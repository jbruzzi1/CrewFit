// Postgres-backed persistence for CrewFit.
//
// DESIGN CALL — worth explaining, since it's a deliberate departure from "textbook" schema
// design: this is a "lift and shift," not a re-architecture. Every route handler in
// server.js still works with the exact same in-memory `DB` object shape it always has
// (DB.users[id], DB.sessions[id], etc.) — all the business logic (PR rebuilding, the
// approval-based follow system, the security/crash-proofing fixes, the boot-time healing
// migrations) is untouched. Only load() and save() change: instead of reading/writing one
// JSON file, they read/write real Postgres rows, one per entity, each holding that entity's
// data as JSONB.
//
// Why not fully normalize (separate tables for session exercises, logs, comments, etc.)?
// Because the actual, current risk isn't "the data isn't queryable enough" — this app has a
// few dozen users, nowhere near a scale where relational queries matter. The actual risk (see
// the "REFUSING TO START IS THE FEATURE" comment this replaces) is that a single shared JSON
// file gets rewritten in full on every mutation with no transaction, no concurrency
// protection, and no real backup story. This gets the real win (atomic per-row writes,
// transactions, no more "one giant file is a single point of failure") with minimal change to
// code that already works and has already been through a real security audit.
//
// DB.friendships was found to be dead code in server.js (declared in EMPTY_DB and defaulted in
// load(), never actually read or written as DB.friendships.xxx anywhere else) — dropped rather
// than carried forward. Everything else server.js actually references at the top level of DB —
// users, sessions, templates, pushSubs, customExercises, prs, followApprovalV1 — is carried
// forward exactly.
//
// Sep 2026: `crews` added (Jeff: "make the collaboration side stronger" -> a saved, named group
// of training partners, not just one-off per-workout invite lists). Same shape as templates/
// sessions above — one row per crew, whole object as JSONB — no new design pattern needed.
//
// Sep 8 2026: save() rewritten to write only what actually changed (see "diffed writes" below).
// This was flagged as the app's real scaling ceiling back at the original migration — not the
// choice of Postgres, but that every single save() rewrote every row of every table regardless
// of what changed. Jeff, after asking what still needed fixing and hearing about this: "Might
// as well fix that issue now... I don't want to have to worry about this once we start
// growing." Every one of server.js's ~70 `await save(DB)` call sites is UNCHANGED by this —
// same function, same "persist the whole current state" contract from the caller's side. The
// two other scaling items flagged alongside this one (swap the hand-rolled pgmini.js client for
// the standard `pg` package; add real connection pooling) are NOT done here — this sandbox
// cannot install new packages to test a client swap against, and pooling would have nothing to
// parallelize until save()'s own JS-level serialization (opQueue, below) is also revisited,
// which is a separate, larger change. Both stay open, on record, for whenever that's tackled.

const { PgConnection, parseConnString } = require('./pgmini');

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  username_lower text UNIQUE NOT NULL,
  data jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id text PRIMARY KEY,
  data jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS templates (
  id text PRIMARY KEY,
  data jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS push_subs (
  user_id text PRIMARY KEY,
  data jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS custom_exercises (
  owner_id text PRIMARY KEY,
  data jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS prs (
  user_id text PRIMARY KEY,
  data jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS crews (
  id text PRIMARY KEY,
  data jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications (
  id text PRIMARY KEY,
  data jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS reports (
  id text PRIMARY KEY,
  data jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS app_state (
  key text PRIMARY KEY,
  value jsonb NOT NULL
);
`;

function connFromEnv() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set — see CLAUDE_HANDOFF.md for the Fly Postgres setup.');
  return new PgConnection(parseConnString(url));
}

let conn = null;
function getConn() {
  if (!conn) conn = connFromEnv();
  return conn;
}

async function ensureSchema() {
  const c = getConn();
  // Statement-by-statement: pgmini's simple path is one query per call, and CREATE TABLE
  // statements don't take parameters, so no need for the extended-protocol machinery here.
  for (const stmt of SCHEMA_SQL.split(';').map(s => s.trim()).filter(Boolean)) {
    await c.query(stmt);
  }
}

const EMPTY_DB = () => ({ users: {}, sessions: {}, templates: {}, pushSubs: {}, customExercises: {}, prs: {}, crews: {}, notifications: {}, reports: {} });

// ---- diffed writes ----
//
// save() has always been handed "the whole current DB" and every one of server.js's call sites
// stays exactly that simple. What changes is internal: instead of upserting every entity in
// every collection and then running a SELECT to discover what's now missing (deleted), this
// keeps an in-memory record — lastPersisted — of exactly what was last actually written to (or
// read from) Postgres, and only touches a row whose JSON has actually changed since then.
// Deletions are computed the same way, as "a key that WAS in the last-known snapshot and no
// longer is in the current one" — no DB round trip needed to discover them either.
//
// lastPersisted starts null (no baseline established yet) and is seeded for free by load(),
// which already reads every row's raw text off the wire — see the `snap.<table>[key] = ...`
// lines below, right next to the existing JSON.parse() lines. The one caller that can reach
// save() before any load() in the same process — scripts/migrate-to-postgres.mjs, a one-shot
// migration tool that saves a freshly-reshaped object straight to Postgres — falls back to the
// exact old full-table behavior (upsert everything, SELECT to find what to delete) for that one
// save, via syncTableFull below, and that write itself establishes the baseline going forward.
// This means the diffing can never miss a write it should have made: the only failure mode of
// "I don't know what's already in the table" is falling back to the slower-but-always-correct
// path, never guessing that something is unchanged when it might not be.
//
// The snapshot only advances AFTER a successful commit (see doSave's try/catch below). A
// failed, rolled-back save must leave lastPersisted exactly as it was — otherwise the next
// save() could wrongly conclude a write that never actually landed had already happened, and
// skip retrying it. That would be silent data loss, the one failure mode this whole file exists
// to rule out (see the file-based-save incident this design replaced, referenced above).
let lastPersisted = null; // null, or { users:{}, sessions:{}, ..., singletons:{} } — each inner value id/key -> last-written JSON string

function freshSnapshot() {
  return { users: {}, sessions: {}, templates: {}, push_subs: {}, custom_exercises: {}, prs: {}, crews: {}, notifications: {}, reports: {}, singletons: {} };
}

// Reassembles the exact in-memory shape server.js has always used, from Postgres rows. Also the
// one place lastPersisted gets (re)established from ground truth — every call to load() is, by
// definition, a moment the app wants an authoritative read of what's really in Postgres, so it's
// exactly the right moment to reset the diff baseline to match, protecting against any possible
// drift between what this process thinks it last wrote and what's actually there.
//
// Queued through the SAME mutex as save() (see opQueue below) — not just for symmetry. A
// cold-review pass (Sep 8 2026) found a real, reproducible silent-data-loss race: pgmini's
// connection only serializes individual SQL statements (see pgmini.js), not transaction
// boundaries, so an un-queued load() running concurrently with an in-flight save() could read
// that save()'s UNCOMMITTED rows straight out of the open transaction, adopt them as the new
// lastPersisted baseline, and then — after the save() that wrote them failed and rolled back —
// have a later, genuinely-successful save() of that same data diff against the poisoned baseline,
// see "no change," and silently skip the write forever. Reproduced live with an xmin comparison
// before this fix. Currently unreachable in production (server.js calls load() exactly once, at
// boot, before app.listen() — never again from a request handler), but nothing enforced that
// invariant, and it's exactly the kind of thing a future "resync from DB" admin route would
// silently reintroduce. Routing load() through opQueue closes it structurally instead of relying
// on every future caller remembering never to call load() while the server is live.
async function doLoad() {
  await ensureSchema();
  const c = getConn();
  const d = EMPTY_DB();
  const snap = freshSnapshot();

  // Keyed by the table's own `id` COLUMN, not a `.id` field read back out of the parsed JSON.
  // A malformed/hand-edited row can have `data` be JSON null, or an object with no `id` at
  // all — this app has real production history of exactly this kind of malformed row (see
  // migrateSessionShapes() in server.js). The row's own primary key is always authoritative
  // and always present; migrateSessionShapes() (which runs right after load(), before anything
  // else touches DB.sessions) is what actually decides whether a null/malformed entry gets
  // healed or dropped — load() must not crash before that healing step ever gets a chance to run.
  const users = await c.query('SELECT id, data FROM users');
  for (const row of users.rows) { d.users[row.id] = JSON.parse(row.data); snap.users[row.id] = JSON.stringify(d.users[row.id]); }

  const sessions = await c.query('SELECT id, data FROM sessions');
  for (const row of sessions.rows) { d.sessions[row.id] = JSON.parse(row.data); snap.sessions[row.id] = JSON.stringify(d.sessions[row.id]); }

  const templates = await c.query('SELECT id, data FROM templates');
  for (const row of templates.rows) { d.templates[row.id] = JSON.parse(row.data); snap.templates[row.id] = JSON.stringify(d.templates[row.id]); }

  const pushSubs = await c.query('SELECT user_id, data FROM push_subs');
  for (const row of pushSubs.rows) { d.pushSubs[row.user_id] = JSON.parse(row.data); snap.push_subs[row.user_id] = JSON.stringify(d.pushSubs[row.user_id]); }

  const customExercises = await c.query('SELECT owner_id, data FROM custom_exercises');
  for (const row of customExercises.rows) { d.customExercises[row.owner_id] = JSON.parse(row.data); snap.custom_exercises[row.owner_id] = JSON.stringify(d.customExercises[row.owner_id]); }

  const prs = await c.query('SELECT user_id, data FROM prs');
  for (const row of prs.rows) { d.prs[row.user_id] = JSON.parse(row.data); snap.prs[row.user_id] = JSON.stringify(d.prs[row.user_id]); }

  const crews = await c.query('SELECT id, data FROM crews');
  for (const row of crews.rows) { d.crews[row.id] = JSON.parse(row.data); snap.crews[row.id] = JSON.stringify(d.crews[row.id]); }

  // Sep 5 2026: passive, read-only notification history (see the comment above notify() and
  // GET /api/notifications in server.js) -- one row per notification, unlike everything above it
  // is not itself app "state" a user edits, just an append-and-eventually-pruned log.
  const notifications = await c.query('SELECT id, data FROM notifications');
  for (const row of notifications.rows) { d.notifications[row.id] = JSON.parse(row.data); snap.notifications[row.id] = JSON.stringify(d.notifications[row.id]); }

  // Sep 2026: user/content reports (app-store readiness -- see the comment above /api/report in
  // server.js). Same one-row-per-entity JSONB shape as notifications just above; also a passive,
  // append-and-eventually-resolved log rather than something a user edits directly.
  const reports = await c.query('SELECT id, data FROM reports');
  for (const row of reports.rows) { d.reports[row.id] = JSON.parse(row.data); snap.reports[row.id] = JSON.stringify(d.reports[row.id]); }

  // Small singleton bookkeeping fields server.js reads/writes directly on DB (not per-entity
  // data) — followApprovalV1 is a boot migration's "did this already run" marker (see
  // migrateFollowApproval() in server.js). It's a BOOT migration, not a one-time import
  // transform, so it must be persisted or it reruns every restart — and it is NOT idempotent
  // against real follow activity: it recomputes `followers` from `friends`, so any follower
  // gained through the actual product flow would be silently dropped back into a pending
  // request on every deploy if this flag were lost. Stored as a row in app_state, mapped back
  // onto DB by name so server.js's call sites (DB.followApprovalV1 = ...) don't change at all.
  const state = await c.query('SELECT key, value FROM app_state');
  for (const row of state.rows) { d[row.key] = JSON.parse(row.value); snap.singletons[row.key] = JSON.stringify(d[row.key]); }

  lastPersisted = snap;
  return d;
}

// Top-level DB fields that are singleton bookkeeping, not per-entity collections — mirrored
// into app_state by save() instead of one of the per-entity tables above. These are ALL of
// server.js's boot-migration "already ran" flags (grep `if (DB.xxxV1) return 0` / `DB.xxxV1 =
// true` in server.js to find them all when adding a new one), not just followApprovalV1 — a
// cold-review pass (Sep 8 2026) caught that this array had silently carried only
// followApprovalV1 since before this file's diffed-writes rewrite, so friendsRetiredV1 and
// binaryVisibilityV1 were NEVER actually persisted to Postgres: save() dropped them every time,
// so migrateFriendsIntoFollowers()/migratePostAndSessionVisibilityBinary() re-ran on every single
// restart. binaryVisibilityV1 re-running is a harmless no-op (it only acts on a legacy value that
// no longer exists in real data), but friendsRetiredV1 re-running is a REAL bug: it unconditionally
// re-derives followers/following from each user's frozen `.friends` array, so a user who unfollowed
// a former friend through the real product flow would have that relationship silently
// resurrected on the next deploy — the exact same class of danger the comment on
// migrateFollowApproval() already called out for followApprovalV1, just not extended to its
// siblings. Any future boot-migration flag added to server.js on this same pattern must be added
// here too, or it will silently never persist.
const SINGLETON_FIELDS = ['followApprovalV1', 'friendsRetiredV1', 'binaryVisibilityV1'];

// Upserts every row of every collection inside one transaction. At this app's scale this was
// trivial for Postgres either way and this keeps save()'s ~70 call sites in server.js completely
// unchanged — every existing `await save(DB)` call still persists "the whole current state,"
// just atomically, without rewriting a shared file, and (as of Sep 8 2026) without re-writing
// rows that haven't actually changed. A row whose in-memory entry was deleted (e.g. a session
// removed) is still deleted here too, so Postgres never accumulates ghosts save() itself no
// longer knows about.
//
// save() (and load(), see the comment above doLoad()) are serialized below through one shared
// queue — two overlapping save(DB) calls (e.g. two concurrent requests each awaiting their own
// save(DB)) would otherwise interleave their statements on the ONE singleton connection:
// PgConnection's FIFO queue only serializes individual SQL statements, not whole BEGIN...COMMIT
// blocks, so a second `BEGIN` while one is already open is just a no-op warning to Postgres, not
// a new transaction — both calls end up sharing one transaction, and one call's ROLLBACK
// (triggered by its own unrelated failure) could silently discard the other call's already-
// "successful" write. Queuing whole save() (and load()) calls end-to-end here — not just their
// individual statements — closes that window. It also means lastPersisted is only ever read/
// advanced by one doSave()/doLoad() at a time — no concurrent mutation of it to worry about, and
// no window for a concurrent load() to read an in-flight save()'s uncommitted transaction either.
let opQueue = Promise.resolve();
function enqueue(fn) {
  const run = opQueue.then(fn);
  opQueue = run.then(() => {}, () => {}); // keep the queue alive even if this op rejects
  return run;
}
async function load() { return enqueue(doLoad); }
async function save(d) { return enqueue(() => doSave(d)); }
async function doSave(d) {
  const c = getConn();
  await c.begin();
  // Bootstrapping (no baseline yet — see the long comment above lastPersisted): fall back to
  // the exact old full-table behavior per collection, via syncTableFull, and use what it
  // determines to be true as this save's contribution to the new baseline. Otherwise, diff
  // against the established baseline via syncTableDiff and only touch what changed.
  const bootstrapping = lastPersisted === null;
  const base = bootstrapping ? null : lastPersisted;
  const pending = freshSnapshot();
  try {
    pending.users = bootstrapping
      ? await syncTableFull(c, 'users', 'id', d.users, usersToParams, USERS_UPSERT_SQL)
      : await syncTableDiff(c, 'users', 'id', d.users, usersToParams, USERS_UPSERT_SQL, base.users);
    pending.sessions = bootstrapping
      ? await syncTableFull(c, 'sessions', 'id', d.sessions, jsonToParams, SESSIONS_UPSERT_SQL)
      : await syncTableDiff(c, 'sessions', 'id', d.sessions, jsonToParams, SESSIONS_UPSERT_SQL, base.sessions);
    pending.templates = bootstrapping
      ? await syncTableFull(c, 'templates', 'id', d.templates, jsonToParams, TEMPLATES_UPSERT_SQL)
      : await syncTableDiff(c, 'templates', 'id', d.templates, jsonToParams, TEMPLATES_UPSERT_SQL, base.templates);
    pending.push_subs = bootstrapping
      ? await syncTableFull(c, 'push_subs', 'user_id', d.pushSubs, jsonToParams, PUSH_SUBS_UPSERT_SQL)
      : await syncTableDiff(c, 'push_subs', 'user_id', d.pushSubs, jsonToParams, PUSH_SUBS_UPSERT_SQL, base.push_subs);
    pending.custom_exercises = bootstrapping
      ? await syncTableFull(c, 'custom_exercises', 'owner_id', d.customExercises, jsonToParams, CUSTOM_EXERCISES_UPSERT_SQL)
      : await syncTableDiff(c, 'custom_exercises', 'owner_id', d.customExercises, jsonToParams, CUSTOM_EXERCISES_UPSERT_SQL, base.custom_exercises);
    pending.prs = bootstrapping
      ? await syncTableFull(c, 'prs', 'user_id', d.prs, jsonToParams, PRS_UPSERT_SQL)
      : await syncTableDiff(c, 'prs', 'user_id', d.prs, jsonToParams, PRS_UPSERT_SQL, base.prs);
    pending.crews = bootstrapping
      ? await syncTableFull(c, 'crews', 'id', d.crews, jsonToParams, CREWS_UPSERT_SQL)
      : await syncTableDiff(c, 'crews', 'id', d.crews, jsonToParams, CREWS_UPSERT_SQL, base.crews);
    pending.notifications = bootstrapping
      ? await syncTableFull(c, 'notifications', 'id', d.notifications, jsonToParams, NOTIFICATIONS_UPSERT_SQL)
      : await syncTableDiff(c, 'notifications', 'id', d.notifications, jsonToParams, NOTIFICATIONS_UPSERT_SQL, base.notifications);
    pending.reports = bootstrapping
      ? await syncTableFull(c, 'reports', 'id', d.reports, jsonToParams, REPORTS_UPSERT_SQL)
      : await syncTableDiff(c, 'reports', 'id', d.reports, jsonToParams, REPORTS_UPSERT_SQL, base.reports);

    // Singletons: never deleted for being merely absent from `d` (unlike collections above) —
    // `d[key] === undefined` has always meant "this save() call has nothing to say about this
    // field," not "this field should be cleared." Carry the prior known value forward into
    // pending unchanged in that case, so a later save() that DOES set it still diffs correctly
    // against the real last-written value, not a blank slate.
    for (const key of SINGLETON_FIELDS) {
      if (d[key] === undefined) {
        if (!bootstrapping && base.singletons[key] !== undefined) pending.singletons[key] = base.singletons[key];
        continue;
      }
      const json = JSON.stringify(d[key]);
      if (bootstrapping || base.singletons[key] !== json) {
        await c.query('INSERT INTO app_state (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, json]);
      }
      pending.singletons[key] = json;
    }
    await c.commit();
    lastPersisted = pending; // only advance the baseline once the write actually landed
  } catch (e) {
    await c.rollback();
    throw e;
  }
}

// username_lower matches server.js's own normUser() exactly: String(v == null ? '' : v)
// .trim().toLowerCase() — substituting '' only for null/undefined, NOT for every falsy
// value. A looser expression here would let this pre-check pass while the UNIQUE
// constraint below still collides (or vice versa) — kept byte-for-byte in sync with
// normUser() in server.js on purpose.
const usersToParams = (id, u) => [id, String((u && u.username) == null ? '' : u.username).trim().toLowerCase(), JSON.stringify(u)];
const jsonToParams = (id, v) => [id, JSON.stringify(v)];

const USERS_UPSERT_SQL = 'INSERT INTO users (id, username_lower, data) VALUES ($1, $2, $3::jsonb) ON CONFLICT (id) DO UPDATE SET username_lower = EXCLUDED.username_lower, data = EXCLUDED.data';
const SESSIONS_UPSERT_SQL = 'INSERT INTO sessions (id, data) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data';
const TEMPLATES_UPSERT_SQL = 'INSERT INTO templates (id, data) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data';
const PUSH_SUBS_UPSERT_SQL = 'INSERT INTO push_subs (user_id, data) VALUES ($1, $2::jsonb) ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data';
const CUSTOM_EXERCISES_UPSERT_SQL = 'INSERT INTO custom_exercises (owner_id, data) VALUES ($1, $2::jsonb) ON CONFLICT (owner_id) DO UPDATE SET data = EXCLUDED.data';
const PRS_UPSERT_SQL = 'INSERT INTO prs (user_id, data) VALUES ($1, $2::jsonb) ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data';
const CREWS_UPSERT_SQL = 'INSERT INTO crews (id, data) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data';
const NOTIFICATIONS_UPSERT_SQL = 'INSERT INTO notifications (id, data) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data';
const REPORTS_UPSERT_SQL = 'INSERT INTO reports (id, data) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data';

// The original, pre-Sep-8 behavior, kept verbatim as the bootstrap fallback (see the comment
// above lastPersisted): upserts every entry currently in `obj`, then deletes any DB row whose
// key is no longer present in `obj` — a full-table SELECT is unavoidable here since there is no
// in-memory baseline yet to diff against. Also returns the resulting key -> JSON map, so the
// caller can use it to establish that baseline for every future save() in this process.
//
// Sep 2026: a caller passing a DB-shaped object that predates a newer collection (found via the
// `crews` addition — scripts/migrate-to-postgres.mjs builds its object from a fixed field list,
// and an old export naturally has no `crews` key at all) used to throw `Object.keys(undefined)`
// here and abort the WHOLE save, not just skip that one collection. `obj || {}` treats "this
// collection doesn't exist in what I was handed" the same as "it's empty" — exactly the same
// forgiving instinct scripts/migrate-to-postgres.mjs already applies at its own call site
// (`raw.crews || {}`), just applied here too so every OTHER future save()-adjacent caller gets
// the same protection automatically instead of needing to remember it.
async function syncTableFull(c, table, keyCol, obj, toParams, upsertSql) {
  const keys = Object.keys(obj || {});
  const map = {};
  for (const k of keys) {
    const json = JSON.stringify(obj[k]);
    await c.query(upsertSql, toParams(k, obj[k]));
    map[k] = json;
  }
  const existing = await c.query(`SELECT ${keyCol} as k FROM ${table}`);
  const keep = new Set(keys);
  for (const row of existing.rows) {
    if (!keep.has(row.k)) await c.query(`DELETE FROM ${table} WHERE ${keyCol} = $1`, [row.k]);
  }
  return map;
}

// The new, fast path (used whenever a baseline exists — i.e. every save() after the first
// load() or bootstrap save() in this process): only writes a row whose JSON has actually
// changed since lastMap (the table's slice of lastPersisted) was captured, and only deletes a
// row whose key WAS in lastMap and no longer is in `obj` — both computed from the in-memory
// snapshot, no DB round trip needed to find either. An entity that hasn't changed costs nothing
// but a string comparison; this is the whole point of this file's Sep 8 2026 rewrite.
//
// Comparing JSON.stringify(current) against a JSON string captured the same way is safe in both
// directions: two different values can never stringify to the same string, so a real change can
// never be missed. The reverse direction (two structurally-identical values stringifying
// differently, causing a wasted-but-harmless write) was a real risk here at one point — Postgres
// echoes jsonb back as text with spaces after `:`/`,` (`{"id": "u1", ...}`) while JS's
// JSON.stringify never adds them, so if load()'s baseline were built from Postgres's own raw row
// text, literally the FIRST save() after every process boot would spuriously rewrite every
// unchanged row (proven with a live `xmin`-comparison test, test/db-diff-writes.mjs, before this
// was caught — the original comment here wrongly assumed this could only be an occasional
// key-order artifact). Fixed at the source: load() re-serializes each parsed value with
// JSON.stringify before storing it in the baseline (see the `snap.<table>[...] = JSON.stringify(...)`
// lines above), so the baseline is always in the exact same format this function itself produces,
// and a Postgres round trip's formatting can never cause a false "changed" reading.
async function syncTableDiff(c, table, keyCol, obj, toParams, upsertSql, lastMap) {
  const current = obj || {};
  const map = { ...lastMap };
  for (const k of Object.keys(current)) {
    const json = JSON.stringify(current[k]);
    if (map[k] !== json) {
      await c.query(upsertSql, toParams(k, current[k]));
      map[k] = json;
    }
  }
  for (const k of Object.keys(lastMap)) {
    if (!Object.prototype.hasOwnProperty.call(current, k)) {
      await c.query(`DELETE FROM ${table} WHERE ${keyCol} = $1`, [k]);
      delete map[k];
    }
  }
  return map;
}

// close() drops the connection AND the diff baseline — a fresh getConn() after this may point
// at a different DATABASE_URL entirely (tests reconnecting to a new throwaway database do
// exactly this), and a baseline captured from the OLD database would make the diff logic wrongly
// skip writes the NEW database actually needs. No real production caller relies on this (the
// live server calls close() only at process exit, if ever), but it costs nothing to be safe here
// — the only effect of losing the baseline is that the next save() re-bootstraps (the old,
// always-correct full-table path) instead of diffing, exactly as if this were a fresh process.
function close() { if (conn) { conn.close(); conn = null; } lastPersisted = null; }

module.exports = { load, save, close, ensureSchema, EMPTY_DB, getConn };
