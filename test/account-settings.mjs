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
  const taken = await post('/api/me/username', { username: uname2 }, a.token);
  ok(taken.error, `changing to an already-taken username is refused (got ${JSON.stringify(taken)})`);
  const takenCase = await post('/api/me/username', { username: uname2.toUpperCase() }, a.token);
  ok(takenCase.error, 'refused case-insensitively too, not just an exact match');
  const bad = await post('/api/me/username', { username: 'ab' }, a.token);
  ok(bad.error, 'the same 3-20 char rule registration uses is enforced here too');
  const reserved = await post('/api/me/username', { username: 'admin' }, a.token);
  ok(reserved.error, 'a reserved name is refused');
  const deletedPrefix = await post('/api/me/username', { username: 'deleted_abc12345' }, a.token);
  ok(deletedPrefix.error, 'a "deleted_" prefixed name is refused -- reserved for anonymized accounts');
  const newName = 'un1renamed_' + Math.floor(Math.random() * 1e9);
  const r = await post('/api/me/username', { username: newName }, a.token);
  ok(r.username === newName, `a genuinely free username is accepted (got ${JSON.stringify(r)})`);
  const loggedIn = await login(newName, 'pass1234');
  ok(!!loggedIn.token, 'and immediately logs in under the new name');
  const oldGone = await login(uname1, 'pass1234');
  ok(!oldGone.token, 'the old username no longer logs in');
  // Re-submitting your OWN current username (unchanged, or just a different capitalisation) must
  // not trip the "taken" check against yourself.
  const same = await post('/api/me/username', { username: newName.toUpperCase() }, a.token);
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

// Sep 29 2026 (audit finding, Tier 1 #1): nothing capped how many times a valid-but-stolen token
// could guess an account's real password against /api/me/password, /api/me/delete-account, or
// /api/me/reset-workouts. All three now share ONE 'pw-confirm:'+userId failCount/bumpFail/
// clearFail counter (only WRONG guesses count against the cap, a correct one clears it) -- a
// single shared budget across all three routes, not 10 per route, per a cold-review catch: since
// all three check the exact same verifyPin(u,...) against the same password hash, a separate
// counter per route would have let a stolen token get 3x the effective guesses just by rotating
// which route it hit. reset-workouts.mjs's own guard-rail block separately covers that route's
// password requirement itself; this block is what actually proves the counter is shared.
console.log('\nrate limiting on the password-confirmation routes, shared across all three (Tier 1 #1)');
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

  // A separate account is entirely unaffected -- this is a per-account cap, not global.
  const other = await reg('rl2_' + Date.now(), 'pass1234', 'RL2');
  const otherOk = await post('/api/me/password', { currentPassword: 'pass1234', newPassword: 'newpass12' }, other.token);
  ok(otherOk.ok === true, `a different account's own password change is unaffected (got ${JSON.stringify(otherOk)})`);
}

srv.kill();
await testDb.drop();
console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
