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
-- Oct 16 2026 (users slice, decision #2 -- scalar profile/settings column normalization, after
-- decision #1 above moved followers/following/followReqs off this blob into user_follows). Jeff,
-- "yes" (authorizing this now rather than later): the ~19 scalar profile/settings fields every
-- user object carries -- identity (username, displayName, bio, avatar), settings (defaultGym,
-- profileVisibility, units, trainingPhase, notifyStreakReminders, notifyWorkoutReminders), auth
-- (pinHash, pinSalt), account lifecycle (createdAt, createdAtEstimated, deleted, deletedAt,
-- tokensValidFrom), and small timestamps (seenRirExplainer, lastStreakReminderAt,
-- lastWorkoutReminderAt) -- move out of the jsonb blob into real columns, same "Option A: stays
-- cached in memory, only the storage shape moves" call Jeff already made for the crew row, not
-- the "removed from memory" shape messages/challenges/user_follows' own blob fields got. No
-- forcing bug behind this one either (unlike decision #1) -- pure storage-shape/scale-readiness,
-- disclosed to Jeff as such before starting.
--
-- ADD COLUMN IF NOT EXISTS, same reason as crews below: this table already has real production
-- rows. All nullable -- see migrateUserScalarColumnsIntoPostgres() in server.js for the one-time
-- backfill from the old 'data' blob, and doLoad() below for why NOT NULL isn't enforced at the
-- schema level. 'username IS NULL' is this table's migration-complete signal, mirroring crews'
-- 'name IS NULL' -- every real user always has a non-empty username (same invariant
-- username_lower above already relies on), so NULL here unambiguously means "not yet backfilled."
-- Unlike crews, 'data' KEEPS its NOT NULL constraint and keeps being written forever, even for a
-- fully-migrated row -- blocked[] (still unbounded, flagged, not moved) and a handful of dead
-- legacy fields (friends, incoming, outgoing, ...) still live there, so the blob is never actually
-- empty the way a migrated crew row's is. See usersToParams' own comment for exactly which fields
-- stop being written into 'data' once a row's id is in userColumnsMigrated, and which never do.
ALTER TABLE users ADD COLUMN IF NOT EXISTS username text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS bio text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS default_gym text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_visibility text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS units text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at_estimated boolean;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pin_hash text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pin_salt text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted boolean;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS tokens_valid_from text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS seen_rir_explainer boolean;
ALTER TABLE users ADD COLUMN IF NOT EXISTS training_phase text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_streak_reminders boolean;
ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_workout_reminders boolean;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_streak_reminder_at text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_workout_reminder_at text;
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
-- Backs pgFindCustomExerciseRowByName's global by-name fallback query (below) -- a WHERE on this
-- expression index instead of a table scan. Table is tiny today (a few hundred rows at most) so
-- this isn't solving a real performance problem yet -- it's here because it's nearly free to add
-- now and this is exactly the kind of lookup that gets slow silently if left until it's actually
-- slow. (Oct 16 2026, read cutover: findExLibEntry itself -- server.js's own by-name lookup used
-- by Progress/volume -- does NOT hit this table per lookup -- see that function's own comment for
-- why it takes a pre-fetched row list instead. This index is for pgFindCustomExerciseRowByName's
-- direct callers, and for any future direct-Postgres caller that does need a single-name query.)
CREATE INDEX IF NOT EXISTS custom_exercise_rows_name_idx ON custom_exercise_rows ((data->>'name'));
CREATE TABLE IF NOT EXISTS prs (
  user_id text PRIMARY KEY,
  data jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS crews (
  id text PRIMARY KEY,
  data jsonb NOT NULL
);
-- Oct 16 2026 (crews deep-dive, decision #2 -- crew-row normalization, after decision #1 below
-- moved messages/challenges off this blob): name/owner_id/created_at pulled out of the jsonb blob
-- into real columns, and memberIds gets a real join table (crew_members) instead of a json array
-- -- Jeff's call, after being shown there's no bug behind this one (unlike decision #1): "normalize
-- the crew row anyway" (Option A -- real columns, but crews stays loaded into memory at boot
-- exactly like users/sessions/templates always have, since there's no growth/concurrency problem
-- here to fix by removing that cache -- see CLAUDE.md). ADD COLUMN IF NOT EXISTS rather than
-- editing the CREATE TABLE above -- this table already has real production rows, and CREATE TABLE
-- IF NOT EXISTS is a no-op against one that already exists, so the new columns have to be added
-- explicitly. All three start nullable -- see migrateCrewRowColumnsIntoPostgres() in server.js for
-- the one-time backfill from the old 'data' blob, and doLoad() below for why NOT NULL isn't
-- enforced at the schema level (name IS NULL is also how doLoad() tells a not-yet-backfilled row
-- apart from a migrated one, so it can fall back to parsing 'data' for just that one row instead
-- of crashing boot over it). The OLD 'data' column is left in place, unused, once a row is
-- migrated -- not maintained, not dropped -- same "leave dead weight rather than risk an
-- irreversible DROP" call this project already made for custom_exercises/DB.friendships.
ALTER TABLE crews ADD COLUMN IF NOT EXISTS name text;
ALTER TABLE crews ADD COLUMN IF NOT EXISTS owner_id text;
ALTER TABLE crews ADD COLUMN IF NOT EXISTS created_at text;
-- The original CREATE TABLE above declared 'data jsonb NOT NULL' back when it was this table's
-- only column. A row created AFTER this migration never has a 'data' blob at all (there's no
-- legacy shape left to carry), so the NOT NULL constraint has to go -- caught live writing this
-- migration's own first test: a brand-new crew's INSERT (which only ever sets id/name/owner_id/
-- created_at now) 500'd on "null value in column data violates not-null constraint" before this
-- line existed.
ALTER TABLE crews ALTER COLUMN data DROP NOT NULL;
-- seq preserves the member list's real order (owner first, then invite/keep order) across a
-- restart -- a bare join table has no inherent row order, and that order is genuinely visible to
-- Jeff's users: the crew-list card's avatar stack (first 4, "+N more") and the crew page's member
-- roster both render straight off this array's own order (see publicCrew() in server.js and
-- avatar-stack/memberRows in app.js). Without this, a restart could silently reshuffle whose
-- avatar shows first -- found while designing this migration, not an existing bug, but a real
-- regression this schema change could have introduced if memberIds just became an unordered set.
CREATE TABLE IF NOT EXISTS crew_members (
  crew_id text NOT NULL,
  user_id text NOT NULL,
  seq integer NOT NULL,
  PRIMARY KEY (crew_id, user_id)
);
CREATE INDEX IF NOT EXISTS crew_members_crew_idx ON crew_members (crew_id);
-- Oct 16 2026 (crews deep-dive, decision #1 of the crews migration pre-mortem, Jeff: "do it right
-- the first time" -- same reasoning as the custom-exercises redesign): crews.data used to embed
-- BOTH of these as arrays that grew without limit for as long as a crew stayed active (every chat
-- message ever sent, every weekly challenge ever run), rewriting the ENTIRE crew blob -- every
-- past message, every past challenge -- on every single new one. One row per message/challenge
-- instead, same shape as custom_exercise_rows below: a write only ever touches its own row.
CREATE TABLE IF NOT EXISTS crew_messages (
  id text PRIMARY KEY,
  crew_id text NOT NULL,
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS crew_messages_crew_idx ON crew_messages (crew_id);
CREATE TABLE IF NOT EXISTS crew_challenges (
  id text PRIMARY KEY,
  crew_id text NOT NULL,
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS crew_challenges_crew_idx ON crew_challenges (crew_id);
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
-- Oct 16 2026 (users slice, decision #1 -- follow-graph redesign, pre-mortem shown to Jeff): each
-- user used to carry three separate plain arrays (followers/following/followReqs) embedded in
-- their own data blob, with no cap -- the same growth/rewrite-size shape the crews chat/challenges
-- fix already solved once (syncTableDiff rewrites a user's ENTIRE row on any change, so gaining
-- one new follower meant rewriting the whole account, every existing follower included, not just
-- the new one). Jeff's call, same as custom exercises/crew messages before it: "redesign now"
-- rather than wait for this to actually bite (nobody's close to a size where it would yet).
--
-- One row per follow relationship replaces all three arrays with a single source of truth: an
-- 'accepted' row IS the edge that me.following and target.followers used to separately (and
-- redundantly) represent from each side, and a 'pending' row IS what target.followReqs alone used
-- to hold. follower_id/followee_id name the DIRECTION explicitly (follower_id wants to follow, or
-- already follows, followee_id) so a row never needs the reader to infer who's who. created_at
-- preserves insertion order -- GET /api/notifications' followRequests listing shows pending
-- requests newest-first by reversing the array it's always been handed, which only stays correct
-- if rows come back in the same order they were created.
--
-- This does NOT remove followers/following/followReqs from the running app's in-memory user
-- objects the way crew messages/challenges were removed from DB.crews -- doLoad() below rebuilds
-- them on every boot from this table, so every synchronous reader (canSeeProfile, publicUser,
-- profileOf, connectionsOf -- used throughout nearly every profile/session/search response) keeps
-- working completely unmodified. Only PERSISTENCE moves to this table (see usersToParams,
-- syncUserFollowsFull/Diff below) -- the same "stays cached, only the underlying storage moves"
-- shape Jeff picked for the crew row itself (Option A), not the "removed from memory" shape
-- messages/challenges got, because canSeeProfile alone would have to become async and ripple into
-- everything that calls it, for no problem that actually needs that trade.
CREATE TABLE IF NOT EXISTS user_follows (
  follower_id text NOT NULL,
  followee_id text NOT NULL,
  status text NOT NULL,
  created_at text,
  PRIMARY KEY (follower_id, followee_id)
);
CREATE INDEX IF NOT EXISTS user_follows_followee_idx ON user_follows (followee_id);
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
// through pgListReports/pgInsertReport/pgResolveReport now.
// Oct 16 2026 (same slice, read cutover, task #258+ phase 2): `customExercises` dropped too, the
// LAST piece of this slice. Unlike push subs/notifications/feed-events/reports, this one did not
// just move the SAME shape behind direct-Postgres functions -- Jeff picked a genuine redesign
// (one row per exercise, custom_exercise_rows, instead of one array per owner) back at this
// slice's own pre-mortem, to remove a concurrent-edit race by construction instead of managing it
// with a transaction. GET /api/exercises, findExLibEntry, findMyCustomExercise, and the create/
// edit/delete routes all read/write exclusively through pgUpsertCustomExerciseRow/
// pgGetCustomExerciseRow/pgListCustomExerciseRowsByOwner/pgListAllCustomExerciseRows/
// pgDeleteCustomExerciseRow now (see "direct Postgres access" below). pgFindCustomExerciseRowByName
// is exported from the same section but NOT currently called from anywhere in server.js -- see
// its own comment for why. The OLD custom_exercises table (array-per-owner) is left in place, unused -- not
// dropped, same "leave dead weight rather than risk an irreversible DROP" call this project
// already made once for DB.friendships (see this file's top comment) -- but nothing reads or
// writes it any more, including the one-shot scripts/migrate-to-postgres.mjs restore path, which
// now flattens straight into custom_exercise_rows instead (see that script's own comment).
const EMPTY_DB = () => ({ users: {}, sessions: {}, templates: {}, prs: {}, crews: {} });

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

// Oct 16 2026 (read cutover, task #258+ phase 2): custom_exercises dropped from this baseline --
// unlike notifications/reports/feed_events just below, which each KEPT a bootstrapping-only
// syncTableFull branch in doSave for scripts/migrate-to-postgres.mjs's one-shot restore path (see
// that function's own comment), custom_exercises has no such branch left at all. Those three kept
// writing into the exact same table/shape their new direct-Postgres functions already read, so
// migrate-to-postgres.mjs restoring into that same table was still correct. custom_exercises
// (array-per-owner) and custom_exercise_rows (one row per exercise) are genuinely different
// shapes -- nothing reads the old table any more, including that restore script, which now
// flattens straight into custom_exercise_rows instead (see its own comment) -- so there is no
// bootstrapping write left for this baseline to track either.
function freshSnapshot() {
  return { users: {}, sessions: {}, templates: {}, prs: {}, crews: {}, notifications: {}, reports: {}, feed_events: {}, singletons: {}, userFollows: {} };
}

// Oct 16 2026 (users slice, decision #1): sticky in-process flag, mirroring lastPersisted just
// below -- true once a load() has confirmed the one-time follow-graph flatten
// (migrateUserFollowsIntoPostgres, server.js) has already run. Read by usersToParams (to decide
// whether followers/following/followReqs belong in the blob) and by doLoad() itself (to decide
// whether those three fields should be rebuilt from user_follows or trusted from the blob as-is).
// Set from d.userFollowsTableV1 at the top of every doLoad() call, and flipped true directly by
// markFollowsTableReady() the moment the migration itself completes, so the SAME boot that just
// migrated also starts excluding these fields from any later save() in that process, not only
// after a restart.
let followsTableReady = false;
function markFollowsTableReady() { followsTableReady = true; }

// Oct 16 2026 (users slice, decision #2 -- scalar column normalization): per-ROW counterpart to
// followsTableReady just above, not a single global flag -- unlike decision #1's follow-graph
// flatten (one all-or-nothing pass across the whole dataset), this migration backfills each
// user's columns independently (same per-row shape crews' own column backfill uses, retry-on-
// failure included), so "is this id done" has to be a per-id answer. Populated two ways: by
// doLoad() below for every row already migrated as of THIS boot (its `username` column is
// already non-null at load time), and by markUserColumnsMigrated() itself, called by
// migrateUserScalarColumnsIntoPostgres() (server.js) right after it successfully backfills a
// not-yet-migrated row during this boot -- mirroring markFollowsTableReady()'s role, just keyed
// per-id via .add(id) instead of a single boolean flip. Read by usersToParams (to decide whether
// THIS user's ~19 scalar fields still belong in the blob) -- a user not in this set always gets
// the old full-blob write, which is always correct (just redundant with the real columns once
// they're filled in by the backfill), so there's no failure mode where a not-yet-migrated row's
// data goes unwritten.
const userColumnsMigrated = new Set();
function markUserColumnsMigrated(id) { userColumnsMigrated.add(id); }
// Oct 16 2026 (users decision #1, CRITICAL fix -- found independently by BOTH review passes on
// this slice, each reproduced live): migrateUserFollowsIntoPostgres() (server.js) writes the real
// edges straight to Postgres via pgUpsertFollowEdge, bypassing doSave()'s own diffing entirely,
// then deletes followers/following/followReqs from every in-memory user. Without this function,
// the very next save(DB) in that same boot (server.js's boot IIFE calls it immediately after the
// migration, before app.listen) would diff that now-empty in-memory state against
// lastPersisted.userFollows -- which doLoad() captured from the PRE-migration blob, before this
// migration had ever run. On a synthetic "first boot ever" test with no real legacy data that
// baseline happens to already be empty too, which is exactly why this was missed in testing: on
// any REAL deploy (where migrateFollowApproval already ran months ago and users have genuine
// following/followReqs content sitting in their blob), that baseline is NON-empty, so every user
// with real follow data "changed," and syncUserFollowsDiff calls writeUserFollowEdges for each
// one -- which DELETEs the edges the migration just wrote and reinserts from the now-empty
// arrays. Net effect: total, silent loss of the whole follow graph, in the same boot that
// migrated it, on every real deploy. Reproduced live against a seeded user with genuine
// following/followReqs content before this fix (confirmed by hand: user_follows was empty after
// boot despite the migration's own log line claiming edges were flattened).
//
// The fix: reset the baseline to the TRUE current (post-deletion) state right after the
// migration runs, so the following save() correctly sees "no change" for these fields and leaves
// the table alone. Exported so server.js's migration can call it directly, right alongside
// markFollowsTableReady().
function syncUserFollowsBaseline(users) {
  if (!lastPersisted) return;   // bootstrapping (no load() baseline yet) -- nothing to correct; the bootstrap save path below doesn't consult this baseline anyway
  const map = {};
  for (const id of Object.keys(users || {})) map[id] = userFollowKey(users[id]);
  lastPersisted.userFollows = map;
}
// The one piece of each user's state that still needs its own derived diff key: comparing the
// FULL user object (as syncTableDiff's generic diff already does) would also catch a pure
// follow-list change and trigger a redundant blob rewrite -- not wrong, since the actual blob
// payload is unchanged, just wasted I/O. Accepted as a minor, disclosed inefficiency rather than
// threading a second comparison key into the generic syncTableDiff machinery other tables share;
// this key is only used for user_follows' OWN diff (syncUserFollowsDiff below), which is separate
// from and unaffected by that inefficiency.
function userFollowKey(u) {
  return JSON.stringify({
    following: Array.isArray(u && u.following) ? u.following : [],
    followReqs: Array.isArray(u && u.followReqs) ? u.followReqs : [],
  });
}

// Oct 16 2026 (users slice, decision #2): pgmini's client always requests TEXT result format
// (see its own comment on PgConnection.query) -- every value comes back as a string or null,
// never a native JS type. For a jsonb column that's fine (JSON.parse handles it), but a
// Postgres `boolean` column comes back as the literal one-character string 't' or 'f', NOT a JS
// true/false -- and 'f' is a non-empty string, so it's TRUTHY in JS. Found at pre-mortem time,
// before any code shipped: skipping this conversion would have silently flipped every false/
// not-yet-set flag (deleted, createdAtEstimated, seenRirExplainer, notifyStreakReminders,
// notifyWorkoutReminders) to "on" for every migrated user, the moment this landed. Every one of
// this migration's new boolean-shaped columns is decoded through this helper, never trusted as
// already being a real boolean.
function pgBool(v) { return v === null ? null : v === 't'; }

// Oct 16 2026 (users slice, decision #2): overlays a migrated row's real columns onto the
// freshly-parsed user object (mutates `u` in place), AFTER JSON.parse(row.data) -- same
// "the real column wins over whatever's still in the blob" rule decision #1 already applies to
// followers/following/followReqs just above in doLoad(). ONLY sets a key when the column is
// NOT null -- deliberately NOT the "always overwrite, defaulting to a chosen value" shape
// decision #1 uses for followers/following/followReqs (those always get a real default, `[]`,
// because "no followers" is a meaningful value every user has). There's no equivalent sane
// default for most of these ~20 fields (a user who's never touched training-phase or bio has no
// honest value to invent), and a column is null in exactly the cases where the field was never
// set on the object in the first place (userColumnParams below writes null ONLY when the
// in-memory field was already null/undefined) -- so skipping the key here faithfully reproduces
// "this field was never set," the exact shape the blob itself always had before this migration
// existed, rather than manufacturing a `key: null` entry that wasn't there before.
//
// Found live, not hypothetically: scripts/migrate-to-postgres.mjs's own read-back verification
// (deep-equality against the literal source backup file) failed on a hand-built old-style backup
// with a sparse user object (just id/username/pin/displayName) the first time this used
// unconditional assignment -- the read-back grew 18 extra `field: null` keys the source file
// never had, and the script's (correct, deliberately strict) deep-equal check flagged that as
// "content does not match the source file," a false FATAL during what should have been a clean
// disaster-recovery restore. Fixed by only ever adding a key, never materializing one that
// wasn't already meaningfully present.
function applyUserColumnsRow(u, row) {
  if (row.username !== null) u.username = row.username;
  if (row.display_name !== null) u.displayName = row.display_name;
  if (row.bio !== null) u.bio = row.bio;
  if (row.avatar !== null) u.avatar = row.avatar;
  if (row.default_gym !== null) u.defaultGym = row.default_gym;
  if (row.profile_visibility !== null) u.profileVisibility = row.profile_visibility;
  if (row.units !== null) u.units = row.units;
  if (row.created_at !== null) u.createdAt = row.created_at;
  if (row.created_at_estimated !== null) u.createdAtEstimated = pgBool(row.created_at_estimated);
  if (row.pin_hash !== null) u.pinHash = row.pin_hash;
  if (row.pin_salt !== null) u.pinSalt = row.pin_salt;
  if (row.deleted !== null) u.deleted = pgBool(row.deleted);
  if (row.deleted_at !== null) u.deletedAt = row.deleted_at;
  if (row.tokens_valid_from !== null) u.tokensValidFrom = row.tokens_valid_from;
  if (row.seen_rir_explainer !== null) u.seenRirExplainer = pgBool(row.seen_rir_explainer);
  if (row.training_phase !== null) u.trainingPhase = row.training_phase;
  if (row.notify_streak_reminders !== null) u.notifyStreakReminders = pgBool(row.notify_streak_reminders);
  if (row.notify_workout_reminders !== null) u.notifyWorkoutReminders = pgBool(row.notify_workout_reminders);
  if (row.last_streak_reminder_at !== null) u.lastStreakReminderAt = row.last_streak_reminder_at;
  if (row.last_workout_reminder_at !== null) u.lastWorkoutReminderAt = row.last_workout_reminder_at;
}
// The same ~19 field names just above, as the keys they're stored under on the in-memory user
// object -- used by usersToParams to strip them out of the blob once a row is in
// userColumnsMigrated. Kept as one array rather than repeating the list a third time.
const USER_SCALAR_COLUMN_FIELDS = [
  'username', 'displayName', 'bio', 'avatar', 'defaultGym', 'profileVisibility', 'units',
  'createdAt', 'createdAtEstimated', 'pinHash', 'pinSalt', 'deleted', 'deletedAt',
  'tokensValidFrom', 'seenRirExplainer', 'trainingPhase', 'notifyStreakReminders',
  'notifyWorkoutReminders', 'lastStreakReminderAt', 'lastWorkoutReminderAt',
];
// Oct 16 2026 (users slice, decision #2): the fresh column VALUES for a user, derived straight
// from the current in-memory object -- called unconditionally by usersToParams below, regardless
// of userColumnsMigrated membership (see that function's own comment for why always-write is
// deliberate, not a bug to guard against). `username` gets the same defense-in-depth crews'
// crewRowParams already uses for `name`: never write a falsy value into the column that doLoad()
// treats as the migration-complete signal, even from some future caller that hands this a
// malformed object -- id (always real, always present) is the fallback here, mirroring crews'
// 'Crew' fallback for the same reason. Every other field is left exactly as it is on `u`,
// including null/undefined -- there's no equivalent signal-column risk for any of the other 19,
// so no fallback is needed or wanted for them (a real null should stay a real null).
function userColumnParams(id, u) {
  const username = (u && typeof u.username === 'string' && u.username.trim()) ? u.username : id;
  return [
    username,
    (u && u.displayName) == null ? null : String(u.displayName),
    (u && u.bio) == null ? null : String(u.bio),
    (u && u.avatar) == null ? null : String(u.avatar),
    (u && u.defaultGym) == null ? null : String(u.defaultGym),
    (u && u.profileVisibility) == null ? null : String(u.profileVisibility),
    (u && u.units) == null ? null : String(u.units),
    (u && u.createdAt) == null ? null : String(u.createdAt),
    (u && u.createdAtEstimated) == null ? null : !!u.createdAtEstimated,
    (u && u.pinHash) == null ? null : String(u.pinHash),
    (u && u.pinSalt) == null ? null : String(u.pinSalt),
    (u && u.deleted) == null ? null : !!u.deleted,
    (u && u.deletedAt) == null ? null : String(u.deletedAt),
    (u && u.tokensValidFrom) == null ? null : String(u.tokensValidFrom),
    (u && u.seenRirExplainer) == null ? null : !!u.seenRirExplainer,
    (u && u.trainingPhase) == null ? null : String(u.trainingPhase),
    (u && u.notifyStreakReminders) == null ? null : !!u.notifyStreakReminders,
    (u && u.notifyWorkoutReminders) == null ? null : !!u.notifyWorkoutReminders,
    (u && u.lastStreakReminderAt) == null ? null : String(u.lastStreakReminderAt),
    (u && u.lastWorkoutReminderAt) == null ? null : String(u.lastWorkoutReminderAt),
  ];
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

  // Oct 16 2026 (users slice, decision #1): moved here from the bottom of this function --
  // userFollowsTableV1 (the migration's own "already ran" flag) has to be known BEFORE users are
  // loaded just below, so this function can decide whether followers/following/followReqs should
  // come from the old embedded blob or from user_follows. Nothing else about this block changed,
  // and moving it earlier doesn't change what server.js ever sees -- doLoad() still returns the
  // whole `d` object at the end either way.
  const state = await c.query('SELECT key, value FROM app_state');
  for (const row of state.rows) { d[row.key] = JSON.parse(row.value); snap.singletons[row.key] = JSON.stringify(d[row.key]); }
  followsTableReady = !!d.userFollowsTableV1;

  // Keyed by the table's own `id` COLUMN, not a `.id` field read back out of the parsed JSON.
  // A malformed/hand-edited row can have `data` be JSON null, or an object with no `id` at
  // all — this app has real production history of exactly this kind of malformed row (see
  // migrateSessionShapes() in server.js). The row's own primary key is always authoritative
  // and always present; migrateSessionShapes() (which runs right after load(), before anything
  // else touches DB.sessions) is what actually decides whether a null/malformed entry gets
  // healed or dropped — load() must not crash before that healing step ever gets a chance to run.
  // Oct 16 2026 (users slice, decision #2 -- scalar column normalization): the ~19 new columns
  // are read alongside `data` on every load, same as crews' name/owner_id/created_at above.
  // `username IS NULL` (row.username, the new real column -- distinct from username_lower,
  // which has always existed and is NOT this signal) means this row hasn't been backfilled yet,
  // so it's left exactly as before: the blob is the only source for these fields, and this id is
  // NOT added to userColumnsMigrated, so usersToParams keeps writing the full blob for it too. A
  // migrated row gets its real columns overlaid onto the freshly-parsed blob below (authoritative
  // over whatever happens to still be sitting in `data` for these fields -- same "the real column
  // wins over a possibly-stale blob copy" rule decision #1 already established for followers/
  // following/followReqs) and is added to the set, so usersToParams starts excluding these same
  // fields from this id's blob on the very next save.
  const users = await c.query(
    'SELECT id, data, username, display_name, bio, avatar, default_gym, profile_visibility, units, ' +
    'created_at, created_at_estimated, pin_hash, pin_salt, deleted, deleted_at, tokens_valid_from, ' +
    'seen_rir_explainer, training_phase, notify_streak_reminders, notify_workout_reminders, ' +
    'last_streak_reminder_at, last_workout_reminder_at FROM users'
  );
  for (const row of users.rows) {
    d.users[row.id] = JSON.parse(row.data);
    if (row.username !== null) {
      applyUserColumnsRow(d.users[row.id], row);
      userColumnsMigrated.add(row.id);
    }
  }

  // Oct 16 2026 (users slice, decision #1 -- follow-graph redesign): once the one-time flatten
  // (migrateUserFollowsIntoPostgres, server.js) has run, user_follows is the sole source of truth
  // for these three fields -- this OVERWRITES whatever's on the freshly-parsed blob (normally
  // nothing at all, since the migration deletes them before a user object is ever saved again --
  // see usersToParams' own comment -- but a stale copy from an old backup restored after this
  // shipped should never be trusted over the real table). Before the flag is set, this is skipped
  // entirely and the blob's own embedded arrays stay authoritative, exactly as before this
  // migration existed -- which is what lets the migration itself read them in the first place.
  if (followsTableReady) {
    const followers = {}, following = {}, followReqs = {};
    const follows = await c.query('SELECT follower_id, followee_id, status FROM user_follows ORDER BY created_at');
    for (const row of follows.rows) {
      if (row.status === 'accepted') {
        (following[row.follower_id] || (following[row.follower_id] = [])).push(row.followee_id);
        (followers[row.followee_id] || (followers[row.followee_id] = [])).push(row.follower_id);
      } else if (row.status === 'pending') {
        (followReqs[row.followee_id] || (followReqs[row.followee_id] = [])).push(row.follower_id);
      }
    }
    for (const id of Object.keys(d.users)) {
      d.users[id].followers = followers[id] || [];
      d.users[id].following = following[id] || [];
      d.users[id].followReqs = followReqs[id] || [];
    }
  }
  for (const row of users.rows) {
    // AFTER the overwrite above, not right after parsing -- so this diff baseline matches the
    // TRUE in-memory state the rest of this boot will actually run with, not a stale blob-era
    // copy. Getting this order wrong would make syncTableDiff think every single user "changed"
    // on the very first save() after every future boot (see that function's own comment on why a
    // mismatched baseline format is exactly the kind of bug that's bitten this file before).
    snap.users[row.id] = JSON.stringify(d.users[row.id]);
    snap.userFollows[row.id] = userFollowKey(d.users[row.id]);
  }

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

  // Oct 16 2026 (read cutover, task #258+ phase 2): customExercises used to be loaded wholesale
  // here too, same as every other collection -- that's gone now. GET /api/exercises, findExLibEntry,
  // findMyCustomExercise, and every create/edit/delete route in server.js already read/write
  // exclusively through pgUpsertCustomExerciseRow/pgGetCustomExerciseRow/
  // pgListCustomExerciseRowsByOwner/pgListAllCustomExerciseRows/pgDeleteCustomExerciseRow (below),
  // not through an in-memory DB.customExercises map, so there is nothing left for doLoad() to
  // populate or for lastPersisted to baseline here.

  const prs = await c.query('SELECT user_id, data FROM prs');
  for (const row of prs.rows) { d.prs[row.user_id] = JSON.parse(row.data); snap.prs[row.user_id] = JSON.stringify(d.prs[row.user_id]); }

  // Oct 16 2026 (crew-row normalization, decision #2): a crew row might not be backfilled onto
  // the new name/owner_id/created_at columns yet -- migrateCrewRowColumnsIntoPostgres() (server.js)
  // runs AFTER this load(), same boot-sequence position as every other boot migration in this
  // app, so the very first load() after this ships (and any row that migration fails to reach --
  // see its own comment for why that's a real possibility, not just theoretical) sees name still
  // NULL here. name IS NULL is exactly the same gate that migration uses to know a row still
  // needs it, so checking it here too, per row, lets this fall back to the pre-migration shape
  // (parse `data` directly, same as every boot before this one did) instead of crashing or
  // silently losing that crew's membership. A migrated row ignores `data` entirely and is
  // reassembled from the real columns + crew_members below.
  const crewsRaw = await c.query('SELECT id, name, owner_id, created_at, data FROM crews');
  const crewMembersRows = await c.query('SELECT crew_id, user_id FROM crew_members ORDER BY crew_id, seq');
  const membersByCrew = {};
  for (const row of crewMembersRows.rows) {
    (membersByCrew[row.crew_id] || (membersByCrew[row.crew_id] = [])).push(row.user_id);
  }
  for (const row of crewsRaw.rows) {
    if (row.name !== null) {
      d.crews[row.id] = { id: row.id, name: row.name, ownerId: row.owner_id, memberIds: membersByCrew[row.id] || [], createdAt: row.created_at };
    } else {
      const parsed = JSON.parse(row.data);
      d.crews[row.id] = (parsed && typeof parsed === 'object') ? parsed : { id: row.id };
    }
    snap.crews[row.id] = JSON.stringify(d.crews[row.id]);
  }

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
  // (Oct 16 2026: this block itself moved to the TOP of this function -- see the comment up there
  // for why -- this comment stays here since it documents the app_state/SINGLETON_FIELDS
  // convention generally, not just where the one query happens to run.)

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
const SINGLETON_FIELDS = ['followApprovalV1', 'friendsRetiredV1', 'binaryVisibilityV1', 'userFollowsTableV1'];

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
    // Oct 16 2026 (users slice, decision #1 -- follow-graph redesign): followers/following/
    // followReqs no longer belong to the generic users blob sync just above once the one-time
    // flatten has run (see usersToParams' own comment) -- this is their own sync, parallel in
    // spirit to syncCrewsFull/Diff (crews decision #2) but diffing against a derived per-user key
    // (userFollowKey) instead of the whole object, since a user's OWN unrelated field changes
    // (bio, settings, ...) must not trigger a follow-table rewrite that has nothing to do with
    // them. Before the flag is set, this is a no-op that just carries the (empty) prior baseline
    // forward -- the blob is still the only thing being written for these fields at that point.
    pending.userFollows = followsTableReady
      ? (bootstrapping ? await syncUserFollowsFull(c, d.users) : await syncUserFollowsDiff(c, d.users, base.userFollows || {}))
      : (bootstrapping ? {} : (base.userFollows || {}));
    pending.sessions = bootstrapping
      ? await syncTableFull(c, 'sessions', 'id', d.sessions, jsonToParams, SESSIONS_UPSERT_SQL)
      : await syncTableDiff(c, 'sessions', 'id', d.sessions, jsonToParams, SESSIONS_UPSERT_SQL, base.sessions);
    pending.templates = bootstrapping
      ? await syncTableFull(c, 'templates', 'id', d.templates, jsonToParams, TEMPLATES_UPSERT_SQL)
      : await syncTableDiff(c, 'templates', 'id', d.templates, jsonToParams, TEMPLATES_UPSERT_SQL, base.templates);
    // Oct 16 2026 (read cutover, task #258+ phase 2): custom_exercises used to be synced here too,
    // the same generic way as every other table above -- removed, see freshSnapshot()'s own
    // comment for why this one has no bootstrapping-only branch left either, unlike notifications/
    // feed_events/push_subs/reports just below.
    pending.prs = bootstrapping
      ? await syncTableFull(c, 'prs', 'user_id', d.prs, jsonToParams, PRS_UPSERT_SQL)
      : await syncTableDiff(c, 'prs', 'user_id', d.prs, jsonToParams, PRS_UPSERT_SQL, base.prs);
    // Oct 16 2026 (crew-row normalization, decision #2): crews no longer fits the generic
    // syncTableFull/syncTableDiff shape (one row, one jsonb column) -- it's real columns plus a
    // crew_members join table now, so it gets its own pair of sync functions below, same role as
    // syncTableFull/syncTableDiff but also diffing crew membership against that join table.
    pending.crews = bootstrapping
      ? await syncCrewsFull(c, d.crews)
      : await syncCrewsDiff(c, d.crews, base.crews);
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
    // Oct 16 2026 (found while writing a regression test for the custom-exercise-rows orphan fix
    // just below sibling functions, reported to Jeff, fixed same day on his go-ahead): these four
    // bootstrap branches used to run syncTableFull(d.pushSubs) etc. unconditionally whenever
    // bootstrapping was true -- and `d.pushSubs`/`d.notifications`/`d.feedEvents`/`d.reports` are
    // ALWAYS `{}` now for any backup taken since each collection's own cutover (see EMPTY_DB/
    // doLoad() above -- the live DB object, and therefore the JSON.stringify(DB) backup snapshot,
    // has not carried these fields at all since then). syncTableFull's whole point is to be a true
    // full-replace -- upsert what's given AND delete every row NOT given -- so handing it `{}`
    // every time doesn't mean "nothing to restore," it means "delete everything in this table."
    // Reproduced live: seeded a push sub and a report, took a real backup, ran
    // scripts/migrate-to-postgres.mjs against it, watched both rows get deleted while the script
    // printed "Migration verified." Same root cause, same fix shape, as the SINGLETON_FIELDS
    // `d[key] === undefined` convention just below this block already uses: `undefined` means
    // "this save() call has nothing to say about this collection," not "this collection is empty."
    // scripts/migrate-to-postgres.mjs now only sets d.pushSubs/d.notifications/d.feedEvents/
    // d.reports to a real object when the SOURCE FILE actually has that key (an old-style backup
    // taken BEFORE that collection's cutover, where it's a genuine complete snapshot worth fully
    // replacing with) -- see that script's own comment. When the key is absent (every backup from
    // now on), `d.<field>` is `undefined` and the table is left completely untouched: no upsert,
    // no delete, not even a transaction touching it.
    pending.push_subs = bootstrapping
      ? (d.pushSubs !== undefined ? await syncTableFull(c, 'push_subs', 'user_id', d.pushSubs, jsonToParams, PUSH_SUBS_UPSERT_SQL) : {})
      : (base.push_subs || {});
    pending.notifications = bootstrapping
      ? (d.notifications !== undefined ? await syncTableFull(c, 'notifications', 'id', d.notifications, jsonToParams, NOTIFICATIONS_UPSERT_SQL) : {})
      : (base.notifications || {});
    pending.feed_events = bootstrapping
      ? (d.feedEvents !== undefined ? await syncTableFull(c, 'feed_events', 'id', d.feedEvents, jsonToParams, FEED_EVENTS_UPSERT_SQL) : {})
      : (base.feed_events || {});
    // Oct 14 2026: reports gets the same bootstrap-only treatment as push_subs/notifications/
    // feed_events just above, for the same reason -- POST /api/report, GET /api/admin/reports,
    // and the resolve route now own this table exclusively via pgInsertReport/pgListReports/
    // pgResolveReport, so a generic sync running alongside them on live traffic would reopen the
    // same "two writers fight over the final value" class of bug. Scoped to bootstrapping
    // (migrate-to-postgres.mjs's one-shot disaster-recovery path) only.
    // Oct 16 2026: same `d.reports !== undefined` guard as the three siblings just above, same
    // reproduced bug, same fix -- see the long comment at the top of this block.
    pending.reports = bootstrapping
      ? (d.reports !== undefined ? await syncTableFull(c, 'reports', 'id', d.reports, jsonToParams, REPORTS_UPSERT_SQL) : {})
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
// Oct 16 2026 (users slice, decision #1): once the follow-graph migration has run,
// followers/following/followReqs are owned exclusively by user_follows (syncUserFollowsFull/Diff,
// via writeUserFollowEdges below) -- excluded here so they're never ALSO re-embedded into the
// blob. doLoad()'s own overwrite step adds these three fields back onto every in-memory user
// object on every boot (so every synchronous reader elsewhere in server.js keeps working
// unmodified -- see that block's own comment), and without this exclusion every one of THOSE
// freshly-re-added fields would get serialized straight back into `data` on the next save,
// reopening the exact whole-row-rewrite-on-any-follow-change problem this migration exists to
// remove, just one layer later than before.
// Oct 16 2026 (users slice, decision #2): same exclusion shape as decision #1's followers/
// following/followReqs just above, extended to the ~19 scalar fields -- once an id is in
// userColumnsMigrated (doLoad() populates it for every already-backfilled row at boot;
// migrateUserScalarColumnsIntoPostgres/server.js adds to it live as each row gets backfilled
// this boot; new registrations are added to it immediately, see /api/register), those fields
// stop being re-embedded into `data` here, for the exact same reason decision #1's exclusion
// exists: without it, doLoad()'s own overlay (applyUserColumnsRow, above) would put them right
// back onto the in-memory object every boot, and the next save would just write them straight
// back into the blob, reopening the redundancy this migration exists to remove. A NOT-yet-
// migrated id is simply skipped by this whole block -- its full blob (scalars included) keeps
// being written exactly as it always has, which is always correct, never destructive.
//
// The real column values themselves (userColumnParams below) are computed UNCONDITIONALLY,
// regardless of userColumnsMigrated membership -- deliberately NOT gated the way the blob
// exclusion above is. A not-yet-migrated row gets its columns written too on any save that
// touches it (redundant with its still-intact blob copy until the boot backfill or a restart
// adds it to the set), which is always correct and never destructive: USERS_UPSERT_SQL is one
// INSERT...ON CONFLICT DO UPDATE, so there's no extra risk or cost to always including these
// params, and it means an ordinary edit can incidentally finish a row's backfill before the
// dedicated migration function ever gets to it, with no special-casing needed either way.
const usersToParams = (id, u) => {
  let payload = u;
  if (followsTableReady && u && (u.followers !== undefined || u.following !== undefined || u.followReqs !== undefined)) {
    const { followers, following, followReqs, ...rest } = u;
    payload = rest;
  }
  if (userColumnsMigrated.has(id) && payload) {
    const rest = { ...payload };
    for (const f of USER_SCALAR_COLUMN_FIELDS) delete rest[f];
    payload = rest;
  }
  return [
    id, String((u && u.username) == null ? '' : u.username).trim().toLowerCase(), JSON.stringify(payload),
    ...userColumnParams(id, u),
  ];
};
const jsonToParams = (id, v) => [id, JSON.stringify(v)];

// Oct 16 2026 (users slice, decision #2): extended with the ~19 new scalar columns, same table/
// same row as before -- unlike crews' own decision #2, this is NOT a separate sync-function pair,
// because there's no join table involved and `data` keeps being written forever (see the ALTER
// TABLE comment above). One upsert statement, used both for every ongoing save (via
// syncTableFull/Diff, unchanged) AND for the one-time backfill (pgBackfillUserColumns below
// reuses this exact statement+params function rather than a second, hand-duplicated one -- see
// that function's own comment for why that's safe here in a way it wasn't for crews).
const USERS_UPSERT_SQL = `INSERT INTO users (
  id, username_lower, data,
  username, display_name, bio, avatar, default_gym, profile_visibility, units,
  created_at, created_at_estimated, pin_hash, pin_salt, deleted, deleted_at, tokens_valid_from,
  seen_rir_explainer, training_phase, notify_streak_reminders, notify_workout_reminders,
  last_streak_reminder_at, last_workout_reminder_at
) VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
ON CONFLICT (id) DO UPDATE SET
  username_lower = EXCLUDED.username_lower,
  data = EXCLUDED.data,
  username = EXCLUDED.username,
  display_name = EXCLUDED.display_name,
  bio = EXCLUDED.bio,
  avatar = EXCLUDED.avatar,
  default_gym = EXCLUDED.default_gym,
  profile_visibility = EXCLUDED.profile_visibility,
  units = EXCLUDED.units,
  created_at = EXCLUDED.created_at,
  created_at_estimated = EXCLUDED.created_at_estimated,
  pin_hash = EXCLUDED.pin_hash,
  pin_salt = EXCLUDED.pin_salt,
  deleted = EXCLUDED.deleted,
  deleted_at = EXCLUDED.deleted_at,
  tokens_valid_from = EXCLUDED.tokens_valid_from,
  seen_rir_explainer = EXCLUDED.seen_rir_explainer,
  training_phase = EXCLUDED.training_phase,
  notify_streak_reminders = EXCLUDED.notify_streak_reminders,
  notify_workout_reminders = EXCLUDED.notify_workout_reminders,
  last_streak_reminder_at = EXCLUDED.last_streak_reminder_at,
  last_workout_reminder_at = EXCLUDED.last_workout_reminder_at`;
const SESSIONS_UPSERT_SQL = 'INSERT INTO sessions (id, data) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data';
const TEMPLATES_UPSERT_SQL = 'INSERT INTO templates (id, data) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data';
const PUSH_SUBS_UPSERT_SQL = 'INSERT INTO push_subs (user_id, data) VALUES ($1, $2::jsonb) ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data';
// CUSTOM_EXERCISES_UPSERT_SQL (the old custom_exercises table, array-per-owner) removed Oct 16
// 2026 (read cutover, task #258+ phase 2) -- nothing writes that table any more, see
// freshSnapshot()'s own comment.
const PRS_UPSERT_SQL = 'INSERT INTO prs (user_id, data) VALUES ($1, $2::jsonb) ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data';
// CREWS_UPSERT_SQL (the old one-jsonb-column upsert) removed Oct 16 2026 (crew-row normalization,
// decision #2) -- crews writes real columns now, via CREWS_ROW_UPSERT_SQL and syncCrewsFull/
// syncCrewsDiff below, never the old `data` blob (see doLoad()'s own comment for why `data` is
// left in place but unmaintained on an already-migrated row).
const CREWS_ROW_UPSERT_SQL = 'INSERT INTO crews (id, name, owner_id, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, owner_id = EXCLUDED.owner_id, created_at = EXCLUDED.created_at';
const CREW_MESSAGES_UPSERT_SQL = 'INSERT INTO crew_messages (id, crew_id, data) VALUES ($1, $2, $3::jsonb) ON CONFLICT (id) DO UPDATE SET crew_id = EXCLUDED.crew_id, data = EXCLUDED.data';
const CREW_CHALLENGES_UPSERT_SQL = 'INSERT INTO crew_challenges (id, crew_id, data) VALUES ($1, $2, $3::jsonb) ON CONFLICT (id) DO UPDATE SET crew_id = EXCLUDED.crew_id, data = EXCLUDED.data';
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

// Oct 16 2026 (crew-row normalization, decision #2): crews' own pair, parallel in spirit to
// syncTableFull/syncTableDiff just above but for the real-columns-plus-join-table shape instead
// of one row/one jsonb column. Both run INSIDE doSave()'s already-open transaction (same as
// syncTableFull/syncTableDiff -- neither of those opens its own transaction either), so a crew's
// row update and its full membership replace below always land or roll back together.
//
// Membership is written as a full replace (delete every crew_members row for that crew, then
// reinsert the current memberIds with their array index as `seq`) rather than diffing added/
// removed members individually. Simpler and just as correct at this app's scale (a crew tops out
// at CREW_MAX_MEMBERS=20, and a membership edit is a deliberate, infrequent owner action, nothing
// like the per-message write rate decision #1 above was built for) -- and it sidesteps a real
// subtlety a diff-based version would have to get right anyway: `seq` has to reflect the CURRENT
// full order every time, including members that didn't change, so an edit that only reorders
// (removes and re-adds the same person elsewhere in the list) still needs every row rewritten.
function crewMemberIdsOf(crew) { return Array.isArray(crew && crew.memberIds) ? crew.memberIds : []; }
// Oct 16 2026 (defense in depth, added after a CRITICAL finding both review passes caught
// independently -- see migrateCrewRowColumnsIntoPostgres()'s own comment in server.js for the
// full story): `name IS NULL` is doLoad()'s ONLY signal for "this row hasn't been backfilled
// yet" -- so writing a falsy name here, from ANY future caller, silently un-migrates a row that
// was already done, not just a one-off bad value. The real bug is already fixed at its source
// (that migration function now keeps DB.crews in sync with what it writes), but this is cheap,
// permanent insurance against the exact same class of mistake happening again some other way --
// same "Crew" fallback the migration itself already uses for a missing name.
function crewRowParams(id, crew) {
  const name = (crew && typeof crew.name === 'string' && crew.name.trim()) ? crew.name : 'Crew';
  return [id, name, (crew && crew.ownerId) || null, (crew && crew.createdAt) || null];
}
async function writeCrewMembers(c, crewId, memberIds) {
  await c.query('DELETE FROM crew_members WHERE crew_id = $1', [crewId]);
  let seq = 0;
  for (const uid of memberIds) {
    await c.query('INSERT INTO crew_members (crew_id, user_id, seq) VALUES ($1, $2, $3) ON CONFLICT (crew_id, user_id) DO NOTHING', [crewId, uid, seq++]);
  }
}
async function syncCrewsFull(c, obj) {
  const current = obj || {};
  const keys = Object.keys(current);
  const map = {};
  for (const k of keys) {
    const crew = current[k];
    const json = JSON.stringify(crew);
    await c.query(CREWS_ROW_UPSERT_SQL, crewRowParams(k, crew));
    await writeCrewMembers(c, k, crewMemberIdsOf(crew));
    map[k] = json;
  }
  const existing = await c.query('SELECT id as k FROM crews');
  const keep = new Set(keys);
  for (const row of existing.rows) {
    if (!keep.has(row.k)) {
      await c.query('DELETE FROM crews WHERE id = $1', [row.k]);
      await c.query('DELETE FROM crew_members WHERE crew_id = $1', [row.k]);
    }
  }
  return map;
}
async function syncCrewsDiff(c, obj, lastMap) {
  const current = obj || {};
  const map = { ...lastMap };
  for (const k of Object.keys(current)) {
    const crew = current[k];
    const json = JSON.stringify(crew);
    if (map[k] !== json) {
      await c.query(CREWS_ROW_UPSERT_SQL, crewRowParams(k, crew));
      await writeCrewMembers(c, k, crewMemberIdsOf(crew));
      map[k] = json;
    }
  }
  for (const k of Object.keys(lastMap)) {
    if (!Object.prototype.hasOwnProperty.call(current, k)) {
      await c.query('DELETE FROM crews WHERE id = $1', [k]);
      await c.query('DELETE FROM crew_members WHERE crew_id = $1', [k]);
      delete map[k];
    }
  }
  return map;
}

// Oct 16 2026 (users slice, decision #1 -- follow-graph redesign): full replace of the edges a
// SINGLE user owns -- their own outbound accepted follows (derived from u.following) and their
// own incoming pending requests (derived from u.followReqs). Deliberately NOT also derived from
// u.followers -- that array is the MIRROR of someone else's following (every accepted edge is
// written exactly once, from the follower's own following array), and processing it here too
// would mean every accepted edge gets written twice per save, for no benefit, assuming the two
// arrays agree (see migrateUserFollowsIntoPostgres' own comment in server.js for why that's
// trusted rather than independently verified here).
//
// Full delete+reinsert rather than diffing individual edges -- same reasoning writeCrewMembers
// (crews decision #2) already gives for crew_members: simpler and just as correct at this app's
// scale, and it sidesteps having to separately detect "an edge's status flipped" from "an edge
// was added/removed." ON CONFLICT DO UPDATE guards against ever downgrading an edge some OTHER
// user's own writeUserFollowEdges call already marked accepted, in case both sides of a pair
// happen to be processed in the same save() (see userFollowsDiff/Full below).
async function writeUserFollowEdges(c, userId, u) {
  // Oct 16 2026 (users decision #1, MODERATE fix from independent review): this used to stamp
  // EVERY row with one `now()` for the whole call -- since every call deletes and fully
  // reinserts this user's owned edges, that silently reset every pending request's created_at
  // to the same instant on ANY unrelated touch of this user's follow data (e.g. their own
  // following list changing elsewhere in the same save), defeating doLoad()'s own
  // `ORDER BY created_at` -- see the user_follows schema's own comment on why that ordering
  // matters for the follow-requests-newest-first display. Fixed by looking up each existing
  // row's created_at first and reusing it for anything still present; only a genuinely NEW edge
  // gets a fresh timestamp.
  const existing = await c.query(
    'SELECT follower_id, followee_id, created_at FROM user_follows WHERE follower_id = $1 OR followee_id = $1',
    [userId]
  );
  const existingCreatedAt = {};
  for (const row of existing.rows) existingCreatedAt[row.follower_id + '>' + row.followee_id] = row.created_at;

  await c.query('DELETE FROM user_follows WHERE follower_id = $1 AND status = $2', [userId, 'accepted']);
  await c.query('DELETE FROM user_follows WHERE followee_id = $1 AND status = $2', [userId, 'pending']);
  const following = Array.isArray(u && u.following) ? u.following : [];
  const followReqs = Array.isArray(u && u.followReqs) ? u.followReqs : [];
  const now = new Date().toISOString();
  for (const followeeId of following) {
    if (typeof followeeId !== 'string' || !followeeId || followeeId === userId) continue;
    const createdAt = existingCreatedAt[userId + '>' + followeeId] || now;
    await c.query(
      `INSERT INTO user_follows (follower_id, followee_id, status, created_at) VALUES ($1, $2, 'accepted', $3)
       ON CONFLICT (follower_id, followee_id) DO UPDATE SET status = 'accepted'`,
      [userId, followeeId, createdAt]
    );
  }
  for (const requesterId of followReqs) {
    if (typeof requesterId !== 'string' || !requesterId || requesterId === userId) continue;
    const createdAt = existingCreatedAt[requesterId + '>' + userId] || now;
    await c.query(
      `INSERT INTO user_follows (follower_id, followee_id, status, created_at) VALUES ($1, $2, 'pending', $3)
       ON CONFLICT (follower_id, followee_id) DO UPDATE SET status = CASE WHEN user_follows.status = 'accepted' THEN 'accepted' ELSE 'pending' END`,
      [requesterId, userId, createdAt]
    );
  }
}
async function syncUserFollowsFull(c, users) {
  const current = users || {};
  const map = {};
  for (const id of Object.keys(current)) {
    await writeUserFollowEdges(c, id, current[id]);
    map[id] = userFollowKey(current[id]);
  }
  return map;
}
async function syncUserFollowsDiff(c, users, lastMap) {
  const current = users || {};
  const map = { ...lastMap };
  for (const id of Object.keys(current)) {
    const key = userFollowKey(current[id]);
    if (map[id] !== key) {
      await writeUserFollowEdges(c, id, current[id]);
      map[id] = key;
    }
  }
  for (const id of Object.keys(lastMap)) {
    if (!Object.prototype.hasOwnProperty.call(current, id)) {
      // A user id present in the last baseline but no longer in `d.users` at all -- doesn't
      // normally happen (accounts are soft-deleted, not removed from DB.users -- see
      // anonymizeAndDeleteAccount), but handled for symmetry with syncCrewsDiff's own
      // removed-crew handling, and in case that ever changes.
      await c.query('DELETE FROM user_follows WHERE follower_id = $1 OR followee_id = $1', [id]);
      delete map[id];
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
// Oct 20 2026 (app-store readiness review -- self-service data export): pgNotificationHistoryForUser
// just above is purpose-built for the in-app feed (a 50-row cap, a sinceIso cutoff) and wrong for
// this -- an export has to be complete, not "recent." A separate function rather than adding an
// "unlimited" mode to the feed one, same reasoning pgListAllCustomExerciseRows stayed separate from
// pgListCustomExerciseRowsByOwner below: different callers, different shapes, no reason to overload
// one function's contract with a flag only one caller needs. 2000 is a sane safety cap (an active
// account's full history realistically never approaches it), not a product-intended limit -- if a
// real user ever hits it, that's a sign this needs pagination, not that the export is silently
// truncating someone's data today.
async function pgAllNotificationsForUser(userId) {
  return enqueue(async () => {
    const c = getConn();
    const r = await c.query(
      `SELECT data FROM notifications WHERE data->>'userId' = $1 ORDER BY data->>'createdAt' DESC LIMIT 2000`,
      [userId]
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
// the NEW custom_exercise_rows table; the old custom_exercises table/column is now untouched by
// this app entirely (Oct 16 2026, read cutover) — the one-time migration read that used to run in
// server.js's boot sequence is gone too (see that removal's own comment there), since nothing
// writes the old table any more for it to ever catch up to.
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
// Oct 20 2026 (data export): pgListReports just above is the admin review queue -- every report,
// regardless of who filed it, which is exactly right for that screen and exactly wrong for an
// export scoped to one person's own data. Ownership check baked into the WHERE clause, same
// reasoning as pgDeleteNotification's own comment on why that's better than a read-then-filter.
async function pgListReportsByReporter(reporterId) {
  return enqueue(async () => {
    const c = getConn();
    const r = await c.query(`SELECT data FROM reports WHERE data->>'reporterId' = $1 ORDER BY data->>'at' DESC`, [reporterId]);
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
// Oct 16 2026 (race fix, caught by two independent review passes after the read cutover landed,
// both reproduced live): POST /api/exercises/custom's 500-per-owner cap used to be race-safe for
// free -- it read DB.customExercises[userId].length and pushed the new exercise in the same
// synchronous stretch, no await in between, so Node's single-threaded execution made the pair
// atomic by construction. The cutover's first version split that into two separate awaited calls
// (pgListCustomExerciseRowsByOwner, then this function) with the route's own `if` in between --
// each awaited call is its own separate enqueue() turn, so another concurrent create from the
// SAME user could interleave between them, read the same stale under-cap count, and also pass.
// Reproduced live by both review passes (504 and 501 rows from a seeded 495/499 base, 10/2
// concurrent creates). Fixed here, not by adding locking in server.js, by doing the count check
// AND the insert inside ONE enqueue()'d function: db.js's enqueue() queue serializes at the
// granularity of a whole enqueue() call (nothing else on this app's one shared connection runs
// until this entire async callback -- both its queries -- has resolved), not at the granularity
// of a single await, so nothing can land between the count and the insert any more, closing
// exactly the gap the two-call version reopened.
async function pgInsertCustomExerciseRowIfUnderCap(row, cap) {
  return enqueue(async () => {
    const c = getConn();
    const r = await c.query('SELECT COUNT(*) AS n FROM custom_exercise_rows WHERE owner_id = $1', [row.ownerId]);
    const n = Number(r.rows[0].n);
    if (n >= cap) return { ok: false, count: n };
    await c.query(CUSTOM_EXERCISE_ROWS_UPSERT_SQL, [row.id, row.ownerId, JSON.stringify(row)]);
    return { ok: true, count: n + 1 };
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
// Backs GET /api/exercises (and GET /api/progress's own customRows pre-fetch, see
// findExLibEntry's comment) — every custom exercise, from every owner, is shown to every user by
// design (see GET /api/exercises' own comment in server.js), so this has no WHERE clause at all.
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
// short-circuiting shape as the in-memory version's three lookups.
//
// Oct 14 2026: used by the dual-write phase's shadow-compare, confirming this priority order
// against the old array-per-owner read before the read cutover switched the source over.
// Oct 16 2026 (read cutover): that shadow-compare is retired along with the old source it
// compared against (see GET /api/exercises' own comment), and findExLibEntry itself deliberately
// does NOT call this -- a per-logged-set lookup through this app's one shared Postgres connection
// would have been a real page-load slowdown (see findExLibEntry's own comment for the full
// reasoning); it takes a pre-fetched row list and searches that in memory instead. So this
// function currently has no caller anywhere in server.js. Left in place, not removed, as a
// correct, already-verified building block for any FUTURE direct-Postgres caller that genuinely
// does need a single by-name lookup outside a hot per-set loop (unlike the two boot migrations
// removed the same day, which can structurally never run again -- this one simply has no current
// caller, a different situation).
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

// ---- Oct 16 2026: direct Postgres access for crew messages + crew challenges ----
//
// Decision #1 of the crews migration pre-mortem (Jeff: "do it right the first time" -- same call
// as the custom-exercises redesign). crews.data used to embed both of these as arrays, rewriting
// the WHOLE crew blob on every single new message or challenge -- see the schema comment above
// crew_messages' CREATE TABLE for the full reasoning. server.js no longer keeps either array on
// the in-memory crew object at all (a true read cutover, same as notifications/feed_events) --
// every read and write for these two goes exclusively through the functions below.
//
// One real, useful side effect of normalizing this way: several of these are now a SINGLE atomic
// statement (an UPDATE/DELETE with ownership baked into the WHERE clause, same pattern as
// pgDeleteNotification), where the old array-in-one-blob version needed server.js's own
// mutate-then-maybe-revert-on-save-failure dance (see withCrewLock's long comment in server.js,
// and the Oct 16 2026 crews deep-dive this migration follows). A single atomic statement either
// fully happens or fully doesn't -- there is no in-memory array left to strand half-mutated any
// more, so that entire bug CLASS is closed by construction for the message routes, not just
// patched. The two routes that genuinely need a check-then-act (is a challenge already running,
// before starting a new one) get that done inside ONE enqueue()'d function instead, the same fix
// already proven for pgInsertCustomExerciseRowIfUnderCap's cap race -- see
// pgInsertCrewChallengeIfNoneRunning below.
async function pgInsertCrewMessage(row) {
  return enqueue(async () => {
    const c = getConn();
    await c.query(CREW_MESSAGES_UPSERT_SQL, [row.id, row.crewId, JSON.stringify(row)]);
    return row;
  });
}
async function pgListCrewMessagesByCrew(crewId) {
  return enqueue(async () => {
    const c = getConn();
    const r = await c.query(`SELECT data FROM crew_messages WHERE crew_id = $1 ORDER BY data->>'at'`, [crewId]);
    return r.rows.map(row => JSON.parse(row.data));
  });
}
// Ownership check baked into the WHERE clause, same reasoning as pgDeleteNotification -- a single
// atomic statement, so a concurrent edit/delete of the SAME message can't land in some
// in-between state, and the caller can't edit a message it doesn't own just by getting the id
// right. jsonb_set writes both fields in one expression so this is still one statement, not two.
// Returns the updated row, or null if the message doesn't exist or isn't the caller's (same 404,
// no info leak either way).
// Oct 16 2026 (adversarial review finding, SEVERE, reproduced live): the first version of this
// scoped ownership on userId alone, with no crew_id in the WHERE clause at all -- the ROUTE
// checks isCrewMember() against the crew id in the URL, but then called this with only the
// message id + caller's own userId, never the crew id. That meant a user could edit/delete their
// OWN message by going through ANY crew they currently belong to, not just the one the message
// actually lives in -- e.g. post a message in crew A, get removed from crew A (losing all access
// to it), then successfully PUT/DELETE that same message via PUT/DELETE
// /api/crews/B/messages/:messageId for some unrelated crew B they still belong to, since nothing
// here ever checked the message's own crew_id against B. crew_id is now part of the WHERE clause,
// matching pgUpdateCrewChallengeFields/pgDeleteCrewChallenge, which were scoped correctly from the
// start -- the inconsistency between the two is what caught this.
const CREW_MESSAGE_EDIT_SQL = `UPDATE crew_messages
  SET data = jsonb_set(jsonb_set(data, '{text}', to_jsonb($4::text)), '{editedAt}', to_jsonb($5::text))
  WHERE id = $1 AND crew_id = $2 AND data->>'userId' = $3
  RETURNING data`;
async function pgUpdateCrewMessageText(id, crewId, userId, text, editedAtIso) {
  return enqueue(async () => {
    const c = getConn();
    const r = await c.query(CREW_MESSAGE_EDIT_SQL, [id, crewId, userId, text, editedAtIso]);
    return r.rows.length ? JSON.parse(r.rows[0].data) : null;
  });
}
async function pgDeleteCrewMessage(id, crewId, userId) {
  return enqueue(async () => {
    const c = getConn();
    const r = await c.query(`DELETE FROM crew_messages WHERE id = $1 AND crew_id = $2 AND data->>'userId' = $3`, [id, crewId, userId]);
    const m = /^DELETE (\d+)$/.exec(r.commandTag || '');
    return !!m && Number(m[1]) > 0;
  });
}
// A system message (userId left out of the WHERE entirely) needs its own delete-free insert path
// -- checkChallengeCompletion's celebration row has no userId to match against, and was never
// meant to be user-deletable anyway (see that function's own comment in server.js). Reuses the
// same upsert as a real user message; `system: true` in the row data is what the client keys off
// of to render it as a celebration banner, not a stored-procedure distinction.
async function pgInsertSystemCrewMessage(row) {
  return pgInsertCrewMessage(row);
}
// Oct 16 2026 (crews deep-dive, decision #1 cleanup -- cold-review catch on DELETE /api/crews/:id):
// messages used to live inside the crew's own JSON blob, so deleting the crew (DB.crews[id]) threw
// its messages away for free. Now that they're their own table, deleting the crew no longer
// touches crew_messages at all -- without this, every deleted crew would leave its whole message
// history behind forever, unreachable through the API (every message route 404s once the crew is
// gone) but still sitting in Postgres. No ownership check needed -- the caller (crew deletion) has
// already verified it owns the crew being torn down.
async function pgDeleteCrewMessagesByCrew(crewId) {
  return enqueue(async () => {
    const c = getConn();
    await c.query('DELETE FROM crew_messages WHERE crew_id = $1', [crewId]);
  });
}
async function pgLastCrewChallenge(crewId) {
  return enqueue(async () => {
    const c = getConn();
    const r = await c.query(`SELECT data FROM crew_challenges WHERE crew_id = $1 ORDER BY data->>'createdAt' DESC LIMIT 1`, [crewId]);
    return r.rows.length ? JSON.parse(r.rows[0].data) : null;
  });
}
// Oldest-first, matching the order c.challenges (the old array) was always built in -- callers
// that want newest-first (publicCrew's own pastChallenges) reverse it themselves, same as they
// always did against the old array.
async function pgListCrewChallengesByCrew(crewId) {
  return enqueue(async () => {
    const c = getConn();
    const r = await c.query(`SELECT data FROM crew_challenges WHERE crew_id = $1 ORDER BY data->>'createdAt' ASC`, [crewId]);
    return r.rows.map(row => JSON.parse(row.data));
  });
}
// Oct 16 2026 (same fix shape as pgInsertCustomExerciseRowIfUnderCap's cap race, see that
// function's own comment): the old in-memory version's "is one already running? then push" was
// atomic for free (synchronous, no await in between). Splitting the check and the insert into two
// separately-awaited calls would reopen that exact race for two concurrent challenge-starts on
// the same crew. Done here instead, inside ONE enqueue()'d function, the same way the cap-race fix
// closed its own version of this gap -- nothing else on this app's one shared connection can run
// between the SELECT and the INSERT below. `isRunning(last, todayStr)` mirrors runningChallenge()'s
// own definition in server.js exactly (not completed, and today is still before its endDate).
// Plain upsert, no "is one already running" guard -- used by the one-time boot migration that
// moves a crew's EXISTING, already-created challenge history out of its old embedded array (see
// server.js's migrateCrewMessagesAndChallengesIntoPostgres), where every row being written already
// legitimately existed and the guard's question doesn't apply. The live challenge-START route
// uses pgInsertCrewChallengeIfNoneRunning below instead, never this.
async function pgUpsertCrewChallenge(row) {
  return enqueue(async () => {
    const c = getConn();
    await c.query(CREW_CHALLENGES_UPSERT_SQL, [row.id, row.crewId, JSON.stringify(row)]);
    return row;
  });
}
async function pgInsertCrewChallengeIfNoneRunning(row, todayStr) {
  return enqueue(async () => {
    const c = getConn();
    const r = await c.query(`SELECT data FROM crew_challenges WHERE crew_id = $1 ORDER BY data->>'createdAt' DESC LIMIT 1`, [row.crewId]);
    const last = r.rows.length ? JSON.parse(r.rows[0].data) : null;
    const running = last && !last.completedAt && todayStr < last.endDate;
    if (running) return { ok: false, running: last };
    await c.query(CREW_CHALLENGES_UPSERT_SQL, [row.id, row.crewId, JSON.stringify(row)]);
    return { ok: true, row };
  });
}
// Generic jsonb merge (not a full replace) -- used for stamping a challenge's feedEventId once
// the "started" feed event exists. `data || patch` keeps every field patch doesn't mention
// untouched. Ownership scoped to crew_id, same reasoning as every other ownership-in-WHERE
// function above. Returns the updated row, or null if the challenge doesn't exist / isn't this
// crew's (caller treats either the same way the array version silently no-op'd on a stale id).
// Oct 16 2026 (correctness/concurrency review finding, SEVERE, reproduced live): this used to ALSO
// be how checkChallengeCompletion stamped completedAt -- but with no completedAt-is-still-null
// guard in the WHERE clause, and the "is it already complete" check (runningChallenge, now async,
// its own separate enqueue()'d SELECT) happening in a SEPARATE enqueue() call before this one,
// two concurrent finishes (two members completing qualifying workouts within milliseconds of each
// other, both routed through checkCrewChallenges) could both see "not yet completed" and both
// successfully run this UPDATE -- double-firing the celebration message/notification/feed event.
// See pgCompleteCrewChallengeIfNotAlready below, which closes this the same way
// pgInsertCrewChallengeIfNoneRunning closed the equivalent race for challenge-START: the check and
// the write are now one atomic statement, not two. This function keeps the feedEventId-stamping
// use (which has no "already done" concept to race on) and is no longer used for completedAt.
async function pgUpdateCrewChallengeFields(id, crewId, patch) {
  return enqueue(async () => {
    const c = getConn();
    const r = await c.query(`UPDATE crew_challenges SET data = data || $3::jsonb WHERE id = $1 AND crew_id = $2 RETURNING data`, [id, crewId, JSON.stringify(patch)]);
    return r.rows.length ? JSON.parse(r.rows[0].data) : null;
  });
}
// Marks a challenge complete ONLY if it isn't already -- the check (completedAt IS NULL) and the
// write are one atomic statement, same shape as pgInsertCrewChallengeIfNoneRunning's
// check-then-insert. Returns the updated row on success, or null if the challenge doesn't exist,
// isn't this crew's, OR (the case this function exists for) someone else's concurrent call already
// completed it first -- the caller treats a null return as "nothing more to do here," not an
// error, since by definition the challenge is already marked complete either way.
async function pgCompleteCrewChallengeIfNotAlready(id, crewId, completedAt) {
  return enqueue(async () => {
    const c = getConn();
    const r = await c.query(
      `UPDATE crew_challenges SET data = data || $3::jsonb WHERE id = $1 AND crew_id = $2 AND data->>'completedAt' IS NULL RETURNING data`,
      [id, crewId, JSON.stringify({ completedAt })]);
    return r.rows.length ? JSON.parse(r.rows[0].data) : null;
  });
}
async function pgDeleteCrewChallenge(id, crewId) {
  return enqueue(async () => {
    const c = getConn();
    const r = await c.query('DELETE FROM crew_challenges WHERE id = $1 AND crew_id = $2', [id, crewId]);
    const m = /^DELETE (\d+)$/.exec(r.commandTag || '');
    return !!m && Number(m[1]) > 0;
  });
}
// Same cleanup reasoning as pgDeleteCrewMessagesByCrew just above, for the other table this
// migration split out of the crew blob.
async function pgDeleteCrewChallengesByCrew(crewId) {
  return enqueue(async () => {
    const c = getConn();
    await c.query('DELETE FROM crew_challenges WHERE crew_id = $1', [crewId]);
  });
}

// ---- Oct 16 2026: crew-row normalization (decision #2) one-time boot backfill ----
//
// Used only by migrateCrewRowColumnsIntoPostgres() in server.js, which runs once per boot, after
// load() (see that function's own comment, and doLoad()'s comment above for why load() has to be
// able to read a not-yet-backfilled row too). Every field server.js hands in has already been
// sanitized there (malformed/missing name, ownerId, createdAt, memberIds all get a safe
// fallback) -- this function's own job is just "write it, atomically, and never half-apply it."
async function pgListCrewsNeedingColumnBackfill() {
  return enqueue(async () => {
    const c = getConn();
    const r = await c.query('SELECT id, data FROM crews WHERE name IS NULL');
    return r.rows.map(row => ({ id: row.id, data: JSON.parse(row.data) }));
  });
}
async function pgBackfillCrewRow(id, name, ownerId, createdAt, memberIds) {
  return enqueue(async () => {
    const c = getConn();
    await c.begin();
    try {
      await c.query(CREWS_ROW_UPSERT_SQL, crewRowParams(id, { name, ownerId, createdAt }));
      await writeCrewMembers(c, id, memberIds);
      await c.commit();
    } catch (e) {
      await c.rollback();
      throw e;
    }
  });
}

// ---- Oct 16 2026: users slice decision #1 (follow-graph redesign) one-time boot backfill ----
//
// Used only by migrateUserFollowsIntoPostgres() in server.js, which runs once per boot, after
// load() (see doLoad()'s own comment for why load() has to be able to read a not-yet-flattened
// user's embedded arrays too). Never downgrades an existing 'accepted' edge to 'pending' --
// server.js processes each user's `following` (accepted) and `followReqs` (pending) entries in
// the same loop, but across DIFFERENT users Object.values() iteration order isn't guaranteed, so
// this has to be safe regardless of which user's entries land first.
async function pgUpsertFollowEdge(followerId, followeeId, status) {
  return enqueue(async () => {
    const c = getConn();
    await c.query(
      `INSERT INTO user_follows (follower_id, followee_id, status, created_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (follower_id, followee_id) DO UPDATE SET status = CASE WHEN user_follows.status = 'accepted' THEN 'accepted' ELSE EXCLUDED.status END`,
      [followerId, followeeId, status, new Date().toISOString()]
    );
  });
}

// ---- Oct 16 2026: users slice decision #2 (scalar column normalization) one-time boot backfill ----
//
// Used only by migrateUserScalarColumnsIntoPostgres() in server.js, which runs once per boot,
// after load() (mirrors pgListCrewsNeedingColumnBackfill/pgBackfillCrewRow above). Unlike that
// crew-row pair, pgBackfillUserColumns takes the live in-memory user object directly and just
// reuses usersToParams/USERS_UPSERT_SQL -- the same statement every ongoing save already uses --
// rather than a second, hand-written upsert. That's safe here in a way it wasn't for crews:
// crews' backfill writes a NEW shape (real columns, no more `data`) via its own dedicated SQL,
// while this one is still the exact same row/same `data` column every other save writes, just
// with the new columns added -- there's no second shape for a duplicated statement to drift out
// of sync with. At backfill time `id` is never yet in userColumnsMigrated (that only happens
// AFTER a successful call here -- see server.js's own comment on the write-then-mark ordering),
// so this call's own blob payload is still the full, un-excluded one -- correct and harmless
// redundancy with the columns it's writing in the same statement, exactly as intended.
async function pgListUsersNeedingColumnBackfill() {
  return enqueue(async () => {
    const c = getConn();
    const r = await c.query('SELECT id, data FROM users WHERE username IS NULL');
    return r.rows.map(row => ({ id: row.id, data: JSON.parse(row.data) }));
  });
}
async function pgBackfillUserColumns(id, u) {
  return enqueue(async () => {
    const c = getConn();
    await c.query(USERS_UPSERT_SQL, usersToParams(id, u));
  });
}

module.exports = {
  load, save, close, ensureSchema, EMPTY_DB, getConn,
  pgNotificationHistoryForUser, pgAllNotificationsForUser, pgInsertNotification, pgDeleteNotification, pgMergedNotificationWrite, pgPruneOldNotifications,
  pgInsertFeedEvent, pgDeleteFeedEvent, pgGetFeedEvent, pgFeedEventsSince, pgToggleFeedEventReaction, pgPruneOldFeedEvents,
  pgGetPushSub, pgSetPushSub, pgDeletePushSubIfEndpointMatches, pgDeletePushSub,
  pgInsertReport, pgListReports, pgListReportsByReporter, pgResolveReport,
  pgUpsertCustomExerciseRow, pgInsertCustomExerciseRowIfUnderCap, pgGetCustomExerciseRow, pgListCustomExerciseRowsByOwner, pgListAllCustomExerciseRows, pgDeleteCustomExerciseRow, pgFindCustomExerciseRowByName,
  pgInsertCrewMessage, pgListCrewMessagesByCrew, pgUpdateCrewMessageText, pgDeleteCrewMessage, pgInsertSystemCrewMessage, pgDeleteCrewMessagesByCrew,
  pgLastCrewChallenge, pgListCrewChallengesByCrew, pgUpsertCrewChallenge, pgInsertCrewChallengeIfNoneRunning, pgUpdateCrewChallengeFields, pgCompleteCrewChallengeIfNotAlready, pgDeleteCrewChallenge, pgDeleteCrewChallengesByCrew,
  pgListCrewsNeedingColumnBackfill, pgBackfillCrewRow,
  pgUpsertFollowEdge, markFollowsTableReady, syncUserFollowsBaseline,
  pgListUsersNeedingColumnBackfill, pgBackfillUserColumns, markUserColumnsMigrated,
};
