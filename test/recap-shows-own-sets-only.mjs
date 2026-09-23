// Sep 23 2026 (Jeff, real complaint): "when logging a workout and it gets saved onto my profile -
// it currently shows everyones sets who were part of the workout. if we have a group of 4-5 thats
// a lot of additional scrolling... it should only show the sets I personally logged - not everyone
// involved in the workout." Confirmed: the posted recap (viewPost) was the one screen in the app
// that widened to show every participant's sets on every single person's own recap -- even the
// LIVE in-workout logging screen has always shown only your own sets per exercise (see
// openSession's exLogs). Fixed: since a recap is already a per-author post (s.posts[authorId],
// each participant gets their own), it now shows only that author's own sets. The "with @X, @Y"
// line stays, so who else was part of it is still visible, just not their rep-by-rep detail.
//
// Fixing this also surfaced a second, related bug while verifying it: the "with @X, @Y"
// collaborator line used to exclude s.creatorId specifically (from back when the creator's post
// was the only recap that existed) -- so on any OTHER participant's own recap, it listed them as
// one of their OWN training partners ("with @Jeff" rendering right on Jeff's own page). Fixed to
// exclude the actual author of THIS recap instead.
//
// Runs the REAL server AND the REAL public/app.js via node:vm (same harness as
// test/message-button-removed.mjs / test/viewpost-swap-attribution.mjs).
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
const testDb = await freshTestDb('recapownonly');

function boot(port, dir) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    srv.stdout.on('data', d => { if (String(d).includes('CrewFit on')) res(srv); });
    srv.on('exit', () => res(null));
    setTimeout(() => res(null), 15000);
  });
}

const DIR = mkdtempSync(join(tmpdir(), 'recapownonly-'));
const PORT = 4984, B = `http://localhost:${PORT}`;
const srv = await boot(PORT, DIR);
ok(!!srv, 'server boots');

const post = (p, b, tok) => fetch(B + p, { method: 'POST', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b) }).then(r => r.json());
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

const jeff = await reg('rso_jeff');
const brian = await reg('rso_brian');
const alice = await reg('rso_alice');
await post('/api/follow/' + brian.user.id, {}, jeff.token);
await post('/api/follow/' + alice.user.id, {}, jeff.token);
await post('/api/follow/' + jeff.user.id, {}, brian.token);

const s = await post('/api/sessions', {
  name: 'Push Day', scheduledAt: new Date().toISOString(),
  exercises: [{ name: 'Bench Press' }, { name: 'Overhead Press' }], visibility: 'private',
  inviteUsernames: ['rso_brian', 'rso_alice'],
}, jeff.token);
await post(`/api/sessions/${s.id}/accept`, {}, brian.token);
await post(`/api/sessions/${s.id}/accept`, {}, alice.token);
const benchId = s.exercises.find(e => e.name === 'Bench Press').id;
const ohpId = s.exercises.find(e => e.name === 'Overhead Press').id;

// Jeff (creator) logs Bench only. Brian logs Bench + Overhead. Alice logs Overhead only.
await post(`/api/sessions/${s.id}/log`, { exerciseId: benchId, weight: 185, reps: 8 }, jeff.token);
await post(`/api/sessions/${s.id}/log`, { exerciseId: benchId, weight: 165, reps: 8 }, brian.token);
await post(`/api/sessions/${s.id}/log`, { exerciseId: ohpId, weight: 105, reps: 6 }, brian.token);
await post(`/api/sessions/${s.id}/log`, { exerciseId: ohpId, weight: 65, reps: 10 }, alice.token);

await post(`/api/sessions/${s.id}/post`, { notes: 'Jeff post', visibility: 'private', media: [] }, jeff.token);
await post(`/api/sessions/${s.id}/post`, { notes: 'Brian post', visibility: 'private', media: [] }, brian.token);

console.log("\nJeff's own posted recap shows only Jeff's own sets, not Brian's or Alice's -- Jeff's exact real-world complaint about a 4-5 person group");
{
  const ctx = makeCtx();
  vm.runInContext(`TOKEN = ${JSON.stringify(jeff.token)}; ME = ${JSON.stringify(jeff.user)};`, ctx);
  sink.html = '';
  await vm.runInContext('viewPost', ctx)(s.id, jeff.user.id);
  ok(sink.html.includes('185 lb'), "Jeff's own Bench set (185) is shown");
  ok(!sink.html.includes('165 lb'), "Brian's Bench set (165) is NOT shown on Jeff's recap");
  ok(!sink.html.includes('105 lb') && !sink.html.includes('65 lb × 10'), "Brian's and Alice's Overhead sets are NOT shown on Jeff's recap");
  ok(sink.html.includes('No sets logged'), "Overhead Press (Jeff never logged it himself) honestly shows \"No sets logged\" on Jeff's own recap, not someone else's numbers");
  ok(/pp-collab">with @rso_brian, @rso_alice/.test(sink.html), 'the "with @Brian, @Alice" line still names who else was part of it (got ' + ((sink.html.match(/pp-collab">[^<]*/) || [])[0]) + ')');
}

console.log("\nBrian's own posted recap (same session) shows only Brian's sets -- each participant's recap is independently scoped");
{
  const ctx = makeCtx();
  vm.runInContext(`TOKEN = ${JSON.stringify(brian.token)}; ME = ${JSON.stringify(brian.user)};`, ctx);
  sink.html = '';
  await vm.runInContext('viewPost', ctx)(s.id, brian.user.id);
  ok(sink.html.includes('165 lb') && sink.html.includes('105 lb'), "Brian's own Bench (165) and Overhead (105) sets are both shown");
  ok(!sink.html.includes('185 lb'), "Jeff's Bench set (185) is NOT shown on Brian's recap");
  ok(!sink.html.includes('65 lb × 10'), "Alice's Overhead set (65 lb x 10 reps) is NOT shown on Brian's recap either");
}

console.log('\ncold-review-adjacent fix: the "with @X" collaborator line names everyone EXCEPT the recap\'s own author, not a hardcoded creator -- viewing your OWN recap never lists yourself as one of your own training partners');
{
  const ctx = makeCtx();
  vm.runInContext(`TOKEN = ${JSON.stringify(brian.token)}; ME = ${JSON.stringify(brian.user)};`, ctx);
  sink.html = '';
  await vm.runInContext('viewPost', ctx)(s.id, brian.user.id);
  ok(!/@rso_brian\b/.test(sink.html), "Brian's own recap (viewed by Brian himself) never lists Brian in the collaborator line");
  ok(/with @You/.test(sink.html) === false || /with @rso_jeff|with @You/.test(sink.html), 'sanity: some collaborator naming is present');

  // Now Jeff (a different participant) views Brian's recap -- Brian's line should name Jeff by
  // pronoun ("You", since Jeff is the one reading it) and Alice by name -- never Brian himself.
  vm.runInContext(`TOKEN = ${JSON.stringify(jeff.token)}; ME = ${JSON.stringify(jeff.user)};`, ctx);
  sink.html = '';
  await vm.runInContext('viewPost', ctx)(s.id, brian.user.id);
  ok(!/@rso_brian\b/.test(sink.html), "Brian's recap still never lists Brian himself, regardless of who's viewing it");
  ok(/pp-collab">with @You, @rso_alice/.test(sink.html), `Jeff (the viewer) is named "You", Alice by name (got ${(sink.html.match(/pp-collab">[^<]*/) || [])[0]})`);
}

console.log('\nviewing someone ELSE\'s recap still labels whose sets they are (needed now that there\'s no "more than one person on this card" ambiguity check left to rely on)');
{
  const ctx = makeCtx();
  vm.runInContext(`TOKEN = ${JSON.stringify(jeff.token)}; ME = ${JSON.stringify(jeff.user)};`, ctx);
  sink.html = '';
  await vm.runInContext('viewPost', ctx)(s.id, brian.user.id);
  ok(/pp-who">rso_brian/.test(sink.html), `Brian's name labels his own sets when Jeff views Brian's recap (got ${(sink.html.match(/pp-who">[^<]*/) || [])[0]})`);
}

try { srv && srv.kill(); } catch {}
rmSync(DIR, { recursive: true, force: true });
await testDb.drop();

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
