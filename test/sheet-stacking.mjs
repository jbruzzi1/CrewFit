// v247: closeSheet() used to grab the FIRST .sheet-back in document order — the OLDEST open
// sheet. That's invisible almost everywhere because only one sheet is ever open at a time, but
// editLogSet() stacks a second .sheet-back on top of the still-open log sheet (tap a set row
// while the log sheet is up to edit it), and the first-in-order sheet is the log sheet
// underneath, not the edit-set sheet on top. Cancel/(x) on the edit-set sheet was closing the log
// sheet behind it instead of itself. This test drives the REAL closeSheet() pulled out of app.js
// against a small but faithful DOM stub (real appendChild/removeChild ordering, real classList),
// simulating exactly that stack, and asserts the LAST (topmost, most-recently-opened) sheet is the
// one that closes.
//
// Cold-review catch on the FIRST version of this fix: closing only the topmost sheet is right for
// Cancel/backdrop-tap (which must leave the sheet underneath alone), but saveLogSet/
// delLogSetConfirmed immediately open a THIRD, freshly-reloaded log sheet after saving — at that
// point NEITHER of the two stacked sheets underneath should survive, or whichever one closeSheet()
// left behind resurfaces later as a zombie showing stale pre-edit data. Those two call sites use
// closeAllSheets() instead, tested separately below.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };

const SRC = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

// A real (if small) DOM: elements track their own children in append order, classList is a real
// Set, remove() actually detaches. This is the part that must NOT be a shallow always-truthy
// Proxy, or the test could not tell "closed the first" from "closed the last".
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
// same shallow always-truthy stub the other client tests use, for every OTHER document API the
// whole-file vm load touches at module scope — only body/createElement/querySelectorAll need to
// be real for this test
const genericEl = () => new Proxy(function () {}, {
  get: (t, k) => k === 'children' || k === 'childNodes' ? [] : (k === 'innerText' || k === 'value' || k === 'textContent') ? '' : genericEl(),
  set: () => true, apply: () => genericEl(), has: () => true,
});
const doc = {
  body,
  createElement: () => makeEl('DIV'),
  getElementById: () => genericEl(),
  querySelector: (sel) => sel === '.sheet-back' ? (body._children.filter(c => c.className === 'sheet-back').at(-1) || null) : genericEl(),
  querySelectorAll: (sel) => sel === '.sheet-back' ? body._children.filter(c => c.className === 'sheet-back') : [],
  addEventListener() {}, documentElement: genericEl(), head: genericEl(), cookie: '', readyState: 'complete',
};
const ctx = {
  console: { log() {}, warn() {}, error() {} }, document: doc,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  fetch: () => Promise.resolve({ json: () => Promise.resolve([]), ok: true, status: 200, text: () => Promise.resolve('') }),
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
const closeSheet = vm.runInContext('closeSheet', ctx);
const closeAllSheets = vm.runInContext('closeAllSheets', ctx);

const wait = ms => new Promise(r => setTimeout(r, ms));

console.log("editLogSet's exact stack: log sheet opened, then an edit-set sheet on top of it");
{
  const logSheet = makeEl('DIV'); logSheet.className = 'sheet-back'; logSheet.classList.add('show');
  const editSheet = makeEl('DIV'); editSheet.className = 'sheet-back'; editSheet.classList.add('show');
  body.appendChild(logSheet); body.appendChild(editSheet); // append order == open order, same as the real app

  ok(body._children.length === 2, 'both sheets are open (stacked), as editLogSet leaves them');

  // Cancel/(x) tapped on the TOP (edit-set) sheet
  closeSheet();
  ok(!editSheet.classList.contains('show'), 'closeSheet() un-shows the TOP sheet (the one whose (x) was actually tapped)');
  ok(logSheet.classList.contains('show'), 'the log sheet underneath is untouched, not silently closed instead');

  await wait(210); // closeSheet's own 200ms remove() delay
  ok(editSheet._removed, 'the top sheet is actually removed from the DOM');
  ok(!logSheet._removed, 'the log sheet underneath is still there — Cancel on the edit sheet must not blow away the sheet it was opened from');
}

console.log('\nSave/Delete on the edit-set sheet: closeAllSheets() must not leak EITHER stacked sheet as a zombie');
{
  body._children.length = 0;
  const logSheet = makeEl('DIV'); logSheet.className = 'sheet-back'; logSheet.classList.add('show');
  const editSheet = makeEl('DIV'); editSheet.className = 'sheet-back'; editSheet.classList.add('show');
  body.appendChild(logSheet); body.appendChild(editSheet);

  // saveLogSet's/delLogSetConfirmed's real sequence is closeAllSheets() then openLogSheet(...) (a
  // fresh log sheet, reloaded from the server). We only need the closeAllSheets() half here —
  // that's the part responsible for nothing stale surviving underneath the fresh one.
  closeAllSheets();
  await wait(210);
  ok(body._children.length === 0, `both stacked sheets are gone, not just the topmost one (${body._children.length} left)`);
}

console.log('\nclosing 3+ stacked sheets at once (e.g. a confirm mid-fade-out on top of both) still clears everything');
{
  body._children.length = 0;
  const a = makeEl('DIV'); a.className = 'sheet-back'; a.classList.add('show');
  const b = makeEl('DIV'); b.className = 'sheet-back'; b.classList.add('show');
  const c = makeEl('DIV'); c.className = 'sheet-back'; c.classList.add('show');
  body.appendChild(a); body.appendChild(b); body.appendChild(c);
  closeAllSheets();
  ok([a, b, c].every(s => !s.classList.contains('show')), 'every sheet loses .show immediately');
  await wait(210);
  ok(body._children.length === 0, 'every sheet is actually removed, not just the last or first');
}

console.log('\nsingle sheet open (the overwhelmingly common case) is unaffected');
{
  body._children.length = 0;
  const only = makeEl('DIV'); only.className = 'sheet-back'; only.classList.add('show');
  body.appendChild(only);
  closeSheet();
  await wait(210);
  ok(only._removed, 'the only open sheet still closes normally');
}

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
