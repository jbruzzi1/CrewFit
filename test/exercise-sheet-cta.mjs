// Sep 28 2026 audit finding #7 (Jeff): "Exercise sheet from the Workouts tab has no action.
// Tapping Cable Fly from the library shows info but no 'Start a workout with this' / 'Add to
// today's workout.' The library is a dead end unless you already started a session." Jeff's
// call: "lets do both - if there is an active workout, it will show add to todays? if not - just
// start a workout with this" -- built as the new action row inside exDetail() (public/app.js).
//
// A cold-review subagent, before this shipped to Jeff, caught a real bug in the first version:
// the live-session lookup only checked isSessionLiveNow(s), which says nothing about whether you
// have actually JOINED that session -- GET /api/sessions also returns sessions you're merely
// INVITED to (not yet accepted). A pending invite to a friend's workout starting right now could
// get picked as "live," offering "Add to today's workout" for a plan the user can't actually add
// to yet (the server's own /suggest route 403s that exact case with "accept the invite first").
// The fix mirrors home()'s own established `yours` filter (see its comment there): exclude any
// session where I'm in `invited` before ever checking isSessionLiveNow.
//
// This file locks that fix in place by running the REAL exDetail() (public/app.js) inside
// node:vm against fixture /api/sessions responses -- same technique as test/client-hostile.mjs
// (which already exercises exDetail this way) and the FixedDate pattern from
// test/home-live-window-and-workouts-view.mjs (so "live right now" is deterministic, not tied to
// whatever moment this happens to run).
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
const doc = { getElementById: () => el(), querySelector: () => el(), querySelectorAll: () => [],
  createElement: () => el(), addEventListener() {}, body: el(), documentElement: el(), head: el(),
  cookie: '', readyState: 'complete' };
// Same fixed-instant trick as test/home-live-window-and-workouts-view.mjs -- isSessionLiveNow's
// internal Date.now()/new Date() calls must be deterministic, not tied to whatever wall-clock
// moment this suite happens to run at.
const FIXED_NOW = new Date(2026, 8, 28, 14, 0, 0);
class FixedDate extends Date {
  constructor(...args) { args.length ? super(...args) : super(FIXED_NOW.getTime()); }
  static now() { return FIXED_NOW.getTime(); }
}
const ctx = { console: { log() {}, warn() {}, error() {} }, document: doc,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  fetch: () => Promise.resolve({ json: () => Promise.resolve([]), ok: true, status: 200, text: () => Promise.resolve('') }),
  location: { href: '/', pathname: '/', search: '', hash: '' },
  history: { replaceState() {}, pushState() {} }, addEventListener() {}, removeEventListener() {}, scrollTo() {},
  navigator: { userAgent: 'node', serviceWorker: { register: () => Promise.resolve() }, onLine: true },
  setTimeout, clearTimeout, setInterval, clearInterval, alert() {}, confirm: () => true, prompt: () => null,
  requestAnimationFrame: f => setTimeout(f, 0), matchMedia: () => ({ matches: false, addEventListener() {} }),
  FileReader: function () {}, Image: function () {}, URL, Blob: function () {}, FormData: function () {},
  IntersectionObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
  ResizeObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
  Date: FixedDate, Math };
ctx.window = ctx; ctx.globalThis = ctx; ctx.self = ctx;
vm.createContext(ctx);
vm.runInContext(SRC, ctx, { filename: 'public/app.js' });
vm.runInContext(`ME = { id: 'me1', displayName: 'Me' };`, ctx);
vm.runInContext(`FAVORITES = new Set();`, ctx);
ctx._LIB2 = [{ name: 'Test Squat', muscle_groups: ['quads'], equipment: ['barbell'], level: 'beginner', is_compound: true }];

const minsFromNow = n => new Date(FIXED_NOW.getTime() + n * 60000).toISOString();
const daysAhead = n => new Date(FIXED_NOW.getTime() + n * 86400000).toISOString();
const base = { history: [], logs: {}, posts: {} };
const flush = () => new Promise(r => setTimeout(r, 0));

// Mocks H.get so exDetail's two fetch-after-render calls (/api/sessions and
// /api/progress/exercise/:name) resolve deterministically, then opens the sheet and waits a tick
// for both .then() callbacks to run, mirroring exactly how the real browser event loop settles
// them (they are not awaited by exDetail itself -- it returns before they resolve).
async function openSheet(sessions) {
  sink.html = '';
  vm.runInContext(`
    H.get = (p) => Promise.resolve(
      p === '/api/sessions' ? ${JSON.stringify(sessions)} : {}
    );
  `, ctx);
  vm.runInContext(`exDetail('Test Squat')`, ctx);
  await flush(); await flush();
  return sink.html;
}

console.log('exercise sheet CTA -- no live session at all');
{
  const html = await openSheet([]);
  ok(html.includes('Start a workout with this'), 'shows "Start a workout with this"');
  ok(!html.includes("Add to today's workout"), 'and not the add-to-live button');
}

console.log('\nexercise sheet CTA -- a session I actually joined, live right now, mine');
{
  const s = { id: 's1', creatorId: 'me1', participants: ['me1'], invited: [],
    exercises: [{ id: 'e1' }], scheduledAt: minsFromNow(5), ...base };
  const html = await openSheet([s]);
  ok(html.includes("Add to today's workout"), 'shows "Add to today\'s workout"');
  ok(/exAddToLive\('s1','Test Squat',true\)/.test(html), 'wired to exAddToLive with isMine=true');
}

console.log('\nexercise sheet CTA -- a session I actually joined, live right now, NOT mine (a training partner\'s)');
{
  const s = { id: 's2', creatorId: 'friend1', participants: ['me1', 'friend1'], invited: [],
    exercises: [{ id: 'e1' }], scheduledAt: minsFromNow(5), ...base };
  const html = await openSheet([s]);
  ok(html.includes("Add to today's workout"), 'still shows "Add to today\'s workout"');
  ok(/exAddToLive\('s2','Test Squat',false\)/.test(html), 'wired to exAddToLive with isMine=false (goes through suggest, not a direct edit)');
}

console.log('\nregression (cold-review catch): a PENDING invite to a session scheduled right now is NOT "live" for this purpose');
{
  // I'm listed in participants (server adds invitees there too) AND in invited -- not yet
  // accepted. Before the fix, isSessionLiveNow(s) alone said nothing about this and the sheet
  // would have offered "Add to today's workout" for a workout I can't actually add to yet (the
  // server's own /suggest route 403s with "accept the invite first").
  const pending = { id: 's-pending', creatorId: 'friend1', participants: ['me1', 'friend1'], invited: ['me1'],
    exercises: [{ id: 'e1' }], scheduledAt: minsFromNow(5), ...base };
  const html = await openSheet([pending]);
  ok(html.includes('Start a workout with this'), 'falls back to "Start a workout with this", not the live-add button');
  ok(!html.includes("Add to today's workout"), 'never offers to add to a workout I have not accepted');
  ok(!/exAddToLive/.test(html), 'exAddToLive is not wired up at all in this state');
}

console.log('\nregression: a pending invite live "now" must not shadow a REAL joined+live session also present');
{
  const pending = { id: 's-pending2', creatorId: 'friend1', participants: ['me1', 'friend1'], invited: ['me1'],
    exercises: [{ id: 'e1' }], scheduledAt: minsFromNow(5), ...base };
  const real = { id: 's-real', creatorId: 'me1', participants: ['me1'], invited: [],
    exercises: [{ id: 'e1' }], scheduledAt: minsFromNow(6), ...base };
  const html = await openSheet([pending, real]);
  ok(/exAddToLive\('s-real','Test Squat',true\)/.test(html), 'picks the real joined session, not the pending invite');
}

console.log('\nnot live -- a session scheduled later today (outside the 10-min window) does not count as live');
{
  const s = { id: 's3', creatorId: 'me1', participants: ['me1'], invited: [],
    exercises: [{ id: 'e1' }], scheduledAt: minsFromNow(240), ...base };
  const html = await openSheet([s]);
  ok(html.includes('Start a workout with this'), 'falls back to "Start a workout with this"');
}

console.log('\nnot live -- a session scheduled for a future day does not count as live even if I created it');
{
  const s = { id: 's4', creatorId: 'me1', participants: ['me1'], invited: [],
    exercises: [{ id: 'e1' }], scheduledAt: daysAhead(1), ...base };
  const html = await openSheet([s]);
  ok(html.includes('Start a workout with this'), 'falls back to "Start a workout with this"');
}

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
