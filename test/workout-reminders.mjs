// "You have a workout scheduled today" push reminder (Task #155) -- Jeff floated this alongside
// the Live/Upcoming work ("maybe scheduled notifications letting you know you have a workout
// upcoming today"), deliberately deferred at the time. First drafted, cold-reviewed, and applied
// once to Jeff's Mac on an old branch (feat/workout-today-reminder) that was never pushed/merged
// and went stale behind ~15 later merges; ported forward onto current main rather than rebasing a
// heavily-conflicting branch. Same two-layer shape as the existing streak-loss reminder
// (test/streak-reminders.mjs): GET /api/me/workout-reminder-status is the per-user, HTTP-testable
// question the real background timer's usersWithWorkoutToday() answers in batch for everyone --
// that batch function is NOT exposed via HTTP on purpose (a "send everyone's reminder now"
// endpoint would be a spam vector), so this file verifies the shared per-user logic thoroughly
// instead. Not verified here, same as streak-reminders.mjs: the setInterval scheduler itself, and
// actual push delivery (notify() silently no-ops for test users with no subscription).
//
// Covers: no session today -> false; a session scheduled today, not yet finished -> true, names
// the session; two sessions today in different scheduledAt formats -> the true chronological
// earliest wins, not raw string comparison; the SAME session after this user finishes it -> false
// (does not still nag); a second participant in the same session who has NOT finished it -> still
// true for them independently; a session scheduled YESTERDAY or TOMORROW does not count as
// "today"; an invited (not-yet-joined) non-participant does not get flagged; and the notify-prefs
// route's generalized {streakReminders, workoutReminders} shape (each independently optional, at
// least one required).
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const J = { 'Content-Type': 'application/json' };
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('workoutrem');

function boot(port, dir) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; srv.stdout.on('data', d => { out += d; if (String(d).includes('CrewFit on')) res({ srv, out }); });
    srv.on('exit', () => res({ srv: null, out }));
    setTimeout(() => res({ srv, out }), 15000);
  });
}

const DIR = mkdtempSync(join(tmpdir(), 'workoutrem-'));
const PORT = 4995, B = `http://localhost:${PORT}`;
const { srv } = await boot(PORT, DIR);
ok(!!srv, 'server boots');

const post = (p, b, tok) => fetch(B + p, { method: 'POST', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b) }).then(r => r.json());
const get = (p, tok) => fetch(B + p, { headers: tok ? { Authorization: 'Bearer ' + tok } : {} }).then(r => r.json());
const reg = (username, pin, displayName) => post('/api/register', { username, pin, displayName });

function isoDaysFromNow(n) {
  const d = new Date(); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString();
}

console.log('\na user with no sessions at all has no reminder today');
{
  const dana = await reg('wr_dana', 'pass1234', 'Dana');
  const status = await get('/api/me/workout-reminder-status', dana.token);
  ok(status.hasSessionToday === false, `hasSessionToday is false (got ${JSON.stringify(status)})`);
  ok(status.sessionName === null, `sessionName is null (got ${status.sessionName})`);
}

console.log('\na session scheduled TODAY, not yet finished -> true, names the session');
let alice;
{
  alice = await reg('wr_alice', 'pass1234', 'Alice');
  await post('/api/sessions', {
    name: 'Push Day', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Bench Press' }],
    inviteUsernames: [], visibility: 'private',
  }, alice.token);

  const status = await get('/api/me/workout-reminder-status', alice.token);
  ok(status.hasSessionToday === true, `hasSessionToday is true (got ${JSON.stringify(status)})`);
  ok(status.sessionName === 'Push Day', `names the session (got ${status.sessionName})`);
}

console.log('\ntwo sessions today in DIFFERENT scheduledAt formats -- true chronological earliest wins, not raw string comparison (cold-review catch)');
{
  // scheduledAt is not consistently typed across sessions (ISO string, or epoch seconds/ms --
  // see perfDate's own comment in server.js). A numeric-string epoch always starts with "1..."
  // for anything in this decade, which sorts BELOW any ISO string (which starts with "2026...")
  // under plain raw string comparison -- so a late-today session stored in epoch-seconds format
  // could get picked as "earliest" over an actually-earlier ISO-format session, purely because of
  // string sort order rather than real time. workoutReminderStatusFor must compare perfDate()'s
  // normalized form, not the raw stored value.
  const greta2 = await reg('wr_greta2', 'pass1234', 'Greta Two');
  const now = new Date();
  const lateToday = new Date(now); lateToday.setUTCHours(23, 0, 0, 0);
  const earlyToday = new Date(now); earlyToday.setUTCHours(6, 0, 0, 0);
  const lateEpochSeconds = String(Math.floor(lateToday.getTime() / 1000));
  await post('/api/sessions', { name: 'Late (epoch fmt)', scheduledAt: lateEpochSeconds, exercises: [{ name: 'Bench Press' }], inviteUsernames: [], visibility: 'private' }, greta2.token);
  await post('/api/sessions', { name: 'Early (ISO fmt)', scheduledAt: earlyToday.toISOString(), exercises: [{ name: 'Bench Press' }], inviteUsernames: [], visibility: 'private' }, greta2.token);

  const status = await get('/api/me/workout-reminder-status', greta2.token);
  ok(status.hasSessionToday === true, `has a session today (got ${JSON.stringify(status)})`);
  ok(status.sessionName === 'Early (ISO fmt)', `the TRUE chronological earliest wins, not whichever format's raw string happens to sort first (got ${status.sessionName})`);
}

console.log('\nthat SAME user, after finishing it -> false, does not still nag someone who already trained');
{
  const sessions = await get('/api/sessions', alice.token);
  const s = sessions.find(x => x.name === 'Push Day');
  await post(`/api/sessions/${s.id}/log`, { exerciseId: s.exercises[0].id, weight: 135, reps: 8 }, alice.token);
  await post(`/api/sessions/${s.id}/lock`, {}, alice.token);

  const status = await get('/api/me/workout-reminder-status', alice.token);
  ok(status.hasSessionToday === false, `clears once finished (got ${JSON.stringify(status)})`);
}

console.log('\na second participant in the SAME session who has NOT finished it is still flagged independently');
{
  const bob = await reg('wr_bob', 'pass1234', 'Bob');
  await post('/api/follow/' + bob.user.id, {}, alice.token);
  await post('/api/follow-requests/' + alice.user.id + '/accept', {}, bob.token);
  await post('/api/follow/' + alice.user.id, {}, bob.token);
  await post('/api/follow-requests/' + bob.user.id + '/accept', {}, alice.token);
  const s2 = await post('/api/sessions', {
    name: 'Team Push', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Bench Press' }],
    inviteUsernames: ['wr_bob'], visibility: 'public',
  }, alice.token);
  const invited = await get('/api/sessions', bob.token);
  const mine = invited.find(x => x.name === 'Team Push');
  await post(`/api/sessions/${mine.id}/accept`, {}, bob.token);

  const aliceStatus = await get('/api/me/workout-reminder-status', alice.token);
  const bobStatus = await get('/api/me/workout-reminder-status', bob.token);
  ok(aliceStatus.hasSessionToday === true, `alice (has not finished Team Push) is flagged (got ${JSON.stringify(aliceStatus)})`);
  ok(bobStatus.hasSessionToday === true, `bob (joined, has not finished it either) is independently flagged (got ${JSON.stringify(bobStatus)})`);

  // bob finishes his own copy; alice's own status must be untouched by bob's action
  await post(`/api/sessions/${mine.id}/log`, { exerciseId: mine.exercises[0].id, weight: 95, reps: 10 }, bob.token);
  await post(`/api/sessions/${mine.id}/lock`, {}, bob.token);
  const bobAfter = await get('/api/me/workout-reminder-status', bob.token);
  const aliceAfter = await get('/api/me/workout-reminder-status', alice.token);
  ok(bobAfter.hasSessionToday === false, `bob clears after finishing his own copy (got ${JSON.stringify(bobAfter)})`);
  ok(aliceAfter.hasSessionToday === true, `alice is UNCHANGED by bob finishing his own copy -- still her own unfinished session (got ${JSON.stringify(aliceAfter)})`);
}

console.log('\na session scheduled YESTERDAY or TOMORROW does not count as "today"');
{
  const eli = await reg('wr_eli', 'pass1234', 'Eli');
  await post('/api/sessions', {
    name: 'Old Session', scheduledAt: isoDaysFromNow(-1), exercises: [{ name: 'Deadlift' }],
    inviteUsernames: [], visibility: 'private',
  }, eli.token);
  await post('/api/sessions', {
    name: 'Future Session', scheduledAt: isoDaysFromNow(1), exercises: [{ name: 'Deadlift' }],
    inviteUsernames: [], visibility: 'private',
  }, eli.token);

  const status = await get('/api/me/workout-reminder-status', eli.token);
  ok(status.hasSessionToday === false, `neither yesterday nor tomorrow counts as today (got ${JSON.stringify(status)})`);
}

console.log('\nan invited-but-not-yet-accepted user is not a participant, so not flagged');
{
  const finn = await reg('wr_finn', 'pass1234', 'Finn');
  await post('/api/follow/' + finn.user.id, {}, alice.token);
  await post('/api/follow-requests/' + alice.user.id + '/accept', {}, finn.token);
  await post('/api/follow/' + alice.user.id, {}, finn.token);
  await post('/api/follow-requests/' + finn.user.id + '/accept', {}, alice.token);
  await post('/api/sessions', {
    name: 'Invite Only', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Bench Press' }],
    inviteUsernames: ['wr_finn'], visibility: 'public',
  }, alice.token);

  const status = await get('/api/me/workout-reminder-status', finn.token);
  ok(status.hasSessionToday === false, `an invited-not-joined user is not a participant, not flagged (got ${JSON.stringify(status)})`);
}

console.log('\nauth is still required');
{
  const noAuth = await fetch(B + '/api/me/workout-reminder-status');
  ok(noAuth.status === 401, `no token is rejected (got ${noAuth.status})`);
}

console.log('\nnotify-prefs: streakReminders and workoutReminders are each independently optional; at least one required; an old client sending only streakReminders is unaffected');
{
  const greta = await reg('wr_greta', 'pass1234', 'Greta');
  const onlyStreak = await post('/api/me/notify-prefs', { streakReminders: false }, greta.token);
  ok(onlyStreak.streakReminders === false, `old-shape request still works (got ${JSON.stringify(onlyStreak)})`);
  ok(onlyStreak.workoutReminders === undefined, `workoutReminders is untouched/absent when not sent (got ${JSON.stringify(onlyStreak)})`);

  const onlyWorkout = await post('/api/me/notify-prefs', { workoutReminders: false }, greta.token);
  ok(onlyWorkout.workoutReminders === false, `new field alone works (got ${JSON.stringify(onlyWorkout)})`);
  ok(onlyWorkout.streakReminders === undefined, `streakReminders is untouched/absent when not sent (got ${JSON.stringify(onlyWorkout)})`);

  const both = await post('/api/me/notify-prefs', { streakReminders: true, workoutReminders: true }, greta.token);
  ok(both.streakReminders === true && both.workoutReminders === true, `both together works (got ${JSON.stringify(both)})`);

  const neither = await post('/api/me/notify-prefs', {}, greta.token);
  ok(neither.error !== undefined, `neither field sent is refused (got ${JSON.stringify(neither)})`);

  const badType = await post('/api/me/notify-prefs', { workoutReminders: 'yes' }, greta.token);
  ok(badType.error !== undefined, `a non-boolean workoutReminders is refused (got ${JSON.stringify(badType)})`);

  const profile = await get('/api/profile/me', greta.token);
  ok(profile.notifyWorkoutReminders === true, `GET /api/profile/me reflects the current value (got ${profile.notifyWorkoutReminders})`);
}

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
if (srv) srv.kill();
rmSync(DIR, { recursive: true, force: true });
await testDb.drop();
process.exit(fails ? 1 : 0);
