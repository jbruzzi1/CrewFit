// Sep 29 2026 (Jeff: "lets add an edit display name or username, and a change password... lets
// build these 4 - along with account deletion"). Four new self-service Settings actions:
//   POST /api/me/display-name  POST /api/me/username  POST /api/me/password  POST /api/me/delete-account
// Also covers the password-length floor moving 6 -> 8 (pinProblem) -- the boundary itself is
// re-tested in accounts.mjs's own "usernames and passwords have rules" block; this file only
// checks the new routes.
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';
import { PgConnection, parseConnString } from '../pgmini.js';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const J = { 'Content-Type': 'application/json' };
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('acctsettings');

function boot(port, dir) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    srv.stdout.on('data', d => { if (String(d).includes('CrewFit on')) res(srv); });
    srv.on('exit', () => res(null));
    setTimeout(() => res(null), 15000);
  });
}
const PORT = 4980, B = `http://localhost:${PORT}`;
const DIR = mkdtempSync(join(tmpdir(), 'acctsettings-'));
const srv = await boot(PORT, DIR);
ok(!!srv, 'server boots');

const post = (p, b, tok) => fetch(B + p, { method: 'POST', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b) }).then(r => r.json());
const postRaw = (p, b, tok) => fetch(B + p, { method: 'POST', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b) });
const reg = (username, pin, displayName) => post('/api/register', { username, pin, displayName });
const login = (username, pin) => post('/api/login', { username, pin });
// Direct-Postgres read of the notifications table -- same pattern reset-workouts.mjs's own readDb
// uses for sessions -- to check the actual stored notification body, which no client-facing route
// otherwise exposes in this shape.
async function readNotificationsFor(userId) {
  const pg = new PgConnection(parseConnString(testDb.url));
  const r = await pg.query('SELECT id, data FROM notifications');
  pg.close();
  return r.rows.map(row => JSON.parse(row.data)).filter(n => n.userId === userId);
}
// Direct-Postgres read of the crews table -- used by the #178 solo-crew-deletion check below,
// since the only account that was ever a member of that crew is the one just deleted (and so can
// no longer authenticate at all, 401, before the request ever reaches the crew lookup) -- there's
// no other user whose own token could ask the API whether the row is gone.
async function readCrew(crewId) {
  const pg = new PgConnection(parseConnString(testDb.url));
  const r = await pg.query('SELECT id FROM crews WHERE id = $1', [crewId]);
  pg.close();
  return r.rows[0] || null;
}
// A tiny real 1x1 PNG, base64-encoded -- small enough to inline, still a real image POST
// /api/me/avatar's own content-type sniff (data:image/png;base64,...) accepts.
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

console.log('\ndisplay name');
{
  const u = await reg('dn_' + Date.now(), 'pass1234', 'Original Name');
  const r = await post('/api/me/display-name', { displayName: 'New Name' }, u.token);
  ok(r.displayName === 'New Name', `saves the new display name (got ${JSON.stringify(r)})`);
  const empty = await post('/api/me/display-name', { displayName: '   ' }, u.token);
  ok(empty.error, 'an empty (or whitespace-only) display name is refused, not silently accepted');
  const long = await post('/api/me/display-name', { displayName: 'x'.repeat(200) }, u.token);
  ok(long.displayName && long.displayName.length === 80, `a very long name is capped at 80, same as registration (got length ${long.displayName && long.displayName.length})`);
  const noAuth = await postRaw('/api/me/display-name', { displayName: 'Nope' });
  ok(noAuth.status === 401 || noAuth.status === 403, `no token is rejected (got ${noAuth.status})`);
}

console.log('\nusername');
{
  const uname1 = 'un1_' + Math.floor(Math.random() * 1e9);
  const uname2 = 'un2_' + Math.floor(Math.random() * 1e9);
  const a = await reg(uname1, 'pass1234', 'A');
  const b = await reg(uname2, 'pass1234', 'B');

  // Sep 30 2026 (audit finding, round-2 Tier 1 #1): username IS the login credential and
  // password reset is permanently disabled, so a stolen/leaked session token alone used to be
  // enough to silently rename someone out of their own account, with no self-service way back
  // in. The route now requires the current password, same bar as /api/me/password,
  // /api/me/reset-workouts and /api/me/delete-account -- and the same 400-not-401 status (a
  // wrong confirmation password must not trip the client's global "401 means your session died"
  // auto-logout, since the request already carries a valid token).
  const noPass = await postRaw('/api/me/username', { username: 'un1nopass_' + Math.floor(Math.random() * 1e9) }, a.token);
  const noPassBody = await noPass.json();
  ok(noPass.status === 400 && !!noPassBody.error, `changing username with no password at all is refused, not silently accepted (got ${noPass.status}, ${JSON.stringify(noPassBody)})`);
  const wrongPass = await postRaw('/api/me/username', { username: 'un1wrongpass_' + Math.floor(Math.random() * 1e9), password: 'nope1234' }, a.token);
  const wrongPassBody = await wrongPass.json();
  ok(wrongPass.status === 400 && wrongPassBody.error === 'Password is incorrect',
     `a wrong password is refused with the same status+message as the other password-confirm routes (got ${wrongPass.status}, ${JSON.stringify(wrongPassBody)})`);
  const stillOldName = await login(uname1, 'pass1234');
  ok(!!stillOldName.token, 'and the username genuinely did not change after either refused attempt');

  const taken = await post('/api/me/username', { username: uname2, password: 'pass1234' }, a.token);
  ok(taken.error, `changing to an already-taken username is refused (got ${JSON.stringify(taken)})`);
  const takenCase = await post('/api/me/username', { username: uname2.toUpperCase(), password: 'pass1234' }, a.token);
  ok(takenCase.error, 'refused case-insensitively too, not just an exact match');
  const bad = await post('/api/me/username', { username: 'ab', password: 'pass1234' }, a.token);
  ok(bad.error, 'the same 3-20 char rule registration uses is enforced here too');
  const reserved = await post('/api/me/username', { username: 'admin', password: 'pass1234' }, a.token);
  ok(reserved.error, 'a reserved name is refused');
  const deletedPrefix = await post('/api/me/username', { username: 'deleted_abc12345', password: 'pass1234' }, a.token);
  ok(deletedPrefix.error, 'a "deleted_" prefixed name is refused -- reserved for anonymized accounts');
  const newName = 'un1renamed_' + Math.floor(Math.random() * 1e9);
  const r = await post('/api/me/username', { username: newName, password: 'pass1234' }, a.token);
  ok(r.username === newName, `a genuinely free username, WITH the correct current password, is accepted (got ${JSON.stringify(r)})`);
  const loggedIn = await login(newName, 'pass1234');
  ok(!!loggedIn.token, 'and immediately logs in under the new name');
  const oldGone = await login(uname1, 'pass1234');
  ok(!oldGone.token, 'the old username no longer logs in');
  // Re-submitting your OWN current username (unchanged, or just a different capitalisation) must
  // not trip the "taken" check against yourself.
  const same = await post('/api/me/username', { username: newName.toUpperCase(), password: 'pass1234' }, a.token);
  ok(!same.error, `re-submitting your own name in a different case is allowed, not refused as "taken" (got ${JSON.stringify(same)})`);
}

console.log('\nchange password');
{
  const uname = 'cp_' + Date.now();
  const u = await reg(uname, 'pass1234', 'CP');
  // A second live session for the same account (a second device, in effect) -- lets the
  // sign-out-everywhere assertions below tell "this device" apart from "every other device".
  const device2 = await login(uname, 'pass1234');
  ok(!!device2.token, 'sanity: a second device can log in with the still-current password');

  const wrongCurrent = await post('/api/me/password', { currentPassword: 'nope1234', newPassword: 'newpass12' }, u.token);
  ok(wrongCurrent.error, `the wrong current password is refused (got ${JSON.stringify(wrongCurrent)})`);
  const weakNew = await post('/api/me/password', { currentPassword: 'pass1234', newPassword: 'short' }, u.token);
  ok(weakNew.error, 'a new password under 8 characters is refused, same floor as registration');
  const r = await post('/api/me/password', { currentPassword: 'pass1234', newPassword: 'newpass12' }, u.token);
  ok(r.ok === true, `a correct current password + valid new one succeeds (got ${JSON.stringify(r)})`);
  const oldNoLongerWorks = await login(uname, 'pass1234');
  ok(!oldNoLongerWorks.token, 'the old password no longer logs in');
  const newWorks = await login(uname, 'newpass12');
  ok(!!newWorks.token, 'the new password does');

  // Sep 29 2026 (audit finding, Tier 1 #3; cold-review catch): the whole point of this change is
  // that it actually signs out every OTHER session, while the device that made the change gets a
  // fresh token so it doesn't lock itself out. None of that was previously covered here.
  ok(typeof r.token === 'string' && r.token.length > 0, `the response hands back a fresh token for this device (got ${JSON.stringify(r.token)})`);
  const oldTokenAfterChange = await postRaw('/api/me/display-name', { displayName: 'still me?' }, u.token);
  ok(oldTokenAfterChange.status === 401, `this device's OWN pre-change token is dead too, same as any other pre-change token (got ${oldTokenAfterChange.status})`);
  const freshTokenWorks = await postRaw('/api/me/display-name', { displayName: 'still me' }, r.token);
  ok(freshTokenWorks.status === 200, `but the FRESH token the route handed back keeps this device logged in, no surprise logout right after changing your own password (got ${freshTokenWorks.status})`);
  const device2AfterChange = await postRaw('/api/me/display-name', { displayName: 'device 2?' }, device2.token);
  ok(device2AfterChange.status === 401, `the OTHER device's session is genuinely signed out (got ${device2AfterChange.status})`);
}

// Oct 2 2026 (#182, deep audit finding, Jeff: "Just sign out this device"): "Log out" used to be
// purely client-side -- the token itself stayed valid server-side regardless, for up to
// TOKEN_TTL_DAYS. POST /api/logout now revokes exactly the one token it's called with; this
// proves that's per-DEVICE, not the account-wide "every session, everywhere" hammer
// /api/me/password (just above) and /api/me/delete-account already use.
console.log('\nlogout (#182)');
{
  const uname = 'lo_' + Date.now();
  const u = await reg(uname, 'pass1234', 'LO');
  const device2 = await login(uname, 'pass1234');
  ok(!!device2.token, 'sanity: a second device logs in fine');

  const before = await fetch(B + '/api/profile/me', { headers: { Authorization: 'Bearer ' + u.token } });
  ok(before.status === 200, `sanity: device 1's token works before logging out (got ${before.status})`);

  const out = await postRaw('/api/logout', {}, u.token);
  ok(out.status === 200, `device 1 logs out (got ${out.status})`);

  const afterD1 = await fetch(B + '/api/profile/me', { headers: { Authorization: 'Bearer ' + u.token } });
  ok(afterD1.status === 401, `device 1's own token is now rejected (got ${afterD1.status})`);
  const afterD2 = await fetch(B + '/api/profile/me', { headers: { Authorization: 'Bearer ' + device2.token } });
  ok(afterD2.status === 200, `but device 2's token still works -- this was a per-device sign-out, not account-wide (got ${afterD2.status})`);

  // Calling it again with the already-revoked token (e.g. a double-tap, or a retry after a flaky
  // network response) must not throw or corrupt anything -- it's already logged out, which is a
  // success, not an error.
  const outAgain = await postRaw('/api/logout', {}, u.token);
  ok(outAgain.status === 401, `a second logout with the same already-revoked token is just an ordinary 401 (already logged out), not a crash (got ${outAgain.status})`);

  // A login right after logging out gets a genuinely fresh, un-revoked token -- a device signing
  // back in must not find itself immediately logged back out again.
  const backIn = await login(uname, 'pass1234');
  ok(!!backIn.token, 'logging back in after logging out works normally');
  const afterBackIn = await fetch(B + '/api/profile/me', { headers: { Authorization: 'Bearer ' + backIn.token } });
  ok(afterBackIn.status === 200, `and the fresh token from that login works immediately (got ${afterBackIn.status})`);
}

console.log('\ndelete account');
{
  // Three accounts: `founder` creates the workout, `owner` is the one whose full delete-account
  // flow this block tests, `friend` is the bystander whose own view (follow list, notifications,
  // session) gets checked afterward. Structured this way specifically so `owner` ends up a
  // NON-creator participant of an ALREADY-ownerless session before deleting -- the one
  // notifyWipePivots branch that actually embeds the departing user's name in the notification
  // body (`${whoLeft} left the workout.`; the creator-pivot branch is a generic, nameless "host
  // left" message -- see notifyWipePivots' own two branches). That's the exact branch the
  // cold-review catch below needs to exercise.
  const founder = await reg('fd_' + Math.floor(Math.random() * 1e9), 'pass1234', 'Founder');
  const owner = await reg('do_' + Math.floor(Math.random() * 1e9), 'pass1234', 'Owner');
  const friend = await reg('df_' + Math.floor(Math.random() * 1e9), 'pass1234', 'Friend');
  // Mutual follow (owner <-> friend), so there's a real follow graph on both sides to verify gets
  // cleaned up by owner's own deletion below.
  await post('/api/follow/' + friend.user.id, {}, owner.token);
  await post('/api/follow-requests/' + owner.user.id + '/accept', {}, friend.token);
  await post('/api/follow/' + owner.user.id, {}, friend.token);
  await post('/api/follow-requests/' + friend.user.id + '/accept', {}, owner.token);
  // founder also needs to be connected to both -- POST /api/sessions only sends an invite to
  // someone already in connectionsOf(inviter) (an approved follow either direction); without this,
  // inviteUsernames below would silently resolve to nobody and owner/friend would never actually
  // join the session.
  await post('/api/follow/' + owner.user.id, {}, founder.token);
  await post('/api/follow-requests/' + founder.user.id + '/accept', {}, owner.token);
  await post('/api/follow/' + friend.user.id, {}, founder.token);
  await post('/api/follow-requests/' + founder.user.id + '/accept', {}, friend.token);

  // founder creates it, invites both; friend logs a set so the session has real credit and
  // survives founder's own departure as a pivot (ownerless) rather than a hard delete. Invites are
  // sent at creation time (inviteUsernames), accepted via POST .../accept -- there is no separate
  // /invite or /join route.
  const sess = await post('/api/sessions', { name: 'Push Day', visibility: 'public', scheduledAt: new Date().toISOString(),
    exercises: [{ name: 'Barbell Bench Press' }], inviteUsernames: [owner.user.username, friend.user.username] }, founder.token);
  await post(`/api/sessions/${sess.id}/accept`, {}, owner.token);
  await post(`/api/sessions/${sess.id}/accept`, {}, friend.token);
  await post(`/api/sessions/${sess.id}/log`, { exerciseId: sess.exercises[0].id, weight: 135, reps: 10 }, friend.token);

  // founder deletes their own account first -- this is exactly wipeUserFromAllSessions' "creator
  // leaves, someone else has credit" ownership-handoff case, already exhaustively covered by
  // reset-workouts.mjs; here it's enough that it pivots the session to genuinely ownerless
  // (creatorId: null) so owner's OWN deletion right after lands in the non-creator/already-
  // ownerless branch this block actually wants to test.
  const founderDel = await post('/api/me/delete-account', { password: 'pass1234' }, founder.token);
  ok(founderDel.ok === true, `founder (the session creator) deletes their account first, to leave it ownerless (got ${JSON.stringify(founderDel)})`);
  const sessAfterFounder = await fetch(B + '/api/sessions/' + sess.id, { headers: { Authorization: 'Bearer ' + owner.token } }).then(r => r.json());
  ok(sessAfterFounder && sessAfterFounder.creatorId === null, `sanity: the session is genuinely ownerless now (got creatorId ${sessAfterFounder && sessAfterFounder.creatorId})`);

  // A real avatar on disk -- confirms deletion actually unlinks the file, not just the reference
  // (cold-review catch: the unauthenticated /uploads static mount would otherwise keep serving it
  // forever at its same old URL, directly contradicting "no longer identifies this person").
  const avatarUp = await post('/api/me/avatar', { data: 'data:image/png;base64,' + TINY_PNG, type: 'image/png' }, owner.token);
  ok(avatarUp.avatar && avatarUp.avatar.startsWith('/uploads/avatar_'), `owner uploads a real avatar first (got ${JSON.stringify(avatarUp)})`);
  const avatarPath = join(DIR, 'uploads', avatarUp.avatar.replace('/uploads/', ''));

  const wrongPass = await post('/api/me/delete-account', { password: 'nope1234' }, owner.token);
  ok(wrongPass.error, `the wrong password refuses the delete (got ${JSON.stringify(wrongPass)})`);
  const stillWorks = await login(owner.user.username, 'pass1234');
  ok(!!stillWorks.token, 'and the account is untouched -- still logs in fine after a refused attempt');

  const ownerOldUsername = owner.user.username, ownerRealName = owner.user.displayName || 'Owner';
  const del = await post('/api/me/delete-account', { password: 'pass1234' }, owner.token);
  ok(del.ok === true, `deleting with the correct password succeeds (got ${JSON.stringify(del)})`);

  ok(!existsSync(avatarPath), `the avatar file is actually unlinked from disk, not just unreferenced (checked ${avatarPath})`);
  const avatarStillServed = await fetch(B + avatarUp.avatar);
  ok(avatarStillServed.status === 404, `and the old avatar URL no longer serves anything (got ${avatarStillServed.status})`);

  const loginAfter = await login(ownerOldUsername, 'pass1234');
  ok(!loginAfter.token, 'the deleted account can no longer log in under its old username');
  const tokenStillWorks = await fetch(B + '/api/profile/' + owner.user.id, { headers: { Authorization: 'Bearer ' + owner.token } });
  // Sep 29 2026 (audit finding, Tier 1 #3): this used to assert 200-or-404 with a comment saying
  // the pre-deletion token "is still cryptographically valid (tokens are signed, not revoked by
  // list)" -- that sentence WAS the bug (Tier 1 audit finding #3: delete-account's own confirm
  // screen already promised "you'll be signed out everywhere," and nothing made that true).
  // tokensValidFrom is now actually assigned on delete (see the route's own comment), so this
  // exact pre-deletion token fails userIdFromToken's check and auth() correctly 401s -- the
  // stronger, intended behavior, not a crash to merely tolerate.
  ok(tokenStillWorks.status === 401, `a stale pre-deletion token is rejected, not still usable (got ${tokenStillWorks.status})`);

  const friendsFollowing = await fetch(B + '/api/profile/' + friend.user.id + '/following', { headers: { Authorization: 'Bearer ' + friend.token } }).then(r => r.json());
  ok(Array.isArray(friendsFollowing) && !friendsFollowing.some(x => x.id === owner.user.id),
     `the deleted account no longer appears in the friend's Following list (got ${JSON.stringify(friendsFollowing)})`);

  // Cold-review catch: notifyWipePivots used to run AFTER anonymization, so the "X left the
  // workout" notification it sends read "Deleted user left the workout" instead of the real name
  // -- fixed by notifying before the anonymization phase runs. Confirm the real name landed.
  const friendNotifs = await readNotificationsFor(friend.user.id);
  const leftNotif = friendNotifs.find(n => (n.body || '').includes('left the workout'));
  ok(!!leftNotif && leftNotif.body.includes(ownerRealName) && !leftNotif.body.includes('Deleted user'),
     `the friend's "left the workout" notification names the real departed user, not "Deleted user" (got ${JSON.stringify(leftNotif)})`);

  // The old username is genuinely freed -- someone new can register it. This is a deliberate,
  // flagged trade-off (see the long comment above POST /api/me/delete-account), not an accident.
  const reused = await reg(ownerOldUsername, 'pass1234', 'New Person');
  ok(!!reused.token, 'the old username can be registered by someone else after deletion');

  // The session the deleted owner created should have pivoted -- creatorId explicitly null, same
  // as reset-workouts' own "ownerless" outcome for a creator who leaves behind a real credit-
  // holder (see wipeUserFromAllSessions) -- not vanished, not left owned by a now-anonymized
  // account, and not silently handed to nobody.
  const sessAfter = await fetch(B + '/api/sessions/' + sess.id, { headers: { Authorization: 'Bearer ' + friend.token } }).then(r => r.json());
  ok(sessAfter && sessAfter.creatorId === null, `the workout pivoted to ownerless, same as reset-workouts (got ${JSON.stringify(sessAfter)})`);
  ok(sessAfter && Array.isArray(sessAfter.participants) && sessAfter.participants.includes(friend.user.id),
     'and the friend is still a real current participant, with their own logged set intact');
}

// Oct 2 2026 (#178, deep audit finding): a crew the deleted account OWNED was never touched by
// delete-account at all -- c.ownerId kept pointing at an id that can never log in again, so every
// owner-gated crew route (rename/membership/delete/start-challenge) silently 403'd for literally
// everyone, forever. Two cases: a crew with other real members pivots to ownerless (c.ownerId:
// null, mirroring sessions' own creatorId pivot), a solo crew (deleted owner was the only member)
// is deleted outright instead, same as the ownerless-but-empty edge case sessions collapse to a
// hard delete for.
console.log('\ndelete account -- crew ownership (#178)');
{
  const owner = await reg('co_' + Math.floor(Math.random() * 1e9), 'pass1234', 'CrewOwner');
  const member = await reg('cm_' + Math.floor(Math.random() * 1e9), 'pass1234', 'CrewMember');
  const solo = await reg('cs_' + Math.floor(Math.random() * 1e9), 'pass1234', 'SoloOwner');
  await post('/api/follow/' + member.user.id, {}, owner.token);
  await post('/api/follow-requests/' + owner.user.id + '/accept', {}, member.token);
  await post('/api/follow/' + owner.user.id, {}, member.token);
  await post('/api/follow-requests/' + member.user.id + '/accept', {}, owner.token);

  const crew = await post('/api/crews', { name: 'Leg Day Crew', memberIds: [member.user.id] }, owner.token);
  ok(crew.id && crew.members && crew.members.length === 2, `crew created with owner + member (got ${JSON.stringify(crew)})`);
  const soloCrew = await post('/api/crews', { name: 'Solo Crew', memberIds: [] }, solo.token);
  ok(soloCrew.id, `solo-member crew created (got ${JSON.stringify(soloCrew)})`);

  const ownerDel = await post('/api/me/delete-account', { password: 'pass1234' }, owner.token);
  ok(ownerDel.ok === true, `crew owner deletes their account (got ${JSON.stringify(ownerDel)})`);
  const soloDel = await post('/api/me/delete-account', { password: 'pass1234' }, solo.token);
  ok(soloDel.ok === true, `solo crew owner deletes their account (got ${JSON.stringify(soloDel)})`);

  const crewAfter = await fetch(B + '/api/crews/' + crew.id, { headers: { Authorization: 'Bearer ' + member.token } }).then(r => r.json());
  ok(crewAfter && crewAfter.ownerId === null, `the crew pivoted to ownerless, not left pointing at the deleted account (got ownerId ${crewAfter && crewAfter.ownerId})`);
  ok(crewAfter && crewAfter.isOwner === false, 'and nobody -- including the remaining member -- reads as owner');
  ok(crewAfter && Array.isArray(crewAfter.members) && crewAfter.members.length === 2 && crewAfter.members.some(m => m.displayName === 'Deleted user'),
     `the deleted owner stays a member, displaying as "Deleted user" rather than vanishing or breaking the roster (got ${JSON.stringify(crewAfter && crewAfter.members)})`);

  const put = await fetch(B + '/api/crews/' + crew.id, { method: 'PUT', headers: { ...J, Authorization: 'Bearer ' + member.token }, body: JSON.stringify({ name: 'New Name' }) }).then(r => r.json());
  ok(!!put.error, `an ownerless crew can no longer be renamed by anyone, including a current member (got ${JSON.stringify(put)})`);
  const challenge = await postRaw('/api/crews/' + crew.id + '/challenge', { type: 'workouts' }, member.token);
  ok(challenge.status === 403, `and no one can start a new challenge on an ownerless crew either (got ${challenge.status})`);
  const leave = await post('/api/crews/' + crew.id + '/leave', {}, member.token);
  ok(leave.ok === true, 'but a current member can still leave an ownerless crew normally');

  const soloCrewAfter = await readCrew(soloCrew.id);
  ok(!soloCrewAfter, `a solo-member crew is deleted outright rather than left ownerless with no one in it (got ${JSON.stringify(soloCrewAfter)})`);
}

// Sep 29 2026 (audit finding, Tier 1 #1): nothing capped how many times a valid-but-stolen token
// could guess an account's real password against /api/me/password, /api/me/delete-account, or
// /api/me/reset-workouts. All three now share ONE 'pw-confirm:'+userId failCount/bumpFail/
// clearFail counter (only WRONG guesses count against the cap, a correct one clears it) -- a
// single shared budget across all three routes, not 10 per route, per a cold-review catch: since
// all three check the exact same verifyPin(u,...) against the same password hash, a separate
// counter per route would have let a stolen token get 3x the effective guesses just by rotating
// which route it hit. reset-workouts.mjs's own guard-rail block separately covers that route's
// password requirement itself; this block is what actually proves the counter is shared.
// Sep 30 2026 (audit finding, round-2 Tier 1 #1): /api/me/username joined the same four-way
// shared budget when it gained its own password requirement (see that route's comment in
// server.js) -- the block below now also proves a lockout driven from ANY of the four routes
// blocks username changes too, not a 4th, separately-resettable 10-guess budget.
console.log('\nrate limiting on the password-confirmation routes, shared across all four (Tier 1 #1)');
{
  const u = await reg('rl_' + Date.now(), 'pass1234', 'RL');
  for (let i = 0; i < 10; i++) {
    const r = await post('/api/me/password', { currentPassword: 'wrongpass', newPassword: 'irrelevant1' }, u.token);
    ok(r.error === 'Current password is incorrect', `wrong guess ${i + 1}/10 is refused normally, not yet locked out (got ${JSON.stringify(r)})`);
  }
  const locked = await postRaw('/api/me/password', { currentPassword: 'wrongpass', newPassword: 'irrelevant1' }, u.token);
  ok(locked.status === 429, `the 11th wrong guess in a row is rate-limited (got ${locked.status})`);
  // A CORRECT guess right after must still be refused while locked out -- the lockout blocks the
  // account for a while regardless of whether this particular attempt would have succeeded,
  // exactly like the existing login lockout already behaves.
  const correctWhileLocked = await postRaw('/api/me/password', { currentPassword: 'pass1234', newPassword: 'newpass12' }, u.token);
  ok(correctWhileLocked.status === 429, 'even the right password is refused while locked out, same as the login lockout');
  // The lockout carries over to the OTHER two password-confirmation routes too -- proves the
  // counter is genuinely shared, not three separate 10-guess budgets an attacker could rotate
  // between.
  const lockedOnDelete = await postRaw('/api/me/delete-account', { password: 'pass1234' }, u.token);
  ok(lockedOnDelete.status === 429, `the same lockout blocks delete-account too, even with the right password (got ${lockedOnDelete.status})`);
  const lockedOnReset = await postRaw('/api/me/reset-workouts', { password: 'pass1234' }, u.token);
  ok(lockedOnReset.status === 429, `and reset-workouts, same shared budget (got ${lockedOnReset.status})`);
  const lockedOnUsername = await postRaw('/api/me/username', { username: 'rl_newname_' + Date.now(), password: 'pass1234' }, u.token);
  ok(lockedOnUsername.status === 429, `and username change -- the round-2 Tier 1 #1 fix -- shares the exact same budget too, even with the right password (got ${lockedOnUsername.status})`);

  // A separate account is entirely unaffected -- this is a per-account cap, not global.
  const other = await reg('rl2_' + Date.now(), 'pass1234', 'RL2');
  const otherOk = await post('/api/me/password', { currentPassword: 'pass1234', newPassword: 'newpass12' }, other.token);
  ok(otherOk.ok === true, `a different account's own password change is unaffected (got ${JSON.stringify(otherOk)})`);
}

srv.kill();
await testDb.drop();
console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
