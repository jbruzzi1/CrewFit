// Progress page additions (Aug 31) -- client-side half. Server aggregation is covered by
// test/progress-volume-bodyweight.mjs; this drives the real progressScreen/bodyweightChart/
// openBodyweightSheet code in public/app.js via node:vm, same harness family as
// test/suggest-add-exercise-client.mjs / test/audit-v253-client.mjs.
//
// Covers:
//  - Weekly volume meter: one row per non-cardio muscle group, "N / target sets" text, correct
//    fill width, and the fill only gets the "met" (green) class once the target is actually hit --
//    not merely progressed towards, matching the app's "green means earned" color rule.
//  - Weekly volume empty state when nothing has been trained yet this week.
//  - Body weight: empty-state CTA, single-entry state (no chart yet), multi-entry state renders an
//    SVG chart with no crash -- this is the exact bug class the wiring test (xs/ys collision) would
//    have caught at runtime if it had slipped through: bodyweightChart's own scale functions have
//    to actually be in scope where they're used, not just declared.
//  - openBodyweightSheet prefills today's existing entry (upsert-by-day, same as the server test)
//    and posts {weight, unit, date} to /api/me/bodyweight on Save.
//  - PROG_LAST is stashed after every progressScreen() render so the sheet (opened from a button
//    on the page, not passed data directly) has something to read.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };

const SRC = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

function makeEl(tag) {
  const el = {
    tagName: tag || 'DIV', className: '', style: {}, innerHTML: '',
    parentNode: null, _children: [], _removed: false, _classes: new Set(),
    appendChild(child) { child.parentNode = el; el._children.push(child); return child; },
    remove() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener() {}, setAttribute() {}, getAttribute() { return null; }, focus() {},
  };
  el.classList = { add() {}, remove() {}, contains: () => false };
  return el;
}
const body = makeEl('BODY');
const appEl = makeEl('DIV'); // real, inspectable innerHTML -- every progressScreen render is checked through this
const teVal = { value: '', focus() {} };
const genericEl = () => new Proxy(function () {}, {
  get: (t, k) => k === 'children' || k === 'childNodes' ? [] : (k === 'innerText' || k === 'value' || k === 'textContent') ? '' : genericEl(),
  set: () => true, apply: () => genericEl(), has: () => true,
});
const byId = { app: appEl, teVal };
const doc = {
  body, createElement: () => makeEl('DIV'), getElementById: (id) => (id in byId) ? byId[id] : genericEl(),
  querySelector: () => genericEl(), querySelectorAll: () => [],
  addEventListener() {}, documentElement: genericEl(), head: genericEl(), cookie: '', readyState: 'complete',
};

let PROGRESS_FIXTURE = null;   // set per-test before calling progressScreen()
let lastBodyweightPost = null;

function jsonRes(v) { return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(v) }); }
function mockFetch(url, opts) {
  const method = (opts && opts.method) || 'GET';
  if (/^\/api\/progress/.test(url) && method === 'GET') return jsonRes(PROGRESS_FIXTURE);
  if (url === '/api/me/bodyweight' && method === 'POST') {
    lastBodyweightPost = JSON.parse(opts.body);
    return jsonRes({ unit: 'lb', entries: [] });
  }
  return jsonRes({});
}

const historyStub = { pushState() {}, replaceState() {}, go() {}, length: 1 };
const ctx = {
  console: { log() {}, warn() {}, error() {} }, document: doc,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  fetch: mockFetch,
  location: { href: '/', pathname: '/', search: '', hash: '' },
  history: historyStub, addEventListener() {}, removeEventListener() {}, scrollTo() {},
  navigator: { userAgent: 'node', serviceWorker: { register: () => Promise.resolve() }, onLine: true },
  setTimeout, clearTimeout, setInterval, clearInterval,
  alert(msg) { ctx._lastAlert = msg; }, confirm: () => true, prompt: () => null,
  requestAnimationFrame: f => setTimeout(f, 0), matchMedia: () => ({ matches: false, addEventListener() {} }),
  FileReader: function () {}, Image: function () {}, URL, Blob: function () {}, FormData: function () {},
  IntersectionObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
  ResizeObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
};
ctx.window = ctx; ctx.globalThis = ctx; ctx.self = ctx;
vm.createContext(ctx);
vm.runInContext(SRC, ctx, { filename: 'public/app.js' });
await new Promise(r => setTimeout(r, 0)); // let the no-token boot IIFE settle harmlessly

const progressScreen = vm.runInContext('progressScreen', ctx);
const openBodyweightSheet = vm.runInContext('openBodyweightSheet', ctx);
const toggleVolExpanded = vm.runInContext('toggleVolExpanded', ctx);
const getVolExpanded = () => vm.runInContext('VOL_EXPANDED', ctx);

function baseProgress(overrides) {
  return Object.assign({
    unit: 'lb', ready: [], holds: [], soon: [], weeks: [{ weekOf: '2026-08-24', days: 0 }],
    thisWeek: 0, avgPerWeek: 0, streakWeeks: 0,
    trend: { lifts: [], overall: [], allNames: [], picks: [] }, prs: [],
    volume: { weekOf: '2026-08-24', groups: [
      { group: 'chest', sets: 0, target: 12 }, { group: 'lats', sets: 0, target: 12 },
      { group: 'shoulders', sets: 0, target: 12 }, { group: 'traps', sets: 0, target: 8 },
      { group: 'biceps', sets: 0, target: 10 }, { group: 'triceps', sets: 0, target: 10 },
      { group: 'forearms', sets: 0, target: 6 }, { group: 'quads', sets: 0, target: 12 },
      { group: 'hamstrings', sets: 0, target: 10 }, { group: 'glutes', sets: 0, target: 10 },
      { group: 'calves', sets: 0, target: 10 }, { group: 'abdominals', sets: 0, target: 10 },
    ] },
    bodyweight: { unit: 'lb', entries: [] },
  }, overrides);
}

console.log('weekly volume: empty state when nothing trained this week');
{
  PROGRESS_FIXTURE = baseProgress();
  await progressScreen({ silent: true });
  const html = appEl.innerHTML;
  ok(html.includes('Weekly volume'), 'section heading renders');
  ok(html.includes("Log some working sets this"), 'shows the empty-state note (got no match)');
  ok(!html.includes('mv-row'), 'no meter rows rendered when nothing trained yet');
}

console.log('weekly volume: rows render with correct fill and "met" state (expanded view)');
{
  const vol = baseProgress().volume;
  vol.groups = vol.groups.map(g => {
    if (g.group === 'quads') return { group: 'quads', sets: 6, target: 12 };   // 50%, under target
    if (g.group === 'glutes') return { group: 'glutes', sets: 12, target: 10 }; // over target -> met
    return g;
  });
  PROGRESS_FIXTURE = baseProgress({ volume: vol });
  // Quads and Glutes both have SOME volume, so a "worst-first" collapsed top-5 (see the dedicated
  // collapse/expand block below) would push them out in favor of the fully-untrained groups --
  // expand first so this block can test row rendering (fill/labels/met-class) in isolation.
  if (!getVolExpanded()) toggleVolExpanded();
  await progressScreen({ silent: true });
  const html = appEl.innerHTML;
  ok(html.includes('mv-row'), 'meter rows render once something has been trained');
  ok(html.includes('Quads'), 'display label used (MUSCLE_LABEL), not the raw key (got no "Quads")');
  ok(html.includes('6 / 12 sets') || html.includes('6<span class="mv-of"> / 12 sets'), 'shows "N / target sets" for quads');
  const quadsBlock = html.slice(html.indexOf('Quads'), html.indexOf('Quads') + 260);
  ok(quadsBlock.includes('width:50%'), `quads fill is at 50% (got ${quadsBlock.slice(0, 260)})`);
  ok(!quadsBlock.includes('mv-met'), 'quads (under target) does NOT get the "met" class');
  const glutesBlock = html.slice(html.indexOf('Glutes'), html.indexOf('Glutes') + 260);
  ok(glutesBlock.includes('mv-met'), 'glutes (at/over target) DOES get the "met" class');
  ok(!html.includes('Cardio'), 'cardio never appears as a volume row');
  if (getVolExpanded()) toggleVolExpanded(); // reset for later blocks
}

console.log('weekly volume: collapsed by default to the 5 most-neglected groups, "Show all" expands');
{
  const vol = baseProgress().volume;
  // Give every group SOME distinguishing value so sort order is unambiguous: quads and glutes
  // are well-trained (should be pushed OUT of the default view), everything else is untouched
  // (0 sets -- equally "most neglected," so the collapsed 5 should be 5 of those, never quads/glutes).
  vol.groups = vol.groups.map(g => {
    if (g.group === 'quads') return { group: 'quads', sets: 12, target: 12 };
    if (g.group === 'glutes') return { group: 'glutes', sets: 10, target: 10 };
    return g;
  });
  PROGRESS_FIXTURE = baseProgress({ volume: vol });
  ok(getVolExpanded() === false, 'starts collapsed (sanity check on the reset above)');

  await progressScreen({ silent: true });
  let html = appEl.innerHTML;
  const rowCount = (html.match(/class="mv-row"/g) || []).length;
  ok(rowCount === 5, `collapsed view shows exactly 5 rows (got ${rowCount})`);
  ok(!html.includes('Quads') && !html.includes('Glutes'), 'the two fully-trained groups are pushed out of the neglected-first top 5');
  ok(html.includes('Show all 12'), `"Show all N" control is offered (got no match in: ${html.slice(html.indexOf('Weekly volume'), html.indexOf('Weekly volume') + 200)})`);
  ok(!html.includes('Show fewer'), 'collapsed view does not offer "Show fewer"');

  toggleVolExpanded();
  await new Promise(r => setTimeout(r, 0));
  html = appEl.innerHTML;
  const rowCount2 = (html.match(/class="mv-row"/g) || []).length;
  ok(rowCount2 === 12, `expanded view shows all 12 rows (got ${rowCount2})`);
  ok(html.includes('Quads') && html.includes('Glutes'), 'expanded view includes the previously-hidden trained groups');
  ok(html.includes('Show fewer'), 'expanded view offers "Show fewer" instead');
  // Anatomical order restored when expanded (server's MUSCLE_ORDER), not sort order --
  // Chest is first in MUSCLE_TARGETS/MUSCLE_ORDER, so it should be the first row again.
  ok(html.indexOf('Chest') < html.indexOf('Quads'), 'expanded view is back in natural anatomical order, not neglect-sorted');

  toggleVolExpanded(); // reset for later blocks
  ok(getVolExpanded() === false, 'toggled back to collapsed');
}

console.log('body weight: empty state offers a CTA, no chart');
{
  PROGRESS_FIXTURE = baseProgress();
  await progressScreen({ silent: true });
  const html = appEl.innerHTML;
  ok(html.includes('Body weight'), 'section heading renders');
  ok(html.includes('Not tracked yet'), 'empty state message renders');
  ok(html.includes('openBodyweightSheet()'), 'a control opens the log sheet');
  ok(!html.includes('<svg'), 'no chart svg with zero entries');
}

console.log('body weight: one entry shows the value but not a chart yet');
{
  PROGRESS_FIXTURE = baseProgress({ bodyweight: { unit: 'lb', entries: [{ date: '2026-08-30', weight: 181 }] } });
  await progressScreen({ silent: true });
  const html = appEl.innerHTML;
  ok(html.includes('181'), 'the single logged weight is shown');
  ok(html.includes('One more entry starts the chart'), 'explains the chart needs a second point');
  ok(!html.includes('<svg'), 'still no chart svg with only one entry');
}

console.log('body weight: two+ entries render a real chart with no crash and a neutral delta');
{
  PROGRESS_FIXTURE = baseProgress({ bodyweight: { unit: 'lb', entries: [
    { date: '2026-08-24', weight: 182 }, { date: '2026-08-27', weight: 180.5 }, { date: '2026-08-30', weight: 179 },
  ] } });
  await progressScreen({ silent: true }); // this is the call that would throw ReferenceError: xs/ys is not defined if bodyweightChart's own scale fns weren't correctly in scope
  const html = appEl.innerHTML;
  ok(html.includes('<svg'), 'chart svg renders for 3 entries');
  ok(html.includes('179'), 'latest weight is the headline value');
  ok(html.includes('-3 lb since'), 'delta since first entry is shown, plainly signed (got no match)');
  ok(!/class="drv-p up"|class="drv-p flat"/.test(html), 'delta is NOT colored via the green "up"/achievement class -- direction is not a judgment here');
}

console.log('openBodyweightSheet: prefills today\'s existing entry and posts on save');
{
  const today = new Date().toISOString().slice(0, 10);
  PROGRESS_FIXTURE = baseProgress({ bodyweight: { unit: 'lb', entries: [{ date: today, weight: 175 }] } });
  await progressScreen({ silent: true }); // populates PROG_LAST
  openBodyweightSheet();
  // The fake DOM doesn't parse innerHTML into a real prefilled <input> (teVal.value never moves on
  // its own here -- see the identical caveat in test/text-entry-double-tap.mjs), so check the sheet
  // markup itself for the prefilled value attribute rather than a live input property.
  const sheetHtml = body._children[body._children.length - 1].innerHTML;
  ok(sheetHtml.includes('value="175"'), `sheet markup prefills today's already-logged weight (got ${sheetHtml.slice(0, 200)})`);
  teVal.value = '174.5';
  lastBodyweightPost = null;
  vm.runInContext('_teConfirm()', ctx);
  await new Promise(r => setTimeout(r, 0));
  ok(!!lastBodyweightPost, 'Save posts to /api/me/bodyweight');
  ok(lastBodyweightPost && lastBodyweightPost.weight === 174.5, `posts the typed weight (got ${lastBodyweightPost && lastBodyweightPost.weight})`);
  ok(lastBodyweightPost && lastBodyweightPost.date === today, `posts today's local date (got ${lastBodyweightPost && lastBodyweightPost.date})`);
  ok(lastBodyweightPost && lastBodyweightPost.unit === 'lb', `posts the user's current unit (got ${lastBodyweightPost && lastBodyweightPost.unit})`);
}

console.log(fails ? `\n${fails} FAILURE(S)\n` : '\nall assertions passed\n');
process.exit(fails ? 1 : 0);
