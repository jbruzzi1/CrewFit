// Oct 2 2026 (Tier 3 audit #158, Jeff's own pick, already captured earlier in this engagement):
// the privacy-toggle confirm sheet ("Make profile private?"/"Make profile public?") used to list
// "PRs, streak, activity, and posted workouts" as what the toggle controls visibility of. The app
// stopped surfacing a day-streak concept on the profile itself back on Sep 30 2026 (the "day
// streak" pill was removed from both the profile header and the crew roster -- see the comments
// above profileView's pinfo block and crewView's member rows in app.js), so naming "streak" here
// went stale -- it described a UI element that no longer exists. Jeff's fix: drop it from the
// sentence. This is a pure client-side text change (toggleProfileVisibility in app.js) with no
// server round trip -- confirmSheet renders synchronously off ME.profileVisibility, so this test
// loads the real public/app.js into a node:vm context directly, no server boot required.
// Run:  npm test
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };

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
    fetch: () => Promise.reject(new Error('no network expected in this test')),
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

console.log('going private: the confirm sheet lists PRs/activity/posted workouts, with no mention of "streak"');
{
  const ctx = makeCtx();
  vm.runInContext(`ME = { id: 'u1', profileVisibility: 'public' };`, ctx);
  sink.html = '';
  vm.runInContext('toggleProfileVisibility', ctx)();
  ok(sink.html.includes('Make profile private?'), 'the right sheet opened (going private, from public)');
  ok(sink.html.includes('PRs, activity, and posted workouts'), `the new wording renders (got: ${sink.html.slice(0, 500)})`);
  ok(!/\bstreak\b/i.test(sink.html), 'no mention of "streak" anywhere in this sheet');
}

console.log('\ngoing public: same fix applies to the other direction\'s copy too');
{
  const ctx = makeCtx();
  vm.runInContext(`ME = { id: 'u1', profileVisibility: 'private' };`, ctx);
  sink.html = '';
  vm.runInContext('toggleProfileVisibility', ctx)();
  ok(sink.html.includes('Make profile public?'), 'the right sheet opened (going public, from private)');
  ok(sink.html.includes('PRs, activity, and posted workouts'), `the new wording renders (got: ${sink.html.slice(0, 500)})`);
  ok(!/\bstreak\b/i.test(sink.html), 'no mention of "streak" anywhere in this sheet either');
}

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
