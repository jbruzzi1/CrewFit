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
const d = {
  users: raw.users || {},
  sessions: raw.sessions || {},
  templates: raw.templates || {},
  pushSubs: raw.pushSubs || {},
  customExercises: raw.customExercises || {},
  prs: raw.prs || {},
};
// Singleton bookkeeping field — only carried over if actually present in the source file, so a
// migration never invents a value db.js's save() would otherwise have left untouched.
if (raw.followApprovalV1 !== undefined) d.followApprovalV1 = raw.followApprovalV1;

const counts = {
  users: Object.keys(d.users).length,
  sessions: Object.keys(d.sessions).length,
  templates: Object.keys(d.templates).length,
  pushSubs: Object.keys(d.pushSubs).length,
  customExercises: Object.keys(d.customExercises).length,
  prs: Object.keys(d.prs).length,
};
console.log(`Migrating ${file} -> ${process.env.DATABASE_URL.replace(/:[^:@]*@/, ':***@')}`);
console.log(`  users=${counts.users} sessions=${counts.sessions} templates=${counts.templates} pushSubs=${counts.pushSubs} customExercises=${counts.customExercises} prs=${counts.prs}`);

const db = (await import('../db.js')).default;
await db.ensureSchema();
await db.save(d);

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

console.log('Migration verified: every collection\'s row counts AND content match on read-back.');
db.close();
