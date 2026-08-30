// v251 audit finding: textEntrySheet() (public/app.js) is the shared sheet behind editBio,
// editDefaultGym, editPostNotes, template naming, and every other in-app "type some text, tap
// Save" flow. Same double-tap shape confirmSheet() was fixed for in v250 (see the comment there),
// but worse: a double-tap on whatever OPENS a text-entry sheet (e.g. tapping the bio text on your
// own profile twice fast) used to stack two sheets, each with its own id="teVal" field.
// window._teConfirm/_teCancel got overwritten to point at the SECOND call's onConfirm, but a real
// browser's getElementById('teVal') resolves to the FIRST matching id in document order -- the
// first (hidden, stale) sheet -- so tapping Save on the sheet the user can actually see would read
// and submit the OTHER sheet's old value, then closeSheet() only removed the topmost sheet,
// leaving the first one behind as a visible, fully-interactive zombie. Not just a stuck popup like
// the confirmSheet bug -- silently wrong data saved. Fixed the same way: removing any already-open
// text-entry sheet immediately before opening a new one (TE_EL), so at most one ever exists, plus
// rebinding _teConfirm/_teCancel to a no-op the instant either fires, guarding the narrower
// double-submit variant (double-tapping Save itself, not just the trigger).
//
// This drives the REAL textEntrySheet()/_teConfirm()/_teCancel() out of the real public/app.js via
// node:vm against the same faithful DOM stub as test/confirm-sheet-stack.mjs.
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
// A single mutable stand-in for whatever <input id="teVal">/<textarea id="teVal"> is currently on
// screen -- since this stub doesn't parse innerHTML into real child elements, the test sets its
// .value directly to simulate the user typing, right before tapping Save. This also means the fix
// is being proven at the level that actually matters: with TE_EL dedup in place there is only ever
// ONE live text-entry sheet, so there is no ambiguity left for getElementById('teVal') to resolve
// wrong -- the assertions below check that the SECOND (visible) call's onConfirm is what fires,
// with whatever was actually typed, not the first call's.
const teVal = { value: '', focus() {} };
const doc = {
  body,
  createElement: () => makeEl('DIV'),
  getElementById: (id) => id === 'teVal' ? teVal : genericEl(),
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
const textEntrySheet = vm.runInContext('textEntrySheet', ctx);

console.log('the exact bug: double-tapping whatever opens a text-entry sheet used to stack two, with Save wired to the wrong one');
{
  let firstCalls = 0, secondCalls = 0, firstVal = null, secondVal = null;
  textEntrySheet({ title: 'Bio', value: 'old bio', onConfirm: v => { firstCalls++; firstVal = v; } }); // first tap
  textEntrySheet({ title: 'Bio', value: 'old bio', onConfirm: v => { secondCalls++; secondVal = v; } }); // accidental second tap

  ok(body._children.length === 1, `only one text-entry sheet is ever live at once (got ${body._children.length})`);

  teVal.value = 'brand new bio text'; // user types into the (only) visible input
  vm.runInContext('_teConfirm()', ctx); // taps Save

  ok(firstCalls === 0, "the FIRST call's onConfirm never fires -- its sheet was removed before Save was tapped");
  ok(secondCalls === 1 && secondVal === 'brand new bio text',
    `the SECOND (visible) call's onConfirm fires exactly once, with what the user actually typed, not stale data (calls=${secondCalls}, got=${JSON.stringify(secondVal)})`);
}

console.log('\ndouble-tapping Save itself must not submit twice (the fix also guards this narrower double-submit variant)');
{
  body._children.length = 0;
  let calls = 0;
  textEntrySheet({ title: 'Notes', value: '', onConfirm: () => { calls++; } });
  teVal.value = 'once';
  vm.runInContext('_teConfirm()', ctx); // first tap on Save
  vm.runInContext('_teConfirm()', ctx); // accidental second tap, same (fading) sheet, before it's actually removed
  ok(calls === 1, `onConfirm fires exactly once even if Save itself is double-tapped (got ${calls})`);
}

console.log('\nthe fix does not break the ordinary single open + single save case');
{
  body._children.length = 0;
  let calls = 0, got = null;
  textEntrySheet({ title: 'Default gym', value: '', onConfirm: v => { calls++; got = v; } });
  ok(body._children.length === 1, 'one sheet opens normally');
  teVal.value = 'Equinox Downtown';
  vm.runInContext('_teConfirm()', ctx);
  ok(calls === 1 && got === 'Equinox Downtown', `Save fires normally with what was typed (calls=${calls}, got=${JSON.stringify(got)})`);
}

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
