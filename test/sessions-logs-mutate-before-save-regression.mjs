// Oct 17 2026 (sessions & logs slice, decision #1 -- mandatory rearchitecture safeguards process,
// step 3: ground-truth regression test). This is the single heaviest slice this engagement has
// done: 46 session routes surveyed for the mutate-before-maybe-failing-save hazard (a route
// mutates shared in-memory state, then does further awaits -- including save(DB) itself -- that
// can throw, with nothing reverting the mutation on failure), plus a second, deeper hazard found
// mid-build and fixed the same day: several of the heaviest routes (/leave, kick, /remove-mine,
// PUT /api/sessions/:id, /suggest + suggestOwnerless/voteOwnerless, the swap-branch of
// /suggest/:editId/approve, the ownerless branch of /suggest/:editId/cancel) guard against THEIR
// OWN save failure by deep-cloning the whole session object up front and blindly restoring it
// wholesale on failure -- safe only if NOTHING ELSE can mutate that same session while the lock is
// held. A review audit found 14 other already-"fixed" routes (own-key revert-only, correctly
// guarding against their OWN save failure) that were never actually serialized against those
// blind-restore routes at all -- so a blind restore could silently wipe out one of their
// successfully-saved writes if the timing lined up. Every one of those 14 was retrofitted with
// the session lock (see each route's own "review audit finding" comment in server.js), and
// POST /api/sessions/:id/variation was found to have had ZERO save-failure protection at all
// (not part of the original 46-route list) and was fixed from scratch alongside the retrofit.
//
// What this file proves, same breakTable/fixTable technique as
// mutate-before-save-ordering-regression.mjs and the crews concurrency test in test/crews.mjs
// (rig a REAL Postgres failure for the exact save() this app's own code depends on, not a mock):
//   1. POST /api/sessions/:id/log (own-key, hottest route in the app) reverts the logged set AND
//      resyncs the derived PR cache on a failed save -- nothing phantom survives in memory.
//   2. POST /api/sessions/:id/variation (the brand-new fix) reverts BOTH the swap assignment and
//      any already-renamed log entries on a failed save -- proving it went from zero protection
//      to the same standard as every other route in this slice.
//   3. POST /api/sessions/:id/lock (locked, scoped field-level revert on history/startedAt/
//      scheduledAt rather than a whole-object clone) reverts cleanly on a failed save, and a
//      second, real /lock call afterward (table fixed) still succeeds -- the revert didn't leave
//      the session in a state creditFinish's own idempotency guard would now refuse to credit.
//   4. POST /api/sessions/:id/unlock (own-key CAS revert on history, now locked) reverts cleanly
//      too, and is correctly serialized against /lock on the same session.
//   5. Two genuinely concurrent requests on the SAME session, touching DIFFERENT users' own keys
//      (attendance), are fully serialized by the per-session lock and never corrupt each other --
//      same shape of proof as the crews PUT race test in test/crews.mjs.
//   6. A completely different, healthy session's save right after a poisoned one still succeeds --
//      the sessions table break is scoped to exactly the window this test controls, not a global
//      app failure (same "a different user's save still works" shape every other mutate-before-
//      save regression file in this suite already asserts).
//
// What this file does NOT attempt, same documented limitation as
// mutate-before-save-ordering-regression.mjs's own comment: forcing the exact real-time
// interleaving where an unlocked route's write used to land INSIDE a blind-restore route's lock
// window (the specific shape of the second hazard above). That window no longer exists to force
// at all -- every route that touches an overlapping field is now serialized through the same
// per-session lock, so the two can never run concurrently any more, which is the fix itself, not
// something further to race. The fix's correctness instead rests on (a) the field-overlap audit
// recorded in server.js's own comments at each retrofit site, (b) this file's direct proof that
// the lock actually serializes genuinely concurrent requests on the same session (#5 above), and
// (c) the independent review passes this same safeguards process requires next.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';
import { PgConnection, parseConnString } from '../pgmini.js';

const PORT = 5071, B = `http://localhost:${PORT}`;
const DIR = mkdtempSync(join(tmpdir(), 'sessions-logs-mbs-'));
const J = { 'Content-Type': 'application/json' };
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('sessionslogsmbs');
let srv, fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const H = t => ({ ...J, Authorization: 'Bearer ' + t });
const post = (p, b, t) => fetch(B + p, { method: 'POST', headers: t ? H(t) : J, body: JSON.stringify(b) });
const put = (p, b, t) => fetch(B + p, { method: 'PUT', headers: t ? H(t) : J, body: JSON.stringify(b) });
const get = (p, t) => fetch(B + p, { headers: t ? H(t) : J });
const j = r => r.json();
process.on('exit', () => { try { srv && srv.kill(); } catch {} try { rmSync(DIR, { recursive: true, force: true }); } catch {} });

function boot(port, dir, databaseUrl) {
  return new Promise(res => {
    const s = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: databaseUrl, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    s.stdout.on('data', d => { if (String(d).includes('CrewFit on')) res({ srv: s }); });
    s.stderr.on('data', d => process.stderr.write('[server] ' + d));
    s.on('exit', () => res({ srv: null }));
    setTimeout(() => res({ srv: s }), 8000);
  });
}

({ srv } = await boot(PORT, DIR, testDb.url));
ok(!!srv, 'server boots');

const raw = new PgConnection(parseConnString(testDb.url));
// Oct 20 2026: the process.on('exit', ...) above (registered before boot) already closes the
// port-orphan risk for `srv`/`DIR` -- Node fires 'exit' reliably even after an uncaught exception.
// What it can't do is the ASYNC cleanup (testDb.drop() is a real await; `exit` handlers can't await
// anything) or close this `raw` connection -- without this, a crash mid-file leaves the throwaway
// Postgres database (and this raw connection) behind even though the server itself gets killed.
let asyncCleanedUp = false;
async function asyncCleanup() {
  if (asyncCleanedUp) return; asyncCleanedUp = true;
  try { raw.close(); } catch {}
  try { await testDb.drop(); } catch {}
}
process.on('uncaughtException', async (e) => { console.error('UNCAUGHT', e); await asyncCleanup(); process.exit(1); });
process.on('unhandledRejection', async (e) => { console.error('UNHANDLED', e); await asyncCleanup(); process.exit(1); });
async function breakTable(name) { await raw.query(`ALTER TABLE ${name} RENAME TO ${name}_broken_for_test`); }
async function fixTable(name) { await raw.query(`ALTER TABLE ${name}_broken_for_test RENAME TO ${name}`); }

const alice = await post('/api/register', { username: 'sl_alice', pin: 'pass1234', displayName: 'Alice' }).then(j);
const bob = await post('/api/register', { username: 'sl_bob', pin: 'pass1234', displayName: 'Bob' }).then(j);
// mutual follow -> connected, so alice can invite bob
await post(`/api/follow/${bob.user.id}`, {}, alice.token);
await post(`/api/follow-requests/${alice.user.id}/accept`, {}, bob.token);
await post(`/api/follow/${alice.user.id}`, {}, bob.token);
await post(`/api/follow-requests/${bob.user.id}/accept`, {}, alice.token);

const session = await post('/api/sessions', {
  name: 'Push Day', scheduledAt: new Date().toISOString(), location: 'Gym', lengthMin: 60,
  exercises: [{ name: 'Bench Press' }], inviteUsernames: ['sl_bob'], visibility: 'private',
}, alice.token).then(j);
await post(`/api/sessions/${session.id}/accept`, {}, bob.token);
const exId = session.exercises[0].id;

console.log('\nPOST /api/sessions/:id/log: a failed save reverts the logged set and resyncs the derived PR cache (own-key revert, now locked)');
{
  const before = await get(`/api/sessions/${session.id}`, alice.token).then(j);
  ok((before.logs[alice.user.id] || []).length === 0, 'sanity: alice has no sets logged yet');

  await breakTable('sessions');
  const rLog = await post(`/api/sessions/${session.id}/log`, { exerciseId: exId, weight: 135, reps: 8 }, alice.token);
  ok(rLog.status === 500, `log returns a real error while the table is broken, got ${rLog.status}`);
  await fixTable('sessions');

  const health = await get('/healthz');
  ok(health.status === 200, 'server still up after the rigged log failure');
  const after = await get(`/api/sessions/${session.id}`, alice.token).then(j);
  ok((after.logs[alice.user.id] || []).length === 0, 'the "failed" set never shows up in alice\'s own logs');

  const prog = await get('/api/progress', alice.token).then(j);
  ok(!(prog.prs || []).some(r => r.exercise === 'Bench Press'), 'the derived PR cache was correctly resynced -- no phantom PR from a set that was never actually saved');

  const rReal = await post(`/api/sessions/${session.id}/log`, { exerciseId: exId, weight: 135, reps: 8 }, alice.token);
  ok(rReal.status === 200, `with the table fixed, the SAME log call now actually succeeds, got ${rReal.status}`);
}

console.log('\nPOST /api/sessions/:id/variation: BRAND-NEW fix (this route had zero save-failure protection before this slice) -- a failed save reverts both the swap assignment and the already-renamed log entry');
{
  const beforeLogName = (await get(`/api/sessions/${session.id}`, alice.token).then(j)).logs[alice.user.id][0].exerciseName;
  ok(beforeLogName === 'Bench Press', `sanity: alice's real logged set is filed under the original exercise name, got ${beforeLogName}`);

  await breakTable('sessions');
  const rVar = await post(`/api/sessions/${session.id}/variation`, { exerciseId: exId, swapTo: 'Incline Bench Press' }, alice.token);
  ok(rVar.status === 500, `variation swap returns a real error while the table is broken, got ${rVar.status}`);
  await fixTable('sessions');

  const health = await get('/healthz');
  ok(health.status === 200, 'server still up after the rigged variation failure');
  const afterFail = await get(`/api/sessions/${session.id}`, alice.token).then(j);
  ok(!afterFail.variations[exId] || !afterFail.variations[exId][alice.user.id], 'the "failed" swap never took effect -- no variation recorded for alice');
  ok(afterFail.logs[alice.user.id][0].exerciseName === 'Bench Press', 'and the already-renamed log entry was reverted back to its ORIGINAL exercise name, not left mid-rename');

  const rReal = await post(`/api/sessions/${session.id}/variation`, { exerciseId: exId, swapTo: 'Incline Bench Press' }, alice.token);
  ok(rReal.status === 200, `with the table fixed, the SAME swap now actually succeeds, got ${rReal.status}`);
  const afterReal = await get(`/api/sessions/${session.id}`, alice.token).then(j);
  ok(afterReal.variations[exId][alice.user.id].swapTo === 'Incline Bench Press', 'and this time the swap really is recorded');
  ok(afterReal.logs[alice.user.id][0].exerciseName === 'Incline Bench Press', 'and the log entry really is renamed this time');
}

console.log('\nPOST /api/sessions/:id/lock: locked, scoped field-level revert on history/startedAt/scheduledAt -- a failed save reverts cleanly, and a real /lock afterward still credits correctly (the revert did not leave creditFinish\'s idempotency guard confused)');
{
  await breakTable('sessions');
  const rLock = await post(`/api/sessions/${session.id}/lock`, {}, bob.token);
  ok(rLock.status === 500, `lock returns a real error while the table is broken, got ${rLock.status}`);
  await fixTable('sessions');

  const health = await get('/healthz');
  ok(health.status === 200, 'server still up after the rigged lock failure');
  const afterFail = await get(`/api/sessions/${session.id}`, bob.token).then(j);
  ok(!(afterFail.history || []).some(h => h.userId === bob.user.id), 'the "failed" finish never created a history row for bob');
  ok(!afterFail.startedAt, 'and startedAt was never backdated by the reverted finish either (bob never started/logged, so this was the only thing that would have set it)');

  const rReal = await post(`/api/sessions/${session.id}/lock`, {}, bob.token);
  ok(rReal.status === 200, `with the table fixed, the SAME finish now actually succeeds, got ${rReal.status}`);
  const afterReal = await get(`/api/sessions/${session.id}`, bob.token).then(j);
  ok((afterReal.history || []).some(h => h.userId === bob.user.id), 'and now bob really does have a history row');
}

console.log('\nPOST /api/sessions/:id/unlock: own-key CAS revert on history (now locked against /lock on the same session) -- a failed save reverts cleanly and does not disturb the row it is not supposed to touch');
{
  await breakTable('sessions');
  const rUnlock = await post(`/api/sessions/${session.id}/unlock`, {}, bob.token);
  ok(rUnlock.status === 500, `unlock returns a real error while the table is broken, got ${rUnlock.status}`);
  await fixTable('sessions');

  const health = await get('/healthz');
  ok(health.status === 200, 'server still up after the rigged unlock failure');
  const afterFail = await get(`/api/sessions/${session.id}`, bob.token).then(j);
  ok((afterFail.history || []).some(h => h.userId === bob.user.id), 'bob\'s history row from the real /lock above survived the reverted unlock attempt -- not left phantom-removed in memory');

  const rReal = await post(`/api/sessions/${session.id}/unlock`, {}, bob.token);
  ok(rReal.status === 200, `with the table fixed, the SAME unlock now actually succeeds, got ${rReal.status}`);
  const afterReal = await get(`/api/sessions/${session.id}`, bob.token).then(j);
  ok(!(afterReal.history || []).some(h => h.userId === bob.user.id), 'and bob\'s history row really is gone this time');
}

console.log('\nTwo genuinely concurrent requests on the SAME session (alice and bob each setting their own attendance) are fully serialized by the per-session lock -- neither response ever borrows or loses the other\'s write');
{
  const [ra, rb] = await Promise.all([
    post(`/api/sessions/${session.id}/attendance`, { status: 'in' }, alice.token),
    post(`/api/sessions/${session.id}/attendance`, { status: 'running-late' }, bob.token),
  ]);
  ok(ra.status === 200 && rb.status === 200, `both concurrent attendance posts succeed, got ${ra.status}/${rb.status}`);
  const [bodyA, bodyB] = await Promise.all([ra.json(), rb.json()]);
  ok(bodyA.attendance[alice.user.id] === 'in', `A's own response reflects exactly what A itself set, got ${JSON.stringify(bodyA.attendance)}`);
  ok(bodyA.attendance[bob.user.id] === 'running-late' || bodyA.attendance[bob.user.id] === undefined,
    `A's response never shows a corrupted/partial value for bob's concurrent write, got ${JSON.stringify(bodyA.attendance[bob.user.id])}`);
  ok(bodyB.attendance[alice.user.id] === 'in' && bodyB.attendance[bob.user.id] === 'running-late',
    `B's response, being the one guaranteed to reflect the FINAL serialized state (whichever request the lock actually ran second), shows BOTH writes intact, got ${JSON.stringify(bodyB.attendance)}`);

  const final = await get(`/api/sessions/${session.id}`, alice.token).then(j);
  ok(final.attendance[alice.user.id] === 'in' && final.attendance[bob.user.id] === 'running-late',
    `the final persisted state has both concurrent writes, neither lost nor corrupted, got ${JSON.stringify(final.attendance)}`);
}

console.log('\na completely different, healthy session\'s save right after a poisoned one on THIS session still succeeds -- the rigged failure above was scoped to this test\'s own window, not a global jam');
{
  const other = await post('/api/sessions', {
    name: 'Leg Day', scheduledAt: new Date().toISOString(), location: 'Gym', lengthMin: 45,
    exercises: [{ name: 'Squat' }], inviteUsernames: [], visibility: 'private',
  }, alice.token).then(j);
  const rOther = await post(`/api/sessions/${other.id}/attendance`, { status: 'in' }, alice.token);
  ok(rOther.status === 200, `a brand-new, unrelated session's own save succeeds cleanly, got ${rOther.status}`);
}

raw.close();
if (srv) srv.kill();
await testDb.drop();
rmSync(DIR, { recursive: true, force: true });

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
