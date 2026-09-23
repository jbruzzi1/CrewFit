// Sep 23 2026 (Jeff, real question: "if I make a swap - but brian kept the original - how does
// this work when logging that workout as both Brians sets and mine on workouts show on the
// logged workout on my profile"): the SHARED posted-workout recap screen (viewPost in app.js)
// groups every participant's sets for an exercise under one heading, and only ever disambiguated
// a participant's sets with a "logged as X" note when a GROUP-approved swap existed
// (approvedFor[e.id]). A personal "just me" swap (s.variations[e.id][pid], reason:'self') never
// touches approvedFor, so someone who personally swapped an exercise while everyone else kept the
// original had their sets silently grouped under the ORIGINAL exercise's heading with no note at
// all -- reading as if they'd done the original lift when they'd actually done a different one.
// Fixed: a personal variation on file for that participant now counts as a real swap too.
//
// Runs the REAL server AND the REAL public/app.js via node:vm (same harness as
// test/message-button-removed.mjs / test/leave-workout.mjs), so what's asserted is the actual
// viewPost() render, not a re-implementation of its branching.
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
const testDb = await freshTestDb('viewpostswap');

function boot(port, dir) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    srv.stdout.on('data', d => { if (String(d).includes('CrewFit on')) res(srv); });
    srv.on('exit', () => res(null));
    setTimeout(() => res(null), 15000);
  });
}

const DIR = mkdtempSync(join(tmpdir(), 'viewpostswap-'));
const PORT = 4985, B = `http://localhost:${PORT}`;
const srv = await boot(PORT, DIR);
ok(!!srv, 'server boots');

const post = (p, b, tok) => fetch(B + p, { method: 'POST', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b) }).then(r => r.json());
const put = (p, b, tok) => fetch(B + p, { method: 'PUT', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b) }).then(r => r.json());
const reg = (username) => post('/api/register', { username, pin: 'pass1234', displayName: username });

// ---- render the REAL client against the REAL running server (same harness as message-button-removed.mjs) ----
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

console.log('\na personal ("just me") swap gets a "logged as X" note on YOUR OWN posted recap even though the creator kept the original -- Jeff\'s exact real-world question ("...on the logged workout on my profile")');
{
  const brian = await reg('vps_brian1');
  const jeff = await reg('vps_jeff1');
  await post('/api/follow/' + jeff.user.id, {}, brian.token);
  const s = await post('/api/sessions', {
    name: 'Push Day', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Barbell Row' }],
    visibility: 'private', inviteUsernames: ['vps_jeff1'],
  }, brian.token);
  await post(`/api/sessions/${s.id}/accept`, {}, jeff.token);
  const rowId = s.exercises[0].id;

  // Jeff personally swaps Barbell Row -> Dumbbell Row (just for him); Brian never swaps.
  const swapRes = await post(`/api/sessions/${s.id}/variation`, { exerciseId: rowId, swapTo: 'Dumbbell Row', reason: 'self' }, jeff.token);
  ok(!swapRes.error, `Jeff's personal swap goes through (got ${swapRes.error})`);

  await post(`/api/sessions/${s.id}/log`, { exerciseId: rowId, weight: 135, reps: 8 }, brian.token);
  await post(`/api/sessions/${s.id}/log`, { exerciseId: rowId, weight: 45, reps: 10 }, jeff.token);
  await post(`/api/sessions/${s.id}/post`, { notes: 'Push day done', visibility: 'private', media: [] }, brian.token);
  // Sep 23 2026 (Jeff, follow-up: "should only show the sets I personally logged, not everyone
  // involved"): each participant gets their OWN posted recap now, so Jeff posts his own here too.
  await post(`/api/sessions/${s.id}/post`, { notes: 'Push day done (Jeff)', visibility: 'private', media: [] }, jeff.token);

  const ctx = makeCtx();
  vm.runInContext(`TOKEN = ${JSON.stringify(brian.token)}; ME = ${JSON.stringify(brian.user)};`, ctx);
  sink.html = '';
  await vm.runInContext('viewPost', ctx)(s.id, brian.user.id);
  ok(sink.html.includes('Barbell Row'), 'Brian\'s own recap heading still shows the original name he kept (no group approval happened)');
  ok(!sink.html.includes('45 lb'), "Brian's own recap no longer shows Jeff's sets at all (Sep 23 2026 fix: a recap only ever shows its own author's sets now)");
  ok(!sink.html.includes('logged as Dumbbell Row'), 'so no swap-attribution note for Jeff appears on BRIAN\'s recap either -- there\'s nothing of Jeff\'s here to attribute');

  sink.html = '';
  await vm.runInContext('viewPost', ctx)(s.id, jeff.user.id);
  ok(sink.html.includes('Barbell Row'), 'JEFF\'s own recap card heading also reads "Barbell Row" -- the shared plan name, since Brian (creator) never renamed it');
  ok(sink.html.includes('45 lb'), "Jeff's own sets ARE shown on his own recap");
  ok(!sink.html.includes('135 lb'), "and Brian's sets are NOT shown on Jeff's recap");
  ok(sink.html.includes('logged as Dumbbell Row'), `Jeff's own recap carries the "logged as Dumbbell Row" note on his own sets, distinguishing them from the "Barbell Row" heading he personally swapped away from (got no match; html snippet: ${(sink.html.match(/pp-who[\s\S]{0,120}/g) || []).join(' | ')})`);
}

console.log('\na plain rename of the exercise (no swap on file for anyone) shows NO spurious "logged as" note, even though the already-logged set\'s stored name now differs from the new heading -- the original guard\'s whole purpose, preserved');
{
  const solo = await reg('vps_solo2');
  const s = await post('/api/sessions', {
    name: 'Solo Day', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Bench Press' }],
    visibility: 'private', inviteUsernames: [],
  }, solo.token);
  const benchId = s.exercises[0].id;
  await post(`/api/sessions/${s.id}/log`, { exerciseId: benchId, weight: 135, reps: 8 }, solo.token);
  // Creator edits the session and renames the SAME exercise id -- no variation, no suggestedEdit.
  const edited = await put(`/api/sessions/${s.id}`, { exercises: [{ id: benchId, name: 'Incline Bench Press' }] }, solo.token);
  ok(!edited.error, `the rename goes through (got ${edited.error})`);
  await post(`/api/sessions/${s.id}/post`, { notes: 'Solo done', visibility: 'private', media: [] }, solo.token);

  const ctx2 = makeCtx();
  vm.runInContext(`TOKEN = ${JSON.stringify(solo.token)}; ME = ${JSON.stringify(solo.user)};`, ctx2);
  sink.html = '';
  await vm.runInContext('viewPost', ctx2)(s.id, solo.user.id);
  ok(sink.html.includes('Incline Bench Press'), 'the card heading shows the renamed exercise');
  ok(!sink.html.includes('logged as'), 'no "logged as" note is shown for a plain rename -- there was never an actual swap, just a typo/name fix, same protection the original guard already had');
}

try { srv && srv.kill(); } catch {}
rmSync(DIR, { recursive: true, force: true });
await testDb.drop();

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
