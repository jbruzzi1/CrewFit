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
-- Oct 14 2026 (push subs/custom exercises/reports slice, task #258+): custom_exercises above is
-- the OLD array-per-owner shape ("every exercise owner X has ever made, all in one jsonb array,
-- rewritten whole on every create/edit/delete") -- kept, but no longer written to once this
-- slice's cutover lands (see the migration function below and CLAUDE.md's "Rearchitecture
-- status"). This is the NEW shape: one row per exercise, matching every other per-entity table in
-- this file (sessions, crews, notifications, ...) instead of being the one remaining "array
-- blob" collection. Jeff's call (Oct 14 2026, choosing between keeping the array shape with a
-- transaction vs. this redesign): "do it right the first time and take longer" -- this removes
-- the lost-write race a naive read-array/mutate/write-array translation would have reopened,
-- by construction, rather than managing it with locking.
CREATE TABLE IF NOT EXISTS custom_exercise_rows (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS custom_exercise_rows_owner_idx ON custom_exercise_rows (owner_id);
-- Backs findExLibEntry's global by-name fallback scan (server.js) -- today that's an in-memory
-- Object.values().find() over every owner's array -- the Postgres equivalent is a WHERE on this
-- expression index instead of a table scan. Table is tiny today (a few hundred rows at most) so
-- this isn't solving a real performance problem yet -- it's here because it's nearly free to add
-- now and this is exactly the kind of lookup that gets slow silently if left until it's actually
-- slow.
CREATE INDEX IF NOT EXISTS custom_exercise_rows_name_idx ON custom_exercise_rows ((data->>'name'));
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
CREATE TABLE IF NOT EXISTS feed_events (
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

// Oct 13 2026 (read cutover, task #252): notifications/feedEvents dropped from this shape --
// nothing in server.js reads or writes DB.notifications/DB.feedEvents any more (see emitFeedEvent/
// pgNotificationHistoryForUser/pgFeedEventsSince and every other direct-Postgres function in the
// "direct Postgres access" section below); both are served and mutated exclusively through those
// functions now.
// Oct 14 2026 (push subs/custom exercises/reports slice, task #258+): pushSubs dropped the same
// way -- POST /api/push/subscribe, notify()'s send path, and the account-deletion cleanup all go
// through pgGetPushSub/pgSetPushSub/pgDeletePushSubIfEndpointMatches/pgDeletePushSub now (see
// those functions' own comments in the "direct Postgres access" section below for why this one
// needed no dual-write window the way notifications/feed-events and customExercises did/do --
// same table, same shape, just a different caller). `reports` dropped the same way right after
// -- GET /api/admin/reports, POST /api/report, and POST /api/admin/reports/:id/resolve all go
// through pgListReports/pgInsertReport/pgResolveReport now. `customExercises` is still untouched
// here -- it's mid-migration to a genuinely different shape (see custom_exercise_rows in
// SCHEMA_SQL and CLAUDE.md's "Rearchitecture status"), the one piece of this slice that still
// needs an actual dual-write window before its cutover, unlike push subs/reports.
const EMPTY_DB = () => ({ users: {}, sessions: {}, templates: {}, customExercises: {}, prs: {}, crews: {} });

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
  return { users: {}, sessions: {}, templates: {}, custom_exercises: {}, prs: {}, crews: {}, notifications: {}, reports: {}, feed_events: {}, singletons: {} };
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

  // Oct 14 2026 (push subs/custom exercises/reports slice, task #258+): push_subs used to be
  // loaded wholesale here too, same shape as every other collection -- that's gone now. POST
  // /api/push/subscribe, notify()'s send path, and the account-deletion cleanup in server.js
  // already read/write exclusively through pgGetPushSub/pgSetPushSub/
  // pgDeletePushSubIfEndpointMatches/pgDeletePushSub (below), not through an in-memory
  // DB.pushSubs map, so there is nothing left for doLoad() to populate or for lastPersisted to
  // baseline here.

  const customExercises = await c.query('SELECT owner_id, data FROM custom_exercises');
  for (const row of customExercises.rows) { d.customExercises[row.owner_id] = JSON.parse(row.data); snap.custom_exercises[row.owner_id] = JSON.stringify(d.customExercises[row.owner_id]); }

  const prs = await c.query('SELECT user_id, data FROM prs');
  for (const row of prs.rows) { d.prs[row.user_id] = JSON.parse(row.data); snap.prs[row.user_id] = JSON.stringify(d.prs[row.user_id]); }

  const crews = await c.query('SELECT id, data FROM crews');
  for (const row of crews.rows) { d.crews[row.id] = JSON.parse(row.data); snap.crews[row.id] = JSON.stringify(d.crews[row.id]); }

  // Oct 13 2026 (read cutover, task #252): notifications used to be loaded wholesale here too,
  // the same way as every other collection -- that's gone now. GET /api/notifications and every
  // other notifications call site in server.js already read/write exclusively through
  // pgNotificationHistoryForUser/pgInsertNotification/pgMergedNotificationWrite/
  // pgDeleteNotification/pgPruneOldNotifications (below), not through an in-memory DB.notifications
  // map, so there is nothing left for doLoad() to populate or for lastPersisted to baseline here.

  // Oct 14 2026 (push subs/custom exercises/reports slice, task #258+): reports used to be
  // loaded wholesale here too (Sep 2026: user/content reports, app-store readiness -- see the
  // comment above /api/report in server.js) -- that's gone now, same removal and same reasoning
  // as notifications/feed_events/push_subs above. GET /api/admin/reports, POST /api/report, and
  // POST /api/admin/reports/:id/resolve already read/write exclusively through
  // pgListReports/pgInsertReport/pgResolveReport (below), not through an in-memory DB.reports map.

  // Oct 13 2026 (read cutover, task #252): feed_events used to be loaded wholesale here too, same
  // removal and same reasoning as notifications just above -- GET /api/feed and every other feed-
  // event call site in server.js already read/write exclusively through pgFeedEventsSince/
  // pgInsertFeedEvent/pgGetFeedEvent/pgToggleFeedEventReaction/pgDeleteFeedEvent/
  // pgPruneOldFeedEvents (below), not through an in-memory DB.feedEvents map.

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
    pending.custom_exercises = bootstrapping
      ? await syncTableFull(c, 'custom_exercises', 'owner_id', d.customExercises, jsonToParams, CUSTOM_EXERCISES_UPSERT_SQL)
      : await syncTableDiff(c, 'custom_exercises', 'owner_id', d.customExercises, jsonToParams, CUSTOM_EXERCISES_UPSERT_SQL, base.custom_exercises);
    pending.prs = bootstrapping
      ? await syncTableFull(c, 'prs', 'user_id', d.prs, jsonToParams, PRS_UPSERT_SQL)
      : await syncTableDiff(c, 'prs', 'user_id', d.prs, jsonToParams, PRS_UPSERT_SQL, base.prs);
    pending.crews = bootstrapping
      ? await syncTableFull(c, 'crews', 'id', d.crews, jsonToParams, CREWS_UPSERT_SQL)
      : await syncTableDiff(c, 'crews', 'id', d.crews, jsonToParams, CREWS_UPSERT_SQL, base.crews);
    // Oct 13 2026 (rearchitecture, notifications+feed-events slice -- REAL finding from task
    // #245's differential test, not a hypothetical): `notifications` and `feed_events` used to be
    // synced here too, the same generic way as every other table. That is now deliberately
    // REMOVED, and this is a correctness fix, not a style choice.
    //
    // What the differential test caught: this generic sync does a coarse "overwrite the whole row
    // to match whatever's in memory right now" write, on the exact same physical rows the new
    // pgMergedNotificationWrite/pgToggleFeedEventReaction functions (below, in the "direct
    // Postgres access" section) do a surgical read-modify-write MERGE/TOGGLE on. Both go through
    // this same enqueue() queue, so neither ever corrupts the OTHER's transaction -- the single-
    // connection safety invariant this queue exists for was never at risk. But the two mechanisms
    // still fight over the FINAL VALUE of the same row: a generic overwrite landing between two of
    // the new functions' own read-then-write steps makes each of those see a different "current"
    // state than the in-memory JS side computed, which does not throw or roll back anything -- it
    // just produces a silently WRONG number. Caught live: 4 real concurrent crew-chat messages
    // produced a grouped notification with count=7, not 4; 10 real concurrent reactions on the
    // same feed event ended at 0, not 10 (the generic overwrite landing between toggles flipped
    // some back off). Both reproduced through real HTTP requests against the real routes, not a
    // synthetic script -- see test/notifications-feed-migration-differential.mjs.
    //
    // The fix: these two tables are now owned EXCLUSIVELY by the new direct-Postgres functions
    // for ONGOING writes, for both inserts/updates/deletes and the prune jobs -- every call site
    // that used to mutate DB.notifications/DB.feedEvents now calls the matching new function
    // instead (see server.js's own comments at each site). This was the dual-write phase's fix,
    // landed before the in-memory maps themselves were removed.
    //
    // Oct 13 2026, same day (read cutover, task #247/#251/#252): DB.notifications/DB.feedEvents
    // are gone now, not just unwritten -- removed from EMPTY_DB and doLoad() above, since every
    // read site (GET /api/notifications, GET /api/feed, the reaction route, the challenge-cancel
    // cleanup) was rewritten to read through the same direct-Postgres functions ongoing writes
    // already used. Nothing in server.js passes `d.notifications`/`d.feedEvents` to save() any
    // more either -- the two branches just below are reachable ONLY from
    // scripts/migrate-to-postgres.mjs's one-shot bootstrap save, never from live server traffic.
    //
    // Oct 13 2026, corrected same day (second review pass caught this): the bootstrapping branch
    // below is NOT removed, only the ongoing (syncTableDiff) branch is. `bootstrapping` is true
    // exactly once per process, and ONLY for scripts/migrate-to-postgres.mjs (the one caller that
    // reaches save() before any load() -- see the comment on lastPersisted above; every normal
    // server.js boot calls load() first, which always establishes a real baseline, so
    // bootstrapping is always false there). Dropping this branch too would have silently made
    // that one-shot import/disaster-recovery script stop writing notifications/feed_events into
    // Postgres AT ALL -- a real, currently-untested regression the differential test (which only
    // exercises normal server traffic, never the import script) would never have caught. Since
    // this branch only ever runs for that single one-shot, non-concurrent script -- never
    // alongside real user traffic -- it cannot re-create the ongoing-write race this whole fix
    // exists to remove; it is the same one-time bulk import syncTableFull always was, just scoped
    // to only fire on that one path now.
    // Oct 14 2026 (push subs/custom exercises/reports slice, task #258+): push_subs gets the same
    // bootstrap-only treatment as notifications/feed_events just below, for the same reason --
    // POST /api/push/subscribe, notify()'s send path, and the account-deletion cleanup now own
    // this table exclusively via pgSetPushSub/pgGetPushSub/pgDeletePushSubIfEndpointMatches/
    // pgDeletePushSub (see those functions' comments), so a generic overwrite-the-whole-row sync
    // running alongside them on live traffic would reopen the exact same "two writers fight over
    // the final value" class of bug the notifications/feed-events slice found and fixed (see that
    // slice's own long comment, a few lines below) -- just with no aggregation logic to visibly
    // corrupt here (push_subs has always been a single whole-object overwrite per user, not a
    // merge), so this one wouldn't even show up as a wrong number, only as "whichever write lost
    // the race is silently gone." Scoped to bootstrapping (migrate-to-postgres.mjs's one-shot
    // disaster-recovery path) only, same reasoning as notifications/feed_events: that script is
    // never running alongside real user traffic, so it cannot reopen the race this exists to avoid.
    pending.push_subs = bootstrapping
      ? await syncTableFull(c, 'push_subs', 'user_id', d.pushSubs, jsonToParams, PUSH_SUBS_UPSERT_SQL)
      : (base.push_subs || {});
    pending.notifications = bootstrapping
      ? await syncTableFull(c, 'notifications', 'id', d.notifications, jsonToParams, NOTIFICATIONS_UPSERT_SQL)
      : (base.notifications || {});
    pending.feed_events = bootstrapping
      ? await syncTableFull(c, 'feed_events', 'id', d.feedEvents, jsonToParams, FEED_EVENTS_UPSERT_SQL)
      : (base.feed_events || {});
    // Oct 14 2026: reports gets the same bootstrap-only treatment as push_subs/notifications/
    // feed_events just above, for the same reason -- POST /api/report, GET /api/admin/reports,
    // and the resolve route now own this table exclusively via pgInsertReport/pgListReports/
    // pgResolveReport, so a generic sync running alongside them on live traffic would reopen the
    // same "two writers fight over the final value" class of bug. Scoped to bootstrapping
    // (migrate-to-postgres.mjs's one-shot disaster-recovery path) only.
    pending.reports = bootstrapping
      ? await syncTableFull(c, 'reports', 'id', d.reports, jsonToParams, REPORTS_UPSERT_SQL)
      : (base.reports || {});

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
const FEED_EVENTS_UPSERT_SQL = 'INSERT INTO feed_events (id, data) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data';

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

// ---- Oct 13 2026: direct Postgres access for notifications + feed_events ----
//
// First slice of the data-ownership rearchitecture (see CrewFit's CLAUDE.md, "Rearchitecture
// status"). These two collections are moving off "loaded wholesale into DB.notifications/
// DB.feedEvents at boot, mutated in memory, persisted via the generic save(DB) diff above" onto
// real per-request Postgres access. Every other collection (sessions, users, crews, etc.) is
// completely unchanged by this and still goes through DB.<x> + save(DB) as always — only these
// two tables get their own functions here, used by server.js in place of DB.notifications[...]/
// DB.feedEvents[...].
//
// Oct 13 2026, corrected same day (two independent review passes, both caught this
// independently, one reproduced it live): EVERY function below — not just
// pgMergedNotificationWrite's own transaction — is routed through enqueue(), the same queue
// doSave()/doLoad() already use. The first version of this comment argued "a single bare
// statement needs no extra coordination, because pgmini's connection already serializes
// individual .query() calls on the wire" — that reasoning is WRONG, and the bug it missed is
// worse than the one pgMergedNotificationWrite's own transaction already guards against: this
// app has exactly ONE live Postgres connection (pgmini.js's own top comment — no pooling), and a
// BEGIN...COMMIT on that connection is a property of the whole connection, not of the caller that
// opened it. A "single bare statement" issued through getConn().query() directly (not enqueued)
// can land ON THE WIRE in between someone ELSE's BEGIN and COMMIT/ROLLBACK — doSave()'s own
// 9-collection transaction, or another pgMergedNotificationWrite call — and become part of THAT
// transaction instead of its own. If that other transaction then rolls back (any thrown error),
// this statement's write is silently undone even though its own promise already resolved with no
// error at all — the caller believes it succeeded, and it didn't. Reproduced live against a real
// Postgres database: an un-enqueued pgInsertFeedEvent-style insert, issued while an unrelated
// transaction was open, vanished the instant that other transaction rolled back. Routing every
// one of these through enqueue() closes this the same way doSave()/doLoad() already do — see the
// comment on opQueue, above, for the general reasoning this now actually follows consistently
// instead of only partially.
//
// Two different safety shapes below, now BOTH always inside enqueue() — the distinction that
// still matters is only about what happens ONCE a function has its exclusive turn on the
// connection, not about whether to use the queue at all:
//   - The reaction toggle (pgToggleFeedEventReaction) is ONE atomic UPDATE, with the toggle
//     logic itself computed inside the SQL (jsonb_set + the jsonb containment/concat/subtract
//     operators), not read-then-decide-in-JS-then-write — no BEGIN/COMMIT of its own needed,
//     Postgres's own row-level locking already serializes two concurrent toggles of the SAME row
//     correctly. Verified directly: 20 truly concurrent reactions from 20 different users on one
//     row all landed, zero lost updates.
//   - The grouped-notification merge (pgMergedNotificationWrite) genuinely cannot be one
//     statement: it has to look up any existing unseen row for this (user, groupKey) and THEN
//     decide insert vs. update, with nothing allowed to happen in between — a real transaction
//     (BEGIN...COMMIT). Verified directly: 8 truly concurrent merges for the same (user, groupKey)
//     produced 8 separate duplicate rows when NOT routed through a shared queue (reproducing the
//     exact bug this exists to prevent), and exactly 1 correctly-merged row (count=8) when they
//     were.
async function pgNotificationHistoryForUser(userId, sinceIso) {
  return enqueue(async () => {
    const c = getConn();
    const r = await c.query(
      `SELECT data FROM notifications WHERE data->>'userId' = $1 AND data->>'createdAt' >= $2 ORDER BY data->>'createdAt' DESC LIMIT 50`,
      [userId, sinceIso]
    );
    return r.rows.map(row => JSON.parse(row.data));
  });
}
async function pgInsertNotification(row) {
  return enqueue(async () => {
    const c = getConn();
    await c.query(NOTIFICATIONS_UPSERT_SQL, [row.id, JSON.stringify(row)]);
    return row;
  });
}
// Ownership check baked into the WHERE clause, not a separate read-then-check-then-delete — a
// single atomic statement, and it also means two concurrent deletes of the same row can't race
// each other into any inconsistent state (the second just affects 0 rows). Returns whether a row
// was actually removed, so the caller can tell "didn't exist" / "wasn't yours" (same outcome,
// same 404, no info leak either way) from "deleted."
async function pgDeleteNotification(id, userId) {
  return enqueue(async () => {
    const c = getConn();
    const r = await c.query(`DELETE FROM notifications WHERE id = $1 AND data->>'userId' = $2`, [id, userId]);
    const m = /^DELETE (\d+)$/.exec(r.commandTag || '');
    return !!m && Number(m[1]) > 0;
  });
}
async function pgMergedNotificationWrite(userId, groupKey, newId, payload) {
  return enqueue(async () => {
    const c = getConn();
    await c.begin();
    try {
      const r = await c.query(
        `SELECT id, data FROM notifications WHERE data->>'userId' = $1 AND data->>'groupKey' = $2 AND data->>'createdAt' > $3 ORDER BY data->>'createdAt' DESC LIMIT 1`,
        [userId, groupKey, payload.seenAtIso]
      );
      let row;
      if (r.rows.length) {
        row = JSON.parse(r.rows[0].data);
        row.count = (row.count || 1) + 1;
        row.title = payload.title;
        row.body = payload.pluralBody(row.count);
        row.link = payload.link != null ? payload.link : row.link;
        row.createdAt = new Date().toISOString();
      } else {
        row = { id: newId, userId, title: payload.title, body: payload.singularBody, link: payload.link || null, groupKey, count: 1, createdAt: new Date().toISOString() };
      }
      await c.query(NOTIFICATIONS_UPSERT_SQL, [row.id, JSON.stringify(row)]);
      await c.commit();
      return row;
    } catch (e) {
      await c.rollback();
      throw e;
    }
  });
}
async function pgPruneOldNotifications(cutoffIso) {
  return enqueue(async () => {
    const c = getConn();
    const r = await c.query(`DELETE FROM notifications WHERE data->>'createdAt' < $1`, [cutoffIso]);
    const m = /^DELETE (\d+)$/.exec(r.commandTag || '');
    return m ? Number(m[1]) : 0;
  });
}
async function pgInsertFeedEvent(row) {
  return enqueue(async () => {
    const c = getConn();
    await c.query(FEED_EVENTS_UPSERT_SQL, [row.id, JSON.stringify(row)]);
    return row;
  });
}
async function pgDeleteFeedEvent(id) {
  return enqueue(async () => {
    const c = getConn();
    await c.query('DELETE FROM feed_events WHERE id = $1', [id]);
  });
}
// Oct 13 2026 (read-cutover): single-row lookup, added for POST /api/feed-events/:id/react --
// now that there is no in-memory DB.feedEvents to read ev.by/ev.crewId/ev.type off of before
// deciding whether this viewer is allowed to react, that route needs a real fetch-by-id. Returns
// null (not throw) when the row doesn't exist, so the caller's existing 404 path is unchanged.
async function pgGetFeedEvent(id) {
  return enqueue(async () => {
    const c = getConn();
    const r = await c.query('SELECT data FROM feed_events WHERE id = $1', [id]);
    return r.rows.length ? JSON.parse(r.rows[0].data) : null;
  });
}
// Bounded to the retention window at the SQL level (same cutoff GET /api/feed itself already
// applies) — this is already what pruneOldFeedEvents keeps the in-memory table down to in
// practice, so this isn't a NEW scan limit, just the same one enforced at the source instead of
// after loading everything into RAM. Visibility filtering (crew membership, blocks, connections)
// stays exactly where it already is, in server.js's GET /api/feed — deliberately NOT duplicated
// into SQL here, so that business logic has exactly one home, not two copies to keep in sync.
async function pgFeedEventsSince(sinceIso) {
  return enqueue(async () => {
    const c = getConn();
    const r = await c.query(`SELECT data FROM feed_events WHERE data->>'at' >= $1`, [sinceIso]);
    return r.rows.map(row => JSON.parse(row.data));
  });
}
// Single atomic UPDATE — see the long comment above this section for why this needs no
// transaction. Returns the updated row, or null if the event doesn't exist (caller 404s).
const FEED_REACTION_TOGGLE_SQL = `UPDATE feed_events
  SET data = jsonb_set(
    data, '{reactions}',
    CASE WHEN COALESCE(data->'reactions', '[]'::jsonb) @> to_jsonb($2::text)
      THEN (COALESCE(data->'reactions', '[]'::jsonb) - $2)
      ELSE (COALESCE(data->'reactions', '[]'::jsonb) || to_jsonb($2::text))
    END
  )
  WHERE id = $1
  RETURNING data`;
async function pgToggleFeedEventReaction(id, userId) {
  return enqueue(async () => {
    const c = getConn();
    const r = await c.query(FEED_REACTION_TOGGLE_SQL, [id, userId]);
    return r.rows.length ? JSON.parse(r.rows[0].data) : null;
  });
}
async function pgPruneOldFeedEvents(cutoffIso) {
  return enqueue(async () => {
    const c = getConn();
    const r = await c.query(`DELETE FROM feed_events WHERE data->>'at' < $1`, [cutoffIso]);
    const m = /^DELETE (\d+)$/.exec(r.commandTag || '');
    return m ? Number(m[1]) : 0;
  });
}

// ---- Oct 14 2026: direct Postgres access for push subs + custom exercises + reports ----
//
// Second slice of the data-ownership rearchitecture (see CLAUDE.md's "Rearchitecture status").
// Every function below is routed through enqueue() for the same reason the notifications/
// feed-events functions above are — see that section's long comment on why a bare,
// un-enqueued statement can land inside someone else's open transaction on this app's one
// shared connection and be silently undone by that transaction's rollback. That reasoning is
// general, not specific to notifications, so it applies here unchanged.
//
// Push subs and reports are NOT changing shape — push_subs was already one row per user and
// reports was already one row per id, both already the "right" long-term shape (see CLAUDE.md
// and db.js's own top comment). These functions exist only to give them the same direct-
// Postgres read/write path notifications/feed_events have, so they can leave the generic
// DB.pushSubs/DB.reports object the same way.
//
// Custom exercises DOES change shape — see the custom_exercise_rows table comment in SCHEMA_SQL
// above for the full reasoning (Jeff's choice, Oct 14 2026: redesign to one row per exercise
// rather than keep the array-per-owner shape with a transaction). Functions below operate on
// the NEW custom_exercise_rows table; the old custom_exercises table/column stays untouched by
// this file from here on except for the one-time migration read in server.js's boot sequence.
async function pgGetPushSub(userId) {
  return enqueue(async () => {
    const c = getConn();
    const r = await c.query('SELECT data FROM push_subs WHERE user_id = $1', [userId]);
    return r.rows.length ? JSON.parse(r.rows[0].data) : null;
  });
}
async function pgSetPushSub(userId, sub) {
  return enqueue(async () => {
    const c = getConn();
    await c.query(PUSH_SUBS_UPSERT_SQL, [userId, JSON.stringify(sub)]);
    return sub;
  });
}
// Value-based, not reference-identity-based — the in-memory version's `DB.pushSubs[userId] ===
// sub` check (see notify() in server.js) only works because the SAME in-process object is still
// sitting in DB.pushSubs when the async sendNotification() call rejects. Once this table is read
// fresh per-request instead, there is no shared in-memory object to compare identity against —
// the only way to tell "is this still the subscription that just failed" is to compare the one
// field that actually identifies a subscription, its endpoint URL. Ownership + endpoint match
// both baked into the WHERE clause — a single atomic statement, so a resubscribe racing against
// this delete can't be undone by it (if the row's endpoint no longer matches, 0 rows affected).
async function pgDeletePushSubIfEndpointMatches(userId, endpoint) {
  return enqueue(async () => {
    const c = getConn();
    const r = await c.query(
      `DELETE FROM push_subs WHERE user_id = $1 AND data->>'endpoint' = $2`,
      [userId, endpoint]
    );
    const m = /^DELETE (\d+)$/.exec(r.commandTag || '');
    return !!m && Number(m[1]) > 0;
  });
}
// Unconditional — for account deletion, where any subscription under this id should go, not
// just one matching a specific endpoint.
async function pgDeletePushSub(userId) {
  return enqueue(async () => {
    const c = getConn();
    await c.query('DELETE FROM push_subs WHERE user_id = $1', [userId]);
  });
}

async function pgInsertReport(row) {
  return enqueue(async () => {
    const c = getConn();
    await c.query(REPORTS_UPSERT_SQL, [row.id, JSON.stringify(row)]);
    return row;
  });
}
// Sorted the same way GET /api/admin/reports already sorts the in-memory version (newest
// first) — done here, at the query, rather than leaving the caller to re-sort what it gets back.
async function pgListReports() {
  return enqueue(async () => {
    const c = getConn();
    const r = await c.query(`SELECT data FROM reports ORDER BY data->>'at' DESC`);
    return r.rows.map(row => JSON.parse(row.data));
  });
}
// resolvedAtIso is passed in rather than computed with SQL's now() so this report's resolvedAt
// uses the exact same JS Date().toISOString() formatting every other timestamp in this app
// already uses — a mixed-format timestamp field would be a real (if minor) inconsistency for
// nothing. Returns the updated row, or null if it doesn't exist (caller 404s) — same shape as
// pgToggleFeedEventReaction above.
const REPORT_RESOLVE_SQL = `UPDATE reports
  SET data = jsonb_set(jsonb_set(data, '{status}', to_jsonb('resolved'::text)), '{resolvedAt}', to_jsonb($2::text))
  WHERE id = $1
  RETURNING data`;
async function pgResolveReport(id, resolvedAtIso) {
  return enqueue(async () => {
    const c = getConn();
    const r = await c.query(REPORT_RESOLVE_SQL, [id, resolvedAtIso]);
    return r.rows.length ? JSON.parse(r.rows[0].data) : null;
  });
}

const CUSTOM_EXERCISE_ROWS_UPSERT_SQL = 'INSERT INTO custom_exercise_rows (id, owner_id, data) VALUES ($1, $2, $3::jsonb) ON CONFLICT (id) DO UPDATE SET owner_id = EXCLUDED.owner_id, data = EXCLUDED.data';
// One function for both create and edit, same as pgInsertNotification/pgUpsertCustomExerciseRow
// elsewhere in this file being reused for both — the caller (server.js) always hands over the
// FULL exercise object (POST builds a brand-new one; PUT mutates a copy of the existing one with
// the same fields PUT has always accepted), so there is no partial-patch case to special-case
// here. `row.ownerId` (camelCase, matching the JS object's own field name everywhere else in this
// app) is what's written into the owner_id column.
async function pgUpsertCustomExerciseRow(row) {
  return enqueue(async () => {
    const c = getConn();
    await c.query(CUSTOM_EXERCISE_ROWS_UPSERT_SQL, [row.id, row.ownerId, JSON.stringify(row)]);
    return row;
  });
}
async function pgGetCustomExerciseRow(id) {
  return enqueue(async () => {
    const c = getConn();
    const r = await c.query('SELECT data FROM custom_exercise_rows WHERE id = $1', [id]);
    return r.rows.length ? JSON.parse(r.rows[0].data) : null;
  });
}
async function pgListCustomExerciseRowsByOwner(ownerId) {
  return enqueue(async () => {
    const c = getConn();
    const r = await c.query('SELECT data FROM custom_exercise_rows WHERE owner_id = $1', [ownerId]);
    return r.rows.map(row => JSON.parse(row.data));
  });
}
// Backs GET /api/exercises' Object.values(DB.customExercises||{}).flat() — every custom
// exercise, from every owner, is shown to every user by design (see that route's own comment in
// server.js), so this has no WHERE clause at all, same reach as the in-memory version.
async function pgListAllCustomExerciseRows() {
  return enqueue(async () => {
    const c = getConn();
    const r = await c.query('SELECT data FROM custom_exercise_rows');
    return r.rows.map(row => JSON.parse(row.data));
  });
}
// Ownership baked into the WHERE clause, same reasoning as pgDeleteNotification above — a
// single atomic statement, so it can't be raced into an inconsistent state, and the caller
// can't accidentally delete a row it doesn't own just by getting the id right.
async function pgDeleteCustomExerciseRow(id, ownerId) {
  return enqueue(async () => {
    const c = getConn();
    const r = await c.query('DELETE FROM custom_exercise_rows WHERE id = $1 AND owner_id = $2', [id, ownerId]);
    const m = /^DELETE (\d+)$/.exec(r.commandTag || '');
    return !!m && Number(m[1]) > 0;
  });
}
// Mirrors findExLibEntry's exact priority order in server.js (the acting user's own list, then —
// if a session creator is given and differs — the creator's own list, then a fully global first
// match) — three sequential queries, each only run if the previous found nothing, same
// short-circuiting shape as the in-memory version's three lookups. Used by the shadow-compare
// during the dual-write phase; not yet the real path server.js's own findExLibEntry takes (that
// cutover is a later step, same two-phase shape as the notifications+feed-events slice).
async function pgFindCustomExerciseRowByName(name, userId, creatorId) {
  return enqueue(async () => {
    const c = getConn();
    let r = await c.query(`SELECT data FROM custom_exercise_rows WHERE owner_id = $1 AND data->>'name' = $2 LIMIT 1`, [userId, name]);
    if (r.rows.length) return JSON.parse(r.rows[0].data);
    if (creatorId && creatorId !== userId) {
      r = await c.query(`SELECT data FROM custom_exercise_rows WHERE owner_id = $1 AND data->>'name' = $2 LIMIT 1`, [creatorId, name]);
      if (r.rows.length) return JSON.parse(r.rows[0].data);
    }
    r = await c.query(`SELECT data FROM custom_exercise_rows WHERE data->>'name' = $1 LIMIT 1`, [name]);
    return r.rows.length ? JSON.parse(r.rows[0].data) : null;
  });
}

module.exports = {
  load, save, close, ensureSchema, EMPTY_DB, getConn,
  pgNotificationHistoryForUser, pgInsertNotification, pgDeleteNotification, pgMergedNotificationWrite, pgPruneOldNotifications,
  pgInsertFeedEvent, pgDeleteFeedEvent, pgGetFeedEvent, pgFeedEventsSince, pgToggleFeedEventReaction, pgPruneOldFeedEvents,
  pgGetPushSub, pgSetPushSub, pgDeletePushSubIfEndpointMatches, pgDeletePushSub,
  pgInsertReport, pgListReports, pgResolveReport,
  pgUpsertCustomExerciseRow, pgGetCustomExerciseRow, pgListCustomExerciseRowsByOwner, pgListAllCustomExerciseRows, pgDeleteCustomExerciseRow, pgFindCustomExerciseRowByName,
};
