// v253 audit findings (server-side), verified against a REAL server process + throwaway Postgres
// DB, same pattern as test/approve-reject-status-guard.mjs.
//
// 1. 500-vs-400 guard: withDefaults() (server.js) threw on a non-object exercises[] element -- e.g.
//    `exercises:[null]`. server.js already wraps every route (see the app.get/post/put/... wrapper
//    near the top of the file) so a thrown/rejected handler forwards to the error middleware
//    instead of taking the whole process down -- confirmed directly by booting a real server and
//    sending it exercises:[null]: the process stayed up and answered a generic 500. So the actual
//    bug is a confusing, generic "Something went wrong" 500 for ordinary bad input, not an outage --
//    every other malformed-input case in this file returns a clean 400, and this one now does too,
//    rejected before it ever reaches withDefaults.
// 2. rebuildAllPrs() never checked isWorkingSet() before picking a PR, unlike the two other places
//    that decide "did this count" -- a warm-up or drop set could become someone's recorded PR,
//    contradicting the deliberate "warm-ups/drop sets aren't working sets" rule (CLAUDE.md).
// 3. sessionView's non-member branch hardcoded history:[] instead of carving out the viewer's own
//    entry like every sibling field (invited/joinRequests/variations) does -- broke home()'s own
//    "Last workout" line for anyone who left a workout with Leave's "keep my credit" option.
// 4. sessionView's member branch spread the FULL, unfiltered joinRequests to every current
//    participant, not just the creator -- leaking other people's join notes to anyone in the
//    workout, not only the person who can actually approve/reject them.
// 5. othersWhoLogged(), used to hand off ownership when a creator leaves, only counts a CURRENT
//    participant who has already logged a set -- so a participant who'd accepted but hadn't
//    logged anything yet was invisible to it, and the workout got orphaned (creatorId: null) even
//    though a real current participant was sitting right there.
// 6. /decline never cleaned up a stale joinRequests row -- the same class of bug already fixed for
//    /leave and /remove-mine (see their own comments), just missed here. A join request filed
//    independently of an invitation survived declining that invitation, so a later approve could
//    silently add back someone who had explicitly said no.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const J = { 'Content-Type': 'application/json' };
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('auditv253');

function boot(port, dir) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; srv.stdout.on('data', d => { out += d; if (String(d).includes('CrewFit on')) res({ srv, out }); });
    srv.on('exit', () => res({ srv: null, out }));
    setTimeout(() => res({ srv, out }), 15000);
  });
}

const DIR = mkdtempSync(join(tmpdir(), 'auditv253-'));
const PORT = 4990, B = `http://localhost:${PORT}`;
const { srv } = await boot(PORT, DIR);
ok(!!srv, 'server boots');

const post = (p, b, tok) => fetch(B + p, { method: 'POST', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b) }).then(r => r.json());
const put = (p, b, tok) => fetch(B + p, { method: 'PUT', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b) }).then(r => r.json());
const get = (p, tok) => fetch(B + p, { headers: tok ? { Authorization: 'Bearer ' + tok } : {} }).then(r => r.json());
const rawStatus = (method, p, b, tok) => fetch(B + p, { method, headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: b !== undefined ? JSON.stringify(b) : undefined }).then(r => r.status);
const reg = (username, pin, displayName) => post('/api/register', { username, pin, displayName });
// v190: "friends" retired -- mutual follow (both directions) reproduces the old symmetric
// friendship this helper's name still describes.
const befriend = async (aTok, aId, bTok, bId) => {
  await post('/api/follow/' + bId, {}, aTok);
  await post('/api/follow-requests/' + aId + '/accept', {}, bTok);
  await post('/api/follow/' + aId, {}, bTok);
  await post('/api/follow-requests/' + bId + '/accept', {}, aTok);
};

console.log('1. malformed exercise data is rejected with a clean 400, not a generic 500');
{
  const host = await reg('sec253_a', 'pass1234', 'A');

  const st1 = await rawStatus('POST', '/api/sessions', { name: 'Bad', scheduledAt: new Date().toISOString(), exercises: [null] }, host.token);
  ok(st1 === 400, `POST /api/sessions with exercises:[null] returns 400, not a generic 500 (got ${st1})`);

  const goodS = await post('/api/sessions', { name: 'Good', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Bench Press' }] }, host.token);
  ok(!goodS.error, `a normal session still creates fine right after (got ${JSON.stringify(goodS.error)})`);

  const st2 = await rawStatus('PUT', '/api/sessions/' + goodS.id, { exercises: [null] }, host.token);
  ok(st2 === 400, `PUT /api/sessions/:id with exercises:[null] returns 400 (got ${st2})`);

  const st3 = await rawStatus('POST', '/api/templates', { name: 'Bad Tpl', exercises: [null] }, host.token);
  ok(st3 === 400, `POST /api/templates with exercises:[null] returns 400 (got ${st3})`);

  const goodTpl = await post('/api/templates', { name: 'Good Tpl', exercises: [{ name: 'Squat' }] }, host.token);
  ok(!goodTpl.error, `a normal template still creates fine (got ${JSON.stringify(goodTpl.error)})`);

  const st4 = await rawStatus('PUT', '/api/templates/' + goodTpl.id, { exercises: [null] }, host.token);
  ok(st4 === 400, `PUT /api/templates/:id with exercises:[null] returns 400 (got ${st4})`);

  // Belt-and-suspenders: confirm the server process is still alive and answering ordinary
  // requests after all four malformed attempts above (it always was, thanks to the app-wide
  // async-error wrapper -- see the comment on test 1 above -- but worth re-confirming here).
  const alive = await get('/healthz');
  ok(alive && alive.ok, `the server process is still alive and responding after all four malformed requests (got ${JSON.stringify(alive)})`);
}

console.log('\n2. warm-up and drop sets never become the recorded PR');
{
  const host = await reg('sec253_b', 'pass1234', 'B');
  const s = await post('/api/sessions', { name: 'Push', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Overhead Press' }] }, host.token);
  const exId = s.exercises[0].id;
  // A heavy WARM-UP first (would win on weight alone if warm-ups counted), then a real, lighter
  // working set. If the fix regressed, the warm-up would show isPr:true and the working set would not.
  await post(`/api/sessions/${s.id}/log`, { exerciseId: exId, weight: 200, reps: 5, setType: 'warmup' }, host.token);
  const after = await post(`/api/sessions/${s.id}/log`, { exerciseId: exId, weight: 135, reps: 8, setType: 'normal' }, host.token);
  const mine = (after.logs && after.logs[host.user.id]) || [];
  const warmup = mine.find(l => l.setType === 'warmup');
  const normal = mine.find(l => l.setType === 'normal');
  ok(warmup && warmup.isPr === false, `the heavier warm-up set does NOT get flagged as the PR (got isPr=${warmup && warmup.isPr})`);
  ok(normal && normal.isPr === true, `the working set (lighter, but the only REAL set) is the PR instead (got isPr=${normal && normal.isPr})`);
  const profile = await get('/api/profile/me', host.token);
  // profile.prs is an ARRAY (see profileOf() in server.js), each entry shaped like
  // { exercise, weight, ... } -- not an object keyed by exercise name.
  const pr = (profile.prs || []).find(p => p.exercise === 'Overhead Press');
  ok(pr && Number(pr.weight) === 135, `the profile's own PR card reflects the working set's weight, not the warm-up's (got ${JSON.stringify(pr)})`);
}

console.log('\n3. a workout left with "keep my credit" still shows up in your own session history');
{
  const host = await reg('sec253_c1', 'pass1234', 'C1');
  const bob = await reg('sec253_c2', 'pass1234', 'C2');
  await befriend(host.token, host.user.id, bob.token, bob.user.id);
  const s = await post('/api/sessions', { name: 'Legs', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Squat' }], inviteUsernames: ['sec253_c2'], visibility: 'private' }, host.token);
  await post(`/api/sessions/${s.id}/accept`, {}, bob.token);
  // Bob logs a set, then leaves keeping credit -- his history row survives, but he's no longer a
  // current participant, so GET /api/sessions runs this session through sessionView's non-member
  // ('alumni') branch for him from here on.
  await post(`/api/sessions/${s.id}/log`, { exerciseId: s.exercises[0].id, weight: 225, reps: 5 }, bob.token);
  const left = await post(`/api/sessions/${s.id}/leave`, { keep: true }, bob.token);
  ok(!left.error, `bob leaves keeping credit (got ${JSON.stringify(left.error)})`);

  const list = await get('/api/sessions', bob.token);
  const seen = Array.isArray(list) ? list.find(x => x.id === s.id) : null;
  ok(!!seen, `the workout still appears at all in bob's own GET /api/sessions (got ${JSON.stringify(seen)})`);
  ok(seen && Array.isArray(seen.history) && seen.history.some(h => h.userId === bob.user.id),
    `and its history array carries BOB'S OWN kept-credit row, not an empty array (got ${JSON.stringify(seen && seen.history)})`);
}

console.log('\n4. only the creator sees the full joinRequests list -- other participants only see their own');
{
  const host = await reg('sec253_d1', 'pass1234', 'D1');
  const bob = await reg('sec253_d2', 'pass1234', 'D2');
  const carol = await reg('sec253_d3', 'pass1234', 'D3');
  await befriend(host.token, host.user.id, bob.token, bob.user.id);
  await befriend(host.token, host.user.id, carol.token, carol.user.id);
  const s = await post('/api/sessions', { name: 'Open Session', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Row' }], inviteUsernames: ['sec253_d2'], visibility: 'public' }, host.token);
  await post(`/api/sessions/${s.id}/accept`, {}, bob.token);   // bob: regular current participant, not creator
  const joined = await post(`/api/sessions/${s.id}/join`, { note: 'let me in please' }, carol.token);
  ok(joined.requested, `carol independently requests to join (got ${JSON.stringify(joined)})`);

  const asCreator = await get('/api/sessions/' + s.id, host.token);
  ok((asCreator.joinRequests || []).some(j => j.userId === carol.user.id),
    `the creator sees carol's join request (got ${JSON.stringify(asCreator.joinRequests)})`);

  const asParticipant = await get('/api/sessions/' + s.id, bob.token);
  ok(!(asParticipant.joinRequests || []).some(j => j.userId === carol.user.id),
    `a regular (non-creator) participant does NOT see carol's join request or her note (got ${JSON.stringify(asParticipant.joinRequests)})`);
}

console.log('\n5. creatorId does not lock to null when a not-yet-logged current participant exists');
{
  const host = await reg('sec253_e1', 'pass1234', 'E1');
  const departed = await reg('sec253_e2', 'pass1234', 'E2');
  const bob = await reg('sec253_e3', 'pass1234', 'E3');
  await befriend(host.token, host.user.id, departed.token, departed.user.id);
  await befriend(host.token, host.user.id, bob.token, bob.user.id);
  const s = await post('/api/sessions', { name: 'Pull', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Pull-up' }], inviteUsernames: ['sec253_e2', 'sec253_e3'], visibility: 'private' }, host.token);
  await post(`/api/sessions/${s.id}/accept`, {}, departed.token);
  await post(`/api/sessions/${s.id}/accept`, {}, bob.token);
  // "departed" leaves keeping credit -- gives the workout SOMEONE with credit (satisfies /leave's
  // own "nobody has logged, delete it instead" guard for when the creator leaves next) without
  // being a CURRENT participant any more, so they can't be handed ownership.
  await post(`/api/sessions/${s.id}/leave`, { keep: true }, departed.token);
  // bob stays current but never logs anything -- this is the exact case othersWhoLogged() alone
  // used to miss.
  const hostLeaves = await post(`/api/sessions/${s.id}/leave`, { keep: true }, host.token);
  ok(!hostLeaves.error, `the creator can leave (got ${JSON.stringify(hostLeaves.error)})`);
  // /leave's own response is just {ok:true, left:true} -- it doesn't echo the updated session --
  // so check ownership by asking bob (the new creator) for the session afresh.
  const afterLeave = await get('/api/sessions/' + s.id, bob.token);
  ok(afterLeave.creatorId === bob.user.id,
    `ownership passes to bob -- the current, not-yet-logged participant -- instead of locking to null (got creatorId=${afterLeave.creatorId})`);
  ok((afterLeave.participants || []).includes(bob.user.id), `bob is still listed as a participant too (got ${JSON.stringify(afterLeave.participants)})`);
}

console.log('\n6. declining an invite also clears a separately-filed pending join request');
{
  const host = await reg('sec253_f1', 'pass1234', 'F1');
  const bob = await reg('sec253_f2', 'pass1234', 'F2');
  await befriend(host.token, host.user.id, bob.token, bob.user.id);
  const s = await post('/api/sessions', { name: 'Open Session', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Row' }], inviteUsernames: ['sec253_f2'], visibility: 'public' }, host.token);
  // bob is invited AND independently asks to join -- /join doesn't check s.invited, so both can
  // exist for the same person at once.
  const joined = await post(`/api/sessions/${s.id}/join`, {}, bob.token);
  ok(joined.requested, `bob also files a separate join request while still invited (got ${JSON.stringify(joined)})`);

  const declined = await post(`/api/sessions/${s.id}/decline`, {}, bob.token);
  ok(!declined.error, `bob declines the invite (got ${JSON.stringify(declined.error)})`);

  const asCreator = await get('/api/sessions/' + s.id, host.token);
  ok(!(asCreator.joinRequests || []).some(j => j.userId === bob.user.id),
    `bob's pending join request is gone too -- the creator can't later "approve" someone who explicitly declined (got ${JSON.stringify(asCreator.joinRequests)})`);
}

try { srv && srv.kill(); } catch {}
rmSync(DIR, { recursive: true, force: true });
await testDb.drop();

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
