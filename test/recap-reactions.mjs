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

async function makeFriends(a, b) {
  await postJ('/api/friends/request', { username: b.user.username }, a.token);
  await postJ('/api/friends/accept', { from: a.user.id }, b.token);
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
  const s = await soloPostedWorkout(alice, 'friends');

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
  const s = await soloPostedWorkout(carl, 'friends');

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
  const s = await soloPostedWorkout(gwen, 'only_me');

  const r = await react(s.id, gwen.user.id, holt.token);
  ok(r.status === 403, `a non-friend on an only-me recap is refused (got ${r.status})`);

  const body = await r.json();
  ok(/forbidden/i.test(body.error || ''), 'a clear error, not a silent success');
}

console.log('\na genuine non-friend is refused on a FRIENDS-visibility recap too, not just only-me (cold-review gap)');
{
  const paul = await reg('rx_paul', 'pass1234', 'Paul');
  const quinn = await reg('rx_quinn', 'pass1234', 'Quinn');   // NOT a friend of paul
  const s = await soloPostedWorkout(paul, 'friends');

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
    name: 'Never Posted', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Deadlift' }], visibility: 'friends',
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
  const s = await soloPostedWorkout(liam, 'friends');
  await reactJ(s.id, liam.user.id, mia.token);

  // liam edits his own notes -- hits POST /post again, same endpoint used to save the recap the
  // first time
  const edited = await postJ(`/api/sessions/${s.id}/post`, { notes: 'edited notes', visibility: 'friends' }, liam.token);
  const reactionsAfterEdit = (edited.posts && edited.posts[liam.user.id] && edited.posts[liam.user.id].reactions) || [];
  ok(reactionsAfterEdit.includes(mia.user.id), `mia's reaction survives liam editing his notes (got ${JSON.stringify(reactionsAfterEdit)})`);
}

console.log('\nGET /api/sessions/:id already carries reactions on the post -- no separate fetch needed');
{
  const noah = await reg('rx_noah', 'pass1234', 'Noah');
  const olive = await reg('rx_olive', 'pass1234', 'Olive');
  await makeFriends(noah, olive);
  const s = await soloPostedWorkout(noah, 'friends');
  await reactJ(s.id, noah.user.id, olive.token);

  const asNoah = await get('/api/sessions/' + s.id, noah.token);
  const p = asNoah.posts && asNoah.posts[noah.user.id];
  ok(!!p && Array.isArray(p.reactions) && p.reactions.includes(olive.user.id),
     `the plain session GET already includes the reaction (got ${JSON.stringify(p && p.reactions)})`);
}

srv.kill();
rmSync(DIR, { recursive: true, force: true });
await testDb.drop();
if (fails) { console.log(`\n${fails} FAILURE(S)`); process.exit(1); }
console.log('\nall assertions passed');
