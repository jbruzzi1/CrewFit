// Oct 20 2026 (app-store readiness review item: "Expand content filtering beyond custom exercise
// names to display names, captions, crew/session names, and other free text"). Custom exercise
// names already had this check (Sep 30 2026, see its own comment above POST /api/exercises/custom
// in server.js) -- this closes the rest of the gap. One shared helper, profanityProblem() in
// server.js, is now called (before any mutation -- see each call site's own comment) at every
// other place a person writes free text that other people can see: username (both registration
// and the dedicated change route, via usernameProblem), displayName (registration + edit), bio,
// crew name (create + rename), crew chat messages (create + edit), a crew's custom-challenge
// title, routine/template name (create + edit), session name/location/creator-note (create +
// edit), the live in-workout chat (create + edit), a posted recap's caption ("notes") and its
// comments (create + edit), a decline reason, a reinvite-request message, and a join-request
// note.
//
// Deliberately NOT filtered, disclosed here rather than silently left as an unexplained gap:
//   - draftNotes (POST /api/sessions/:id/draft-notes) -- explicitly own-eyes-only scratch, never
//     shown to anyone else (see sessionView's own "yourself and nobody else" comment); nothing to
//     moderate if nobody but the author ever sees it.
//   - a filed report's "details" field (POST /api/report) -- a reporter describing abusive
//     behavior often has to quote the offending language; blocking that would make it harder,
//     not easier, to report exactly the content this whole feature exists to catch.
// Both are checked below too, confirming they still accept the same word the filtered routes
// reject -- proving the exclusion is a deliberate, verified design choice, not an oversight.
//
// Real server + real Postgres, same shape as test/age-gate.mjs / test/data-export.mjs. One
// reusable BAD phrase (the exact one test/audit-sep30-fixes.mjs already uses for the custom-
// exercise-name check, so this suite stays consistent with what the maintained word list already
// proved it catches) run through every covered field; each assertion also proves an ordinary,
// clean value of the same field still succeeds, so this isn't just "everything 400s now."
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const J = { 'Content-Type': 'application/json' };
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('contentfilter');
const BAD = 'fuck this';
const rand = () => Math.random().toString(36).slice(2, 8);

function boot(port, dir) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    srv.stdout.on('data', d => { if (String(d).includes('CrewFit on')) res(srv); });
    srv.on('exit', () => res(null));
    setTimeout(() => res(srv), 15000);
  });
}

const DIR = mkdtempSync(join(tmpdir(), 'contentfilter-'));
const PORT = 4796, B = `http://localhost:${PORT}`;
const srv = await boot(PORT, DIR);
ok(!!srv, 'server boots');

let cleanedUp = false;
async function cleanup() {
  if (cleanedUp) return; cleanedUp = true;
  try { srv && srv.kill(); } catch {}
  try { await testDb.drop(); } catch {}
}
process.on('uncaughtException', async (e) => { console.error('UNCAUGHT', e); await cleanup(); process.exit(1); });
process.on('unhandledRejection', async (e) => { console.error('UNHANDLED', e); await cleanup(); process.exit(1); });

const post = (p, b, tok) => fetch(B + p, { method: 'POST', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b || {}) }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }));
const put  = (p, b, tok) => fetch(B + p, { method: 'PUT',  headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b || {}) }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }));
const get  = (p, tok) => fetch(B + p, { headers: tok ? { Authorization: 'Bearer ' + tok } : {} }).then(r => r.json());
const reg  = async (username, displayName) => { const r = await post('/api/register', { ageConfirmed: true, username, pin: 'pass1234', displayName: displayName || username }); return r.json; };
const rejects = (r, label) => ok(r.status === 400 && /allowed/i.test((r.json && r.json.error) || ''), `${label} (got ${r.status} ${JSON.stringify(r.json)})`);
const allows  = (r, label) => ok(r.status === 200 || r.status === 201, `${label} (got ${r.status} ${JSON.stringify(r.json)})`);

try {

const EX_LIB = await get('/api/exercises');
const EX_NAME = EX_LIB[0].name;
const MUSCLE = EX_LIB[0].muscle_groups[0];

console.log('username: registration and the dedicated change route both reject it, and a clean value still works');
{
  const bad = await post('/api/register', { ageConfirmed: true, username: 'cf_fuck_bad', pin: 'pass1234', displayName: 'X' });
  rejects(bad, 'a profane username is rejected at registration');
  // Not "still available" -- GET /api/register/check already runs usernameProblem() too (same
  // function, now with the same profanity check), so it correctly flags this live, as the user
  // types, with the real reason rather than falling through to "already taken." The actual point
  // here -- no account exists under this name -- is proven by the login attempt below instead.
  const check = await fetch(B + '/api/register/check?username=cf_fuck_bad').then(r => r.json());
  ok(check.available === false && /allowed/i.test(check.reason || ''),
    `and the live availability check flags the same problem, not "already taken" (got ${JSON.stringify(check)})`);
  const loginAttempt = await post('/api/login', { username: 'cf_fuck_bad', pin: 'pass1234' });
  ok(!!(loginAttempt.json && loginAttempt.json.error), `and no account was actually created -- a login attempt for it fails (got ${JSON.stringify(loginAttempt.json)})`);

  const u = await reg('cf_user_' + rand());
  const badChange = await post('/api/me/username', { username: 'cf_fuck_rename', password: 'pass1234' }, u.token);
  rejects(badChange, 'changing to a profane username is rejected the same way');
  const okChange = await post('/api/me/username', { username: 'cf_cl_' + rand(), password: 'pass1234' }, u.token);
  allows(okChange, 'an ordinary username change still succeeds');
}

console.log('\ndisplayName: registration (explicit value, and the username-fallback default) and the edit route');
{
  const bad = await post('/api/register', { ageConfirmed: true, username: 'cf_dn_bad_' + rand(), pin: 'pass1234', displayName: BAD });
  rejects(bad, 'a profane displayName is rejected at registration');

  const u = await reg('cf_dn2_' + rand(), 'Clean Name');
  const badEdit = await post('/api/me/display-name', { displayName: BAD }, u.token);
  rejects(badEdit, 'editing displayName to something profane is rejected');
  const okEdit = await post('/api/me/display-name', { displayName: 'Still Clean' }, u.token);
  allows(okEdit, 'an ordinary displayName edit still succeeds');
}

console.log('\nbio');
{
  const u = await reg('cf_bio_' + rand());
  const bad = await post('/api/me/bio', { bio: BAD }, u.token);
  rejects(bad, 'a profane bio is rejected');
  const okBio = await post('/api/me/bio', { bio: 'Just here to lift.' }, u.token);
  allows(okBio, 'an ordinary bio still succeeds');
}

console.log('\ncrew name: create and rename');
{
  const owner = await reg('cf_crew_' + rand());
  const badCreate = await post('/api/crews', { name: BAD }, owner.token);
  rejects(badCreate, 'creating a crew with a profane name is rejected');
  const c = await post('/api/crews', { name: 'Clean Crew' }, owner.token);
  allows(c, 'creating a crew with a clean name still succeeds');
  const badRename = await put('/api/crews/' + c.json.id, { name: BAD }, owner.token);
  rejects(badRename, 'renaming a crew to something profane is rejected');
  const okRename = await put('/api/crews/' + c.json.id, { name: 'Still Clean Crew' }, owner.token);
  allows(okRename, 'an ordinary crew rename still succeeds');
}

console.log('\ncrew chat: post a message and edit it');
{
  const owner = await reg('cf_crewchat_' + rand());
  const c = await post('/api/crews', { name: 'Chat Crew ' + rand() }, owner.token);
  const badMsg = await post(`/api/crews/${c.json.id}/messages`, { text: BAD }, owner.token);
  rejects(badMsg, 'a profane crew message is rejected');
  const okMsg = await post(`/api/crews/${c.json.id}/messages`, { text: 'see everyone at 6am' }, owner.token);
  allows(okMsg, 'an ordinary crew message still succeeds');
  const badEdit = await put(`/api/crews/${c.json.id}/messages/${okMsg.json.id}`, { text: BAD }, owner.token);
  rejects(badEdit, 'editing a crew message to something profane is rejected');
  const okEdit = await put(`/api/crews/${c.json.id}/messages/${okMsg.json.id}`, { text: 'see everyone at 7am instead' }, owner.token);
  allows(okEdit, 'an ordinary crew message edit still succeeds');
}

console.log('\ncrew custom-challenge title');
{
  const owner = await reg('cf_chal_' + rand());
  const c = await post('/api/crews', { name: 'Challenge Crew ' + rand() }, owner.token);
  const bad = await post(`/api/crews/${c.json.id}/challenge`, { type: 'custom', title: BAD }, owner.token);
  rejects(bad, 'a profane custom-challenge title is rejected');
  const okChal = await post(`/api/crews/${c.json.id}/challenge`, { type: 'custom', title: 'Most pushups this week' }, owner.token);
  allows(okChal, 'an ordinary custom-challenge title still succeeds');
}

console.log('\ntemplate/routine name: create and edit');
{
  const owner = await reg('cf_tpl_' + rand());
  const badCreate = await post('/api/templates', { name: BAD, exercises: [{ name: EX_NAME }] }, owner.token);
  rejects(badCreate, 'creating a routine with a profane name is rejected');
  const t = await post('/api/templates', { name: 'Clean Routine', exercises: [{ name: EX_NAME }] }, owner.token);
  allows(t, 'creating a routine with a clean name still succeeds');
  const badEdit = await put('/api/templates/' + t.json.id, { name: BAD }, owner.token);
  rejects(badEdit, 'renaming a routine to something profane is rejected');
  const okEdit = await put('/api/templates/' + t.json.id, { name: 'Still Clean Routine' }, owner.token);
  allows(okEdit, 'an ordinary routine rename still succeeds');
}

console.log('\nsession name/location/creatorNote: create and edit');
{
  const owner = await reg('cf_sess_' + rand());
  const badName = await post('/api/sessions', { name: BAD, exercises: [{ name: EX_NAME }], visibility: 'private' }, owner.token);
  rejects(badName, 'creating a session with a profane name is rejected');
  const badLoc = await post('/api/sessions', { name: 'Fine', location: BAD, exercises: [{ name: EX_NAME }], visibility: 'private' }, owner.token);
  rejects(badLoc, 'creating a session with a profane location is rejected');
  const badNote = await post('/api/sessions', { name: 'Fine', creatorNote: BAD, exercises: [{ name: EX_NAME }], visibility: 'private' }, owner.token);
  rejects(badNote, 'creating a session with a profane creatorNote is rejected');

  const s = await post('/api/sessions', { name: 'Leg Day', location: 'Gold\'s Gym', creatorNote: 'bring straps', exercises: [{ name: EX_NAME }], visibility: 'private' }, owner.token);
  allows(s, 'creating a session with ordinary name/location/creatorNote still succeeds');
  const sid = s.json.id;

  const badEditName = await put('/api/sessions/' + sid, { name: BAD }, owner.token);
  rejects(badEditName, 'editing a session name to something profane is rejected');
  const badEditLoc = await put('/api/sessions/' + sid, { location: BAD }, owner.token);
  rejects(badEditLoc, 'editing a session location to something profane is rejected');
  const badEditNote = await put('/api/sessions/' + sid, { creatorNote: BAD }, owner.token);
  rejects(badEditNote, 'editing a session creatorNote to something profane is rejected');
  const okEdit = await put('/api/sessions/' + sid, { name: 'Leg Day (updated)' }, owner.token);
  allows(okEdit, 'an ordinary session edit still succeeds');

  // The session must still be exactly as it was before any of the rejected edits above --
  // proof that a rejected PUT (validated before the lock/mutation, see server.js's own comment)
  // never partially applied, not just that it returned 400.
  const fresh = await get('/api/sessions/' + sid, owner.token);
  ok(fresh.location === "Gold's Gym" && fresh.creatorNote === 'bring straps',
    `rejected location/creatorNote edits left the session's real values untouched (got location=${JSON.stringify(fresh.location)}, creatorNote=${JSON.stringify(fresh.creatorNote)})`);
}

console.log('\nlive in-workout chat: post a comment and edit it');
{
  const owner = await reg('cf_chat_' + rand());
  const s = await post('/api/sessions', { name: 'Chat Session', exercises: [{ name: EX_NAME }], visibility: 'private' }, owner.token);
  const sid = s.json.id;
  const bad = await post(`/api/sessions/${sid}/comments`, { text: BAD }, owner.token);
  rejects(bad, 'a profane workout-chat message is rejected');
  const okMsg = await post(`/api/sessions/${sid}/comments`, { text: 'starting in 5' }, owner.token);
  allows(okMsg, 'an ordinary workout-chat message still succeeds');
  const commentId = okMsg.json.comments[okMsg.json.comments.length - 1].id;
  const badEdit = await put(`/api/sessions/${sid}/comments/${commentId}`, { text: BAD }, owner.token);
  rejects(badEdit, 'editing a workout-chat message to something profane is rejected');
}

console.log('\nposted-recap caption ("notes") and its comments');
{
  const author = await reg('cf_post_' + rand());
  const commenter = await reg('cf_commenter_' + rand());
  const s = await post('/api/sessions', { name: 'Recap Session', exercises: [{ name: EX_NAME }], visibility: 'public', inviteUsernames: [] }, author.token);
  const sid = s.json.id;
  await post(`/api/sessions/${sid}/log`, { exerciseId: s.json.exercises[0].id, weight: 100, reps: 5 }, author.token);

  const badPost = await post(`/api/sessions/${sid}/post`, { notes: BAD, visibility: 'public' }, author.token);
  rejects(badPost, 'posting a recap with a profane caption is rejected');
  const okPost = await post(`/api/sessions/${sid}/post`, { notes: 'great session today', visibility: 'public' }, author.token);
  allows(okPost, 'posting a recap with an ordinary caption still succeeds');

  await post('/api/follow/' + author.user.id, {}, commenter.token);
  const badComment = await post(`/api/sessions/${sid}/posts/${author.user.id}/comments`, { text: BAD }, commenter.token);
  rejects(badComment, 'commenting on a posted recap with profanity is rejected');
  const okComment = await post(`/api/sessions/${sid}/posts/${author.user.id}/comments`, { text: 'nice work!' }, commenter.token);
  allows(okComment, 'an ordinary recap comment still succeeds');
  const recapComments = okComment.json.posts[author.user.id].comments;
  const recapCommentId = recapComments[recapComments.length - 1].id;
  const badCommentEdit = await put(`/api/sessions/${sid}/posts/${author.user.id}/comments/${recapCommentId}`, { text: BAD }, commenter.token);
  rejects(badCommentEdit, 'editing a recap comment to something profane is rejected');
}

console.log('\ndecline reason');
{
  const host = await reg('cf_dhost_' + rand());
  const invitee = await reg('cf_declinee_' + rand());
  await post('/api/follow/' + invitee.user.id, {}, host.token);
  const s = await post('/api/sessions', { name: 'Invite Session', exercises: [{ name: EX_NAME }], visibility: 'private', inviteUsernames: [invitee.user.username] }, host.token);
  const sid = s.json.id;
  const badDecline = await post(`/api/sessions/${sid}/decline`, { reason: BAD }, invitee.token);
  rejects(badDecline, 'a profane decline reason is rejected');
  // Still invited afterward -- the rejected decline (checked before any mutation) never partially
  // removed the invite.
  const stillInvited = await get('/api/sessions/' + sid, invitee.token);
  ok(stillInvited.id === sid, `the invite is untouched after the rejected decline (got ${JSON.stringify(stillInvited.error || stillInvited.id)})`);
  const okDecline = await post(`/api/sessions/${sid}/decline`, { reason: 'can’t make it tonight' }, invitee.token);
  allows(okDecline, 'an ordinary decline reason still succeeds');
}

console.log('\nreinvite-request message');
{
  const host = await reg('cf_reinvhost_' + rand());
  const asker = await reg('cf_reinvasker_' + rand());
  const s = await post('/api/sessions', { name: 'Reinvite Session', exercises: [{ name: EX_NAME }], visibility: 'private' }, host.token);
  const sid = s.json.id;
  const bad = await post(`/api/sessions/${sid}/reinvite-request`, { message: BAD }, asker.token);
  rejects(bad, 'a profane reinvite-request message is rejected');
  const okReq = await post(`/api/sessions/${sid}/reinvite-request`, { message: 'changed my mind, can I join?' }, asker.token);
  allows(okReq, 'an ordinary reinvite-request message still succeeds');
}

console.log('\njoin-request note');
{
  const host = await reg('cf_joinhost_' + rand());
  const asker = await reg('cf_joinasker_' + rand());
  const s = await post('/api/sessions', { name: 'Joinable Session', exercises: [{ name: EX_NAME }], visibility: 'public' }, host.token);
  const sid = s.json.id;
  const bad = await post(`/api/sessions/${sid}/join`, { note: BAD }, asker.token);
  rejects(bad, 'a profane join-request note is rejected');
  const okJoin = await post(`/api/sessions/${sid}/join`, { note: 'would love to join!' }, asker.token);
  allows(okJoin, 'an ordinary join-request note still succeeds');
}

console.log('\ndeliberately NOT filtered, verified rather than just asserted in a comment: draftNotes (own-eyes-only) and a filed report\'s "details"');
{
  const owner = await reg('cf_draft_' + rand());
  const s = await post('/api/sessions', { name: 'Draft Session', exercises: [{ name: EX_NAME }], visibility: 'private' }, owner.token);
  const draft = await post(`/api/sessions/${s.json.id}/draft-notes`, { notes: BAD }, owner.token);
  allows(draft, 'draftNotes accepts the same phrase every filtered route rejects -- own-eyes-only, deliberately excluded');

  const reporter = await reg('cf_reporter_' + rand());
  const target = await reg('cf_target_' + rand());
  const report = await post('/api/report', { targetType: 'user', targetUserId: target.user.id, reason: 'harassment', details: BAD }, reporter.token);
  allows(report, 'a filed report\'s own description accepts the same phrase too -- reporting abusive language must not itself be blocked');
}

} finally {
  await cleanup();
}

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
