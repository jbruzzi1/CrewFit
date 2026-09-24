// Sep 23 2026 (Jeff: "with these changes you are seeing us make - bugs and missed items in
// workout such as owners leaving/etc. What else can you think of or find that may have similar
// issues") -- an audit pass over every "someone leaves/is kicked/resets their workouts" departure
// route turned up three more real, still-open instances of the exact same bug family the
// invite/delete/removal-approval fixes already closed:
//
//   1. POST /api/sessions/:id/remove-mine's ownership handoff only ever checked
//      othersWhoLogged(s, me) with no fallback to "any other CURRENT participant" -- unlike /leave
//      (v253) and /me/reset-workouts (Sep 18), which both already had this exact fallback. A
//      participant who'd accepted an invite but hadn't logged anything yet was invisible to the
//      narrower check, so the workout went permanently ownerless the moment the creator tapped
//      "Remove from my profile" -- even though someone real was still sitting right there in
//      s.participants.
//   2. Only the kick route (POST .../participants/:pid/remove) ever let go of a still-REQUIRED
//      exercise-removal-approval vote a departing person held. /leave, /remove-mine and
//      stripUserFromSession (used by /me/reset-workouts) all erased someone's participation
//      without this cleanup, leaving a fully-departed person as a standing, undiscoverable-except-
//      via-notifications required approver forever -- and unlike a vote stuck on someone merely
//      inactive, the creator had no way to force THIS one, since you can't kick someone who
//      already left.
//   3. POST /api/sessions/:id/comments only ever notified s.participants of a reply, but the
//      route's own access gate (same line as the GET right above it) explicitly lets tier
//      'invited' -- a pending, not-yet-accepted invitee -- both read AND post into that same
//      thread. An invited person could post and then never hear about any reply to it.
//
// A fourth finding from the same pass -- "X invited you" resolving the CURRENT session owner
// instead of whoever actually sent the invite, once ownership hands off mid-invite -- is covered
// separately in this same file (the new s.invitedBy map) since it shares the same ownership-
// handoff setup as finding #1.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const J = { 'Content-Type': 'application/json' };
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('departurecleanup');

function boot(port, dir) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    srv.stdout.on('data', d => { if (String(d).includes('CrewFit on')) res(srv); });
    srv.on('exit', () => res(null));
    setTimeout(() => res(null), 15000);
  });
}

const DIR = mkdtempSync(join(tmpdir(), 'departurecleanup-'));
const PORT = 4981, B = `http://localhost:${PORT}`;
const srv = await boot(PORT, DIR);
ok(!!srv, 'server boots');

const post = (p, b, tok) => fetch(B + p, { method: 'POST', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b) }).then(r => r.json());
const put = (p, b, tok) => fetch(B + p, { method: 'PUT', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b) }).then(r => r.json());
const get = (p, tok) => fetch(B + p, { headers: tok ? { Authorization: 'Bearer ' + tok } : {} }).then(r => r.json());
const reg = async (username) => { const r = await post('/api/register', { username, pin: 'pass1234', displayName: username }); return { token: r.token, id: r.user.id, user: r.user }; };

console.log('\nFix #1: creator taps "Remove from my profile" -- ownership hands off to any other CURRENT participant, not just one who has already logged something');
{
  const host = await reg('rm1_host');
  const other = await reg('rm1_other');
  await post(`/api/follow/${other.id}`, {}, host.token);
  const s = await post('/api/sessions', {
    name: 'Push Day', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Bench Press' }],
    visibility: 'private', inviteUsernames: ['rm1_other'],
  }, host.token);
  await post(`/api/sessions/${s.id}/accept`, {}, other.token);
  // Deliberately no log -- the whole point is this participant is CURRENT but has not logged yet.
  const r = await post(`/api/sessions/${s.id}/remove-mine`, {}, host.token);
  ok(r.ok === true && r.removed === true, `remove-mine itself succeeds (got ${JSON.stringify(r)})`);
  const after = await get(`/api/sessions/${s.id}`, other.token);
  ok(after.creatorId === other.id, `ownership handed to the still-current participant, not left null (got creatorId=${after.creatorId})`);
  ok((after.participants || []).includes(other.id), 'the new owner is still listed as a participant');
}

console.log('\nFix #1 (unchanged case): if NOBODY else is current, remove-mine still orphans the workout exactly as before -- nothing to hand off to');
{
  const host = await reg('rm2_host');
  const s = await post('/api/sessions', {
    name: 'Solo Day', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Bench Press' }],
    visibility: 'private',
  }, host.token);
  const r = await post(`/api/sessions/${s.id}/remove-mine`, {}, host.token);
  ok(r.ok === true, 'remove-mine succeeds on a solo workout');
}

console.log('\nFix #3a: leaving drops a still-required exercise-removal vote -- if that was the ONLY required approver, the removal resolves on the spot');
{
  const host = await reg('lv1_host');
  const other = await reg('lv1_other');
  await post(`/api/follow/${other.id}`, {}, host.token);
  const s = await post('/api/sessions', {
    name: 'Leg Day', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Squat' }, { name: 'Leg Press' }],
    visibility: 'private', inviteUsernames: ['lv1_other'],
  }, host.token);
  await post(`/api/sessions/${s.id}/accept`, {}, other.token);
  const squatId = s.exercises.find(e => e.name === 'Squat').id;
  const legPressId = s.exercises.find(e => e.name === 'Leg Press').id;
  await post(`/api/sessions/${s.id}/log`, { exerciseId: squatId, weight: 225, reps: 5 }, other.token);
  const putRes = await put(`/api/sessions/${s.id}`, { exercises: [{ id: legPressId, name: 'Leg Press' }] }, host.token);
  const pr = putRes.pendingRemovals.find(p => p.exerciseId === squatId);
  ok(!!pr && pr.status === 'pending' && pr.requiredApprovals.includes(other.id), 'a pending removal on Squat is genuinely waiting on the other participant');

  const leaveRes = await post(`/api/sessions/${s.id}/leave`, { keep: true }, other.token);
  ok(leaveRes.ok === true && leaveRes.left === true, `leaving itself succeeds (got ${JSON.stringify(leaveRes)})`);
  const after = await get(`/api/sessions/${s.id}`, host.token);
  const prAfter = after.pendingRemovals.find(p => p.id === pr.id);
  ok(prAfter.status === 'approved', `the removal auto-resolved once the only required approver left (got status=${prAfter && prAfter.status})`);
  ok(!after.exercises.find(e => e.id === squatId), 'Squat is genuinely gone from the shared plan now');
}

console.log('\nFix #3b: leaving with MULTIPLE required approvers only drops the leaver\'s own vote -- the request stays pending on whoever remains');
{
  const host = await reg('lv2_host');
  const a = await reg('lv2_a');
  const b = await reg('lv2_b');
  await post(`/api/follow/${a.id}`, {}, host.token);
  await post(`/api/follow/${b.id}`, {}, host.token);
  const s = await post('/api/sessions', {
    name: 'Pull Day', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Deadlift' }, { name: 'Row' }],
    visibility: 'private', inviteUsernames: ['lv2_a', 'lv2_b'],
  }, host.token);
  await post(`/api/sessions/${s.id}/accept`, {}, a.token);
  await post(`/api/sessions/${s.id}/accept`, {}, b.token);
  const dlId = s.exercises.find(e => e.name === 'Deadlift').id;
  const rowId = s.exercises.find(e => e.name === 'Row').id;
  await post(`/api/sessions/${s.id}/log`, { exerciseId: dlId, weight: 315, reps: 3 }, a.token);
  await post(`/api/sessions/${s.id}/log`, { exerciseId: dlId, weight: 225, reps: 5 }, b.token);
  const putRes = await put(`/api/sessions/${s.id}`, { exercises: [{ id: rowId, name: 'Row' }] }, host.token);
  const pr = putRes.pendingRemovals.find(p => p.exerciseId === dlId);
  ok(pr.requiredApprovals.length === 2, `both A and B are required (got ${JSON.stringify(pr.requiredApprovals)})`);

  await post(`/api/sessions/${s.id}/leave`, { keep: true }, a.token);
  const mid = await get(`/api/sessions/${s.id}`, host.token);
  const prMid = mid.pendingRemovals.find(p => p.id === pr.id);
  ok(prMid.status === 'pending', 'still pending -- B has not weighed in yet');
  ok(!prMid.requiredApprovals.includes(a.id) && prMid.requiredApprovals.includes(b.id), `A's vote requirement is gone, B's remains (got ${JSON.stringify(prMid.requiredApprovals)})`);

  const approveRes = await post(`/api/sessions/${s.id}/removal/${pr.id}/approve`, {}, b.token);
  ok(!approveRes.error, `B alone can now resolve it (got ${JSON.stringify(approveRes.error)})`);
  ok(!approveRes.exercises.find(e => e.id === dlId), 'Deadlift is gone once the one remaining required approver signs off');
}

console.log('\nFix #3c: remove-mine ("delete off my profile") also drops a still-required removal vote it was about to erase every trace of');
{
  const host = await reg('rmv1_host');
  const other = await reg('rmv1_other');
  await post(`/api/follow/${other.id}`, {}, host.token);
  const s = await post('/api/sessions', {
    name: 'Push Day 2', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Bench Press' }, { name: 'Incline Press' }],
    visibility: 'private', inviteUsernames: ['rmv1_other'],
  }, host.token);
  await post(`/api/sessions/${s.id}/accept`, {}, other.token);
  const benchId = s.exercises.find(e => e.name === 'Bench Press').id;
  const inclineId = s.exercises.find(e => e.name === 'Incline Press').id;
  await post(`/api/sessions/${s.id}/log`, { exerciseId: benchId, weight: 135, reps: 8 }, other.token);
  const putRes = await put(`/api/sessions/${s.id}`, { exercises: [{ id: inclineId, name: 'Incline Press' }] }, host.token);
  const pr = putRes.pendingRemovals.find(p => p.exerciseId === benchId);
  ok(!!pr, 'a pending removal exists, waiting on the other participant');

  await post(`/api/sessions/${s.id}/remove-mine`, {}, other.token);
  const after = await get(`/api/sessions/${s.id}`, host.token);
  const prAfter = after.pendingRemovals.find(p => p.id === pr.id);
  ok(prAfter.status === 'approved', `the removal resolved once the departing (self-erasing) participant was the only vote it needed (got ${prAfter && prAfter.status})`);
}

console.log('\nFix #3d: "reset my workouts" (stripUserFromSession) also drops a still-required removal vote for a session this user does not own');
{
  const host = await reg('rst1_host');
  const other = await reg('rst1_other');
  await post(`/api/follow/${other.id}`, {}, host.token);
  const s = await post('/api/sessions', {
    name: 'Arm Day', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Curl' }, { name: 'Pushdown' }],
    visibility: 'private', inviteUsernames: ['rst1_other'],
  }, host.token);
  await post(`/api/sessions/${s.id}/accept`, {}, other.token);
  const curlId = s.exercises.find(e => e.name === 'Curl').id;
  const pushdownId = s.exercises.find(e => e.name === 'Pushdown').id;
  await post(`/api/sessions/${s.id}/log`, { exerciseId: curlId, weight: 30, reps: 10 }, other.token);
  const putRes = await put(`/api/sessions/${s.id}`, { exercises: [{ id: pushdownId, name: 'Pushdown' }] }, host.token);
  const pr = putRes.pendingRemovals.find(p => p.exerciseId === curlId);
  ok(!!pr, 'a pending removal exists, waiting on the other participant');

  const resetRes = await post('/api/me/reset-workouts', { confirm: true }, other.token);
  ok(resetRes.ok === true, `reset-workouts succeeds (got ${JSON.stringify(resetRes)})`);
  const after = await get(`/api/sessions/${s.id}`, host.token);
  const prAfter = after.pendingRemovals.find(p => p.id === pr.id);
  ok(prAfter.status === 'approved', `the removal resolved once reset-workouts erased the only required approver's stake in it (got ${prAfter && prAfter.status})`);
}

console.log('\nFix #5: a pending (not-yet-accepted) invitee can already post AND read the workout chat -- they should also be notified of a reply to it');
{
  const host = await reg('cht1_host');
  const invitee = await reg('cht1_invitee');
  await post(`/api/follow/${invitee.id}`, {}, host.token);
  const s = await post('/api/sessions', {
    name: 'Chat Test Day', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Bench Press' }],
    visibility: 'private', inviteUsernames: ['cht1_invitee'],
  }, host.token);
  // Deliberately never accepted -- still just 'invited' tier.
  const postComment = await post(`/api/sessions/${s.id}/comments`, { text: 'Is there a squat rack free?' }, invitee.token);
  ok(!postComment.error, `the still-invited person really can post into the chat (got ${JSON.stringify(postComment.error)})`);

  const reply = await post(`/api/sessions/${s.id}/comments`, { text: 'Should be free by 6' }, host.token);
  ok(!reply.error, 'the host can reply');

  const notifs = await get('/api/notifications', invitee.token);
  const gotChatNotif = (notifs.history || []).some(h => String(h.link && h.link.type) === 'session-chat' && String(h.link.sessionId) === s.id);
  ok(gotChatNotif, `the still-invited person was notified of the reply in a thread they can already read and post in (got history=${JSON.stringify((notifs.history||[]).map(h=>h.link))})`);
}

console.log('\nFix #4: "X invited you" keeps crediting whoever actually sent the invite, even after ownership hands off to someone else');
{
  const host = await reg('inv1_host');
  const heir = await reg('inv1_heir');
  const invitee = await reg('inv1_invitee');
  await post(`/api/follow/${heir.id}`, {}, host.token);
  await post(`/api/follow/${invitee.id}`, {}, host.token);
  const s = await post('/api/sessions', {
    name: 'Handoff Day', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Bench Press' }],
    visibility: 'private', inviteUsernames: ['inv1_heir', 'inv1_invitee'],
  }, host.token);
  await post(`/api/sessions/${s.id}/accept`, {}, heir.token);
  // heir logs a set so the ownership-handoff fallback prefers them as the new owner.
  const benchId = s.exercises.find(e => e.name === 'Bench Press').id;
  await post(`/api/sessions/${s.id}/log`, { exerciseId: benchId, weight: 135, reps: 8 }, heir.token);
  // invitee never answers -- still sitting in s.invited when the host leaves.

  const beforeNotifs = await get('/api/notifications', invitee.token);
  const beforeInvite = (beforeNotifs.invites || []).find(iv => iv.sessionId === s.id);
  ok(!!beforeInvite && beforeInvite.from.username === 'inv1_host', `before any handoff, the invite correctly names the real host (got ${beforeInvite && beforeInvite.from && beforeInvite.from.username})`);

  const leaveRes = await post(`/api/sessions/${s.id}/leave`, { keep: true }, host.token);
  ok(leaveRes.ok === true, 'the host leaves');
  const afterHandoff = await get(`/api/sessions/${s.id}`, heir.token);
  ok(afterHandoff.creatorId === heir.id, `ownership genuinely handed off to the heir (got creatorId=${afterHandoff.creatorId})`);
  // Cold-review catch: the member-tier view is a raw spread of the session object, which used to
  // leak s.invitedBy -- who invited EVERY invitee, not just the viewer's own -- to any current
  // member. Fixed the same "yourself and nobody else" way draftNotes/hiddenFor already were.
  ok(afterHandoff.invitedBy === undefined, `a member (the heir) does NOT get the whole invitedBy map -- who invited the still-pending invitee is not the heir's business (got ${JSON.stringify(afterHandoff.invitedBy)})`);

  const afterNotifs = await get('/api/notifications', invitee.token);
  const afterInvite = (afterNotifs.invites || []).find(iv => iv.sessionId === s.id);
  ok(!!afterInvite && afterInvite.from.username === 'inv1_host', `AFTER the handoff, the invite still credits the ORIGINAL host, not the new owner (got ${afterInvite && afterInvite.from && afterInvite.from.username})`);

  const invSessionView = await get(`/api/sessions/${s.id}`, invitee.token);
  ok(invSessionView.invitedById === host.id, `the invitee's own session view also resolves the real inviter, not the current creator (got invitedById=${invSessionView.invitedById}, creatorId=${invSessionView.creatorId})`);

  // The new owner re-saving the invite list (still including the same still-pending invitee)
  // must NOT silently re-credit that invite to themselves -- only a genuinely NEW invitee added
  // in this edit should be credited to whoever is editing it now.
  const thirdParty = await reg('inv1_third');
  // The new owner has to actually be CONNECTED to re-save someone into the invite list (same
  // eligibility rule as inviting at creation time -- see resolveInvites/connectionsOf) -- heir was
  // never connected to the still-pending invitee before now, only the original host was.
  await post(`/api/follow/${invitee.id}`, {}, heir.token);
  await post(`/api/follow/${thirdParty.id}`, {}, heir.token);
  await put(`/api/sessions/${s.id}`, { inviteUsernames: ['inv1_invitee', 'inv1_third'] }, heir.token);
  const afterEditNotifs = await get('/api/notifications', invitee.token);
  const afterEditInvite = (afterEditNotifs.invites || []).find(iv => iv.sessionId === s.id);
  ok(afterEditInvite && afterEditInvite.from.username === 'inv1_host', `re-saving the SAME invite list under the new owner still credits the original host for the invitee who was already on it (got ${afterEditInvite && afterEditInvite.from && afterEditInvite.from.username})`);

  const thirdNotifs = await get('/api/notifications', thirdParty.token);
  const thirdInvite = (thirdNotifs.invites || []).find(iv => iv.sessionId === s.id);
  ok(thirdInvite && thirdInvite.from.username === 'inv1_heir', `a genuinely NEW invitee added in that same edit is correctly credited to whoever just invited them (got ${thirdInvite && thirdInvite.from && thirdInvite.from.username})`);
}

try { srv && srv.kill(); } catch {}
rmSync(DIR, { recursive: true, force: true });
await testDb.drop();

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
