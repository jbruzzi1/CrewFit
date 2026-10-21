// Oct 21 2026 (moderation tooling, Slice B -- app-store readiness review item "moderation
// tooling"). Once 3 DISTINCT people report the same comment, maybeAutoHideComment() in server.js
// hides it from everyone except an admin -- reversible via POST /api/admin/comments/unhide. Jeff
// picked auto-hide over flag-only, and 3 over 5, after being shown the disclosed brigading risk
// (see the Oct 21 CLAUDE.md addendum). v1 is comments-only (not posts/users) and covers BOTH
// comment shapes this app has: the live in-workout chat (s.comments, no authorId on the report)
// and a posted recap's own comment thread (s.posts[authorId].comments, authorId present) -- the
// same authorId-presence convention app.js already uses to tell the two report shapes apart.
//
// Covers: 3 distinct reporters hides a chat comment from a non-reporter viewer but it stays
// resolvable/visible to an admin; the SAME reporter reporting 3 TIMES never hides anything
// (self-exclusion -- duplicate reports from one person don't count toward the threshold); a
// recap comment hides the same way and a hidden comment can no longer be reacted to (404, same
// shape as a deleted one); admin unhide restores visibility (and reactability) in both shapes.
//
// Real server + real Postgres, same boot/cleanup shape as test/content-filter-expansion.mjs /
// test/data-export.mjs.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const J = { 'Content-Type': 'application/json' };
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('modautohide');
const rand = () => Math.random().toString(36).slice(2, 8);

function boot(port, dir) {
  return new Promise(res => {
    let adminToken = null;
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    srv.stdout.on('data', d => {
      const m = String(d).match(/Generated ADMIN_TOKEN.*?:\s*(\S+)/);
      if (m) adminToken = m[1];
      if (String(d).includes('CrewFit on')) res({ srv, adminToken: () => adminToken });
    });
    srv.on('exit', () => res({ srv: null, adminToken: () => adminToken }));
    setTimeout(() => res({ srv, adminToken: () => adminToken }), 15000);
  });
}

const DIR = mkdtempSync(join(tmpdir(), 'modautohide-'));
const PORT = 4992, B = `http://localhost:${PORT}`;
const { srv, adminToken } = await boot(PORT, DIR);
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
const get  = (p, tok) => fetch(B + p, { headers: tok ? { Authorization: 'Bearer ' + tok } : {} }).then(r => r.json());
const adminPost = (p, b) => fetch(B + p, { method: 'POST', headers: { ...J, 'x-admin-token': adminToken() }, body: JSON.stringify(b || {}) }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }));
const reg = async (username) => { const r = await post('/api/register', { ageConfirmed: true, username, pin: 'pass1234', displayName: username }); return r.json; };
const report = (reporterTok, body) => post('/api/report', { targetType: 'comment', reason: 'harassment', ...body }, reporterTok);

try {

const EX_LIB = await get('/api/exercises');
const EX_NAME = EX_LIB[0].name;

const alice = await reg('mah_alice_' + rand());   // creator
const bob = await reg('mah_bob_' + rand());        // offending commenter
const carol = await reg('mah_carol_' + rand());    // reporter 1
const dave = await reg('mah_dave_' + rand());       // reporter 2
const erin = await reg('mah_erin_' + rand());       // reporter 3 / also the "outside viewer"

// POST /api/sessions only allows inviting an existing CONNECTION (an approved follow, either
// direction -- see connectionsOf()), not an arbitrary username -- same prerequisite
// test/data-export.mjs's own session-setup comment documents.
for (const u of [bob, carol, dave, erin]) await post('/api/follow/' + u.user.id, {}, alice.token);
const s = await post('/api/sessions', { name: 'Leg Day', scheduledAt: new Date().toISOString(), exercises: [{ name: EX_NAME }], inviteUsernames: [bob.user.username, carol.user.username, dave.user.username, erin.user.username], visibility: 'public' }, alice.token);
for (const u of [bob, carol, dave, erin]) await post(`/api/sessions/${s.json.id}/accept`, {}, u.token);

console.log('\n-- chat comment (no authorId): 3 distinct reporters auto-hides it --');
{
  const c = await post(`/api/sessions/${s.json.id}/comments`, { text: 'be mean to everyone here' }, bob.token);
  ok(c.status === 200, `bob can post the chat comment (got ${c.status})`);
  const list1 = await get(`/api/sessions/${s.json.id}/comments`, erin.token);
  const target = list1.find(x => x.userId === bob.user.id);
  ok(!!target, 'erin can see the comment before any report');

  await report(carol.token, { sessionId: s.json.id, commentId: target.id });
  const afterOne = await get(`/api/sessions/${s.json.id}/comments`, erin.token);
  ok(afterOne.some(x => x.id === target.id), 'still visible after 1 distinct report');

  await report(dave.token, { sessionId: s.json.id, commentId: target.id });
  const afterTwo = await get(`/api/sessions/${s.json.id}/comments`, erin.token);
  ok(afterTwo.some(x => x.id === target.id), 'still visible after 2 distinct reports');

  const r3 = await report(erin.token, { sessionId: s.json.id, commentId: target.id });
  ok(r3.status === 200, `the 3rd report itself still succeeds (got ${r3.status})`);
  const afterThree = await get(`/api/sessions/${s.json.id}/comments`, erin.token);
  ok(!afterThree.some(x => x.id === target.id), 'hidden from a non-reporter viewer after the 3rd distinct report');

  console.log('  admin sees it as an auto-hidden group, grouped with all 3 reports');
  const grouped = await fetch(B + '/api/admin/reports/grouped', { headers: { 'x-admin-token': adminToken() } }).then(r => r.json());
  const g = grouped.find(x => x.commentId === target.id);
  ok(!!g && g.hidden === true, `grouped view marks this comment group as hidden (got ${JSON.stringify(g)})`);
  ok(g && g.distinctReporters === 3 && g.reportCount === 3, `3 distinct reporters, 3 reports filed (got ${g && g.distinctReporters}/${g && g.reportCount})`);

  console.log('  admin unhide restores it for everyone');
  const unhideWrongToken = await fetch(B + '/api/admin/comments/unhide', { method: 'POST', headers: { ...J, 'x-admin-token': 'wrong' }, body: JSON.stringify({ sessionId: s.json.id, commentId: target.id }) });
  ok(unhideWrongToken.status === 401, `unhide refuses a wrong admin token (got ${unhideWrongToken.status})`);
  const un = await adminPost('/api/admin/comments/unhide', { sessionId: s.json.id, commentId: target.id });
  ok(un.status === 200 && un.json.changed === true, `unhide succeeds (got ${un.status}, ${JSON.stringify(un.json)})`);
  const afterUnhide = await get(`/api/sessions/${s.json.id}/comments`, erin.token);
  ok(afterUnhide.some(x => x.id === target.id), 'visible again after admin unhide');
}

console.log('\n-- the SAME reporter reporting 3 times never auto-hides (self-exclusion) --');
{
  const c = await post(`/api/sessions/${s.json.id}/comments`, { text: 'another one for the dup-reporter test' }, bob.token);
  const list = await get(`/api/sessions/${s.json.id}/comments`, erin.token);
  const target = list.filter(x => x.userId === bob.user.id).slice(-1)[0];
  await report(carol.token, { sessionId: s.json.id, commentId: target.id });
  await report(carol.token, { sessionId: s.json.id, commentId: target.id });
  await report(carol.token, { sessionId: s.json.id, commentId: target.id });
  const afterThreeFromOne = await get(`/api/sessions/${s.json.id}/comments`, erin.token);
  ok(afterThreeFromOne.some(x => x.id === target.id), 'still visible -- 3 reports from ONE person is 1 distinct reporter, not 3');
  const grouped = await fetch(B + '/api/admin/reports/grouped', { headers: { 'x-admin-token': adminToken() } }).then(r => r.json());
  const g = grouped.find(x => x.commentId === target.id);
  ok(g && g.distinctReporters === 1 && g.reportCount === 3, `grouped view: 1 distinct reporter, 3 reports filed (got ${g && g.distinctReporters}/${g && g.reportCount})`);
  ok(g && g.hidden === false, 'grouped view correctly reports this comment as NOT hidden');
}

console.log('\n-- recap-post comment (authorId present): auto-hide + react-while-hidden rejected --');
{
  await post(`/api/sessions/${s.json.id}/post`, { notes: 'crushed legs today', visibility: 'public' }, alice.token);
  const c = await post(`/api/sessions/${s.json.id}/posts/${alice.user.id}/comments`, { text: 'rude recap comment' }, bob.token);
  ok(c.status === 200, `bob can comment on alice's public recap (got ${c.status})`);
  const list1 = await get(`/api/sessions/${s.json.id}/posts/${alice.user.id}/comments`, erin.token);
  const target = list1.find(x => x.userId === bob.user.id);
  ok(!!target, 'erin can see the recap comment before any report');

  const reactBefore = await post(`/api/sessions/${s.json.id}/posts/${alice.user.id}/comments/${target.id}/react`, {}, carol.token);
  ok(reactBefore.status === 200 && reactBefore.json.reacted === true, `reacting to it before any report works (got ${reactBefore.status})`);
  // carol already reacted (not reported) -- reacting again un-reacts; leave as-is for dave/erin's own reports below.

  await report(carol.token, { sessionId: s.json.id, authorId: alice.user.id, commentId: target.id });
  await report(dave.token, { sessionId: s.json.id, authorId: alice.user.id, commentId: target.id });
  await report(erin.token, { sessionId: s.json.id, authorId: alice.user.id, commentId: target.id });

  const afterThree = await get(`/api/sessions/${s.json.id}/posts/${alice.user.id}/comments`, erin.token);
  ok(!afterThree.some(x => x.id === target.id), 'recap comment hidden after 3 distinct reports, same as the chat case');

  const reactAfter = await post(`/api/sessions/${s.json.id}/posts/${alice.user.id}/comments/${target.id}/react`, {}, dave.token);
  ok(reactAfter.status === 404, `reacting to a hidden comment is rejected like a deleted one (got ${reactAfter.status})`);

  const grouped = await fetch(B + '/api/admin/reports/grouped', { headers: { 'x-admin-token': adminToken() } }).then(r => r.json());
  const g = grouped.find(x => x.commentId === target.id && x.authorId === alice.user.id);
  ok(!!g && g.hidden === true, 'admin grouped view shows the recap-comment group as hidden too');

  const un = await adminPost('/api/admin/comments/unhide', { sessionId: s.json.id, authorId: alice.user.id, commentId: target.id });
  ok(un.status === 200 && un.json.changed === true, `recap-comment unhide succeeds (got ${un.status}, ${JSON.stringify(un.json)})`);
  const afterUnhide = await get(`/api/sessions/${s.json.id}/posts/${alice.user.id}/comments`, erin.token);
  ok(afterUnhide.some(x => x.id === target.id), 'recap comment visible again after unhide');
  const reactAgain = await post(`/api/sessions/${s.json.id}/posts/${alice.user.id}/comments/${target.id}/react`, {}, dave.token);
  ok(reactAgain.status === 200, `reacting works again after unhide (got ${reactAgain.status})`);
}

console.log('\n-- cold-review fix: a hidden comment\'s full text no longer leaks through GET /api/sessions/:id (sessionView) --');
{
  // Independent cold-review, CRITICAL finding: sessionView()'s posts loop used to hand back the
  // raw post object (including its full, unfiltered .comments array) to every viewer the post's
  // OWN visibility admits -- the dedicated comments route and the live-chat path both correctly
  // stripped a hidden comment, but the embedded copy inside GET /api/sessions/:id (and, per
  // CLAUDE.md, the data-export feature that builds its `sessions` field from this same
  // sessionView) did not. Proven here against BOTH shapes this feature covers.
  const chatComment = await post(`/api/sessions/${s.json.id}/comments`, { text: 'leak-check chat comment' }, bob.token);
  const chatList = await get(`/api/sessions/${s.json.id}/comments`, erin.token);
  const chatTarget = chatList.filter(x => x.userId === bob.user.id).slice(-1)[0];
  await report(carol.token, { sessionId: s.json.id, commentId: chatTarget.id });
  await report(dave.token, { sessionId: s.json.id, commentId: chatTarget.id });
  await report(erin.token, { sessionId: s.json.id, commentId: chatTarget.id });
  const viewAfterChatHide = await get(`/api/sessions/${s.json.id}`, erin.token);
  const leakedChat = (viewAfterChatHide.comments || []).find(x => x.id === chatTarget.id);
  ok(!leakedChat, `GET /api/sessions/:id's own .comments no longer includes the hidden chat comment (got ${JSON.stringify(leakedChat)})`);

  const recapComment = await post(`/api/sessions/${s.json.id}/posts/${alice.user.id}/comments`, { text: 'leak-check recap comment' }, bob.token);
  const recapList = await get(`/api/sessions/${s.json.id}/posts/${alice.user.id}/comments`, erin.token);
  const recapTarget = recapList.filter(x => x.userId === bob.user.id).slice(-1)[0];
  await report(carol.token, { sessionId: s.json.id, authorId: alice.user.id, commentId: recapTarget.id });
  await report(dave.token, { sessionId: s.json.id, authorId: alice.user.id, commentId: recapTarget.id });
  await report(erin.token, { sessionId: s.json.id, authorId: alice.user.id, commentId: recapTarget.id });
  const viewAfterRecapHide = await get(`/api/sessions/${s.json.id}`, erin.token);
  const embeddedPost = viewAfterRecapHide.posts && viewAfterRecapHide.posts[alice.user.id];
  const leakedRecap = embeddedPost && Array.isArray(embeddedPost.comments) && embeddedPost.comments.find(x => x.id === recapTarget.id);
  ok(!leakedRecap, `GET /api/sessions/:id's embedded posts[authorId].comments no longer includes the hidden recap comment (got ${JSON.stringify(leakedRecap)})`);
  // postViewSafe() must not strip anything else on the post, or any OTHER, still-visible
  // comment -- only the specific hidden one.
  ok(embeddedPost.notes === 'crushed legs today', `the post's own fields (notes, etc.) are untouched (got ${JSON.stringify(embeddedPost.notes)})`);
  ok(embeddedPost.comments.length > 0, `the post's other, non-hidden comments are still present (got ${embeddedPost.comments.length})`);
}

console.log('\n-- cold-review fix: POST /api/report now validates a comment report instead of trusting opaque ids --');
{
  console.log('  a well-formed-looking but nonexistent commentId is rejected, not silently stored');
  const fake = await report(carol.token, { sessionId: s.json.id, commentId: 'c_does_not_exist' });
  ok(fake.status === 400, `nonexistent commentId -> 400 (got ${fake.status}, ${JSON.stringify(fake.json)})`);

  console.log('  a real commentId with the WRONG sessionId/authorId pairing is rejected rather than silently accepted as opaque text');
  const c = await post(`/api/sessions/${s.json.id}/comments`, { text: 'validation-check chat comment' }, bob.token);
  const list = await get(`/api/sessions/${s.json.id}/comments`, erin.token);
  const target = list.filter(x => x.userId === bob.user.id).slice(-1)[0];
  const wrongSession = await report(carol.token, { sessionId: 'sess_totally_made_up', commentId: target.id });
  ok(wrongSession.status === 400, `a commentId paired with a session it doesn't actually live in -> 400 (got ${wrongSession.status})`);
  const wrongAuthorId = await report(carol.token, { sessionId: s.json.id, authorId: alice.user.id, commentId: target.id }); // this IS a chat comment, has no authorId
  ok(wrongAuthorId.status === 400, `a real chat comment reported as if it were a recap comment (wrong authorId) -> 400 (got ${wrongAuthorId.status})`);

  console.log('  someone with no current access to the session cannot report a comment in it');
  const outsider = await reg('mah_outsider_' + rand());
  const noAccess = await report(outsider.token, { sessionId: s.json.id, commentId: target.id });
  ok(noAccess.status === 403, `a non-member/non-invitee reporting a real chat comment in a session they have no access to -> 403 (got ${noAccess.status})`);

  console.log('  the legitimate case (real comment, real pairing, reporter has access) still succeeds exactly as before');
  const legit = await report(carol.token, { sessionId: s.json.id, commentId: target.id });
  ok(legit.status === 200, `a correctly-formed, resolvable, visible comment report still succeeds (got ${legit.status})`);
}

console.log('\n-- unhide on a comment that is not actually hidden is a harmless no-op --');
{
  const c = await post(`/api/sessions/${s.json.id}/comments`, { text: 'never reported, never hidden' }, bob.token);
  const list = await get(`/api/sessions/${s.json.id}/comments`, erin.token);
  const target = list.filter(x => x.userId === bob.user.id).slice(-1)[0];
  const un = await adminPost('/api/admin/comments/unhide', { sessionId: s.json.id, commentId: target.id });
  ok(un.status === 200 && un.json.changed === false, `unhide on a never-hidden comment reports changed:false, not an error (got ${un.status}, ${JSON.stringify(un.json)})`);
}

} finally {
  console.log(fails ? `\n${fails} FAILURE(S)` : '\nAll moderation auto-hide tests passed.');
  await cleanup();
  process.exit(fails ? 1 : 0);
}
