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
//  - "This week"/"4-wk avg" toggle (Aug 31, round 2): the pill markup, the mode-dependent numbers
//    (with a "/wk" suffix and switched rulenote copy in avg mode), and specifically that the
//    collapsed 5-row selection is PINNED to "This week" ranking regardless of which mode is being
//    viewed -- a real bug Jeff caught in the first draft, where tapping the toggle could swap out
//    which muscles even appeared, not just their numbers.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
// Aug 31 addition: the new "Volume trend" section (right after Weekly volume on the page) lists
// every muscle group's name again as chip labels, unconditionally -- so a bare html.includes('Quads')
// against the WHOLE page is no longer a reliable proxy for "is Quads shown as a METER ROW." Scope
// those checks to just the Weekly volume card's own markup, between its heading and the next one.
const volSection = html => html.slice(html.indexOf('Weekly volume'), (() => { const i = html.indexOf('Volume trend'); return i === -1 ? html.length : i; })());

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
const openVolTrendPicker = vm.runInContext('openVolTrendPicker', ctx);
const pickVolTrendMuscle = vm.runInContext('pickVolTrendMuscle', ctx);
const getTrendVolPick = () => vm.runInContext('TREND_VOL_PICK', ctx);

function baseProgress(overrides) {
  return Object.assign({
    unit: 'lb', ready: [], holds: [], soon: [], weeks: [{ weekOf: '2026-08-24', days: 0 }],
    thisWeek: 0, avgPerWeek: 0, streakWeeks: 0,
    trend: { lifts: [], overall: [], allNames: [], picks: [] }, prs: [],
    volume: { weekOf: '2026-08-24', weeks: 1, groups: [
      { group: 'chest', sets: 0, target: 12 }, { group: 'lats', sets: 0, target: 12 },
      { group: 'shoulders', sets: 0, target: 12 }, { group: 'traps', sets: 0, target: 8 },
      { group: 'biceps', sets: 0, target: 10 }, { group: 'triceps', sets: 0, target: 10 },
      { group: 'forearms', sets: 0, target: 6 }, { group: 'quads', sets: 0, target: 12 },
      { group: 'hamstrings', sets: 0, target: 10 }, { group: 'glutes', sets: 0, target: 10 },
      { group: 'calves', sets: 0, target: 10 }, { group: 'abdominals', sets: 0, target: 10 },
    ] },
    volumeAvg: { weekOf: '2026-08-10', weeks: 4, groups: [
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
  ok(!html.includes(`onclick="setVolMode`), 'no mode toggle when BOTH this week and the 4-wk avg are truly empty');
}

console.log('weekly volume: mode toggle still shows when THIS WEEK is empty but the 4-wk avg has data (cold-review catch)');
{
  // Real bug caught by cold review: the toggle used to be gated on the CURRENTLY DISPLAYED mode's
  // data. A fresh page load always starts on "This week," so a week with nothing logged yet --
  // the exact scenario this whole feature exists for -- hid the "4-wk avg" button entirely, even
  // though the trailing month had real data to show. The toggle must be offered whenever EITHER
  // view has something, not just the one currently on screen.
  const volAvg = baseProgress().volumeAvg;
  volAvg.groups = volAvg.groups.map(g => g.group === 'chest' ? { group: 'chest', sets: 6, target: 12 } : g);
  PROGRESS_FIXTURE = baseProgress({ volumeAvg: volAvg }); // volume (this week) stays all-zero
  ok(getVolMode() === 'week', 'starts on "This week" (sanity check)');

  await progressScreen({ silent: true });
  const html = appEl.innerHTML;
  ok(html.includes("Log some working sets this"), 'This week itself still shows its own empty state (got no match)');
  ok(!html.includes('mv-row'), 'no rows rendered while on the empty "This week" view');
  ok(html.includes(`onclick="setVolMode('avg')"`), 'the "4-wk avg" button IS offered even though this week is empty (this was the bug)');

  setVolMode('avg');
  await new Promise(r => setTimeout(r, 0));
  const html2 = appEl.innerHTML;
  ok(html2.includes('mv-row') && html2.includes('Chest'), 'switching to avg mode reveals the real data (got no match)');
  setVolMode('week'); // reset for later blocks
  await new Promise(r => setTimeout(r, 0));
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
  ok(!volSection(html).includes('Quads') && !volSection(html).includes('Glutes'), 'the two fully-trained groups are pushed out of the neglected-first top 5');
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

console.log('weekly volume: "This week"/"4-wk avg" toggle -- pinned row selection, mode-dependent numbers');
{
  // Jeff, Aug 31 (round 2): tapping the toggle must NOT reshuffle which 5 muscles show in the
  // collapsed view -- only their numbers. This week: quads/glutes are well-trained (pushed out of
  // the neglected-first top 5, same setup as the collapse/expand block above), everything else 0.
  // 4-wk avg: chest is now fully "met" (12/12) -- if the collapsed selection re-ranked per mode
  // (the bug Jeff caught), chest would drop OUT of the list once its avg looks good, replaced by
  // some other zero group. Pinning selection to THIS WEEK's ranking means chest stays visible
  // (still flagged, because it really was skipped this week), just showing its better avg number.
  const vol = baseProgress().volume;
  vol.groups = vol.groups.map(g => {
    if (g.group === 'quads') return { group: 'quads', sets: 12, target: 12 };
    if (g.group === 'glutes') return { group: 'glutes', sets: 10, target: 10 };
    return g;
  });
  const volAvg = baseProgress().volumeAvg;
  volAvg.groups = volAvg.groups.map(g => {
    if (g.group === 'chest') return { group: 'chest', sets: 12, target: 12 };   // looks great by avg
    if (g.group === 'lats') return { group: 'lats', sets: 6, target: 12 };      // partial by avg
    if (g.group === 'quads') return { group: 'quads', sets: 8, target: 12 };
    if (g.group === 'glutes') return { group: 'glutes', sets: 7, target: 10 };
    return g;
  });
  PROGRESS_FIXTURE = baseProgress({ volume: vol, volumeAvg: volAvg });
  ok(getVolMode() === 'week', 'starts on "This week" (sanity check)');

  await progressScreen({ silent: true });
  let html = appEl.innerHTML;
  ok(html.includes(`class="on" onclick="setVolMode('week')"`), '"This week" pill is active by default');
  ok(!html.includes(`class="on" onclick="setVolMode('avg')"`), '"4-wk avg" pill is not active by default');
  let rowCount = (html.match(/class="mv-row"/g) || []).length;
  ok(rowCount === 5, `collapsed to 5 rows in week mode (got ${rowCount})`);
  ok(html.includes('Chest') && html.includes('Back') && html.includes('Shoulders') && html.includes('Traps') && html.includes('Biceps'),
    'the 5 zero-ratio-this-week groups are shown (got: ' + html.slice(html.indexOf('Weekly volume'), html.indexOf('Weekly volume') + 400) + ')');
  ok(!volSection(html).includes('Quads') && !volSection(html).includes('Glutes'), 'well-trained-this-week groups stay excluded');
  ok(html.includes('working sets logged this week'), 'rulenote uses the weekly wording');

  setVolMode('avg');
  await new Promise(r => setTimeout(r, 0));
  html = appEl.innerHTML;
  ok(getVolMode() === 'avg', 'setVolMode switched the mode');
  ok(html.includes(`class="on" onclick="setVolMode('avg')"`), '"4-wk avg" pill is now active');
  ok(!html.includes(`class="on" onclick="setVolMode('week')"`), '"This week" pill is no longer active');
  rowCount = (html.match(/class="mv-row"/g) || []).length;
  ok(rowCount === 5, `still exactly 5 rows after switching mode (got ${rowCount})`);
  ok(html.includes('Chest') && html.includes('Back') && html.includes('Shoulders') && html.includes('Traps') && html.includes('Biceps'),
    'SAME 5 rows as week mode -- selection is pinned, not re-ranked per mode (got: ' + html.slice(html.indexOf('Weekly volume'), html.indexOf('Weekly volume') + 400) + ')');
  ok(!volSection(html).includes('Quads') && !volSection(html).includes('Glutes'),
    'quads/glutes still excluded in avg mode even though their avg numbers differ from their week numbers');
  const chestBlock = html.slice(html.indexOf('Chest'), html.indexOf('Chest') + 260);
  ok(chestBlock.includes('/ 12 sets/wk'), `chest shows the AVG number with "/wk" suffix, not the week number (got ${chestBlock.slice(0, 200)})`);
  ok(chestBlock.includes('mv-met'), 'chest is now "met" using its avg value (12/12), proving the NUMBER did update even though the row stayed');
  ok(html.includes('average working sets per week over the trailing 4 weeks'), 'rulenote switches to the avg wording');

  setVolMode('week'); // reset for later blocks
  await new Promise(r => setTimeout(r, 0));
  ok(getVolMode() === 'week', 'reset back to "This week"');
}

// Aug 31, round 3: the "Volume trend" chart (volTrendChart in app.js), right below Weekly volume.
// Scope checks to just its own section the same way volSection does for the meter above it.
const trendSection = html => html.slice(html.indexOf('Volume trend'), (() => { const i = html.indexOf('Consistency'); return i === -1 ? html.length : i; })());
const MUSCLE_KEYS = vm.runInContext('Object.keys(MUSCLE_LABEL)', ctx);
const MUSCLE_LABEL_MAP = vm.runInContext('MUSCLE_LABEL', ctx);
const setTrendVolPick = vm.runInContext('setTrendVolPick', ctx);
// A chip's class attribute and its onclick handler sit on the SAME <span>, but the looped muscle
// chips wrap that span onto a second line (a literal newline+indent in between) while the single
// hand-written "Overall" chip does not -- so tie the class capture directly to this span's own
// onclick via a bounded, non-greedy gap rather than assuming a fixed literal string.
function chipActive(html, key) {
  const re = new RegExp(`<span class="chip ([^"]*)"[\\s\\S]{0,30}?onclick="setTrendVolPick\\('${key}'\\)"`);
  const m = html.match(re);
  if (!m) return null;
  return /\bon\b/.test(m[1]);
}
// Sep 1, round 2: the second chip (the picker trigger) always calls openVolTrendPicker(), not
// setTrendVolPick(<key>) -- its active state and label are what changes, not its handler -- so it
// needs its own extractor rather than reusing chipActive's per-key onclick match.
function pickChipInfo(html) {
  const m = html.match(/<span class="chip ([^"]*)"[\s\S]{0,30}?onclick="openVolTrendPicker\(\)">([^<]*)<\/span>/);
  if (!m) return null;
  return { active: /\bon\b/.test(m[1]), label: m[2].trim() };
}
function makeTrendWeeks(weeksSpec, target = 10) {
  return weeksSpec.map(w => ({
    weekOf: w.weekOf,
    groups: MUSCLE_KEYS.map(g => ({ group: g, sets: (w.sets && w.sets[g]) || 0, target })),
  }));
}
function allGroupsSet(n) { const o = {}; MUSCLE_KEYS.forEach(g => o[g] = n); return o; }

console.log('volume trend: no data at all -- the "Pick a muscle" chip still opens the picker (discoverable), true "Not enough history yet." state, no chart');
{
  PROGRESS_FIXTURE = baseProgress(); // no volumeTrend key at all
  await progressScreen({ silent: true });
  const html = appEl.innerHTML;
  const sec = trendSection(html);
  ok(html.includes('Volume trend'), 'section heading renders even before any trend data exists');
  ok(sec.includes('Not enough history yet.'), 'shows the zero-history empty state (got no match)');
  ok(chipActive(sec, '__overall') === true, 'Overall chip is active by default');
  const pick = pickChipInfo(sec);
  ok(!!pick && pick.active === false && pick.label === 'Pick a muscle ▾', `the second chip prompts to pick a muscle and opens the picker even with zero weeks of data (got ${JSON.stringify(pick)})`);
  ok(!sec.includes('<svg'), 'no chart svg with zero weeks of trend history');

  // The picker itself must still be usable here -- with truly no history, every tile falls back to
  // a plain "No data yet" subtext (window._VOLTREND_GROUPS is null in this state).
  openVolTrendPicker();
  const sheetHtml = body._children[body._children.length - 1].innerHTML;
  ok((sheetHtml.match(/No data yet/g) || []).length === 12, `all 12 tiles show "No data yet" when there is truly no history at all (got ${(sheetHtml.match(/No data yet/g) || []).length})`);
}

console.log('volume trend: the inline chip row always shows exactly 2 chips -- Overall + a single picker chip (Jeff, Sep 1 round 2: the old header button "seemed out of place") -- the other 11 muscles live in the picker sheet, not as inline pills');
{
  const weeks = makeTrendWeeks([{ weekOf: '2026-08-17', sets: {} }, { weekOf: '2026-08-24', sets: allGroupsSet(5) }], 10);
  PROGRESS_FIXTURE = baseProgress({ volumeTrend: { weeks } });
  await progressScreen({ silent: true });
  let sec = trendSection(appEl.innerHTML);
  ok((sec.match(/class="chip /g) || []).length === 2, `always exactly 2 inline chips, never a wall of 12 (got ${(sec.match(/class="chip /g) || []).length})`);
  let pick = pickChipInfo(sec);
  ok(!!pick && pick.label === 'Pick a muscle ▾' && pick.active === false, `on Overall, the second chip is a neutral prompt, not a filled/active pill (got ${JSON.stringify(pick)})`);

  setTrendVolPick('quads');
  await new Promise(r => setTimeout(r, 0));
  sec = trendSection(appEl.innerHTML);
  ok((sec.match(/class="chip /g) || []).length === 2, `still exactly 2 inline chips after picking a muscle (got ${(sec.match(/class="chip /g) || []).length})`);
  pick = pickChipInfo(sec);
  ok(!!pick && pick.label === 'Quads ▾' && pick.active === true, `the second chip now names the picked muscle and shows active (got ${JSON.stringify(pick)})`);
  ok(chipActive(sec, '__overall') === false, 'Overall is no longer the active chip');
  ok(!sec.includes('>Chest<') && !sec.includes('>Biceps<'), `muscles that are NOT picked never clutter the inline row (got: ${sec.slice(0, 300)})`);

  setTrendVolPick('__overall'); // reset for later blocks
  await new Promise(r => setTimeout(r, 0));
}

console.log('volume trend: tapping the "Pick a muscle" chip opens a sheet of .mg-card tiles (icon + name + this week\'s own sets/target), grouped Upper Body/Lower Body/Other same as the Workouts library\'s muscle browser -- not a bare text list');
{
  const weeks = makeTrendWeeks([{ weekOf: '2026-08-17', sets: {} }, { weekOf: '2026-08-24', sets: { hamstrings: 6 } }], 10);
  PROGRESS_FIXTURE = baseProgress({ volumeTrend: { weeks } });
  await progressScreen({ silent: true });

  openVolTrendPicker();
  const sheetHtml = body._children[body._children.length - 1].innerHTML;
  ok(sheetHtml.includes('Pick a muscle'), 'sheet title renders');
  ok(sheetHtml.includes('Upper Body') && sheetHtml.includes('Lower Body') && sheetHtml.includes('Other'), 'muscles are grouped into the same categories the Workouts library uses (got no match)');
  ok(MUSCLE_KEYS.every(g => sheetHtml.includes(`pickVolTrendMuscle('${g}')`) && sheetHtml.includes(MUSCLE_LABEL_MAP[g]) && sheetHtml.includes('mg-ico')),
    'all 12 muscles render as tappable .mg-card tiles with an icon (got no match for one or more)');
  ok(sheetHtml.includes('6 / 10 sets this week'), `hamstrings' own this-week progress shows as the tile's subtext (got no match in: ${sheetHtml.slice(0, 200)})`);
  ok(sheetHtml.includes('0 / 10 sets this week'), 'an untrained muscle shows its real 0/target this week, not a blank or a false claim');
  ok(!sheetHtml.includes('✓'), 'nothing is marked active yet while still on Overall (got a checkmark unexpectedly)');

  pickVolTrendMuscle('hamstrings');
  await new Promise(r => setTimeout(r, 0));
  ok(getTrendVolPick() === 'hamstrings', `picking a tile from the sheet switches TREND_VOL_PICK (got ${getTrendVolPick()})`);
  const sec = trendSection(appEl.innerHTML);
  ok(sec.includes('Week of 2026-08-24: 6 sets'), `the chart actually switched to hamstrings' own data (got: ${sec.slice(0, 400)})`);

  openVolTrendPicker(); // reopen -- the just-picked muscle should now show as the checked tile
  const sheetHtml2 = body._children[body._children.length - 1].innerHTML;
  const i = sheetHtml2.indexOf("pickVolTrendMuscle('hamstrings')");
  const hamTile = sheetHtml2.slice(i, i + 400);
  ok(hamTile.includes('✓'), `hamstrings shows as the checked tile after picking it (got: ${hamTile})`);

  setTrendVolPick('__overall'); // reset for later blocks
  await new Promise(r => setTimeout(r, 0));
}

console.log('volume trend: real weeks exist but nothing logged -- "Log a few weeks..." message, distinct from the zero-history state');
{
  const weeks = makeTrendWeeks([{ weekOf: '2026-08-17', sets: {} }, { weekOf: '2026-08-24', sets: {} }], 10);
  PROGRESS_FIXTURE = baseProgress({ volumeTrend: { weeks } });
  await progressScreen({ silent: true });
  const sec = trendSection(appEl.innerHTML);
  ok(sec.includes('Log a few weeks of working sets'), 'shows the not-yet-trained message once real weeks exist but are all zero (got no match)');
  ok(!sec.includes('Not enough history yet.'), 'does NOT show the different zero-history message once weeks actually exist');
  ok(!sec.includes('<svg'), 'still no chart svg when every week is zero');
  ok(sec.includes('onclick="openVolTrendPicker()"') && sec.includes('Pick a muscle'), 'cold-review catch: the picker chip still offers all 12 muscles in this THIRD empty-state branch too, not just the other two (got no match)');
}

console.log('volume trend: re-picking the muscle that is already active is a harmless no-op');
{
  const weeks = makeTrendWeeks([{ weekOf: '2026-08-17', sets: {} }, { weekOf: '2026-08-24', sets: { hamstrings: 6 } }], 10);
  PROGRESS_FIXTURE = baseProgress({ volumeTrend: { weeks } });
  await progressScreen({ silent: true });
  pickVolTrendMuscle('hamstrings');
  await new Promise(r => setTimeout(r, 0));
  pickVolTrendMuscle('hamstrings'); // already active -- re-picking the same one must not error or change anything
  await new Promise(r => setTimeout(r, 0));
  ok(getTrendVolPick() === 'hamstrings', `re-picking the already-active muscle is a no-op, still hamstrings (got ${getTrendVolPick()})`);
  const sec = trendSection(appEl.innerHTML);
  ok(sec.includes('Week of 2026-08-24: 6 sets'), `chart still shows the correct data after the redundant re-pick (got: ${sec.slice(0, 400)})`);
  setTrendVolPick('__overall'); // reset for later blocks
  await new Promise(r => setTimeout(r, 0));
}

console.log('volume trend: Overall view averages % of target across all 12 muscle groups, per week');
{
  const weeks = makeTrendWeeks([
    { weekOf: '2026-08-17', sets: {} },              // 2 weeks ago: nothing logged -> 0%
    { weekOf: '2026-08-24', sets: allGroupsSet(5) },  // last week: every group at 5/10 -> 50%
  ], 10);
  PROGRESS_FIXTURE = baseProgress({ volumeTrend: { weeks } });
  await progressScreen({ silent: true });
  const sec = trendSection(appEl.innerHTML);
  ok(sec.includes('<svg'), 'chart renders once at least one week has data');
  ok(chipActive(sec, '__overall') === true, 'Overall chip is active by default');
  ok(sec.includes('Week of 2026-08-17: 0% of target'), `untrained week shows 0% average (got: ${sec.slice(0, 500)})`);
  ok(sec.includes('Week of 2026-08-24: 50% of target'), `every group at half its target averages to a clean 50% (got: ${sec.slice(0, 500)})`);
  ok(sec.includes('this week'), 'the most recent bar is labeled "this week"');
  ok(sec.includes('average % of target reached across all muscle groups'), 'Overall rulenote explains the % averaging (got no match)');
}

console.log('volume trend: picking a muscle chip switches to that muscle\'s own raw weekly set count, not the Overall percentage');
{
  // Only quads gets trained this week (8 of a 10-set target) -- Overall blends that across all 12
  // groups (80 + 0*11) / 12 = 6.67 -> rounds to 7%, while picking Quads must show the real "8".
  const weeks = makeTrendWeeks([
    { weekOf: '2026-08-17', sets: {} },
    { weekOf: '2026-08-24', sets: { quads: 8 } },
  ], 10);
  PROGRESS_FIXTURE = baseProgress({ volumeTrend: { weeks } });
  await progressScreen({ silent: true });
  let sec = trendSection(appEl.innerHTML);
  ok(sec.includes('Week of 2026-08-24: 7% of target'), `Overall blends quads' 8 sets across all 12 groups, not a raw count (got: ${sec.slice(0, 500)})`);

  setTrendVolPick('quads');
  await new Promise(r => setTimeout(r, 0));
  sec = trendSection(appEl.innerHTML);
  const quadsPick = pickChipInfo(sec);
  ok(quadsPick && quadsPick.active === true && quadsPick.label === 'Quads ▾', `picker chip becomes active and shows Quads after picking it (got: ${JSON.stringify(quadsPick)})`);
  ok(chipActive(sec, '__overall') === false, 'Overall chip is no longer active');
  ok(sec.includes('Week of 2026-08-24: 8 sets'), `switches to quads' own raw weekly set count (got: ${sec.slice(0, 500)})`);
  ok(sec.includes('Week of 2026-08-17: 0 sets'), 'the untrained earlier week shows 0 sets for quads specifically');
  ok(sec.includes('working sets per week for quads'), 'rulenote switches to the per-muscle wording (got no match)');
  ok(sec.includes('Dashed line marks the 10-set weekly target'), "rulenote names quads' own 10-set target, not the Overall 100% line");

  setTrendVolPick('__overall'); // reset for later blocks
  await new Promise(r => setTimeout(r, 0));
  ok(chipActive(trendSection(appEl.innerHTML), '__overall') === true, 'reset back to Overall');
}

console.log('volume trend: more than 13 weeks (the "6 months" range) still renders -- per-bar value labels are suppressed above the label-crowding threshold, but tooltips and axis labels still work');
{
  // Cold-review gap: every other fixture in this file uses 2 weeks. weeksData.length<=13 gates
  // whether a value is drawn as floating <text> on top of each bar -- real usage reaches well past
  // 13 (PROG_RANGES offers "6 months" = 26), so this needs its own dedicated coverage.
  const spec = [];
  for (let i = 0; i < 14; i++) {
    const d = new Date('2026-06-01T00:00:00Z'); d.setUTCDate(d.getUTCDate() + i * 7);
    spec.push({ weekOf: d.toISOString().slice(0, 10), sets: i === 13 ? { quads: 6 } : {} }); // only the last week has any volume
  }
  const weeks = makeTrendWeeks(spec, 10);
  PROGRESS_FIXTURE = baseProgress({ volumeTrend: { weeks } });
  await progressScreen({ silent: true });
  const sec = trendSection(appEl.innerHTML);
  ok(sec.includes('<svg'), '14-week chart still renders without crashing');
  ok(!sec.includes('font-weight="700"'), 'per-bar floating value labels are suppressed once there are more than 13 weeks (got some anyway)');
  ok(/Week of \d{4}-\d{2}-\d{2}: \d+% of target/.test(sec), 'the tooltip text is still present per-bar even without the visible floating label (got no match)');
  ok(sec.includes('this week'), 'the "this week" axis label still renders on the last bar');
}

console.log('volume trend: a stale/unknown picked muscle falls back to Overall instead of falsely reporting "no data" (cold-review catch)');
{
  // Same defensive pattern trendChart already uses for TREND_PICK (fall back to a valid selection
  // rather than a value that no longer corresponds to any real chip/group). Simulate a stale pick
  // by setting one that isn't Overall and isn't any of the 12 known muscle keys.
  setTrendVolPick('__overall');
  await new Promise(r => setTimeout(r, 0));
  vm.runInContext(`TREND_VOL_PICK = 'not_a_real_muscle_key'`, ctx);
  const weeks = makeTrendWeeks([{ weekOf: '2026-08-17', sets: {} }, { weekOf: '2026-08-24', sets: allGroupsSet(5) }], 10);
  PROGRESS_FIXTURE = baseProgress({ volumeTrend: { weeks } });
  await progressScreen({ silent: true });
  const sec = trendSection(appEl.innerHTML);
  ok(chipActive(sec, '__overall') === true, 'a stale/unknown pick falls back to the Overall chip rather than staying on a phantom selection');
  ok(sec.includes('Week of 2026-08-24: 50% of target'), 'and shows the real Overall data instead of a false "no data" message (got: ' + sec.slice(0, 400) + ')');
  ok(!sec.includes('Log a few weeks of working sets'), 'does NOT fall into the empty-state branch just because the stale pick matched nothing');
  const fallbackPick = pickChipInfo(sec);
  ok(fallbackPick && fallbackPick.active === false && fallbackPick.label === 'Pick a muscle ▾', `the picker chip itself also resets to its neutral label/state, not left showing the phantom key (got: ${JSON.stringify(fallbackPick)})`);
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
