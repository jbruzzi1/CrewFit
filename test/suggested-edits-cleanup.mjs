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
  await post('/api/friends/request', { username: 'sec_bob1' }, host.token);
  await post('/api/friends/accept', { from: host.user.id }, bob.token);
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
  await post('/api/friends/request', { username: 'sec_bob2' }, host.token);
  await post('/api/friends/accept', { from: host.user.id }, bob.token);
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
  await post('/api/friends/request', { username: 'sec_bob3' }, host.token);
  await post('/api/friends/accept', { from: host.user.id }, bob.token);
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

try { srv && srv.kill(); } catch {}
rmSync(DIR, { recursive: true, force: true });
await testDb.drop();

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
