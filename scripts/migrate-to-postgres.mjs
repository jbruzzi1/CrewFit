#!/usr/bin/env node
// One-shot data.json -> Postgres migration.
//
// Usage:
//   DATABASE_URL=postgres://user:pass@host:port/db node scripts/migrate-to-postgres.mjs path/to/data.json
//
// This is the tool for the actual production cutover (see DEPLOY.md for the full Fly Postgres
// provisioning + cutover steps) and is exercised end-to-end by test/data-safety.mjs's
// "documented recovery path" test.
//
// Deliberately thin: it does not reimplement the schema or the upsert/no-ghosts logic — it reads
// the old file, reshapes it into the exact in-memory DB object server.js has always used
// (DB.users, DB.sessions, ...), and hands that straight to db.js's own save(), the same function
// every live write in the app already goes through. One source of truth for "how a DB object
// becomes Postgres rows," used by both the running server and this migration.
//
// Old data.json also carries DB.friendships, which is dead weight, not carried forward —
// declared and defaulted in the old EMPTY_DB/load(), never actually read or written anywhere in
// server.js (found during the migration audit; see db.js's top-of-file comment). Anything else
// unrecognized in the file is also left alone (not migrated, not an error) — this only carries
// forward the fields server.js's DB object actually still uses. Per-user data (including the
// working-weight `seeded` field) travels automatically inside each user's own JSONB blob — no
// special-casing needed for it here.
import { readFileSync, existsSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('Usage: DATABASE_URL=postgres://... node scripts/migrate-to-postgres.mjs <path-to-data.json>');
  process.exit(1);
}
if (!existsSync(file)) {
  console.error(`FATAL: no such file: ${file}`);
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('FATAL: DATABASE_URL is not set. Point it at the target Postgres database before running this.');
  process.exit(1);
}

const raw = JSON.parse(readFileSync(file, 'utf8'));

// Pre-flight: refuse to write ANYTHING if the source file has a case-insensitive username
// collision. users.username_lower has a UNIQUE constraint (see db.js's SCHEMA_SQL) — without
// this check, db.save(d) crashes mid-transaction with a raw, unhandled
// `23505 duplicate key value violates unique constraint "users_username_lower_key"` and no
// guidance, on exactly the shape of a real historical production incident this app already had
// (two "Brian" accounts differing only by case — see server.js's migrateMergeDuplicateBrian()).
// Mirrors server.js's own reportUsernameCollisions()/normUser() detection exactly, but here a
// collision is fatal, not just logged: this script has no server.js-side judgement call about
// which account is "the real one" to fall back on, so it stops before touching Postgres and
// leaves that call to a human. Not auto-merged here on purpose — merging accounts is a product
// decision Jeff should make explicitly (see migrateMergeDuplicateBrian(), which is a
// hand-verified one-off fix for two specific real user ids, not a general-purpose resolver).
//
// Kept byte-for-byte identical to server.js's normUser() — String(v == null ? '' : v)
// .trim().toLowerCase() — which substitutes '' only for null/undefined, NOT for every falsy
// value. db.js's username_lower column uses this exact same expression (applied to u.username).
// A looser/tighter check here than what actually computes username_lower would be a false sense
// of safety: it could pass this pre-flight while the real INSERT still collides, or vice versa.
const normUser = v => String(v == null ? '' : v).trim().toLowerCase();
{
  const byKey = {};
  for (const u of Object.values(raw.users || {})) (byKey[normUser(u && u.username)] ||= []).push(u);
  const clashes = Object.entries(byKey).filter(([, list]) => list.length > 1);
  if (clashes.length) {
    console.error(`FATAL: ${clashes.length} username collision(s) in ${file} — migration refuses to write anything to Postgres until this is resolved:`);
    for (const [key, list] of clashes) {
      // Entries can be malformed/null (a known real-world shape this migration must tolerate —
      // see db.js's load() comment on malformed rows) — describe those without crashing on them.
      const desc = list.map(u => (u && typeof u === 'object') ? `${u.username}(${u.id})` : `<malformed entry: ${JSON.stringify(u)}>`);
      console.error(`  "${key}": ` + desc.join(' + ') + ' — both would answer to the same login.');
    }
    console.error('Resolve manually first (decide which account is real, e.g. by session/log activity), then re-run this script.');
    console.error('See server.js\'s migrateMergeDuplicateBrian() for a worked example of merging a real historical duplicate by hand.');
    process.exit(1);
  }
}

// Reshape into exactly the DB object shape db.js's save() expects — see EMPTY_DB in db.js.
// Falling back to {} for a missing collection means an old file that never had, say, `templates`
// at all still migrates cleanly rather than throwing.
// Oct 13 2026 (found while verifying the notifications+feed-events read cutover, task #252 --
// this is NOT a regression from that work, a pre-existing gap this script had from before this
// slice's rearchitecture started at all; see the chat disclosure for the real repro): these two
// were missing from this list entirely, meaning every migrate-to-postgres.mjs run -- including
// the documented disaster-recovery path, not just the original one-time cutover -- silently
// wiped out any notifications/feed_events rows already sitting in the target Postgres database.
// Harmless on a fresh/empty target (the original cutover's actual use case), but a real,
// reproducible data-loss bug on a disaster-recovery re-run against a database that already has
// live notification/feed-event history. db.js's save()/doSave() already knows how to write these
// two collections (see its bootstrap-only syncTableFull branch, which this script's call is the
// ONLY thing that ever reaches) -- this script just needed to actually hand them over.
// Oct 14 2026 (found while researching the NEXT migration slice's pre-mortem -- same bug class
// as the notifications/feedEvents gap just above, not caught at the time because `reports` was
// never cut over to direct-Postgres functions, so it's easy to assume the generic save()/load()
// path "just works" for it -- but this script builds its own `d` object by hand, field by field,
// and `reports` was simply never added to the list. Same consequence: every run of this script,
// including the documented disaster-recovery path, silently wiped the `reports` table with
// nothing restored in its place. Unlike notifications/feedEvents, `reports` is still fully
// generic (db.js's EMPTY_DB/doLoad()/doSave() all still handle it the normal way), so the fix
// here is simpler -- no raw-SQL readback workaround needed, db.load() already returns
// `after.reports` correctly for the verification loop below once it's included in `counts`.
// Oct 16 2026 (read cutover, task #258+ phase 2): customExercises is deliberately NOT part of
// this object any more. db.js's EMPTY_DB/doLoad()/doSave() dropped it the same way notifications/
// feedEvents were dropped before it (see db.js's own comment on EMPTY_DB) -- it is handled
// separately, below, by flattening straight into custom_exercise_rows instead of handing it to
// db.save() like every other collection here.
const d = {
  users: raw.users || {},
  sessions: raw.sessions || {},
  templates: raw.templates || {},
  pushSubs: raw.pushSubs || {},
  prs: raw.prs || {},
  crews: raw.crews || {},
  notifications: raw.notifications || {},
  feedEvents: raw.feedEvents || {},
  reports: raw.reports || {},
};
// Singleton bookkeeping field — only carried over if actually present in the source file, so a
// migration never invents a value db.js's save() would otherwise have left untouched.
if (raw.followApprovalV1 !== undefined) d.followApprovalV1 = raw.followApprovalV1;

const counts = {
  users: Object.keys(d.users).length,
  sessions: Object.keys(d.sessions).length,
  templates: Object.keys(d.templates).length,
  pushSubs: Object.keys(d.pushSubs).length,
  prs: Object.keys(d.prs).length,
  crews: Object.keys(d.crews).length,
  notifications: Object.keys(d.notifications).length,
  feedEvents: Object.keys(d.feedEvents).length,
  reports: Object.keys(d.reports).length,
};
// customExerciseRows is counted separately below, once raw.customExercises (old array-per-owner
// shape) is actually flattened -- Object.keys(raw.customExercises||{}).length would only count
// OWNERS, not individual exercises, which is the wrong number for this collection specifically
// (every other collection above is already keyed one-row-per-entity, so Object.keys().length IS
// the row count for those).
console.log(`Migrating ${file} -> ${process.env.DATABASE_URL.replace(/:[^:@]*@/, ':***@')}`);
console.log(`  users=${counts.users} sessions=${counts.sessions} templates=${counts.templates} pushSubs=${counts.pushSubs} prs=${counts.prs} crews=${counts.crews} notifications=${counts.notifications} feedEvents=${counts.feedEvents} reports=${counts.reports}`);

const db = (await import('../db.js')).default;
await db.ensureSchema();
await db.save(d);

// Oct 16 2026 (read cutover, task #258+ phase 2): flattens raw.customExercises (the OLD array-
// per-owner shape every existing backup/data.json file still has) straight into the NEW
// custom_exercise_rows table (one row per exercise) -- the exact flatten
// migrateCustomExerciseRowsIntoPostgres used to do every boot in server.js, now retired now that
// DB.customExercises can never exist again (see that removal's own comment in server.js). Same
// defensive id-backfill migrateCustomExerciseIds used to apply at boot: a legacy row from before
// Sep 30 2026 has no `id` yet, and this script never runs that old boot migration, so a brand-new
// one is minted here instead. Vanishingly unlikely against a REAL backup (every backup taken
// since that migration first landed already has ids, persisted by the very boot that made it),
// but cheap insurance against a much older hand-supplied file.
const expectedCustomExerciseRows = {};
for (const [ownerId, arr] of Object.entries(raw.customExercises || {})) {
  for (const e of (Array.isArray(arr) ? arr : [])) {
    if (!e || typeof e !== 'object') continue;   // tolerate a malformed exercise object rather than crash the migration -- same stance server.js's own boot migrations already took
    if (!e.id) e.id = crypto.randomUUID();
    const row = { ...e, ownerId };
    await db.pgUpsertCustomExerciseRow(row);
    expectedCustomExerciseRows[row.id] = row;
  }
}
// Adversarial-review finding (reproduced live): every OTHER collection this script restores goes
// through db.js's syncTableFull, which is a true full-replace -- it deletes any row in the
// target table that ISN'T in the backup, not just upserts what is. The loop just above was
// upsert-only, so restoring a backup into a database that already had SOME custom_exercise_rows
// not present in that backup (live traffic since the snapshot, or any stray leftover row) left
// those orphans silently surviving a "restore" -- exactly the two-way-reconciliation gap the old
// migrateCustomExerciseRowsIntoPostgres boot migration had already been fixed to close once
// (see its own comment, before it was retired along with DB.customExercises). Reproduced: seeding
// one pre-existing row for a different owner before running this script against a backup that
// didn't mention it left that row behind, and the read-back verification below correctly caught
// it as an unexpected extra row. Fixed by actually deleting anything in the table that isn't in
// `expectedCustomExerciseRows`, so this script's restore is a real full-replace like every other
// collection's, not a merge.
const existingCustomExerciseRows = (await db.getConn().query('SELECT id, owner_id FROM custom_exercise_rows')).rows;
let removedCustomExerciseRowOrphans = 0;
for (const row of existingCustomExerciseRows) {
  if (!expectedCustomExerciseRows[row.id]) {
    await db.pgDeleteCustomExerciseRow(row.id, row.owner_id);
    removedCustomExerciseRowOrphans++;
  }
}
const customExerciseRowCount = Object.keys(expectedCustomExerciseRows).length;
console.log(`  customExerciseRows=${customExerciseRowCount} (flattened from raw.customExercises)${removedCustomExerciseRowOrphans ? `, removed ${removedCustomExerciseRowOrphans} orphan(s) not present in the source file` : ''}`);

// Order-independent deep equality — Postgres's jsonb column type does NOT preserve object key
// order (it stores a canonicalized binary form and reconstructs keys in its own order on
// output), so a naive JSON.stringify(before) === JSON.stringify(after) comparison would report
// "corruption" on every single row purely from harmless key reordering, even when the actual
// data is byte-for-byte intact. Arrays DO preserve order in jsonb, so only object keys are
// order-normalized here — an actual reordering of an array's elements is still a real mismatch.
function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const aKeys = Object.keys(a), bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(k => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

// Verify by reading back through the exact same load() the running server uses — this is the
// real acceptance check, not just "save() didn't throw." Deep-equality on every entity's
// content, not just row counts: a count-only check would call a migration "verified" even if it
// silently truncated or corrupted a field along the way while preserving row counts. This app's
// whole database is dozens of rows, so a full deep-compare of every collection is cheap —
// there's no scale reason to settle for the weaker check.
const after = await db.load();
// Oct 13 2026 (read cutover, task #252): notifications/feedEvents are no longer part of what
// db.load() returns at all -- they're served through the direct-Postgres functions now (see
// db.js's EMPTY_DB/doLoad() comments), not the generic in-memory DB object this script otherwise
// verifies against. Read them back with a plain SELECT off the same connection instead, so the
// addition above actually gets verified rather than silently skipped.
const notifRows = (await db.getConn().query('SELECT id, data FROM notifications')).rows;
const afterNotifications = {}; for (const r of notifRows) afterNotifications[r.id] = JSON.parse(r.data);
const feedRows = (await db.getConn().query('SELECT id, data FROM feed_events')).rows;
const afterFeedEvents = {}; for (const r of feedRows) afterFeedEvents[r.id] = JSON.parse(r.data);
const afterByCollection = { ...after, notifications: afterNotifications, feedEvents: afterFeedEvents };
// Oct 16 2026 (read cutover, task #258+ phase 2): custom_exercise_rows verified the same raw-SQL
// way as notifications/feed_events just above, for the same reason (db.load() doesn't return it
// either) -- but NOT folded into the generic counts/afterByCollection loop below, unlike those
// two: that loop compares against `d[collection]`, which is keyed by id already for every other
// collection, while raw.customExercises is keyed by OWNER with an array value -- comparing it
// against this table (keyed by exercise id) needs its own loop, against the already-flattened
// `expectedCustomExerciseRows` built above, not against `d` or `raw` directly.
const customExerciseRowsResult = (await db.getConn().query('SELECT id, data FROM custom_exercise_rows')).rows;
const afterCustomExerciseRows = {}; for (const r of customExerciseRowsResult) afterCustomExerciseRows[r.id] = JSON.parse(r.data);
const problems = [];
{
  const afterKeys = Object.keys(afterCustomExerciseRows);
  if (afterKeys.length !== customExerciseRowCount) {
    problems.push(`customExerciseRows: expected ${customExerciseRowCount} row(s), found ${afterKeys.length}`);
  }
  for (const id of Object.keys(expectedCustomExerciseRows)) {
    if (!deepEqual(afterCustomExerciseRows[id], expectedCustomExerciseRows[id])) {
      problems.push(`customExerciseRows/${id}: content does not match the source file after read-back`);
    }
  }
}
for (const [collection, n] of Object.entries(counts)) {
  const afterKeys = Object.keys(afterByCollection[collection] || {});
  if (afterKeys.length !== n) { problems.push(`${collection}: expected ${n} row(s), found ${afterKeys.length}`); continue; }
  for (const id of Object.keys(d[collection])) {
    if (!deepEqual(afterByCollection[collection][id], d[collection][id])) {
      problems.push(`${collection}/${id}: content does not match the source file after read-back`);
    }
  }
}
if (d.followApprovalV1 !== undefined && !deepEqual(after.followApprovalV1, d.followApprovalV1)) {
  problems.push('followApprovalV1: content does not match the source file after read-back');
}
if (problems.length) {
  console.error('FATAL: post-migration read-back does not match the source file:');
  for (const p of problems) console.error(`  ${p}`);
  db.close();
  process.exit(1);
}

console.log('Migration verified: every collection\'s row counts AND content match on read-back.');
db.close();
