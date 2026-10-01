// Oct 1 2026 -- permanent coverage for the round-2 audit's Tier 2 finding (privacy/block-bypass
// leak): a PENDING workout invite kept working as a live, full-plan-revealing 'invited' tier even
// after either side blocked the other, unlike every sibling gate in server.js (canSeeProfile,
// canSeePostAuthor, the member-tier filters, followRequests/joinRequests/removals' own block
// filters). Fixed in seven places, all covered here:
//   1. sessionTier() -- the 'invited' branch now requires !isBlocked(inviterId, viewerId), so a
//      blocked pending invite no longer grants GET /api/sessions/:id the full plan (location,
//      notes, exercises) and no longer appears at all in GET /api/sessions (Home's invite banner).
//      inviterId resolves through s.invitedBy (falling back to s.creatorId) rather than checking
//      the bare s.creatorId -- a first pass at this fix checked bare s.creatorId and a cold-review
//      pass caught that it silently stopped working the moment a session goes ownerless
//      (s.creatorId -> null, permanent, once its creator /leave's -- see that route's own
//      comment), since isBlocked(null, viewerId) always evaluates false. See the last test block
//      below for the regression test covering exactly that scenario.
//   2. POST /api/sessions/:id/accept -- the pre-existing isBlocked(s.creatorId, req.userId) check
//      (from an earlier, Sep 24 2026 audit round) had the identical ownerless-session gap, fixed
//      the same way, same inviterId resolution.
//   3. GET /api/notifications' own `invites` list -- now filters out a blocked fromId, matching the
//      followRequests/joinRequests/removals filters right next to it. This one already resolved
//      through s.invitedBy from the start, so it never had the ownerless-session gap.
//   4. POST /api/sessions/:id/suggest -- a cold-review pass on this round's fix found this route
//      had its OWN separate, bare s.invited.includes() authorization check with no block-
//      awareness at all, letting a blocked still-invited caller create a real suggestedEdits row
//      (visible to non-blocked co-participants, approvable by the creator) even after sessionTier
//      had already stopped showing them the plan. Fixed with the same inviterId resolution.
//   5. POST /api/sessions/:id/suggest/:editId/approve and .../reject -- Jeff-flagged follow-up,
//      found during this round's own cold review and explicitly asked for by name ("lets fix the
//      flagged issue also"): sessionView's own suggestedEdits filter already hides a blocked
//      proposer's pending suggestion from the creator's own GET response, but a direct POST to
//      approve/reject with that still-live editId had no isBlocked check at all -- so it still
//      renamed the shared exercise (approve) or flipped the status (reject), a real interaction
//      with someone the creator had blocked, regardless of whether the proposer happened to still
//      be a current participant. Both now refuse with {error:'blocked'} the same way /accept does.
//   6. voteOwnerless() -- same follow-up, same "yes fix it all": once a session has gone
//      ownerless, suggestions are decided by group vote (every current participant, via the same
//      .../suggest/:editId/approve|reject routes, just delegated to this function instead) rather
//      than one creator deciding. It had the identical missing isBlocked check as point 5's
//      owned-session version -- a blocked co-participant's vote could still apply their own
//      variation from a swap, or still count toward (or permanently block, via reject) an 'add'
//      suggestion's unanimous-consensus requirement (maybeResolveOwnerlessAdd). Fixed the same way.
//   7. app.js acceptInvite()/notifAcceptInvite() -- now check the response for an error (the
//      pre-existing POST /api/sessions/:id/accept 400 {error:'blocked'}) instead of discarding it
//      and opening the session regardless. Not exercised here (no browser in this file) -- see
//      CLAUDE.md's own note on why a fetch-only test can't cover a client-side DOM/JS fix; the
//      server-side close (points 1, 2, 4, 5, 6) already makes this path unreachable in normal
//      use, which is what this file proves.
// Run:  npm test
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';

const PORT = process.env.TEST_PORT_OCT1T2 || 4985;
const B = `http://localhost:${PORT}`;
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('oct1tier2');
let fails = 0, srv = null;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const J = { 'Content-Type': 'application/json' };

function boot(dir) {
  return new Promise((res, rej) => {
    srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(PORT) },
      cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    srv.stderr.on('data', d => { err += d; });
    srv.stdout.on('data', d => { if (String(d).includes('CrewFit on')) res(); });
    srv.on('exit', c => rej(new Error(`server exited (${c}):\n${err}`)));
    setTimeout(() => rej(new Error('server never started:\n' + err)), 15000);
  });
}
const DIR = mkdtempSync(join(tmpdir(), 'oct1tier2-'));
await boot(DIR);

async function api(path, method, token, body) {
  const r = await fetch(B + path, { method, headers: { ...J, ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
}
const post = (p, b, tok) => api(p, 'POST', tok, b).then(r => r.body);
const postFull = (p, b, tok) => api(p, 'POST', tok, b);
const getFull = (p, tok) => api(p, 'GET', tok);
const reg = (u) => post('/api/register', { username: u, pin: 'pass1234', displayName: u });

async function setupInvite(aName, bName) {
  const a = await reg(aName), b = await reg(bName);
  // A invites B needs them connected first (POST /api/sessions only sends an invite to someone
  // already in connectionsOf(inviter) -- same setup pattern account-settings.mjs's delete-account
  // block uses).
  await post('/api/follow/' + b.user.id, {}, a.token);
  await post('/api/follow-requests/' + a.user.id + '/accept', {}, b.token);
  const s = await post('/api/sessions', { name: 'Push Day', visibility: 'private', scheduledAt: new Date().toISOString(),
    exercises: [{ name: 'Overhead Press' }], inviteUsernames: [b.user.username] }, a.token);
  return { a, b, s };
}

console.log('A blocks B after inviting them: B loses the pending invite entirely -- GET /api/sessions, GET /api/sessions/:id, and GET /api/notifications all stop showing it');
{
  const { a, b, s } = await setupInvite('oct1t2_a1', 'oct1t2_b1');
  const beforeList = await api('/api/sessions', 'GET', b.token).then(r => r.body);
  ok(beforeList.some(x => x.id === s.id), 'sanity: before any block, B sees the invite in GET /api/sessions');
  const beforeDetail = await getFull('/api/sessions/' + s.id, b.token);
  ok(beforeDetail.status === 200 && beforeDetail.body.location !== undefined, 'sanity: before any block, GET /api/sessions/:id hands B the full plan under the invited tier');
  const beforeNotif = await api('/api/notifications', 'GET', b.token).then(r => r.body);
  ok((beforeNotif.invites || []).some(x => x.sessionId === s.id), 'sanity: before any block, the invite shows up in B\'s notifications inbox');

  await post('/api/block/' + b.user.id, {}, a.token);

  const afterList = await api('/api/sessions', 'GET', b.token).then(r => r.body);
  ok(!afterList.some(x => x.id === s.id), 'after A blocks B, the session no longer appears in GET /api/sessions at all (Home\'s invite banner would show nothing)');
  const afterDetail = await getFull('/api/sessions/' + s.id, b.token);
  ok(afterDetail.status === 403, `GET /api/sessions/:id now refuses outright instead of handing over the full plan (got ${afterDetail.status})`);
  const afterNotif = await api('/api/notifications', 'GET', b.token).then(r => r.body);
  ok(!(afterNotif.invites || []).some(x => x.sessionId === s.id), 'the invite no longer shows up in B\'s notifications inbox either');

  const acceptAttempt = await postFull('/api/sessions/' + s.id + '/accept', {}, b.token);
  ok(acceptAttempt.status === 400 && acceptAttempt.body.error === 'blocked', `accept is still correctly refused if somehow attempted anyway (got ${acceptAttempt.status}, ${JSON.stringify(acceptAttempt.body)})`);

  const suggestAttempt = await postFull('/api/sessions/' + s.id + '/suggest', { exerciseId: s.exercises[0].id, swapTo: 'Incline Press' }, b.token);
  ok(suggestAttempt.status === 403, `a blocked still-invited caller can no longer call POST /suggest directly either (got ${suggestAttempt.status}, ${JSON.stringify(suggestAttempt.body)})`);
}

console.log('\nsame leak, other direction: B blocks A (the inviter) instead of A blocking B');
{
  const { a, b, s } = await setupInvite('oct1t2_a2', 'oct1t2_b2');
  await post('/api/block/' + a.user.id, {}, b.token);
  const afterList = await api('/api/sessions', 'GET', b.token).then(r => r.body);
  ok(!afterList.some(x => x.id === s.id), 'B blocking A (not the other way around) hides the invite too -- isBlocked is symmetric');
  const afterDetail = await getFull('/api/sessions/' + s.id, b.token);
  ok(afterDetail.status === 403, `GET /api/sessions/:id refuses this direction too (got ${afterDetail.status})`);
}

console.log('\nunblocking restores the invite -- this hides a blocked invite, it does not silently cancel it');
{
  const { a, b, s } = await setupInvite('oct1t2_a3', 'oct1t2_b3');
  await post('/api/block/' + b.user.id, {}, a.token);
  const hiddenList = await api('/api/sessions', 'GET', b.token).then(r => r.body);
  ok(!hiddenList.some(x => x.id === s.id), 'sanity: hidden while blocked');

  await post('/api/unblock/' + b.user.id, {}, a.token);
  const restoredList = await api('/api/sessions', 'GET', b.token).then(r => r.body);
  ok(restoredList.some(x => x.id === s.id), 'after unblocking, the same still-pending invite reappears in GET /api/sessions');
  const restoredDetail = await getFull('/api/sessions/' + s.id, b.token);
  ok(restoredDetail.status === 200, `and GET /api/sessions/:id works again (got ${restoredDetail.status})`);
  const acceptNow = await postFull('/api/sessions/' + s.id + '/accept', {}, b.token);
  ok(acceptNow.status === 200, `and B can genuinely accept it now that the block is gone (got ${acceptNow.status}, ${JSON.stringify(acceptNow.body)})`);
}

console.log('\nscope check: this does NOT touch an ALREADY-joined member -- blocking after acceptance leaves shared session access alone, same as blockUser\'s own deliberate "nothing about a session you already trained together is touched" rule');
{
  const { a, b, s } = await setupInvite('oct1t2_a4', 'oct1t2_b4');
  const accept = await postFull('/api/sessions/' + s.id + '/accept', {}, b.token);
  ok(accept.status === 200, `sanity: B accepts before any block exists (got ${accept.status})`);

  await post('/api/block/' + b.user.id, {}, a.token);

  const stillInList = await api('/api/sessions', 'GET', b.token).then(r => r.body);
  ok(stillInList.some(x => x.id === s.id), 'B is still a real participant/member of the session after the block -- membership itself is untouched, only the PENDING-invite path was fixed');
  const stillDetail = await getFull('/api/sessions/' + s.id, b.token);
  ok(stillDetail.status === 200, `GET /api/sessions/:id still works for an already-joined member (got ${stillDetail.status})`);
}

console.log('\nregression check: an invite between two people who never block each other is completely unaffected');
{
  const { a, b, s } = await setupInvite('oct1t2_a5', 'oct1t2_b5');
  const list = await api('/api/sessions', 'GET', b.token).then(r => r.body);
  ok(list.some(x => x.id === s.id), 'ordinary invite still shows up in GET /api/sessions');
  const notif = await api('/api/notifications', 'GET', b.token).then(r => r.body);
  ok((notif.invites || []).some(x => x.sessionId === s.id), 'and in the notifications inbox');
  // Regression check for the POST /suggest fix specifically: a still-invited (never blocked)
  // caller proposing a pre-join swap -- the whole point of letting an invitee suggest before
  // accepting (see the route's own "I'll come if we swap Barbell Row" comment) -- must still work.
  const suggest = await postFull('/api/sessions/' + s.id + '/suggest', { exerciseId: s.exercises[0].id, swapTo: 'Incline Press' }, b.token);
  ok(suggest.status === 200, `a never-blocked still-invited caller can still propose a pre-join swap (got ${suggest.status}, ${JSON.stringify(suggest.body)})`);
  const accept = await postFull('/api/sessions/' + s.id + '/accept', {}, b.token);
  ok(accept.status === 200, `and accepting it still works normally (got ${accept.status})`);
}

console.log('\nownerless-session edge case (cold-review catch): creator leaves (s.creatorId -> null, permanently) while an invite is still pending, THEN a block happens against the ORIGINAL inviter -- isBlocked(null, viewerId) always evaluates false, so checking the bare (now-null) s.creatorId would silently stop catching this block the instant the session went ownerless');
{
  const a = await reg('oct1t2_a6'), b = await reg('oct1t2_b6'), c = await reg('oct1t2_c6');
  await post('/api/follow/' + b.user.id, {}, a.token);
  await post('/api/follow-requests/' + a.user.id + '/accept', {}, b.token);
  await post('/api/follow/' + c.user.id, {}, a.token);
  await post('/api/follow-requests/' + a.user.id + '/accept', {}, c.token);
  const s = await post('/api/sessions', { name: 'Leg Day', visibility: 'private', scheduledAt: new Date().toISOString(),
    exercises: [{ name: 'Squat' }], inviteUsernames: [b.user.username, c.user.username] }, a.token);

  // B accepts so A has someone to leave to (/leave refuses a creator with nobody else current or
  // credited) -- C deliberately stays pending.
  const bAccept = await postFull('/api/sessions/' + s.id + '/accept', {}, b.token);
  ok(bAccept.status === 200, `sanity: B accepts, becomes a real current participant (got ${bAccept.status})`);

  // A (the creator) leaves -- s.creatorId goes permanently null, but /leave only clears the
  // LEAVER's own s.invited/s.invitedBy entries, not C's still-pending one.
  const aLeave = await postFull('/api/sessions/' + s.id + '/leave', { keep: true }, a.token);
  ok(aLeave.status === 200, `sanity: A leaves cleanly since B is still a current participant (got ${aLeave.status})`);

  const cSeesPending = await api('/api/sessions', 'GET', c.token).then(r => r.body);
  ok(cSeesPending.some(x => x.id === s.id), 'sanity: C\'s invite survives the creator leaving -- still pending, now on an ownerless session');
  const cDetailPending = await getFull('/api/sessions/' + s.id, c.token);
  ok(cDetailPending.status === 200 && cDetailPending.body.location !== undefined, 'sanity: C still gets the full plan under the invited tier, ownerless session and all');

  // The block that matters: between C and the ORIGINAL inviter A -- not the (now-null) current creatorId.
  await post('/api/block/' + c.user.id, {}, a.token);

  const cAfterList = await api('/api/sessions', 'GET', c.token).then(r => r.body);
  ok(!cAfterList.some(x => x.id === s.id), 'after A (the original inviter, now departed) blocks C, the ownerless session\'s pending invite is hidden from GET /api/sessions -- exactly what a bare isBlocked(s.creatorId, ...) check would have missed, since s.creatorId is null here');
  const cAfterDetail = await getFull('/api/sessions/' + s.id, c.token);
  ok(cAfterDetail.status === 403, `GET /api/sessions/:id now refuses instead of leaking the full plan (got ${cAfterDetail.status})`);
  const cAfterNotif = await api('/api/notifications', 'GET', c.token).then(r => r.body);
  ok(!(cAfterNotif.invites || []).some(x => x.sessionId === s.id), 'the notifications inbox agrees too (it already resolved through s.invitedBy before this round\'s fix, so this one was never broken -- kept as a consistency check)');
  const cAcceptAttempt = await postFull('/api/sessions/' + s.id + '/accept', {}, c.token);
  ok(cAcceptAttempt.status === 400 && cAcceptAttempt.body.error === 'blocked', `and accept is refused too -- same ownerless-session fix applied to this route's own isBlocked check (got ${cAcceptAttempt.status}, ${JSON.stringify(cAcceptAttempt.body)})`);
  const cSuggestAttempt = await postFull('/api/sessions/' + s.id + '/suggest', { exerciseId: s.exercises[0].id, swapTo: 'Front Squat' }, c.token);
  ok(cSuggestAttempt.status === 403, `and POST /suggest is refused too on this ownerless session, same inviterId resolution (got ${cSuggestAttempt.status}, ${JSON.stringify(cSuggestAttempt.body)})`);

  // B, already a real participant before any of this happened, is completely unaffected --
  // membership scope stays exactly where blockUser's own comment says it should.
  const bStillIn = await api('/api/sessions', 'GET', b.token).then(r => r.body);
  ok(bStillIn.some(x => x.id === s.id), 'B (already an accepted participant) is untouched -- the ownerless-session invite fix never reaches membership, only the still-pending invite path');
}

console.log('\nstale-suggestion block cluster (Jeff-flagged follow-up): approving or rejecting a swap suggestion from someone you have since blocked is refused too -- even though sessionView already hides that pending row from your own GET response, a direct POST with the still-live editId used to go through anyway and would rename the shared exercise / rewrite the blocked proposer\'s own logged sets');
{
  // Case 1: proposer was still just INVITED (not yet a member) when they proposed -- the
  // deliberate "I'll come if we swap X" pre-join carve-out -- then gets blocked before the host
  // ever decides.
  const { a, b, s } = await setupInvite('oct1t2_a7', 'oct1t2_b7');
  const propose = await postFull('/api/sessions/' + s.id + '/suggest', { exerciseId: s.exercises[0].id, swapTo: 'Incline Press' }, b.token);
  ok(propose.status === 200, `sanity: still-invited B can propose a pre-join swap (got ${propose.status})`);
  const editId = propose.body.suggestedEdits.find(e => e.proposedBy === b.user.id).id;

  await post('/api/block/' + b.user.id, {}, a.token);

  const hiddenView = await getFull('/api/sessions/' + s.id, a.token);
  ok(hiddenView.status === 200 && !(hiddenView.body.suggestedEdits || []).some(e => e.id === editId), 'sanity: the pending suggestion is already invisible to A in their own GET response once B is blocked (sessionView\'s existing suggestedEdits filter)');

  const approveAttempt = await postFull('/api/sessions/' + s.id + '/suggest/' + editId + '/approve', {}, a.token);
  ok(approveAttempt.status === 400 && approveAttempt.body.error === 'blocked', `approving that same still-live editId directly is refused too, not just hidden from view (got ${approveAttempt.status}, ${JSON.stringify(approveAttempt.body)})`);
  const rejectAttempt = await postFull('/api/sessions/' + s.id + '/suggest/' + editId + '/reject', {}, a.token);
  ok(rejectAttempt.status === 400 && rejectAttempt.body.error === 'blocked', `rejecting it directly is refused the same way (got ${rejectAttempt.status}, ${JSON.stringify(rejectAttempt.body)})`);

  await post('/api/unblock/' + b.user.id, {}, a.token);
  const approveAfterUnblock = await postFull('/api/sessions/' + s.id + '/suggest/' + editId + '/approve', {}, a.token);
  ok(approveAfterUnblock.status === 200 && approveAfterUnblock.body.exercises.some(e => e.name === 'Incline Press'), `and once unblocked, the SAME still-pending suggestion can genuinely be approved -- this hides/refuses it, it does not silently discard it (got ${approveAfterUnblock.status})`);
}
{
  // Case 2: proposer is an ALREADY-ACCEPTED member when they propose, and only gets blocked
  // afterward -- membership itself stays untouched (same scope boundary as every other block fix
  // in this file), but approving/rejecting their specific pending suggestion is still a real
  // interaction and is refused the same way, matching sessionView's own suggestedEdits filter
  // (which doesn't care whether the proposer happens to still be a current participant either).
  const { a, b, s } = await setupInvite('oct1t2_a8', 'oct1t2_b8');
  const acceptFirst = await postFull('/api/sessions/' + s.id + '/accept', {}, b.token);
  ok(acceptFirst.status === 200, `sanity: B accepts and becomes a real member first (got ${acceptFirst.status})`);
  const propose = await postFull('/api/sessions/' + s.id + '/suggest', { exerciseId: s.exercises[0].id, swapTo: 'Arnold Press' }, b.token);
  ok(propose.status === 200, `sanity: B, now a member, proposes a swap (got ${propose.status})`);
  const editId = propose.body.suggestedEdits.find(e => e.proposedBy === b.user.id).id;

  await post('/api/block/' + b.user.id, {}, a.token);

  const stillMember = await api('/api/sessions', 'GET', b.token).then(r => r.body);
  ok(stillMember.some(x => x.id === s.id), 'sanity: B is still a real member after the block -- this fix does not touch membership');

  const approveAttempt = await postFull('/api/sessions/' + s.id + '/suggest/' + editId + '/approve', {}, a.token);
  ok(approveAttempt.status === 400 && approveAttempt.body.error === 'blocked', `approving a MEMBER's pending suggestion is still refused once blocked -- membership alone doesn't exempt this action (got ${approveAttempt.status}, ${JSON.stringify(approveAttempt.body)})`);
  const rejectAttempt = await postFull('/api/sessions/' + s.id + '/suggest/' + editId + '/reject', {}, a.token);
  ok(rejectAttempt.status === 400 && rejectAttempt.body.error === 'blocked', `and rejecting it is refused the same way (got ${rejectAttempt.status}, ${JSON.stringify(rejectAttempt.body)})`);
}
console.log('\nregression check: approving/rejecting an ordinary (never-blocked) suggestion still works exactly as before');
{
  const { a, b, s } = await setupInvite('oct1t2_a9', 'oct1t2_b9');
  await postFull('/api/sessions/' + s.id + '/accept', {}, b.token);
  const propose = await postFull('/api/sessions/' + s.id + '/suggest', { exerciseId: s.exercises[0].id, swapTo: 'Decline Press' }, b.token);
  const editId = propose.body.suggestedEdits.find(e => e.proposedBy === b.user.id).id;
  const approve = await postFull('/api/sessions/' + s.id + '/suggest/' + editId + '/approve', {}, a.token);
  ok(approve.status === 200 && approve.body.exercises.some(e => e.name === 'Decline Press'), `an ordinary approve between two people who never blocked each other still works normally (got ${approve.status})`);
}

console.log('\nownerless-session GROUP VOTING block cluster (Jeff: "yes fix it all" -- the voteOwnerless equivalent of the stale-suggestion fix above): once a session has gone ownerless, suggestions are decided by everyone voting rather than one creator approving -- a blocked co-participant\'s vote is refused the same way, including for an \'add\' suggestion\'s unanimous-consensus requirement');
{
  const a = await reg('oct1t2_a10'), b = await reg('oct1t2_b10'), c = await reg('oct1t2_c10');
  await post('/api/follow/' + b.user.id, {}, a.token);
  await post('/api/follow-requests/' + a.user.id + '/accept', {}, b.token);
  await post('/api/follow/' + c.user.id, {}, a.token);
  await post('/api/follow-requests/' + a.user.id + '/accept', {}, c.token);
  const s = await post('/api/sessions', { name: 'Pull Day', visibility: 'private', scheduledAt: new Date().toISOString(),
    exercises: [{ name: 'Lat Pulldown' }], inviteUsernames: [b.user.username, c.user.username] }, a.token);
  await postFull('/api/sessions/' + s.id + '/accept', {}, b.token);
  await postFull('/api/sessions/' + s.id + '/accept', {}, c.token);
  const aLeave = await postFull('/api/sessions/' + s.id + '/leave', { keep: true }, a.token);
  ok(aLeave.status === 200, `sanity: A leaves, session goes ownerless with B and C still current participants (got ${aLeave.status})`);

  // B (a current participant) proposes a real group-vote swap, not the private pre-join carve-out.
  const proposeSwap = await postFull('/api/sessions/' + s.id + '/suggest', { exerciseId: s.exercises[0].id, swapTo: 'Cable Pulldown' }, b.token);
  ok(proposeSwap.status === 200, `sanity: B proposes a group swap (got ${proposeSwap.status})`);
  const swapEditId = proposeSwap.body.suggestedEdits.find(e => e.proposedBy === b.user.id && e.type === 'swap').id;

  // B also proposes a group "add", to cover the unanimous-consensus path specifically.
  const proposeAdd = await postFull('/api/sessions/' + s.id + '/suggest', { type: 'add', name: 'Face Pull' }, b.token);
  ok(proposeAdd.status === 200, `sanity: B proposes an add too (got ${proposeAdd.status})`);
  const addEditId = proposeAdd.body.suggestedEdits.find(e => e.proposedBy === b.user.id && e.type === 'add').id;

  // C blocks B -- membership for both stays untouched (this round's established scope boundary).
  await post('/api/block/' + b.user.id, {}, c.token);

  const cVoteSwap = await postFull('/api/sessions/' + s.id + '/suggest/' + swapEditId + '/approve', {}, c.token);
  ok(cVoteSwap.status === 400 && cVoteSwap.body.error === 'blocked', `C's vote on B's swap suggestion is refused once blocked, even though it's a group vote, not one creator deciding (got ${cVoteSwap.status}, ${JSON.stringify(cVoteSwap.body)})`);
  const cVoteAdd = await postFull('/api/sessions/' + s.id + '/suggest/' + addEditId + '/approve', {}, c.token);
  ok(cVoteAdd.status === 400 && cVoteAdd.body.error === 'blocked', `C's vote on B's "add" suggestion is refused too -- can't silently count toward (or permanently block, via reject) the unanimous-consensus requirement while blocked (got ${cVoteAdd.status}, ${JSON.stringify(cVoteAdd.body)})`);

  const stillMembers = await api('/api/sessions', 'GET', c.token).then(r => r.body);
  ok(stillMembers.some(x => x.id === s.id), 'sanity: C is still a real member of the ownerless session after the block -- membership untouched');

  await post('/api/unblock/' + b.user.id, {}, c.token);
  const cVoteSwapAfterUnblock = await postFull('/api/sessions/' + s.id + '/suggest/' + swapEditId + '/approve', {}, c.token);
  ok(cVoteSwapAfterUnblock.status === 200, `and once unblocked, C can genuinely cast that same vote -- this refuses it, it does not silently discard it (got ${cVoteSwapAfterUnblock.status})`);
}
console.log('\nregression check: ownerless group voting between two people who never block each other is completely unaffected');
{
  const a = await reg('oct1t2_a11'), b = await reg('oct1t2_b11'), c = await reg('oct1t2_c11');
  await post('/api/follow/' + b.user.id, {}, a.token);
  await post('/api/follow-requests/' + a.user.id + '/accept', {}, b.token);
  await post('/api/follow/' + c.user.id, {}, a.token);
  await post('/api/follow-requests/' + a.user.id + '/accept', {}, c.token);
  const s = await post('/api/sessions', { name: 'Core Day', visibility: 'private', scheduledAt: new Date().toISOString(),
    exercises: [{ name: 'Plank' }], inviteUsernames: [b.user.username, c.user.username] }, a.token);
  await postFull('/api/sessions/' + s.id + '/accept', {}, b.token);
  await postFull('/api/sessions/' + s.id + '/accept', {}, c.token);
  await postFull('/api/sessions/' + s.id + '/leave', { keep: true }, a.token);
  const propose = await postFull('/api/sessions/' + s.id + '/suggest', { exerciseId: s.exercises[0].id, swapTo: 'Side Plank' }, b.token);
  const editId = propose.body.suggestedEdits.find(e => e.proposedBy === b.user.id).id;
  const vote = await postFull('/api/sessions/' + s.id + '/suggest/' + editId + '/approve', {}, c.token);
  ok(vote.status === 200, `an ordinary ownerless group vote between two people who never blocked each other still works normally (got ${vote.status})`);
}

srv.kill();
await testDb.drop();
console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
