// Progress page additions (Aug 31) -- client-side half. Server aggregation is covered by
// test/progress-volume-bodyweight.mjs; this drives the real progressScreen/bodyweightChart/
// openBodyweightSheet code in public/app.js via node:vm, same harness family as
// test/suggest-add-exercise-client.mjs / test/audit-v253-client.mjs.
//
// Covers:
//  - Volume trend: one row per non-cardio muscle group, "N / target sets" text, correct fill
//    width, and the fill only gets the "met" (green) class once the target is actually hit -- not
//    merely progressed towards, matching the app's "green means earned" color rule. (This section
//    has gone through several redesigns since Aug 31 -- see the big comment above volTrendChart in
//    app.js for the full history. As of round 6 it is just ONE bar-row list plus a This week/Month/
//    3 months range picker: no "Overall"/"Pick a muscle" chips, no picker sheet, no per-muscle SVG
//    chart -- every muscle always shows as its own row, all the time.)
//  - Empty state when nothing has been trained yet this week.
//  - Body weight: empty-state CTA, single-entry state (no chart yet), multi-entry state renders an
//    SVG chart with no crash -- this is the exact bug class the wiring test (xs/ys collision) would
//    have caught at runtime if it had slipped through: bodyweightChart's own scale functions have
//    to actually be in scope where they're used, not just declared.
//  - openBodyweightSheet prefills today's existing entry (upsert-by-day, same as the server test)
//    and posts {weight, unit, date} to /api/me/bodyweight on Save.
//  - PROG_LAST is stashed after every progressScreen() render so the sheet (opened from a button
//    on the page, not passed data directly) has something to read.
//  - This week/Month/3 months range picker (round 6, replacing the earlier This-week/4-wk-avg
//    2-way toggle): the pill markup, the range-dependent numbers (with a "/wk" suffix and switched
//    rulenote copy on the two longer ranges), and specifically that the collapsed 5-row selection
//    is PINNED to "This week" ranking regardless of which range is being viewed -- a real bug Jeff
//    caught in the first draft, where tapping the toggle could swap out which muscles even
//    appeared, not just their numbers.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
// The "Volume trend" section is the only place mv-rows / muscle names show up on this page -- so a
// bare html.includes('Quads') against the WHOLE page is a reliable proxy for "is Quads shown as a
// bar row" EXCEPT where it could collide with Strength trend's own "Overall" chip label further
// down the page. Scope checks to just this section's own markup, between its heading and the next
// one (Consistency), to stay safe either way.
const trendSection = html => html.slice(html.indexOf('Volume trend'), (() => { const i = html.indexOf('Consistency'); return i === -1 ? html.length : i; })());

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
const setVolMode = vm.runInContext('setVolMode', ctx);
const getVolMode = () => vm.runInContext('VOL_MODE', ctx);

function emptyGroups(overrides) {
  const base = [
    { group: 'chest', sets: 0, target: 12 }, { group: 'lats', sets: 0, target: 12 },
    { group: 'shoulders', sets: 0, target: 12 }, { group: 'traps', sets: 0, target: 8 },
    { group: 'biceps', sets: 0, target: 10 }, { group: 'triceps', sets: 0, target: 10 },
    { group: 'forearms', sets: 0, target: 6 }, { group: 'quads', sets: 0, target: 12 },
    { group: 'hamstrings', sets: 0, target: 10 }, { group: 'glutes', sets: 0, target: 10 },
    { group: 'calves', sets: 0, target: 10 }, { group: 'abdominals', sets: 0, target: 10 },
  ];
  if (!overrides) return base;
  return base.map(g => overrides[g.group] !== undefined ? { group: g.group, sets: overrides[g.group], target: g.target } : g);
}

function baseProgress(overrides) {
  return Object.assign({
    unit: 'lb', ready: [], holds: [], soon: [], weeks: [{ weekOf: '2026-08-24', days: 0 }],
    thisWeek: 0, avgPerWeek: 0, streakWeeks: 0,
    trend: { lifts: [], overall: [], allNames: [], picks: [] }, prs: [],
    volume: { weekOf: '2026-08-24', weeks: 1, groups: emptyGroups() },
    volumeAvg: { weekOf: '2026-08-10', weeks: 4, groups: emptyGroups() },
    volume3mo: { weekOf: '2026-06-02', weeks: 13, groups: emptyGroups() },
    bodyweight: { unit: 'lb', entries: [] },
  }, overrides);
}

console.log('volume trend: empty state when nothing trained in any range');
{
  PROGRESS_FIXTURE = baseProgress();
  await progressScreen({ silent: true });
  const html = appEl.innerHTML;
  ok(html.includes('Volume trend'), 'section heading renders');
  ok(html.includes("Log some working sets this"), 'shows the empty-state note (got no match)');
  ok(!html.includes('mv-row'), 'no meter rows rendered when nothing trained yet');
  ok(!html.includes(`onclick="setVolMode`), 'no range picker when This week, Month AND 3 months are all truly empty');
}

console.log('volume trend: range picker still shows when THIS WEEK is empty but Month has data (cold-review catch, carried forward)');
{
  // Real bug caught by cold review: the toggle used to be gated on the CURRENTLY DISPLAYED range's
  // data. A fresh page load always starts on "This week," so a week with nothing logged yet -- the
  // exact scenario this whole feature exists for -- hid the other ranges entirely, even though a
  // longer window had real data to show. The toggle must be offered whenever ANY range has
  // something, not just the one currently on screen.
  PROGRESS_FIXTURE = baseProgress({ volumeAvg: { weekOf: '2026-08-10', weeks: 4, groups: emptyGroups({ chest: 6 }) } }); // volume (this week) and volume3mo stay all-zero
  ok(getVolMode() === 'week', 'starts on "This week" (sanity check)');

  await progressScreen({ silent: true });
  const html = appEl.innerHTML;
  ok(html.includes("Log some working sets this"), 'This week itself still shows its own empty state (got no match)');
  ok(!html.includes('mv-row'), 'no rows rendered while on the empty "This week" view');
  ok(html.includes(`onclick="setVolMode('month')"`), 'the "Month" button IS offered even though this week is empty (this was the bug)');

  setVolMode('month');
  await new Promise(r => setTimeout(r, 0));
  const html2 = appEl.innerHTML;
  ok(html2.includes('mv-row') && html2.includes('Chest'), 'switching to Month reveals the real data (got no match)');
  setVolMode('week'); // reset for later blocks
  await new Promise(r => setTimeout(r, 0));
}

console.log('volume trend: rows render with correct fill and "met" state (expanded view)');
{
  PROGRESS_FIXTURE = baseProgress({ volume: { weekOf: '2026-08-24', weeks: 1, groups: emptyGroups({ quads: 6, glutes: 12 }) } });
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

console.log('volume trend: collapsed by default to the 5 most-neglected groups, "Show all" expands');
{
  // Give every group SOME distinguishing value so sort order is unambiguous: quads and glutes are
  // well-trained (should be pushed OUT of the default view), everything else is untouched (0 sets
  // -- equally "most neglected," so the collapsed 5 should be 5 of those, never quads/glutes).
  PROGRESS_FIXTURE = baseProgress({ volume: { weekOf: '2026-08-24', weeks: 1, groups: emptyGroups({ quads: 12, glutes: 10 }) } });
  ok(getVolExpanded() === false, 'starts collapsed (sanity check on the reset above)');

  await progressScreen({ silent: true });
  let html = appEl.innerHTML;
  const rowCount = (html.match(/class="mv-row"/g) || []).length;
  ok(rowCount === 5, `collapsed view shows exactly 5 rows (got ${rowCount})`);
  ok(!trendSection(html).includes('Quads') && !trendSection(html).includes('Glutes'), 'the two fully-trained groups are pushed out of the neglected-first top 5');
  ok(html.includes('Show all 12'), `"Show all N" control is offered (got no match in: ${html.slice(html.indexOf('Volume trend'), html.indexOf('Volume trend') + 200)})`);
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

console.log('volume trend: This week/Month/3 months range picker -- pinned row selection, range-dependent numbers, per-range suffix and rulenote');
{
  // Jeff, Aug 31 (round 2, still true for the round-6 3-way picker): tapping the toggle must NOT
  // reshuffle which 5 muscles show in the collapsed view -- only their numbers. This week:
  // quads/glutes are well-trained (pushed out of the neglected-first top 5, same setup as the
  // collapse/expand block above), everything else 0. Month: chest is now fully "met" (12/12) -- if
  // the collapsed selection re-ranked per range (the bug Jeff caught), chest would drop OUT of the
  // list once its Month number looks good, replaced by some other zero group. Pinning selection to
  // THIS WEEK's ranking means chest stays visible (still flagged, because it really was skipped
  // this week), just showing its better Month/3-month number.
  PROGRESS_FIXTURE = baseProgress({
    volume: { weekOf: '2026-08-24', weeks: 1, groups: emptyGroups({ quads: 12, glutes: 10 }) },
    volumeAvg: { weekOf: '2026-08-10', weeks: 4, groups: emptyGroups({ chest: 12, lats: 6, quads: 8, glutes: 7 }) },
    volume3mo: { weekOf: '2026-06-02', weeks: 13, groups: emptyGroups({ chest: 3, lats: 2, quads: 5, glutes: 4 }) },
  });
  ok(getVolMode() === 'week', 'starts on "This week" (sanity check)');

  await progressScreen({ silent: true });
  let html = appEl.innerHTML;
  ok(html.includes(`class="on" onclick="setVolMode('week')"`), '"This week" pill is active by default');
  ok(!html.includes(`class="on" onclick="setVolMode('month')"`), '"Month" pill is not active by default');
  let rowCount = (html.match(/class="mv-row"/g) || []).length;
  ok(rowCount === 5, `collapsed to 5 rows in week mode (got ${rowCount})`);
  ok(html.includes('Chest') && html.includes('Back') && html.includes('Shoulders') && html.includes('Traps') && html.includes('Biceps'),
    'the 5 zero-ratio-this-week groups are shown (got: ' + html.slice(html.indexOf('Volume trend'), html.indexOf('Volume trend') + 400) + ')');
  ok(!trendSection(html).includes('Quads') && !trendSection(html).includes('Glutes'), 'well-trained-this-week groups stay excluded');
  ok(html.includes('working sets logged this week'), 'rulenote uses the weekly wording');

  setVolMode('month');
  await new Promise(r => setTimeout(r, 0));
  html = appEl.innerHTML;
  ok(getVolMode() === 'month', 'setVolMode switched to Month');
  ok(html.includes(`class="on" onclick="setVolMode('month')"`), '"Month" pill is now active');
  ok(!html.includes(`class="on" onclick="setVolMode('week')"`), '"This week" pill is no longer active');
  rowCount = (html.match(/class="mv-row"/g) || []).length;
  ok(rowCount === 5, `still exactly 5 rows after switching to Month (got ${rowCount})`);
  ok(html.includes('Chest') && html.includes('Back') && html.includes('Shoulders') && html.includes('Traps') && html.includes('Biceps'),
    'SAME 5 rows as week mode -- selection is pinned, not re-ranked per range (got: ' + html.slice(html.indexOf('Volume trend'), html.indexOf('Volume trend') + 400) + ')');
  ok(!trendSection(html).includes('Quads') && !trendSection(html).includes('Glutes'),
    'quads/glutes still excluded in Month view even though their Month numbers differ from their week numbers');
  let chestBlock = html.slice(html.indexOf('Chest'), html.indexOf('Chest') + 260);
  ok(chestBlock.includes('/ 12 sets/wk'), `chest shows the Month number with "/wk" suffix, not the week number (got ${chestBlock.slice(0, 200)})`);
  ok(chestBlock.includes('mv-met'), 'chest is now "met" using its Month value (12/12), proving the NUMBER did update even though the row stayed');
  ok(html.includes('average working sets per week over the trailing month'), 'rulenote switches to the Month wording');

  setVolMode('3mo');
  await new Promise(r => setTimeout(r, 0));
  html = appEl.innerHTML;
  ok(getVolMode() === '3mo', 'setVolMode switched to 3 months');
  ok(html.includes(`class="on" onclick="setVolMode('3mo')"`), '"3 months" pill is now active');
  rowCount = (html.match(/class="mv-row"/g) || []).length;
  ok(rowCount === 5, `still exactly 5 rows after switching to 3 months (got ${rowCount})`);
  ok(!trendSection(html).includes('Quads') && !trendSection(html).includes('Glutes'), 'quads/glutes still excluded in the 3-month view too -- ranking never re-sorts');
  chestBlock = html.slice(html.indexOf('Chest'), html.indexOf('Chest') + 260);
  ok(chestBlock.includes('3<span class="mv-of"> / 12 sets/wk'), `chest shows the 3-month number with "/wk" suffix (got ${chestBlock.slice(0, 200)})`);
  ok(!chestBlock.includes('mv-met'), 'chest is NOT "met" at its lower 3-month average (3/12) -- proves this is really a different number from Month, not a stale re-render');
  ok(html.includes('average working sets per week over the trailing 3 months'), 'rulenote switches to the 3-month wording');

  setVolMode('week'); // reset for later blocks
  await new Promise(r => setTimeout(r, 0));
  ok(getVolMode() === 'week', 'reset back to "This week"');
}

console.log('volume trend: round 6 -- no "Overall"/"Pick a muscle" chips and no picker sheet anymore; just the bar list and the range picker');
{
  // Jeff: "I dont feel like we need the separate SVG report, overall pill box, and muscle picker if
  // we show the volume trend in the main bar graph." Confirms the whole chip/picker mechanism from
  // rounds 2-5 is genuinely gone, not just unused -- both the markup AND the functions themselves.
  PROGRESS_FIXTURE = baseProgress({ volume: { weekOf: '2026-08-24', weeks: 1, groups: emptyGroups({ quads: 6 }) } });
  await progressScreen({ silent: true });
  const sec = trendSection(appEl.innerHTML);
  ok(!sec.includes('class="chip'), 'no chip markup anywhere in the Volume trend section (got a match)');
  ok(!sec.includes('Pick a muscle'), '"Pick a muscle" no longer appears at all (got a match)');
  ok(!sec.includes('<svg'), 'no per-muscle SVG chart either -- the bar list is the only visual');
  for (const fn of ['setTrendVolPick', 'openVolTrendPicker', 'pickVolTrendMuscle', 'renderVolTrendPicker']) {
    ok(vm.runInContext(`typeof ${fn}`, ctx) === 'undefined', `${fn} no longer exists in app.js (got ${vm.runInContext(`typeof ${fn}`, ctx)})`);
  }
  ok(vm.runInContext(`typeof TREND_VOL_PICK`, ctx) === 'undefined', 'TREND_VOL_PICK no longer exists in app.js');
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

// Consistency card only, between its own heading and Strength trend's -- same scoping reasoning
// as trendSection above.
const consistencySection = html => html.slice(html.indexOf('Consistency'), (() => { const i = html.indexOf('Strength trend'); return i === -1 ? html.length : i; })());

console.log('Consistency: streak leads the card (round Sep 2, replacing the average-led/badge version)');
{
  // Jeff's iteration on this card, in order: rejected a calendar/heatmap grid on looks alone
  // ("Don't like the grid/squares look" -- bar chart stays untouched); rejected the streak in
  // green ("i dont think so on this report" -- green stays reserved for earned/celebratory
  // moments elsewhere, not a permanent hero color); rejected the hero digit in bold ("don't
  // bolden the number like that" -- .streak-hero is a light weight instead of .hero's bold); and
  // asked whether the bars themselves are self-explanatory ("will people know what they mean?"),
  // answered with a "How it works" line matching every other card on this page.
  PROGRESS_FIXTURE = baseProgress({
    weeks: [
      { weekOf: '2026-07-27', days: 3 }, { weekOf: '2026-08-03', days: 2 },
      { weekOf: '2026-08-10', days: 4 }, { weekOf: '2026-08-17', days: 3 },
      { weekOf: '2026-08-24', days: 2 },
    ],
    thisWeek: 2, avgPerWeek: 2.8, streakWeeks: 5,
  });
  await progressScreen({ silent: true });
  const html = appEl.innerHTML;
  const section = consistencySection(html);

  ok(section.includes('class="streak-hero"'), 'the streak number uses the light-weight .streak-hero class, not the bold .hero class');
  ok(!/<div class="hero">5<span/.test(section), 'the streak digit itself is NOT rendered inside a bold .hero div (got a hero-wrapped "5")');
  ok(section.includes('>5<') && section.includes('week streak'), `streak count and label render (got ${section.slice(0, 200)})`);
  ok(section.includes('2.8 days/week average'), 'the average is demoted to the caption line, not the headline, when a streak exists');
  ok(!/style="[^"]*color:var\(--green\)/.test(section), 'the streak hero is NOT colored green (rejected -- green stays reserved for earned/celebratory moments)');
  ok(!section.includes('class="streak"'), 'the old small streak badge is gone, folded into the hero instead');
  ok(section.includes('<b>How it works:</b>') && section.includes('each bar is one week'),
    `a "How it works" line explains the bars, matching Add weight/Volume trend's own pattern (got ${section.includes('How it works') ? 'present but wrong text' : 'missing entirely'})`);
}

console.log('Consistency: no active streak falls back to the plain average as the hero (unchanged from before)');
{
  PROGRESS_FIXTURE = baseProgress({
    weeks: [{ weekOf: '2026-08-17', days: 0 }, { weekOf: '2026-08-24', days: 2 }],
    thisWeek: 2, avgPerWeek: 2, streakWeeks: 0,
  });
  await progressScreen({ silent: true });
  const section = consistencySection(appEl.innerHTML);
  ok(section.includes('class="hero">2.0<span'), `with no streak, the average is still the plain bold .hero (got ${section.slice(0, 300)})`);
  ok(!section.includes('class="streak-hero"'), 'no streak-hero markup renders when streakWeeks is 0');
  ok(!section.includes('week streak'), 'no "week streak" text renders when streakWeeks is 0');
}

console.log('Consistency: "How it works" line is absent on the true empty state (nothing trained ever)');
{
  PROGRESS_FIXTURE = baseProgress(); // default weeks: all zero, streakWeeks: 0
  await progressScreen({ silent: true });
  const section = consistencySection(appEl.innerHTML);
  ok(!section.includes('<b>How it works:</b>'), `no rulenote when there is no chart to explain yet (got ${section.slice(0, 400)})`);
  ok(section.includes('No workouts logged yet'), 'shows the true empty state instead (got no match)');
}

console.log(fails ? `\n${fails} FAILURE(S)\n` : '\nall assertions passed\n');
process.exit(fails ? 1 : 0);
