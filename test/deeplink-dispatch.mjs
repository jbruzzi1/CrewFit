// Sep 8 2026 (Jeff, lock-screen screenshot: "when I click on a push notification it should open
// to where the notification happened... currently it just opens to where I was last"). server.js's
// notify() now tags most payloads with `link: {type, ...ids}` (see the long comment above notify()
// in server.js), and public/sw.js's notificationclick generalizes to a `data.link` case alongside
// its pre-existing sid/exId one (see that file's own comment, and test/lockscreen-deeplink-guard.mjs
// for the sid/exId coverage, which this file deliberately does not duplicate).
//
// This is the client-side coverage for the NEW half: openDeepLink()'s dispatch table, tryBoot()'s
// `?dl=` query-string parsing (the no-open-tab path), and the serviceWorker 'message' listener's
// 'deepLink' case (the already-open-tab path). Same node:vm harness family as
// test/lockscreen-deeplink-guard.mjs -- context creation is kept separate from script loading (as
// there, `?dl=`/`?openLog=` must be set on ctx.location BEFORE app.js's boot code runs, since
// tryBoot() reads it once at load time) -- but here the four real nav functions (openSession/
// viewPost/profileView/crewView/renderNotifications) are additionally stubbed AFTER loading app.js,
// proven safe by a quick standalone check: top-level `function` declarations in a vm Script context
// are just properties of the context's global object, so reassigning e.g. ctx.openSession changes
// what openDeepLink's plain `openSession(...)` call resolves to for the rest of that same script.
// This isolates openDeepLink's OWN dispatch logic (right type -> right function, right args,
// missing ids -> no call) from whether openSession/viewPost/profileView/crewView themselves work,
// which is already covered elsewhere (openSession heavily in lockscreen-deeplink-guard.mjs and
// audit-v254-nav.mjs; the other three by their own screens' tests) -- re-proving all four here
// would be redundant, not more thorough.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };

const SRC = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

function makeEl(tag) {
  const el = {
    tagName: tag || 'DIV', className: '', style: {}, innerHTML: '',
    parentNode: null, _children: [], _removed: false,
    appendChild(child) { child.parentNode = el; el._children.push(child); return child; },
    remove() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener() {}, setAttribute() {}, getAttribute() { return null; },
  };
  el.classList = { add() {}, remove() {}, contains: () => false };
  return el;
}
const genericEl = () => new Proxy(function () {}, {
  get: (t, k) => k === 'children' || k === 'childNodes' ? [] : (k === 'innerText' || k === 'value' || k === 'textContent') ? '' : genericEl(),
  set: () => true, apply: () => genericEl(), has: () => true,
});
function makeDoc() {
  const body = makeEl('BODY');
  return {
    body, createElement: () => makeEl('DIV'), getElementById: () => genericEl(),
    querySelector: () => genericEl(), querySelectorAll: () => [],
    addEventListener() {}, documentElement: genericEl(), head: genericEl(), cookie: '', readyState: 'complete',
  };
}

function jsonRes(v) { return Promise.resolve({ json: () => Promise.resolve(v), ok: true, status: 200, text: () => Promise.resolve('') }); }
function mockFetch(url) {
  if (/^\/api\/profile\/me/.test(url)) return jsonRes({ id: 'me1', displayName: 'Test User' });
  if (/^\/api\/sessions$/.test(url)) return jsonRes([]);
  if (/^\/api\/feed$/.test(url)) return jsonRes([]);
  if (/^\/api\/friends$/.test(url)) return jsonRes({ friends: [], incoming: [], outgoing: [], followRequests: [] });
  if (/^\/api\/progress/.test(url)) return jsonRes({ ready: [], soon: [], holds: [], weeks: [], prs: [] });
  return jsonRes({});
}

// Creates the context ONLY -- does NOT run app.js yet, so callers can set ctx.location.search
// (?dl=/?openLog=) first when that matters, same reasoning as lockscreen-deeplink-guard.mjs.
let swMessageListeners, calls;
function freshCtx() {
  calls = { openSession: [], openSessionChat: [], viewPost: [], profileView: [], crewView: [], openCrewChat: [], renderNotifications: [] };
  swMessageListeners = [];
  const historyStub = { pushState() {}, replaceState() {}, go() {}, length: 1 };
  const ctx = {
    console: { log() {}, warn() {}, error() {} }, document: makeDoc(),
    localStorage: { getItem: (k) => k === 'crewfit_token' ? 'tok' : null, setItem() {}, removeItem() {} },
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
    alert() {}, confirm: () => true, prompt: () => null,
    requestAnimationFrame: f => setTimeout(f, 0), matchMedia: () => ({ matches: false, addEventListener() {} }),
    FileReader: function () {}, Image: function () {}, URL, Blob: function () {}, FormData: function () {},
    IntersectionObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
    ResizeObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
  };
  ctx.window = ctx; ctx.globalThis = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  return ctx;
}
// Loads app.js into an already-created ctx, then immediately (before any microtask can run, i.e.
// before app.js's own top-level boot code gets past its first await) stubs the four real nav
// destinations -- so the override is in place before tryBoot()/the boot IIFE ever reaches a point
// where it might call one of them.
function load(ctx) {
  vm.runInContext(SRC, ctx, { filename: 'public/app.js' });
  ctx.openSession = (...a) => { calls.openSession.push(a); return Promise.resolve(true); };
  ctx.openSessionChat = (...a) => { calls.openSessionChat.push(a); return Promise.resolve(true); };
  ctx.viewPost = (...a) => { calls.viewPost.push(a); return Promise.resolve(true); };
  ctx.profileView = (...a) => { calls.profileView.push(a); return Promise.resolve(true); };
  ctx.crewView = (...a) => { calls.crewView.push(a); return Promise.resolve(true); };
  ctx.openCrewChat = (...a) => { calls.openCrewChat.push(a); return Promise.resolve(true); };
  ctx.renderNotifications = (...a) => { calls.renderNotifications.push(a); return Promise.resolve(true); };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

console.log('openDeepLink() dispatch table -- right type routes to the right screen with the right ids');
{
  const cases = [
    { link: { type: 'session', sessionId: 's1' }, fn: 'openSession', args: ['s1'] },
    // Sep 8 2026: 'session-chat'/'crew-chat' -- a comment notification lands scrolled to the
    // actual messages (openSessionChat/openCrewChat), distinct from plain 'session'/'crew' above
    // and below, which land at the top of the page (used for swap/join/invite outcomes and
    // "added you to the crew" respectively).
    { link: { type: 'session-chat', sessionId: 's1' }, fn: 'openSessionChat', args: ['s1'] },
    { link: { type: 'post', sessionId: 's1', authorId: 'u1' }, fn: 'viewPost', args: ['s1', 'u1'] },
    { link: { type: 'profile', userId: 'u1' }, fn: 'profileView', args: ['u1'] },
    { link: { type: 'crew', crewId: 'c1' }, fn: 'crewView', args: ['c1'] },
    { link: { type: 'crew-chat', crewId: 'c1' }, fn: 'openCrewChat', args: ['c1'] },
    { link: { type: 'notifications' }, fn: 'renderNotifications', args: [] },
  ];
  for (const c of cases) {
    const ctx = freshCtx();
    load(ctx);
    const result = await vm.runInContext(`openDeepLink(${JSON.stringify(c.link)})`, ctx);
    ok(result === true, `${c.link.type}: openDeepLink resolves true (got ${result})`);
    ok(calls[c.fn].length === 1, `${c.link.type}: ${c.fn}() was called exactly once (got ${calls[c.fn].length})`);
    ok(JSON.stringify(calls[c.fn][0]) === JSON.stringify(c.args), `${c.link.type}: ${c.fn}() was called with the right args (got ${JSON.stringify(calls[c.fn][0])}, expected ${JSON.stringify(c.args)})`);
    // every OTHER destination must be left untouched -- a link tagged 'session' must never also
    // poke viewPost/profileView/crewView/renderNotifications.
    const others = Object.keys(calls).filter(k => k !== c.fn);
    ok(others.every(k => calls[k].length === 0), `${c.link.type}: no other destination fired (got ${JSON.stringify(calls)})`);
  }
}

console.log('\nopenDeepLink() fails open (returns false, calls nothing) for bad or incomplete input');
{
  const badInputs = [
    null, undefined, 'a string', 42, {},
    { type: 'session' }, // missing sessionId
    { type: 'session-chat' }, // missing sessionId
    { type: 'post', sessionId: 's1' }, // missing authorId
    { type: 'profile' }, // missing userId
    { type: 'crew' }, // missing crewId
    { type: 'crew-chat' }, // missing crewId
    { sessionId: 's1' }, // missing type entirely
    { type: 'teleport', sessionId: 's1' }, // unrecognized type
  ];
  for (const bad of badInputs) {
    const ctx = freshCtx();
    load(ctx);
    const result = await vm.runInContext(`openDeepLink(${JSON.stringify(bad)})`, ctx);
    ok(result === false, `openDeepLink(${JSON.stringify(bad)}) returns false (got ${result})`);
    const anyCalled = Object.values(calls).some(a => a.length > 0);
    ok(!anyCalled, `openDeepLink(${JSON.stringify(bad)}) dispatched to nothing (got ${JSON.stringify(calls)})`);
  }
}

console.log('\ntryBoot()\'s ?dl= query string -- the no-open-tab path (a fresh launch from tapping a push)');
{
  const ctx = freshCtx();
  ctx.location.search = '?dl=' + encodeURIComponent(JSON.stringify({ type: 'crew', crewId: 'crew_abc' }));
  load(ctx);
  await vm.runInContext('BOOT_DONE', ctx);
  ok(calls.crewView.length === 1 && calls.crewView[0][0] === 'crew_abc', `?dl= boots straight into crewView('crew_abc') (got ${JSON.stringify(calls.crewView)})`);
  ok(calls.openSession.length === 0 && calls.viewPost.length === 0 && calls.profileView.length === 0,
    'and no other destination fired');
}

console.log('\ntryBoot()\'s ?dl= with a malformed/undecodable payload -- must not throw, falls through to home()');
{
  const ctx = freshCtx();
  ctx.location.search = '?dl=%7Bnot-valid-json';
  let threw = false;
  try {
    load(ctx);
    await vm.runInContext('BOOT_DONE', ctx);
  } catch (e) { threw = true; }
  ok(!threw, 'a malformed ?dl= payload does not throw during boot');
  const anyDeepLinkCalled = calls.viewPost.length + calls.profileView.length + calls.crewView.length + calls.renderNotifications.length;
  ok(anyDeepLinkCalled === 0, `and nothing was dispatched for it (got ${JSON.stringify(calls)})`);
}

console.log('\n?openLog= (the pre-existing case) still takes priority and is untouched by ?dl= being added alongside it');
{
  // tryBoot checks openLog first and returns before ever looking at dl -- confirms the two query
  // params were composed additively (an `if / return` followed by a second `if`), not by
  // accidentally replacing one branch with the other.
  const ctx = freshCtx();
  ctx.location.search = '?openLog=badsid:ex1&dl=' + encodeURIComponent(JSON.stringify({ type: 'crew', crewId: 'crew_abc' }));
  load(ctx);
  await vm.runInContext('BOOT_DONE', ctx);
  ok(calls.openSession.length === 1 && calls.openSession[0][0] === 'badsid', `?openLog= still runs openSession('badsid') (got ${JSON.stringify(calls.openSession)})`);
  ok(calls.crewView.length === 0, `and ?dl= is never reached once ?openLog= handled the boot (got ${JSON.stringify(calls.crewView)})`);
}

console.log('\nthe serviceWorker \'message\' listener\'s \'deepLink\' case -- the already-open-tab path');
{
  const ctx = freshCtx();
  load(ctx);
  ok(swMessageListeners.length === 1, `message listener registered (got ${swMessageListeners.length})`);
  await vm.runInContext('BOOT_DONE', ctx);
  let threw = false;
  try { swMessageListeners[0]({ data: { type: 'deepLink', link: { type: 'profile', userId: 'u_xyz' } } }); } catch (e) { threw = true; }
  ok(!threw, 'firing a deepLink postMessage does not throw');
  await sleep(5);
  ok(calls.profileView.length === 1 && calls.profileView[0][0] === 'u_xyz', `dispatches to profileView('u_xyz') (got ${JSON.stringify(calls.profileView)})`);
}

console.log('\nthe \'deepLink\' postMessage case respects the same BOOT_DONE/ME race guard as \'openLog\' (audit-v254-nav.mjs\'s original fix)');
{
  const ctx = freshCtx();
  // Force /api/profile/me to fail for this context, same shape as lockscreen-deeplink-guard.mjs's
  // Test D -- boot never establishes ME, so the listener must not dispatch at all.
  ctx.fetch = (url) => /^\/api\/profile\/me/.test(url) ? Promise.reject(new Error('network down')) : mockFetch(url);
  load(ctx);
  let threw = false;
  try { swMessageListeners[0]({ data: { type: 'deepLink', link: { type: 'profile', userId: 'u_xyz' } } }); } catch (e) { threw = true; }
  ok(!threw, 'firing the message event when boot will fail does not throw synchronously');
  await vm.runInContext('BOOT_DONE', ctx).catch(() => {});
  await sleep(5);
  ok(calls.profileView.length === 0, `profileView never ran for a boot that failed to establish ME (got ${calls.profileView.length})`);
}

console.log(fails === 0 ? '\nall assertions passed' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
