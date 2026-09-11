// Sep 11 2026, real bug report: after finishing a workout, three screens for the SAME session
// disagreed on what day it happened. The recap ("Nice work") page said "Friday, Sep 11" while the
// very next screen (Save workout) and the workout's own entry in Profile history both correctly
// said "Sep 10, 9:44 PM". Root cause: rcDay() (public/app.js) -- used only by the recap headline --
// sliced scheduledAt (a full UTC ISO timestamp) down to its first 10 characters and re-parsed THAT
// substring, which is the UTC calendar date, not the local one. For anyone west of UTC, an evening
// workout that's already "tomorrow" in UTC (e.g. 9:44 PM US Eastern = 01:44 UTC the next day) showed
// the recap headline one day ahead of reality. showSavePage() had this EXACT bug and fixed it back
// in v247 (see its own comment above `const when = ...` in app.js) by handing scheduledAt's FULL
// value straight to a Date-based formatter instead of slicing first -- rcDay() never got the same
// fix. This test drives the real rcDay() out of public/app.js via node:vm (same harness family as
// test/home-live-window-and-workouts-view.mjs), under a real negative-UTC-offset timezone, so the
// exact reported mismatch is reproduced and proven fixed.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Must be set before any Date is constructed in this process -- Node reads process.env.TZ lazily,
// so setting it this early is sufficient (confirmed: no need to spawn a subprocess for this).
process.env.TZ = 'America/New_York';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };

const SRC = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const el = () => new Proxy(function () {}, {
  get: (t, k) => k === 'style' || k === 'classList' || k === 'dataset' ? el()
    : k === 'innerHTML' || k === 'innerText' || k === 'value' || k === 'textContent' ? ''
    : k === 'children' || k === 'childNodes' ? [] : el(),
  set: () => true, apply: () => el(), has: () => true,
});
const doc = { getElementById: () => el(), querySelector: () => el(), querySelectorAll: () => [],
  createElement: () => el(), addEventListener() {}, body: el(), documentElement: el(), head: el(),
  cookie: '', readyState: 'complete' };
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
  // The REAL Date, not a fixed stand-in -- this test is specifically about timezone conversion,
  // which needs Date/toLocaleDateString to behave exactly as they do for a real user's browser.
  Date, Math };
ctx.window = ctx; ctx.globalThis = ctx; ctx.self = ctx;
vm.createContext(ctx);
vm.runInContext(SRC, ctx, { filename: 'public/app.js' });
const rcDay = vm.runInContext('rcDay', ctx);
const fmtDate = vm.runInContext('fmtDate', ctx);

console.log('the exact reported bug: an evening US-Eastern workout, already tomorrow in UTC');
{
  // 9:44 PM Eastern on Sep 10 2026 (EDT, UTC-4) = 01:44 UTC on Sep 11 2026.
  const scheduledAt = '2026-09-11T01:44:00.000Z';
  ok(rcDay(scheduledAt) === 'Thursday, Sep 10',
    `recap headline reads the LOCAL day (got "${rcDay(scheduledAt)}")`);
  ok(fmtDate(scheduledAt).startsWith('Sep 10'),
    `...matching what the save screen / profile history already correctly show (got "${fmtDate(scheduledAt)}")`);
}

console.log('\na genuinely next-day session (well past midnight local too) still reads as the later day');
{
  // 1:00 AM Eastern on Sep 11 -- both local and UTC calendar days agree it is the 11th.
  const scheduledAt = '2026-09-11T05:00:00.000Z';
  ok(rcDay(scheduledAt) === 'Friday, Sep 11', `got "${rcDay(scheduledAt)}"`);
}

console.log('\na morning session (UTC and local agree) is unaffected either way');
{
  // 8:00 AM Eastern on Sep 10 -- nowhere near a day boundary in either timezone.
  const scheduledAt = '2026-09-10T12:00:00.000Z';
  ok(rcDay(scheduledAt) === 'Thursday, Sep 10', `got "${rcDay(scheduledAt)}"`);
}

console.log('\nmalformed/missing input never throws, same as before the fix');
{
  ok(rcDay('') === '', `empty string -> empty, no throw (got "${rcDay('')}")`);
  ok(rcDay(undefined) === '', `undefined -> empty, no throw (got "${rcDay(undefined)}")`);
  ok(rcDay('not-a-date') === 'not-a-date', `garbage -> the raw value back, no throw (got "${rcDay('not-a-date')}")`);
}

console.log('\nDEFENSE IN DEPTH: a bare date-only scheduledAt (no time component) reads one day');
console.log('EARLY here, the mirror image of the bug this file fixes -- rcDay() itself has no way');
console.log('to know it was handed an incomplete value. The server now guards the actual gap (see');
console.log('normalizedScheduledAt() in server.js / test/scheduled-at-validation.mjs -- a bare date');
console.log('can no longer reach a stored session at all, it falls back to "now" at write time), so');
console.log('this can\'t happen in practice any more. This assertion just locks in rcDay\'s own');
console.log('behavior on malformed input at the client-function level too, belt-and-suspenders.');
{
  // "2026-09-11" with no time parses as 2026-09-11T00:00:00.000Z (UTC midnight) -- 8:00 PM the
  // PRIOR day in US-Eastern (EDT, UTC-4). Meant to represent the 11th, reads as the 10th.
  const scheduledAt = '2026-09-11';
  ok(rcDay(scheduledAt) === 'Thursday, Sep 10',
    `bare date-only input reads one day early under UTC-4 (got "${rcDay(scheduledAt)}") -- ` +
    `known, pre-existing, unclosed by this fix; see comment above`);
}

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
