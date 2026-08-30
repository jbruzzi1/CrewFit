// v249 audit finding: viewPost() (public/app.js) rendered "No sets logged" under any exercise
// card with no VISIBLE sets on it — but "no sets logged" and "no sets I'm allowed to see" are two
// different facts. A departed participant's sets are stored and real even after they leave (see
// test/leave-workout.mjs), and if their recap's own privacy setting (Only me / Friends) doesn't
// admit this viewer, the server never sends their sets to the client at all — sessionView strips
// them before this page ever runs. The old code had no way to tell "genuinely nobody logged this"
// from "someone logged this and I'm just not allowed to see it," and said the same false-when-wrong
// sentence either way. CLAUDE.md's own rule: "never state something about the user you can't stand
// behind" (the v163 incident this rule exists for is the same shape of bug — a definite claim
// about someone's history that happened to be untrue for a specific viewer).
//
// The fix (see the comment above `hasHiddenPost` in app.js): once the session has ANY hidden recap
// in it (view.posts still carries a {hidden:true} placeholder for a recap that exists but isn't
// visible to this viewer — that's the one signal the server does leak, deliberately, without
// leaking the recap's content), every otherwise-empty exercise card switches from the flat "No sets
// logged" claim to the honest hedge "Sets not shared." It can't be exercise-precise (the hidden
// person's logs never reach the client, so there's no way to know which exercises they touched),
// so it hedges every empty card on the page rather than risk being wrong on any one of them.
//
// This test runs the REAL server AND the REAL public/app.js via node:vm (same harness as
// test/leave-workout.mjs), so viewPost's actual rendered HTML is what gets asserted on, not a
// re-implementation of its logic.
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
const testDb = await freshTestDb('hiddenrecap');

function boot(port, dir) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; srv.stdout.on('data', d => { out += d; if (String(d).includes('CrewFit on')) res({ srv, out }); });
    srv.on('exit', () => res({ srv: null, out }));
    setTimeout(() => res({ srv, out }), 15000);
  });
}

const DIR = mkdtempSync(join(tmpdir(), 'hiddenrecap-'));
const PORT = 4986, B = `http://localhost:${PORT}`;
const { srv } = await boot(PORT, DIR);
ok(!!srv, 'server boots');

const post = (p, b, tok) => fetch(B + p, { method: 'POST', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b) }).then(r => r.json());
const reg = (username, pin, displayName) => post('/api/register', { username, pin, displayName });

// ---- render the REAL client against the REAL running server (same harness as leave-workout.mjs) ----
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
  // v254: app.js now registers a top-level window.addEventListener('popstate', ...) (the Back-
  // button fix) and calls history.pushState/replaceState from openSheetHtml/closeSheet/navigated/
  // landOn -- these need to be real enough not to throw, even in tests that don't care about nav.
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

console.log("the exact bug: a departed participant's recap is set to 'Only me', but their sets are real — the empty Bench Press card must not claim nobody logged it");
{
  const host = await reg('hr_host', 'pass1234', 'Host');
  const partnerA = await reg('hr_partnera', 'pass1234', 'PartnerA');
  const buddy = await reg('hr_buddy', 'pass1234', 'Buddy');
  for (const uname of ['hr_partnera', 'hr_buddy']) {
    await post('/api/friends/request', { username: uname }, host.token);
  }
  await post('/api/friends/accept', { from: host.user.id }, partnerA.token);
  await post('/api/friends/accept', { from: host.user.id }, buddy.token);

  const s = await post('/api/sessions', {
    name: 'Push Day', scheduledAt: new Date().toISOString(),
    exercises: [{ name: 'Bench Press' }, { name: 'Overhead Press' }],
    inviteUsernames: [], visibility: 'private',
  }, host.token);
  await fetch(B + '/api/sessions/' + s.id, {
    method: 'PUT', headers: { ...J, Authorization: 'Bearer ' + host.token },
    body: JSON.stringify({ inviteUsernames: ['hr_partnera', 'hr_buddy'] }),
  }).then(r => r.json());
  await post('/api/sessions/' + s.id + '/accept', {}, partnerA.token);
  await post('/api/sessions/' + s.id + '/accept', {}, buddy.token);

  const benchId = s.exercises.find(e => e.name === 'Bench Press').id;
  // Overhead Press is deliberately never logged by anyone — the genuinely-empty control case.
  await post('/api/sessions/' + s.id + '/log', { exerciseId: benchId, weight: 185, reps: 5 }, partnerA.token);
  await post('/api/sessions/' + s.id + '/log', { exerciseId: benchId, weight: 185, reps: 5, set: 2 }, partnerA.token);
  const posted = await post('/api/sessions/' + s.id + '/post', { notes: 'good session', visibility: 'only_me', media: [] }, partnerA.token);
  ok(!posted.error, `partnerA posts a private ("Only me") recap (got ${posted.error})`);
  const left = await post('/api/sessions/' + s.id + '/leave', { keep: true }, partnerA.token);
  ok(!!left.left, `partnerA leaves, keeping credit (got ${JSON.stringify(left)})`);

  const ctx = makeCtx();
  vm.runInContext(`TOKEN = ${JSON.stringify(buddy.token)}; ME = ${JSON.stringify(buddy.user)};`, ctx);
  sink.html = '';
  await vm.runInContext('viewPost', ctx)(s.id, host.user.id);
  ok(!sink.html.includes('No sets logged'), 'the page never falsely claims "No sets logged" once a hidden recap is in the mix');
  ok(sink.html.includes('Sets not shared'), 'Bench Press (genuinely has hidden sets) is honestly hedged as "Sets not shared"');
  ok((sink.html.match(/Sets not shared/g) || []).length === 2,
    'BOTH exercise cards hedge — Overhead Press too, since the client cannot know which exercise the hidden recap covers');
}

console.log('\ncontrol case: no hidden recaps in the session at all — "No sets logged" still shows plainly for a genuinely untouched exercise, so the fix does not just delete the honest common case');
{
  const solo = await reg('hr_solo', 'pass1234', 'Solo');
  const s = await post('/api/sessions', {
    name: 'Leg Day', scheduledAt: new Date().toISOString(),
    exercises: [{ name: 'Back Squat' }, { name: 'Leg Press' }],
    inviteUsernames: [], visibility: 'private',
  }, solo.token);
  const squatId = s.exercises.find(e => e.name === 'Back Squat').id;
  await post('/api/sessions/' + s.id + '/log', { exerciseId: squatId, weight: 225, reps: 5 }, solo.token);
  await post('/api/sessions/' + s.id + '/post', { notes: 'quads done', visibility: 'public', media: [] }, solo.token);

  const ctx = makeCtx();
  vm.runInContext(`TOKEN = ${JSON.stringify(solo.token)}; ME = ${JSON.stringify(solo.user)};`, ctx);
  sink.html = '';
  await vm.runInContext('viewPost', ctx)(s.id, solo.user.id);
  ok(sink.html.includes('No sets logged'), 'Leg Press (truly untouched, no hidden recaps anywhere) still says "No sets logged"');
  ok(!sink.html.includes('Sets not shared'), 'and the hedge never fires when there is nothing to hedge about');
}

try { srv && srv.kill(); } catch {}
rmSync(DIR, { recursive: true, force: true });
await testDb.drop();

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
