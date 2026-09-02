// v252 audit finding: /suggest/:editId/approve+reject and /join/:reqId/approve+reject never
// checked the CURRENT status of the thing they were deciding before mutating it -- so a double-tap,
// or the same two buttons still visible in a stale second tab, could fire both approve and reject on
// the same suggestion or join request. For a swap suggestion this is real data corruption, not just
// a confusing status flip: approve renames the proposer's already-logged sets for that exercise,
// rewrites s.variations, and rebuilds every PR record via rebuildAllPrs() -- none of which a
// following reject undoes -- so the edit could end up reading 'rejected' while the swap's effects
// were still fully live, and the proposer had already gotten a "your swap was approved" push.
// /api/sessions/:id/join already validates `jr.status === 'pending'` before transitioning (see its
// own comment) -- these four routes just never got the same treatment. Fixed by adding the
// identical guard: once a suggestion or join request is no longer 'pending', neither of its two
// decision routes touches it again.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const J = { 'Content-Type': 'application/json' };
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('approverejectguard');

function boot(port, dir) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; srv.stdout.on('data', d => { out += d; if (String(d).includes('CrewFit on')) res({ srv, out }); });
    srv.on('exit', () => res({ srv: null, out }));
    setTimeout(() => res({ srv, out }), 15000);
  });
}

const DIR = mkdtempSync(join(tmpdir(), 'approverejectguard-'));
const PORT = 4989, B = `http://localhost:${PORT}`;
const { srv } = await boot(PORT, DIR);
ok(!!srv, 'server boots');

const post = (p, b, tok) => fetch(B + p, { method: 'POST', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b) }).then(r => r.json());
const get = (p, tok) => fetch(B + p, { headers: tok ? { Authorization: 'Bearer ' + tok } : {} }).then(r => r.json());
const reg = (username, pin, displayName) => post('/api/register', { username, pin, displayName });

async function makeSessionWithSwap(hostU, bobU, exerciseName, swapTo) {
  const host = await reg(hostU, 'pass1234', hostU);
  const bob = await reg(bobU, 'pass1234', bobU);
  // v190: "friends" retired -- mutual follow (both directions) reproduces the old symmetric
  // friendship this helper's name still describes, so canSeeProfile/connectionsOf work either way.
  await post('/api/follow/' + bob.user.id, {}, host.token);
  await post('/api/follow-requests/' + host.user.id + '/accept', {}, bob.token);
  await post('/api/follow/' + host.user.id, {}, bob.token);
  await post('/api/follow-requests/' + bob.user.id + '/accept', {}, host.token);
  const s = await post('/api/sessions', {
    name: 'Leg Day', scheduledAt: new Date().toISOString(), exercises: [{ name: exerciseName }],
    inviteUsernames: [bobU], visibility: 'private',
  }, host.token);
  await post('/api/sessions/' + s.id + '/accept', {}, bob.token);
  const suggested = await post('/api/sessions/' + s.id + '/suggest', { exerciseId: s.exercises[0].id, swapTo }, bob.token);
  const editId = suggested.suggestedEdits.find(e => e.proposedBy === bob.user.id).id;
  return { host, bob, s, editId, exerciseId: s.exercises[0].id };
}

console.log('a swap suggestion approved, then a stale reject on the same edit, must NOT flip its status or undo anything');
{
  const { host, bob, s, editId, exerciseId } = await makeSessionWithSwap('sec_gh1', 'sec_gb1', 'Bench Press', 'Incline Press');
  await post('/api/sessions/' + s.id + '/log', { exerciseId, weight: 135, reps: 8 }, bob.token);

  const approved = await post('/api/sessions/' + s.id + '/suggest/' + editId + '/approve', {}, host.token);
  ok(!approved.error, `first approve goes through (got ${approved.error})`);
  const approvedEdit = approved.suggestedEdits.find(e => e.id === editId);
  ok(approvedEdit.status === 'approved', `edit reads approved (got ${approvedEdit.status})`);

  const staleReject = await post('/api/sessions/' + s.id + '/suggest/' + editId + '/reject', {}, host.token);
  ok(staleReject.error === 'already decided', `the stale reject is refused, not applied (got ${JSON.stringify(staleReject)})`);

  const after = await get('/api/sessions/' + s.id, host.token);
  const afterEdit = after.suggestedEdits.find(e => e.id === editId);
  ok(afterEdit.status === 'approved', `the edit still reads approved -- not flipped by the stale reject (got ${afterEdit.status})`);
  const bobLog = after.logs && after.logs[bob.user.id] && after.logs[bob.user.id][0];
  ok(bobLog && bobLog.exerciseName === 'Incline Press', `bob's already-logged set stays renamed to the approved swap, not reverted (got ${bobLog && bobLog.exerciseName})`);
}

console.log('\na swap suggestion rejected, then a stale approve on the same edit, must NOT resurrect it');
{
  const { host, s, editId } = await makeSessionWithSwap('sec_gh2', 'sec_gb2', 'Squat', 'Leg Press');

  const rejected = await post('/api/sessions/' + s.id + '/suggest/' + editId + '/reject', {}, host.token);
  ok(!rejected.error, `first reject goes through (got ${rejected.error})`);

  const staleApprove = await post('/api/sessions/' + s.id + '/suggest/' + editId + '/approve', {}, host.token);
  ok(staleApprove.error === 'already decided', `the stale approve is refused, not applied (got ${JSON.stringify(staleApprove)})`);

  const after = await get('/api/sessions/' + s.id, host.token);
  const afterEdit = after.suggestedEdits.find(e => e.id === editId);
  ok(afterEdit.status === 'rejected', `the edit still reads rejected -- a rejected swap is not silently resurrected (got ${afterEdit.status})`);
}

async function makeSessionWithJoinRequest(hostU, bobU) {
  const host = await reg(hostU, 'pass1234', hostU);
  const bob = await reg(bobU, 'pass1234', bobU);
  // v190: "friends" retired -- mutual follow (both directions) reproduces the old symmetric
  // friendship this helper's name still describes, so canSeeProfile/connectionsOf work either way.
  await post('/api/follow/' + bob.user.id, {}, host.token);
  await post('/api/follow-requests/' + host.user.id + '/accept', {}, bob.token);
  await post('/api/follow/' + host.user.id, {}, bob.token);
  await post('/api/follow-requests/' + bob.user.id + '/accept', {}, host.token);
  const s = await post('/api/sessions', {
    name: 'Open Session', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Row' }],
    visibility: 'public',
  }, host.token);
  const joined = await post('/api/sessions/' + s.id + '/join', {}, bob.token);
  ok(joined.requested, `bob requests to join (got ${JSON.stringify(joined)})`);
  const asHost = await get('/api/sessions/' + s.id, host.token);
  const reqId = asHost.joinRequests.find(j => j.userId === bob.user.id).id;
  return { host, bob, s, reqId };
}

console.log('\na join request approved, then a stale reject on the same request, must NOT remove the participant or flip the status');
{
  const { host, bob, s, reqId } = await makeSessionWithJoinRequest('sec_gh3', 'sec_gb3');

  const approved = await post('/api/sessions/' + s.id + '/join/' + reqId + '/approve', {}, host.token);
  ok(!approved.error, `first approve goes through (got ${approved.error})`);
  ok((approved.participants || []).includes(bob.user.id), `bob is added as a participant (got ${JSON.stringify(approved.participants)})`);

  const staleReject = await post('/api/sessions/' + s.id + '/join/' + reqId + '/reject', {}, host.token);
  ok(staleReject.error === 'already decided', `the stale reject is refused, not applied (got ${JSON.stringify(staleReject)})`);

  const after = await get('/api/sessions/' + s.id, host.token);
  ok((after.participants || []).includes(bob.user.id), `bob is still a participant -- not removed by the stale reject (got ${JSON.stringify(after.participants)})`);
}

console.log('\na join request rejected, then a stale approve on the same request, must NOT add the participant back');
{
  const { host, bob, s, reqId } = await makeSessionWithJoinRequest('sec_gh4', 'sec_gb4');

  const rejected = await post('/api/sessions/' + s.id + '/join/' + reqId + '/reject', {}, host.token);
  ok(!rejected.error, `first reject goes through (got ${rejected.error})`);
  ok(!(rejected.participants || []).includes(bob.user.id), `bob is not a participant after being rejected (got ${JSON.stringify(rejected.participants)})`);

  const staleApprove = await post('/api/sessions/' + s.id + '/join/' + reqId + '/approve', {}, host.token);
  ok(staleApprove.error === 'already decided', `the stale approve is refused, not applied (got ${JSON.stringify(staleApprove)})`);

  const after = await get('/api/sessions/' + s.id, host.token);
  ok(!(after.participants || []).includes(bob.user.id), `bob is still not a participant -- not silently added by the stale approve (got ${JSON.stringify(after.participants)})`);
}

try { srv && srv.kill(); } catch {}
rmSync(DIR, { recursive: true, force: true });
await testDb.drop();

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
