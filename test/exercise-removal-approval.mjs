// Sep 23 2026 (Jeff, real bug report): "Brian deleted an exercise from the workout and it removed
// it from everyones workout including all of the sets the others had already logged... the owner
// shouldn't just be able to delete workouts others have added sets [to] -- this could be
// accidentally done." Confirmed with Jeff: removing an exercise now needs a real yes from every
// OTHER participant who has logged sets on it (see PUT /api/sessions/:id's own long comment) --
// not just a one-tap "Save anyway" the creator alone could blow through. One decline cancels the
// whole request; the creator can withdraw a stalled one via /removal/:reqId/cancel. Everything
// else in the same save (renames, reorders, additions, an uncontested removal) still applies
// immediately -- only a removal with a real stake for someone else waits.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const J = { 'Content-Type': 'application/json' };
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('removalapproval');

function boot(port, dir) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    srv.stdout.on('data', d => { if (String(d).includes('CrewFit on')) res(srv); });
    srv.on('exit', () => res(null));
    setTimeout(() => res(null), 15000);
  });
}

const DIR = mkdtempSync(join(tmpdir(), 'removalapproval-'));
const PORT = 4988, B = `http://localhost:${PORT}`;
const srv = await boot(PORT, DIR);
ok(!!srv, 'server boots');

const post = (p, b, tok) => fetch(B + p, { method: 'POST', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b) }).then(r => r.json());
const put = (p, b, tok) => fetch(B + p, { method: 'PUT', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b) }).then(r => r.json());
const get = (p, tok) => fetch(B + p, { headers: tok ? { Authorization: 'Bearer ' + tok } : {} }).then(r => r.json());
const reg = async (username) => { const r = await post('/api/register', { username, pin: 'pass1234', displayName: username }); return { token: r.token, id: r.user.id, user: r.user }; };

async function makeSharedWorkout(hostU, otherU, exNames) {
  const host = await reg(hostU);
  const other = await reg(otherU);
  await post(`/api/follow/${other.id}`, {}, host.token);
  const s = await post('/api/sessions', {
    name: 'Push Day', scheduledAt: new Date().toISOString(), exercises: exNames.map(n => ({ name: n })),
    visibility: 'private', inviteUsernames: [otherU],
  }, host.token);
  await post(`/api/sessions/${s.id}/accept`, {}, other.token);
  return { host, other, s };
}

console.log('\nremoving an exercise nobody else has logged sets on still happens immediately -- no request needed, unchanged from before');
{
  const { host, s } = await makeSharedWorkout('rea_h1', 'rea_o1', ['Bench Press', 'Incline Press']);
  const benchId = s.exercises.find(e => e.name === 'Bench Press').id;
  const inclineId = s.exercises.find(e => e.name === 'Incline Press').id;
  const r = await put(`/api/sessions/${s.id}`, { exercises: [{ id: inclineId, name: 'Incline Press' }] }, host.token);
  ok(!r.exercises.find(e => e.id === benchId), 'Bench Press is genuinely gone right away (got ' + JSON.stringify(r.exercises.map(e => e.name)) + ')');
  ok(!(r.pendingRemovals || []).length, 'no pending removal was created -- nothing was actually at stake');
}

console.log('\nthe real bug: removing an exercise a PARTICIPANT logged sets on does NOT remove it -- it stays, pending their approval');
{
  const { host, other, s } = await makeSharedWorkout('rea_h2', 'rea_o2', ['Bench Press', 'Incline Press']);
  const benchId = s.exercises.find(e => e.name === 'Bench Press').id;
  const inclineId = s.exercises.find(e => e.name === 'Incline Press').id;
  await post(`/api/sessions/${s.id}/log`, { exerciseId: benchId, weight: 135, reps: 8 }, other.token);

  const r = await put(`/api/sessions/${s.id}`, { exercises: [{ id: inclineId, name: 'Incline Press' }] }, host.token);
  ok(!!r.exercises.find(e => e.id === benchId), `Bench Press is STILL in the shared workout, not silently removed (got ${JSON.stringify(r.exercises.map(e => e.name))})`);
  const pr = (r.pendingRemovals || []).find(p => p.exerciseId === benchId);
  ok(!!pr, 'a pending removal request exists');
  ok(pr.status === 'pending', `it reads pending (got ${pr && pr.status})`);
  ok(pr.requiredApprovals.length === 1 && pr.requiredApprovals[0] === other.id, `required approvals is exactly the one participant who logged sets on it (got ${JSON.stringify(pr.requiredApprovals)})`);
  ok(pr.approvals.length === 0, 'nobody has approved yet');

  // From the other participant's own view.
  const otherView = await get(`/api/sessions/${s.id}`, other.token);
  const otherPr = (otherView.pendingRemovals || []).find(p => p.exerciseId === benchId);
  ok(!!otherPr, 'the affected participant sees the pending request asking for their own approval');
}

console.log('\na decline cancels the request outright -- the exercise stays, permanently, unless the creator asks again');
{
  const { host, other, s } = await makeSharedWorkout('rea_h3', 'rea_o3', ['Bench Press', 'Incline Press']);
  const benchId = s.exercises.find(e => e.name === 'Bench Press').id;
  const inclineId = s.exercises.find(e => e.name === 'Incline Press').id;
  await post(`/api/sessions/${s.id}/log`, { exerciseId: benchId, weight: 135, reps: 8 }, other.token);
  const putRes = await put(`/api/sessions/${s.id}`, { exercises: [{ id: inclineId, name: 'Incline Press' }] }, host.token);
  const reqId = putRes.pendingRemovals.find(p => p.exerciseId === benchId).id;

  const declineRes = await post(`/api/sessions/${s.id}/removal/${reqId}/decline`, {}, other.token);
  ok(!declineRes.error, `decline goes through (got ${declineRes.error})`);
  const after = await get(`/api/sessions/${s.id}`, host.token);
  ok(!!after.exercises.find(e => e.id === benchId), 'Bench Press is still there after the decline');
  ok(after.pendingRemovals.find(p => p.id === reqId).status === 'declined', 'the request itself reads declined');

  const staleApprove = await post(`/api/sessions/${s.id}/removal/${reqId}/approve`, {}, other.token);
  ok(staleApprove.error === 'already decided', `a stale approve on the same (already-declined) request is refused (got ${JSON.stringify(staleApprove)})`);
}

console.log('\nan approval actually removes it -- and the person\'s own already-logged sets survive on their own record, just detached from the live plan');
{
  const { host, other, s } = await makeSharedWorkout('rea_h4', 'rea_o4', ['Bench Press', 'Incline Press']);
  const benchId = s.exercises.find(e => e.name === 'Bench Press').id;
  const inclineId = s.exercises.find(e => e.name === 'Incline Press').id;
  await post(`/api/sessions/${s.id}/log`, { exerciseId: benchId, weight: 135, reps: 8 }, other.token);
  await post(`/api/sessions/${s.id}/log`, { exerciseId: benchId, weight: 135, reps: 8 }, other.token);
  const putRes = await put(`/api/sessions/${s.id}`, { exercises: [{ id: inclineId, name: 'Incline Press' }] }, host.token);
  const reqId = putRes.pendingRemovals.find(p => p.exerciseId === benchId).id;

  const approveRes = await post(`/api/sessions/${s.id}/removal/${reqId}/approve`, {}, other.token);
  ok(!approveRes.error, `approve goes through (got ${approveRes.error})`);
  ok(!approveRes.exercises.find(e => e.id === benchId), 'Bench Press is genuinely gone now, with the one required approval in');
  ok(approveRes.pendingRemovals.find(p => p.id === reqId).status === 'approved', 'the request reads approved');

  const otherView = await get(`/api/sessions/${s.id}`, other.token);
  ok((otherView.logs[other.id] || []).filter(l => l.exerciseId === benchId).length === 2, 'both of their own logged sets on it are still on file -- nothing was actually deleted, just detached from the shared plan');
}

console.log('\nwith TWO participants who both logged sets, it takes BOTH of them saying yes -- one approval alone does not remove it');
{
  const host = await reg('rea_h5');
  const alice = await reg('rea_a5');
  const bob = await reg('rea_b5');
  await post(`/api/follow/${alice.id}`, {}, host.token);
  await post(`/api/follow/${bob.id}`, {}, host.token);
  const s = await post('/api/sessions', {
    name: 'Leg Day', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Squat' }],
    visibility: 'private', inviteUsernames: ['rea_a5', 'rea_b5'],
  }, host.token);
  await post(`/api/sessions/${s.id}/accept`, {}, alice.token);
  await post(`/api/sessions/${s.id}/accept`, {}, bob.token);
  const squatId = s.exercises[0].id;
  await post(`/api/sessions/${s.id}/log`, { exerciseId: squatId, weight: 225, reps: 5 }, alice.token);
  await post(`/api/sessions/${s.id}/log`, { exerciseId: squatId, weight: 185, reps: 5 }, bob.token);

  const putRes = await put(`/api/sessions/${s.id}`, { exercises: [] }, host.token);
  const reqId = putRes.pendingRemovals[0].id;
  ok(putRes.pendingRemovals[0].requiredApprovals.length === 2, `both alice and bob are required (got ${JSON.stringify(putRes.pendingRemovals[0].requiredApprovals)})`);

  const aliceApprove = await post(`/api/sessions/${s.id}/removal/${reqId}/approve`, {}, alice.token);
  ok(!!aliceApprove.exercises.find(e => e.id === squatId), 'still present after only ONE of the two required approvals');
  ok(aliceApprove.pendingRemovals[0].status === 'pending', 'request still reads pending, not approved yet');

  const bobApprove = await post(`/api/sessions/${s.id}/removal/${reqId}/approve`, {}, bob.token);
  ok(!bobApprove.exercises.find(e => e.id === squatId), 'gone once the SECOND required approval lands too');
  ok(bobApprove.pendingRemovals[0].status === 'approved', 'request now reads approved');
}

console.log('\nsomeone with no stake in the exercise cannot approve or decline someone else\'s request');
{
  const { host, other, s } = await makeSharedWorkout('rea_h6', 'rea_o6', ['Bench Press', 'Incline Press']);
  const benchId = s.exercises.find(e => e.name === 'Bench Press').id;
  const inclineId = s.exercises.find(e => e.name === 'Incline Press').id;
  await post(`/api/sessions/${s.id}/log`, { exerciseId: benchId, weight: 135, reps: 8 }, other.token);
  const putRes = await put(`/api/sessions/${s.id}`, { exercises: [{ id: inclineId, name: 'Incline Press' }] }, host.token);
  const reqId = putRes.pendingRemovals.find(p => p.exerciseId === benchId).id;

  const rando = await reg('rea_rando6');
  const forbiddenApprove = await post(`/api/sessions/${s.id}/removal/${reqId}/approve`, {}, rando.token);
  ok(forbiddenApprove.error === 'not yours to approve', `a random user cannot approve someone else's removal request (got ${JSON.stringify(forbiddenApprove)})`);
  const forbiddenDecline = await post(`/api/sessions/${s.id}/removal/${reqId}/decline`, {}, rando.token);
  ok(forbiddenDecline.error === 'not yours to decide', `and cannot decline it either (got ${JSON.stringify(forbiddenDecline)})`);
  // The creator themselves, who proposed it, is not a required approver either -- they already
  // expressed their intent by proposing it; nothing left for them to "approve" here.
  const creatorSelfApprove = await post(`/api/sessions/${s.id}/removal/${reqId}/approve`, {}, host.token);
  ok(creatorSelfApprove.error === 'not yours to approve', 'the creator who proposed it cannot also "approve" their own request');
}

console.log('\nthe creator can withdraw a stalled request -- the exercise was never touched while pending, so nothing needs undoing');
{
  const { host, other, s } = await makeSharedWorkout('rea_h7', 'rea_o7', ['Bench Press', 'Incline Press']);
  const benchId = s.exercises.find(e => e.name === 'Bench Press').id;
  const inclineId = s.exercises.find(e => e.name === 'Incline Press').id;
  await post(`/api/sessions/${s.id}/log`, { exerciseId: benchId, weight: 135, reps: 8 }, other.token);
  const putRes = await put(`/api/sessions/${s.id}`, { exercises: [{ id: inclineId, name: 'Incline Press' }] }, host.token);
  const reqId = putRes.pendingRemovals.find(p => p.exerciseId === benchId).id;

  const nonCreatorCancel = await post(`/api/sessions/${s.id}/removal/${reqId}/cancel`, {}, other.token);
  ok(nonCreatorCancel.error === 'only creator can cancel', `only the creator can withdraw it, not the required approver (got ${JSON.stringify(nonCreatorCancel)})`);

  const cancelRes = await post(`/api/sessions/${s.id}/removal/${reqId}/cancel`, {}, host.token);
  ok(!cancelRes.error, `creator's own cancel goes through (got ${cancelRes.error})`);
  ok(!!cancelRes.exercises.find(e => e.id === benchId), 'Bench Press is still there -- withdrawing the request never touched it');
  ok(cancelRes.pendingRemovals.find(p => p.id === reqId).status === 'cancelled', 'the request now reads cancelled');

  // Asking again afterward opens a genuinely NEW request -- the cancelled one does not block it.
  const putRes2 = await put(`/api/sessions/${s.id}`, { exercises: [{ id: inclineId, name: 'Incline Press' }] }, host.token);
  const freshReq = putRes2.pendingRemovals.find(p => p.exerciseId === benchId && p.status === 'pending');
  ok(!!freshReq && freshReq.id !== reqId, 'asking again after a cancel opens a fresh pending request, not blocked by the old cancelled one');
}

console.log('\na repeat Save while a request is already pending reuses it rather than spamming a second ask');
{
  const { host, other, s } = await makeSharedWorkout('rea_h8', 'rea_o8', ['Bench Press', 'Incline Press']);
  const benchId = s.exercises.find(e => e.name === 'Bench Press').id;
  const inclineId = s.exercises.find(e => e.name === 'Incline Press').id;
  await post(`/api/sessions/${s.id}/log`, { exerciseId: benchId, weight: 135, reps: 8 }, other.token);
  const putRes1 = await put(`/api/sessions/${s.id}`, { exercises: [{ id: inclineId, name: 'Incline Press' }] }, host.token);
  const putRes2 = await put(`/api/sessions/${s.id}`, { exercises: [{ id: inclineId, name: 'Incline Press' }] }, host.token);
  const pending = putRes2.pendingRemovals.filter(p => p.exerciseId === benchId && p.status === 'pending');
  ok(pending.length === 1, `still exactly one pending request for it, not a duplicate (got ${pending.length})`);
  ok(pending[0].id === putRes1.pendingRemovals.find(p => p.exerciseId === benchId).id, 'it is literally the same request, reused');
}

console.log('\neverything ELSE in the same save (renames, additions, an uncontested removal) still applies immediately, even when one removal is blocked');
{
  const { host, other, s } = await makeSharedWorkout('rea_h9', 'rea_o9', ['Bench Press', 'Incline Press', 'Tricep Pushdown']);
  const benchId = s.exercises.find(e => e.name === 'Bench Press').id;
  const inclineId = s.exercises.find(e => e.name === 'Incline Press').id;
  // nobody logged sets on Tricep Pushdown -- its removal is uncontested and should go through
  await post(`/api/sessions/${s.id}/log`, { exerciseId: benchId, weight: 135, reps: 8 }, other.token);

  const r = await put(`/api/sessions/${s.id}`, {
    name: 'Renamed Push Day',
    exercises: [{ id: inclineId, name: 'Incline Dumbbell Press' }, { name: 'Cable Fly' }],
  }, host.token);
  ok(r.name === 'Renamed Push Day', 'the name change applied right away');
  // Checked by id, not the exact string -- the exercise-library name canonicalization
  // (currentExerciseName/withDefaults) may retarget "Incline Dumbbell Press" to its real library
  // name; what matters here is that the SAME exercise (inclineId) actually got renamed at all.
  const inclineAfter = r.exercises.find(e => e.id === inclineId);
  ok(!!inclineAfter && inclineAfter.name !== 'Incline Press', `the rename on Incline Press applied right away (got ${inclineAfter && inclineAfter.name})`);
  ok(!!r.exercises.find(e => e.name === 'Cable Fly'), 'the brand-new exercise (Cable Fly) was added right away');
  ok(!r.exercises.find(e => e.id !== benchId && e.name === 'Tricep Pushdown' && false), 'sanity no-op'); // keep structure symmetric
  ok(!r.exercises.find(e => e.name === 'Tricep Pushdown'), 'Tricep Pushdown (nobody else had logged it) was removed right away, no request needed');
  ok(!!r.exercises.find(e => e.id === benchId && e.name === 'Bench Press'), 'Bench Press (contested) is still there, untouched, pending approval');
  ok(r.pendingRemovals.filter(p => p.status === 'pending').length === 1, 'exactly one pending request exists, for the one contested exercise');
}

// Sep 23 2026 follow-up (Jeff, same conversation): "the ability to have the owner remove people
// from the workout... this person can be removed and solve that issue [of someone inactive/not
// voting]... they just keep the sets they've logged." Kicking someone drops their vote
// requirement from any pending removal they were blocking, and can resolve it outright if they
// were the last one needed.
console.log('\nkicking a participant who was the ONLY thing a removal request was waiting on resolves it immediately');
{
  const { host, other, s } = await makeSharedWorkout('rea_h10', 'rea_o10', ['Bench Press', 'Incline Press']);
  const benchId = s.exercises.find(e => e.name === 'Bench Press').id;
  const inclineId = s.exercises.find(e => e.name === 'Incline Press').id;
  await post(`/api/sessions/${s.id}/log`, { exerciseId: benchId, weight: 135, reps: 8 }, other.token);
  const putRes = await put(`/api/sessions/${s.id}`, { exercises: [{ id: inclineId, name: 'Incline Press' }] }, host.token);
  ok(!!putRes.exercises.find(e => e.id === benchId), 'Bench Press is pending, waiting on the one participant');

  const nonCreatorKick = await post(`/api/sessions/${s.id}/participants/${other.id}/remove`, {}, other.token);
  ok(nonCreatorKick.error === 'only the creator can remove someone', `only the creator can kick, not the target themselves (got ${JSON.stringify(nonCreatorKick)})`);

  const kickRes = await post(`/api/sessions/${s.id}/participants/${other.id}/remove`, {}, host.token);
  ok(!kickRes.error, `kick goes through (got ${kickRes.error})`);
  ok(!(kickRes.participants || []).includes(other.id), 'the kicked person is no longer a participant');
  ok(!kickRes.exercises.find(e => e.id === benchId), 'Bench Press is now GONE -- kicking the only required approver resolved the stuck request');

  // Checked from the kicked person's OWN token -- sessionView's existing "yourself and nobody
  // else, unless you're current or posted" privacy rule (v242, same one Leave already relies on)
  // hides a departed member's logs from everyone ELSE, same as it always has; it was never about
  // whether the data survives, which is the actual thing Jeff asked for here.
  const otherOwnView = await get(`/api/sessions/${s.id}`, other.token);
  ok((otherOwnView.logs[other.id] || []).filter(l => l.exerciseId === benchId).length === 1, "the kicked person's own logged set is still on file, exactly as Jeff asked for");
}

console.log('\nkicking one of TWO required approvers only drops their own requirement -- the remaining one still has to say yes');
{
  const host = await reg('rea_h11');
  const alice = await reg('rea_a11');
  const bob = await reg('rea_b11');
  await post(`/api/follow/${alice.id}`, {}, host.token);
  await post(`/api/follow/${bob.id}`, {}, host.token);
  const s = await post('/api/sessions', {
    name: 'Leg Day', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Squat' }],
    visibility: 'private', inviteUsernames: ['rea_a11', 'rea_b11'],
  }, host.token);
  await post(`/api/sessions/${s.id}/accept`, {}, alice.token);
  await post(`/api/sessions/${s.id}/accept`, {}, bob.token);
  const squatId = s.exercises[0].id;
  await post(`/api/sessions/${s.id}/log`, { exerciseId: squatId, weight: 225, reps: 5 }, alice.token);
  await post(`/api/sessions/${s.id}/log`, { exerciseId: squatId, weight: 185, reps: 5 }, bob.token);
  const putRes = await put(`/api/sessions/${s.id}`, { exercises: [] }, host.token);
  ok(putRes.pendingRemovals[0].requiredApprovals.length === 2, 'both required at the start');

  const kickAlice = await post(`/api/sessions/${s.id}/participants/${alice.id}/remove`, {}, host.token);
  ok(!!kickAlice.exercises.find(e => e.id === squatId), 'still present -- bob has not approved yet, kicking alice alone did not resolve it');
  const stillPending = kickAlice.pendingRemovals[0];
  ok(stillPending.status === 'pending' && stillPending.requiredApprovals.length === 1 && stillPending.requiredApprovals[0] === bob.id, `only bob is required now (got ${JSON.stringify(stillPending)})`);

  const bobApprove = await post(`/api/sessions/${s.id}/removal/${stillPending.id}/approve`, {}, bob.token);
  ok(!bobApprove.exercises.find(e => e.id === squatId), "gone once bob (the only one left) approves");
}

console.log("\nan owner can hide an exercise from JUST THEIR OWN view -- no approval needed, the shared plan and everyone else's access is untouched");
{
  const { host, other, s } = await makeSharedWorkout('rea_h12', 'rea_o12', ['Bench Press']);
  const benchId = s.exercises[0].id;

  const nonMemberHide = await post(`/api/sessions/${s.id}/exercises/${benchId}/hide-for-me`, {}, (await reg('rea_stranger12')).token);
  ok(nonMemberHide.error === 'not in this workout', `someone with no stake in the session cannot hide its exercises (got ${JSON.stringify(nonMemberHide)})`);

  const hideRes = await post(`/api/sessions/${s.id}/exercises/${benchId}/hide-for-me`, {}, host.token);
  ok(!hideRes.error, `the creator hiding it for themselves goes through with no approval needed (got ${hideRes.error})`);
  ok((hideRes.myHiddenExerciseIds || []).includes(benchId), 'the creator\'s own view now lists it as hidden');
  ok(!!hideRes.exercises.find(e => e.id === benchId), 'the exercise itself is completely untouched -- still a real part of the shared workout');

  const otherView = await get(`/api/sessions/${s.id}`, other.token);
  ok(!(otherView.myHiddenExerciseIds || []).includes(benchId), "the OTHER participant's own view is completely unaffected -- hiding is genuinely personal");
  ok(!!otherView.exercises.find(e => e.id === benchId), 'and they still see the exercise itself, fully intact');

  const unhideRes = await post(`/api/sessions/${s.id}/exercises/${benchId}/unhide-for-me`, {}, host.token);
  ok(!(unhideRes.myHiddenExerciseIds || []).includes(benchId), 'unhiding it brings it back to the creator\'s own view');
}

console.log('\nSep 23 2026 (cold-review catch): the creator changing their mind -- re-saving with a contested exercise kept in the list -- must actually cancel the open request, not leave it silently pending for someone to approve later against a plan that no longer reflects it');
{
  const { host, other, s } = await makeSharedWorkout('rea_h13', 'rea_o13', ['Bench Press', 'Squat']);
  const benchId = s.exercises.find(e => e.name === 'Bench Press').id;
  const squatId = s.exercises.find(e => e.name === 'Squat').id;
  await post(`/api/sessions/${s.id}/log`, { exerciseId: benchId, weight: 135, reps: 8 }, other.token);

  const removed = await put(`/api/sessions/${s.id}`, { exercises: [{ id: squatId, name: 'Squat' }] }, host.token);
  const pr = removed.pendingRemovals.find(p => p.exerciseId === benchId);
  ok(pr && pr.status === 'pending', 'a request opens as usual');

  // Creator changes their mind and re-saves with Bench Press back in the list.
  const kept = await put(`/api/sessions/${s.id}`, { exercises: [{ id: squatId, name: 'Squat' }, { id: benchId, name: 'Bench Press' }] }, host.token);
  ok(!!kept.exercises.find(e => e.id === benchId), 'Bench Press is back in the shared list right away -- keeping it needs no one\'s approval');
  const staleReq = (kept.pendingRemovals || []).find(p => p.id === pr.id);
  ok(staleReq && staleReq.status === 'cancelled', `the now-stale request is cancelled, not left pending (got ${JSON.stringify(staleReq)})`);

  const staleApprove = await post(`/api/sessions/${s.id}/removal/${pr.id}/approve`, {}, other.token);
  ok(staleApprove.error === 'already decided', `a stale approve on the cancelled request is refused, so it can never silently re-delete what the creator just kept (got ${JSON.stringify(staleApprove)})`);
  ok(!!(await get(`/api/sessions/${s.id}`, host.token)).exercises.find(e => e.id === benchId), 'and Bench Press really is still there after that refused approve');
}

console.log('\nSep 23 2026 (cold-review catch): someone who logs a NEW set on an exercise while a removal request on it is already pending gets pulled into requiredApprovals too -- their consent was never asked for otherwise, even though the request could still go through without them');
{
  const host = await reg('rea_h14');
  const alice = await reg('rea_o14a');
  const bob = await reg('rea_o14b');
  await post(`/api/follow/${alice.id}`, {}, host.token);
  await post(`/api/follow/${bob.id}`, {}, host.token);
  const s = await post('/api/sessions', {
    name: 'Leg Day', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Squat' }],
    visibility: 'private', inviteUsernames: ['rea_o14a', 'rea_o14b'],
  }, host.token);
  await post(`/api/sessions/${s.id}/accept`, {}, alice.token);
  await post(`/api/sessions/${s.id}/accept`, {}, bob.token);
  const squatId = s.exercises[0].id;
  await post(`/api/sessions/${s.id}/log`, { exerciseId: squatId, weight: 225, reps: 5 }, alice.token);

  const opened = await put(`/api/sessions/${s.id}`, { exercises: [] }, host.token);
  let pr = opened.pendingRemovals[0];
  ok(pr.requiredApprovals.length === 1 && pr.requiredApprovals[0] === alice.id, `only alice is required at first (got ${JSON.stringify(pr.requiredApprovals)})`);

  // Bob logs a set on the SAME exercise while the request is still pending.
  await post(`/api/sessions/${s.id}/log`, { exerciseId: squatId, weight: 45, reps: 12 }, bob.token);
  const afterBobLog = await get(`/api/sessions/${s.id}`, host.token);
  pr = afterBobLog.pendingRemovals.find(p => p.id === pr.id);
  ok(pr.requiredApprovals.includes(bob.id), `bob is pulled into requiredApprovals the moment he logs a set on the contested exercise (got ${JSON.stringify(pr.requiredApprovals)})`);
  ok(pr.requiredApprovals.includes(alice.id), 'alice is still required too -- bob logging did not replace her');

  const aliceApprove = await post(`/api/sessions/${s.id}/removal/${pr.id}/approve`, {}, alice.token);
  ok(!!aliceApprove.exercises.find(e => e.id === squatId), 'still present -- alice alone approving is not enough now that bob is required too');
  const bobApprove = await post(`/api/sessions/${s.id}/removal/${pr.id}/approve`, {}, bob.token);
  ok(!bobApprove.exercises.find(e => e.id === squatId), 'gone once bob (pulled in after the fact) also approves');
}

console.log('\nSep 23 2026 (cold-review catch): a pending removal request shows up in GET /api/notifications for the required approver, same as invites/join requests -- not just the one push notification that can be missed or dismissed');
{
  const { host, other, s } = await makeSharedWorkout('rea_h15', 'rea_o15', ['Bench Press']);
  const benchId = s.exercises[0].id;
  await post(`/api/sessions/${s.id}/log`, { exerciseId: benchId, weight: 135, reps: 8 }, other.token);
  await put(`/api/sessions/${s.id}`, { exercises: [] }, host.token);

  const otherNotifs = await get('/api/notifications', other.token);
  ok((otherNotifs.removals || []).length === 1, `the required approver sees exactly one removal request in their notifications (got ${JSON.stringify(otherNotifs.removals)})`);
  ok(otherNotifs.removals[0].sessionId === s.id && otherNotifs.removals[0].exerciseName === 'Bench Press', 'with the right session and exercise named');
  ok(otherNotifs.count >= 1, 'and it is folded into the overall notification count (bell badge)');

  const hostNotifs = await get('/api/notifications', host.token);
  ok(!(hostNotifs.removals || []).length, 'the creator (who proposed it, not a required approver) does not see it in their own notifications list');

  const reqId = otherNotifs.removals[0].reqId;
  const approved = await post(`/api/sessions/${s.id}/removal/${reqId}/approve`, {}, other.token);
  ok(!approved.exercises.find(e => e.id === benchId), 'approving via the id surfaced in notifications actually works, same route the in-session button calls');
  const afterNotifs = await get('/api/notifications', other.token);
  ok(!(afterNotifs.removals || []).length, 'and it drops out of notifications once decided');
}

console.log('\nSep 23 2026 (cold-review catch): unhide-for-me now checks real membership, same as hide-for-me right above it in server.js -- a stranger gets the same 403, not a silent 200');
{
  const { host, s } = await makeSharedWorkout('rea_h16', 'rea_o16', ['Bench Press']);
  const benchId = s.exercises[0].id;
  await post(`/api/sessions/${s.id}/exercises/${benchId}/hide-for-me`, {}, host.token);
  const stranger = await reg('rea_stranger16');
  const strangerUnhide = await post(`/api/sessions/${s.id}/exercises/${benchId}/unhide-for-me`, {}, stranger.token);
  ok(strangerUnhide.error === 'not in this workout', `a non-member is refused (got ${JSON.stringify(strangerUnhide)})`);
  const hostUnhide = await post(`/api/sessions/${s.id}/exercises/${benchId}/unhide-for-me`, {}, host.token);
  ok(!(hostUnhide.myHiddenExerciseIds || []).includes(benchId), 'the real owner can still unhide their own exercise as before');
}

console.log('\nSep 23 2026 (Jeff, real question: "does the removing from his view hide anything underneath that may be missed or an issue with logging and completing?"): Log & Finish must NOT credit an exercise you personally hid from your own view -- you never saw it, never logged it, and creditFinish is a permanent claim about what you actually did');
{
  const { host, other, s } = await makeSharedWorkout('rea_h17', 'rea_o17', ['Squat', 'Leg Press']);
  const squatId = s.exercises.find(e => e.name === 'Squat').id;
  const legPressId = s.exercises.find(e => e.name === 'Leg Press').id;
  // The other participant logs sets on Leg Press so it's a real, contested exercise -- not
  // something that would've just been deleted outright.
  await post(`/api/sessions/${s.id}/log`, { exerciseId: legPressId, weight: 90, reps: 12 }, other.token);
  // The host hides Leg Press from just his own view (never logs a set on it), then logs and
  // finishes on Squat only -- the real "Just for me" scenario from Jeff's own bug report.
  await post(`/api/sessions/${s.id}/exercises/${legPressId}/hide-for-me`, {}, host.token);
  await post(`/api/sessions/${s.id}/log`, { exerciseId: squatId, weight: 225, reps: 5 }, host.token);
  const lockRes = await post(`/api/sessions/${s.id}/lock`, { localDate: new Date().toISOString().slice(0, 10) }, host.token);
  ok(!lockRes.error, `Log & Finish goes through (got ${lockRes.error})`);
  const hostHistory = (lockRes.history || []).find(h => h.userId === host.id);
  ok(!!hostHistory, 'a history entry was credited for the host');
  ok(hostHistory.exercises.includes('Squat'), `Squat (what he actually did) is credited (got ${JSON.stringify(hostHistory && hostHistory.exercises)})`);
  ok(!hostHistory.exercises.includes('Leg Press'), 'Leg Press (hidden from his own view, never logged) is NOT credited to his permanent history');

  // The other participant, who never hid anything, still gets credited normally when they finish --
  // hide-for-me is genuinely personal and must not leak into someone else's own credit either.
  const otherLock = await post(`/api/sessions/${s.id}/lock`, { localDate: new Date().toISOString().slice(0, 10) }, other.token);
  const otherHistory = (otherLock.history || []).find(h => h.userId === other.id);
  ok(!!otherHistory && otherHistory.exercises.includes('Leg Press'), `the OTHER participant (who never hid it and did log it) is still credited with Leg Press, unaffected by the host's own personal hide (got ${JSON.stringify(otherHistory && otherHistory.exercises)})`);
}

try { srv && srv.kill(); } catch {}
rmSync(DIR, { recursive: true, force: true });
await testDb.drop();

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
