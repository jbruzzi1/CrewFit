// Oct 16 2026 (disaster-recovery wipe bug -- found while writing a regression test for the
// customExerciseRows orphan-deletion fix in test/pushsubs-customex-reports-migration-differential.mjs,
// reported to Jeff in chat immediately on finding it per hard rule #11, fixed same day on his
// explicit go-ahead: "I want to fix the above issue you mentioned"). See CLAUDE.md's
// "Rearchitecture status" for the full writeup; this is the permanent regression test for it.
//
// The bug: scripts/migrate-to-postgres.mjs (the documented disaster-recovery tool -- run against
// the newest JSON backup if the live database is ever lost or corrupted) used to default
// push_subs/notifications/feed_events/reports/custom_exercise_rows to `{}` whenever the backup
// file didn't have that key -- and EVERY backup taken since each of those collections' own
// rearchitecture cutover (push_subs/reports: Oct 14 2026; notifications/feed_events: Oct 13 2026;
// custom exercises: Oct 16 2026) genuinely does not have that key at all, because the live DB
// object stopped carrying it the moment its cutover landed (see db.js's EMPTY_DB/doLoad()
// comments) and a backup is just `JSON.stringify(DB)` (see backupOnBoot() in server.js). Handing
// `{}` to db.save()'s bootstrap-only syncTableFull branches -- a TRUE full-replace, upsert what's
// given AND delete everything that isn't -- silently wiped all five tables on every single run,
// while the script printed "Migration verified" and exited 0.
//
// The fix (see scripts/migrate-to-postgres.mjs's own long comment on `legacyPresent`, and
// db.js's updated doSave() comment): check the SOURCE FILE for the key's actual presence, not
// its truthiness. Present (an old-style backup, genuinely taken before that collection's own
// cutover) -> treat it as a real, complete snapshot and fully replace, exactly as before. Absent
// (every backup since) -> leave that collection's table completely untouched, verified by
// comparing its content before and after the run.
//
// Two scenarios below, both run against a REAL spawned server and a REAL Postgres database, same
// ground-truth technique as every other test in this suite:
//   A) A backup taken by the ACTUAL, CURRENT app (the only kind that will ever exist again) does
//      not wipe any of the five collections -- this is the exact scenario that was broken.
//   B) A hand-built OLD-STYLE backup (simulating a data.json from before these cutovers) still
//      restores and fully replaces all five collections, including deleting an orphan row not in
//      that backup -- proving the fix didn't just disable the real-restore path to fix the wipe.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';

const PORT = 5004, B = `http://localhost:${PORT}`;
const DIR = mkdtempSync(join(tmpdir(), 'migrate-recovery-no-wipe-'));
const J = { 'Content-Type': 'application/json' };
const CWD = new URL('..', import.meta.url).pathname;
let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const H = t => ({ ...J, Authorization: 'Bearer ' + t });
const post = (p, b, t) => fetch(B + p, { method: 'POST', headers: t ? H(t) : J, body: JSON.stringify(b) });
process.on('exit', () => { try { rmSync(DIR, { recursive: true, force: true }); } catch {} });

function boot(port, dir, databaseUrl) {
  return new Promise(res => {
    const s = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: databaseUrl, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    s.stdout.on('data', d => { if (String(d).includes('CrewFit on')) res(s); });
    s.stderr.on('data', d => process.stderr.write('[server] ' + d));
    s.on('exit', () => res(null));
    setTimeout(() => res(s), 10000);
  });
}
const stop = srv => new Promise(r => { if (!srv) return r(); srv.on('exit', r); srv.kill(); });

// ─────────────────────────────────────────────────────────────────────────────
console.log('A) a backup taken by the CURRENT app does not wipe push_subs/notifications/feed_events/reports/custom_exercise_rows on recovery');
{
  const testDb = await freshTestDb('migraterecoveryA');
  process.env.DATABASE_URL = testDb.url;
  const db = await import('../db.js');
  await db.ensureSchema();

  let srv = await boot(PORT, DIR, testDb.url);
  ok(!!srv, 'server boots');

  const alice = await post('/api/register', { username: 'mrwa_alice', pin: 'pass1234', displayName: 'Alice' }).then(r => r.json());
  const bob = await post('/api/register', { username: 'mrwa_bob', pin: 'pass1234', displayName: 'Bob' }).then(r => r.json());

  // One real row in each of the five cutover-only collections. Push sub, report, and custom
  // exercise go in through the real HTTP routes (the natural, simple path for each); notification
  // and feed event go in via db.js's own direct-Postgres functions -- the same functions
  // POST/various routes in server.js already call internally, and the same pattern
  // test/pushsubs-customex-reports-migration-differential.mjs already uses for setup -- since
  // there's no single simple HTTP action that deterministically creates exactly one of each
  // without a lot of unrelated setup (a crew, a PR, etc).
  const subR = await post('/api/push/subscribe', { subscription: { endpoint: 'https://push.example/mrwa', expirationTime: null, keys: { p256dh: 'p1', auth: 'a1' } } }, alice.token);
  ok(subR.status === 200, `push subscribe succeeds, got ${subR.status}`);
  const repR = await post('/api/report', { targetType: 'user', targetUserId: bob.user.id, reason: 'spam' }, alice.token);
  ok(repR.status === 200, `report succeeds, got ${repR.status}`);
  const exR = await post('/api/exercises/custom', { name: 'MRWA Curl', muscle_groups: ['biceps'] }, alice.token);
  ok(exR.status === 200, `custom exercise create succeeds, got ${exR.status}`);
  await db.pgInsertNotification({ id: 'mrwa_notif_1', userId: alice.user.id, title: 'Test', body: 'hi', count: 1, createdAt: new Date().toISOString() });
  await db.pgInsertFeedEvent({ id: 'mrwa_feed_1', type: 'pr', by: alice.user.id, at: new Date().toISOString() });

  const beforePushSubs = await db.getConn().query('SELECT user_id, data FROM push_subs');
  const beforeReports = await db.getConn().query('SELECT id, data FROM reports');
  const beforeCustomExerciseRows = await db.getConn().query('SELECT id, data FROM custom_exercise_rows');
  const beforeNotifications = await db.getConn().query('SELECT id, data FROM notifications');
  const beforeFeedEvents = await db.getConn().query('SELECT id, data FROM feed_events');
  ok(beforePushSubs.rows.length === 1 && beforeReports.rows.length === 1 && beforeCustomExerciseRows.rows.length === 1
     && beforeNotifications.rows.length === 1 && beforeFeedEvents.rows.length === 1,
     `setup: all five seeded rows are really there before any backup/recovery, got push_subs=${beforePushSubs.rows.length} reports=${beforeReports.rows.length} custom_exercise_rows=${beforeCustomExerciseRows.rows.length} notifications=${beforeNotifications.rows.length} feed_events=${beforeFeedEvents.rows.length}`);

  // A fresh reboot takes a real backup snapshot of the CURRENT app's DB object -- the only kind
  // of backup that will ever exist again now that all five collections are cut over.
  await stop(srv);
  srv = await boot(PORT, DIR, testDb.url);
  ok(!!srv, 'server re-boots (also takes the backup this test restores from)');
  await stop(srv);

  const bdir = join(DIR, 'backups');
  const newest = readdirSync(bdir).filter(f => f.endsWith('.json')).sort().pop();
  ok(!!newest, 'a backup file exists to restore from');

  let exitCode = 0;
  try {
    execFileSync('node', ['scripts/migrate-to-postgres.mjs', join(bdir, newest)], { cwd: CWD, env: { ...process.env, DATABASE_URL: testDb.url }, stdio: 'pipe' });
  } catch (e) {
    exitCode = e.status;
    process.stderr.write(String(e.stdout || '') + String(e.stderr || ''));
  }
  ok(exitCode === 0, `the documented recovery script exits 0 (not FATAL) against this backup, got ${exitCode}`);

  const afterPushSubs = await db.getConn().query('SELECT user_id, data FROM push_subs');
  const afterReports = await db.getConn().query('SELECT id, data FROM reports');
  const afterCustomExerciseRows = await db.getConn().query('SELECT id, data FROM custom_exercise_rows');
  const afterNotifications = await db.getConn().query('SELECT id, data FROM notifications');
  const afterFeedEvents = await db.getConn().query('SELECT id, data FROM feed_events');
  ok(afterPushSubs.rows.length === 1, `push_subs: the real row survives the recovery run, not wiped (THE bug -- got ${afterPushSubs.rows.length} row(s))`);
  ok(afterReports.rows.length === 1, `reports: the real row survives the recovery run, not wiped (got ${afterReports.rows.length} row(s))`);
  ok(afterCustomExerciseRows.rows.length === 1, `custom_exercise_rows: the real row survives the recovery run, not wiped (got ${afterCustomExerciseRows.rows.length} row(s))`);
  ok(afterNotifications.rows.length === 1, `notifications: the real row survives the recovery run, not wiped (got ${afterNotifications.rows.length} row(s))`);
  ok(afterFeedEvents.rows.length === 1, `feed_events: the real row survives the recovery run, not wiped (got ${afterFeedEvents.rows.length} row(s))`);
  ok(afterCustomExerciseRows.rows[0] && JSON.parse(afterCustomExerciseRows.rows[0].data).name === 'MRWA Curl',
     `and its content is exactly what was there before, not just a coincidental count match, got ${JSON.stringify(afterCustomExerciseRows.rows[0] && JSON.parse(afterCustomExerciseRows.rows[0].data).name)}`);

  db.close();
  await testDb.drop();
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nB) a hand-built OLD-STYLE backup (simulating a pre-cutover data.json) still fully restores, including deleting an orphan not in it');
{
  const testDb = await freshTestDb('migraterecoveryB');
  process.env.DATABASE_URL = testDb.url;
  const db = await import('../db.js');
  await db.ensureSchema();

  // A stray pre-existing row for an owner NOT in the backup below -- the adversarial-review
  // scenario this recovery script's custom_exercise_rows orphan-deletion fix exists for. An
  // old-style restore (one that genuinely covers this collection) must still delete it.
  await db.pgUpsertCustomExerciseRow({ id: 'mrwb_stray', ownerId: 'owner-not-in-backup', name: 'Stray Curl', muscle_groups: ['biceps'] });

  const oldStyleBackup = {
    users: { u1: { id: 'u1', username: 'mrwb_oldstyle', pin: 'x', displayName: 'Old' } },
    sessions: {}, templates: {}, prs: {}, crews: {},
    pushSubs: { u1: { endpoint: 'https://push.example/mrwb-old', keys: { auth: 'a', p256dh: 'p' } } },
    notifications: { n1: { id: 'n1', userId: 'u1', title: 'Old notif', body: 'hi', count: 1, createdAt: '2026-01-01T00:00:00.000Z' } },
    feedEvents: { f1: { id: 'f1', type: 'pr', by: 'u1', at: '2026-01-01T00:00:00.000Z' } },
    reports: { r1: { id: 'r1', targetType: 'user', targetUserId: 'u1', reason: 'spam', status: 'open', at: '2026-01-01T00:00:00.000Z' } },
    customExercises: { u1: [{ id: 'ce1', name: 'Old Style Curl', muscle_groups: ['biceps'] }] },
  };
  const file = join(DIR, 'old-style-data.json');
  writeFileSync(file, JSON.stringify(oldStyleBackup));

  let exitCode = 0;
  try {
    execFileSync('node', ['scripts/migrate-to-postgres.mjs', file], { cwd: CWD, env: { ...process.env, DATABASE_URL: testDb.url }, stdio: 'pipe' });
  } catch (e) {
    exitCode = e.status;
    process.stderr.write(String(e.stdout || '') + String(e.stderr || ''));
  }
  ok(exitCode === 0, `the recovery script exits 0 restoring a genuine old-style backup, got ${exitCode}`);

  const pushSubs = await db.getConn().query('SELECT user_id, data FROM push_subs');
  const notifications = await db.getConn().query('SELECT id, data FROM notifications');
  const feedEvents = await db.getConn().query('SELECT id, data FROM feed_events');
  const reports = await db.getConn().query('SELECT id, data FROM reports');
  const customExerciseRows = await db.getConn().query('SELECT id, owner_id, data FROM custom_exercise_rows');
  ok(pushSubs.rows.length === 1, `pushSubs: restored from the old-style backup, got ${pushSubs.rows.length} row(s)`);
  ok(notifications.rows.length === 1, `notifications: restored from the old-style backup, got ${notifications.rows.length} row(s)`);
  ok(feedEvents.rows.length === 1, `feedEvents: restored from the old-style backup, got ${feedEvents.rows.length} row(s)`);
  ok(reports.rows.length === 1, `reports: restored from the old-style backup, got ${reports.rows.length} row(s)`);
  ok(customExerciseRows.rows.length === 1, `customExerciseRows: restored from the old-style backup AND the orphan deleted, got ${customExerciseRows.rows.length} row(s)`);
  ok(customExerciseRows.rows.length === 1 && customExerciseRows.rows[0].id === 'ce1', `the surviving row is the one FROM the backup (ce1), not the stray orphan, got ${JSON.stringify(customExerciseRows.rows.map(r => r.id))}`);

  db.close();
  await testDb.drop();
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nC) a backup with a MALFORMED value for one of these five keys (present, but null/not-an-object) is refused outright, not silently wiped or silently restored as empty');
{
  // Adversarial-review finding on the fix above, reproduced live by the reviewer (same day):
  // `legacyPresent` originally only checked whether the KEY was present, not whether its value
  // actually looks like a real collection snapshot. A hand-edited or corrupted backup with, say,
  // `"pushSubs": null` passed that check as "a genuine old-style backup, safe to fully replace" --
  // and syncTableFull's `Object.keys(obj || {})` silently treats `null` as `{}`, so that "replace"
  // was a full, silent wipe of a real table, the exact failure mode the whole fix exists to
  // close, just reached through a different input shape than "key absent." Fixed by refusing
  // outright (FATAL, exit 1, nothing touched) whenever one of these five keys is present with a
  // non-object value, rather than guessing whether that means "empty" (wipe) or "corrupted"
  // (leave alone) -- a disaster-recovery tool specifically has to be trusted against abnormal
  // input, not guess at it.
  const testDb = await freshTestDb('migraterecoveryC');
  process.env.DATABASE_URL = testDb.url;
  const db = await import('../db.js');
  await db.ensureSchema();
  await db.pgSetPushSub('mrwc-existing-user', { endpoint: 'https://push.example/mrwc', keys: { auth: 'a', p256dh: 'p' } });

  const malformedBackup = { users: {}, sessions: {}, templates: {}, prs: {}, crews: {}, pushSubs: null };
  const file = join(DIR, 'malformed-data.json');
  writeFileSync(file, JSON.stringify(malformedBackup));

  let exitCode = 0, out = '';
  try {
    out = execFileSync('node', ['scripts/migrate-to-postgres.mjs', file], { cwd: CWD, env: { ...process.env, DATABASE_URL: testDb.url } }).toString();
  } catch (e) {
    exitCode = e.status;
    out = String(e.stdout || '') + String(e.stderr || '');
  }
  ok(exitCode === 1, `the script refuses (exit 1), does not guess, got exit ${exitCode}`);
  ok(/FATAL.*pushSubs/.test(out), `and says plainly which collection is malformed, got: ${out.slice(0, 300)}`);

  const pushSubs = await db.getConn().query('SELECT user_id FROM push_subs');
  ok(pushSubs.rows.length === 1, `the real push_subs row was never touched by the refused run, got ${pushSubs.rows.length} row(s)`);

  db.close();
  await testDb.drop();
}

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
