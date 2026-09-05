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

const EMPTY_DB = () => ({ users: {}, sessions: {}, templates: {}, pushSubs: {}, customExercises: {}, prs: {}, crews: {} });

// Reassembles the exact in-memory shape server.js has always used, from Postgres rows.
async function load() {
  await ensureSchema();
  const c = getConn();
  const d = EMPTY_DB();

  // Keyed by the table's own `id` COLUMN, not a `.id` field read back out of the parsed JSON.
  // A malformed/hand-edited row can have `data` be JSON null, or an object with no `id` at
  // all — this app has real production history of exactly this kind of malformed row (see
  // migrateSessionShapes() in server.js). The row's own primary key is always authoritative
  // and always present; migrateSessionShapes() (which runs right after load(), before anything
  // else touches DB.sessions) is what actually decides whether a null/malformed entry gets
  // healed or dropped — load() must not crash before that healing step ever gets a chance to run.
  const users = await c.query('SELECT id, data FROM users');
  for (const row of users.rows) { d.users[row.id] = JSON.parse(row.data); }

  const sessions = await c.query('SELECT id, data FROM sessions');
  for (const row of sessions.rows) { d.sessions[row.id] = JSON.parse(row.data); }

  const templates = await c.query('SELECT id, data FROM templates');
  for (const row of templates.rows) { d.templates[row.id] = JSON.parse(row.data); }

  const pushSubs = await c.query('SELECT user_id, data FROM push_subs');
  for (const row of pushSubs.rows) { d.pushSubs[row.user_id] = JSON.parse(row.data); }

  const customExercises = await c.query('SELECT owner_id, data FROM custom_exercises');
  for (const row of customExercises.rows) { d.customExercises[row.owner_id] = JSON.parse(row.data); }

  const prs = await c.query('SELECT user_id, data FROM prs');
  for (const row of prs.rows) { d.prs[row.user_id] = JSON.parse(row.data); }

  const crews = await c.query('SELECT id, data FROM crews');
  for (const row of crews.rows) { d.crews[row.id] = JSON.parse(row.data); }

  // Small singleton bookkeeping fields server.js reads/writes directly on DB (not per-entity
  // data) — followApprovalV1 is a boot migration's "did this already run" marker (see
  // migrateFollowApproval() in server.js). It's a BOOT migration, not a one-time import
  // transform, so it must be persisted or it reruns every restart — and it is NOT idempotent
  // against real follow activity: it recomputes `followers` from `friends`, so any follower
  // gained through the actual product flow would be silently dropped back into a pending
  // request on every deploy if this flag were lost. Stored as a row in app_state, mapped back
  // onto DB by name so server.js's call sites (DB.followApprovalV1 = ...) don't change at all.
  const state = await c.query('SELECT key, value FROM app_state');
  for (const row of state.rows) { d[row.key] = JSON.parse(row.value); }

  return d;
}

// Top-level DB fields that are singleton bookkeeping, not per-entity collections — mirrored
// into app_state by save() instead of one of the per-entity tables above.
const SINGLETON_FIELDS = ['followApprovalV1'];

// Upserts every row of every collection inside one transaction. At this app's scale this is
// trivial for Postgres and keeps save()'s ~40 call sites in server.js completely unchanged —
// every existing `await save(DB)` call still persists "the whole current state," just
// atomically and without rewriting a shared file. A row whose in-memory entry was deleted
// (e.g. a session removed) is deleted here too, so Postgres never accumulates ghosts save()
// itself no longer knows about.
//
// save() itself is serialized below (saveQueue) — two overlapping save(DB) calls (e.g. two
// concurrent requests each awaiting their own save(DB)) would otherwise interleave their
// statements on the ONE singleton connection: PgConnection's FIFO queue only serializes
// individual SQL statements, not whole BEGIN...COMMIT blocks, so a second `BEGIN` while one is
// already open is just a no-op warning to Postgres, not a new transaction — both calls end up
// sharing one transaction, and one call's ROLLBACK (triggered by its own unrelated failure)
// could silently discard the other call's already-"successful" write. Queuing whole save()
// calls end-to-end here — not just their individual statements — closes that window.
let saveQueue = Promise.resolve();
async function save(d) {
  const run = saveQueue.then(() => doSave(d));
  saveQueue = run.then(() => {}, () => {}); // keep the queue alive even if this save() rejects
  return run;
}
async function doSave(d) {
  const c = getConn();
  await c.begin();
  try {
    // username_lower matches server.js's own normUser() exactly: String(v == null ? '' : v)
    // .trim().toLowerCase() — substituting '' only for null/undefined, NOT for every falsy
    // value. A looser expression here would let this pre-check pass while the UNIQUE
    // constraint below still collides (or vice versa) — kept byte-for-byte in sync with
    // normUser() in server.js on purpose.
    await syncTable(c, 'users', 'id', d.users, (id, u) => [id, String((u && u.username) == null ? '' : u.username).trim().toLowerCase(), JSON.stringify(u)],
      'INSERT INTO users (id, username_lower, data) VALUES ($1, $2, $3::jsonb) ON CONFLICT (id) DO UPDATE SET username_lower = EXCLUDED.username_lower, data = EXCLUDED.data');
    await syncTable(c, 'sessions', 'id', d.sessions, (id, s) => [id, JSON.stringify(s)],
      'INSERT INTO sessions (id, data) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data');
    await syncTable(c, 'templates', 'id', d.templates, (id, t) => [id, JSON.stringify(t)],
      'INSERT INTO templates (id, data) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data');
    await syncTable(c, 'push_subs', 'user_id', d.pushSubs, (id, v) => [id, JSON.stringify(v)],
      'INSERT INTO push_subs (user_id, data) VALUES ($1, $2::jsonb) ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data');
    await syncTable(c, 'custom_exercises', 'owner_id', d.customExercises, (id, v) => [id, JSON.stringify(v)],
      'INSERT INTO custom_exercises (owner_id, data) VALUES ($1, $2::jsonb) ON CONFLICT (owner_id) DO UPDATE SET data = EXCLUDED.data');
    await syncTable(c, 'prs', 'user_id', d.prs, (id, v) => [id, JSON.stringify(v)],
      'INSERT INTO prs (user_id, data) VALUES ($1, $2::jsonb) ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data');
    await syncTable(c, 'crews', 'id', d.crews, (id, v) => [id, JSON.stringify(v)],
      'INSERT INTO crews (id, data) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data');
    for (const key of SINGLETON_FIELDS) {
      if (d[key] === undefined) continue;
      await c.query('INSERT INTO app_state (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, JSON.stringify(d[key])]);
    }
    await c.commit();
  } catch (e) {
    await c.rollback();
    throw e;
  }
}

// Upserts every entry currently in `obj`, and deletes any DB row whose key is no longer
// present in `obj` — keeps Postgres from accumulating rows for entities that were removed
// from the in-memory DB (e.g. a deleted session) since the last save().
//
// Sep 2026: a caller passing a DB-shaped object that predates a newer collection (found via the
// `crews` addition — scripts/migrate-to-postgres.mjs builds its object from a fixed field list,
// and an old export naturally has no `crews` key at all) used to throw `Object.keys(undefined)`
// here and abort the WHOLE save, not just skip that one collection. `obj || {}` treats "this
// collection doesn't exist in what I was handed" the same as "it's empty" — exactly the same
// forgiving instinct scripts/migrate-to-postgres.mjs already applies at its own call site
// (`raw.crews || {}`), just applied here too so every OTHER future save()-adjacent caller gets
// the same protection automatically instead of needing to remember it.
async function syncTable(c, table, keyCol, obj, toParams, upsertSql) {
  const keys = Object.keys(obj || {});
  for (const k of keys) {
    await c.query(upsertSql, toParams(k, obj[k]));
  }
  const existing = await c.query(`SELECT ${keyCol} as k FROM ${table}`);
  const keep = new Set(keys);
  for (const row of existing.rows) {
    if (!keep.has(row.k)) await c.query(`DELETE FROM ${table} WHERE ${keyCol} = $1`, [row.k]);
  }
}

function close() { if (conn) { conn.close(); conn = null; } }

module.exports = { load, save, close, ensureSchema, EMPTY_DB, getConn };
