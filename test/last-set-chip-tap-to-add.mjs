// Sep 9 2026 (Jeff: "the tap to use function should automatically record that set - I should have
// to select tap to use then click add. it should be tap to add instead I feel - one less click"):
// useLastSet() used to only fill the weight/reps boxes, leaving +Add as a still-required second
// tap (see lastSetChipHtml's own history comment in app.js for why that extra step existed in the
// first place). It now fills the boxes AND immediately calls addLogSet() itself -- the chip *is*
// the add action now, not a shortcut into it.
//
// This drives the real useLastSet()/addLogSet() out of app.js in node:vm against a fake exercise
// card and a fake fetch (same harness shape as test/inline-log-cards.mjs), and proves: tapping the
// chip posts exactly the last-set weight/reps as a real logged set (not just fills boxes and
// stops), the boxes end up blank afterward (proof it actually submitted, not merely populated),
// the existing double-tap guard (ADDLOG_BUSY) still applies to a rapid second tap on the chip
// itself, and the label text really reads "Tap to add" now.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const SRC = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

function field(initial) {
  return { value: initial === undefined ? '' : initial,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, style: {}, addEventListener() {}, focus() {} };
}
function chip(on) { return { getAttribute: (k) => k === 'data-t' ? on : null, classList: { add() {}, remove() {}, toggle() {}, contains: () => false } }; }

const w = field(''), r = field(''), rir = field(''), rirBtn = field('');
const typeSeg = { querySelector: (sel) => sel === '.chip.on' ? chip('normal') : null };
const sets = { innerHTML: '' };
const lastRef = { innerHTML: '' };
// Sep 10 2026: startRest() (app.js) looks up two sibling buttons inside the '.rest' element it
// just rendered -- '.rest-main' (opens the edit popup) and '.rest-x' (dismisses). This stub keeps
// drifting behind startRest's real shape as that markup evolves (round 1 added '.rest-x', round 2's
// cold-review pass split the old div[role=button] into '.rest-main' + '.rest-x' siblings) -- match
// whatever startRest actually queries for so this fake DOM doesn't lag behind it again.
const rest = { innerHTML: '', querySelector: (sel) => sel === '.rest' ? {
  querySelector: (s2) => (s2 === '.rest-main' || s2 === '.rest-x') ? { onclick: null } : null
} : null };
const rec = { innerHTML: '' };

const FIELDS = { w, r, rir, rirBtn, typeSeg, sets, lastRef, rest, rec };
const cardEl = {
  dataset: { sid: 's1', ex: 'exA', load: '', rec: '' },
  querySelector: (sel) => { const m = sel.match(/data-f="([^"]+)"/); return m ? (FIELDS[m[1]] || null) : null; },
  querySelectorAll: () => [],
};

const posts = [];
let nextLogId = 1;
const LOGS = [];   // simulated server-side log history for this exercise, across calls in this test
function fetchStub(url, opts) {
  const method = (opts && opts.method) || 'GET';
  if (method === 'POST' && url.includes('/log')) {
    const body = JSON.parse(opts.body);
    posts.push(body);
    const entry = { id: 'log' + (nextLogId++), exerciseId: 'exA', weight: Number(body.weight) || 0, reps: Number(body.reps) || 0,
      set: LOGS.length + 1, setType: body.setType || 'normal', isPr: false, isSetPr: false, at: new Date().toISOString() };
    LOGS.push(entry);
    return Promise.resolve({ status: 200, json: () => Promise.resolve({ logs: { u1: LOGS.slice() } }) });
  }
  return Promise.resolve({ status: 200, json: () => Promise.resolve({}) });
}

const doc = { body: { contains: () => true }, createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, innerHTML: '' }),
  getElementById: () => ({ classList: { toggle() {}, add() {}, remove() {}, contains: () => false } }),
  querySelector: (sel) => sel === '.ex-log[data-ex="exA"]' ? cardEl : null,
  querySelectorAll: () => [], addEventListener() {}, documentElement: { style: {} }, head: {}, cookie: '', readyState: 'complete' };

const ctx = { console: { log() {}, warn() {}, error() {} }, document: doc,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  fetch: fetchStub,
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
vm.runInContext('TOKEN = "t"', ctx);
const useLastSet = vm.runInContext('useLastSet', ctx);

const tick = () => new Promise(res => setTimeout(res, 20));

console.log('tapping "Last set" logs the set directly -- no separate +Add needed');
{
  useLastSet('exA', 185, 5);
  await tick();
  ok(posts.length === 1, `exactly one POST fired from a single tap (got ${posts.length})`);
  ok(posts[0] && Number(posts[0].weight) === 185 && Number(posts[0].reps) === 5, `posted the last set's own weight/reps (got ${JSON.stringify(posts[0])})`);
  ok(posts[0] && posts[0].setType === 'normal', `used whatever set type was selected on the card (got ${posts[0] && posts[0].setType})`);
  ok(w.value === '' && r.value === '', 'the weight/reps boxes end up blank afterward -- proof this actually SUBMITTED the set rather than just filling the boxes and stopping there');
}

console.log('a rapid second tap while the first is still in flight is ignored -- the existing double-tap guard covers the chip too, not just the +Add button');
{
  vm.runInContext('ADDLOG_BUSY = true', ctx);
  useLastSet('exA', 185, 5);
  await tick();
  ok(posts.length === 1, `no second POST fired while ADDLOG_BUSY was set (got ${posts.length} total)`);
  vm.runInContext('ADDLOG_BUSY = false', ctx);
}

console.log('a second GENUINE tap (not a double-tap on the same one) logs a second set normally');
{
  useLastSet('exA', 185, 5);
  await tick();
  ok(posts.length === 2, `a fresh tap after the guard cleared posts again (got ${posts.length} total)`);
}

console.log('\nthe chip label really reads "Tap to add" now, not "Tap to use"');
{
  ok(SRC.includes('Tap to add'), '"Tap to add" appears in app.js');
  ok(!/lsc-tap">Tap to use/.test(SRC), 'the old "Tap to use" wording is gone');
}

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
