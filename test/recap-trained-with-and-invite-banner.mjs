// Sep 23 2026 (Jeff: "with these changes you are seeing us make - bugs and missed items in
// workout such as owners leaving/etc. What else can you think of or find that may have similar
// issues") -- two more real, still-open instances of the same bug family, both client-rendering:
//
//   1. A posted recap's "with @X, @Y" collaborator line (viewPost, public/app.js) used to rebuild
//      itself from the CURRENT s.participants every single time the recap is opened -- so someone
//      who genuinely trained that session but later left (even choosing to keep their credit) or
//      was kicked silently vanished from a recap that was already posted, understating who was
//      really there. Fixed with a server-side snapshot (s.posts[authorId].trainedWith, set once
//      when the recap is first posted -- see POST /api/sessions/:id/post) that the client now
//      reads instead of recomputing live.
//   2. Home's "X invited you" banner used to resolve the CURRENT session owner, not whoever
//      actually sent the invite -- so once ownership hands off mid-invite (the original creator
//      leaves -- see /leave), the banner silently switched to crediting the new owner for an
//      invite they never sent. Fixed with a server-side s.invitedBy map the client now reads
//      (s.invitedById) instead of always falling back to s.creatorId.
//
// Runs the REAL server AND the REAL public/app.js via node:vm (same harness as
// test/recap-shows-own-sets-only.mjs / test/viewpost-swap-attribution.mjs).
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { freshTestDb } from './_pgtestdb.mjs';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const J = { 'Content-Type': 'application/json' };
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('trainedwithbanner');

function boot(port, dir) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    srv.stdout.on('data', d => { if (String(d).includes('CrewFit on')) res(srv); });
    srv.on('exit', () => res(null));
    setTimeout(() => res(null), 15000);
  });
}

const DIR = mkdtempSync(join(tmpdir(), 'trainedwithbanner-'));
const PORT = 4982, B = `http://localhost:${PORT}`;
const srv = await boot(PORT, DIR);
ok(!!srv, 'server boots');

const post = (p, b, tok) => fetch(B + p, { method: 'POST', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b) }).then(r => r.json());
const get = (p, tok) => fetch(B + p, { headers: tok ? { Authorization: 'Bearer ' + tok } : {} }).then(r => r.json());
const reg = (username) => post('/api/register', { username, pin: 'pass1234', displayName: username });

const SRC = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const sink = { html: '' };
const el = () => new Proxy(function () {}, {
  get: (t, k) => k === 'style' || k === 'classList' || k === 'dataset' ? el()
    : k === 'innerHTML' ? sink.html
    : k === 'innerText' || k === 'value' || k === 'textContent' ? ''
    : k === 'children' || k === 'childNodes' ? [] : el(),
  set: (t, k, v) => { if (k === 'innerHTML') sink.html += String(v); return true; },
  apply: () => el(), has: () => true,
});
const doc = { getElementById: () => el(), querySelector: () => null, querySelectorAll: () => [],
  createElement: () => el(), addEventListener() {}, body: el(), documentElement: el(), head: el(),
  cookie: '', readyState: 'complete' };
function makeCtx() {
  const ctx = { console: { log() {}, warn() {}, error() {} }, document: doc,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: (url, opts) => fetch(B + url, opts),
    location: { href: '/', pathname: '/', search: '', hash: '' },
    history: { replaceState() {}, pushState() {} }, addEventListener() {}, removeEventListener() {}, scrollTo() {},
    navigator: { userAgent: 'node', serviceWorker: { register: () => Promise.resolve() }, onLine: true },
    setTimeout, clearTimeout, setInterval, clearInterval, alert() {}, confirm: () => true, prompt: () => null,
    requestAnimationFrame: f => setTimeout(f, 0), matchMedia: () => ({ matches: false, addEventListener() {} }),
    FileReader: function () {}, Image: function () {}, URL, Blob: function () {}, FormData: function () {},
    IntersectionObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
    ResizeObserver: function () { this.observe = () => {}; this.disconnect = () => {}; } };
  ctx.window = ctx; ctx.globalThis = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx, { filename: 'public/app.js' });
  return ctx;
}

console.log('\nFix #2: a posted recap\'s "with @X, @Y" line survives a training partner leaving afterward -- it is a snapshot of who was actually there, not a live re-derivation');
{
  const jeff = await reg('tw_jeff');
  const brian = await reg('tw_brian');
  const alice = await reg('tw_alice');
  await post('/api/follow/' + brian.user.id, {}, jeff.token);
  await post('/api/follow/' + alice.user.id, {}, jeff.token);

  const s = await post('/api/sessions', {
    name: 'Push Day', scheduledAt: new Date().toISOString(),
    exercises: [{ name: 'Bench Press' }], visibility: 'private',
    inviteUsernames: ['tw_brian', 'tw_alice'],
  }, jeff.token);
  await post(`/api/sessions/${s.id}/accept`, {}, brian.token);
  await post(`/api/sessions/${s.id}/accept`, {}, alice.token);
  const benchId = s.exercises.find(e => e.name === 'Bench Press').id;
  await post(`/api/sessions/${s.id}/log`, { exerciseId: benchId, weight: 185, reps: 8 }, jeff.token);
  await post(`/api/sessions/${s.id}/log`, { exerciseId: benchId, weight: 165, reps: 8 }, brian.token);
  await post(`/api/sessions/${s.id}/log`, { exerciseId: benchId, weight: 95, reps: 10 }, alice.token);

  // Jeff posts his recap WHILE Brian and Alice are both still current -- this is what snapshots
  // trainedWith = [brian, alice] onto Jeff's post.
  const postRes = await post(`/api/sessions/${s.id}/post`, { notes: 'Great session', visibility: 'private', media: [] }, jeff.token);
  ok(Array.isArray(postRes.posts[jeff.user.id].trainedWith) && postRes.posts[jeff.user.id].trainedWith.length === 2,
    `the recap was saved with a trainedWith snapshot of both training partners (got ${JSON.stringify(postRes.posts[jeff.user.id].trainedWith)})`);

  const ctx = makeCtx();
  vm.runInContext(`TOKEN = ${JSON.stringify(jeff.token)}; ME = ${JSON.stringify(jeff.user)};`, ctx);
  sink.html = '';
  await vm.runInContext('viewPost', ctx)(s.id, jeff.user.id);
  ok(/pp-collab">with @tw_brian, @tw_alice/.test(sink.html), `right after posting, the collaborator line names both (got ${(sink.html.match(/pp-collab">[^<]*/) || [])[0]})`);

  // Brian now leaves the workout entirely, keeping his own credit. He is no longer in
  // s.participants at all.
  const leaveRes = await post(`/api/sessions/${s.id}/leave`, { keep: true }, brian.token);
  ok(leaveRes.ok === true, 'Brian leaves, keeping his credit');

  sink.html = '';
  await vm.runInContext('viewPost', ctx)(s.id, jeff.user.id);
  ok(/pp-collab">with @tw_brian, @tw_alice/.test(sink.html), `Jeff's ALREADY-POSTED recap still names Brian even though he has since left -- it is a snapshot of who was really there, not today's live roster (got ${(sink.html.match(/pp-collab">[^<]*/) || [])[0]})`);

  // A NEW recap posted AFTER Brian left (Alice's own, for example) should reflect the roster AS
  // OF WHEN SHE POSTS -- Brian genuinely is not part of what Alice is posting now.
  const alicePost = await post(`/api/sessions/${s.id}/post`, { notes: 'My side', visibility: 'private', media: [] }, alice.token);
  ok(Array.isArray(alicePost.posts[alice.user.id].trainedWith) && !alicePost.posts[alice.user.id].trainedWith.includes(brian.user.id),
    `a recap posted AFTER Brian left correctly does not snapshot him in (got ${JSON.stringify(alicePost.posts[alice.user.id].trainedWith)})`);
}

console.log('\nFix #2 (kick case): the same snapshot survives someone being KICKED, not just leaving voluntarily');
{
  const host = await reg('twk_host');
  const target = await reg('twk_target');
  await post('/api/follow/' + target.user.id, {}, host.token);
  const s = await post('/api/sessions', {
    name: 'Leg Day', scheduledAt: new Date().toISOString(),
    exercises: [{ name: 'Squat' }], visibility: 'private', inviteUsernames: ['twk_target'],
  }, host.token);
  await post(`/api/sessions/${s.id}/accept`, {}, target.token);
  const squatId = s.exercises.find(e => e.name === 'Squat').id;
  await post(`/api/sessions/${s.id}/log`, { exerciseId: squatId, weight: 225, reps: 5 }, target.token);
  await post(`/api/sessions/${s.id}/post`, { notes: 'Leg day', visibility: 'private', media: [] }, host.token);

  await post(`/api/sessions/${s.id}/participants/${target.user.id}/remove`, {}, host.token);

  const ctx = makeCtx();
  vm.runInContext(`TOKEN = ${JSON.stringify(host.token)}; ME = ${JSON.stringify(host.user)};`, ctx);
  sink.html = '';
  await vm.runInContext('viewPost', ctx)(s.id, host.user.id);
  ok(/pp-collab">with @twk_target/.test(sink.html), `the host's already-posted recap still names the kicked participant (got ${(sink.html.match(/pp-collab">[^<]*/) || [])[0]})`);
}

console.log('\nFix #4 (client): Home\'s invite banner names the person who actually sent the invite, even after ownership has since handed off to someone else');
{
  const host = await reg('ivb_host');
  const heir = await reg('ivb_heir');
  const invitee = await reg('ivb_invitee');
  await post('/api/follow/' + heir.user.id, {}, host.token);
  await post('/api/follow/' + invitee.user.id, {}, host.token);
  // Invitee needs to actually know the host's real name via friendName()'s own-friends lookup.
  await post('/api/follow/' + host.user.id, {}, invitee.token);

  const s = await post('/api/sessions', {
    name: 'Handoff Day', scheduledAt: new Date().toISOString(),
    exercises: [{ name: 'Bench Press' }], visibility: 'private',
    inviteUsernames: ['ivb_heir', 'ivb_invitee'],
  }, host.token);
  await post(`/api/sessions/${s.id}/accept`, {}, heir.token);
  const benchId = s.exercises.find(e => e.name === 'Bench Press').id;
  await post(`/api/sessions/${s.id}/log`, { exerciseId: benchId, weight: 135, reps: 8 }, heir.token);
  // invitee never answers.

  await post(`/api/sessions/${s.id}/leave`, { keep: true }, host.token);
  const afterHandoff = await get(`/api/sessions/${s.id}`, heir.token);
  ok(afterHandoff.creatorId === heir.user.id, `sanity: ownership really did hand off to the heir (got creatorId=${afterHandoff.creatorId})`);

  const ctx = makeCtx();
  vm.runInContext(`TOKEN = ${JSON.stringify(invitee.token)}; ME = ${JSON.stringify(invitee.user)};`, ctx);
  sink.html = '';
  await vm.runInContext('home', ctx)();
  ok(/<b>ivb_host<\/b> invited you/.test(sink.html), `Home's banner still credits the ORIGINAL host for the invite (got ${(sink.html.match(/<b>[^<]*<\/b> invited you/) || [])[0]})`);
  ok(!/<b>ivb_heir<\/b> invited you/.test(sink.html), 'the banner does NOT credit the new owner for an invite they never sent');
}

try { srv && srv.kill(); } catch {}
rmSync(DIR, { recursive: true, force: true });
await testDb.drop();

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
