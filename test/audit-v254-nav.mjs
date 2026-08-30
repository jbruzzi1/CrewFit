// v254 (Jeff): "when I press the back button I want it to bring me to the page I was just on. It
// brings you back to the home screen." and "When you click on a page it doesn't bring you to the
// top of the page. It sometimes starts in the middle or at certain spots."
//
// Two fixes, sharing one mechanism (see the "---- Nav / browser Back ----" block in app.js):
//   1. navigated(state)/landOn(state) reset scroll to the top; navigated() also pushes a History
//      API entry, landOn() doesn't (used when popstate already moved the pointer). Every render
//      function that can be reached both as a genuine navigation AND as a same-screen quiet
//      refresh (openSession, viewPost, profileView, friends, library, libOpenMuscle, followList,
//      progressScreen, home) takes an opts.silent/opts.fromHistory pair and must call the right
//      one of navigated()/landOn()/neither.
//   2. openSheetHtml() pushes a {t:'sheet'} entry so the hardware/gesture Back button dismisses a
//      sheet instead of leaving the app; closeSheet()/dismissConfirm() replace that entry with the
//      real underlying screen when the LAST sheet closes via its own UI (not via popstate, which
//      already moved the pointer itself).
//
// This drives the REAL navigated/landOn/openSheetHtml/closeSheet/dismissConfirm/confirmSheet/
// tryBoot/friends/library/libOpenMuscle out of the real public/app.js via node:vm, same harness
// family as test/confirm-sheet-stack.mjs / test/sheet-stacking.mjs / test/stale-save-race.mjs.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };

const SRC = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

function makeEl(tag) {
  const el = {
    tagName: tag || 'DIV', className: '', style: {}, innerHTML: '',
    parentNode: null, _children: [], _removed: false,
    _classes: new Set(),
    appendChild(child) { child.parentNode = el; el._children.push(child); return child; },
    remove() { el._removed = true; if (el.parentNode) el.parentNode._children = el.parentNode._children.filter(c => c !== el); },
    querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener() {}, setAttribute() {}, getAttribute() { return null; },
  };
  el.classList = {
    add: (...c) => c.forEach(x => el._classes.add(x)),
    remove: (...c) => c.forEach(x => el._classes.delete(x)),
    contains: c => el._classes.has(c),
  };
  return el;
}
const body = makeEl('BODY');
const genericEl = () => new Proxy(function () {}, {
  get: (t, k) => k === 'children' || k === 'childNodes' ? [] : (k === 'innerText' || k === 'value' || k === 'textContent') ? '' : genericEl(),
  set: () => true, apply: () => genericEl(), has: () => true,
});
const doc = {
  body,
  createElement: () => makeEl('DIV'),
  getElementById: () => genericEl(),
  querySelector: (sel) => sel === '.nav button.active' ? { dataset: { tab: 'me' } }
    : sel === '.sheet-back' ? (body._children.filter(c => c.className === 'sheet-back').at(-1) || null) : genericEl(),
  querySelectorAll: (sel) => sel === '.sheet-back' ? body._children.filter(c => c.className === 'sheet-back')
    : sel === '.nav button' ? [] : [],
  addEventListener() {}, documentElement: genericEl(), head: genericEl(), cookie: '', readyState: 'complete',
};
// Real, inspectable History API stand-in -- the whole point of this file is checking WHAT gets
// pushed/replaced and WHEN, not just that nothing throws.
const historyLog = [];
// v254 Finding-4 fix: backToSessionAfterSwapPicker() pops however many entries browsing inside
// the swap picker actually pushed (history.go(-delta), computed from history.length), rather than
// assuming exactly one -- so this stub tracks a real, running length, like an actual browser's
// history.length does across the whole test file (reset() below only clears the per-block LOG,
// not this counter).
let historyLength = 1;
const historyStub = {
  pushState(state) { historyLog.push({ op: 'push', state }); historyLength++; },
  replaceState(state) { historyLog.push({ op: 'replace', state }); },
  go(n) { historyLog.push({ op: 'go', n }); historyLength = Math.max(1, historyLength + n); },
  get length() { return historyLength; },
};
let scrollToCalls = 0;
// popstate listeners land here so the test can fire them manually -- vm.runInContext's
// window === ctx, so window.addEventListener('popstate', ...) at app.js's top level calls this.
const popstateListeners = [];
function mockFetch(url) {
  // Minimal-but-valid fixtures, just enough for each render function below to reach its own
  // $('app').innerHTML=/navigated()/landOn() call without throwing on a missing field.
  if (/^\/api\/friends$/.test(url)) return jsonRes({ friends: [], incoming: [], outgoing: [], followRequests: [] });
  if (/^\/api\/exercises$/.test(url)) return jsonRes([]);
  if (/^\/api\/profile\/[^/]+\/(followers|following)$/.test(url)) return jsonRes([]);
  if (/^\/api\/sessions$/.test(url)) return jsonRes([]);
  if (/^\/api\/feed$/.test(url)) return jsonRes([]);
  if (/^\/api\/progress/.test(url)) return jsonRes({ ready: [], soon: [], holds: [], weeks: [], prs: [] });
  return jsonRes({});
}
function jsonRes(v) { return Promise.resolve({ json: () => Promise.resolve(v), ok: true, status: 200, text: () => Promise.resolve('') }); }
const ctx = {
  console: { log() {}, warn() {}, error() {} }, document: doc,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  fetch: mockFetch,
  location: { href: '/', pathname: '/', search: '', hash: '' },
  history: historyStub,
  addEventListener(type, fn) { if (type === 'popstate') popstateListeners.push(fn); },
  removeEventListener() {},
  scrollTo() { scrollToCalls++; },
  navigator: { userAgent: 'node', serviceWorker: { register: () => Promise.resolve() }, onLine: true },
  setTimeout, clearTimeout, setInterval, clearInterval, alert() {}, confirm: () => true, prompt: () => null,
  requestAnimationFrame: f => setTimeout(f, 0), matchMedia: () => ({ matches: false, addEventListener() {} }),
  FileReader: function () {}, Image: function () {}, URL, Blob: function () {}, FormData: function () {},
  IntersectionObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
  ResizeObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
};
ctx.window = ctx; ctx.globalThis = ctx; ctx.self = ctx;
vm.createContext(ctx);
vm.runInContext(SRC, ctx, { filename: 'public/app.js' });
vm.runInContext(`ME = { id: 'me1', displayName: 'Test User', username: 'testuser' };`, ctx);

const navigated = vm.runInContext('navigated', ctx);
const landOn = vm.runInContext('landOn', ctx);
const openSheetHtml = vm.runInContext('openSheetHtml', ctx);
const closeSheet = vm.runInContext('closeSheet', ctx);
const confirmSheet = vm.runInContext('confirmSheet', ctx);
const dismissConfirm = vm.runInContext('dismissConfirm', ctx);
const friends = vm.runInContext('friends', ctx);
const library = vm.runInContext('library', ctx);
const tryBoot = vm.runInContext('tryBoot', ctx);
const home = vm.runInContext('home', ctx);
const swapCancel = vm.runInContext('swapCancel', ctx);
const openSwapPicker = vm.runInContext('openSwapPicker', ctx);
const libOpenMuscle = vm.runInContext('libOpenMuscle', ctx);
const reset = () => { historyLog.length = 0; scrollToCalls = 0; };

console.log('navigated()/landOn(): the shared primitive both fixes are built on');
{
  reset();
  navigated({ t: 'tab', tab: 'progress' });
  ok(scrollToCalls === 1, `navigated() resets scroll (got ${scrollToCalls} scrollTo calls)`);
  ok(historyLog.length === 1 && historyLog[0].op === 'push' && historyLog[0].state.tab === 'progress',
    `navigated() pushes a new entry (got ${JSON.stringify(historyLog)})`);

  reset();
  landOn({ t: 'tab', tab: 'progress' });
  ok(scrollToCalls === 1, `landOn() also resets scroll (got ${scrollToCalls})`);
  ok(historyLog.length === 0, `landOn() does NOT push -- popstate already moved the pointer (got ${JSON.stringify(historyLog)})`);
}

console.log('\nfriends()/library(): opts.silent must suppress scroll reset (same-screen quiet refresh)');
{
  reset();
  await friends();
  ok(scrollToCalls === 1, `friends() with no opts scrolls to top like any genuine nav (got ${scrollToCalls})`);

  reset();
  await friends({ silent: true });
  ok(scrollToCalls === 0, `friends({silent:true}) (acceptRequest/rejectRequest/acceptFollow/rejectFollow's same-screen refresh) does NOT scroll (got ${scrollToCalls})`);

  reset();
  await library();
  ok(scrollToCalls === 1 && historyLog.length === 1 && historyLog[0].op === 'push' && historyLog[0].state.t === 'library',
    `library() with no opts (the "‹ All muscles" drill-back) pushes {t:'library'} and scrolls (got scrollTo=${scrollToCalls}, history=${JSON.stringify(historyLog)})`);

  reset();
  await library({ silent: true });
  ok(scrollToCalls === 0 && historyLog.length === 0,
    `library({silent:true}) (showTab/renderTabState's tab-root call, and submitCreateEx's refresh) pushes nothing and does not scroll (got scrollTo=${scrollToCalls}, history=${JSON.stringify(historyLog)})`);

  reset();
  await library({ fromHistory: true });
  ok(scrollToCalls === 1 && historyLog.length === 0,
    `library({fromHistory:true}) (popstate restoring a {t:'library'} entry) scrolls but does NOT push again (got scrollTo=${scrollToCalls}, history=${JSON.stringify(historyLog)})`);
}

console.log("\nhome(): opts.silent must suppress scroll reset too (declineInvite's same-screen refresh)");
{
  reset();
  await home();
  ok(scrollToCalls === 1, `home() with no opts (tab tap, boot, Cancel-from-create-flow, etc.) scrolls to top (got ${scrollToCalls})`);

  reset();
  await home({ silent: true });
  ok(scrollToCalls === 0, `home({silent:true}) (declineInvite dismissing a banner while still on Home) does NOT scroll (got ${scrollToCalls})`);
}

console.log('\nopenSheetHtml()/closeSheet(): a sheet pushes its own entry; closing it collapses that entry back to the real screen');
{
  reset();
  body._children.length = 0;
  vm.runInContext(`CURRENT_NAV_STATE = {t:'tab', tab:'home'};`, ctx);

  openSheetHtml('<div class="sheet">hi</div>');
  ok(historyLog.length === 1 && historyLog[0].op === 'push' && historyLog[0].state.t === 'sheet',
    `opening a sheet pushes {t:'sheet'} (got ${JSON.stringify(historyLog)})`);

  reset();
  closeSheet(); // closed via its own UI (✕ / backdrop), not popstate
  ok(historyLog.length === 1 && historyLog[0].op === 'replace' && historyLog[0].state.t === 'tab' && historyLog[0].state.tab === 'home',
    `closing the ONLY open sheet via its own UI replaces the entry with CURRENT_NAV_STATE, not push (got ${JSON.stringify(historyLog)})`);

  console.log('  (a Back press after that closeSheet() must not need an extra press to leave -- proven by there being no leftover {t:\'sheet\'} entry above)');

  reset();
  body._children.length = 0;
  openSheetHtml('<div class="sheet">one</div>');
  openSheetHtml('<div class="sheet">two (stacked)</div>');
  reset();
  closeSheet(); // closes the TOP sheet of a 2-deep stack via its own UI
  ok(historyLog.length === 0,
    `closing one sheet out of a still-stacked pair leaves history alone -- the sheet beneath is still open and still needs its own Back press (got ${JSON.stringify(historyLog)})`);

  reset();
  body._children.length = 1; // simulate: only the bottom sheet remains
  closeSheet();
  ok(historyLog.length === 1 && historyLog[0].op === 'replace',
    `closing the LAST remaining sheet of what was a stack DOES collapse the entry (got ${JSON.stringify(historyLog)})`);

  reset();
  body._children.length = 1;
  closeSheet(true); // fromPopstate=true -- the browser already moved the pointer, must not touch history
  ok(historyLog.length === 0,
    `closeSheet(true) (called from the popstate handler) never touches history itself (got ${JSON.stringify(historyLog)})`);
}

console.log('\nconfirmSheet()/dismissConfirm(): closes CONFIRM_EL directly (not via closeSheet, see its own comment) but must do the identical history fixup');
{
  reset();
  body._children.length = 0;
  vm.runInContext(`CURRENT_NAV_STATE = {t:'tab', tab:'friends'};`, ctx);

  confirmSheet('Delete?', '', 'Delete', () => {});
  ok(historyLog.length === 1 && historyLog[0].op === 'push' && historyLog[0].state.t === 'sheet',
    `confirmSheet() opens via openSheetHtml, so it also pushes {t:'sheet'} (got ${JSON.stringify(historyLog)})`);

  reset();
  dismissConfirm();
  ok(historyLog.length === 1 && historyLog[0].op === 'replace' && historyLog[0].state.tab === 'friends',
    `dismissConfirm() on the only open sheet replaces the entry with CURRENT_NAV_STATE (got ${JSON.stringify(historyLog)})`);

  console.log('\n  the v250 double-tap case: a second confirmSheet() while one is already open removes the old one immediately (no fade) -- must not leave two stacked {t:\'sheet\'} entries for one visible sheet');
  reset();
  body._children.length = 0;
  confirmSheet('Delete workout?', '', 'Delete', () => {});
  reset();
  confirmSheet('Delete workout?', '', 'Delete', () => {}); // accidental double-tap
  const pushes = historyLog.filter(h => h.op === 'push');
  const replaces = historyLog.filter(h => h.op === 'replace');
  ok(pushes.length === 1 && replaces.length === 1,
    `the double-tap replaces the first sheet's stale entry before pushing the second's (got ${JSON.stringify(historyLog)})`);
  ok(body._children.length === 1, `and still only one confirm sheet physically exists (got ${body._children.length})`);
}

console.log('\nthe popstate listener: dismisses a topmost sheet WITHOUT touching the screen underneath; otherwise restores nav state');
{
  ok(popstateListeners.length === 1, `exactly one popstate listener was registered at load (got ${popstateListeners.length})`);
  const onPopstate = popstateListeners[0];

  reset();
  body._children.length = 0;
  openSheetHtml('<div class="sheet">x</div>');
  reset();
  onPopstate({ state: { t: 'tab', tab: 'me' } }); // the browser already walked back past the sheet's entry
  ok(historyLog.length === 0, `a sheet-open popstate calls closeSheet(true), which itself never touches history (got ${JSON.stringify(historyLog)})`);
  ok(scrollToCalls === 0, `and does not scroll/re-render the screen underneath -- it was already correct (got ${scrollToCalls})`);

  reset();
  body._children.length = 0; // no sheet open
  // t:'tab' entries get their landOn() call synchronously from popToNavState itself (not from
  // inside the async tab-render function), so this assertion doesn't need to wait on a fetch.
  onPopstate({ state: { t: 'tab', tab: 'progress' } });
  ok(scrollToCalls === 1 && historyLog.length === 0,
    `a plain popstate with no sheet open restores the target state via landOn (scrolls, does not push) (got scrollTo=${scrollToCalls}, history=${JSON.stringify(historyLog)})`);

  reset();
  body._children.length = 0;
  onPopstate({ state: null }); // an old/bare entry (e.g. the initial page load, before v254's replaceState existed)
  ok(scrollToCalls === 1, `a null/missing state (old entry predating this fix) falls back to Home rather than stranding the user (got ${scrollToCalls} scrollTo calls)`);
}

console.log("\ntryBoot(): establishes a baseline history entry so the FIRST real navigation's Back doesn't fall off into nothing");
{
  reset();
  vm.runInContext(`TOKEN = 'tok'; ME = null;`, ctx);
  // H.get('/api/profile/me...') below resolves via the generic mockFetch -> {} (no .id), so ME
  // stays null and tryBoot falls into its retry/login branches -- NOT the baseline-establishing
  // success branch. Only the success branch (a real ME.id) is what this test is about.
  vm.runInContext(`window.__origFetch = fetch; fetch = (url) => url.includes('/api/profile/me') ? Promise.resolve({ json: () => Promise.resolve({id:'me1'}), ok:true, status:200, text:()=>Promise.resolve('') }) : window.__origFetch(url);`, ctx);
  await tryBoot();
  ok(historyLog.length === 1 && historyLog[0].op === 'replace' && historyLog[0].state.t === 'tab' && historyLog[0].state.tab === 'home',
    `a successful boot replaceState's a {t:'tab',tab:'home'} baseline entry, not push (got ${JSON.stringify(historyLog)})`);
  const navState = vm.runInContext('CURRENT_NAV_STATE', ctx);
  ok(navState && navState.t === 'tab' && navState.tab === 'home', `and CURRENT_NAV_STATE agrees (got ${JSON.stringify(navState)})`);
}

console.log("\nswapCancel(): undoes however many entries the swap-picker excursion actually pushed, by POPPING them, not by pushing/replacing a duplicate");
{
  // openSwapPicker() reaches the library via showTab('lib', true), which pushes one entry on top
  // of whatever the session's own entry already was. A fix that instead does
  // history.replaceState({t:'session',id}, ...) leaves TWO CONSECUTIVE, identical {t:'session',id}
  // entries (the session's original push, plus the replaced one) -- live-verified broken via
  // Playwright: one Back press after swapCancel() only walked from the duplicate to the original,
  // still landing on the session, needing a SECOND press to actually leave.
  reset();
  openSwapPicker('s1', 'e1');
  reset();
  swapCancel();
  ok(historyLog.length === 1 && historyLog[0].op === 'go' && historyLog[0].n === -1,
    `cancelling from the picker's ROOT screen pops exactly the 1 entry showTab pushed (got ${JSON.stringify(historyLog)})`);
  const swapMode = vm.runInContext('SWAP_MODE', ctx);
  const swapSession = vm.runInContext('SWAP_SESSION', ctx);
  ok(swapMode === false && swapSession === null, `and clears SWAP_MODE/SWAP_SESSION (got ${swapMode}, ${swapSession})`);

  // Cold-review catch: the picker's root only shows muscle-group TILES, not a flat exercise list
  // (see renderLibGroups) -- drilling into one via libOpenMuscle('chest') is indistinguishable
  // from a genuine library navigation, so it pushes a SECOND {t:'muscle',m} entry on top of the
  // picker's own. A bare history.back() (an earlier version of this fix) only popped that second
  // entry, landing back on the picker's ROOT instead of the session -- the exact "needs a second
  // Back press" bug this function exists to eliminate, just one level deeper. Popping however many
  // entries were actually pushed (tracked via SWAP_ENTRY_HISTORY_LEN / history.length) fixes it at
  // any depth.
  reset();
  openSwapPicker('s1', 'e1');
  await new Promise(r => setTimeout(r, 0)); // let library()'s H.get('/api/exercises') resolve so window._LIB2 exists
  libOpenMuscle('chest');
  reset();
  swapCancel();
  ok(historyLog.length === 1 && historyLog[0].op === 'go' && historyLog[0].n === -2,
    `cancelling after drilling into a muscle group pops BOTH entries pushed since the picker opened (got ${JSON.stringify(historyLog)})`);
}

console.log("\nin-page '← Back' buttons use real history.back(), not a hardcoded or duplicate-pushing destination");
{
  // Jeff, Aug 30 (live on v254, after the popstate/history mechanism above already shipped):
  // "im on my profile then clicking on a workout then clicking back and its taking me to the home
  // page". Root cause: viewPost's own in-PAGE '← Back' button (independent of the hardware/
  // gesture Back button the rest of this file tests) was still hardcoded to onclick="showTab('home')"
  // -- a leftover from before this file's history mechanism existed, never touched by that work
  // because it doesn't go through popstate at all, it's a plain onclick. Same inspection turned up
  // two more of the same class: openSession's own header Back button used to compute a 'backTab'
  // guess from the currently-highlighted nav tab (closer, but still wrong for e.g. Friends tab ->
  // a friend's profile -> their workout -> Back, which landed on the Friends LIST, not the specific
  // profile you came from) and followList's Back button called profileView(id) directly, which
  // PUSHES a new entry rather than popping -- leaving a stale duplicate that made a hardware Back
  // press right after land back on the followers/following list instead of leaving the profile
  // (same duplicate-entry shape as the swapCancel bug above). All three now just call
  // history.back(), replaying the same real pop the hardware/gesture Back button already uses.
  const backButtonSites = [
    { label: 'openSession (session detail header)', re: /class="pp-head"><button class="sec sm" onclick="history\.back\(\)">.*\$\{sessDots\}/ },
    { label: 'viewPost (posted recap header)', re: /class="pp-head"><button class="sec sm" onclick="history\.back\(\)">.*\$\{dots\}/ },
    { label: 'followList (followers/following header)', re: /const backBtn = `<div class="pp-head"><button class="sec sm" onclick="history\.back\(\)">/ },
  ];
  for (const site of backButtonSites) {
    ok(site.re.test(SRC), `${site.label} Back button calls history.back()`);
  }
  ok(!/onclick="showTab\('home'\)">.{0,30}Back/.test(SRC),
    "no in-page Back button is hardcoded to showTab('home') anymore");
  ok(!/onclick="profileView\('\$\{id\}'\)">.{0,30}Back/.test(SRC),
    "no in-page Back button re-pushes a duplicate profileView(id) entry anymore");
}

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
