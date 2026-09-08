// App-Store-readiness moderation tools (Sep 8 2026, Apple guideline 1.2): block/unblock,
// report (user/post/comment) with admin review, and edit/delete/remove on posted-recap comments.
// Real server + real Postgres. Every assertion here exists because a cold-review pass (or the
// manual verification that preceded it) found the corresponding bug for real:
//   - block wasn't checked on comment-editing (only comment-posting) -- a blocked commenter could
//     still rewrite an existing comment to new abusive text indefinitely
//   - block wasn't checked on reacting to a specific commenter's comment inside someone else's
//     unrelated post -- two users who'd blocked each other could still notify one another via a
//     shared thread
//   - /api/report had no rate limit at all, unlike every other write-heavy unauthenticated-adjacent
//     route in this file
//   - /admin.html (the whole point of "reports go somewhere a human can act on them") didn't exist
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const J = { 'Content-Type': 'application/json' };
const CWD = new URL('..', import.meta.url).pathname;

function boot(port, dir, databaseUrl) {
  return new Promise(res => {
    let adminToken = null, out = '';
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: databaseUrl, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    srv.stdout.on('data', d => {
      out += d;
      const m = String(d).match(/Generated ADMIN_TOKEN.*?:\s*(\S+)/);
      if (m) adminToken = m[1];
      if (String(d).includes('CrewFit on')) res({ srv, out, adminToken });
    });
    srv.on('exit', () => res({ srv: null, out, adminToken }));
    setTimeout(() => res({ srv, out, adminToken }), 8000);
  });
}

const DIR = mkdtempSync(join(tmpdir(), 'moderation-'));
const testDb = await freshTestDb('moderation');
const PORT = 4796, BASE = `http://localhost:${PORT}`;
const { srv, adminToken } = await boot(PORT, DIR, testDb.url);
if (!srv) { console.log('FAIL: server did not boot'); process.exit(1); }
if (!adminToken) { console.log('FAIL: no ADMIN_TOKEN captured from boot log'); process.exit(1); }

const H = t => ({ ...J, Authorization: 'Bearer ' + t });
const api = (method, path, token, body) => fetch(BASE + path, { method, headers: token ? H(token) : J, body: body !== undefined ? JSON.stringify(body) : undefined }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }));
const reg = n => api('POST', '/api/register', null, { username: n, pin: 'pass1234', displayName: n[0].toUpperCase() + n.slice(1) }).then(r => r.json);

try {

const rand = Math.floor(Math.random() * 1e6);
const alice = await reg(`mod_alice${rand}`);
const bob = await reg(`mod_bob${rand}`);
const carol = await reg(`mod_carol${rand}`);
const A = alice.token, AID = alice.user.id;
const B = bob.token, BID = bob.user.id;
const C = carol.token, CID = carol.user.id;

console.log('block/unblock and bidirectional enforcement');
{
  ok((await api('POST', `/api/follow/${AID}`, B)).status === 200, 'bob can follow alice before any block');
  ok((await api('POST', `/api/block/${BID}`, A)).status === 200, 'alice blocks bob');
  const blockedList = await api('GET', '/api/blocked', A);
  ok(blockedList.json.some(u => u.id === BID), "bob appears in alice's /api/blocked list");
  ok((await api('POST', `/api/follow/${AID}`, B)).status === 403, 'bob cannot re-follow alice once blocked');
  ok((await api('POST', `/api/follow/${BID}`, A)).status === 403, 'alice (the blocker) also cannot follow bob -- block is bidirectional');
  const aliceProfileForBob = await api('GET', `/api/profile/${AID}`, B);
  ok(aliceProfileForBob.json.prCount === null, "bob viewing alice's profile sees gated fields (prCount) hidden by the block");
  ok((await api('POST', `/api/unblock/${BID}`, A)).status === 200, 'alice unblocks bob');
  const blockedAfter = await api('GET', '/api/blocked', A);
  ok(!blockedAfter.json.some(u => u.id === BID), 'bob no longer in blocked list after unblock');
}

console.log('\nposted-recap comments: posting, editing, deleting, removing, reacting -- all block-aware');
{
  await api('POST', `/api/block/${BID}`, A); // re-block for this section
  const sess = await api('POST', '/api/sessions', A, { name: 'Leg Day', visibility: 'public', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Back Squat' }] });
  const sid = sess.json.id;
  await api('POST', `/api/sessions/${sid}/post`, A, { notes: 'heavy', media: [], visibility: 'public' });

  ok((await api('POST', `/api/sessions/${sid}/posts/${AID}/comments`, B, { text: 'sneaking in' })).status === 403, 'blocked bob cannot post a NEW comment on alice\'s post');

  const carolComment = await api('POST', `/api/sessions/${sid}/posts/${AID}/comments`, C, { text: 'nice work' });
  const cid = carolComment.json.posts[AID].comments.at(-1).id;

  ok((await api('PUT', `/api/sessions/${sid}/posts/${AID}/comments/${cid}`, C, { text: 'nice work, edited' })).status === 200, "carol can edit her own comment");
  ok((await api('PUT', `/api/sessions/${sid}/posts/${AID}/comments/${cid}`, B, { text: 'hijack attempt' })).status === 403, "bob (not the comment's author) cannot edit carol's comment");

  // Cold-review fix: block must be checked on EDIT too, not just on posting a brand-new comment.
  const bobsOwnComment = await api('POST', `/api/sessions/${sid}/posts/${AID}/comments`, C, { text: 'placeholder for bob edit test' }); // carol posts, we'll fake bob-owned via a fresh unblocked flow below instead
  {
    // Set up a scenario where bob HAS a comment, THEN alice blocks him, to prove editing an
    // EXISTING comment is refused post-block (not just posting a brand-new one).
    await api('POST', `/api/unblock/${BID}`, A);
    const bobComment = await api('POST', `/api/sessions/${sid}/posts/${AID}/comments`, B, { text: 'before the block' });
    const bobCid = bobComment.json.posts[AID].comments.find(x => x.userId === BID).id;
    await api('POST', `/api/block/${BID}`, A);
    const editAttempt = await api('PUT', `/api/sessions/${sid}/posts/${AID}/comments/${bobCid}`, B, { text: 'after the block -- should be refused' });
    ok(editAttempt.status === 403, "bob cannot edit his OWN pre-existing comment after alice blocks him (cold-review fix)");
    await api('DELETE', `/api/sessions/${sid}/posts/${AID}/comments/${bobCid}`, A); // cleanup via post-owner moderation
  }

  ok((await api('DELETE', `/api/sessions/${sid}/posts/${AID}/comments/${cid}`, B)).status === 403, "bob (neither comment author nor post owner) cannot delete carol's comment");
  ok((await api('DELETE', `/api/sessions/${sid}/posts/${AID}/comments/${cid}`, A)).status === 200, "alice (post owner) CAN remove carol's comment (moderation)");

  // alice still has bob blocked from the edit-after-block scenario above -- clear that first so
  // the reaction test below isolates the bob<->carol block specifically, not alice<->bob.
  await api('POST', `/api/unblock/${BID}`, A);

  // Cold-review fix: reacting to a specific commenter's comment must respect a block between the
  // reactor and that COMMENTER, not just between the reactor and the post's own author.
  {
    const carolComment2 = await api('POST', `/api/sessions/${sid}/posts/${AID}/comments`, C, { text: 'another comment' });
    const cid2 = carolComment2.json.posts[AID].comments.find(x => x.userId === CID).id;
    await api('POST', `/api/block/${CID}`, B); // bob blocks carol (unrelated to alice's own post)
    const reactAttempt = await api('POST', `/api/sessions/${sid}/posts/${AID}/comments/${cid2}/react`, B);
    ok(reactAttempt.status === 403, "bob cannot react to carol's comment on alice's post once bob has blocked carol (cold-review fix)");
    await api('POST', `/api/unblock/${CID}`, B);
    const reactOk = await api('POST', `/api/sessions/${sid}/posts/${AID}/comments/${cid2}/react`, B);
    ok(reactOk.status === 200, 'and reacting works again once unblocked, proving the 403 above was really about the block');
  }

  await api('POST', `/api/unblock/${BID}`, A);
}

console.log('\ninvalid report inputs are rejected');
{
  ok((await api('POST', '/api/report', C, { targetType: 'bogus', reason: 'harassment' })).status === 400, 'invalid targetType rejected');
  ok((await api('POST', '/api/report', C, { targetType: 'user', targetUserId: AID, reason: 'not-a-real-reason' })).status === 400, 'invalid reason rejected');
  ok((await api('POST', '/api/report', C, { targetType: 'user', reason: 'spam' })).status === 400, "a 'user' report with no targetUserId is rejected");
}

console.log('\n/api/report is rate-limited per user (cold-review fix)');
{
  let sawLimit = false;
  for (let i = 0; i < 35; i++) {
    const r = await api('POST', '/api/report', C, { targetType: 'user', targetUserId: BID, reason: 'spam', details: 'rl-test-' + i });
    if (r.status === 429) { sawLimit = true; break; }
  }
  ok(sawLimit, '31st+ report from the same user within the window is refused with 429');
}

console.log('\nadmin report review: auth gating, listing, resolving');
{
  ok((await api('GET', '/api/admin/reports')).status === 401, 'no token -> 401');
  const badAuth = await fetch(BASE + '/api/admin/reports', { headers: { 'x-admin-token': 'wrong' } });
  ok(badAuth.status === 401, 'wrong token -> 401');
  const goodAuth = await fetch(BASE + '/api/admin/reports', { headers: { 'x-admin-token': adminToken } });
  const list = await goodAuth.json();
  ok(goodAuth.status === 200 && Array.isArray(list) && list.length > 0, 'correct token lists the reports created above');
  const first = list[0];
  ok(typeof first.reporterName === 'string' && typeof first.targetName === 'string', 'each report is resolved to reporter/target display names server-side');
  const resolveRes = await fetch(BASE + `/api/admin/reports/${first.id}/resolve`, { method: 'POST', headers: { 'x-admin-token': adminToken } });
  ok(resolveRes.status === 200, 'resolve succeeds with correct token');
  const afterResolve = await fetch(BASE + '/api/admin/reports', { headers: { 'x-admin-token': adminToken } }).then(r => r.json());
  ok(afterResolve.find(r => r.id === first.id).status === 'resolved', 'resolved report shows status:resolved on the next list call');
}

console.log('\n/admin.html is actually served as a static file');
{
  const r = await fetch(BASE + '/admin.html');
  const text = await r.text();
  ok(r.status === 200 && text.includes('Report Review'), '/admin.html responds 200 and contains the report-review page (cold-review fix: this route did not exist at all before)');
}

} finally {
  srv.kill();
  await testDb.drop();
}

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
