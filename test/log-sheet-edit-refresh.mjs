// Jeff, Sep 1: "when I edit a set in the log page during a workout - it goes back to just the log
// page without showing the other sets you had logged." Root cause lived in renderLogSets(): every
// log sheet's markup has a `<div id="logSetList">` inside it, and saveLogSet()/delLogSetConfirmed()
// both call closeAllSheets() (which un-shows the old sheet(s) immediately but only detaches them
// from the DOM after a 200ms close-transition delay — see closeAllSheets' own comment) and then
// IMMEDIATELY open a fresh log sheet via openLogSheet(). For that 200ms window, TWO elements with
// id="logSetList" exist in the document at once: the dying old one (still attached, still first in
// document order, still holding the pre-edit rows) and the new visible one (freshly appended,
// still empty). A plain document.getElementById('logSetList') always resolves to the OLD one, so
// renderLogSets() wrote the freshly-fetched sets into an element that was seconds away from being
// deleted — the sheet actually on screen was never populated. The fix scopes the lookup to
// LOGVIEW.sheetEl (stamped onto LOGVIEW right before every renderLogSets() call site), so it always
// fills the sheet it was actually called for, id collision or not.
//
// This test drives the REAL renderLogSets() pulled out of app.js against a small but faithful DOM
// stub (real id-based getElementById/querySelector, real appendChild ordering) reproducing exactly
// that two-elements-share-an-id moment, and asserts the currently-visible sheet's list gets filled
// while the doomed old one is left alone.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };

const SRC = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

// A real (if small) DOM: elements track their own children in append order and their own id, so
// getElementById/querySelector can do a genuine document-order search — this is the part that
// must NOT be a shallow always-truthy proxy, or the test could not tell "wrote into the old
// element" from "wrote into the new one".
function makeEl(tag, id) {
  const el = {
    tagName: tag || 'DIV', id: id || '', className: '', style: {}, innerHTML: '',
    parentNode: null, _children: [], _removed: false, _classes: new Set(),
    appendChild(child) { child.parentNode = el; el._children.push(child); return child; },
    remove() { el._removed = true; if (el.parentNode) el.parentNode._children = el.parentNode._children.filter(c => c !== el); },
    querySelector(sel) {
      if (sel && sel[0] === '#') {
        const wantId = sel.slice(1);
        const stack = [...el._children];
        while (stack.length) { const n = stack.shift(); if (n.id === wantId) return n; stack.push(...n._children); }
      }
      return null;
    },
    querySelectorAll() { return []; },
    addEventListener() {}, setAttribute() {}, getAttribute() { return null; },
  };
  el.classList = {
    add: (...c) => c.forEach(x => el._classes.add(x)),
    remove: (...c) => c.forEach(x => el._classes.delete(x)),
    contains: c => el._classes.has(c),
  };
  return el;
}
function findById(root, id) {
  const stack = [...root._children];
  while (stack.length) { const n = stack.shift(); if (n.id === id) return n; stack.push(...n._children); }
  return null;
}
const body = makeEl('BODY');
const genericEl = () => new Proxy(function () {}, {
  get: (t, k) => k === 'children' || k === 'childNodes' ? [] : (k === 'innerText' || k === 'value' || k === 'textContent') ? '' : genericEl(),
  set: () => true, apply: () => genericEl(), has: () => true,
});
const doc = {
  body,
  createElement: (tag) => makeEl(tag),
  // real document.getElementById: first match in document order, same as a browser — this is
  // exactly the call the pre-fix code made and the exact thing that resolved to the stale sheet.
  getElementById: (id) => findById(body, id) || null,
  querySelector: () => genericEl(), querySelectorAll: () => [],
  addEventListener() {}, documentElement: genericEl(), head: genericEl(), cookie: '', readyState: 'complete',
};
const ctx = {
  console: { log() {}, warn() {}, error() {} }, document: doc,
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
};
ctx.window = ctx; ctx.globalThis = ctx; ctx.self = ctx;
vm.createContext(ctx);
vm.runInContext(SRC, ctx, { filename: 'public/app.js' });
const renderLogSets = vm.runInContext('renderLogSets', ctx);
vm.runInContext('function __setState(me, lv){ ME = me; LOGVIEW = lv; }', ctx);
const setState = vm.runInContext('__setState', ctx);

console.log('renderLogSets() during the 200ms window where the old and new sheets both have a #logSetList');
{
  // The old (closing) sheet: closeAllSheets() has un-shown it but its remove() is still 200ms out,
  // so it's still attached to the DOM, still first in document order, and its logSetList still
  // holds the pre-edit content.
  const oldSheet = makeEl('DIV'); oldSheet.className = 'sheet-back';
  const oldList = makeEl('DIV', 'logSetList'); oldList.innerHTML = '<div class="set-row">STALE PRE-EDIT ROW</div>';
  oldSheet.appendChild(oldList);
  body.appendChild(oldSheet);

  // The new (freshly reopened) sheet, exactly as openLogSheet() builds it: appended after the old
  // one, its own empty #logSetList, and LOGVIEW.sheetEl stamped to point at it before renderLogSets
  // is called (see openLogSheet's own comment on why sheetEl is stamped before this call).
  const newSheet = makeEl('DIV'); newSheet.className = 'sheet-back';
  const newList = makeEl('DIV', 'logSetList');
  newSheet.appendChild(newList);
  body.appendChild(newSheet);

  ok(doc.getElementById('logSetList') === oldList, 'sanity check: a plain getElementById(\'logSetList\') really does resolve to the stale old element here — this is the exact collision that caused the bug');

  const me = { id: 'u1' };
  const s = { logs: { u1: [
    { id: 'log1', exerciseId: 'ex1', set: 1, weight: 135, reps: 8, setType: 'normal' },
    { id: 'log2', exerciseId: 'ex1', set: 2, weight: 145, reps: 6, setType: 'normal' },
    { id: 'log3', exerciseId: 'ex1', set: 3, weight: 999, reps: 8, setType: 'normal' },
  ] } };
  setState(me, { sid: 's1', exId: 'ex1', loadType: '', recName: 'Back Squat', sheetEl: newSheet });

  renderLogSets(s);

  ok(newList.innerHTML.includes('999') && newList.innerHTML.includes('145') && newList.innerHTML.includes('135'),
    'the sheet actually on screen (LOGVIEW.sheetEl) gets all 3 sets, including the just-edited one');
  ok((newList.innerHTML.match(/set-row/g) || []).length === 3, 'exactly 3 set rows rendered into the live sheet, not 0');
  ok(oldList.innerHTML === '<div class="set-row">STALE PRE-EDIT ROW</div>', 'the doomed old #logSetList is left untouched, not overwritten and then thrown away with it');
}

console.log('\nrenderLogSets() with no id collision (the overwhelmingly common case: only one sheet open) still works');
{
  body._children.length = 0;
  const sheet = makeEl('DIV'); sheet.className = 'sheet-back';
  const list = makeEl('DIV', 'logSetList');
  sheet.appendChild(list);
  body.appendChild(sheet);

  const me = { id: 'u1' };
  const s = { logs: { u1: [{ id: 'log1', exerciseId: 'ex1', set: 1, weight: 135, reps: 8, setType: 'normal' }] } };
  setState(me, { sid: 's1', exId: 'ex1', loadType: '', recName: 'Back Squat', sheetEl: sheet });

  renderLogSets(s);
  ok(list.innerHTML.includes('135'), 'single-sheet case renders normally');
}

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
