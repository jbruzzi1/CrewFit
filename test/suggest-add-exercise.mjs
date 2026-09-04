// v262b (Jeff, Aug 31): "add the ability to add an exercise to a workout, not just suggest a
// swap." Asked which population should get this; Jeff picked "anyone can suggest adding one" --
// same creator-approval pattern the existing swap suggestion already has, extended with a new
// `type:'add'` edit that has no target exerciseId, since it isn't replacing anything.
//
// This drives the real /api/sessions/:id/suggest + approve/reject endpoints in server.js, same
// spawned-server harness as test/approve-reject-status-guard.mjs.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const J = { 'Content-Type': 'application/json' };
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('suggestaddexercise');

function boot(port, dir) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; srv.stdout.on('data', d => { out += d; if (String(d).includes('CrewFit on')) res({ srv, out }); });
    srv.on('exit', () => res({ srv: null, out }));
    setTimeout(() => res({ srv, out }), 15000);
  });
}

const DIR = mkdtempSync(join(tmpdir(), 'suggestaddexercise-'));
const PORT = 4992, B = `http://localhost:${PORT}`;
const { srv } = await boot(PORT, DIR);
ok(!!srv, 'server boots');

const post = (p, b, tok) => fetch(B + p, { method: 'POST', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b) }).then(r => r.json());
const get = (p, tok) => fetch(B + p, { headers: tok ? { Authorization: 'Bearer ' + tok } : {} }).then(r => r.json());
const reg = (username, pin, displayName) => post('/api/register', { username, pin, displayName });

async function makeSession(hostU, bobU, exerciseNames) {
  const host = await reg(hostU, 'pass1234', hostU);
  const bob = await reg(bobU, 'pass1234', bobU);
  await post('/api/follow/' + bob.user.id, {}, host.token);
  await post('/api/follow-requests/' + host.user.id + '/accept', {}, bob.token);
  await post('/api/follow/' + host.user.id, {}, bob.token);
  await post('/api/follow-requests/' + bob.user.id + '/accept', {}, host.token);
  const s = await post('/api/sessions', {
    name: 'Push Day', scheduledAt: new Date().toISOString(), exercises: exerciseNames.map(name => ({ name })),
    inviteUsernames: [bobU], visibility: 'private',
  }, host.token);
  await post('/api/sessions/' + s.id + '/accept', {}, bob.token);
  return { host, bob, s };
}

console.log('a participant suggests adding a new exercise -- files as a pending edit with no exerciseId, notifies the creator');
{
  const { host, bob, s } = await makeSession('sae_h1', 'sae_b1', ['Bench Press']);
  const r = await post('/api/sessions/' + s.id + '/suggest', { type: 'add', name: 'Dumbbell Lateral Raise' }, bob.token);
  ok(!r.error, `suggest goes through (got ${r.error})`);
  const edit = (r.suggestedEdits || []).find(e => e.proposedBy === bob.user.id);
  ok(!!edit, 'a suggestedEdits entry was created');
  ok(edit && edit.type === 'add', `edit is typed 'add' (got ${edit && edit.type})`);
  ok(edit && !edit.exerciseId, `edit has no exerciseId -- it isn't replacing anything (got ${edit && edit.exerciseId})`);
  ok(edit && edit.swapTo === 'Dumbbell Lateral Raise', `edit carries the proposed name (got ${edit && edit.swapTo})`);
  ok(edit && edit.status === 'pending', `edit starts pending (got ${edit && edit.status})`);
  ok(r.exercises.length === 1, `the exercise list is untouched until approved (got ${r.exercises.length})`);
}

console.log('\nan invited-but-not-yet-accepted person CANNOT suggest adding one -- narrower than swap on purpose');
{
  // Jeff, Aug 31, same thread as the feature request: "anyone that is already accepted and part
  // of the workout ... can suggest to add an exercise." Deliberately narrower than the swap
  // suggestion (which DOES let a still-invited person propose before accepting -- see
  // makeSession's sibling test in suggested-edits-cleanup.mjs) -- proposing a brand-new exercise
  // is shaping a workout you haven't actually joined yet, not raising a condition on your invite.
  const host = await reg('sae_h2', 'pass1234', 'sae_h2');
  const bob = await reg('sae_b2', 'pass1234', 'sae_b2');
  await post('/api/follow/' + bob.user.id, {}, host.token);
  await post('/api/follow-requests/' + host.user.id + '/accept', {}, bob.token);
  await post('/api/follow/' + host.user.id, {}, bob.token);
  await post('/api/follow-requests/' + bob.user.id + '/accept', {}, host.token);
  const s = await post('/api/sessions', { name: 'Leg Day', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Squat' }], inviteUsernames: ['sae_b2'], visibility: 'private' }, host.token);
  // deliberately no /accept here -- bob is still just invited
  const r = await post('/api/sessions/' + s.id + '/suggest', { type: 'add', name: 'Leg Curl' }, bob.token);
  ok(r.error === 'accept the invite first', `a still-invited person is refused (got ${JSON.stringify(r)})`);
  // The exact same still-invited bob CAN still suggest a swap on the existing exercise -- that
  // half of /suggest is untouched by this narrowing.
  const swapAttempt = await post('/api/sessions/' + s.id + '/suggest', { exerciseId: s.exercises[0].id, swapTo: 'Leg Press' }, bob.token);
  ok(!swapAttempt.error, `the same still-invited person CAN still suggest a swap, unaffected by the add-specific narrowing (got ${swapAttempt.error})`);
}

console.log('\na stranger (no participant/join/invite standing) cannot suggest adding one');
{
  const host = await reg('sae_h3', 'pass1234', 'sae_h3');
  const outsider = await reg('sae_o3', 'pass1234', 'sae_o3');
  const s = await post('/api/sessions', { name: 'Pull Day', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Row' }], visibility: 'private' }, host.token);
  const r = await post('/api/sessions/' + s.id + '/suggest', { type: 'add', name: 'Curl' }, outsider.token);
  ok(r.error === 'not a participant', `an outsider is refused (got ${JSON.stringify(r)})`);
}

console.log('\nsuggesting an add with a blank name is refused with a clean 400, not silently filed');
{
  const { bob, s } = await makeSession('sae_h4', 'sae_b4', ['Deadlift']);
  const r = await post('/api/sessions/' + s.id + '/suggest', { type: 'add', name: '   ' }, bob.token);
  ok(r.error === 'needs a name', `blank name is rejected (got ${JSON.stringify(r)})`);
  const after = await get('/api/sessions/' + s.id, bob.token);
  ok((after.suggestedEdits || []).length === 0, 'nothing was filed for the blank name');
}

console.log('\napproving an add-suggestion appends a real exercise to the workout, notifies the proposer, and touches nothing else');
{
  const { host, bob, s } = await makeSession('sae_h5', 'sae_b5', ['Overhead Press']);
  const suggested = await post('/api/sessions/' + s.id + '/suggest', { type: 'add', name: 'Face Pull' }, bob.token);
  const editId = suggested.suggestedEdits.find(e => e.proposedBy === bob.user.id).id;

  const approved = await post('/api/sessions/' + s.id + '/suggest/' + editId + '/approve', {}, host.token);
  ok(!approved.error, `approve goes through (got ${approved.error})`);
  ok(approved.exercises.length === 2, `the workout now has 2 exercises (got ${approved.exercises.length})`);
  const newEx = approved.exercises.find(e => e.name === 'Face Pull');
  ok(!!newEx, 'the new exercise is really in the list');
  ok(!!(newEx && newEx.id && newEx.id !== approved.exercises[0].id), 'the new exercise got its own real id, distinct from the original');
  ok(newEx && newEx.order === 1, `the new exercise is ordered after the original (got ${newEx && newEx.order})`);
  ok(newEx && typeof newEx.defaultSets === 'number', 'the new exercise got normal default set/rep targets, same as any other exercise');
  const editAfter = approved.suggestedEdits.find(e => e.id === editId);
  ok(editAfter && editAfter.status === 'approved', `the edit itself reads approved (got ${editAfter && editAfter.status})`);
  // The whole point of the 'add' branch in the approve handler: unlike a swap, there is no
  // existing exercise/logged sets to touch, so s.variations must stay completely empty.
  ok(Object.keys(approved.variations || {}).length === 0, `s.variations is untouched by an add-approval (got ${JSON.stringify(approved.variations)})`);
}

console.log('\nonly the creator can approve or reject an add-suggestion (same rule as swap)');
{
  const { bob, s } = await makeSession('sae_h6', 'sae_b6', ['Bicep Curl']);
  const suggested = await post('/api/sessions/' + s.id + '/suggest', { type: 'add', name: 'Tricep Pushdown' }, bob.token);
  const editId = suggested.suggestedEdits.find(e => e.proposedBy === bob.user.id).id;
  const r = await post('/api/sessions/' + s.id + '/suggest/' + editId + '/approve', {}, bob.token);
  ok(r.error === 'only creator approves', `the proposer approving their own suggestion is refused (got ${JSON.stringify(r)})`);
}

console.log('\nrejecting an add-suggestion leaves the exercise list untouched');
{
  const { host, bob, s } = await makeSession('sae_h7', 'sae_b7', ['Chest Fly']);
  const suggested = await post('/api/sessions/' + s.id + '/suggest', { type: 'add', name: 'Pec Deck' }, bob.token);
  const editId = suggested.suggestedEdits.find(e => e.proposedBy === bob.user.id).id;
  const rejected = await post('/api/sessions/' + s.id + '/suggest/' + editId + '/reject', {}, host.token);
  ok(!rejected.error, `reject goes through (got ${rejected.error})`);
  ok(rejected.exercises.length === 1, `the exercise list is unchanged (got ${rejected.exercises.length})`);
  const editAfter = rejected.suggestedEdits.find(e => e.id === editId);
  ok(editAfter && editAfter.status === 'rejected', `the edit reads rejected (got ${editAfter && editAfter.status})`);
}

console.log('\na double-tap approve on an already-approved add-suggestion is refused, not applied twice');
{
  const { host, bob, s } = await makeSession('sae_h8', 'sae_b8', ['EZ-Bar Skull Crusher']);
  const suggested = await post('/api/sessions/' + s.id + '/suggest', { type: 'add', name: 'Cable Glute Kickback' }, bob.token);
  const editId = suggested.suggestedEdits.find(e => e.proposedBy === bob.user.id).id;
  await post('/api/sessions/' + s.id + '/suggest/' + editId + '/approve', {}, host.token);
  const staleApprove = await post('/api/sessions/' + s.id + '/suggest/' + editId + '/approve', {}, host.token);
  ok(staleApprove.error === 'already decided', `the stale second approve is refused (got ${JSON.stringify(staleApprove)})`);
  const after = await get('/api/sessions/' + s.id, host.token);
  ok(after.exercises.filter(e => e.name === 'Cable Glute Kickback').length === 1, `the exercise was appended exactly once, not twice (got ${after.exercises.filter(e => e.name === 'Cable Glute Kickback').length})`);
}

console.log('\nan ordinary swap suggestion (no type field, exactly what every pre-existing client call sends) still works unchanged');
{
  const { host, bob, s } = await makeSession('sae_h9', 'sae_b9', ['Barbell Hip Thrust']);
  const suggested = await post('/api/sessions/' + s.id + '/suggest', { exerciseId: s.exercises[0].id, swapTo: 'Glute Bridge' }, bob.token);
  const edit = suggested.suggestedEdits.find(e => e.proposedBy === bob.user.id);
  ok(edit && edit.type === 'swap', `an old-style call with no type field is stored as 'swap' (got ${edit && edit.type})`);
  ok(edit && edit.exerciseId === s.exercises[0].id, 'the swap edit still carries its target exerciseId');
  const approved = await post('/api/sessions/' + s.id + '/suggest/' + edit.id + '/approve', {}, host.token);
  ok(approved.exercises.length === 1, `approving a swap does NOT append a new exercise (got ${approved.exercises.length})`);
  ok(approved.variations[s.exercises[0].id] && approved.variations[s.exercises[0].id][bob.user.id].swapTo === 'Glute Bridge', 'the swap still records a variation exactly as before');
}

try { srv && srv.kill(); } catch {}
rmSync(DIR, { recursive: true, force: true });
await testDb.drop();

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
