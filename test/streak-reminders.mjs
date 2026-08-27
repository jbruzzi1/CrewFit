// Jeff, Aug 21: "you're about to lose your streak" push reminder — first of the "what would you
// add next" list. GET /api/me/streak-status is the whole claim this feature makes, boiled down to
// one testable question per user: does this person still need to train today to keep their streak?
// CLAUDE.md is explicit that a claim about someone's own history has to be right every time (v163:
// "One session logged" on a lift Jeff had never touched), so this is tested harder than most
// features that size — including the exact edge the threshold exists to prevent (nagging a
// brand-new user about a "streak" that's really just one day) and the full lifecycle of actually
// being at risk and then training to clear it.
//
// `usersAtRiskOfLosingStreak()` (the function the real background timer calls) is NOT hit directly
// by an HTTP route on purpose — a batch "send everyone their reminder now" endpoint would be a way
// to spam every user's push notifications on demand, which is not a risk worth taking for a test's
// convenience. It shares the exact same per-user logic as streakStatusFor()/this endpoint (see
// server.js), so this file verifies that shared logic thoroughly instead. What is NOT verified here:
// the setInterval scheduler itself (waiting real hours for it to fire isn't practical in a test) and
// actual push delivery (notify() silently no-ops for any test user, since none of them subscribe to
// push — same as how no other route's notify() call is push-tested in this suite).
//
// Ported to the Postgres-backed test harness (Aug 2026 data-layer migration) — the original version
// predates that migration and hand-edited data.json directly; backdating a history row now goes
// through a direct UPDATE on the sessions table's jsonb column instead (see withSessionsDb below),
// same stop-the-server / mutate / reboot shape progression.mjs already established for this. Nothing
// about the streak-status assertions themselves changed.
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
const testDb = await freshTestDb('streak');

function boot(port, dir) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; srv.stdout.on('data', d => { out += d; if (String(d).includes('CrewFit on')) res({ srv, out }); });
    srv.on('exit', () => res({ srv: null, out }));
    setTimeout(() => res({ srv, out }), 15000);
  });
}
async function killAndWait(srv) {
  return new Promise(res => { srv.once('exit', res); srv.kill(); setTimeout(res, 2000); });
}
// Reads every session row, hands the parsed rows to `mutator` to edit in place (or push a new
// history row onto), writes every row back. Direct-Postgres equivalent of the old hand-edit of
// data.json — the server process must be stopped first and rebooted after, same as before, since
// it holds everything in memory and only re-reads from Postgres at boot.
async function withSessionsDb(mutator) {
  const pg = new PgConnection(parseConnString(testDb.url));
  const r = await pg.query('SELECT id, data FROM sessions');
  const rows = r.rows.map(row => ({ id: row.id, data: JSON.parse(row.data) }));
  await mutator(rows);
  for (const row of rows) await pg.query('UPDATE sessions SET data = $1::jsonb WHERE id = $2', [JSON.stringify(row.data), row.id]);
  pg.close();
}

const DIR = mkdtempSync(join(tmpdir(), 'streak-'));
const PORT = 4995, B = `http://localhost:${PORT}`;
let { srv } = await boot(PORT, DIR);
ok(!!srv, 'server boots');

const post = (p, b, tok) => fetch(B + p, { method: 'POST', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b) }).then(r => r.json());
const get = (p, tok) => fetch(B + p, { headers: tok ? { Authorization: 'Bearer ' + tok } : {} }).then(r => r.json());
const reg = (username, pin, displayName) => post('/api/register', { username, pin, displayName });

console.log('\na brand-new user with no history at all is never "at risk" — there is nothing to protect yet');
{
  const dana = await reg('streak_dana', 'pass1234', 'Dana');
  const status = await get('/api/me/streak-status', dana.token);
  ok(status.streak === 0, `streak is 0 (got ${status.streak})`);
  ok(status.trainedToday === false, 'trainedToday is false');
  ok(status.atRisk === false, 'atRisk is false — nobody gets nagged on day zero');
}

console.log('\na user who trained TODAY is safe, regardless of streak length');
{
  const alice = await reg('streak_alice', 'pass1234', 'Alice');
  const s1 = await post('/api/sessions', {
    name: 'Push Day', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Bench Press' }],
    inviteUsernames: [], visibility: 'private',
  }, alice.token);
  await post('/api/sessions/' + s1.id + '/log', { exerciseId: s1.exercises[0].id, weight: 135, reps: 8 }, alice.token);
  await post('/api/sessions/' + s1.id + '/lock', {}, alice.token);

  const status = await get('/api/me/streak-status', alice.token);
  ok(status.streak === 1, `streak reflects today's session (got ${status.streak})`);
  ok(status.trainedToday === true, 'trainedToday is true');
  ok(status.atRisk === false, 'atRisk is false — already safe today, no reason to nag');
}

console.log('\na user with exactly a 1-day streak from YESTERDAY (not today) is still below the threshold — the whole point of >=2 is not nagging over one day');
{
  const eli = await reg('streak_eli', 'pass1234', 'Eli');
  const s2 = await post('/api/sessions', {
    name: 'Leg Day', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Back Squat' }],
    inviteUsernames: [], visibility: 'private',
  }, eli.token);
  await post('/api/sessions/' + s2.id + '/log', { exerciseId: s2.exercises[0].id, weight: 185, reps: 5 }, eli.token);
  await post('/api/sessions/' + s2.id + '/lock', {}, eli.token);

  // backdate that one history row to yesterday — the signing secret lives in its own file in
  // DATA_DIR (loadOrCreateSecret) and survives the restart, so Eli's existing token is still
  // valid afterward — no need to re-login.
  await killAndWait(srv);
  const yesterday = new Date(Date.now() - 1 * 86400000).toISOString().slice(0, 10);
  await withSessionsDb(async (rows) => {
    for (const row of rows) for (const h of (row.data.history || [])) if (h.userId === eli.user.id) h.date = yesterday;
  });
  ({ srv } = await boot(PORT, DIR));
  ok(!!srv, 'server reboots cleanly after the hand-edit');

  const status = await get('/api/me/streak-status', eli.token);
  ok(status.streak === 1, `streak still counts yesterday via the grace window (got ${status.streak})`);
  ok(status.trainedToday === false, 'trainedToday is false');
  ok(status.atRisk === false, `atRisk is false even though he has not trained today — 1 day is not yet a streak worth protecting (${JSON.stringify(status)})`);
}

console.log('\na GENUINE multi-day streak, last trained yesterday, not yet today: atRisk is true — this is the exact person the reminder exists for');
let carol;
{
  carol = await reg('streak_carol', 'pass1234', 'Carol');
  const s3 = await post('/api/sessions', {
    name: 'Pull Day', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Deadlift' }],
    inviteUsernames: [], visibility: 'private',
  }, carol.token);
  await post('/api/sessions/' + s3.id + '/log', { exerciseId: s3.exercises[0].id, weight: 225, reps: 5 }, carol.token);
  await post('/api/sessions/' + s3.id + '/lock', {}, carol.token);

  await killAndWait(srv);
  const twoAgo = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
  const oneAgo = new Date(Date.now() - 1 * 86400000).toISOString().slice(0, 10);
  await withSessionsDb(async (rows) => {
    for (const row of rows) {
      for (const h of (row.data.history || [])) if (h.userId === carol.user.id) h.date = oneAgo;
      // a genuine second training day, two days ago — same shape creditFinish would have written
      if (row.id === s3.id) row.data.history.push({ userId: carol.user.id, date: twoAgo, muscleGroups: ['back'], exercises: ['Deadlift'] });
    }
  });
  ({ srv } = await boot(PORT, DIR));
  ok(!!srv, 'server reboots cleanly after the hand-edit');

  const status = await get('/api/me/streak-status', carol.token);
  ok(status.streak === 2, `two consecutive days counted (got ${status.streak})`);
  ok(status.trainedToday === false, 'trainedToday is false — the real, honest reason to remind her');
  ok(status.atRisk === true, 'atRisk is true — this is exactly the person the reminder is for');
}

console.log('\nthat SAME at-risk user, after actually training today: atRisk clears — the reminder would not fire twice for someone who already acted on it');
{
  const s4 = await post('/api/sessions', {
    name: 'Pull Day', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Deadlift' }],
    inviteUsernames: [], visibility: 'private',
  }, carol.token);
  await post('/api/sessions/' + s4.id + '/log', { exerciseId: s4.exercises[0].id, weight: 235, reps: 5 }, carol.token);
  await post('/api/sessions/' + s4.id + '/lock', {}, carol.token);

  const status = await get('/api/me/streak-status', carol.token);
  ok(status.streak === 3, `the streak extended to 3 (got ${status.streak})`);
  ok(status.trainedToday === true, 'trainedToday is now true');
  ok(status.atRisk === false, 'atRisk clears the moment the real reason for it (not training today) stops being true');
}

console.log('\na streak that already broke (a real gap of 2+ days) is 0, not "at risk" — nothing left worth interrupting someone over');
{
  const finn = await reg('streak_finn', 'pass1234', 'Finn');
  const s5 = await post('/api/sessions', {
    name: 'Arm Day', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Bicep Curl' }],
    inviteUsernames: [], visibility: 'private',
  }, finn.token);
  await post('/api/sessions/' + s5.id + '/log', { exerciseId: s5.exercises[0].id, weight: 30, reps: 12 }, finn.token);
  await post('/api/sessions/' + s5.id + '/lock', {}, finn.token);

  await killAndWait(srv);
  const fourAgo = new Date(Date.now() - 4 * 86400000).toISOString().slice(0, 10);
  await withSessionsDb(async (rows) => {
    for (const row of rows) for (const h of (row.data.history || [])) if (h.userId === finn.user.id) h.date = fourAgo;
  });
  ({ srv } = await boot(PORT, DIR));
  ok(!!srv, 'server reboots cleanly after the hand-edit');

  const status = await get('/api/me/streak-status', finn.token);
  ok(status.streak === 0, `the grace window only covers today/yesterday, so a 4-day-old session gives 0, not a stale streak (got ${status.streak})`);
  ok(status.atRisk === false, 'atRisk is false — there is nothing left to protect, so no false "keep it going" claim gets made');
}

console.log('\nauth is still required — this is per-user data, not open to a stranger');
{
  const noAuth = await fetch(B + '/api/me/streak-status');
  ok(noAuth.status === 401, `no token is rejected (got ${noAuth.status})`);
}

try { srv && srv.kill(); } catch {}
rmSync(DIR, { recursive: true, force: true });
await testDb.drop();

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
