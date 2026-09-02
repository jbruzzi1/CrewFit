// v250 audit finding: /leave withdraws a still-PENDING swap suggestion when you go (v242 -- see the
// comment above its own suggestedEdits filter, because an approved swap RENAMES the proposer's
// already-logged sets for that exercise, so a creator approving a stale pending swap long after the
// proposer left would silently rewrite a departed person's sets with no involvement from them).
// remove-mine (meant to erase EVERY trace of a user, stronger than /leave) and reset-workouts'
// shared stripUserFromSession helper (same "strip every trace" intent -- the sibling joinRequests
// fix was already ported to both in v248/v249) never got the same suggestedEdits treatment, even
// though both are supposed to be at least as thorough as /leave.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const J = { 'Content-Type': 'application/json' };
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('suggeditcleanup');

function boot(port, dir) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; srv.stdout.on('data', d => { out += d; if (String(d).includes('CrewFit on')) res({ srv, out }); });
    srv.on('exit', () => res({ srv: null, out }));
    setTimeout(() => res({ srv, out }), 15000);
  });
}

const DIR = mkdtempSync(join(tmpdir(), 'suggeditcleanup-'));
const PORT = 4988, B = `http://localhost:${PORT}`;
const { srv } = await boot(PORT, DIR);
ok(!!srv, 'server boots');

const post = (p, b, tok) => fetch(B + p, { method: 'POST', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b) }).then(r => r.json());
const get = (p, tok) => fetch(B + p, { headers: tok ? { Authorization: 'Bearer ' + tok } : {} }).then(r => r.json());
const reg = (username, pin, displayName) => post('/api/register', { username, pin, displayName });

console.log('remove-mine withdraws a still-pending swap suggestion, same as /leave already does');
{
  const host = await reg('sec_host1', 'pass1234', 'Host1');
  const bob = await reg('sec_bob1', 'pass1234', 'Bob1');
  await post('/api/follow/' + bob.user.id, {}, host.token);
  await post('/api/follow-requests/' + host.user.id + '/accept', {}, bob.token);
  await post('/api/follow/' + host.user.id, {}, bob.token);
  await post('/api/follow-requests/' + bob.user.id + '/accept', {}, host.token);
  const s = await post('/api/sessions', {
    name: 'Leg Day', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Squat' }],
    inviteUsernames: ['sec_bob1'], visibility: 'private',
  }, host.token);
  await post('/api/sessions/' + s.id + '/accept', {}, bob.token);
  const suggested = await post('/api/sessions/' + s.id + '/suggest', { exerciseId: s.exercises[0].id, swapTo: 'Leg Press' }, bob.token);
  ok(!suggested.error, `bob suggests a swap (got ${suggested.error})`);
  await post('/api/sessions/' + s.id + '/log', { exerciseId: s.exercises[0].id, weight: 135, reps: 8 }, bob.token);

  const removed = await post('/api/sessions/' + s.id + '/remove-mine', {}, bob.token);
  ok(removed.ok, `bob removes himself from the session (got ${JSON.stringify(removed)})`);

  const asHost = await get('/api/sessions/' + s.id, host.token);
  const stillPending = (asHost.suggestedEdits || []).some(e => e.proposedBy === bob.user.id && e.status === 'pending');
  ok(!stillPending, `bob's pending swap suggestion is gone, not left for the creator to approve later (got ${JSON.stringify(asHost.suggestedEdits)})`);
}

console.log('\nreset-workouts (stripUserFromSession) withdraws it too');
{
  const host = await reg('sec_host2', 'pass1234', 'Host2');
  const bob = await reg('sec_bob2', 'pass1234', 'Bob2');
  await post('/api/follow/' + bob.user.id, {}, host.token);
  await post('/api/follow-requests/' + host.user.id + '/accept', {}, bob.token);
  await post('/api/follow/' + host.user.id, {}, bob.token);
  await post('/api/follow-requests/' + bob.user.id + '/accept', {}, host.token);
  const s = await post('/api/sessions', {
    name: 'Pull Day', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Row' }],
    inviteUsernames: ['sec_bob2'], visibility: 'private',
  }, host.token);
  await post('/api/sessions/' + s.id + '/accept', {}, bob.token);
  await post('/api/sessions/' + s.id + '/suggest', { exerciseId: s.exercises[0].id, swapTo: 'Lat Pulldown' }, bob.token);
  await post('/api/sessions/' + s.id + '/log', { exerciseId: s.exercises[0].id, weight: 95, reps: 10 }, bob.token);

  const reset = await post('/api/me/reset-workouts', { confirm: true }, bob.token);
  ok(!reset.error && reset.sessionsCleared >= 1, `bob resets his workouts (got ${JSON.stringify(reset)})`);

  const asHost = await get('/api/sessions/' + s.id, host.token);
  const stillPending = (asHost.suggestedEdits || []).some(e => e.proposedBy === bob.user.id && e.status === 'pending');
  ok(!stillPending, `bob's pending swap suggestion is gone here too (got ${JSON.stringify(asHost.suggestedEdits)})`);
}

console.log('\ncontrol: an APPROVED swap survives either route -- it was settled while the proposer was still here');
{
  const host = await reg('sec_host3', 'pass1234', 'Host3');
  const bob = await reg('sec_bob3', 'pass1234', 'Bob3');
  await post('/api/follow/' + bob.user.id, {}, host.token);
  await post('/api/follow-requests/' + host.user.id + '/accept', {}, bob.token);
  await post('/api/follow/' + host.user.id, {}, bob.token);
  await post('/api/follow-requests/' + bob.user.id + '/accept', {}, host.token);
  const s = await post('/api/sessions', {
    name: 'Arm Day', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Curl' }],
    inviteUsernames: ['sec_bob3'], visibility: 'private',
  }, host.token);
  await post('/api/sessions/' + s.id + '/accept', {}, bob.token);
  const suggested = await post('/api/sessions/' + s.id + '/suggest', { exerciseId: s.exercises[0].id, swapTo: 'Hammer Curl' }, bob.token);
  const editId = suggested.suggestedEdits.find(e => e.proposedBy === bob.user.id).id;
  const approved = await post('/api/sessions/' + s.id + '/suggest/' + editId + '/approve', {}, host.token);
  ok(!approved.error, `host approves the swap (got ${approved.error})`);
  await post('/api/sessions/' + s.id + '/log', { exerciseId: s.exercises[0].id, weight: 30, reps: 12 }, bob.token);

  await post('/api/sessions/' + s.id + '/remove-mine', {}, bob.token);
  const asHost = await get('/api/sessions/' + s.id, host.token);
  const stillApproved = (asHost.suggestedEdits || []).some(e => e.proposedBy === bob.user.id && e.status === 'approved');
  ok(stillApproved, `the already-approved swap is still there after bob removes himself (got ${JSON.stringify(asHost.suggestedEdits)})`);
}

console.log('\ndecline withdraws a still-pending swap suggested before deciding (v251 audit finding)');
{
  // /suggest deliberately lets a still-INVITED (not yet accepted) person propose a swap before
  // deciding -- "I'll come if we swap Barbell Row" is a thing you say before accepting. Declining
  // that invite used to leave the suggestion behind: it blocks everyone else from proposing their
  // own swap on that exercise (app.js's pendingSwap/offerSwap treats a pending swap as exclusive),
  // and if the creator approves it anyway, notifies the decliner about a workout they said no to.
  const host = await reg('sec_host4', 'pass1234', 'Host4');
  const bob = await reg('sec_bob4', 'pass1234', 'Bob4');
  await post('/api/follow/' + bob.user.id, {}, host.token);
  await post('/api/follow-requests/' + host.user.id + '/accept', {}, bob.token);
  await post('/api/follow/' + host.user.id, {}, bob.token);
  await post('/api/follow-requests/' + bob.user.id + '/accept', {}, host.token);
  const s = await post('/api/sessions', {
    name: 'Push Day', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Bench Press' }],
    inviteUsernames: ['sec_bob4'], visibility: 'private',
  }, host.token);
  const suggested = await post('/api/sessions/' + s.id + '/suggest', { exerciseId: s.exercises[0].id, swapTo: 'Incline Press' }, bob.token);
  ok(!suggested.error, `bob (still just invited, not accepted) suggests a swap (got ${suggested.error})`);

  // /decline responds with sessionView(s, req.userId) for the DECLINING user's own now-stranger
  // view of a private session -- sessionView returns null for tier==='stranger' (pre-existing,
  // unrelated to this fix), so a bare `null` body here is the actual success shape, not an error.
  const declined = await post('/api/sessions/' + s.id + '/decline', {}, bob.token);
  ok(declined === null, `bob declines the invite (got ${JSON.stringify(declined)})`);

  const asHost = await get('/api/sessions/' + s.id, host.token);
  const stillPending = (asHost.suggestedEdits || []).some(e => e.proposedBy === bob.user.id && e.status === 'pending');
  ok(!stillPending, `bob's pending swap suggestion is withdrawn along with his decline (got ${JSON.stringify(asHost.suggestedEdits)})`);
}

console.log('\ncontrol: an APPROVED swap survives a decline too -- it was settled while bob was still deciding');
{
  const host = await reg('sec_host5', 'pass1234', 'Host5');
  const bob = await reg('sec_bob5', 'pass1234', 'Bob5');
  await post('/api/follow/' + bob.user.id, {}, host.token);
  await post('/api/follow-requests/' + host.user.id + '/accept', {}, bob.token);
  await post('/api/follow/' + host.user.id, {}, bob.token);
  await post('/api/follow-requests/' + bob.user.id + '/accept', {}, host.token);
  const s = await post('/api/sessions', {
    name: 'Chest Day', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Fly' }],
    inviteUsernames: ['sec_bob5'], visibility: 'private',
  }, host.token);
  const suggested = await post('/api/sessions/' + s.id + '/suggest', { exerciseId: s.exercises[0].id, swapTo: 'Cable Fly' }, bob.token);
  const editId = suggested.suggestedEdits.find(e => e.proposedBy === bob.user.id).id;
  await post('/api/sessions/' + s.id + '/suggest/' + editId + '/approve', {}, host.token);

  await post('/api/sessions/' + s.id + '/decline', {}, bob.token);
  const asHost = await get('/api/sessions/' + s.id, host.token);
  const stillApproved = (asHost.suggestedEdits || []).some(e => e.proposedBy === bob.user.id && e.status === 'approved');
  ok(stillApproved, `the already-approved swap is still there after bob declines (got ${JSON.stringify(asHost.suggestedEdits)})`);
}

console.log('\nthe creator editing the invite list and dropping someone withdraws their pending suggestion the same way (v251 audit finding)');
{
  const host = await reg('sec_host6', 'pass1234', 'Host6');
  const bob = await reg('sec_bob6', 'pass1234', 'Bob6');
  const charlie = await reg('sec_charlie6', 'pass1234', 'Charlie6');
  await post('/api/follow/' + bob.user.id, {}, host.token);
  await post('/api/follow-requests/' + host.user.id + '/accept', {}, bob.token);
  await post('/api/follow/' + host.user.id, {}, bob.token);
  await post('/api/follow-requests/' + bob.user.id + '/accept', {}, host.token);
  await post('/api/follow/' + charlie.user.id, {}, host.token);
  await post('/api/follow-requests/' + host.user.id + '/accept', {}, charlie.token);
  await post('/api/follow/' + host.user.id, {}, charlie.token);
  await post('/api/follow-requests/' + charlie.user.id + '/accept', {}, host.token);
  const s = await post('/api/sessions', {
    name: 'Back Day', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Deadlift' }],
    inviteUsernames: ['sec_bob6', 'sec_charlie6'], visibility: 'private',
  }, host.token);
  const suggested = await post('/api/sessions/' + s.id + '/suggest', { exerciseId: s.exercises[0].id, swapTo: 'Rack Pull' }, bob.token);
  ok(!suggested.error, `bob suggests a swap while still just invited (got ${suggested.error})`);

  // host re-edits the invite list, silently dropping bob (keeping charlie)
  const put = await fetch(B + '/api/sessions/' + s.id, {
    method: 'PUT', headers: { ...J, Authorization: 'Bearer ' + host.token },
    body: JSON.stringify({ inviteUsernames: ['sec_charlie6'] }),
  }).then(r => r.json());
  ok(!put.error, `host edits the invite list, dropping bob (got ${put.error})`);

  const asHost = await get('/api/sessions/' + s.id, host.token);
  const stillPending = (asHost.suggestedEdits || []).some(e => e.proposedBy === bob.user.id && e.status === 'pending');
  ok(!stillPending, `bob's pending suggestion is withdrawn along with dropping him from the invite list (got ${JSON.stringify(asHost.suggestedEdits)})`);
}

console.log('\ncontrol: re-editing the invite list WITHOUT dropping someone leaves their pending suggestion alone');
{
  const host = await reg('sec_host7', 'pass1234', 'Host7');
  const bob = await reg('sec_bob7', 'pass1234', 'Bob7');
  await post('/api/follow/' + bob.user.id, {}, host.token);
  await post('/api/follow-requests/' + host.user.id + '/accept', {}, bob.token);
  await post('/api/follow/' + host.user.id, {}, bob.token);
  await post('/api/follow-requests/' + bob.user.id + '/accept', {}, host.token);
  const s = await post('/api/sessions', {
    name: 'Shoulder Day', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Press' }],
    inviteUsernames: ['sec_bob7'], visibility: 'private',
  }, host.token);
  const suggested = await post('/api/sessions/' + s.id + '/suggest', { exerciseId: s.exercises[0].id, swapTo: 'Arnold Press' }, bob.token);
  ok(!suggested.error, `bob suggests a swap while still just invited (got ${suggested.error})`);

  // host re-saves the session with the SAME invite list -- bob is not dropped
  const put = await fetch(B + '/api/sessions/' + s.id, {
    method: 'PUT', headers: { ...J, Authorization: 'Bearer ' + host.token },
    body: JSON.stringify({ inviteUsernames: ['sec_bob7'] }),
  }).then(r => r.json());
  ok(!put.error, `host re-saves the invite list with bob still on it (got ${put.error})`);

  const asHost = await get('/api/sessions/' + s.id, host.token);
  const stillPending = (asHost.suggestedEdits || []).some(e => e.proposedBy === bob.user.id && e.status === 'pending');
  ok(stillPending, `bob's pending suggestion is untouched -- he was never actually dropped (got ${JSON.stringify(asHost.suggestedEdits)})`);
}

try { srv && srv.kill(); } catch {}
rmSync(DIR, { recursive: true, force: true });
await testDb.drop();

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
