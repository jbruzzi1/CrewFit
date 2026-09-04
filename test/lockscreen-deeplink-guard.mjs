// v262 lock-screen-notification deep link: cold-review found 3 real bugs in the client-side
// handoff (tryBoot's ?openLog=sid:exId branch, and the serviceWorker 'message' listener that
// covers the already-open-tab case) and all 3 were fixed together. This is the permanent
// regression coverage for those fixes, same pattern as audit-v253-client.mjs/audit-v254-nav.mjs:
//   1. openSession now returns true only on its successful-render path (every pre-existing caller
//      already ignored its return value, so this was safe to add).
//   2. Both deep-link call sites gate their follow-up (v312: focusLogBlock, the inline card;
//      before that openLogSheet) on that return value -- without this, a dead or expired session
//      double-alerted (openSession's own alert, then the sheet's SEPARATE fetch-and-alert).
//   3. The serviceWorker 'message' listener is registered synchronously, before BOOT_DONE (the
//      named boot IIFE) has resolved ME -- a postMessage arriving in that window used to call
//      openSession() immediately (TOKEN alone passes server auth) and crash deep inside its own
//      render path on ME.id while ME was still null. It now awaits BOOT_DONE and bails if ME
//      never ended up populated (e.g. a failed boot), instead of blindly proceeding.
// Same node:vm harness family as test/audit-v254-nav.mjs / test/audit-v253-client.mjs.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };

const SRC = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

function makeEl(tag) {
  const el = {
    tagName: tag || 'DIV', className: '', style: {}, innerHTML: '',
    parentNode: null, _children: [], _removed: false, _classes: new Set(),
    appendChild(child) { child.parentNode = el; el._children.push(child); return child; },
    remove() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener() {}, setAttribute() {}, getAttribute() { return null; },
  };
  el.classList = { add() {}, remove() {}, contains: () => false };
  return el;
}
const body = makeEl('BODY');
const genericEl = () => new Proxy(function () {}, {
  get: (t, k) => k === 'children' || k === 'childNodes' ? [] : (k === 'innerText' || k === 'value' || k === 'textContent') ? '' : genericEl(),
  set: () => true, apply: () => genericEl(), has: () => true,
});
const doc = {
  body, createElement: () => makeEl('DIV'), getElementById: () => genericEl(),
  querySelector: () => genericEl(), querySelectorAll: () => [],
  addEventListener() {}, documentElement: genericEl(), head: genericEl(), cookie: '', readyState: 'complete',
};

let alertCalls = [];
let sessionFetchCalls = [];
let profileMeDelayMs = 0; // set per-test to control the ME race window
function jsonRes(v) { return Promise.resolve({ json: () => Promise.resolve(v), ok: true, status: 200, text: () => Promise.resolve('') }); }
function mockFetch(url) {
  if (/^\/api\/profile\/me/.test(url)) {
    if (profileMeDelayMs > 0) {
      return new Promise(res => setTimeout(() => res({ json: () => Promise.resolve({ id: 'me1', displayName: 'Test User' }), ok: true, status: 200, text: () => Promise.resolve('') }), profileMeDelayMs));
    }
    return jsonRes({ id: 'me1', displayName: 'Test User' });
  }
  if (/^\/api\/sessions\/badsid$/.test(url)) { sessionFetchCalls.push(url); return jsonRes({ error: 'Session not found' }); }
  if (/^\/api\/sessions\/goodsid$/.test(url)) {
    sessionFetchCalls.push(url);
    return jsonRes({ id: 'goodsid', creatorId: 'me1', participants: ['me1'], invited: [], exercises: [{ id: 'ex1', name: 'Squat' }], suggestedEdits: [], joinRequests: [], variations: {}, posts: {}, logs: {}, logCounts: {} });
  }
  // home()'s own fetches, reached only when tryBoot has no ?openLog= to act on (Test C/D use a
  // delayed/failing ME fetch but still land in tryBoot's normal home() path once ME resolves).
  if (/^\/api\/sessions$/.test(url)) return jsonRes([]);
  if (/^\/api\/feed$/.test(url)) return jsonRes([]);
  if (/^\/api\/friends$/.test(url)) return jsonRes({ friends: [], incoming: [], outgoing: [], followRequests: [] });
  if (/^\/api\/progress/.test(url)) return jsonRes({ ready: [], soon: [], holds: [], weeks: [], prs: [] });
  return jsonRes({});
}

let swMessageListeners = [];
function freshCtx({ token }) {
  alertCalls = []; sessionFetchCalls = [];
  const historyStub = { pushState() {}, replaceState() {}, go() {}, length: 1 };
  swMessageListeners = [];
  const ctx = {
    console: { log() {}, warn() {}, error() {} }, document: doc,
    localStorage: { getItem: (k) => k === 'crewfit_token' ? (token || null) : null, setItem() {}, removeItem() {} },
    fetch: mockFetch,
    location: { href: '/', pathname: '/', search: '', hash: '' },
    history: historyStub,
    addEventListener() {}, removeEventListener() {}, scrollTo() {},
    navigator: {
      userAgent: 'node', onLine: true,
      serviceWorker: {
        register: () => Promise.resolve(),
        addEventListener: (type, fn) => { if (type === 'message') swMessageListeners.push(fn); },
        removeEventListener() {},
      },
    },
    setTimeout, clearTimeout, setInterval, clearInterval,
    alert(msg) { alertCalls.push(msg); }, confirm: () => true, prompt: () => null,
    requestAnimationFrame: f => setTimeout(f, 0), matchMedia: () => ({ matches: false, addEventListener() {} }),
    FileReader: function () {}, Image: function () {}, URL, Blob: function () {}, FormData: function () {},
    IntersectionObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
    ResizeObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
  };
  ctx.window = ctx; ctx.globalThis = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  return ctx;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- Test A: dead deep link (?openLog=badsid:ex1) via tryBoot -- must alert exactly ONCE ----
{
  profileMeDelayMs = 0;
  const ctx = freshCtx({ token: 'tok' });
  ctx.location.search = '?openLog=badsid:ex1';
  vm.runInContext(SRC, ctx, { filename: 'public/app.js' });
  await vm.runInContext('BOOT_DONE', ctx);
  ok(alertCalls.length === 1, `tryBoot dead-link fires exactly one alert (got ${alertCalls.length}: ${JSON.stringify(alertCalls)})`);
  ok(sessionFetchCalls.length === 1, `only openSession's fetch ran (got ${sessionFetchCalls.length} session fetches: ${JSON.stringify(sessionFetchCalls)})`);
}

// ---- Test B: live deep link (?openLog=goodsid:ex1) via tryBoot -- must proceed normally ----
{
  profileMeDelayMs = 0;
  const ctx = freshCtx({ token: 'tok' });
  ctx.location.search = '?openLog=goodsid:ex1';
  vm.runInContext(SRC, ctx, { filename: 'public/app.js' });
  await vm.runInContext('BOOT_DONE', ctx);
  ok(alertCalls.length === 0, `tryBoot live-link fires no alert (got ${alertCalls.length}: ${JSON.stringify(alertCalls)})`);
  // v312: the log sheet is gone -- the deep link opens the session (one fetch) and then just
  // scrolls to / focuses that exercise's inline card (focusLogBlock, no fetch of its own).
  ok(sessionFetchCalls.length === 1, `openSession fetched goodsid once and focusLogBlock needed no fetch (got ${sessionFetchCalls.length}: ${JSON.stringify(sessionFetchCalls)})`);
}

// ---- Test C: message listener race -- postMessage arrives BEFORE BOOT_DONE resolves ----
{
  profileMeDelayMs = 40; // hold the ME-fetch open so we have a real window to fire into
  const ctx = freshCtx({ token: 'tok' });
  vm.runInContext(SRC, ctx, { filename: 'public/app.js' });
  ok(swMessageListeners.length === 1, `message listener registered (got ${swMessageListeners.length})`);
  let threw = false;
  try {
    // Fire synchronously, well before the 40ms profile/me delay resolves.
    swMessageListeners[0]({ data: { type: 'openLog', sid: 'goodsid', exId: 'ex1' } });
  } catch (e) { threw = true; }
  ok(!threw, 'firing the message event before boot resolves does not throw synchronously');
  await sleep(5);
  ok(sessionFetchCalls.length === 0, `openSession has NOT run yet while ME is still null (got ${sessionFetchCalls.length} fetches)`);
  const meNow = vm.runInContext('ME', ctx);
  ok(meNow === null || meNow === undefined, 'ME is still unset during the race window (confirms this is a real race, not a no-op test)');
  await vm.runInContext('BOOT_DONE', ctx);
  await sleep(5); // let the now-unblocked listener's own awaits (openSession) settle
  const meAfter = vm.runInContext('ME', ctx);
  ok(meAfter && meAfter.id === 'me1', 'ME is populated once BOOT_DONE resolves');
  ok(sessionFetchCalls.length === 1, `deep link proceeds correctly once boot completes (got ${sessionFetchCalls.length} fetches, expected 1: openSession; v312 focusLogBlock fetches nothing)`);
  ok(alertCalls.length === 0, `no alert fired for the delayed-but-valid deep link (got ${JSON.stringify(alertCalls)})`);
}

// ---- Test D: message listener race, but boot NEVER resolves ME (failed auth) -- must not crash, must not fetch ----
{
  profileMeDelayMs = 0;
  const ctx = freshCtx({ token: 'tok' });
  // Force /api/profile/me to fail for this one context.
  ctx.fetch = (url) => /^\/api\/profile\/me/.test(url) ? Promise.reject(new Error('network down')) : mockFetch(url);
  vm.runInContext(SRC, ctx, { filename: 'public/app.js' });
  let threw = false;
  try { swMessageListeners[0]({ data: { type: 'openLog', sid: 'goodsid', exId: 'ex1' } }); } catch (e) { threw = true; }
  ok(!threw, 'firing the message event when boot will fail does not throw synchronously');
  await vm.runInContext('BOOT_DONE', ctx).catch(() => {});
  await sleep(5);
  const meAfter = vm.runInContext('ME', ctx);
  // H._req's own .catch turns a rejected fetch into {error:'Network error'} rather than throwing
  // (see H._req in app.js) -- so ME ends up truthy-but-id-less here, not null. The guard the fix
  // actually added checks !ME || !ME.id, which this still exercises correctly.
  ok(!meAfter || !meAfter.id, `ME has no usable id after a failed boot (got ${JSON.stringify(meAfter)})`);
  ok(sessionFetchCalls.length === 0, `openSession never ran for a boot that failed to establish ME (got ${sessionFetchCalls.length})`);
}

console.log(fails === 0 ? '\nall assertions passed' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
