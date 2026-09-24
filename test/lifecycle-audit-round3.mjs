// Sep 24 2026 (Jeff: "go through all the avenues of a workout with people... what else can you
// find like this" -- a third, broader audit round covering the ENTIRE multi-person workout
// lifecycle, not just the departure/ownership-handoff family the first two rounds fixed). Five
// parallel audits (creation/invites, joining, live collaboration, the posted-recap social layer,
// and cross-cutting relationship changes) turned up a long list of real bugs; Jeff: "lets build
// through all of these - i want to ship them all together." This file covers the highest-severity
// and most load-bearing fixes from that list with real HTTP requests against a real server + real
// Postgres, same harness family as participant-departure-cleanup.mjs.
//
// Covered here:
//   1. The block-privacy cluster: blocking someone stopped actually separating you in a shared
//      workout (live chat, the shared log sheet, and join-request approval never re-checked
//      isBlocked at all -- only canSeePostAuthor's recap path did).
//   2. PUT /api/sessions/:id (Edit workout, exercise list) could silently RESURRECT an exercise
//      everyone just unanimously approved removing, or REVERT an approved swap's rename, purely
//      because a stale Edit-session form still reflected the pre-change state.
//   3. trainedWith (the posted recap's "with @X" credit line) used to credit anyone who was a
//      current participant at post time, even someone approved into the workout who never logged
//      a single set.
//   4. joinableHiddenBy (who swiped to hide this workout from their own feed) leaked to the
//      session's own creator/participants via sessionView's member-tier spread.
//   5. POST /log accepted a set logged against an exerciseId that no longer exists on a real
//      (non-empty) exercise list, permanently filing it under a garbage internal id.
//   6. Two participants could each get a pending swap suggestion in on the SAME exercise at once.
//   7. PUT invite-list edits could silently re-invite an already-joined participant (hiding their
//      own active workout from Home) and sent no notification for a brand-new invitee.
//   8. Declining an invite left a stale invitedBy attribution entry behind.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const J = { 'Content-Type': 'application/json' };
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('lifecycleaudit3');

function boot(port, dir) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    srv.stdout.on('data', d => { if (String(d).includes('CrewFit on')) res(srv); });
    srv.on('exit', () => res(null));
    setTimeout(() => res(null), 15000);
  });
}

const DIR = mkdtempSync(join(tmpdir(), 'lifecycleaudit3-'));
const PORT = 4983, B = `http://localhost:${PORT}`;
const srv = await boot(PORT, DIR);
ok(!!srv, 'server boots');

const post = (p, b, tok) => fetch(B + p, { method: 'POST', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b) }).then(r => r.json());
const put = (p, b, tok) => fetch(B + p, { method: 'PUT', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b) }).then(r => r.json());
const get = (p, tok) => fetch(B + p, { headers: tok ? { Authorization: 'Bearer ' + tok } : {} }).then(r => r.json());
const getRaw = (p, tok, extraHeaders) => fetch(B + p, { headers: { ...(tok ? { Authorization: 'Bearer ' + tok } : {}), ...(extraHeaders || {}) } });
const reg = async (username) => { const r = await post('/api/register', { username, pin: 'pass1234', displayName: username }); return { token: r.token, id: r.user.id, user: r.user }; };
const connect = async (a, b) => { await post(`/api/follow/${b.id}`, {}, a.token); };

console.log('\n1a. Block cluster: a blocked co-participant can no longer read or post in the shared workout chat');
{
  const host = await reg('blk1_host');
  const other = await reg('blk1_other');
  await connect(host, other);
  const s = await post('/api/sessions', { name: 'Push Day', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Bench Press' }], visibility: 'private', inviteUsernames: ['blk1_other'] }, host.token);
  await post(`/api/sessions/${s.id}/accept`, {}, other.token);
  await post(`/api/sessions/${s.id}/comments`, { text: 'ready when you are' }, other.token);
  const beforeBlock = await get(`/api/sessions/${s.id}/comments`, host.token);
  ok(beforeBlock.length === 1, `sanity: the comment is visible before any block (got ${JSON.stringify(beforeBlock)})`);
  await post(`/api/block/${other.id}`, {}, host.token);
  const afterBlockHost = await get(`/api/sessions/${s.id}/comments`, host.token);
  ok(Array.isArray(afterBlockHost) && afterBlockHost.length === 0, `host no longer sees the blocked participant's chat message (got ${JSON.stringify(afterBlockHost)})`);
  const afterBlockOther = await get(`/api/sessions/${s.id}/comments`, other.token);
  ok(Array.isArray(afterBlockOther) && afterBlockOther.length === 1, `the blocked participant STILL sees their own old message when they view the thread themselves -- only the OTHER side of the block is hidden, from each side (got ${JSON.stringify(afterBlockOther)})`);
  const postAttempt = await post(`/api/sessions/${s.id}/comments`, { text: 'still here' }, other.token);
  const afterPostAttempt = await get(`/api/sessions/${s.id}/comments`, host.token);
  ok(Array.isArray(afterPostAttempt) && afterPostAttempt.length === 0, `a NEW message from the blocked participant still doesn't reach the host's view (got ${JSON.stringify(afterPostAttempt)})`);
}

console.log('\n1b. Block cluster: a blocked co-participant\'s logged sets no longer show in the shared log sheet');
{
  const host = await reg('blk2_host');
  const other = await reg('blk2_other');
  await connect(host, other);
  const s = await post('/api/sessions', { name: 'Leg Day', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Squat' }], visibility: 'private', inviteUsernames: ['blk2_other'] }, host.token);
  await post(`/api/sessions/${s.id}/accept`, {}, other.token);
  const exId = (await get(`/api/sessions/${s.id}`, host.token)).exercises[0].id;
  await post(`/api/sessions/${s.id}/log`, { exerciseId: exId, weight: 225, reps: 5 }, other.token);
  const beforeBlock = await get(`/api/sessions/${s.id}`, host.token);
  ok(Array.isArray(beforeBlock.logs[other.id]) && beforeBlock.logs[other.id].length === 1, 'sanity: host sees the other participant\'s set before any block');
  await post(`/api/block/${other.id}`, {}, host.token);
  const afterBlock = await get(`/api/sessions/${s.id}`, host.token);
  ok(!afterBlock.logs[other.id], `host no longer sees the blocked participant's logged sets at all (got ${JSON.stringify(afterBlock.logs)})`);
  const ownStillThere = await get(`/api/sessions/${s.id}`, host.token);
  ok(Array.isArray(ownStillThere.logs[host.id] || []), 'the block never hides the VIEWER\'s own sets (sanity on the uid===viewerId branch)');
}

console.log('\n1c. Block cluster: approving a join request re-checks block at the moment of decision');
{
  const host = await reg('blk3_host');
  const joiner = await reg('blk3_joiner');
  const s = await post('/api/sessions', { name: 'Open Session', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Row' }], visibility: 'public' }, host.token);
  const jr = await post(`/api/sessions/${s.id}/join`, { note: 'let me in' }, joiner.token);
  ok(jr.requested === true, 'the join request itself is filed');
  const after = await get(`/api/sessions/${s.id}`, host.token);
  const reqId = after.joinRequests[0].id;
  await post(`/api/block/${joiner.id}`, {}, host.token);
  const approve = await post(`/api/sessions/${s.id}/join/${reqId}/approve`, {}, host.token);
  ok(approve.error === 'blocked', `approving a join request from someone now blocked is refused (got ${JSON.stringify(approve)})`);
  const finalState = await get(`/api/sessions/${s.id}`, host.token);
  ok(!(finalState.participants || []).includes(joiner.id), 'the blocked requester was never actually added as a participant');
}

console.log('\n2a. PUT /api/sessions/:id: a stale Edit-session save cannot resurrect an exercise everyone just unanimously approved removing');
{
  const host = await reg('res1_host');
  const other = await reg('res1_other');
  await connect(host, other);
  const s = await post('/api/sessions', { name: 'Full Body', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Bench Press' }, { name: 'Squat' }], visibility: 'private', inviteUsernames: ['res1_other'] }, host.token);
  await post(`/api/sessions/${s.id}/accept`, {}, other.token);
  const before = await get(`/api/sessions/${s.id}`, host.token);
  const benchId = before.exercises.find(e => e.name === 'Bench Press').id;
  const squatId = before.exercises.find(e => e.name === 'Squat').id;
  await post(`/api/sessions/${s.id}/log`, { exerciseId: benchId, weight: 135, reps: 8 }, other.token);
  // Host edits the list, dropping Bench -- since `other` has sets logged on it, this opens a
  // pendingRemovals request instead of removing it outright.
  const editedList = before.exercises.map(e => ({ id: e.id, name: e.name }));
  const withoutBench = editedList.filter(e => e.id !== benchId);
  const afterDrop = await put(`/api/sessions/${s.id}`, { exercises: withoutBench }, host.token);
  const pr = afterDrop.pendingRemovals.find(p => p.exerciseId === benchId);
  ok(pr && pr.status === 'pending', `dropping Bench opened a pending removal request instead of deleting it outright (got ${JSON.stringify(afterDrop.pendingRemovals)})`);
  // `other` approves -- unanimous consent, Bench is genuinely gone now.
  await post(`/api/sessions/${s.id}/removal/${pr.id}/approve`, {}, other.token);
  const afterApprove = await get(`/api/sessions/${s.id}`, host.token);
  ok(!afterApprove.exercises.find(e => e.id === benchId), 'Bench is genuinely gone from the shared plan after unanimous approval');
  // Host's Edit-session FORM was opened before any of this and still has the OLD full list
  // (Bench + Squat) -- simulating that stale form being saved now.
  const staleSave = await put(`/api/sessions/${s.id}`, { exercises: editedList }, host.token);
  ok(!staleSave.exercises.find(e => e.id === benchId), `the stale save (still listing Bench by its old id) does NOT resurrect it (got ${JSON.stringify(staleSave.exercises.map(e => e.name))})`);
  ok(staleSave.exercises.some(e => e.id === squatId), 'Squat (never touched by the removal) is untouched by the guard');
}

console.log('\n2b. PUT /api/sessions/:id: a stale Edit-session save cannot revert an approved swap\'s rename');
{
  const host = await reg('res2_host');
  const other = await reg('res2_other');
  await connect(host, other);
  const s = await post('/api/sessions', { name: 'Pull Day', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Cable Row' }], visibility: 'private', inviteUsernames: ['res2_other'] }, host.token);
  await post(`/api/sessions/${s.id}/accept`, {}, other.token);
  const before = await get(`/api/sessions/${s.id}`, host.token);
  const exId = before.exercises[0].id;
  // Host's Edit-session form loaded here, while the exercise was still "Cable Row".
  const staleList = [{ id: exId, name: 'Cable Row' }];
  // Meanwhile `other` proposes a swap and the host approves it from the live suggestion card (a
  // DIFFERENT UI surface than the still-open Edit-session form).
  const suggest = await post(`/api/sessions/${s.id}/suggest`, { exerciseId: exId, swapTo: 'Barbell Row' }, other.token);
  const editId = suggest.suggestedEdits.find(e => e.exerciseId === exId && e.status === 'pending').id;
  await post(`/api/sessions/${s.id}/suggest/${editId}/approve`, {}, host.token);
  const afterSwap = await get(`/api/sessions/${s.id}`, host.token);
  ok(afterSwap.exercises[0].name === 'Barbell Row', 'the swap is approved and the shared exercise is genuinely renamed');
  // Now the stale form (still showing "Cable Row") gets saved.
  const staleSave = await put(`/api/sessions/${s.id}`, { exercises: staleList }, host.token);
  ok(staleSave.exercises[0].name === 'Barbell Row', `the stale save does NOT revert the approved rename (got "${staleSave.exercises[0].name}")`);
}

console.log('\n2c. A GENUINE intentional rename (not matching any approved swap) still goes through untouched');
{
  const host = await reg('res3_host');
  const s = await post('/api/sessions', { name: 'Solo', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Lunge' }], visibility: 'private' }, host.token);
  const before = await get(`/api/sessions/${s.id}`, host.token);
  const exId = before.exercises[0].id;
  const renamed = await put(`/api/sessions/${s.id}`, { exercises: [{ id: exId, name: 'Walking Lunge' }] }, host.token);
  ok(renamed.exercises[0].name === 'Walking Lunge', `an ordinary rename with no swap history at all still applies normally (got "${renamed.exercises[0].name}")`);
}

console.log('\n3. trainedWith only credits a participant who actually logged something, not everyone merely approved into the workout');
{
  const host = await reg('tw1_host');
  const joiner = await reg('tw1_joiner');
  const s = await post('/api/sessions', { name: 'Open Workout', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Deadlift' }], visibility: 'public' }, host.token);
  const jr = await post(`/api/sessions/${s.id}/join`, {}, joiner.token);
  const withReq = await get(`/api/sessions/${s.id}`, host.token);
  await post(`/api/sessions/${s.id}/join/${withReq.joinRequests[0].id}/approve`, {}, host.token);
  // `joiner` never logs a single set. Host finishes and posts a recap.
  const exId = withReq.exercises[0].id;
  await post(`/api/sessions/${s.id}/log`, { exerciseId: exId, weight: 315, reps: 3 }, host.token);
  const posted = await post(`/api/sessions/${s.id}/post`, { notes: 'good session', media: [], visibility: 'public' }, host.token);
  const myPost = posted.posts[host.id];
  ok(Array.isArray(myPost.trainedWith) && !myPost.trainedWith.includes(joiner.id), `a joiner who never logged anything is NOT credited as a training partner (got trainedWith=${JSON.stringify(myPost.trainedWith)})`);
}

console.log('\n4. joinableHiddenBy no longer leaks to the session\'s own creator/participants');
{
  const host = await reg('jhb1_host');
  const hider = await reg('jhb1_hider');
  const s = await post('/api/sessions', { name: 'Public Workout', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Bench Press' }], visibility: 'public' }, host.token);
  await post(`/api/sessions/${s.id}/hide-joinable`, {}, hider.token);
  const creatorView = await get(`/api/sessions/${s.id}`, host.token);
  ok(creatorView.joinableHiddenBy === undefined, `the raw joinableHiddenBy array is stripped from the creator's own session view (got ${JSON.stringify(creatorView.joinableHiddenBy)})`);
  ok(creatorView.hiddenForMe === false, 'the creator gets their OWN scoped boolean instead (false -- they didn\'t hide it)');
}

console.log('\n5. POST /log rejects logging against an exerciseId that is not on a real, populated exercise list');
{
  const host = await reg('logid1_host');
  const s = await post('/api/sessions', { name: 'Real Workout', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Bench Press' }], visibility: 'private' }, host.token);
  const bad = await post(`/api/sessions/${s.id}/log`, { exerciseId: 'e_totally_made_up', weight: 100, reps: 5 }, host.token);
  ok(bad.error === 'exercise not found', `logging against a nonexistent exerciseId on a populated exercise list is refused (got ${JSON.stringify(bad)})`);
  const real = await get(`/api/sessions/${s.id}`, host.token);
  const good = await post(`/api/sessions/${s.id}/log`, { exerciseId: real.exercises[0].id, weight: 100, reps: 5 }, host.token);
  ok(good.id && !good.error, `a real exerciseId still logs normally (got ${JSON.stringify(good)})`);
}

console.log('\n6. Two participants cannot each get a pending swap suggestion in on the same exercise at once');
{
  const host = await reg('dupswap1_host');
  const a = await reg('dupswap1_a');
  const b = await reg('dupswap1_b');
  await connect(host, a); await connect(host, b);
  const s = await post('/api/sessions', { name: 'Group Workout', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Cable Fly' }], visibility: 'private', inviteUsernames: ['dupswap1_a', 'dupswap1_b'] }, host.token);
  await post(`/api/sessions/${s.id}/accept`, {}, a.token);
  await post(`/api/sessions/${s.id}/accept`, {}, b.token);
  const exId = (await get(`/api/sessions/${s.id}`, host.token)).exercises[0].id;
  const first = await post(`/api/sessions/${s.id}/suggest`, { exerciseId: exId, swapTo: 'Pec Deck' }, a.token);
  ok(first.suggestedEdits && first.suggestedEdits.some(e => e.exerciseId === exId && e.status === 'pending'), 'the first swap suggestion goes through');
  const second = await post(`/api/sessions/${s.id}/suggest`, { exerciseId: exId, swapTo: 'Dumbbell Fly' }, b.token);
  ok(second.error === 'a swap is already pending for this exercise', `a second, conflicting swap on the SAME exercise while one is already pending is refused (got ${JSON.stringify(second)})`);
}

console.log('\n7a. PUT invite-list edits cannot re-add an already-joined participant to the invited list');
{
  const host = await reg('editinv1_host');
  const other = await reg('editinv1_other');
  await connect(host, other);
  const s = await post('/api/sessions', { name: 'Session', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Bench Press' }], visibility: 'private', inviteUsernames: ['editinv1_other'] }, host.token);
  await post(`/api/sessions/${s.id}/accept`, {}, other.token);
  const edited = await put(`/api/sessions/${s.id}`, { inviteUsernames: ['editinv1_other'] }, host.token);
  ok(!(edited.invited || []).includes(other.id), `re-checking the already-joined participant's box does NOT put them back on the invited list (got invited=${JSON.stringify(edited.invited)})`);
  const otherView = await get(`/api/sessions/${s.id}`, other.token);
  ok(otherView.invitedById === undefined, 'and their own session view correctly shows no pending invite for a workout they are already in');
}

console.log('\n7b. PUT invite-list edits notify a brand-new invitee, and dedupe repeated/case-variant usernames');
{
  const host = await reg('editinv2_host');
  const newFriend = await reg('editinv2_new');
  await connect(host, newFriend);
  const s = await post('/api/sessions', { name: 'Session', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Bench Press' }], visibility: 'private' }, host.token);
  const edited = await put(`/api/sessions/${s.id}`, { inviteUsernames: ['editinv2_new', 'EditInv2_New'] }, host.token);
  ok(Array.isArray(edited.invited) && edited.invited.filter(x => x === newFriend.id).length === 1, `a duplicate/case-variant submission of the same person only lands ONCE (got ${JSON.stringify(edited.invited)})`);
  const notifs = await get('/api/notifications', newFriend.token);
  ok((notifs.invites || []).some(i => i.sessionId === s.id), `the brand-new invitee added via Edit-session gets notified (got invites=${JSON.stringify(notifs.invites)})`);
}

console.log('\n8. Declining an invite clears the stale invitedBy attribution, so a later re-invite by someone else credits correctly');
{
  const host = await reg('decl1_host');
  const heir = await reg('decl1_heir');
  const invitee = await reg('decl1_invitee');
  await connect(host, heir); await connect(host, invitee); await connect(heir, invitee);
  const s = await post('/api/sessions', { name: 'Session', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Bench Press' }], visibility: 'private', inviteUsernames: ['decl1_invitee', 'decl1_heir'] }, host.token);
  await post(`/api/sessions/${s.id}/decline`, {}, invitee.token);
  await post(`/api/sessions/${s.id}/accept`, {}, heir.token);
  // host leaves, ownership hands off to heir
  await post(`/api/sessions/${s.id}/leave`, {}, host.token);
  const afterHandoff = await get(`/api/sessions/${s.id}`, heir.token);
  ok(afterHandoff.creatorId === heir.id, 'sanity: ownership really did hand off to heir');
  const reinvited = await put(`/api/sessions/${s.id}`, { inviteUsernames: ['decl1_invitee'] }, heir.token);
  ok((reinvited.invited || []).includes(invitee.id), 'heir successfully re-invites the person who originally declined');
  const inviteeView = await get(`/api/sessions/${s.id}`, invitee.token);
  ok(inviteeView.invitedById === heir.id, `the re-invite is correctly credited to HEIR (who just sent it), not the original host whose invite they declined (got invitedById=${inviteeView.invitedById})`);
}

console.log('\n9. Media token: recap photo URLs are gated by a real access check, not served unconditionally');
{
  const author = await reg('media1_author');
  const stranger = await reg('media1_stranger');
  const tokenResp = await get('/api/media-token', author.token);
  ok(typeof tokenResp.token === 'string' && tokenResp.token.length > 10, `GET /api/media-token returns a signed token for a logged-in user (got ${JSON.stringify(tokenResp)})`);
  const s = await post('/api/sessions', { name: 'Solo', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Bench Press' }], visibility: 'private' }, author.token);
  const exId = (await get(`/api/sessions/${s.id}`, author.token)).exercises[0].id;
  await post(`/api/sessions/${s.id}/log`, { exerciseId: exId, weight: 100, reps: 5 }, author.token);
  const posted = await post(`/api/sessions/${s.id}/post`, {
    notes: 'note', visibility: 'private',
    media: [{ type: 'image', src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' }],
  }, author.token);
  const media = posted.posts[author.id].media;
  ok(media.length === 1 && typeof media[0].src === 'string' && media[0].src.startsWith('/uploads/post_'), `the recap photo was saved to /uploads/post_... (got ${JSON.stringify(media)})`);
  const fname = media[0].src.split('/').pop();
  const noToken = await getRaw(`/uploads/${fname}`);
  ok(noToken.status === 401, `fetching the file with no media token at all is refused (got ${noToken.status})`);
  const authorTok = (await get('/api/media-token', author.token)).token;
  const asAuthor = await getRaw(`/uploads/${fname}?tok=${encodeURIComponent(authorTok)}`);
  ok(asAuthor.status === 200, `the author, with their own valid media token, can load their own private recap photo (got ${asAuthor.status})`);
  const strangerTok = (await get('/api/media-token', stranger.token)).token;
  const asStranger = await getRaw(`/uploads/${fname}?tok=${encodeURIComponent(strangerTok)}`);
  ok(asStranger.status === 403, `a stranger with a VALID media token (but no right to see this private post) is refused (got ${asStranger.status})`);
}

try { srv && srv.kill(); } catch (e) {}
rmSync(DIR, { recursive: true, force: true });
await testDb.drop();

console.log(`\n${fails ? fails + ' FAILURE(S)' : 'all assertions passed'}`);
process.exit(fails ? 1 : 0);
