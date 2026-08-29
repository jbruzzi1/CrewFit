// v250 audit finding: editBio() and editDefaultGym() (public/app.js) both fire their real side
// effect -- reopening Settings, or a full navigate back to the profile via profileView() -- from
// an async .then() that resolves an arbitrary, network-latency-bound delay after Save was tapped,
// not the next tick. If the user has already moved on by the time a slow save resolves (opened a
// different sheet, switched tabs), the stale callback barged in anyway: reopening Settings on top
// of whatever they're now looking at, or for editBio, silently yanking them back to their own
// profile mid-task with zero warning -- a real navigation hijack, not just a stray overlay.
//
// The fix (UI_EPOCH, stillOnProfileWithNothingElseOpen) snapshots a sequence number when Save is
// tapped and only proceeds if nothing has opened a new sheet or switched tabs since -- same
// staleness principle openSession's own `silent` refresh already uses (SESSION_SILENT_SEQ /
// logSheetStillOpenFor).
//
// This drives the REAL editBio()/editDefaultGym()/showTab()/openSheetHtml() out of the real
// public/app.js via node:vm, with a controllable-delay fetch so the race can be reproduced
// deterministically instead of guessed at.
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
// The active nav tab is a real, mutable stub (not a shallow always-truthy Proxy) -- the fix reads
// it via document.querySelector('.nav button.active').dataset.tab, and the test needs to actually
// change it mid-scenario to simulate the user switching tabs.
const navState = { tab: 'me' };
const genericEl = () => new Proxy(function () {}, {
  get: (t, k) => k === 'children' || k === 'childNodes' ? [] : (k === 'innerText' || k === 'value' || k === 'textContent') ? '' : genericEl(),
  set: () => true, apply: () => genericEl(), has: () => true,
});
let profileViewCalls = 0, openSettingsRealCalls = 0;
const doc = {
  body,
  createElement: () => makeEl('DIV'),
  getElementById: (id) => id === 'teVal' ? { value: 'new value', focus() {} } : genericEl(),
  querySelector: (sel) => sel === '.nav button.active' ? { dataset: { tab: navState.tab } }
    : sel === '.sheet-back' ? (body._children.filter(c => c.className === 'sheet-back').at(-1) || null) : genericEl(),
  querySelectorAll: (sel) => sel === '.sheet-back' ? body._children.filter(c => c.className === 'sheet-back') : [],
  addEventListener() {}, documentElement: genericEl(), head: genericEl(), cookie: '', readyState: 'complete',
};
// The mock fetch is delay-controllable per call, keyed by URL, so the test can hold a save
// "in flight" while it simulates the user doing something else, then release it.
const pending = new Map(); // url -> {resolve}
function mockFetch(url, opts) {
  return new Promise(resolve => {
    pending.set(url, () => resolve({
      json: () => Promise.resolve(JSON.parse(opts.body)), ok: true, status: 200, text: () => Promise.resolve(''),
    }));
  });
}
const ctx = {
  console: { log() {}, warn() {}, error() {} }, document: doc,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  fetch: mockFetch,
  location: { href: '/', pathname: '/', search: '', hash: '' }, history: { replaceState() {}, pushState() {} },
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
vm.runInContext(`ME = { id:'u1', bio:'', defaultGym:'', units:'lb' };`, ctx);
// Stub out the real profileView/openSettings so this test only has to prove WHETHER they get
// called, not re-render their (unrelated) HTML -- exactly what the bug is about.
// The stub still bumps UI_EPOCH, mirroring the real profileView()'s own first statement (the
// v250 audit follow-up fix) -- this test is about whether the STALE-SAVE GUARD correctly reacts
// to that navigation, not about re-rendering profileView's real HTML.
vm.runInContext(`
  window._realOpenSettings = openSettings;
  window.profileView = (id) => { UI_EPOCH++; window.__profileViewCalls = (window.__profileViewCalls||0) + 1; };
  window.openSettings = (...a) => { window.__openSettingsCalls = (window.__openSettingsCalls||0) + 1; return window._realOpenSettings(...a); };
`, ctx);
const editBio = vm.runInContext('editBio', ctx);
const editDefaultGym = vm.runInContext('editDefaultGym', ctx);
const showTab = vm.runInContext('showTab', ctx);
const openSheetHtml = vm.runInContext('openSheetHtml', ctx);
const profileView = vm.runInContext('profileView', ctx);
const calls = () => ({
  profileView: vm.runInContext('window.__profileViewCalls || 0', ctx),
  openSettings: vm.runInContext('window.__openSettingsCalls || 0', ctx),
});

console.log('editDefaultGym: a slow save must NOT reopen Settings if the user already opened something else');
{
  navState.tab = 'me';
  editDefaultGym(); // opens the Default Gym text-entry sheet
  vm.runInContext(`_teConfirm()`, ctx); // taps Save -- closes the sheet, fires H.post, in flight now

  // user gets impatient and opens Weight units before the slow save resolves
  openSheetHtml('<div>Weight units</div>');

  const before = calls();
  pending.get('/api/me/default-gym')(); // the stale save finally resolves
  await new Promise(r => setTimeout(r, 5));
  const after = calls();
  ok(after.openSettings === before.openSettings, `Settings does NOT reopen on top of Weight units (before ${before.openSettings}, after ${after.openSettings})`);
}

console.log('\neditBio: a slow save must NOT navigate the user back to their profile if they switched tabs');
{
  pending.clear();
  navState.tab = 'me';
  editBio();
  vm.runInContext(`_teConfirm()`, ctx); // taps Save, in flight

  navState.tab = 'home';
  showTab('home'); // user moves on to the Home tab while the save is still in flight

  const before = calls();
  pending.get('/api/me/bio')();
  await new Promise(r => setTimeout(r, 5));
  const after = calls();
  ok(after.profileView === before.profileView, `the user is NOT yanked back to their profile mid-task (before ${before.profileView}, after ${after.profileView})`);
}

console.log('\neditBio: a slow save must NOT yank the user back from a FRIEND\'S profile (cold-review follow-up)');
{
  // The gap the first cold-review pass found: navigating from your own profile to someone else's
  // (e.g. tap Followers -> tap a friend's row -> profileView(friendId)) is a real navigation away,
  // but it neither switches the nav tab nor opens a new sheet -- the tab stays 'me' throughout.
  // Before this fix, the guard only checked the tab, so it couldn't tell this had happened and
  // would let the stale save barge in on top of the friend's profile.
  pending.clear();
  navState.tab = 'me';
  editBio();
  vm.runInContext(`_teConfirm()`, ctx); // taps Save, in flight

  profileView('friend-123'); // user taps a friend's row from their Followers list

  const before = calls();
  pending.get('/api/me/bio')(); // the stale save finally resolves, now looking at the friend's profile
  await new Promise(r => setTimeout(r, 5));
  const after = calls();
  ok(after.profileView === before.profileView, `the user is NOT yanked off the friend's profile back to their own (before ${before.profileView}, after ${after.profileView})`);
}

console.log('\nthe ordinary fast-save case (the overwhelming common one) must still work -- the fix must not break the everyday flow');
{
  pending.clear();
  navState.tab = 'me';
  const before = calls();
  editDefaultGym();
  vm.runInContext(`_teConfirm()`, ctx);
  // nothing else happens -- resolve immediately, same as a normal fast network round trip
  pending.get('/api/me/default-gym')();
  await new Promise(r => setTimeout(r, 5));
  const after = calls();
  ok(after.openSettings === before.openSettings + 1, `Settings still reopens normally when nothing else interrupted the save (before ${before.openSettings}, after ${after.openSettings})`);
}
{
  pending.clear();
  navState.tab = 'me';
  const before = calls();
  editBio();
  vm.runInContext(`_teConfirm()`, ctx);
  pending.get('/api/me/bio')();
  await new Promise(r => setTimeout(r, 5));
  const after = calls();
  ok(after.profileView === before.profileView + 1, `and profileView still fires normally for a fast bio save (before ${before.profileView}, after ${after.profileView})`);
}

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
