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
// comments (create + edit), a decline reason, a reinvite-request message, a join-request note,
// and -- added Oct 21 2026 after a cold-review pass caught the first version missed this --
// exercise names everywhere they're shared text: the pre-existing custom-exercise-name check
// (migrated onto the shared helper, closing the same _/- gap there), session create/edit,
// template create/edit, and the owned + ownerless /suggest routes (both "add" and swap).
//
// Deliberately NOT filtered, disclosed here rather than silently left as an unexplained gap:
//   - draftNotes (POST /api/sessions/:id/draft-notes) -- explicitly own-eyes-only scratch, never
//     shown to anyone else (see sessionView's own "yourself and nobody else" comment); nothing to
//     moderate if nobody but the author ever sees it.
//   - POST /api/sessions/:id/variation -- a personal, view-only exercise rename; sessionView only
//     ever returns the viewer's OWN variation (pickMine), never another participant's, same own-
//     eyes-only shape as draftNotes.
//   - suggestOwnerless's still-invited "private pre-join swap" -- applied only to that one
//     person's own card once they join, never a group proposal, never shown to anyone else (see
//     that branch's own comment and sessionView's suggestedEdits filter).
//   - a filed report's "details" field (POST /api/report) -- a reporter describing abusive
//     behavior often has to quote the offending language; blocking that would make it harder,
//     not easier, to report exactly the content this whole feature exists to catch.
// All four are checked below too, confirming they still accept the same word the filtered routes
// reject -- proving the exclusion is a deliberate, verified design choice, not an oversight.
//
// Oct 21 2026 (Jeff: "I think we should be allowed to swear... only derogatory words should be
// blocked or racial slurs. fuck, shit, kick ass, etc should not be blocked."). server.js's
// profanityFilter.remove() call now takes casual swearing (fuck/shit/ass plus, per Jeff's explicit
// follow-up answer, the borderline tier too: dick/piss/bastard/bitch, and their direct forms) OFF
// the blocklist, while leaving every slur and every explicit-sexual/exploitative term on it --
// this app has 13+ users (see the age-gate feature), and none of that was what "fuck yeah!" was
// about. BAD below was changed from the original 'fuck this' (now allowed) to a phrase that's
// still blocked and isn't a slur, so every pre-existing assertion in this file keeps meaning the
// same thing: "a profane value is rejected". A separate section near the end proves the newly-
// allowed words specifically pass, and that the scope stayed narrow (explicit content and a
// couple of ableist/gendered compound terms are still caught) -- without putting any actual slur
// literal in this file; the exact removed-word list in server.js is itself the proof slurs were
// never touched, not something re-derived here.
//
// Real server + real Postgres, same shape as test/age-gate.mjs / test/data-export.mjs. One
// reusable BAD phrase run through every covered field; each assertion also proves an ordinary,
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
const BAD = 'literal porn content';   // still blocked post-Oct-21; see the header comment above
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

console.log('username: registration and the dedicated change route both reject it (including the _/- separator evasion gap), and a clean value still works');
{
  // 'fuck' is now an allowed word (Oct 21 2026, see the swear-word section below), so this uses
  // 'porn' instead -- still blocked, and 'cf_porn_bad' still exercises the exact evasion gap this
  // test was written to prove closed: leo-profanity's check() doesn't tokenize on '_'/'-', so the
  // RAW check on this whole string would miss it; profanityProblem()'s own '_'/'-'-to-space
  // normalization is what catches it.
  const bad = await post('/api/register', { ageConfirmed: true, username: 'cf_porn_bad', pin: 'pass1234', displayName: 'X' });
  rejects(bad, 'a profane username (via the _/- separator evasion gap) is rejected at registration');
  // Not "still available" -- GET /api/register/check already runs usernameProblem() too (same
  // function, now with the same profanity check), so it correctly flags this live, as the user
  // types, with the real reason rather than falling through to "already taken." The actual point
  // here -- no account exists under this name -- is proven by the login attempt below instead.
  const check = await fetch(B + '/api/register/check?username=cf_porn_bad').then(r => r.json());
  ok(check.available === false && /allowed/i.test(check.reason || ''),
    `and the live availability check flags the same problem, not "already taken" (got ${JSON.stringify(check)})`);
  const loginAttempt = await post('/api/login', { username: 'cf_porn_bad', pin: 'pass1234' });
  ok(!!(loginAttempt.json && loginAttempt.json.error), `and no account was actually created -- a login attempt for it fails (got ${JSON.stringify(loginAttempt.json)})`);

  const u = await reg('cf_user_' + rand());
  const badChange = await post('/api/me/username', { username: 'cf_porn_rename', password: 'pass1234' }, u.token);
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

// Oct 21 2026 (cold-review finding, follow-up): the first pass of this feature missed exercise
// names entirely -- withDefaults' own comment ("another user's exercise name renders in your
// app") is exactly the risk this feature exists to close, and every one of these call sites went
// straight through withDefaults/the custom-exercise route with no check. Covers: the pre-existing
// custom-exercise-name check (now migrated to the shared helper, closing the same _/- gap there
// too), session create/edit, template create/edit, and both the owned and ownerless /suggest
// routes (add + swap) -- while confirming the two genuinely own-eyes-only exceptions (a still-
// invited pre-join private swap, and POST /variation's personal view-only swap) are deliberately
// left unfiltered, same reasoning as draftNotes below.
console.log('\ncustom exercise name: the _/- separator evasion gap (migrated to the shared helper) is now closed here too');
{
  const u = await reg('cf_exmig_' + rand());
  // 'fuck' is now an allowed word (see the Oct 21 swear-word section below), so the gap is
  // reproduced here with 'porn' instead -- still blocked, and the same underscore-tokenization
  // gap applies regardless of which word is in the dictionary.
  const badUnderscore = await post('/api/exercises/custom', { name: 'cf_porn_bad', muscle_groups: [MUSCLE] }, u.token);
  rejects(badUnderscore, 'an underscore-separated profane custom exercise name is now rejected (slipped through the pre-migration raw check)');
  const okName = await post('/api/exercises/custom', { name: 'My Custom Lift ' + rand(), muscle_groups: [MUSCLE] }, u.token);
  allows(okName, 'an ordinary custom exercise name still succeeds');
}

console.log('\nsession create/edit: exercise names inside the exercises array are filtered too (not just name/location/creatorNote)');
{
  const u = await reg('cf_exsess_' + rand());
  const bad = await post('/api/sessions', { name: 'Clean Name', exercises: [{ name: BAD }], visibility: 'private' }, u.token);
  rejects(bad, 'creating a session with a profane exercise name is rejected');
  const okS = await post('/api/sessions', { name: 'Clean Name', exercises: [{ name: EX_NAME }], visibility: 'private' }, u.token);
  allows(okS, 'a session with an ordinary exercise name still succeeds');
  const sid = okS.json.id;

  const badEdit = await put(`/api/sessions/${sid}`, { exercises: [{ name: BAD }] }, u.token);
  rejects(badEdit, 'editing a session to add a profane exercise name is rejected');
  const unchanged = await get('/api/sessions/' + sid, u.token);
  ok(unchanged.exercises.length === 1 && unchanged.exercises[0].name === EX_NAME, `the rejected exercise edit left the exercise list untouched (got ${JSON.stringify(unchanged.exercises)})`);
  const okEdit = await put(`/api/sessions/${sid}`, { exercises: [{ name: EX_NAME }, { name: 'Lunges' }] }, u.token);
  allows(okEdit, 'an ordinary exercise-name edit still succeeds');
}

console.log('\ntemplate create/edit: exercise names inside the exercises array are filtered too');
{
  const u = await reg('cf_extpl_' + rand());
  const bad = await post('/api/templates', { name: 'Clean Template', exercises: [{ name: BAD }] }, u.token);
  rejects(bad, 'creating a routine with a profane exercise name is rejected');
  const okT = await post('/api/templates', { name: 'Clean Template', exercises: [{ name: EX_NAME }] }, u.token);
  allows(okT, 'a routine with an ordinary exercise name still succeeds');
  const tid = okT.json.id;
  const badEdit = await put('/api/templates/' + tid, { exercises: [{ name: BAD }] }, u.token);
  rejects(badEdit, 'editing a routine to a profane exercise name is rejected');
  const okTplEdit = await put('/api/templates/' + tid, { exercises: [{ name: 'Lunges' }] }, u.token);
  allows(okTplEdit, 'an ordinary routine exercise-name edit still succeeds');
}

console.log('\nsuggest route (owned session): a new-exercise "add" name and a swap\'s swapTo are both filtered, before the shared plan is ever touched');
{
  const host = await reg('cf_sughost_' + rand());
  const participant = await reg('cf_sugpart_' + rand());
  await post('/api/follow/' + participant.user.id, {}, host.token);
  const s = await post('/api/sessions', { name: 'Suggest Session', exercises: [{ name: EX_NAME }], visibility: 'private', inviteUsernames: [participant.user.username] }, host.token);
  const sid = s.json.id;
  await post(`/api/sessions/${sid}/accept`, {}, participant.token);

  const badAdd = await post(`/api/sessions/${sid}/suggest`, { type: 'add', name: BAD }, participant.token);
  rejects(badAdd, 'a profane "suggest add" exercise name is rejected');
  const okAdd = await post(`/api/sessions/${sid}/suggest`, { type: 'add', name: 'Lunges' }, participant.token);
  allows(okAdd, 'an ordinary "suggest add" exercise name still succeeds');

  const existingExId = s.json.exercises[0].id;
  const badSwap = await post(`/api/sessions/${sid}/suggest`, { type: 'swap', exerciseId: existingExId, swapTo: BAD }, participant.token);
  rejects(badSwap, 'a profane swap suggestion is rejected');
  const okSwap = await post(`/api/sessions/${sid}/suggest`, { type: 'swap', exerciseId: existingExId, swapTo: 'Lunges Variant' }, participant.token);
  allows(okSwap, 'an ordinary swap suggestion still succeeds');
}

console.log('\nsuggest route (ownerless session): "add" and the already-joined group swap are filtered; the still-invited private pre-join swap stays deliberately unfiltered (own-eyes-only, same reasoning as draftNotes)');
{
  const host = await reg('cf_ownhost_' + rand());
  const a = await reg('cf_owna_' + rand());
  const b = await reg('cf_ownb_' + rand());
  await post('/api/follow/' + a.user.id, {}, host.token);
  await post('/api/follow/' + b.user.id, {}, host.token);
  const s = await post('/api/sessions', { name: 'Ownerless Suggest Session', exercises: [{ name: EX_NAME }], visibility: 'private', inviteUsernames: [a.user.username, b.user.username] }, host.token);
  const sid = s.json.id;
  await post(`/api/sessions/${sid}/accept`, {}, a.token);
  // b deliberately stays invited, never accepts -- the still-invited, private-pre-join case below.
  await post(`/api/sessions/${sid}/leave`, { keep: true }, host.token);   // now ownerless; a is the sole current participant

  const badAdd = await post(`/api/sessions/${sid}/suggest`, { type: 'add', name: BAD }, a.token);
  rejects(badAdd, 'a profane ownerless "add" exercise name is rejected');
  const okAdd = await post(`/api/sessions/${sid}/suggest`, { type: 'add', name: 'Lunges' }, a.token);
  allows(okAdd, 'an ordinary ownerless "add" exercise name still succeeds');

  const existingExId = s.json.exercises[0].id;
  const badSwap = await post(`/api/sessions/${sid}/suggest`, { type: 'swap', exerciseId: existingExId, swapTo: BAD }, a.token);
  rejects(badSwap, 'a profane ownerless group-swap proposal is rejected');
  const okSwap = await post(`/api/sessions/${sid}/suggest`, { type: 'swap', exerciseId: existingExId, swapTo: 'Lunges Variant' }, a.token);
  allows(okSwap, 'an ordinary ownerless group-swap proposal still succeeds');

  // b is still-invited -- hits suggestOwnerless's privatePreJoin branch, which never shows this
  // text to anyone but b (see sessionView's suggestedEdits filter and this branch's own comment),
  // applied as b's own personal variation only once they actually join -- deliberately unfiltered
  // for the same own-eyes-only reason as draftNotes below.
  const preJoin = await post(`/api/sessions/${sid}/suggest`, { type: 'swap', exerciseId: existingExId, swapTo: BAD }, b.token);
  allows(preJoin, 'a still-invited pre-join private swap accepts the same phrase -- own-eyes-only, deliberately excluded like draftNotes');
}

console.log('\nOct 21 2026 (Jeff: casual swearing should be allowed): the removed words pass everywhere, and the scope stayed narrow -- slurs, explicit content, and a couple of still-blocked compound terms are untouched');
{
  const u = await reg('cf_swear_' + rand());
  // A representative spread of fields, not just one -- proves the policy change actually reached
  // the shared helper every route calls, not just the one spot it was eyeballed in.
  const okBio = await post('/api/me/bio', { bio: "fuck yeah, that was a hell of a session" }, u.token);
  allows(okBio, '"fuck yeah" is allowed in bio');
  const okDisplay = await post('/api/me/display-name', { displayName: 'Shit Kicker' }, u.token);
  allows(okDisplay, '"shit" is allowed in displayName');
  const crew = await post('/api/crews', { name: 'Kick-Ass Crew' }, u.token);
  allows(crew, '"kick-ass" (hyphenated) is allowed in a crew name -- the exact phrase Jeff asked about');
  const okMsg = await post(`/api/crews/${crew.json.id}/messages`, { text: 'bitch we crushed that pr, fuck yeah' }, u.token);
  allows(okMsg, '"bitch" and "fuck" together are allowed in crew chat');
  const okSession = await post('/api/sessions', { name: "Dick's bastard piss-off leg day", exercises: [{ name: EX_NAME }], visibility: 'private' }, u.token);
  allows(okSession, 'dick/bastard/piss (the borderline tier Jeff explicitly asked to include) are allowed in a session name');

  // Scope check: explicit sexual content was never part of "allowed to swear" -- still blocked,
  // same field, proving this wasn't a blanket loosening of the whole filter.
  const stillBlocked = await post('/api/me/bio', { bio: BAD }, u.token);
  rejects(stillBlocked, 'explicit sexual content is still rejected in the same field the swear words above just passed in');
  // And a compound word that embeds an ableist slur root ('tard') stays blocked even though its
  // own prefix ('fuck') is now allowed on its own -- leo-profanity matches whole dictionary
  // entries, not substrings, so removing 'fuck' never silently removed 'fucktards' too.
  const stillBlockedCompound = await post('/api/me/bio', { bio: 'fucktards' }, u.token);
  rejects(stillBlockedCompound, 'a compound word embedding a slur root stays blocked even though it contains an now-allowed word as a substring');
}

console.log('\ndeliberately NOT filtered, verified rather than just asserted in a comment: draftNotes, POST /variation, and a filed report\'s "details" -- all own-eyes-only or needed verbatim to report abuse');
{
  const owner = await reg('cf_draft_' + rand());
  const s = await post('/api/sessions', { name: 'Draft Session', exercises: [{ name: EX_NAME }], visibility: 'private' }, owner.token);
  const draft = await post(`/api/sessions/${s.json.id}/draft-notes`, { notes: BAD }, owner.token);
  allows(draft, 'draftNotes accepts the same phrase every filtered route rejects -- own-eyes-only, deliberately excluded');

  // POST /variation is a personal, view-only exercise rename -- sessionView only ever returns the
  // viewer's OWN variation to them (pickMine), never another participant's, so it's the same own-
  // eyes-only shape as draftNotes, not the shared-plan rename /suggest's swap performs.
  const varExId = s.json.exercises[0].id;
  const variation = await post(`/api/sessions/${s.json.id}/variation`, { exerciseId: varExId, swapTo: BAD }, owner.token);
  allows(variation, 'a personal (own-eyes-only) exercise variation accepts the same phrase too -- never shown to anyone else, see sessionView\'s pickMine');

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
