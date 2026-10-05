// Oct 2 2026 (#183, deep audit finding, Jeff: "Add a Cancel button for the proposer" (Recommended)):
// the only way to withdraw your OWN still-pending suggested swap/add used to be leaving the
// workout outright -- there was no way to take it back while staying in it. POST
// /api/sessions/:id/suggest/:editId/cancel (server.js) now lets the ORIGINAL proposer withdraw it
// themselves, scoped narrowly: never the creator (that's what approve/reject are for), and only
// while nothing else has happened to it yet -- an owned edit the creator already decided, or an
// ownerless edit someone ELSE has already voted on, or an ownerless 'add' that's already reached
// unanimous consensus, are all past the point where cancelling would silently retract a decision
// someone else already made.
// Real HTTP requests against a real server + real Postgres, same harness family as
// approve-reject-status-guard.mjs / ownerless-workout-flow.mjs.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const J = { 'Content-Type': 'application/json' };
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('cancelsuggest');

function boot(port, dir) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    srv.stdout.on('data', d => { if (String(d).includes('CrewFit on')) res(srv); });
    srv.on('exit', () => res(null));
    setTimeout(() => res(null), 15000);
  });
}

const DIR = mkdtempSync(join(tmpdir(), 'cancelsuggest-'));
const PORT = 4987, B = `http://localhost:${PORT}`;
const srv = await boot(PORT, DIR);
ok(!!srv, 'server boots');

const post = (p, b, tok) => fetch(B + p, { method: 'POST', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b) }).then(r => r.json());
const get = (p, tok) => fetch(B + p, { headers: tok ? { Authorization: 'Bearer ' + tok } : {} }).then(r => r.json());
const reg = async (username) => { const r = await post('/api/register', { username, pin: 'pass1234', displayName: username }); return { token: r.token, id: r.user.id, user: r.user }; };
const connect = async (a, b) => { await post(`/api/follow/${b.id}`, {}, a.token); };

async function makeOwnedSessionWithSwap(prefix, exerciseName, swapTo) {
  const host = await reg(prefix + 'host'), bob = await reg(prefix + 'bob');
  await connect(host, bob); await connect(bob, host);
  await post(`/api/follow-requests/${host.id}/accept`, {}, bob.token);
  await post(`/api/follow-requests/${bob.id}/accept`, {}, host.token);
  const s = await post('/api/sessions', {
    name: 'Leg Day', scheduledAt: new Date().toISOString(), exercises: [{ name: exerciseName }],
    inviteUsernames: [prefix + 'bob'], visibility: 'private',
  }, host.token);
  await post(`/api/sessions/${s.id}/accept`, {}, bob.token);
  const suggested = await post(`/api/sessions/${s.id}/suggest`, { exerciseId: s.exercises[0].id, swapTo }, bob.token);
  const editId = suggested.suggestedEdits.find(e => e.proposedBy === bob.id).id;
  return { host, bob, s, editId, exerciseId: s.exercises[0].id };
}

// Same shape as ownerless-workout-flow.mjs's own mkTrio -- a trio where the host leaves right
// after, pivoting the workout to genuinely ownerless (creatorId: null) with a and b both still in it.
async function makeOwnerlessTrio(prefix) {
  const host = await reg(prefix + 'host'), a = await reg(prefix + 'a'), b = await reg(prefix + 'b');
  await connect(host, a); await connect(host, b);
  const s = await post('/api/sessions', {
    name: 'Trio Day', scheduledAt: new Date().toISOString(),
    exercises: [{ name: 'Bench Press' }], visibility: 'private',
    inviteUsernames: [prefix + 'a', prefix + 'b'],
  }, host.token);
  await post(`/api/sessions/${s.id}/accept`, {}, a.token);
  await post(`/api/sessions/${s.id}/accept`, {}, b.token);
  await post(`/api/sessions/${s.id}/leave`, { keep: true }, host.token);
  return { a, b, s };
}

console.log('owned session: the proposer can cancel their own pending swap suggestion');
{
  const { host, bob, s, editId } = await makeOwnedSessionWithSwap('cs_own1_', 'Bench Press', 'Incline Press');
  const cancelled = await post(`/api/sessions/${s.id}/suggest/${editId}/cancel`, {}, bob.token);
  ok(!cancelled.error, `bob cancels his own suggestion (got ${JSON.stringify(cancelled)})`);
  ok(!(cancelled.suggestedEdits || []).some(e => e.id === editId), 'the edit is gone entirely, not just marked rejected');
  const asHost = await get(`/api/sessions/${s.id}`, host.token);
  ok(!(asHost.suggestedEdits || []).some(e => e.id === editId), 'and it is gone from the host\'s own view too');
}

console.log('\nowned session: only the proposer can cancel it -- not the creator, not a stranger');
{
  const { host, s, editId } = await makeOwnedSessionWithSwap('cs_own2_', 'Squat', 'Leg Press');
  const hostTries = await post(`/api/sessions/${s.id}/suggest/${editId}/cancel`, {}, host.token);
  ok(hostTries.error, `the creator cannot cancel someone else's suggestion (got ${JSON.stringify(hostTries)})`);
  const after = await get(`/api/sessions/${s.id}`, host.token);
  ok((after.suggestedEdits || []).some(e => e.id === editId && e.status === 'pending'), 'the suggestion is untouched, still pending');
}

console.log('\nowned session: once the creator has already decided it, the proposer can no longer cancel it');
{
  const { host, bob, s, editId } = await makeOwnedSessionWithSwap('cs_own3_', 'Deadlift', 'Romanian Deadlift');
  const approved = await post(`/api/sessions/${s.id}/suggest/${editId}/approve`, {}, host.token);
  ok(!approved.error, `host approves it first (got ${JSON.stringify(approved)})`);
  const lateCancel = await post(`/api/sessions/${s.id}/suggest/${editId}/cancel`, {}, bob.token);
  ok(lateCancel.error === 'already decided', `cancelling an already-approved suggestion is refused, not silently undone (got ${JSON.stringify(lateCancel)})`);
  const after = await get(`/api/sessions/${s.id}`, host.token);
  const afterEdit = after.suggestedEdits.find(e => e.id === editId);
  ok(afterEdit && afterEdit.status === 'approved', 'the approval stands, untouched');
}

console.log('\nownerless session: the proposer can cancel a swap suggestion nobody else has voted on yet');
{
  const { a, b, s } = await makeOwnerlessTrio('cs_ol1_');
  const proposed = await post(`/api/sessions/${s.id}/suggest`, { exerciseId: s.exercises[0].id, swapTo: 'Cable Fly' }, a.token);
  const editId = proposed.suggestedEdits.find(e => e.proposedBy === a.id).id;
  ok(proposed.variations && proposed.variations[s.exercises[0].id] && proposed.variations[s.exercises[0].id][a.id],
     'sanity: proposing in ownerless mode applies the proposer\'s own auto-yes as a real personal variation');

  const cancelled = await post(`/api/sessions/${s.id}/suggest/${editId}/cancel`, {}, a.token);
  ok(!cancelled.error, `a cancels his own ownerless swap suggestion (got ${JSON.stringify(cancelled)})`);
  ok(!(cancelled.suggestedEdits || []).some(e => e.id === editId), 'the suggestion is gone entirely');
  ok(!(cancelled.variations && cancelled.variations[s.exercises[0].id] && cancelled.variations[s.exercises[0].id][a.id]),
     'and the proposer\'s own auto-applied variation from proposing it is undone too');
}

console.log('\nownerless session: once someone else has voted on it, the proposer can no longer cancel it out from under their vote');
{
  const { a, b, s } = await makeOwnerlessTrio('cs_ol2_');
  const proposed = await post(`/api/sessions/${s.id}/suggest`, { exerciseId: s.exercises[0].id, swapTo: 'Cable Fly' }, a.token);
  const editId = proposed.suggestedEdits.find(e => e.proposedBy === a.id).id;
  const bVoted = await post(`/api/sessions/${s.id}/suggest/${editId}/reject`, {}, b.token);
  ok(!bVoted.error, `b casts their own real vote (reject) on it (got ${JSON.stringify(bVoted)})`);

  const lateCancel = await post(`/api/sessions/${s.id}/suggest/${editId}/cancel`, {}, a.token);
  ok(lateCancel.error, `a can no longer cancel it now that b has weighed in (got ${JSON.stringify(lateCancel)})`);
  const after = await get(`/api/sessions/${s.id}`, b.token);
  ok((after.suggestedEdits || []).some(e => e.id === editId), 'the suggestion is still there, b\'s vote intact');
}

console.log('\nownerless session: an "add" suggestion the proposer already logged real sets on cannot be cancelled away');
{
  const { a, b, s } = await makeOwnerlessTrio('cs_ol3_');
  const added = await post(`/api/sessions/${s.id}/suggest`, { type: 'add', name: 'Face Pull' }, a.token);
  const edit = added.suggestedEdits.find(e => e.proposedBy === a.id && e.type === 'add');
  await post(`/api/sessions/${s.id}/log`, { exerciseId: edit.exerciseId, weight: 20, reps: 15 }, a.token);

  const lateCancel = await post(`/api/sessions/${s.id}/suggest/${edit.id}/cancel`, {}, a.token);
  ok(lateCancel.error, `cancelling after logging real sets on it is refused (got ${JSON.stringify(lateCancel)})`);
  const after = await get(`/api/sessions/${s.id}`, a.token);
  ok((after.exercises || []).some(e => e.id === edit.exerciseId), 'the added exercise -- and its logged set -- is still there, not silently deleted');
}

console.log('\nownerless session: an "add" suggestion cannot be cancelled away once a DIFFERENT, never-voted participant has logged real sets on it');
{
  // Cold-review catch, same day: the first draft of this check only ever looked at the
  // PROPOSER's own logs. But unhide-for-me is a completely separate, vote-independent mechanism
  // -- any current participant can call it on any exercise id (including this still-pending
  // 'add's, which sessionView already exposes via suggestedEdits) -- and POST /log never checks
  // hiddenFor at all. So a different participant can see and log real sets on the new exercise
  // WITHOUT ever casting a vote, which the othersVoted guard (keyed on edit.votes) would never
  // catch. This proves the fix checks every participant's logs, not just the proposer's.
  const { a, b, s } = await makeOwnerlessTrio('cs_ol5_');
  const added = await post(`/api/sessions/${s.id}/suggest`, { type: 'add', name: 'Leg Curl' }, a.token);
  const edit = added.suggestedEdits.find(e => e.proposedBy === a.id && e.type === 'add');
  ok(!(edit.votes || {})[b.id], 'sanity: b has not voted on this at all yet');

  const unhid = await post(`/api/sessions/${s.id}/exercises/${edit.exerciseId}/unhide-for-me`, {}, b.token);
  ok(!unhid.error, `b un-hides the still-pending add for themselves, without voting (got ${JSON.stringify(unhid)})`);
  const logged = await post(`/api/sessions/${s.id}/log`, { exerciseId: edit.exerciseId, weight: 40, reps: 10 }, b.token);
  ok(!logged.error, `and logs a real set on it (got ${JSON.stringify(logged)})`);

  const lateCancel = await post(`/api/sessions/${s.id}/suggest/${edit.id}/cancel`, {}, a.token);
  ok(lateCancel.error, `a cannot cancel it now that b has real logged data on it, even though b never voted (got ${JSON.stringify(lateCancel)})`);
  const after = await get(`/api/sessions/${s.id}`, a.token);
  ok((after.exercises || []).some(e => e.id === edit.exerciseId), 'the exercise -- and b\'s logged set -- is still there, not silently deleted');
}

console.log('\nownerless session: an "add" suggestion with no logs yet IS cancellable, and removes the exercise entirely');
{
  const { a, b, s } = await makeOwnerlessTrio('cs_ol4_');
  const added = await post(`/api/sessions/${s.id}/suggest`, { type: 'add', name: 'Cable Row' }, a.token);
  const edit = added.suggestedEdits.find(e => e.proposedBy === a.id && e.type === 'add');

  const cancelled = await post(`/api/sessions/${s.id}/suggest/${edit.id}/cancel`, {}, a.token);
  ok(!cancelled.error, `a cancels the brand-new, never-logged "add" (got ${JSON.stringify(cancelled)})`);
  ok(!(cancelled.exercises || []).some(e => e.id === edit.exerciseId), 'the exercise itself is gone, not just hidden');
  ok(!(cancelled.suggestedEdits || []).some(e => e.id === edit.id), 'and the suggestion row is gone too');
}

srv.kill();
await testDb.drop();
console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
