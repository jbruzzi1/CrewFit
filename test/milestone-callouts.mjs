// Milestone callouts (Task #32, Oct 21 2026) -- Jeff: "workout counts + time anniversaries,"
// private only (push + the user's own profile; the profile marker itself is a separate, later
// piece that needs a screenshot shown to Jeff first per hard rule #9 -- NOT built or tested here,
// only the notification half is). Covers:
//   - live crossing via real /lock calls: no premature firing below the threshold, firing exactly
//     at the threshold, totalWorkouts/milestonesSeen reflected in GET /api/me/milestones
//   - idempotency: a repeated /lock (creditFinish is idempotent per user) must not re-fire or
//     duplicate the "Milestone reached" notification
//   - anniversary milestones, crossed the moment ANY workout is credited after the calendar date
//     passes (markNewlyCrossedMilestones checks both milestone types on every call, not just
//     workout-count ones)
//   - the backfill-no-spam guarantee: a user who already had the data to cross milestones BEFORE
//     this feature's one-time boot backfill ever ran must be silently seeded (milestonesSeen
//     populated) with ZERO notifications -- the exact failure mode migrateMilestonesBackfillV1
//     exists to prevent (shipping would otherwise instantly blast 3-5 lifetime pushes at once to
//     every existing user with 50+ workouts or a year+ on the app)
//   - that the backfill guard is a ONE-TIME catch-up, not a standing kill switch: a brand-new
//     crossing on the SAME already-backfilled server still notifies normally
//   - auth is required on the new endpoint
//
// Not verified here, same caveat as streak-reminders.mjs/workout-reminders.mjs: the daily
// MILESTONE_CHECK_HOUR_UTC setInterval scheduler itself (anniversary backstop/poll), and actual
// push delivery (notify() silently no-ops the webpush.sendNotification call for test users with
// no subscription) -- "did notify() run at all" is instead verified the same way those two files
// verify their own notify() calls would have fired: by reading notify()'s own persisted in-app
// history via GET /api/notifications (history entries are written unconditionally, before the
// subscription check -- see notify()'s own comment), or, for the backfill test (which has no
// logged-in session to call that route with), by reading the notifications table directly.
//
// Also: an independent cold-review before this shipped (Oct 21 2026) found two real pre-ship
// bugs -- see markNewlyCrossedMilestones' and each call site's own "Cold-review catch" comments
// in server.js. (1) a save(DB) failure specifically during /lock used to leave milestonesSeen
// silently advanced in memory with nothing reverting it (not just skipping the notification --
// the record itself stayed mutated, ready to be persisted for real by some later, unrelated
// successful save) -- fixed, and proven below with a REAL Postgres failure (the same
// breakTable/fixTable technique test/phase1-mutate-before-save-regression.mjs uses), not just
// disclosed. (2) the fix uses this codebase's own established, already-reviewed CAS pattern
// (snapshotMutableFields/revertFieldsIfUnchanged, the same one FOLLOW_FIELDS uses) specifically so
// a revert can't clobber a DIFFERENT, already-saved-and-notified crossing for the same user that
// landed in between (withSessionLock only serializes per-session, not per-user, so a /lock and a
// /leave keep-credit for the same user are never mutually excluded) -- genuinely racing two live
// HTTP requests against a precise, one-save-fails-one-succeeds timing window isn't attempted here
// (this codebase has no way to do that deterministically, only to break/fix a WHOLE table across
// however many requests land while it's broken); confidence for that half rests on reusing the
// exact mechanism FOLLOW_FIELDS already relies on for the identical hazard, not a dedicated test.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';
import { PgConnection, parseConnString } from '../pgmini.js';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const J = { 'Content-Type': 'application/json' };
const CWD = new URL('..', import.meta.url).pathname;
const normUser = v => String(v == null ? '' : v).trim().toLowerCase();

function boot(port, dir, dbUrl) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: dbUrl, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; srv.stdout.on('data', d => { out += d; if (String(d).includes('CrewFit on')) res({ srv, out }); });
    srv.on('exit', () => res({ srv: null, out }));
    setTimeout(() => res({ srv, out }), 15000);
  });
}

// --- Part 1: live crossing, idempotency, anniversaries, auth -- one normal server, registered
// and credited entirely over real HTTP, same as every other feature test in this suite. ---

const testDb = await freshTestDb('milestones');
const DIR = mkdtempSync(join(tmpdir(), 'milestones-'));
const PORT = 4994, B = `http://localhost:${PORT}`;
let { srv } = await boot(PORT, DIR, testDb.url);
ok(!!srv, 'server boots');

// Oct 20/21 2026 idiom (see workout-reminders.mjs's own comment): crash-safe cleanup so a genuinely
// failing assertion/await doesn't leave the spawned server (and, for Part 2, the raw PgConnection)
// orphaned for whatever test runs next.
let cleanedUp = false;
async function cleanup() {
  if (cleanedUp) return; cleanedUp = true;
  try { srv && srv.kill(); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
  try { await testDb.drop(); } catch {}
}
process.on('uncaughtException', async (e) => { console.error('UNCAUGHT', e); await cleanup(); process.exit(1); });
process.on('unhandledRejection', async (e) => { console.error('UNHANDLED', e); await cleanup(); process.exit(1); });

const post = (p, b, tok) => fetch(B + p, { method: 'POST', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b) }).then(r => r.json());
const get = (p, tok) => fetch(B + p, { headers: tok ? { Authorization: 'Bearer ' + tok } : {} }).then(r => r.json());
const reg = (username, pin, displayName) => post('/api/register', { ageConfirmed: true, username, pin, displayName });

// Creates one session, logs one set, and locks it (credits exactly one workout for `tok`) --
// the real end-to-end path /lock's own milestone check runs on, not a shortcut around it.
async function creditOneWorkout(tok, name) {
  const s = await post('/api/sessions', {
    name: name || 'Workout', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Bench Press' }],
    inviteUsernames: [], visibility: 'private',
  }, tok);
  await post(`/api/sessions/${s.id}/log`, { exerciseId: s.exercises[0].id, weight: 135, reps: 8 }, tok);
  return post(`/api/sessions/${s.id}/lock`, {}, tok);
}
const milestoneNotifs = history => (history || []).filter(h => h.title === 'Milestone reached');

console.log('\nbelow the first threshold (9 workouts): not crossed, no notification, GET reflects the real count');
let cal;
{
  cal = await reg('ms_cal', 'pass1234', 'Cal');
  for (let i = 0; i < 9; i++) await creditOneWorkout(cal.token, 'Workout ' + i);

  const m = await get('/api/me/milestones', cal.token);
  ok(m.totalWorkouts === 9, `totalWorkouts is 9 (got ${JSON.stringify(m)})`);
  ok(!m.milestonesSeen.includes('workouts_10'), `workouts_10 NOT yet in milestonesSeen (got ${JSON.stringify(m.milestonesSeen)})`);

  const n = await get('/api/notifications', cal.token);
  ok(milestoneNotifs(n.history).length === 0, `no "Milestone reached" notification yet (got ${JSON.stringify(n.history)})`);
}

console.log('\ncrossing the threshold on the 10th workout: fires exactly once, with the right body');
{
  await creditOneWorkout(cal.token, 'Workout 9');

  const m = await get('/api/me/milestones', cal.token);
  ok(m.totalWorkouts === 10, `totalWorkouts is 10 (got ${m.totalWorkouts})`);
  ok(m.milestonesSeen.includes('workouts_10'), `workouts_10 now in milestonesSeen (got ${JSON.stringify(m.milestonesSeen)})`);
  ok(!m.milestonesSeen.includes('workouts_50'), `workouts_50 NOT claimed early (got ${JSON.stringify(m.milestonesSeen)})`);

  const n = await get('/api/notifications', cal.token);
  const fired = milestoneNotifs(n.history);
  ok(fired.length === 1, `exactly one "Milestone reached" notification exists (got ${fired.length}: ${JSON.stringify(fired)})`);
  ok(fired[0] && /10 workouts/.test(fired[0].body), `body names 10 workouts (got ${fired[0] && fired[0].body})`);
}

console.log('\nidempotency: re-locking the SAME already-finished session does not re-fire or duplicate the milestone');
{
  const sessions = await get('/api/sessions', cal.token);
  const s = sessions.find(x => x.name === 'Workout 9');
  const before = await get('/api/me/milestones', cal.token);
  await post(`/api/sessions/${s.id}/lock`, {}, cal.token);   // creditFinish is idempotent -- this must be a no-op
  const after = await get('/api/me/milestones', cal.token);
  ok(JSON.stringify(before.milestonesSeen) === JSON.stringify(after.milestonesSeen), `milestonesSeen unchanged by the repeat /lock (before ${JSON.stringify(before.milestonesSeen)}, after ${JSON.stringify(after.milestonesSeen)})`);

  const n = await get('/api/notifications', cal.token);
  ok(milestoneNotifs(n.history).length === 1, `still exactly one "Milestone reached" notification, not duplicated (got ${milestoneNotifs(n.history).length})`);
}

console.log('\nanniversary milestone: crosses the moment ANY workout is credited after the calendar date passes, independent of workout count');
{
  const dee = await reg('ms_dee', 'pass1234', 'Dee');
  // There is no API letting a user set their own join date, and DB.users lives in memory --
  // editing Postgres directly while this same server is still running would not touch the
  // already-loaded in-memory copy /api/me/milestones actually reads, so it would silently do
  // nothing (confirmed: that was tried first and monthsSinceCreated kept reading 0). The real
  // fix: stop the server, backdate createdAt directly via Postgres while nothing has it loaded in
  // memory, then reboot against the SAME database so the fresh in-memory DB is read back off the
  // now-backdated row -- same "bypass the app, then let it reload for real" shape boot-shape.mjs
  // uses, just applied mid-test instead of only at the very first boot. milestonesBackfillV1 is
  // already true from this database's first boot, so this second boot's backfill call is a no-op
  // (see migrateMilestonesBackfillV1's own early return) -- the anniversary crossing below is
  // caught live, by the /lock route's own check, not by the backfill. 4 months clears anniv_3mo
  // (3) but not anniv_6mo (6).
  //
  // createdAt lives in its own real `created_at` COLUMN, not inside the `data` jsonb blob --
  // confirmed by reading db.js's own comment (Oct 16 2026, users slice decision #2): registration
  // calls db.markUserColumnsMigrated(id) immediately, which excludes createdAt (and the other
  // scalar fields) from the blob from a brand-new account's very first write onward (see
  // usersToParams' own comment). A jsonb_set on `data` -- confirmed by trying it first -- silently
  // writes a field nothing ever reads back; doRow() (db.js) only ever assigns u.createdAt from
  // row.created_at.
  const fourMonthsAgo = new Date(); fourMonthsAgo.setUTCMonth(fourMonthsAgo.getUTCMonth() - 4);
  try { srv && srv.kill(); } catch {}
  const pg = new PgConnection(parseConnString(testDb.url));
  await pg.query('UPDATE users SET created_at = $2 WHERE id = $1', [dee.user.id, fourMonthsAgo.toISOString()]);
  pg.close();
  ({ srv } = await boot(PORT, DIR, testDb.url));
  ok(!!srv, 'server reboots against the same database after the direct backdate');
  const deeRelogin = await post('/api/login', { username: 'ms_dee', pin: 'pass1234' });

  // Before any workout: GET is read-only (never mutates milestonesSeen itself -- see its own
  // comment), so the backdating + reboot alone must not have silently crossed anything -- only
  // the backfill (a no-op here, flag already true) or a live creditFinish call do that.
  const before = await get('/api/me/milestones', deeRelogin.token);
  ok(before.monthsSinceCreated === 4, `monthsSinceCreated reads 4 after the reboot picks up the backdated row (got ${before.monthsSinceCreated})`);
  ok(!before.milestonesSeen.includes('anniv_3mo'), `...but reading GET /api/me/milestones does not itself cross anything (got ${JSON.stringify(before.milestonesSeen)})`);

  // One single workout -- far below any workout-count threshold -- still runs
  // markNewlyCrossedMilestones, which checks BOTH milestone types every call.
  await creditOneWorkout(deeRelogin.token, 'Dee Workout 1');
  const after = await get('/api/me/milestones', deeRelogin.token);
  ok(after.milestonesSeen.includes('anniv_3mo'), `anniv_3mo crossed live, by the one workout (got ${JSON.stringify(after.milestonesSeen)})`);
  ok(!after.milestonesSeen.includes('anniv_6mo'), `anniv_6mo NOT crossed yet -- only 4 months in (got ${JSON.stringify(after.milestonesSeen)})`);
  ok(!after.milestonesSeen.includes('workouts_10'), `workouts_10 NOT crossed -- only 1 workout (got ${JSON.stringify(after.milestonesSeen)})`);

  const n = await get('/api/notifications', deeRelogin.token);
  const fired = milestoneNotifs(n.history);
  ok(fired.length === 1, `one "Milestone reached" notification for Dee (got ${fired.length})`);
  ok(fired[0] && /3 months/.test(fired[0].body), `body names the 3-month anniversary (got ${fired[0] && fired[0].body})`);
}

console.log('\na REAL save(DB) failure during /lock correctly reverts milestonesSeen (the cold-review fix, not just disclosed) -- same breakTable/fixTable technique as test/phase1-mutate-before-save-regression.mjs, a genuine Postgres failure, not a mock');
{
  const frank = await reg('ms_frank', 'pass1234', 'Frank');
  for (let i = 0; i < 9; i++) await creditOneWorkout(frank.token, 'Frank Workout ' + i);
  const before = await get('/api/me/milestones', frank.token);
  ok(before.totalWorkouts === 9 && !before.milestonesSeen.includes('workouts_10'), `sanity: 9 workouts, not yet crossed (got ${JSON.stringify(before)})`);

  const raw = new PgConnection(parseConnString(testDb.url));
  const breakTable = name => raw.query(`ALTER TABLE ${name} RENAME TO ${name}_broken_for_test`);
  const fixTable = name => raw.query(`ALTER TABLE ${name}_broken_for_test RENAME TO ${name}`);

  const s = await post('/api/sessions', { name: 'Frank Workout 9', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Bench Press' }], inviteUsernames: [], visibility: 'private' }, frank.token);
  await post(`/api/sessions/${s.id}/log`, { exerciseId: s.exercises[0].id, weight: 135, reps: 8 }, frank.token);

  await breakTable('users');
  const failedLock = await fetch(B + `/api/sessions/${s.id}/lock`, { method: 'POST', headers: { ...J, Authorization: 'Bearer ' + frank.token }, body: JSON.stringify({}) });
  ok(failedLock.status === 500, `a real save(DB) failure while the users table is broken returns 500, not a silent success (got ${failedLock.status})`);
  await fixTable('users');
  raw.close();

  // The whole point of the fix: NOT just "no notification on a failed save" (every passing
  // assertion above already implies that, since they all rely on a successful save) -- specifically
  // that milestonesSeen itself was reverted, not left silently advanced in memory to be persisted
  // for real by some later, UNRELATED successful save. Confirmed on a plain GET -- no further
  // mutation of any kind -- so this is reading exactly what the failed /lock left behind.
  const afterFailedSave = await get('/api/me/milestones', frank.token);
  ok(afterFailedSave.totalWorkouts === 9, `creditFinish itself also correctly never landed -- totalWorkouts still 9, not 10 (got ${afterFailedSave.totalWorkouts})`);
  ok(!afterFailedSave.milestonesSeen.includes('workouts_10'), `workouts_10 correctly REVERTED, not left silently advanced in memory (got ${JSON.stringify(afterFailedSave.milestonesSeen)})`);
  const afterFailedN = await get('/api/notifications', frank.token);
  ok(milestoneNotifs(afterFailedN.history).length === 0, `and correctly never notified for it (got ${milestoneNotifs(afterFailedN.history).length})`);

  // With the table fixed, the SAME /lock (idempotent -- creditFinish never ran the first time, so
  // this isn't a double-credit) now succeeds normally, proving the table break/fix didn't leave
  // anything else broken behind it.
  await post(`/api/sessions/${s.id}/lock`, {}, frank.token);
  const afterRealSave = await get('/api/me/milestones', frank.token);
  ok(afterRealSave.totalWorkouts === 10, `with the table fixed, the real /lock now credits the 10th workout (got ${afterRealSave.totalWorkouts})`);
  ok(afterRealSave.milestonesSeen.includes('workouts_10'), `...and workouts_10 crosses for real this time (got ${JSON.stringify(afterRealSave.milestonesSeen)})`);
  const afterRealN = await get('/api/notifications', frank.token);
  ok(milestoneNotifs(afterRealN.history).length === 1, `...with exactly one real notification, not a leftover/duplicate from the failed attempt (got ${milestoneNotifs(afterRealN.history).length})`);
}

console.log('\nauth is required on GET /api/me/milestones');
{
  const noAuth = await fetch(B + '/api/me/milestones');
  ok(noAuth.status === 401, `no token is rejected (got ${noAuth.status})`);
}

await cleanup();

// --- Part 2: the backfill-no-spam guarantee. Needs its own fresh server/DB: this has to be the
// database's one and only boot, so migrateMilestonesBackfillV1 runs for the very first time
// against data that was never touched through the live app at all -- seeded directly via
// Postgres, the same "bypass the app entirely" technique boot-shape.mjs uses to simulate a
// pre-existing/hand-edited row. Registering this user over HTTP first and crediting workouts for
// them the normal way is exactly what this test must NOT do: that would cross the milestones
// LIVE, on an already-backfilled server, which is the thing Part 1 already covers -- the whole
// point here is proving the FIRST-EVER boot of a database that already contains old data doesn't
// blast out retroactive notifications for it. ---

console.log('\nbackfill-no-spam: a user who already had the data to cross milestones before this feature ever ran a single boot gets silently seeded, with ZERO notifications');
{
  const testDb2 = await freshTestDb('milestonesbackfill');
  const DIR2 = mkdtempSync(join(tmpdir(), 'milestonesbackfill-'));

  const dbmod = (await import('../db.js')).default;
  process.env.DATABASE_URL = testDb2.url;
  await dbmod.ensureSchema();
  dbmod.close();

  const userId = 'preexisting_u1';
  const fiveMonthsAgo = new Date(); fiveMonthsAgo.setUTCMonth(fiveMonthsAgo.getUTCMonth() - 5);
  const user = {
    id: userId, username: 'preexisting', displayName: 'Pre-Existing',
    createdAt: fiveMonthsAgo.toISOString(), units: 'lb', pinHash: 'x', pinSalt: 'y',
    // Deliberately NOT set -- milestonesSeen is absent here, exactly the shape a real account
    // created before this feature shipped would have (ensureMilestonesSeen lazy-inits it).
  };
  // 12 separate completed sessions, each with exactly one s.history row crediting this user --
  // clears workouts_10 (12 >= 10) but not workouts_50. Minimal shape: totalWorkoutsFor only reads
  // s.history, nothing else about these rows matters for this test.
  const sessions = {};
  for (let i = 0; i < 12; i++) {
    sessions['s' + i] = {
      id: 's' + i, creatorId: userId, scheduledAt: fiveMonthsAgo.toISOString(), status: 'locked',
      visibility: 'private', name: 'Old Session ' + i, participants: [userId],
      exercises: [{ id: 'e1', name: 'Bench Press' }], history: [{ userId, at: fiveMonthsAgo.toISOString() }],
    };
  }

  const pg = new PgConnection(parseConnString(testDb2.url));
  await pg.query('INSERT INTO users (id, username_lower, data) VALUES ($1, $2, $3::jsonb)', [user.id, normUser(user.username), JSON.stringify(user)]);
  for (const [id, s] of Object.entries(sessions)) {
    await pg.query('INSERT INTO sessions (id, data) VALUES ($1, $2::jsonb)', [id, JSON.stringify(s)]);
  }
  pg.close();

  const PORT2 = 4993;
  const { srv: srv2 } = await boot(PORT2, DIR2, testDb2.url);
  ok(!!srv2, 'server boots against the pre-seeded database');

  const pg2 = new PgConnection(parseConnString(testDb2.url));
  const userRow = await pg2.query('SELECT data FROM users WHERE id = $1', [userId]);
  const seenAfterBoot = JSON.parse(userRow.rows[0].data).milestonesSeen || [];
  ok(seenAfterBoot.includes('workouts_10'), `workouts_10 silently backfilled on first boot (got ${JSON.stringify(seenAfterBoot)})`);
  ok(seenAfterBoot.includes('anniv_3mo'), `anniv_3mo silently backfilled (5 months old) (got ${JSON.stringify(seenAfterBoot)})`);
  ok(!seenAfterBoot.includes('anniv_6mo'), `anniv_6mo correctly NOT backfilled -- only 5 months (got ${JSON.stringify(seenAfterBoot)})`);
  ok(!seenAfterBoot.includes('workouts_50'), `workouts_50 correctly NOT backfilled -- only 12 workouts (got ${JSON.stringify(seenAfterBoot)})`);

  const notifRows = await pg2.query(`SELECT data FROM notifications WHERE data->>'userId' = $1`, [userId]);
  ok(notifRows.rows.length === 0, `ZERO notifications were created by the backfill -- the exact retroactive-spam failure mode this exists to prevent (got ${notifRows.rows.length}: ${JSON.stringify(notifRows.rows.map(r => JSON.parse(r.data)))})`);

  const flagRow = await pg2.query(`SELECT value FROM app_state WHERE key = 'milestonesBackfillV1'`);
  ok(flagRow.rows.length === 1 && JSON.parse(flagRow.rows[0].value) === true, `milestonesBackfillV1 flag persisted true (got ${JSON.stringify(flagRow.rows)})`);
  pg2.close();

  console.log('  (same already-backfilled server) a brand-new LIVE crossing still notifies normally -- the guard is a one-time catch-up, not a standing kill switch');
  const B2 = `http://localhost:${PORT2}`;
  const post2 = (p, b, tok) => fetch(B2 + p, { method: 'POST', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b) }).then(r => r.json());
  const get2 = (p, tok) => fetch(B2 + p, { headers: tok ? { Authorization: 'Bearer ' + tok } : {} }).then(r => r.json());
  const fresh = await post2('/api/register', { ageConfirmed: true, username: 'ms_fresh', pin: 'pass1234', displayName: 'Fresh' });
  for (let i = 0; i < 10; i++) {
    const s = await post2('/api/sessions', { name: 'Fresh ' + i, scheduledAt: new Date().toISOString(), exercises: [{ name: 'Squat' }], inviteUsernames: [], visibility: 'private' }, fresh.token);
    await post2(`/api/sessions/${s.id}/log`, { exerciseId: s.exercises[0].id, weight: 95, reps: 5 }, fresh.token);
    await post2(`/api/sessions/${s.id}/lock`, {}, fresh.token);
  }
  const freshM = await get2('/api/me/milestones', fresh.token);
  ok(freshM.milestonesSeen.includes('workouts_10'), `the NEW user's live crossing is recorded (got ${JSON.stringify(freshM.milestonesSeen)})`);
  const freshN = await get2('/api/notifications', fresh.token);
  ok(milestoneNotifs(freshN.history).length === 1, `...and DOES notify, proving the backfill guard only ever suppressed the one-time catch-up (got ${milestoneNotifs(freshN.history).length})`);

  try { srv2 && srv2.kill(); } catch {}
  try { rmSync(DIR2, { recursive: true, force: true }); } catch {}
  try { await testDb2.drop(); } catch {}
}

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
