// v249, Jeff Aug 29 (uploaded video): "When selecting things on the settings menu it's affecting
// things behind it." Every row in openSettings() except "Default gym" calls closeSheet() before
// opening its sub-flow (Edit photo/Edit bio/Weight units/Reset workouts/Log out all do
// `closeSheet(); <action>()`). "Default gym" alone went straight to editDefaultGym(), which itself
// calls textEntrySheet() -> openSheetHtml(), appending a SECOND full-viewport .sheet-back on top
// of the still-open Settings sheet. That violates the single-sheet invariant the rest of this file
// already assumes (see the comment above _teConfirm in textEntrySheet(): "only one text-entry
// sheet is ever open at a time, same as closeSheet()'s single .sheet-back assumption elsewhere in
// this file"). Two sheets stacked means two independent rgba(0,0,0,.35) backdrops compounding —
// exactly "affecting things behind it" — and, since closeSheet() captures its target in a closure
// before its own 200ms fade-out timer runs (see test/sheet-stacking.mjs for that mechanism in
// isolation), any close of the Settings sheet while Default Gym sits on top of it removes the
// ORIGINAL Settings element on its own independent timer regardless of what has since stacked
// above it — leaving Default Gym's sheet orphaned over a fully bright, fully interactive profile
// page once that timer fires. That's exactly the state frames 010-011 of Jeff's recording show.
//
// The fix adds closeSheet() to the "Default gym" row, matching every sibling: Settings is always
// gone (fading, on its own removal timer) before Default Gym's sheet is ever created, so at most
// one sheet-back can ever be live at a time from this flow -- the same pattern every other row
// here already uses without incident.
//
// Jeff's second complaint in the same message -- "the log out button is the same size and very
// close to the reset workout button" -- is a separate fix in the same openSettings() rewrite:
// Log out no longer shares Reset workouts' .sheet-row.red (destructive) styling, and moves into
// its own grouped .sheet-list section with real spacing above it, so a harmless, fully reversible
// action no longer reads as being just as risky as an irreversible one, or sits a hairline away.
//
// Cold-review catch on the first version of this fix: "Default gym" wasn't the only offender.
// "Streak reminders" (toggleStreakReminders()) never called closeSheet() either, and on a
// successful toggle called openSettings() again to refresh its On/Off label -- appending a
// SECOND full-viewport Settings sheet on top of the still-fully-live original, permanently (not
// even a brief fade-race -- nothing ever closed the first one). toggleTheme() had already hit
// this exact shape of bug for the theme row and was fixed by updating the row's own text in
// place instead of closing-and-reopening (see the comment above toggleTheme()); toggleStreakReminders()
// now gets the same treatment.
//
// This drives the REAL openSettings()/closeSheet()/editDefaultGym()/toggleStreakReminders() out
// of the real public/app.js via node:vm against a small but faithful DOM stub (real
// appendChild/classList/remove, same harness as test/sheet-stacking.mjs) -- not a
// re-implementation of the branching -- and literally
// executes the onclick attribute string openSettings() actually renders, the same way a browser
// would on a real tap.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };

const SRC = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

// Same real-DOM stub as test/sheet-stacking.mjs: elements track their own children in append
// order, classList is a real Set, remove() actually detaches -- needed to tell "both sheets are
// live" from "only the new one is", which a shallow always-truthy Proxy cannot distinguish.
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
// getElementById needs to be real (a settable, inspectable object per id) for the
// update-in-place assertion below (toggleStreakReminders sets .textContent on #streakRemVal) --
// a shallow always-truthy Proxy would silently swallow that write, same reasoning as
// chatInputPresent in test/joinable-message-crash.mjs.
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
  // /api/me/notify-prefs gets a real-shaped response (toggleStreakReminders reads
  // r.streakReminders back out of it below); everything else keeps the generic empty stub the
  // other client tests use.
  fetch: (url, opts) => url.includes('/api/me/notify-prefs')
    ? Promise.resolve({ json: () => Promise.resolve(JSON.parse(opts.body)), ok: true, status: 200, text: () => Promise.resolve('') })
    : Promise.resolve({ json: () => Promise.resolve([]), ok: true, status: 200, text: () => Promise.resolve('') }),
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
  ResizeObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
};
ctx.window = ctx; ctx.globalThis = ctx; ctx.self = ctx;
vm.createContext(ctx);
vm.runInContext(SRC, ctx, { filename: 'public/app.js' });
vm.runInContext(`ME = { id:'u1', defaultGym:'', units:'lb', notifyStreakReminders:true };`, ctx);
const openSettings = vm.runInContext('openSettings', ctx);
const editDefaultGym = vm.runInContext('editDefaultGym', ctx);
const toggleStreakReminders = vm.runInContext('toggleStreakReminders', ctx);

const wait = ms => new Promise(r => setTimeout(r, ms));

console.log('openSettings() itself renders the fix: every row closes Settings before opening its sub-flow');
{
  openSettings();
  ok(body._children.length === 1, 'Settings opens as the only sheet');
  const inner = body._children[0].innerHTML;

  const gymRow = inner.match(/<button class="sheet-row" onclick="([^"]*)">Default gym/);
  ok(!!gymRow, 'the Default gym row is present');
  ok(gymRow && gymRow[1] === 'closeSheet(); editDefaultGym()', `Default gym now closes Settings first, matching every sibling row (got onclick="${gymRow && gymRow[1]}")`);

  ok(/<button class="sheet-row red" onclick="closeSheet\(\); confirmResetWorkouts\(\)">Reset workouts<\/button>/.test(inner), 'Reset workouts keeps its destructive red styling, unchanged');

  const logoutRow = inner.match(/<button class="([^"]*)" onclick="closeSheet\(\); logout\(\)">Log out/);
  ok(!!logoutRow, 'the Log out row is present');
  ok(logoutRow && logoutRow[1] === 'sheet-row', `Log out no longer shares Reset workouts' red/destructive styling (got class="${logoutRow && logoutRow[1]}")`);
  ok(/sheet-list" style="margin-top:14px">\s*<button class="sheet-row" onclick="closeSheet\(\); logout\(\)">Log out/.test(inner), 'and Log out sits in its own grouped section with real spacing above it, not hugging Reset workouts behind a hairline divider');
}

console.log("\nbehavioral: literally executing the Default gym row's onclick (the same string a real tap would run) never leaves two sheets alive");
{
  body._children.length = 0;
  openSettings();
  const settingsSheet = body._children[0];
  const inner = settingsSheet.innerHTML;
  const onclickAttr = inner.match(/<button class="sheet-row" onclick="([^"]*)">Default gym/)[1];

  vm.runInContext(onclickAttr, ctx); // exactly what a browser runs for this button's tap
  ok(!settingsSheet.classList.contains('show'), 'Settings is already fading (closeSheet ran) the instant the tap handler returns');
  ok(body._children.length === 2, 'Default Gym has been appended -- briefly overlapping Settings mid-fade is expected, same as every sibling row');

  await wait(210); // closeSheet()'s own 200ms remove() delay
  ok(body._children.length === 1, `Settings has actually been removed by its own timer, leaving exactly one sheet (got ${body._children.length})`);
  ok(body._children[0] !== settingsSheet, 'the surviving sheet is the new Default Gym one, not a stale Settings');
  ok(body._children[0].classList.contains('show'), 'and it is fully shown -- not itself mid-fade or orphaned');
}

console.log('\nthe bug this replaces: calling editDefaultGym() straight from Settings (the old code path) really does stack two live sheets at once');
{
  body._children.length = 0;
  openSettings();
  ok(body._children.length === 1, 'Settings open, alone');
  const settingsSheet = body._children[0];

  editDefaultGym(); // the OLD "Default gym" row's behavior: no closeSheet() first
  ok(body._children.length === 2, 'Default Gym stacks directly on top of the still-open Settings sheet');
  await wait(10); // let openSheetHtml's requestAnimationFrame(() => classList.add('show')) actually run
  ok(settingsSheet.classList.contains('show'), 'and Settings is still fully shown underneath -- this is the double-backdrop, "affecting things behind it" state from frame 009 of the video');
  ok(body._children[1].classList.contains('show'), 'both sheets fully shown simultaneously, which the rest of this file assumes never happens');
}

console.log('\ncold-review catch: Streak reminders had the exact same reopen-on-top bug, one sibling row over -- toggling it must update in place, not stack a second Settings sheet');
{
  body._children.length = 0;
  vm.runInContext(`ME.notifyStreakReminders = true;`, ctx);
  openSettings();
  ok(body._children.length === 1, 'Settings open, alone');
  const settingsSheet = body._children[0];
  await wait(10); // let openSheetHtml's requestAnimationFrame(() => classList.add('show')) actually run
  ok(/id="streakRemVal">On</.test(settingsSheet.innerHTML), 'starts On, per ME.notifyStreakReminders');

  await toggleStreakReminders(); // exactly what tapping the row runs
  ok(body._children.length === 1, `toggling does not stack a second Settings sheet (got ${body._children.length})`);
  ok(body._children[0] === settingsSheet, 'the original Settings sheet is still the one and only sheet -- updated, not replaced');
  ok(settingsSheet.classList.contains('show'), 'and it was never closed/re-faded in the process');
  ok(idEls.get('streakRemVal').textContent === 'Off', `the row's own text flips to Off in place, same pattern toggleTheme() already uses for Appearance (got "${idEls.get('streakRemVal').textContent}")`);
}

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
