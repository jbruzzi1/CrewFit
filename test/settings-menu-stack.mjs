// v249, Jeff Aug 29 (uploaded video): "When selecting things on the settings menu it's affecting
// things behind it." Back then Settings was a SHEET, and every row except "Default gym" already
// called closeSheet() before opening its sub-flow. "Default gym" alone went straight to
// editDefaultGym(), which itself opened a SECOND full-viewport .sheet-back on top of the still-open
// Settings sheet -- two stacked rgba(0,0,0,.35) backdrops compounding, exactly "affecting things
// behind it". The fix at the time was closeSheet()-before-every-row; a cold-review pass also caught
// Streak reminders reopening Settings on top of itself after a successful toggle, fixed by patching
// the row's own value span in place instead (the same pattern toggleTheme() already used for
// Appearance).
//
// Sep 2026: Jeff asked to clean the settings page up -- "should this be a full page with a back
// button... rather than just a pop up window" -- and Settings was rebuilt as a real full-page nav
// screen (`openSettings()` now writes `$('app').innerHTML` and calls navigated()/landOn(), it no
// longer calls openSheetHtml() at all; see the long comment above openSettings() in app.js). That
// makes the ORIGINAL "two .sheet-back elements stacked" failure mode structurally impossible --
// Settings itself is never a sheet to stack a second one on top of. But the underlying lesson the
// v249 fix protected -- a row's own edit/toggle must update itself in place, never reopen the whole
// screen it lives on -- still applies, just one level up: reopening Settings now means an extra
// navigated()/landOn() call (a duplicate {t:'settings'} history entry, a needless full re-render)
// instead of an extra .sheet-back. editDefaultGym() and the two reminder toggles were all
// deliberately kept patching #settingsGymVal/#streakRemVal/#workoutRemVal in place through the
// conversion (see their own comments in app.js) -- this file now asserts that in page terms.
//
// This drives the REAL openSettings()/editDefaultGym()/toggleStreakReminders()/
// toggleWorkoutReminders()/stillOnProfileWithNothingElseOpen() out of the real public/app.js via
// node:vm against a small but faithful DOM stub (real appendChild/classList/remove, same harness as
// test/sheet-stacking.mjs) -- not a re-implementation of the branching -- and literally executes the
// onclick attribute strings openSettings() actually renders, the same way a browser would on a real
// tap.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };

const SRC = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

// Same real-DOM stub as test/sheet-stacking.mjs: elements track their own children in append
// order, classList is a real Set, remove() actually detaches -- needed to tell "a sheet is still
// live" from "it's gone", which a shallow always-truthy Proxy cannot distinguish.
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
// getElementById needs to be real (a settable, inspectable object per id) for the update-in-place
// assertions below -- $('app').innerHTML = ... (openSettings' own full-page write), and
// toggleStreakReminders/toggleWorkoutReminders/editDefaultGym's onConfirm setting .textContent on
// #streakRemVal/#workoutRemVal/#settingsGymVal -- a shallow always-truthy Proxy would silently
// swallow those writes, same reasoning as chatInputPresent in test/joinable-message-crash.mjs. No
// special-casing needed for 'app' itself: byId() below hands back a plain, unsealed object for ANY
// id the first time it's asked for, and `.innerHTML = ...` just adds the property to it like any
// other write.
const idEls = new Map();
const byId = (id) => { if (!idEls.has(id)) idEls.set(id, { textContent: '', innerText: '', value: '', classList: { add() {}, remove() {}, contains: () => false }, focus() {}, click() {}, style: {} }); return idEls.get(id); };
const doc = {
  body,
  createElement: () => makeEl('DIV'),
  getElementById: byId,
  querySelector: (sel) => sel === '.sheet-back' ? (body._children.filter(c => c.className === 'sheet-back').at(-1) || null) : genericEl(),
  querySelectorAll: (sel) => sel === '.sheet-back' ? body._children.filter(c => c.className === 'sheet-back') : [],
  addEventListener() {}, documentElement: genericEl(), head: genericEl(), cookie: '', readyState: 'complete',
};
const ctx = {
  console: { log() {}, warn() {}, error() {} }, document: doc,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  // Every POST in this file (notify-prefs, default-gym) expects back exactly what it posted --
  // editDefaultGym/toggleStreakReminders/toggleWorkoutReminders all read their own field straight
  // out of the response (r.defaultGym / r.streakReminders / r.workoutReminders), so echoing the
  // posted body back as the response covers all of them without special-casing any one URL.
  fetch: (url, opts) => Promise.resolve({
    json: () => Promise.resolve(opts && opts.body ? JSON.parse(opts.body) : []),
    ok: true, status: 200, text: () => Promise.resolve(''),
  }),
  location: { href: '/', pathname: '/', search: '', hash: '' },
  // v254: app.js registers a top-level window.addEventListener('popstate', ...) (the Back-button
  // fix) and calls history.pushState/replaceState from openSheetHtml/closeSheet/navigated/landOn --
  // these need to be real enough not to throw, even in tests that don't care about nav.
  history: { replaceState() {}, pushState() {} }, addEventListener() {}, removeEventListener() {}, scrollTo() {},
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
vm.runInContext(`ME = { id:'u1', defaultGym:'', units:'lb', notifyStreakReminders:true, notifyWorkoutReminders:true };`, ctx);
const openSettings = vm.runInContext('openSettings', ctx);
const editDefaultGym = vm.runInContext('editDefaultGym', ctx);
const toggleStreakReminders = vm.runInContext('toggleStreakReminders', ctx);
const toggleWorkoutReminders = vm.runInContext('toggleWorkoutReminders', ctx);
const stillOnProfileWithNothingElseOpen = vm.runInContext('stillOnProfileWithNothingElseOpen', ctx);

// Settings is a page now, not a sheet -- the invariant worth protecting is "editing/toggling a row
// updates itself in place", i.e. it must never call navigated()/landOn() again (which would push a
// duplicate {t:'settings'} history entry and needlessly re-render the whole page). navigated/landOn
// are ordinary top-level function declarations in the script just evaluated, which makes them
// properties of the sandbox's global object (ctx) -- reassigning ctx.navigated/ctx.landOn here
// redirects every later unqualified call inside app.js to this wrapper, while still running the
// real implementation underneath.
const origNavigated = vm.runInContext('navigated', ctx);
const origLandOn = vm.runInContext('landOn', ctx);
let navCalls = 0;
ctx.navigated = (...a) => { navCalls++; return origNavigated(...a); };
ctx.landOn = (...a) => { navCalls++; return origLandOn(...a); };

const wait = ms => new Promise(r => setTimeout(r, ms));

console.log('openSettings() renders Settings as a full page in #app, not a sheet');
{
  navCalls = 0;
  openSettings();
  ok(body._children.length === 0, 'no .sheet-back is created -- opening Settings never touches document.body');
  ok(navCalls === 1, `exactly one navigated()/landOn() call for the page render (got ${navCalls})`);
  const st = vm.runInContext('CURRENT_NAV_STATE', ctx);
  ok(st.t === 'settings', `CURRENT_NAV_STATE reflects the settings page (got ${JSON.stringify(st)})`);

  const inner = idEls.get('app').innerHTML;
  ok(/<h1[^>]*>Settings<\/h1>/.test(inner), 'renders a Settings <h1>');
  ok(/<button class="sec sm" onclick="history\.back\(\)">← Back<\/button>/.test(inner), 'and a Back button using history.back() -- not closeSheet(), Settings has no sheet to close');

  for (const h of ['Profile', 'Preferences', 'Notifications', 'Help', 'Danger zone']) {
    ok(new RegExp(`<h2>${h}</h2>`).test(inner), `section header "${h}" present`);
  }

  const gymRow = inner.match(/<button class="sheet-row" onclick="([^"]*)">Default gym/);
  ok(!!gymRow, 'the Default gym row is present');
  ok(gymRow && gymRow[1] === 'editDefaultGym()', `Default gym is a bare call now -- nothing to closeSheet() first, Settings isn't a sheet (got onclick="${gymRow && gymRow[1]}")`);

  ok(/<button class="sheet-row red" onclick="confirmResetWorkouts\(\)">Reset workouts<\/button>/.test(inner), 'Reset workouts keeps its destructive red styling, unchanged');

  const logoutRow = inner.match(/<button class="([^"]*)" onclick="logout\(\)">Log out/);
  ok(!!logoutRow, 'the Log out row is present');
  ok(logoutRow && logoutRow[1] === 'sheet-row', `Log out still doesn't share Reset workouts' red/destructive styling (got class="${logoutRow && logoutRow[1]}")`);
  ok(/sheet-list" style="margin-top:14px">\s*<button class="sheet-row" onclick="logout\(\)">Log out/.test(inner), 'and still sits in its own grouped section, separated from Danger zone');
}

console.log("\nediting Default gym patches the row in place -- no re-render of the Settings page, no extra nav entry");
{
  body._children.length = 0;
  openSettings();
  ok(/id="settingsGymVal">Not set</.test(idEls.get('app').innerHTML), 'starts unset, per ME.defaultGym');
  navCalls = 0; // measure only what the edit flow itself triggers, not the setup render above

  editDefaultGym(); // exactly what tapping the row runs
  ok(body._children.length === 1, 'opens a text-entry sheet on top of the (page, not sheet) Settings screen -- that part is unchanged');

  vm.runInContext(`document.getElementById('teVal').value = 'Planet Fitness';`, ctx);
  const teConfirm = vm.runInContext('_teConfirm', ctx);
  teConfirm(); // exactly what tapping Save runs
  ok(!body._children[0].classList.contains('show'), 'the text-entry sheet starts fading immediately (closeSheet ran)');

  await wait(210); // closeSheet()'s own 200ms remove() delay, then the mocked network round trip
  ok(body._children.length === 0, 'and is fully removed, leaving no sheet behind');
  ok(idEls.get('settingsGymVal').textContent === 'Planet Fitness', `the row's own value span updates in place (got "${idEls.get('settingsGymVal').textContent}")`);
  ok(navCalls === 0, `Settings itself was never re-rendered/re-pushed to show the new value -- no navigated()/landOn() call (got ${navCalls})`);
}

console.log('\ntoggling Streak reminders updates the row in place -- no re-render of the Settings page');
{
  body._children.length = 0;
  vm.runInContext(`ME.notifyStreakReminders = true;`, ctx);
  openSettings();
  ok(/id="streakRemVal">On</.test(idEls.get('app').innerHTML), 'starts On, per ME.notifyStreakReminders');
  navCalls = 0;

  await toggleStreakReminders(); // exactly what tapping the row runs
  ok(navCalls === 0, `toggling does not re-render Settings -- no navigated()/landOn() call (got ${navCalls})`);
  ok(body._children.length === 0, 'and no sheet is stacked in the process');
  ok(idEls.get('streakRemVal').textContent === 'Off', `the row's own text flips to Off in place, same pattern toggleTheme() already uses for Appearance (got "${idEls.get('streakRemVal').textContent}")`);
}

console.log('\nWorkout reminders (Task #155) is the exact same row/toggle pattern as Streak reminders, one sibling further down -- same update-in-place behavior');
{
  body._children.length = 0;
  vm.runInContext(`ME.notifyWorkoutReminders = true;`, ctx);
  openSettings();
  ok(/id="workoutRemVal">On</.test(idEls.get('app').innerHTML), 'starts On, per ME.notifyWorkoutReminders');
  navCalls = 0;

  await toggleWorkoutReminders(); // exactly what tapping the row runs
  ok(navCalls === 0, `toggling does not re-render Settings -- no navigated()/landOn() call (got ${navCalls})`);
  ok(body._children.length === 0, 'and no sheet is stacked in the process');
  ok(idEls.get('workoutRemVal').textContent === 'Off', `the row's own text flips to Off in place (got "${idEls.get('workoutRemVal').textContent}")`);
}

console.log('\nstillOnProfileWithNothingElseOpen() -- rewritten for the settings-as-a-page conversion. The OLD check read document.querySelector(\'.nav button.active\').dataset.tab===\'me\' as a proxy for "the profile is on screen", which broke the instant Settings (and Starting weights) became their own screens sharing that same tab: closing a sheet from EITHER of them wrongly re-rendered the profile underneath. The NEW check reads CURRENT_NAV_STATE directly instead of guessing from the tab.');
{
  const epoch = vm.runInContext('UI_EPOCH', ctx); // nothing below bumps UI_EPOCH, so this stays valid as a "nothing navigated since" baseline throughout

  vm.runInContext(`CURRENT_NAV_STATE = {t:'tab', tab:'me'};`, ctx);
  ok(stillOnProfileWithNothingElseOpen(epoch) === true, 'viewing your own profile via the Me tab -> true');

  vm.runInContext(`CURRENT_NAV_STATE = {t:'profile', id:'u1'};`, ctx);
  ok(stillOnProfileWithNothingElseOpen(epoch) === true, 'viewing your own profile via a direct {t:profile,id} entry -> true');

  vm.runInContext(`CURRENT_NAV_STATE = {t:'profile', id:'someone-else'};`, ctx);
  ok(stillOnProfileWithNothingElseOpen(epoch) === false, "viewing a DIFFERENT profile -> false");

  vm.runInContext(`CURRENT_NAV_STATE = {t:'settings'};`, ctx);
  ok(stillOnProfileWithNothingElseOpen(epoch) === false, 'on Settings (same "me" tab, not actually the profile screen) -> false -- exactly the case the old dataset.tab===\'me\' proxy check could not see');

  vm.runInContext(`CURRENT_NAV_STATE = {t:'seeds'};`, ctx);
  ok(stillOnProfileWithNothingElseOpen(epoch) === false, 'on Starting weights -> false, same reasoning');

  vm.runInContext(`CURRENT_NAV_STATE = {t:'tab', tab:'me'};`, ctx);
  ok(stillOnProfileWithNothingElseOpen(epoch + 1) === false, 'epoch gone stale (something else navigated in between) -> false regardless of CURRENT_NAV_STATE');
}

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
