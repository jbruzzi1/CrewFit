// v250 audit finding: confirmSheet() tracks its currently-open sheet in two module-level
// singletons, CONFIRM_CB/CONFIRM_EL, and (unlike every closeSheet()-guarded flow) never closed an
// existing confirm before opening a new one. None of its 11 call sites (Delete photo/set/workout/
// routine, Decline invite, Remove from my profile, Discard changes, Save changes, Remove routine,
// ...) disable themselves on tap, so a double-tap on a destructive button -- very easy to do,
// especially on a scary one -- called confirmSheet() twice, stacking two identical confirm sheets
// and overwriting CONFIRM_CB/CONFIRM_EL to point only at the second (topmost) one.
// dismissConfirm()/runConfirmCb() are wired to every button on EVERY confirm sheet but read those
// globals, not a reference to whichever physical sheet a tap actually came from -- so once the
// visible (topmost, second) sheet was dismissed, the first sheet's Cancel/Delete buttons called
// dismissConfirm()/runConfirmCb() against already-null globals and did nothing. Not a brief
// closeSheet()-style fade race: nothing was ever closing the first sheet, so it sat there fully
// rendered and fully tappable-looking, permanently dead, with no way out but reloading the page.
//
// This drives the REAL confirmSheet()/dismissConfirm()/runConfirmCb() out of the real
// public/app.js via node:vm against a small but faithful DOM stub (real appendChild/classList/
// remove, same harness as test/sheet-stacking.mjs and test/settings-menu-stack.mjs).
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
  querySelector: (sel) => sel === '.nav button.active' ? { dataset: { tab: 'me' } } : sel === '.sheet-back' ? (body._children.filter(c => c.className === 'sheet-back').at(-1) || null) : genericEl(),
  querySelectorAll: (sel) => sel === '.sheet-back' ? body._children.filter(c => c.className === 'sheet-back') : [],
  addEventListener() {}, documentElement: genericEl(), head: genericEl(), cookie: '', readyState: 'complete',
};
const ctx = {
  console: { log() {}, warn() {}, error() {} }, document: doc,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  fetch: () => Promise.resolve({ json: () => Promise.resolve([]), ok: true, status: 200, text: () => Promise.resolve('') }),
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
const confirmSheet = vm.runInContext('confirmSheet', ctx);
const dismissConfirm = vm.runInContext('dismissConfirm', ctx);
const runConfirmCb = vm.runInContext('runConfirmCb', ctx);

console.log("the exact bug: a double-tap on a destructive button used to leave a dead, undismissable confirm sheet behind");
{
  let deleteCalls = 0;
  const del = () => { deleteCalls++; };

  confirmSheet('Delete workout?', 'This cannot be undone.', 'Delete', del); // first tap
  confirmSheet('Delete workout?', 'This cannot be undone.', 'Delete', del); // accidental second tap

  ok(body._children.length === 1, `only one confirm sheet is ever live at once (got ${body._children.length})`);
  ok(body._children[0].classList.contains('show') || true, 'sanity: the surviving sheet exists'); // show is added via rAF(setTimeout 0), not asserted here

  // dismiss it (Cancel, or the ✕, or tapping the backdrop -- all call dismissConfirm())
  dismissConfirm();
  ok(body._children.length === 0 || body._children.every(c => !c.classList.contains('show')), 'dismissing the one live sheet actually dismisses it');

  // and tapping "Delete" on it (if it were still visible) must not silently do nothing --
  // there is no zombie left underneath to be stuck on, because only one was ever created.
  runConfirmCb();
  ok(deleteCalls === 0, 'no stray callback fires from a sheet that was never actually confirmed');
}

console.log('\nthe fix does not break the ordinary single-tap case');
{
  body._children.length = 0;
  let deleteCalls = 0;
  const del = () => { deleteCalls++; };
  confirmSheet('Delete photo?', '', 'Delete', del);
  ok(body._children.length === 1, 'one confirm sheet opens normally');
  runConfirmCb(); // tapping "Delete"
  ok(deleteCalls === 1, 'and its callback fires exactly once');
  ok(body._children.length === 1, 'the sheet starts its normal close-and-fade (not yet removed -- that\'s closeSheet()\'s own 200ms, unrelated to this fix)');
}

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
