// Sep 27 2026 -- the "Ownerless Workout Flow" redesign. See server.js's comment block above
// applyOwnedSuggestedEdit for the full history: a Sep 26 attempt to ship a plain ownership-HANDOFF
// notification ("you're now the owner") turned out to contradict an already-decided design Jeff had
// mapped out earlier (a Google Sheet, referenced by an Aug/Sep Claude artifact) that this file now
// covers end to end. The core idea: a workout's creator leaving never hands ownership to anyone --
// it can't deterministically pick among three-plus current participants -- so it just clears to
// null, permanently. From that point on:
//   - edit/delete/join-approve/join-file-new-request are locked forever (nobody is ever promoted).
//   - anything still waiting on the now-gone creator's OK (a pending suggested edit) auto-applies
//     at the moment of the pivot, rather than being stuck forever.
//   - every NEW suggestion (add or swap) becomes an independent, never-expiring per-participant
//     vote instead of one owner's single yes/no -- every "yes" is really that voter's own personal
//     swap (or, for an add, un-hiding it from their own card), the same s.variations/s.hiddenFor
//     mechanisms /variation and the "hide for just me" feature already use elsewhere.
//   - a still-invited (not yet accepted) person can stash one private pre-join swap, applied for
//     real -- as their own personal variation, never a group proposal -- the moment they accept.
//   - two specific broadcasts fire on departure: "host left" (the pivot itself) and a plain
//     "X left the workout" for any later departure once already ownerless.
// Real HTTP requests against a real server + real Postgres, same harness family as
// lifecycle-audit-round4.mjs.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const J = { 'Content-Type': 'application/json' };
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('ownerless');

function boot(port, dir) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    srv.stdout.on('data', d => { if (String(d).includes('CrewFit on')) res(srv); });
    srv.on('exit', () => res(null));
    setTimeout(() => res(null), 15000);
  });
}

const DIR = mkdtempSync(join(tmpdir(), 'ownerless-'));
const PORT = 4988, B = `http://localhost:${PORT}`;
const srv = await boot(PORT, DIR);
ok(!!srv, 'server boots');

const post = (p, b, tok) => fetch(B + p, { method: 'POST', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b) }).then(r => r.json());
const postRaw = (p, b, tok) => fetch(B + p, { method: 'POST', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b) });
const put = (p, b, tok) => fetch(B + p, { method: 'PUT', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b) });
const get = (p, tok) => fetch(B + p, { headers: tok ? { Authorization: 'Bearer ' + tok } : {} }).then(r => r.json());
const reg = async (username) => { const r = await post('/api/register', { username, pin: 'pass1234', displayName: username }); return { token: r.token, id: r.user.id, user: r.user }; };
const connect = async (a, b) => { await post(`/api/follow/${b.id}`, {}, a.token); };
const historyFor = async (who, sessionId) => (await get('/api/notifications', who.token)).history.filter(h => h.link && h.link.sessionId === sessionId);
const mkTrio = async (prefix) => {
  const host = await reg(prefix + 'host'), a = await reg(prefix + 'a'), b = await reg(prefix + 'b');
  await connect(host, a); await connect(host, b);
  const s = await post('/api/sessions', {
    name: 'Trio Day', scheduledAt: new Date().toISOString(),
    exercises: [{ name: 'Bench Press' }, { name: 'Row' }], visibility: 'private',
    inviteUsernames: [prefix + 'a', prefix + 'b'],
  }, host.token);
  await post(`/api/sessions/${s.id}/accept`, {}, a.token);
  await post(`/api/sessions/${s.id}/accept`, {}, b.token);
  return { host, a, b, s };
};

console.log('\n1. the creator leaving with 2+ current participants clears ownership to null -- never hands it to anyone, even deterministically');
{
  const { host, a, b, s } = await mkTrio('piv1_');
  const left = await post(`/api/sessions/${s.id}/leave`, { keep: true }, host.token);
  ok(left.ok === true, `host left cleanly (${JSON.stringify(left)})`);
  const view = await get(`/api/sessions/${s.id}`, a.token);
  ok(view.creatorId === null, `ownership cleared, not handed to either remaining participant (got ${view.creatorId})`);
  ok((view.participants || []).includes(a.id) && (view.participants || []).includes(b.id), 'both other participants are still right there, workout intact');
}

console.log('\n2. the two departure broadcasts: "host left" fires on the pivot itself; a plain "X left" fires for any LATER departure once already ownerless -- an owned session\'s ordinary participant leaving gets neither');
{
  const host = await reg('bcast1_host'), a = await reg('bcast1_a'), b = await reg('bcast1_b');
  await connect(host, a); await connect(host, b);
  const s = await post('/api/sessions', {
    name: 'Trio Day', scheduledAt: new Date().toISOString(),
    exercises: [{ name: 'Bench Press' }], visibility: 'private',
    inviteUsernames: ['bcast1_a', 'bcast1_b'],
  }, host.token);
  await post(`/api/sessions/${s.id}/accept`, {}, a.token);
  await post(`/api/sessions/${s.id}/accept`, {}, b.token);

  // sanity: an ordinary (non-owner) departure from a still-OWNED session notifies nobody.
  const beforeA = await historyFor(a, s.id);
  const bLeavesEarly = await post(`/api/sessions/${s.id}/leave`, { keep: true }, b.token);
  ok(bLeavesEarly.ok === true, 'b leaves first, while the session is still owned by host');
  const afterA1 = await historyFor(a, s.id);
  ok(afterA1.length === beforeA.length, 'an ordinary participant leaving a still-owned session notifies nobody (unaffected by this redesign)');

  const hostLeft = await post(`/api/sessions/${s.id}/leave`, { keep: true }, host.token);
  ok(hostLeft.ok === true, 'host leaves next -- this is the pivot');
  const afterA2 = await historyFor(a, s.id);
  const pivotNotif = afterA2.find(h => /has no host now/i.test(h.body || ''));
  ok(!!pivotNotif, `a still-current participant is told the workout has no host now (got ${JSON.stringify(afterA2)})`);
  ok(pivotNotif && pivotNotif.title === 'Trio Day', `titled with the workout's own name, not something generic (got title=${pivotNotif && pivotNotif.title})`);
}

console.log('\n2b. a LATER departure from an already-ownerless workout gets the plain "X left the workout" broadcast, not the pivot copy');
{
  // Carla is invited BEFORE the pivot (invites can still be sent while there's a real creator) but
  // only accepts AFTER it -- exercising accept-into-an-ownerless-workout and then a genuine second
  // departure, distinct from the pivot itself.
  const host = await reg('bcast2_host'), a = await reg('bcast2_a'), carla = await reg('bcast2_c');
  await connect(host, a); await connect(host, carla);
  const s = await post('/api/sessions', {
    name: 'Trio Day 2', scheduledAt: new Date().toISOString(),
    exercises: [{ name: 'Bench Press' }], visibility: 'private',
    inviteUsernames: ['bcast2_a', 'bcast2_c'],
  }, host.token);
  await post(`/api/sessions/${s.id}/accept`, {}, a.token);
  await post(`/api/sessions/${s.id}/leave`, { keep: true }, host.token); // pivot -- a is now alone
  const acceptedLate = await post(`/api/sessions/${s.id}/accept`, {}, carla.token);
  ok(!acceptedLate.error, `carla can still accept a still-pending invite on an ownerless workout (got ${acceptedLate.error})`);

  const beforeIds = new Set((await historyFor(a, s.id)).map(h => h.id));
  const carlaLeft = await post(`/api/sessions/${s.id}/leave`, { keep: true }, carla.token);
  ok(carlaLeft.ok === true, 'carla leaves the already-ownerless workout');
  // history sorts newest-first, so the new entry lands at the FRONT of the array, not the end.
  const newOnes = (await historyFor(a, s.id)).filter(h => !beforeIds.has(h.id));
  const plainNotif = newOnes.find(h => /left the workout/i.test(h.body || ''));
  ok(!!plainNotif, `a is told carla left, with the plain (non-pivot) copy (got ${JSON.stringify(newOnes)})`);
  ok(plainNotif && !/has no host now/i.test(plainNotif.body || ''), 'this is genuinely the plain departure copy, not a second pivot notification');
}

console.log('\n3. a pending suggested edit still waiting on the now-departed creator auto-applies at the pivot, and notifies its proposer');
{
  const { host, a, b, s } = await mkTrio('auto1_');
  const rowId = s.exercises.find(e => e.name === 'Row').id;
  const suggested = await post(`/api/sessions/${s.id}/suggest`, { type: 'swap', exerciseId: rowId, swapTo: 'Cable Row' }, a.token);
  ok(!suggested.error, `a proposes a swap while host is still owner (got ${suggested.error})`);
  const pending = (await get(`/api/sessions/${s.id}`, host.token)).suggestedEdits.find(e => e.exerciseId === rowId);
  ok(pending && pending.status === 'pending', 'sanity: the swap is genuinely still pending, waiting on the host');

  const beforeA = await historyFor(a, s.id);
  const left = await post(`/api/sessions/${s.id}/leave`, { keep: true }, host.token);
  ok(left.ok === true, 'host leaves with a decision still outstanding');

  const view = await get(`/api/sessions/${s.id}`, b.token);
  const ex = view.exercises.find(e => e.id === rowId);
  ok(ex && ex.name === 'Cable Row', `the pending swap auto-applied at the pivot -- the shared exercise is genuinely renamed (got ${ex && ex.name})`);
  const afterA = await historyFor(a, s.id);
  ok(afterA.length > beforeA.length, 'the proposer (a) was notified their suggestion auto-approved');
  ok(afterA.some(h => /approved automatically/i.test(h.body || '')), `the notification explains it was automatic, not a real decision by anyone (got ${JSON.stringify(afterA)})`);
}

console.log('\n4. once ownerless, edit/delete are locked forever -- for every participant, not just non-creators');
{
  const { host, a, b, s } = await mkTrio('lock1_');
  await post(`/api/sessions/${s.id}/leave`, { keep: true }, host.token);
  const editAttempt = await put(`/api/sessions/${s.id}`, { name: 'Renamed' }, a.token);
  ok(editAttempt.status === 403, `editing is locked for a, a genuine current participant (got ${editAttempt.status})`);
  const deleteAttempt = await fetch(B + '/api/sessions/' + s.id, { method: 'DELETE', headers: { Authorization: 'Bearer ' + b.token } });
  ok(deleteAttempt.status === 403, `deleting is locked for b too (got ${deleteAttempt.status})`);
}

console.log('\n5. once ownerless, a public workout cannot be asked to join, and cannot have a join request approved (already-open requests are equally stuck -- nobody to decide them)');
{
  const host = await reg('lock2_host'), a = await reg('lock2_a'), stranger = await reg('lock2_s');
  await connect(host, a);
  const s = await post('/api/sessions', {
    name: 'Open Gym', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Squat' }],
    visibility: 'public', inviteUsernames: ['lock2_a'],
  }, host.token);
  await post(`/api/sessions/${s.id}/accept`, {}, a.token);
  await connect(host, stranger); await connect(stranger, host);
  // file a join request BEFORE the pivot, so there's a real pending row to prove is now stuck.
  const jr = await post(`/api/sessions/${s.id}/join`, { note: 'let me in' }, stranger.token);
  ok(jr.requested === true, `stranger files a join request before the pivot (got ${JSON.stringify(jr)})`);

  await post(`/api/sessions/${s.id}/leave`, { keep: true }, host.token);

  const carla = await reg('lock2_c');
  await connect(host, carla); await connect(carla, host);
  const joinAfter = await postRaw(`/api/sessions/${s.id}/join`, { note: 'me too' }, carla.token);
  const joinAfterBody = await joinAfter.json();
  ok(joinAfter.status === 400 && /no host/i.test(joinAfterBody.error || ''), `asking to join a now-ownerless public workout is refused outright (got ${joinAfter.status}, ${JSON.stringify(joinAfterBody)})`);

  const view = await get(`/api/sessions/${s.id}`, a.token);
  const stuckJr = (view.joinRequests || []).find(j => j.userId === stranger.id);
  // approve is creator-gated and there is no creator, so nobody -- not even a current participant
  // -- can approve the request that was already filed before the pivot; it just sits stuck.
  const approveAttempt = await post(`/api/sessions/${s.id}/join/${stuckJr ? stuckJr.id : 'x'}/approve`, {}, a.token);
  ok(approveAttempt.error === 'forbidden', `approving an already-open join request is also locked once ownerless, for every participant (got ${JSON.stringify(approveAttempt)})`);
}

console.log('\n6. new "add exercise" suggestion in an ownerless workout: hidden from everyone else until they each vote yes, visible immediately to the proposer');
{
  const { host, a, b, s } = await mkTrio('add1_');
  await post(`/api/sessions/${s.id}/leave`, { keep: true }, host.token);

  const added = await post(`/api/sessions/${s.id}/suggest`, { type: 'add', name: 'Lat Pulldown' }, a.token);
  ok(!added.error, `a suggests adding an exercise (got ${added.error})`);
  const newEdit = added.suggestedEdits.find(e => e.swapTo === 'Lat Pulldown');
  ok(!!newEdit && newEdit.status === 'pending', 'the suggestion is recorded, pending forever (no global approve/reject in ownerless mode)');
  ok((added.myHiddenExerciseIds || []).includes(newEdit.exerciseId) === false, "the proposer's own vote is an automatic yes -- it is NOT hidden on their own card");

  const bView = await get(`/api/sessions/${s.id}`, b.token);
  ok((bView.myHiddenExerciseIds || []).includes(newEdit.exerciseId), "b, who hasn't voted, has it hidden from their own card by default");

  const bApproves = await post(`/api/sessions/${s.id}/suggest/${newEdit.id}/approve`, {}, b.token);
  ok(!bApproves.error, `b votes yes (got ${bApproves.error})`);
  const bViewAfter = await get(`/api/sessions/${s.id}`, b.token);
  ok(!(bViewAfter.myHiddenExerciseIds || []).includes(newEdit.exerciseId), "after voting yes, it is no longer hidden on b's own card");

  const notifsForA = await historyFor(a, s.id);
  ok(notifsForA.some(h => /suggestion approved/i.test(h.title || '')), 'the proposer (a) was told b approved it');
}

console.log('\n7. new "swap" suggestion in an ownerless workout: every yes is that voter\'s OWN personal swap -- never a shared rename; a no is silent, no notification');
{
  const { host, a, b, s } = await mkTrio('swap1_');
  await post(`/api/sessions/${s.id}/leave`, { keep: true }, host.token);
  const benchId = s.exercises.find(e => e.name === 'Bench Press').id;

  const swapped = await post(`/api/sessions/${s.id}/suggest`, { type: 'swap', exerciseId: benchId, swapTo: 'Dumbbell Press' }, a.token);
  ok(!swapped.error, `a proposes a swap (got ${swapped.error})`);
  const edit = swapped.suggestedEdits.find(e => e.exerciseId === benchId && e.swapTo === 'Dumbbell Press');
  ok(!!edit, 'the swap proposal is recorded');

  const hostViewShared = await get(`/api/sessions/${s.id}`, b.token);
  const sharedEx = hostViewShared.exercises.find(e => e.id === benchId);
  ok(sharedEx && sharedEx.name === 'Bench Press', 'the SHARED exercise name never changes just because one person proposed a swap -- b still sees Bench Press');
  // Member-tier sessionView returns the full s.variations shape (exerciseId -> userId -> {swapTo}),
  // not a "mine only" flattened one the way the non-member view's pickMine() does.
  const aOwn = await get(`/api/sessions/${s.id}`, a.token);
  ok(aOwn.variations && aOwn.variations[benchId] && aOwn.variations[benchId][a.id] && aOwn.variations[benchId][a.id].swapTo === 'Dumbbell Press', "the proposer's own card already shows their personal swap (auto-yes)");

  const bBefore = await historyFor(a, s.id);
  const bRejects = await post(`/api/sessions/${s.id}/suggest/${edit.id}/reject`, {}, b.token);
  ok(!bRejects.error, `b votes no (got ${bRejects.error})`);
  const aAfterNo = await historyFor(a, s.id);
  ok(aAfterNo.length > bBefore.length, 'a IS told b declined (the proposer is notified either way, per spec)');
  ok(aAfterNo.some(h => /suggestion declined/i.test(h.title || '')), `the notification says declined, and frames it as one vote, not a final no (got ${JSON.stringify(aAfterNo.slice(-1))})`);

  const bView = await get(`/api/sessions/${s.id}`, b.token);
  ok(!(bView.variations && bView.variations[benchId] && bView.variations[benchId][b.id]), "b's own card has no personal swap on this exercise -- their no changed nothing about their own view");

  // b can change their mind later -- ownerless votes are never final.
  const bApprovesNow = await post(`/api/sessions/${s.id}/suggest/${edit.id}/approve`, {}, b.token);
  ok(!bApprovesNow.error, `b can change their vote to yes later, anytime (got ${bApprovesNow.error})`);
  const bViewNow = await get(`/api/sessions/${s.id}`, b.token);
  ok(bViewNow.variations && bViewNow.variations[benchId] && bViewNow.variations[benchId][b.id] && bViewNow.variations[benchId][b.id].swapTo === 'Dumbbell Press', "b's own card now shows the personal swap too, from their own later yes");
}

console.log('\n8. voting is open to every current participant, including the original proposer changing their own mind -- and a no-op re-vote (same value twice) does not re-notify');
{
  const { host, a, b, s } = await mkTrio('vote1_');
  await post(`/api/sessions/${s.id}/leave`, { keep: true }, host.token);
  const added = await post(`/api/sessions/${s.id}/suggest`, { type: 'add', name: 'Face Pull' }, a.token);
  const edit = added.suggestedEdits.find(e => e.swapTo === 'Face Pull');

  const before = await historyFor(a, s.id);
  const again = await post(`/api/sessions/${s.id}/suggest/${edit.id}/approve`, {}, a.token);
  ok(!again.error, `the proposer re-approving their own already-yes vote is a harmless no-op (got ${again.error})`);
  const after = await historyFor(a, s.id);
  ok(after.length === before.length, 'no self-notification fired from voting on your own proposal');

  // a stranger (not a participant) cannot vote at all.
  const stranger = await reg('vote1_stranger');
  const strangerVote = await post(`/api/sessions/${s.id}/suggest/${edit.id}/approve`, {}, stranger.token);
  ok(strangerVote.error === 'not a participant', `a non-participant cannot vote (got ${JSON.stringify(strangerVote)})`);
}

console.log('\n9. a still-invited person can stash a private pre-join swap on an ownerless workout; it applies as their OWN personal variation only once they actually accept -- never a group proposal, nobody else ever sees it');
{
  const host = await reg('pre1_host'), a = await reg('pre1_a'), invitee = await reg('pre1_invitee');
  await connect(host, a); await connect(host, invitee);
  const s = await post('/api/sessions', {
    name: 'Pre-join Day', scheduledAt: new Date().toISOString(),
    exercises: [{ name: 'Overhead Press' }], visibility: 'private',
    inviteUsernames: ['pre1_a', 'pre1_invitee'],
  }, host.token);
  await post(`/api/sessions/${s.id}/accept`, {}, a.token);
  await post(`/api/sessions/${s.id}/leave`, { keep: true }, host.token); // now ownerless
  const ohpId = s.exercises[0].id;

  const stashed = await post(`/api/sessions/${s.id}/suggest`, { type: 'swap', exerciseId: ohpId, swapTo: 'Push Press' }, invitee.token);
  ok(!stashed.error, `still-invited invitee can stash a private pre-join swap (got ${stashed.error})`);

  const aView = await get(`/api/sessions/${s.id}`, a.token);
  ok(!(aView.suggestedEdits || []).some(e => e.swapTo === 'Push Press'), 'a, a current participant, never sees this as a group proposal to vote on -- it is private');

  const accepted = await post(`/api/sessions/${s.id}/accept`, {}, invitee.token);
  ok(!accepted.error, `invitee accepts (got ${accepted.error})`);
  const inviteeView = await get(`/api/sessions/${s.id}`, invitee.token);
  ok(inviteeView.variations && inviteeView.variations[ohpId] && inviteeView.variations[ohpId][invitee.id] && inviteeView.variations[ohpId][invitee.id].swapTo === 'Push Press', "the moment they join, it becomes their own real personal swap");
  ok(!(inviteeView.suggestedEdits || []).some(e => e.swapTo === 'Push Press'), 'and it never turns into a lingering group suggestedEdits entry either');

  const aViewAfter = await get(`/api/sessions/${s.id}`, a.token);
  const sharedOhp = aViewAfter.exercises.find(e => e.id === ohpId);
  ok(sharedOhp && sharedOhp.name === 'Overhead Press', "the shared exercise itself is untouched -- this was always just the invitee's own card");
}

console.log('\n10. resetting workouts (POST /api/me/reset-workouts) pivots ownerless too, applying the same auto-approve-at-pivot and broadcast rules as a single Leave');
{
  const { host, a, b, s } = await mkTrio('reset1_');
  const rowId = s.exercises.find(e => e.name === 'Row').id;
  await post(`/api/sessions/${s.id}/suggest`, { type: 'swap', exerciseId: rowId, swapTo: 'T-Bar Row' }, a.token);

  const r = await post('/api/me/reset-workouts', { password: 'pass1234' }, host.token);
  ok(r.ok === true, `host resets their workouts (got ${JSON.stringify(r)})`);

  const view = await get(`/api/sessions/${s.id}`, b.token);
  ok(view.creatorId === null, `the trio workout pivoted to ownerless via reset, same as a single Leave (got ${view.creatorId})`);
  const ex = view.exercises.find(e => e.id === rowId);
  ok(ex && ex.name === 'T-Bar Row', 'the still-pending swap auto-applied at the reset pivot too');
  const bNotifs = await historyFor(b, s.id);
  ok(bNotifs.some(h => /has no host now/i.test(h.body || '')), 'b was told the workout has no host now, same broadcast as a single Leave');
}

console.log('\n11. a proposer leaving an already-ownerless workout after someone else has already voted keeps that vote alive -- exercises cold-review fix #1 (a missing "&& !e.votes" guard in /leave used to delete the whole row out from under the other voter)');
{
  const { host, a, b, s } = await mkTrio('leavevote1_');
  await post(`/api/sessions/${s.id}/leave`, { keep: true }, host.token); // ownerless
  const benchId = s.exercises.find(e => e.name === 'Bench Press').id;
  const proposed = await post(`/api/sessions/${s.id}/suggest`, { type: 'swap', exerciseId: benchId, swapTo: 'Incline Press' }, a.token);
  const edit = proposed.suggestedEdits.find(e => e.exerciseId === benchId && e.swapTo === 'Incline Press');
  ok(!!edit, 'a proposes a swap in the already-ownerless workout');
  const bVoted = await post(`/api/sessions/${s.id}/suggest/${edit.id}/approve`, {}, b.token);
  ok(!bVoted.error, `b votes yes on it (got ${bVoted.error})`);

  const aLeft = await post(`/api/sessions/${s.id}/leave`, { keep: true }, a.token);
  ok(aLeft.ok === true, 'the proposer (a) then leaves the workout entirely');

  const bView = await get(`/api/sessions/${s.id}`, b.token);
  const survivingEdit = (bView.suggestedEdits || []).find(e => e.exerciseId === benchId && e.swapTo === 'Incline Press');
  ok(!!survivingEdit, 'the proposal is NOT deleted just because its proposer left -- b already voted on it');
  ok(bView.variations && bView.variations[benchId] && bView.variations[benchId][b.id] && bView.variations[benchId][b.id].swapTo === 'Incline Press', "b's own already-cast vote (their personal variation) survived the proposer's departure intact");
}

console.log('\n12. a participant who joins AFTER an ownerless "add" proposal already exists gets backfilled into its hidden list too -- exercises cold-review fix #2 (without it, a late joiner was never in the snapshot taken at proposal time, so they silently read as "already voted yes")');
{
  // b is a real second current participant from the start, and deliberately never votes on the
  // add -- without them, a's own auto-yes would be the ONLY current participant's vote at proposal
  // time and the suggestion would trivially settle right there (see scenario 15), which would mean
  // /accept's backfill never runs (it only backfills a still-PENDING add) and this scenario
  // wouldn't actually be exercising fix #2 at all.
  const host = await reg('joinafter1_host'), a = await reg('joinafter1_a'), b = await reg('joinafter1_b'), late = await reg('joinafter1_late');
  await connect(host, a); await connect(host, b); await connect(host, late);
  const s = await post('/api/sessions', {
    name: 'Late Joiner Day', scheduledAt: new Date().toISOString(),
    exercises: [{ name: 'Squat' }], visibility: 'private',
    inviteUsernames: ['joinafter1_a', 'joinafter1_b', 'joinafter1_late'],
  }, host.token);
  await post(`/api/sessions/${s.id}/accept`, {}, a.token);
  await post(`/api/sessions/${s.id}/accept`, {}, b.token);
  await post(`/api/sessions/${s.id}/leave`, { keep: true }, host.token); // ownerless, participants = [a, b]

  const added = await post(`/api/sessions/${s.id}/suggest`, { type: 'add', name: 'Leg Curl' }, a.token);
  const edit = added.suggestedEdits.find(e => e.swapTo === 'Leg Curl');
  ok(!!edit && edit.status === 'pending', 'a suggests adding an exercise while "late" is still only invited, not yet a participant -- b (a real current participant) has not voted, so it is genuinely still pending');

  const joined = await post(`/api/sessions/${s.id}/accept`, {}, late.token);
  ok(!joined.error, `late accepts the invite after the add-proposal already exists (got ${joined.error})`);
  ok((joined.myHiddenExerciseIds || []).includes(edit.exerciseId), "the newly-joined participant is backfilled into the still-pending add's hidden list -- it does NOT silently show as already-decided on their own card");

  const lateVotes = await post(`/api/sessions/${s.id}/suggest/${edit.id}/approve`, {}, late.token);
  ok(!lateVotes.error, `late can vote on it normally, same as anyone else (got ${lateVotes.error})`);
  const lateView = await get(`/api/sessions/${s.id}`, late.token);
  ok(!(lateView.myHiddenExerciseIds || []).includes(edit.exerciseId), 'after voting yes, it is unhidden on their own card too');
  // b (the real holdout) still hasn't voted, so this stays pending even with a and late both in --
  // confirms this scenario never touched the separate collapse-on-consensus behavior (scenario 15).
  const stillPending = (await get(`/api/sessions/${s.id}`, a.token)).suggestedEdits.find(e => e.id === edit.id);
  ok(stillPending && stillPending.status === 'pending', "still pending -- b, a real current participant, hasn't voted yet");
}

console.log('\n13. a departing creator\'s own still-pending, un-voted self-proposal is discarded (never auto-approved) whether they leave or reset-workouts -- exercises cold-review fix #3, which reordered reset-workouts to withdraw a self-proposal before auto-applying, matching /leave and /remove-mine');
{
  // via reset-workouts
  const { host, a, s } = await mkTrio('selfprop1_');
  const rowId = s.exercises.find(e => e.name === 'Row').id;
  const proposed = await post(`/api/sessions/${s.id}/suggest`, { type: 'swap', exerciseId: rowId, swapTo: 'Cable Row' }, host.token);
  ok(!proposed.error, `the host (soon-to-depart creator) proposes their own swap (got ${proposed.error})`);
  const r = await post('/api/me/reset-workouts', { password: 'pass1234' }, host.token);
  ok(r.ok === true, 'host resets their workouts with their own pending self-proposal still outstanding');
  const view = await get(`/api/sessions/${s.id}`, a.token);
  ok(view.creatorId === null, 'the workout still pivoted to ownerless via reset');
  const ex = view.exercises.find(e => e.id === rowId);
  ok(ex && ex.name === 'Row', `the self-proposal was discarded, NOT auto-approved -- the exercise is still named Row (got ${ex && ex.name})`);
  ok(!(view.suggestedEdits || []).some(e => e.swapTo === 'Cable Row'), 'and no lingering suggestedEdits row for it either');

  // sanity: a plain Leave already did this correctly -- this is the exact behavior reset-workouts
  // was made consistent with.
  const { host: host2, a: a2, s: s2 } = await mkTrio('selfprop2_');
  const rowId2 = s2.exercises.find(e => e.name === 'Row').id;
  await post(`/api/sessions/${s2.id}/suggest`, { type: 'swap', exerciseId: rowId2, swapTo: 'Cable Row' }, host2.token);
  await post(`/api/sessions/${s2.id}/leave`, { keep: true }, host2.token);
  const view2 = await get(`/api/sessions/${s2.id}`, a2.token);
  const ex2 = view2.exercises.find(e => e.id === rowId2);
  ok(ex2 && ex2.name === 'Row', 'sanity: a plain Leave already discarded the identical self-proposal -- reset-workouts now matches it');
}

console.log('\n14. two still-invited people can each stash their own private pre-join swap on the same ownerless workout -- neither ever sees the other\'s, and each applies independently once THEY join, without clobbering the other');
{
  const host = await reg('twopre1_host'), a = await reg('twopre1_a'), inv1 = await reg('twopre1_inv1'), inv2 = await reg('twopre1_inv2');
  await connect(host, a); await connect(host, inv1); await connect(host, inv2);
  const s = await post('/api/sessions', {
    name: 'Two Invitees Day', scheduledAt: new Date().toISOString(),
    exercises: [{ name: 'Overhead Press' }], visibility: 'private',
    inviteUsernames: ['twopre1_a', 'twopre1_inv1', 'twopre1_inv2'],
  }, host.token);
  await post(`/api/sessions/${s.id}/accept`, {}, a.token);
  await post(`/api/sessions/${s.id}/leave`, { keep: true }, host.token); // ownerless
  const ohpId = s.exercises[0].id;

  const stash1 = await post(`/api/sessions/${s.id}/suggest`, { type: 'swap', exerciseId: ohpId, swapTo: 'Push Press' }, inv1.token);
  ok(!stash1.error, `invitee 1 stashes a private pre-join swap (got ${stash1.error})`);
  const stash2 = await post(`/api/sessions/${s.id}/suggest`, { type: 'swap', exerciseId: ohpId, swapTo: 'Arnold Press' }, inv2.token);
  ok(!stash2.error, `invitee 2 stashes a DIFFERENT private pre-join swap on the SAME exercise (got ${stash2.error})`);

  const inv1View = await get(`/api/sessions/${s.id}`, inv1.token);
  ok(!(inv1View.suggestedEdits || []).some(e => e.swapTo === 'Arnold Press'), "invitee 1 never sees invitee 2's private stash");
  const inv2View = await get(`/api/sessions/${s.id}`, inv2.token);
  ok(!(inv2View.suggestedEdits || []).some(e => e.swapTo === 'Push Press'), "invitee 2 never sees invitee 1's private stash either");

  const aView = await get(`/api/sessions/${s.id}`, a.token);
  ok(!(aView.suggestedEdits || []).some(e => e.swapTo === 'Push Press' || e.swapTo === 'Arnold Press'), 'a, a current participant, sees neither still-pending private stash');

  const accepted1 = await post(`/api/sessions/${s.id}/accept`, {}, inv1.token);
  ok(!accepted1.error, `invitee 1 accepts (got ${accepted1.error})`);
  const inv1After = await get(`/api/sessions/${s.id}`, inv1.token);
  ok(inv1After.variations && inv1After.variations[ohpId] && inv1After.variations[ohpId][inv1.id] && inv1After.variations[ohpId][inv1.id].swapTo === 'Push Press', "invitee 1's own stash applied as their personal variation on joining");

  // invitee 2's stash must be untouched by invitee 1's accept -- two independent stashes on the
  // SAME exercise must never clobber each other.
  const inv2StillPre = await get(`/api/sessions/${s.id}`, inv2.token);
  ok(!(inv2StillPre.variations && inv2StillPre.variations[ohpId] && inv2StillPre.variations[ohpId][inv2.id]), "invitee 2's stash is untouched by invitee 1's join -- still just theirs, not yet applied since they haven't joined");

  const accepted2 = await post(`/api/sessions/${s.id}/accept`, {}, inv2.token);
  ok(!accepted2.error, `invitee 2 accepts later too (got ${accepted2.error})`);
  const inv2After = await get(`/api/sessions/${s.id}`, inv2.token);
  ok(inv2After.variations && inv2After.variations[ohpId] && inv2After.variations[ohpId][inv2.id] && inv2After.variations[ohpId][inv2.id].swapTo === 'Arnold Press', "invitee 2's own stash applies too, independently, once THEY join -- inv1's earlier swap didn't block or overwrite it");
  ok(inv2After.variations[ohpId][inv1.id] && inv2After.variations[ohpId][inv1.id].swapTo === 'Push Press', "and invitee 1's earlier personal swap is still intact too -- neither one clobbered the other");
}

console.log('\n15. once every CURRENT participant has voted yes on an "add" suggestion, it settles and disappears from "Suggested changes" for good (Jeff, follow-up to the cold review: "it should disappear/collapse once everyone\'s on board") -- and a holdout leaving instead of voting can complete that same consensus for whoever remains');
{
  const host = await reg('resolve1_host'), a = await reg('resolve1_a'), b = await reg('resolve1_b'), c = await reg('resolve1_c');
  await connect(host, a); await connect(host, b); await connect(host, c);
  const s = await post('/api/sessions', {
    name: 'Resolve Day', scheduledAt: new Date().toISOString(),
    exercises: [{ name: 'Squat' }], visibility: 'private',
    inviteUsernames: ['resolve1_a', 'resolve1_b', 'resolve1_c'],
  }, host.token);
  await post(`/api/sessions/${s.id}/accept`, {}, a.token);
  await post(`/api/sessions/${s.id}/accept`, {}, b.token);
  await post(`/api/sessions/${s.id}/accept`, {}, c.token);
  await post(`/api/sessions/${s.id}/leave`, { keep: true }, host.token); // ownerless, participants = [a, b, c]

  const added = await post(`/api/sessions/${s.id}/suggest`, { type: 'add', name: 'Leg Extension' }, a.token);
  const edit = added.suggestedEdits.find(e => e.swapTo === 'Leg Extension');
  ok(!!edit && edit.status === 'pending', "the add suggestion is pending with just the proposer's own auto-yes -- b and c haven't voted yet");

  const bVoted = await post(`/api/sessions/${s.id}/suggest/${edit.id}/approve`, {}, b.token);
  ok(!bVoted.error, `b votes yes (got ${bVoted.error})`);
  const midView = await get(`/api/sessions/${s.id}`, a.token);
  const stillPending = (midView.suggestedEdits || []).find(e => e.id === edit.id);
  ok(stillPending && stillPending.status === 'pending', 'still pending with c left to vote -- not everyone is on board yet');

  // c leaves instead of ever voting -- that alone can complete consensus for whoever's left (a, b).
  const cLeft = await post(`/api/sessions/${s.id}/leave`, { keep: true }, c.token);
  ok(cLeft.ok === true, 'c leaves without ever voting on it');
  const afterCLeft = await get(`/api/sessions/${s.id}`, a.token);
  const settled = (afterCLeft.suggestedEdits || []).find(e => e.id === edit.id);
  // The row itself stays in s.suggestedEdits (a permanent record, same as any owned-mode approved
  // edit) -- it's app.js's own `ed.type==='add' && ed.status==='approved'` skip (see its comment,
  // built ahead of this exact feature) that drops it from "Suggested changes" client-side. The API
  // contract this test can actually verify is the signal that skip keys on: status flips off
  // 'pending' the moment the only holdout leaves, for the two who remain, who were unanimous all along.
  ok(settled && settled.status === 'approved', `the moment the only holdout leaves, the suggestion settles (status: 'approved') for the two who remain, who were unanimous all along (got ${settled && settled.status})`);
  ok((afterCLeft.exercises || []).some(e => e.name === 'Leg Extension'), 'the exercise itself is still there, completely normal -- just nothing left to vote on');

  // sanity: an already-settled add can't be voted on again -- refused, not silently accepted.
  const staleVote = await postRaw(`/api/sessions/${s.id}/suggest/${edit.id}/approve`, {}, b.token);
  ok(staleVote.status === 400, `voting again on an already-settled suggestion is refused (got ${staleVote.status})`);
}

console.log('\n16. re-proposing a DIFFERENT swap on the same exercise (same proposer, ownerless) replaces the still-pending row instead of piling up a duplicate -- cold-review finding #4, Jeff: "yes fix it". A DIFFERENT proposer\'s own swap on the same exercise is a real, separate choice and stays untouched');
{
  const { host, a, b, s } = await mkTrio('dedupe1_');
  await post(`/api/sessions/${s.id}/leave`, { keep: true }, host.token); // ownerless, participants = [a, b]
  const rowId = s.exercises.find(e => e.name === 'Row').id;
  const benchId = s.exercises.find(e => e.name === 'Bench Press').id;

  // -- part 1 (on Row): the SAME proposer changing their mind replaces the row and clears a now-
  // stale vote, both the vote record and the personal variation it had set.
  const first = await post(`/api/sessions/${s.id}/suggest`, { type: 'swap', exerciseId: rowId, swapTo: 'Cable Row' }, a.token);
  const firstEdit = first.suggestedEdits.find(e => e.exerciseId === rowId && e.proposedBy === a.id);
  ok(!!firstEdit, 'a proposes swapping Row to Cable Row');
  const bVoted = await post(`/api/sessions/${s.id}/suggest/${firstEdit.id}/approve`, {}, b.token);
  ok(!bVoted.error, `b votes yes on it (got ${bVoted.error})`);
  const bBefore = await get(`/api/sessions/${s.id}`, b.token);
  ok(bBefore.variations && bBefore.variations[rowId] && bBefore.variations[rowId][b.id] && bBefore.variations[rowId][b.id].swapTo === 'Cable Row', "sanity: b's yes vote really did set their own personal variation to Cable Row");

  const second = await post(`/api/sessions/${s.id}/suggest`, { type: 'swap', exerciseId: rowId, swapTo: 'T-Bar Row' }, a.token);
  ok(!second.error, `a re-proposes a DIFFERENT swap on the same exercise (got ${second.error})`);
  const aEdits = (second.suggestedEdits || []).filter(e => e.exerciseId === rowId && e.proposedBy === a.id);
  ok(aEdits.length === 1, `a's own re-proposal REPLACES the old row rather than adding a second one (found ${aEdits.length})`);
  ok(aEdits[0].swapTo === 'T-Bar Row', 'the surviving row carries the NEW swapTo');
  ok(aEdits[0].id === firstEdit.id, "it reuses the original row's id, not a freshly minted one");
  ok(!aEdits[0].votes || aEdits[0].votes[b.id] !== 'approved', "b's stale vote on the discarded Cable Row value did not carry over to the new T-Bar Row proposal");
  const bAfter = await get(`/api/sessions/${s.id}`, b.token);
  ok(!(bAfter.variations && bAfter.variations[rowId] && bAfter.variations[rowId][b.id]), "b's own personal variation (set by that now-stale vote) was cleared along with it");
  const aView = await get(`/api/sessions/${s.id}`, a.token);
  ok(aView.variations && aView.variations[rowId] && aView.variations[rowId][a.id] && aView.variations[rowId][a.id].swapTo === 'T-Bar Row', "a's own card shows the new swap, auto-approved same as any fresh proposal");

  // -- part 2 (on Bench Press, a completely separate exercise): two DIFFERENT proposers each
  // proposing their own swap on the SAME exercise is a real, separate choice for the group and
  // stays two independent rows -- unaffected by, and unrelated to, anything in part 1 above.
  const aBench = await post(`/api/sessions/${s.id}/suggest`, { type: 'swap', exerciseId: benchId, swapTo: 'Incline Press' }, a.token);
  ok(!aBench.error, `a proposes swapping Bench Press to Incline Press (got ${aBench.error})`);
  const bBench = await post(`/api/sessions/${s.id}/suggest`, { type: 'swap', exerciseId: benchId, swapTo: 'Cable Press' }, b.token);
  ok(!bBench.error, `b independently proposes their OWN swap on the same exercise (got ${bBench.error})`);
  const benchEdits = (bBench.suggestedEdits || []).filter(e => e.exerciseId === benchId);
  ok(benchEdits.length === 2
    && benchEdits.some(e => e.proposedBy === a.id && e.swapTo === 'Incline Press')
    && benchEdits.some(e => e.proposedBy === b.id && e.swapTo === 'Cable Press'),
    `two DIFFERENT people's own swaps on the SAME exercise stay two real, independent rows -- never deduped against each other (found ${JSON.stringify(benchEdits.map(e=>({by:e.proposedBy===a.id?'a':'b',swapTo:e.swapTo})))})`);
}

srv.kill('SIGKILL');
rmSync(DIR, { recursive: true, force: true });
await testDb.drop();
if (fails) { console.log(`\n${fails} FAILED`); process.exit(1); }
console.log('\nall assertions passed');
