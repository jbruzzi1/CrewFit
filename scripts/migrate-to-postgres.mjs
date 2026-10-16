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

// Oct 16 2026 (adversarial review of the disaster-recovery wipe fix just below, reproduced live
// by the reviewer): the original version of the `legacyPresent` check (see its own long comment
// below) only tested whether the key was PRESENT, not whether its value actually looks like a
// genuine collection snapshot. A source file with `"pushSubs": null` (or any non-object value)
// for one of these five keys passed that check as "a real old-style backup, safe to fully
// replace" -- and since syncTableFull's `Object.keys(obj || {})` silently treats `null` as `{}`,
// that "replace" was a full, silent wipe, the exact failure mode the fix below exists to close,
// just reached through a different input shape. Reproduced by the reviewer: seeded a real
// push_subs row, wrote a backup with `pushSubs: null` alongside real users, ran this script
// against it, watched the row disappear while the script printed "Migration verified." A
// malformed value here can only come from a hand-edited or corrupted file (every historical
// EMPTY_DB-era version of the live DB object defaulted these fields to a real `{}`, never `null`,
// so a genuine backup file was never going to produce this on its own) -- which is exactly the
// kind of input this disaster-recovery tool specifically has to be trusted against, not the kind
// it can afford to guess about. So this refuses outright rather than silently picking a side
// (treat it as empty-and-wipe, or as absent-and-skip): a human has to look at the file and decide.
function isPlainCollectionObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
{
  const malformed = ['pushSubs', 'notifications', 'feedEvents', 'reports', 'customExercises']
    .filter(key => Object.prototype.hasOwnProperty.call(raw, key) && !isPlainCollectionObject(raw[key]));
  if (malformed.length) {
    console.error(`FATAL: ${file} has a malformed value for: ${malformed.join(', ')} — expected a plain object (or the key to be entirely absent, which is normal for any backup taken since that collection's own cutover), got something else (null / an array / a primitive) instead.`);
    console.error('This script refuses to guess whether that means "this collection is genuinely empty" (safe to fully replace with nothing) or "this file is corrupted/hand-edited wrong" (NOT safe to touch) -- deciding wrong either way can silently destroy real data in the target database.');
    console.error('Fix the file by hand (set it to a real object, e.g. {}, if it really is meant to be an old-style snapshot of this collection -- or remove the key entirely if this collection is not meant to be restored from this file) and re-run.');
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
// Oct 16 2026 (disaster-recovery wipe bug, found while writing a regression test for the
// customExerciseRows orphan-deletion fix below, reported to Jeff, fixed same day on his go-ahead
// "I want to fix the above issue"): pushSubs/notifications/feedEvents/reports/customExercises are
// only ever genuinely present in a source file that predates that specific collection's own
// cutover -- the point in time each one was removed from the live DB object entirely (see db.js's
// EMPTY_DB/doLoad() comments). EVERY backup taken since (this app backs up with a plain
// `JSON.stringify(DB)` -- see backupOnBoot() in server.js) genuinely does not have the key at all,
// which is NOT the same thing as "this backup has zero items in this collection." The difference
// matters because `raw.pushSubs || {}` (what this script used to do) collapses both cases to the
// same `{}` -- and db.save()'s bootstrap-only branches for these four tables, and this script's
// own customExerciseRows flatten below, treat `{}` as a real, complete, authoritative snapshot:
// upsert what's given AND delete every row that isn't. Fed `{}` every single time (because the
// key is never actually there any more), that is a full wipe disguised as a restore.
//
// Reproduced live, three different ways, before this fix: seeded a push subscription, a user
// report, and a custom exercise; took one real backup; ran this script against it; all three were
// silently deleted, and the script printed "Migration verified." This was not unique to today's
// custom-exercise work -- push_subs/reports (cut over Oct 14) and notifications/feed_events (cut
// over Oct 13) have had this exact gap since their own cutovers landed, just never noticed,
// because the one test that exercises this script (test/data-safety.mjs's "documented recovery
// path") only ever asserted on the user count surviving.
//
// The fix checks for the KEY'S PRESENCE, not its truthiness or content: `'pushSubs' in raw` is
// true for an old-style backup (even a genuinely empty `{}` one, from back when that was still a
// real, complete snapshot) and false for every backup since that collection's cutover. Only the
// true case gets handed a real object; the false case gets `undefined` instead of `{}` --
// `undefined` already means "this save() call has nothing to say about this field" by convention
// in this file (see the SINGLETON_FIELDS loop in doSave()), extended here to these four
// collections too. db.save() (see its own updated comment) and this script's own verification
// below both now treat `undefined` as "leave this table completely untouched," not "replace it
// with nothing."
const legacyPresent = {
  pushSubs: Object.prototype.hasOwnProperty.call(raw, 'pushSubs'),
  notifications: Object.prototype.hasOwnProperty.call(raw, 'notifications'),
  feedEvents: Object.prototype.hasOwnProperty.call(raw, 'feedEvents'),
  reports: Object.prototype.hasOwnProperty.call(raw, 'reports'),
  customExercises: Object.prototype.hasOwnProperty.call(raw, 'customExercises'),
};

const d = {
  users: raw.users || {},
  sessions: raw.sessions || {},
  templates: raw.templates || {},
  pushSubs: legacyPresent.pushSubs ? raw.pushSubs : undefined,
  prs: raw.prs || {},
  // Oct 16 2026 (crews deep-dive, decision #1 -- messages/challenges moved to their own tables):
  // checked whether `crews` needed the same legacyPresent-style disaster-recovery treatment as
  // pushSubs/notifications/feedEvents/reports/customExercises just above/below, since Jeff flagged
  // this as non-negotiable for the new crew_messages/crew_challenges tables too. It doesn't, for a
  // structural reason specific to how this one migration is shaped (verified, not assumed):
  //   1. crew_messages/crew_challenges are read/written ONLY through db.js's direct-Postgres
  //      functions (pgInsertCrewMessage, pgUpsertCrewChallenge, etc.) -- they are never part of
  //      db.save()'s generic table sync at all (unlike push_subs/notifications/feed_events/reports,
  //      which WERE syncTableFull'd by db.save() itself, which is what made the `{}`-vs-`undefined`
  //      distinction below load-bearing for THEM). This script's `db.save(d)` call below physically
  //      cannot write to, and so cannot wipe, crew_messages/crew_challenges -- there's no code path
  //      from here to those tables at all.
  //   2. Unlike customExercises (which needed its own explicit flatten a few lines down, because
  //      EMPTY_DB/doLoad()/doSave() dropped that collection from the generic DB object ENTIRELY,
  //      leaving no other path for old data to survive), `crews` is still a fully generic,
  //      untouched db.save()-handled collection -- CREWS_UPSERT_SQL stores each crew's `data`
  //      verbatim (jsonToParams does a plain JSON.stringify, no field filtering), so an old-style
  //      backup's embedded c.messages/c.challenges arrays ride along into the crews table's jsonb
  //      blob exactly as they always did, untouched by this script either way.
  // Net effect: restoring an old-style backup through this script does not lose or silently wipe
  // any message/challenge data -- it just defers moving it into the new tables to the very next
  // server boot, which already has a dedicated, idempotent, crash-safe migration for exactly that
  // (migrateCrewMessagesAndChallengesIntoPostgres in server.js, same "flatten on boot" pattern the
  // now-retired migrateCustomExerciseRowsIntoPostgres used). See test/crews.mjs's migration test
  // for the end-to-end proof of that boot-time flatten; nothing further is needed here.
  crews: raw.crews || {},
  notifications: legacyPresent.notifications ? raw.notifications : undefined,
  feedEvents: legacyPresent.feedEvents ? raw.feedEvents : undefined,
  reports: legacyPresent.reports ? raw.reports : undefined,
};
// Singleton bookkeeping field — only carried over if actually present in the source file, so a
// migration never invents a value db.js's save() would otherwise have left untouched.
if (raw.followApprovalV1 !== undefined) d.followApprovalV1 = raw.followApprovalV1;

const counts = {
  users: Object.keys(d.users).length,
  sessions: Object.keys(d.sessions).length,
  templates: Object.keys(d.templates).length,
  prs: Object.keys(d.prs).length,
  crews: Object.keys(d.crews).length,
};
// pushSubs/notifications/feedEvents/reports are deliberately NOT in `counts` any more -- they are
// no longer guaranteed to be plain row-count-able objects (can be `undefined`), and -- now that
// db.load() doesn't return them either -- they get their own direct-SQL before/after verification
// below, same treatment customExerciseRows already needed for the same reason.
// customExerciseRows is counted separately below, once raw.customExercises (old array-per-owner
// shape) is actually flattened -- Object.keys(raw.customExercises||{}).length would only count
// OWNERS, not individual exercises, which is the wrong number for this collection specifically
// (every other collection above is already keyed one-row-per-entity, so Object.keys().length IS
// the row count for those).
const legacyLabel = (name, present) => present ? `${name}=${Object.keys(d[name] ?? raw[name] ?? {}).length}` : `${name}=<not in backup, left untouched>`;
console.log(`Migrating ${file} -> ${process.env.DATABASE_URL.replace(/:[^:@]*@/, ':***@')}`);
console.log(`  users=${counts.users} sessions=${counts.sessions} templates=${counts.templates} prs=${counts.prs} crews=${counts.crews} ${legacyLabel('pushSubs', legacyPresent.pushSubs)} ${legacyLabel('notifications', legacyPresent.notifications)} ${legacyLabel('feedEvents', legacyPresent.feedEvents)} ${legacyLabel('reports', legacyPresent.reports)}`);

const db = (await import('../db.js')).default;
await db.ensureSchema();

// Snapshot the four cutover-only tables' CURRENT content before save() touches anything --
// the only way to later prove a table genuinely marked "not in backup" was left byte-for-byte
// alone, rather than just hoping db.save()'s updated guard (see its own comment) worked.
async function readTable(table, idCol) {
  const r = await db.getConn().query(`SELECT ${idCol} AS id, data FROM ${table}`);
  const out = {};
  for (const row of r.rows) out[row.id] = JSON.parse(row.data);
  return out;
}
const beforePushSubs = await readTable('push_subs', 'user_id');
const beforeNotifications = await readTable('notifications', 'id');
const beforeFeedEvents = await readTable('feed_events', 'id');
const beforeReports = await readTable('reports', 'id');
const beforeCustomExerciseRows = await readTable('custom_exercise_rows', 'id');

await db.save(d);

// Oct 16 2026 (read cutover, task #258+ phase 2): flattens raw.customExercises (the OLD array-
// per-owner shape a backup taken BEFORE the customExercises cutover has) straight into the NEW
// custom_exercise_rows table (one row per exercise) -- the exact flatten
// migrateCustomExerciseRowsIntoPostgres used to do every boot in server.js, now retired now that
// DB.customExercises can never exist again (see that removal's own comment in server.js). Same
// defensive id-backfill migrateCustomExerciseIds used to apply at boot: a legacy row from before
// Sep 30 2026 has no `id` yet, and this script never runs that old boot migration, so a brand-new
// one is minted here instead. Vanishingly unlikely against a REAL old-style backup (every backup
// taken since that migration first landed already has ids, persisted by the very boot that made
// it), but cheap insurance against a much older hand-supplied file.
//
// Oct 16 2026, same day (disaster-recovery wipe bug, see the long comment above `legacyPresent`):
// this whole block -- flatten AND the orphan-deletion fix just below it -- now only runs when
// `legacyPresent.customExercises` is true, i.e. the source file is an old-style backup that
// genuinely predates the customExercises cutover and actually has the key. Every backup since
// that cutover does not have `raw.customExercises` at all -- running this unconditionally (as it
// did until today) meant `expectedCustomExerciseRows` was always `{}`, and the orphan-deletion
// loop then deleted every real row in custom_exercise_rows on every single run, reporting it as
// "removed N orphan(s)" as if that were a good thing. Reproduced live, fixed by skipping this
// block entirely when the backup doesn't cover this collection -- see the matching `else` branch
// in the verification section below, which proves the table was left byte-for-byte alone instead.
let expectedCustomExerciseRows = null;
let removedCustomExerciseRowOrphans = 0;
if (legacyPresent.customExercises) {
  expectedCustomExerciseRows = {};
  for (const [ownerId, arr] of Object.entries(raw.customExercises || {})) {
    for (const e of (Array.isArray(arr) ? arr : [])) {
      if (!e || typeof e !== 'object') continue;   // tolerate a malformed exercise object rather than crash the migration -- same stance server.js's own boot migrations already took
      if (!e.id) e.id = crypto.randomUUID();
      const row = { ...e, ownerId };
      await db.pgUpsertCustomExerciseRow(row);
      expectedCustomExerciseRows[row.id] = row;
    }
  }
  // Adversarial-review finding (reproduced live): every OTHER collection this script restores
  // goes through db.js's syncTableFull, which is a true full-replace -- it deletes any row in the
  // target table that ISN'T in the backup, not just upserts what is. The loop just above was
  // upsert-only, so restoring an OLD-STYLE backup into a database that already had SOME
  // custom_exercise_rows not present in that backup (live traffic since the snapshot, or any
  // stray leftover row) left those orphans silently surviving a "restore" -- exactly the
  // two-way-reconciliation gap the old migrateCustomExerciseRowsIntoPostgres boot migration had
  // already been fixed to close once (see its own comment, before it was retired along with
  // DB.customExercises). Reproduced: seeding one pre-existing row for a different owner before
  // running this script against an old-style backup that didn't mention it left that row behind,
  // and the read-back verification below correctly caught it as an unexpected extra row. Fixed by
  // actually deleting anything in the table that isn't in `expectedCustomExerciseRows`, so this
  // script's restore of an old-style backup is a real full-replace like every other collection's,
  // not a merge. (This is correct ONLY because we already know, from the `if` above, that this
  // backup is a genuine complete snapshot of this collection -- the exact thing that stopped being
  // true for every backup going forward, which is why the `if` exists at all now.)
  const existingCustomExerciseRows = (await db.getConn().query('SELECT id, owner_id FROM custom_exercise_rows')).rows;
  for (const row of existingCustomExerciseRows) {
    if (!expectedCustomExerciseRows[row.id]) {
      await db.pgDeleteCustomExerciseRow(row.id, row.owner_id);
      removedCustomExerciseRowOrphans++;
    }
  }
  const customExerciseRowCount = Object.keys(expectedCustomExerciseRows).length;
  console.log(`  customExerciseRows=${customExerciseRowCount} (flattened from raw.customExercises)${removedCustomExerciseRowOrphans ? `, removed ${removedCustomExerciseRowOrphans} orphan(s) not present in the source file` : ''}`);
} else {
  console.log('  customExerciseRows=<not in backup, left untouched>');
}

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
const problems = [];

// Oct 13/14/16 2026 (read cutover, tasks #252/#258+): push_subs/notifications/feed_events/
// reports/custom_exercise_rows are no longer part of what db.load() returns at all -- they're
// served through the direct-Postgres functions now (see db.js's EMPTY_DB/doLoad() comments), not
// the generic in-memory DB object this script otherwise verifies against. Each is read back with
// a plain SELECT off the same connection instead.
//
// Oct 16 2026 (disaster-recovery wipe bug): each of these five now verifies ONE of two different
// things, depending on `legacyPresent` (see its own long comment above): if the source file
// genuinely covered this collection (an old-style backup), verify its content matches the source
// exactly, same as every other collection below. If it didn't (every backup since that
// collection's own cutover), verify the table was left COMPLETELY UNCHANGED from its pre-save
// snapshot (`before*`, captured above, right before db.save(d) ran) -- proving this script
// actually did nothing to a collection it has no business touching, rather than just hoping the
// `undefined`-means-"don't touch" convention (see db.js's updated comment) held.
function verifyCutoverCollection(name, present, afterRows, beforeRows, expected) {
  if (present) {
    const afterKeys = Object.keys(afterRows);
    const expectedKeys = Object.keys(expected);
    if (afterKeys.length !== expectedKeys.length) {
      problems.push(`${name}: expected ${expectedKeys.length} row(s) from the backup, found ${afterKeys.length}`);
      return;
    }
    for (const id of expectedKeys) {
      if (!deepEqual(afterRows[id], expected[id])) {
        problems.push(`${name}/${id}: content does not match the source file after read-back`);
      }
    }
  } else {
    if (!deepEqual(afterRows, beforeRows)) {
      problems.push(`${name}: not present in this backup, but the table changed anyway (expected it to be left completely untouched) -- before had ${Object.keys(beforeRows).length} row(s), after has ${Object.keys(afterRows).length}`);
    }
  }
}

verifyCutoverCollection('pushSubs', legacyPresent.pushSubs, await readTable('push_subs', 'user_id'), beforePushSubs, d.pushSubs || {});
verifyCutoverCollection('notifications', legacyPresent.notifications, await readTable('notifications', 'id'), beforeNotifications, d.notifications || {});
verifyCutoverCollection('feedEvents', legacyPresent.feedEvents, await readTable('feed_events', 'id'), beforeFeedEvents, d.feedEvents || {});
verifyCutoverCollection('reports', legacyPresent.reports, await readTable('reports', 'id'), beforeReports, d.reports || {});
verifyCutoverCollection('customExerciseRows', legacyPresent.customExercises, await readTable('custom_exercise_rows', 'id'), beforeCustomExerciseRows, expectedCustomExerciseRows || {});

for (const [collection, n] of Object.entries(counts)) {
  const afterKeys = Object.keys(after[collection] || {});
  if (afterKeys.length !== n) { problems.push(`${collection}: expected ${n} row(s), found ${afterKeys.length}`); continue; }
  for (const id of Object.keys(d[collection])) {
    if (!deepEqual(after[collection][id], d[collection][id])) {
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

console.log('Migration verified: every collection covered by this backup matches on read-back, and every collection NOT covered by it (see any "left untouched" lines above) was provably left alone.');
db.close();
