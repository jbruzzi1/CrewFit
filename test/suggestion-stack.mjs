// Sep 23 2026 (Jeff, bug #3 from the original three-bug list: "layered suggestions instead of
// list view"). Confirmed with Jeff (clarifying questions, since the original detail had aged out
// of context): the "Suggested changes" section on a workout used to stack every pending swap/add
// suggestion as its own full-width card, one under the next -- fine for one, a wall of cards for a
// group where several people propose something. Replaced with a shallow deck: one card visible at
// a time (the next 1-2 peeking out behind it for depth), dots below to page through, deciding the
// front card (existing approve()/reject(), which already re-render this screen) naturally reveals
// the next one.
//
// Runs the REAL server AND the REAL public/app.js via node:vm (same harness as
// test/message-button-removed.mjs), so what's asserted is openSession()'s actual rendered HTML,
// not a re-implementation of its branching. Real interactive taps (approve/reject/gotoSuggestion)
// are exercised through the VM'd global functions themselves, same as test/_verify_removal_kick_
// hide_shot.mjs did for the kick/hide flow earlier this engagement.
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
const testDb = await freshTestDb('suggstack');

function boot(port, dir) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    srv.stdout.on('data', d => { if (String(d).includes('CrewFit on')) res(srv); });
    srv.on('exit', () => res(null));
    setTimeout(() => res(null), 15000);
  });
}

const DIR = mkdtempSync(join(tmpdir(), 'suggstack-'));
const PORT = 4983, B = `http://localhost:${PORT}`;
const srv = await boot(PORT, DIR);
ok(!!srv, 'server boots');

const post = (p, b, tok) => fetch(B + p, { method: 'POST', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b) }).then(r => r.json());
const reg = (username, displayName) => post('/api/register', { username, pin: 'pass1234', displayName: displayName || username });

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

const brian = await reg('sst_brian', 'Brian');
const jeff = await reg('sst_jeff', 'Jeff');
const alice = await reg('sst_alice', 'Alice');
await post('/api/follow/' + jeff.user.id, {}, brian.token);
await post('/api/follow/' + alice.user.id, {}, brian.token);

const s = await post('/api/sessions', {
  name: 'Push Day', scheduledAt: new Date().toISOString(),
  exercises: [{ name: 'Bench Press' }], visibility: 'private',
  inviteUsernames: ['sst_jeff', 'sst_alice'],
}, brian.token);
await post(`/api/sessions/${s.id}/accept`, {}, jeff.token);
await post(`/api/sessions/${s.id}/accept`, {}, alice.token);

console.log('\na single pending suggestion renders as a plain card -- no stack chrome for just one');
{
  await post(`/api/sessions/${s.id}/suggest`, { type: 'add', name: 'Cable Fly' }, jeff.token);
  const ctx = makeCtx();
  vm.runInContext(`TOKEN = ${JSON.stringify(brian.token)}; ME = ${JSON.stringify(brian.user)};`, ctx);
  sink.html = '';
  await vm.runInContext('openSession', ctx)(s.id);
  ok(sink.html.includes('Jeff suggests adding Cable Fly'), 'the suggestion renders');
  ok(!sink.html.includes('sugg-stack'), 'no stack wrapper for a single suggestion');
  ok(!sink.html.includes('sugg-dot'), 'no paging dots for a single suggestion');
}

console.log('\n2+ pending suggestions render as a stacked deck: one front card, peek strips behind it, and paging dots');
{
  await post(`/api/sessions/${s.id}/suggest`, { type: 'add', name: 'Incline Press' }, alice.token);
  const ctx = makeCtx();
  vm.runInContext(`TOKEN = ${JSON.stringify(brian.token)}; ME = ${JSON.stringify(brian.user)};`, ctx);
  sink.html = '';
  await vm.runInContext('openSession', ctx)(s.id);
  ok(sink.html.includes('sugg-stack'), 'the stack wrapper renders now that there are 2 pending');
  ok((sink.html.match(/sugg-peek/g) || []).length === 1, `exactly one peek strip behind the front card for 2 total (got ${(sink.html.match(/sugg-peek/g) || []).length})`);
  ok((sink.html.match(/<span class="sugg-dot/g) || []).length === 2, 'two paging dots, one per pending suggestion');
  ok(sink.html.includes('font-size:12px">1 of 2<'), 'the page counter reads "1 of 2"');
  ok(sink.html.includes('Jeff suggests adding Cable Fly'), "the first-proposed suggestion (Jeff's) is the front card by default");
  ok(!sink.html.includes('Incline Press'), "Alice's suggestion is NOT on screen yet -- it's the one behind the front card");
}

console.log('\ntapping a dot pages the deck to that suggestion, without deciding anything');
{
  const ctx = makeCtx();
  vm.runInContext(`TOKEN = ${JSON.stringify(brian.token)}; ME = ${JSON.stringify(brian.user)};`, ctx);
  sink.html = '';
  await vm.runInContext('gotoSuggestion', ctx)(s.id, 1);
  ok(sink.html.includes('Alice suggests adding Incline Press'), 'the front card is now Alice\'s suggestion (index 1)');
  ok(sink.html.includes('font-size:12px">2 of 2<'), 'the page counter reads "2 of 2"');

  // A non-creator (Jeff) sees the same deck, same current page, but "waiting on creator" instead
  // of Approve/Reject -- the deck is genuinely shared state, not per-viewer.
  const ctx2 = makeCtx();
  vm.runInContext(`TOKEN = ${JSON.stringify(jeff.token)}; ME = ${JSON.stringify(jeff.user)};`, ctx2);
  sink.html = '';
  await vm.runInContext('openSession', ctx2)(s.id);
  ok(sink.html.includes('waiting on creator'), 'Jeff (not the creator) sees "waiting on creator" instead of decision buttons on the front card');
  ok(!/<button class="sm ok"/.test(sink.html), 'and genuinely no Approve button rendered for him');
}

console.log("\napproving the front card decides it and reveals the next one -- deciding is what pages the deck forward for whoever's approving");
{
  const ctx = makeCtx();
  vm.runInContext(`TOKEN = ${JSON.stringify(brian.token)}; ME = ${JSON.stringify(brian.user)};`, ctx);
  // Brian is parked on index 1 (Alice's) from the gotoSuggestion call above -- approve it.
  const editRow = await fetch(B + `/api/sessions/${s.id}`, { headers: { Authorization: 'Bearer ' + brian.token } }).then(r => r.json());
  const aliceEdit = editRow.suggestedEdits.find(e => e.swapTo === 'Incline Press' && e.status === 'pending');
  sink.html = '';
  await vm.runInContext('approve', ctx)(s.id, aliceEdit.id);
  // approve() (app.js) fires its post-decide openSession() re-render without awaiting/returning
  // it (pre-existing shape, shared by approve/reject/approveJoin/rejectJoin -- fine for a real
  // onclick, which never awaits the return value either) -- give that in-flight render a moment
  // to actually finish writing to the DOM before reading it back.
  await new Promise(r => setTimeout(r, 80));
  ok(!sink.html.includes('sugg-stack'), 'only one pending suggestion left (Jeff\'s) -- back to a plain single card, no stack chrome');
  ok(sink.html.includes('Jeff suggests adding Cable Fly'), 'and it\'s the right one');
}

console.log('\nrejecting the last remaining suggestion empties the deck entirely -- no stray stack/dots left behind');
{
  const ctx = makeCtx();
  vm.runInContext(`TOKEN = ${JSON.stringify(brian.token)}; ME = ${JSON.stringify(brian.user)};`, ctx);
  const row = await fetch(B + `/api/sessions/${s.id}`, { headers: { Authorization: 'Bearer ' + brian.token } }).then(r => r.json());
  const jeffEdit = row.suggestedEdits.find(e => e.swapTo === 'Cable Fly' && e.status === 'pending');
  sink.html = '';
  await vm.runInContext('reject', ctx)(s.id, jeffEdit.id);
  await new Promise(r => setTimeout(r, 80)); // see the comment on the same pattern above (approve())
  ok(!sink.html.includes('Suggested changes'), 'the "Suggested changes" section is gone entirely -- nothing pending or decided left to show');
  ok(!sink.html.includes('sugg-stack') && !sink.html.includes('sugg-dot'), 'no leftover stack chrome');
}

console.log('\nSep 23 2026: viewing a DIFFERENT session\'s deck starts back at the front, not wherever a previous session\'s deck was left');
{
  const s2 = await post('/api/sessions', {
    name: 'Leg Day', scheduledAt: new Date().toISOString(),
    exercises: [{ name: 'Squat' }], visibility: 'private',
    inviteUsernames: ['sst_jeff', 'sst_alice'],
  }, brian.token);
  await post(`/api/sessions/${s2.id}/accept`, {}, jeff.token);
  await post(`/api/sessions/${s2.id}/accept`, {}, alice.token);
  await post(`/api/sessions/${s2.id}/suggest`, { type: 'add', name: 'Leg Press' }, jeff.token);
  await post(`/api/sessions/${s2.id}/suggest`, { type: 'add', name: 'Leg Curl' }, alice.token);

  const ctx = makeCtx();
  vm.runInContext(`TOKEN = ${JSON.stringify(brian.token)}; ME = ${JSON.stringify(brian.user)};`, ctx);
  sink.html = '';
  await vm.runInContext('openSession', ctx)(s2.id);
  ok(sink.html.includes('1 of 2'), 'a fresh session\'s deck starts at "1 of 2", ignoring whatever index a prior session left SUGG_STATE on');
  ok(sink.html.includes('Jeff suggests adding Leg Press'), 'front card is the first-proposed suggestion on THIS session');
}

try { srv && srv.kill(); } catch {}
rmSync(DIR, { recursive: true, force: true });
await testDb.drop();

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
