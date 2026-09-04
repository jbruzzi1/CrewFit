// v312 (Jeff, Sep 4): "get rid of the logging page and have it all on the active workout page."
// Every exercise card on the active workout is its own logger, and logging a set repaints THAT
// card's set rows in place (renderExSets) -- never the page, never another card. This drives the
// real exSetRowsHtml()/renderExSets() out of app.js in node:vm against two fake cards and proves
// the rows land in the right card, read like the posted-workout view's rows (W/D/F badge or set
// number, "143 lb × 12 reps", PR, Edit), and leave the other card alone.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const SRC = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

const el = () => ({ innerHTML: '', style: {}, value: '', classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] });
const card = (sid, ex, load) => { const sets = el(); const c = { dataset: { sid, ex, load: load || '', rec: 'x' }, sets,
  querySelector: (sel) => sel === '[data-f="sets"]' ? sets : null, querySelectorAll: () => [] }; return c; };
const A = card('s1', 'exA', 'pair'), B = card('s1', 'exB', '');
B.sets.innerHTML = 'UNTOUCHED';
const doc = { body: Object.assign(el(), { contains: () => true }), createElement: () => el(), getElementById: () => el(),
  querySelector: (sel) => sel === '.ex-log[data-ex="exA"]' ? A : sel === '.ex-log[data-ex="exB"]' ? B : null,
  querySelectorAll: () => [], addEventListener() {}, documentElement: el(), head: el(), cookie: '', readyState: 'complete' };
const ctx = { console: { log() {}, warn() {}, error() {} }, document: doc,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  fetch: () => Promise.resolve({ json: () => Promise.resolve({}), status: 200, text: () => Promise.resolve('') }),
  location: { href: '/', pathname: '/', search: '', hash: '' }, history: { replaceState() {}, pushState() {} },
  addEventListener() {}, removeEventListener() {}, scrollTo() {},
  navigator: { userAgent: 'node', serviceWorker: { register: () => Promise.resolve() }, onLine: true },
  setTimeout, clearTimeout, setInterval, clearInterval, alert() {}, confirm: () => true, prompt: () => null,
  requestAnimationFrame: f => setTimeout(f, 0), matchMedia: () => ({ matches: false, addEventListener() {} }),
  FileReader: function () {}, Image: function () {}, URL, Blob: function () {}, FormData: function () {},
  IntersectionObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
  ResizeObserver: function () { this.observe = () => {}; this.disconnect = () => {}; } };
ctx.window = ctx; ctx.globalThis = ctx; ctx.self = ctx;
vm.createContext(ctx);
vm.runInContext(SRC, ctx, { filename: 'public/app.js' });
vm.runInContext('ME = {id:"u1", units:"lb"}', ctx);
const renderExSets = vm.runInContext('renderExSets', ctx);

console.log('renderExSets() paints one card, in place, and leaves the others alone');
{
  const s = { logs: { u1: [
    { id: 'l1', exerciseId: 'exA', set: 1, weight: 99, reps: 12, setType: 'warmup', loadType: 'pair' },
    { id: 'l2', exerciseId: 'exA', set: 2, weight: 143, reps: 12, setType: 'normal', loadType: 'pair' },
    { id: 'l3', exerciseId: 'exA', set: 3, weight: 143, reps: 15, setType: 'normal', loadType: 'pair', rir: 1, isPr: true },
    { id: 'l9', exerciseId: 'exB', set: 1, weight: 500, reps: 1, setType: 'normal' },
  ] } };
  renderExSets('exA', s, 'l3');
  const html = A.sets.innerHTML;
  ok((html.match(/class="pp-set /g) || []).length === 3, `card A got exactly its 3 sets (got ${(html.match(/class="pp-set /g) || []).length})`);
  ok(!html.includes('500'), "card B's set did not leak into card A");
  ok(B.sets.innerHTML === 'UNTOUCHED', 'card B was not touched at all');
  ok(/pp-set-n warm">W</.test(html), 'a warm-up set shows the W badge instead of a number');
  ok(html.includes('99 lb each × 12 reps') && html.includes('143 lb each × 15 reps · RIR 1'), 'rows read "99 lb each × 12 reps" (per-dumbbell suffix from the stamped loadType) and carry RIR when tracked');
  ok(/pp-pr pr-pop">PR</.test(html) && (html.match(/pp-pr/g) || []).length === 1, 'the PR pill sits on the record set only, and pops because it was just logged');
  ok((html.match(/pp-set-edit/g) || []).length === 3 && html.includes(`editLogSet('s1','exA','l2')`), 'every row has Edit wired to the small Edit-set sheet for that set');
}

console.log('\nan exercise with nothing logged reads "No sets yet"; a card that is not on screen is a no-op');
{
  renderExSets('exA', { logs: { u1: [] } });
  ok(A.sets.innerHTML.includes('No sets yet'), 'empty card copy');
  let threw = false; try { renderExSets('exZ', { logs: {} }); } catch (e) { threw = true; }
  ok(!threw, 'renderExSets on a card that is not in the DOM does nothing rather than throwing (a slow response after leaving the page)');
}

console.log('\nthe old per-exercise log sheet is really gone');
ok(!/function openLogSheet\b/.test(SRC) && !SRC.includes("openLogSheet("), 'no openLogSheet() left anywhere in app.js');
ok(!/\bLOGVIEW\b/.test(SRC.replace(/\/\/.*$/gm, '')), 'no LOGVIEW global left in code (comments aside)');

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
