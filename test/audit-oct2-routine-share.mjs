// Oct 2 2026 (Jeff, full redesign): "remove the visibility and the details for location, and
// inviting friends. You should solely be able to edit the exercises in the routine and then
// share the routine with others. that person should then get a notification that a routine was
// shared with them and they can then click on that be brought to the routine and accept the
// routine or decline it."
//
// This retires the old PASSIVE share model (any 'public'-visibility routine silently showed up in
// every connection's own "shared" list, no notification, no accept step -- see
// test/audit-sep30-fixes.mjs's own RESOLVED note) in favor of an ACTIVE one: an owner explicitly
// shares with specific connections (POST /api/templates/:id/share), the recipient gets a real
// notification and a pending entry in GET /api/templates' `shared` and GET /api/notifications'
// `routineShares`, and only Accept (POST .../accept-share) or Decline (POST .../decline-share)
// resolves it. Accept creates a brand-new, independently-owned COPY -- same semantics as the
// existing tplEditCopy() flow -- never a live/shared object.
//
// Built block-aware from the start, matching the rigor this same session's four-round Tier 2 fix
// (test/audit-oct1-tier2-invite-block.mjs) established for exactly this bug family: sharing itself
// can only ever target a real connection (resolveInvites -> connectionsOf, which blockUser()
// already keeps block-free), but a block can happen ANY time between the share and the recipient's
// decision, and every read/action along the way re-checks it, same as a workout invite's own
// isBlocked re-checks.
// Run:  npm test
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';

const PORT = process.env.TEST_PORT_OCT2ROUTINESHARE || 4985;
const B = `http://localhost:${PORT}`;
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('oct2routineshare');
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
const DIR = mkdtempSync(join(tmpdir(), 'oct2routineshare-'));
await boot(DIR);

async function api(path, method, token, body) {
  const r = await fetch(B + path, { method, headers: { ...J, ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
}
const post = (p, b, tok) => api(p, 'POST', tok, b).then(r => r.body);
const put = (p, b, tok) => api(p, 'PUT', tok, b).then(r => r.body);
const get = (p, tok) => api(p, 'GET', tok).then(r => r.body);
const reg = (u) => post('/api/register', { username: u, pin: 'pass1234', displayName: u });
const connect = async (a, b) => { await post('/api/follow/' + b.user.id, {}, a.token); await post('/api/follow-requests/' + a.user.id + '/accept', {}, b.token); };

console.log('POST /api/templates(/:id) no longer accepts location/visibility/inviteUsernames -- the editor is solely name + exercises now');
{
  const owner = await reg('oct2_fields_owner');
  const friend = await reg('oct2_fields_friend');
  await connect(friend, owner);
  const t = await post('/api/templates', { name: 'Leg Day', exercises: [{ name: 'Squat' }],
    location: 'Gold\'s Gym', visibility: 'public', inviteUsernames: ['oct2_fields_friend'] }, owner.token);
  ok(!!t.id, 'setup: routine created despite the legacy fields in the request body');
  ok(t.location === undefined, 'location is silently ignored, never stored');
  ok(t.visibility === undefined, 'visibility is silently ignored, never stored');
  ok(t.invited === undefined, 'inviteUsernames is silently ignored, never stored as `invited`');
  ok(t.sharedTo === undefined, 'and a brand-new routine starts with no pending shares at all');

  const edited = await put('/api/templates/' + t.id, { name: 'Leg Day', exercises: [{ name: 'Squat' }],
    location: 'New Gym', visibility: 'private', inviteUsernames: ['oct2_fields_friend'] }, owner.token);
  ok(edited.location === undefined && edited.visibility === undefined && edited.invited === undefined, 'PUT ignores the same legacy fields too -- editing never resurrects them');

  // and, since visibility is never read any more, the old passive discovery is genuinely gone --
  // a connection's completely ordinary (unshared) routine never shows up as "shared" with anyone.
  const friendsView = await get('/api/templates', friend.token);
  ok(!friendsView.shared.some(x => x.id === t.id), 'a connection\'s routine, never explicitly shared, does not passively show up in their shared list');
}

console.log('\nthe full share -> notify -> accept flow: Accept creates a brand-new, independently-owned copy and clears the pending state everywhere');
{
  const owner = await reg('oct2_accept_owner');
  const friend = await reg('oct2_accept_friend');
  await connect(friend, owner);
  const t = await post('/api/templates', { name: 'Push Day', exercises: [{ name: 'Bench Press', defaultSets: 4 }] }, owner.token);

  const shareRes = await post('/api/templates/' + t.id + '/share', { usernames: ['oct2_accept_friend'] }, owner.token);
  ok(shareRes.id === t.id, 'setup: share call succeeds and echoes the (owner\'s own) routine');
  ok(Array.isArray(shareRes.sharedTo) && shareRes.sharedTo.includes(friend.user.id), 'owner\'s own view of the routine shows the pending recipient');

  const friendList = await get('/api/templates', friend.token);
  const pendingRow = friendList.shared.find(x => x.id === t.id);
  ok(!!pendingRow, 'the routine shows up in the recipient\'s `shared` list as a pending share');
  ok(pendingRow.sharedTo === undefined, 'the pending row never echoes sharedTo to the recipient -- no seeing who ELSE it was shared with');
  ok(pendingRow.ownerName === 'oct2_accept_owner', 'the pending row carries the owner\'s display name, same as before');

  const friendNotifs = await get('/api/notifications', friend.token);
  ok(friendNotifs.routineShares.some(r => r.routineId === t.id && r.from.id === owner.user.id), 'the recipient\'s notifications inbox surfaces the pending share');

  const acceptRes = await post('/api/templates/' + t.id + '/accept-share', {}, friend.token);
  ok(acceptRes.ok === true && !!acceptRes.id && acceptRes.id !== t.id, 'accept creates a brand-new routine with its OWN id, never the original');

  const friendsCopy = await get('/api/templates', friend.token);
  const copy = friendsCopy.mine.find(x => x.id === acceptRes.id);
  ok(!!copy && copy.ownerId === friend.user.id, 'the new copy is genuinely owned by the recipient, in their own `mine` list');
  ok(copy && copy.exercises.length === 1 && copy.exercises[0].name === 'Bench Press' && copy.exercises[0].defaultSets === 4, 'the copy carries the same exercises as the original');
  ok(!friendsCopy.shared.some(x => x.id === t.id), 'the original pending share is gone from `shared` once accepted');

  const ownersView = await get('/api/templates', owner.token);
  const originalAfter = ownersView.mine.find(x => x.id === t.id);
  ok(!!originalAfter && !(originalAfter.sharedTo || []).includes(friend.user.id), 'the owner\'s ORIGINAL routine no longer lists the friend as pending -- they decided');
  ok(originalAfter.exercises[0].name === 'Bench Press', 'the original itself is completely untouched -- accept copies, it never moves or mutates the source');

  const friendNotifsAfter = await get('/api/notifications', friend.token);
  ok(!friendNotifsAfter.routineShares.some(r => r.routineId === t.id), 'the accepted share no longer sits in the notifications inbox');
}

console.log('\nDecline: removes the pending entry everywhere, creates no copy, leaves the original untouched');
{
  const owner = await reg('oct2_decline_owner');
  const friend = await reg('oct2_decline_friend');
  await connect(friend, owner);
  const t = await post('/api/templates', { name: 'Pull Day', exercises: [{ name: 'Row' }] }, owner.token);
  await post('/api/templates/' + t.id + '/share', { usernames: ['oct2_decline_friend'] }, owner.token);

  const beforeMine = await get('/api/templates', friend.token);
  const minecountBefore = beforeMine.mine.length;

  const declineRes = await post('/api/templates/' + t.id + '/decline-share', {}, friend.token);
  ok(declineRes.ok === true, 'decline succeeds');

  const afterMine = await get('/api/templates', friend.token);
  ok(afterMine.mine.length === minecountBefore, 'no new routine was created by declining');
  ok(!afterMine.shared.some(x => x.id === t.id), 'the declined share is gone from the recipient\'s shared list');

  const ownersView = await get('/api/templates', owner.token);
  const original = ownersView.mine.find(x => x.id === t.id);
  ok(!(original.sharedTo || []).includes(friend.user.id), 'the owner\'s pending list no longer includes the decliner');
  ok(original.exercises[0].name === 'Row', 'the owner still has their original routine, completely untouched');
}

console.log('\nblock-awareness: sharing can only ever target a real connection in the first place');
{
  const owner = await reg('oct2_blk1_owner');
  const stranger = await reg('oct2_blk1_stranger');   // never connected at all
  const t = await post('/api/templates', { name: 'Core', exercises: [{ name: 'Plank' }] }, owner.token);
  const r = await post('/api/templates/' + t.id + '/share', { usernames: ['oct2_blk1_stranger'] }, owner.token);
  ok(r.error === 'pick at least one person to share with', 'sharing with a non-connection resolves to nobody and is refused, same as resolveInvites everywhere else in this app');
}

console.log('\nblock-awareness: a block AFTER the share but BEFORE the decision hides the pending share from the recipient\'s list and notifications, and refuses accept outright');
{
  const owner = await reg('oct2_blk2_owner');
  const friend = await reg('oct2_blk2_friend');
  await connect(friend, owner);
  const t = await post('/api/templates', { name: 'Shoulders', exercises: [{ name: 'Lateral Raise' }] }, owner.token);
  await post('/api/templates/' + t.id + '/share', { usernames: ['oct2_blk2_friend'] }, owner.token);

  const before = await get('/api/templates', friend.token);
  ok(before.shared.some(x => x.id === t.id), 'sanity: the pending share is visible before any block');

  // the OWNER blocks the recipient -- isBlocked is bidirectional, so either direction must work;
  // this covers the direction a naive `isBlocked(ownerId, viewerId)`-only check (rather than the
  // real bidirectional isBlocked) would still happen to catch, same reasoning as every other
  // block test in this suite covering both directions explicitly.
  await post('/api/block/' + friend.user.id, {}, owner.token);

  const afterList = await get('/api/templates', friend.token);
  ok(!afterList.shared.some(x => x.id === t.id), 'the pending share is hidden from the recipient\'s shared list once blocked');

  const afterNotifs = await get('/api/notifications', friend.token);
  ok(!afterNotifs.routineShares.some(x => x.routineId === t.id), 'and hidden from their notifications inbox too');

  const acceptAttempt = await post('/api/templates/' + t.id + '/accept-share', {}, friend.token);
  ok(acceptAttempt.error === 'blocked', 'accept is refused outright rather than silently handing a blocked owner\'s routine to the recipient (got: ' + JSON.stringify(acceptAttempt) + ')');

  const stillPendingOnOwner = await get('/api/templates', owner.token);
  const stillThere = stillPendingOnOwner.mine.find(x => x.id === t.id);
  ok((stillThere.sharedTo || []).includes(friend.user.id), 'the refused accept leaves the pending share exactly where it was -- refused, not silently discarded');

  // decline, unlike accept, carries no isBlocked check (removing your own pending entry can never
  // hand anyone anything) -- confirms it still works even while blocked, same shape as a workout
  // invite's own /decline route.
  const declineWhileBlocked = await post('/api/templates/' + t.id + '/decline-share', {}, friend.token);
  ok(declineWhileBlocked.ok === true, 'decline still works even while blocked -- there is nothing unsafe about removing your own pending entry');
}

console.log('\nblock-awareness: the OTHER direction -- the recipient blocks the owner instead -- is caught the same way (isBlocked is symmetric)');
{
  const owner = await reg('oct2_blk3_owner');
  const friend = await reg('oct2_blk3_friend');
  await connect(friend, owner);
  const t = await post('/api/templates', { name: 'Back', exercises: [{ name: 'Lat Pulldown' }] }, owner.token);
  await post('/api/templates/' + t.id + '/share', { usernames: ['oct2_blk3_friend'] }, owner.token);

  await post('/api/block/' + owner.user.id, {}, friend.token);   // friend blocks owner this time

  const afterList = await get('/api/templates', friend.token);
  ok(!afterList.shared.some(x => x.id === t.id), 'friend blocking the owner also hides the pending share from friend\'s own list');
  const acceptAttempt = await post('/api/templates/' + t.id + '/accept-share', {}, friend.token);
  ok(acceptAttempt.error === 'blocked', 'and accept is refused this direction too');
}

console.log('\nownership and validation guards: 403/404s exactly where expected, matching every other owner-gated route in this file');
{
  const owner = await reg('oct2_guard_owner');
  const other = await reg('oct2_guard_other');
  const friend = await reg('oct2_guard_friend');
  await connect(friend, owner);
  const t = await post('/api/templates', { name: 'Arms', exercises: [{ name: 'Curl' }] }, owner.token);

  const shareByNonOwner = await api('/api/templates/' + t.id + '/share', 'POST', other.token, { usernames: ['oct2_guard_friend'] });
  ok(shareByNonOwner.status === 403, 'a non-owner cannot share someone else\'s routine (got ' + shareByNonOwner.status + ')');

  const shareMissing = await api('/api/templates/t_doesnotexist/share', 'POST', owner.token, { usernames: ['oct2_guard_friend'] });
  ok(shareMissing.status === 404, 'sharing a routine that does not exist 404s');

  const acceptNotShared = await api('/api/templates/' + t.id + '/accept-share', 'POST', friend.token, {});
  ok(acceptNotShared.status === 403, 'accepting a routine that was never shared with you is refused (got ' + acceptNotShared.status + ')');

  const declineNotShared = await api('/api/templates/' + t.id + '/decline-share', 'POST', friend.token, {});
  ok(declineNotShared.status === 403, 'declining a routine that was never shared with you is refused the same way');

  const acceptMissing = await api('/api/templates/t_doesnotexist/accept-share', 'POST', owner.token, {});
  ok(acceptMissing.status === 404, 'accepting a routine that does not exist 404s');
}

console.log('\nregression check: sharing with the same person twice does not duplicate the pending entry or double-notify');
{
  const owner = await reg('oct2_dup_owner');
  const friend = await reg('oct2_dup_friend');
  await connect(friend, owner);
  const t = await post('/api/templates', { name: 'Full Body', exercises: [{ name: 'Deadlift' }] }, owner.token);
  await post('/api/templates/' + t.id + '/share', { usernames: ['oct2_dup_friend'] }, owner.token);
  const second = await post('/api/templates/' + t.id + '/share', { usernames: ['oct2_dup_friend'] }, owner.token);
  const count = (second.sharedTo || []).filter(id => id === friend.user.id).length;
  ok(count === 1, 'sharing with an already-pending recipient again does not add a second entry (saw ' + count + ')');
  const notifs = await get('/api/notifications', friend.token);
  const matches = notifs.routineShares.filter(r => r.routineId === t.id).length;
  ok(matches === 1, 'and the notifications inbox still shows exactly one pending entry for it, not two');
}

srv.kill();
await testDb.drop();
console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
