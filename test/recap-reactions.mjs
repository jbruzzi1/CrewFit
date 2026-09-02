// One-tap reactions on a posted recap (Task #157). Jeff wanted something lightweight to tap on a
// friend's workout -- not another comment to type, just a quick "nice work." Deliberately ONE
// reaction, toggled on/off, not a picker -- same "avoid adding a ton of fields" instinct behind
// Plateau watch. POST /api/sessions/:id/posts/:authorId/react mirrors the shape of the existing
// /api/favorites/toggle endpoint: {reacted, count} back, same read/write gate as commenting on the
// post (canSeePostAuthor) -- if you can see the recap, you can react to it.
//
// Covers: toggle on/off flips reacted + count correctly; the count is real and shared (two
// different people reacting both land in the same count, and un-reacting removes only that
// person); a viewer who cannot see the recap at all (private, not the author, not a friend) is
// refused with 403, same as commenting; reacting to a session/author that has no post at all is
// refused, not a crash; the author can react to their own recap; editing notes/photos on an
// already-posted recap does NOT wipe out reactions people already left (the same carry-over bug
// class comments were already protected against); and the reaction is visible on the plain
// GET /api/sessions/:id response (no separate fetch needed, unlike comments).
//
// [comments follow-up] Also covers the same reaction extended one level deeper, onto individual
// comments under a posted recap (POST .../comments/:commentId/react) -- toggle on/off; the count
// is independent per comment and separate from the post-level reaction; the same access gate
// applies (a non-friend is refused); an unknown comment id is a clean 404; and a comment's
// reactions survive the recap being re-posted, since comment objects (and now their reactions)
// carry over by reference in POST /post.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const J = { 'Content-Type': 'application/json' };
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('recapreact');

function boot(port, dir) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; srv.stdout.on('data', d => { out += d; if (String(d).includes('CrewFit on')) res({ srv, out }); });
    srv.on('exit', () => res({ srv: null, out }));
    setTimeout(() => res({ srv, out }), 15000);
  });
}

const DIR = mkdtempSync(join(tmpdir(), 'recapreact-'));
const PORT = 4993, B = `http://localhost:${PORT}`;
const { srv } = await boot(PORT, DIR);
ok(!!srv, 'server boots');

const postJ = (p, b, tok) => fetch(B + p, { method: 'POST', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b) }).then(r => r.json());
const post = (p, b, tok) => fetch(B + p, { method: 'POST', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b) });
const get = (p, tok) => fetch(B + p, { headers: tok ? { Authorization: 'Bearer ' + tok } : {} }).then(r => r.json());
const reg = (username, pin, displayName) => postJ('/api/register', { username, pin, displayName });
const react = (id, authorId, tok) => post(`/api/sessions/${id}/posts/${authorId}/react`, {}, tok);
const reactJ = (id, authorId, tok) => react(id, authorId, tok).then(r => r.json());
const addComment = (id, authorId, text, tok) => postJ(`/api/sessions/${id}/posts/${authorId}/comments`, { text }, tok);
const commentReact = (id, authorId, commentId, tok) => post(`/api/sessions/${id}/posts/${authorId}/comments/${commentId}/react`, {}, tok);
const commentReactJ = (id, authorId, commentId, tok) => commentReact(id, authorId, commentId, tok).then(r => r.json());

// v190: mutual follow reproduces the old symmetric "friends" relationship.
async function makeFriends(a, b) {
  await postJ('/api/follow/' + b.user.id, {}, a.token);
  await postJ('/api/follow-requests/' + a.user.id + '/accept', {}, b.token);
  await postJ('/api/follow/' + a.user.id, {}, b.token);
  await postJ('/api/follow-requests/' + b.user.id + '/accept', {}, a.token);
}
async function soloPostedWorkout(u, visibility) {
  const s = await postJ('/api/sessions', {
    name: 'Leg Day', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Barbell Back Squat' }], visibility: 'private',
  }, u.token);
  await postJ(`/api/sessions/${s.id}/log`, { exerciseId: s.exercises[0].id, weight: 225, reps: 5 }, u.token);
  await postJ(`/api/sessions/${s.id}/lock`, {}, u.token);
  await postJ(`/api/sessions/${s.id}/post`, { notes: 'good session', visibility }, u.token);
  return s;
}

console.log('\na tap toggles on, a second tap toggles off');
{
  const alice = await reg('rx_alice', 'pass1234', 'Alice');
  const bob = await reg('rx_bob', 'pass1234', 'Bob');
  await makeFriends(alice, bob);
  const s = await soloPostedWorkout(alice, 'public');

  const on = await reactJ(s.id, alice.user.id, bob.token);
  ok(on.reacted === true && on.count === 1, `first tap: reacted true, count 1 (got ${JSON.stringify(on)})`);

  const off = await reactJ(s.id, alice.user.id, bob.token);
  ok(off.reacted === false && off.count === 0, `second tap: reacted false, count back to 0 (got ${JSON.stringify(off)})`);
}

console.log('\nthe count is real and shared -- two different people reacting both count, un-reacting removes only that one');
{
  const carl = await reg('rx_carl', 'pass1234', 'Carl');
  const dee = await reg('rx_dee', 'pass1234', 'Dee');
  const finn = await reg('rx_finn', 'pass1234', 'Finn');
  await makeFriends(carl, dee);
  await makeFriends(carl, finn);
  const s = await soloPostedWorkout(carl, 'public');

  const r1 = await reactJ(s.id, carl.user.id, dee.token);
  ok(r1.count === 1, `dee reacts: count 1 (got ${r1.count})`);
  const r2 = await reactJ(s.id, carl.user.id, finn.token);
  ok(r2.count === 2, `finn also reacts: count 2 (got ${r2.count})`);

  const undo = await reactJ(s.id, carl.user.id, dee.token);
  ok(undo.reacted === false && undo.count === 1, `dee un-reacts: count drops to 1, finn's still counted (got ${JSON.stringify(undo)})`);
}

console.log('\nsomeone who cannot see the recap at all cannot react to it either (403, same gate as commenting)');
{
  const gwen = await reg('rx_gwen', 'pass1234', 'Gwen');
  const holt = await reg('rx_holt', 'pass1234', 'Holt');   // NOT a friend of gwen
  const s = await soloPostedWorkout(gwen, 'private');

  const r = await react(s.id, gwen.user.id, holt.token);
  ok(r.status === 403, `a non-friend on an only-me recap is refused (got ${r.status})`);

  const body = await r.json();
  ok(/forbidden/i.test(body.error || ''), 'a clear error, not a silent success');
}

console.log('\na genuine non-friend is refused on a FRIENDS-visibility recap too, not just only-me (cold-review gap)');
{
  const paul = await reg('rx_paul', 'pass1234', 'Paul');
  const quinn = await reg('rx_quinn', 'pass1234', 'Quinn');   // NOT a friend of paul
  // Sep 2026: profiles default Public now -- a 'public'-visibility recap only actually stays
  // closed to a genuine non-follower stranger if the author's own profile is Private too
  // (canSeeProfile gates it, same rule as everywhere else). That's exactly what this block is
  // testing, so paul opts into Private explicitly.
  await postJ('/api/me/profile-visibility', { visibility: 'private' }, paul.token);
  const s = await soloPostedWorkout(paul, 'public');

  const r = await react(s.id, paul.user.id, quinn.token);
  ok(r.status === 403, `a non-friend on a friends-visibility recap is refused (got ${r.status})`);
  const count = await get('/api/sessions/' + s.id, paul.token);
  const reactions = (count.posts && count.posts[paul.user.id] && count.posts[paul.user.id].reactions) || [];
  ok(!reactions.includes(quinn.user.id), 'and nothing was actually recorded');
}

console.log('\nreacting where there is no post at all is refused, not a crash');
{
  const iris = await reg('rx_iris', 'pass1234', 'Iris');
  const jack = await reg('rx_jack', 'pass1234', 'Jack');
  await makeFriends(iris, jack);
  const s = await postJ('/api/sessions', {
    name: 'Never Posted', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Deadlift' }], visibility: 'public',
  }, iris.token);
  // iris never calls /post -- s.posts[iris.id] does not exist
  const r = await react(s.id, iris.user.id, jack.token);
  ok(r.status === 403, `no post yet -> refused, not a 500 (got ${r.status})`);

  const missingSession = await react('nope-not-a-real-session-id', iris.user.id, jack.token);
  ok(missingSession.status === 404, `an unknown session id -> 404 (got ${missingSession.status})`);
}

console.log('\nthe author can react to their own recap');
{
  const kate = await reg('rx_kate', 'pass1234', 'Kate');
  const s = await soloPostedWorkout(kate, 'public');
  const r = await reactJ(s.id, kate.user.id, kate.token);
  ok(r.reacted === true && r.count === 1, `self-react works (got ${JSON.stringify(r)})`);
}

console.log('\nediting notes/photos on an already-posted recap does not wipe existing reactions');
{
  const liam = await reg('rx_liam', 'pass1234', 'Liam');
  const mia = await reg('rx_mia', 'pass1234', 'Mia');
  await makeFriends(liam, mia);
  const s = await soloPostedWorkout(liam, 'public');
  await reactJ(s.id, liam.user.id, mia.token);

  // liam edits his own notes -- hits POST /post again, same endpoint used to save the recap the
  // first time
  const edited = await postJ(`/api/sessions/${s.id}/post`, { notes: 'edited notes', visibility: 'public' }, liam.token);
  const reactionsAfterEdit = (edited.posts && edited.posts[liam.user.id] && edited.posts[liam.user.id].reactions) || [];
  ok(reactionsAfterEdit.includes(mia.user.id), `mia's reaction survives liam editing his notes (got ${JSON.stringify(reactionsAfterEdit)})`);
}

console.log('\nGET /api/sessions/:id already carries reactions on the post -- no separate fetch needed');
{
  const noah = await reg('rx_noah', 'pass1234', 'Noah');
  const olive = await reg('rx_olive', 'pass1234', 'Olive');
  await makeFriends(noah, olive);
  const s = await soloPostedWorkout(noah, 'public');
  await reactJ(s.id, noah.user.id, olive.token);

  const asNoah = await get('/api/sessions/' + s.id, noah.token);
  const p = asNoah.posts && asNoah.posts[noah.user.id];
  ok(!!p && Array.isArray(p.reactions) && p.reactions.includes(olive.user.id),
     `the plain session GET already includes the reaction (got ${JSON.stringify(p && p.reactions)})`);
}

console.log('\n[comments follow-up] a tap toggles a comment reaction on, a second tap toggles it off');
{
  const rex = await reg('rx_rex', 'pass1234', 'Rex');
  const sam = await reg('rx_sam', 'pass1234', 'Sam');
  await makeFriends(rex, sam);
  const s = await soloPostedWorkout(rex, 'public');
  const withComment = await addComment(s.id, rex.user.id, 'nice work', sam.token);
  const c = withComment.posts[rex.user.id].comments.find(x => x.text === 'nice work');
  ok(!!c, 'comment was created');

  const on = await commentReactJ(s.id, rex.user.id, c.id, rex.token);
  ok(on.reacted === true && on.count === 1, `first tap on the comment: reacted true, count 1 (got ${JSON.stringify(on)})`);
  const off = await commentReactJ(s.id, rex.user.id, c.id, rex.token);
  ok(off.reacted === false && off.count === 0, `second tap: reacted false, count back to 0 (got ${JSON.stringify(off)})`);
}

console.log('\n[comments follow-up] a comment reaction count is independent -- not conflated with the post reaction or another comment');
{
  const tia = await reg('rx_tia', 'pass1234', 'Tia');
  const uri = await reg('rx_uri', 'pass1234', 'Uri');
  const vin = await reg('rx_vin', 'pass1234', 'Vin');
  await makeFriends(tia, uri);
  await makeFriends(tia, vin);
  const s = await soloPostedWorkout(tia, 'public');
  const afterC1 = await addComment(s.id, tia.user.id, 'first comment', uri.token);
  const c1 = afterC1.posts[tia.user.id].comments.find(x => x.text === 'first comment');
  const afterC2 = await addComment(s.id, tia.user.id, 'second comment', vin.token);
  const c2 = afterC2.posts[tia.user.id].comments.find(x => x.text === 'second comment');

  await reactJ(s.id, tia.user.id, vin.token);              // reacts to the POST itself
  await commentReactJ(s.id, tia.user.id, c1.id, uri.token); // reacts to comment 1 only

  const view = await get('/api/sessions/' + s.id, tia.token);
  const p = view.posts[tia.user.id];
  ok(Array.isArray(p.reactions) && p.reactions.length === 1, `post-level reaction count untouched by the comment reaction (got ${JSON.stringify(p.reactions)})`);
  const gc1 = p.comments.find(x => x.id === c1.id), gc2 = p.comments.find(x => x.id === c2.id);
  ok(Array.isArray(gc1.reactions) && gc1.reactions.length === 1, `comment 1 has its own reaction (got ${JSON.stringify(gc1.reactions)})`);
  ok(!gc2.reactions || gc2.reactions.length === 0, `comment 2 was never reacted to and stays empty (got ${JSON.stringify(gc2.reactions)})`);
}

console.log('\n[comments follow-up] access control on a comment reaction matches the post-level gate -- a non-friend is refused');
{
  const walt = await reg('rx_walt', 'pass1234', 'Walt');
  const xena = await reg('rx_xena', 'pass1234', 'Xena');
  await makeFriends(walt, xena);
  const yara = await reg('rx_yara', 'pass1234', 'Yara');   // NOT a friend of walt
  // Sep 2026: profiles default Public now -- walt opts into Private so yara (a genuine
  // non-follower stranger) is still refused, same reasoning as the post-level block above.
  await postJ('/api/me/profile-visibility', { visibility: 'private' }, walt.token);
  const s = await soloPostedWorkout(walt, 'public');
  const withComment = await addComment(s.id, walt.user.id, 'hi', xena.token);
  const c = withComment.posts[walt.user.id].comments.find(x => x.text === 'hi');

  const r = await commentReact(s.id, walt.user.id, c.id, yara.token);
  ok(r.status === 403, `a non-friend cannot react to a comment on a friends-visibility recap (got ${r.status})`);
}

console.log('\n[comments follow-up] a non-owner is refused on an ONLY-ME recap\'s comment too (post-level covers this; comment-level should match)');
{
  const ozzy = await reg('rx_ozzy', 'pass1234', 'Ozzy');
  const pia = await reg('rx_pia', 'pass1234', 'Pia');
  await makeFriends(ozzy, pia);   // friendship alone should not be enough against only_me
  const s = await soloPostedWorkout(ozzy, 'private');
  // ozzy can't comment on his own only_me-visibility post via a friend either -- simulate a
  // comment existing by having ozzy himself comment, then a friend tries to react to it.
  const withComment = await addComment(s.id, ozzy.user.id, 'solo note', ozzy.token);
  const c = withComment.posts[ozzy.user.id].comments.find(x => x.text === 'solo note');
  const r = await commentReact(s.id, ozzy.user.id, c.id, pia.token);
  ok(r.status === 403, `a friend still can't react to a comment on an only-me recap (got ${r.status})`);
}

console.log('\n[comments follow-up] reacting to a comment where the target author has no post at all is refused, not a crash');
{
  const quin = await reg('rx_quin', 'pass1234', 'Quin');
  const remy = await reg('rx_remy', 'pass1234', 'Remy');
  await makeFriends(quin, remy);
  const s = await postJ('/api/sessions', {
    name: 'Never Posted', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Deadlift' }], visibility: 'public',
  }, quin.token);
  // quin never calls /post -- s.posts[quin.id] does not exist, so there's no comment to react to
  const r = await commentReact(s.id, quin.user.id, 'c_whatever', remy.token);
  ok(r.status === 403, `no post yet -> refused, not a 500 (got ${r.status})`);
}

console.log('\n[comments follow-up] reacting to a comment on an unknown session id is refused, not a crash');
{
  const sara = await reg('rx_sara', 'pass1234', 'Sara');
  const r = await commentReact('nope-not-a-real-session-id', sara.user.id, 'c_whatever', sara.token);
  ok(r.status === 404, `an unknown session id -> 404 (got ${r.status})`);
}

console.log('\n[comments follow-up] reacting to an unknown comment id is refused, not a crash');
{
  const zeke = await reg('rx_zeke', 'pass1234', 'Zeke');
  const s = await soloPostedWorkout(zeke, 'public');
  const r = await commentReact(s.id, zeke.user.id, 'c_not_real', zeke.token);
  ok(r.status === 404, `an unknown comment id -> 404, not a 500 (got ${r.status})`);
}

console.log('\n[comments follow-up] a comment reaction survives the recap being re-posted (notes edit carry-over)');
{
  const abby = await reg('rx_abby', 'pass1234', 'Abby');
  const bret = await reg('rx_bret', 'pass1234', 'Bret');
  await makeFriends(abby, bret);
  const s = await soloPostedWorkout(abby, 'public');
  const withComment = await addComment(s.id, abby.user.id, 'great lift', bret.token);
  const c = withComment.posts[abby.user.id].comments.find(x => x.text === 'great lift');
  await commentReactJ(s.id, abby.user.id, c.id, abby.token);

  const edited = await postJ(`/api/sessions/${s.id}/post`, { notes: 'edited notes', visibility: 'public' }, abby.token);
  const gc = edited.posts[abby.user.id].comments.find(x => x.id === c.id);
  ok(!!gc && Array.isArray(gc.reactions) && gc.reactions.includes(abby.user.id),
     `the comment reaction survives abby editing her notes (got ${JSON.stringify(gc && gc.reactions)})`);
}

srv.kill();
rmSync(DIR, { recursive: true, force: true });
await testDb.drop();
if (fails) { console.log(`\n${fails} FAILURE(S)`); process.exit(1); }
console.log('\nall assertions passed');
