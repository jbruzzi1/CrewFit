// v311 (Jeff, Sep 4): "if an exercise only SLIGHTLY uses triceps and is MAINLY used for chest, we
// shouldn't have it as a tricep exercise ... if it is genuinely used in multiple muscle groups
// that's fine -- a sled for legs and not just cardio should be in each." The library carries the
// split: muscle_groups = primary movers (a tile per entry), secondary = helpers (row subtitle,
// detail sheet, search, volume meter -- Jeff chose to leave the meter's full-credit rule alone).
// Drives the real renderLibExercises()/renderLibGroups() from app.js in node:vm with a tiny fake
// library, same technique as test/favorite-exercises.mjs.
import { readFileSync } from 'node:fs';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };

const src = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const sink = {};                                   // innerHTML written by id
const el = (id) => ({ set innerHTML(v) { sink[id] = v; }, get innerHTML() { return sink[id] || ''; },
  textContent: '', value: '', style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], focus() {}, scrollIntoView() {} });
const doc = {
  body: el('body'), createElement: () => el('x'), getElementById: (id) => el(id),
  querySelector: () => el('q'), querySelectorAll: () => [],
  addEventListener() {}, documentElement: el('html'), head: el('head'), cookie: '', readyState: 'complete',
};
const ctx = {
  console: { log() {}, warn() {}, error() {} }, document: doc,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  fetch: () => Promise.resolve({ json: () => Promise.resolve([]), status: 200, text: () => Promise.resolve('') }),
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
const vm = await import('node:vm');
vm.createContext(ctx);
vm.runInContext(src, ctx, { filename: 'public/app.js' });

const LIB = [
  { name: 'Flat Barbell Bench Press', muscle_groups: ['chest'], secondary: ['triceps', 'shoulders'], equipment: ['barbell', 'bench'], level: 'beginner', is_compound: true },
  { name: 'Rope Pushdown', muscle_groups: ['triceps'], equipment: ['cable'], level: 'beginner', is_compound: false },
  { name: 'Close-Grip Bench Press', muscle_groups: ['triceps'], secondary: ['chest'], equipment: ['barbell', 'bench'], level: 'intermediate', is_compound: true },
  { name: 'Barbell Overhead Press', muscle_groups: ['shoulders'], secondary: ['triceps'], equipment: ['barbell'], level: 'intermediate', is_compound: true },
  { name: 'Sled Push', muscle_groups: ['cardio', 'quads', 'glutes'], equipment: ['sled'], level: 'intermediate', is_compound: true },
];
ctx._LIB2 = LIB;
vm.runInContext('FAVORITES = new Set()', ctx);

console.log('a muscle tile lists an exercise under each PRIMARY muscle, never a helper');
{
  vm.runInContext(`LIB_STATE.view='muscle'; LIB_STATE.muscle='triceps'; LIB_STATE.eq=''; LIB_STATE.q=''; LIB_STATE.fav=false; renderLibExercises()`, ctx);
  const html = sink.lib2 || '';
  const names = [...html.matchAll(/exDetail\('([^']+)'\)/g)].map(m => m[1]);
  ok(names.includes('Rope Pushdown') && names.includes('Close-Grip Bench Press'), `Triceps shows the lifts whose main muscle is triceps (got ${JSON.stringify(names)})`);
  ok(!names.includes('Flat Barbell Bench Press') && !names.includes('Barbell Overhead Press'),
    `a chest press / overhead press that only uses triceps as a helper is NOT filed under Triceps (got ${JSON.stringify(names)})`);
  vm.runInContext(`LIB_STATE.muscle='chest'; renderLibExercises()`, ctx);
  const chest = [...(sink.lib2 || '').matchAll(/exDetail\('([^']+)'\)/g)].map(m => m[1]);
  ok(JSON.stringify(chest) === JSON.stringify(['Flat Barbell Bench Press']), `Chest holds the bench press and not the close-grip variant (got ${JSON.stringify(chest)})`);
  for (const m of ['cardio', 'quads', 'glutes']) {
    vm.runInContext(`LIB_STATE.muscle='${m}'; renderLibExercises()`, ctx);
    const rows = [...(sink.lib2 || '').matchAll(/exDetail\('([^']+)'\)/g)].map(x => x[1]);
    ok(rows.includes('Sled Push'), `a lift that is genuinely several things (Sled Push) is filed under ${m} too (got ${JSON.stringify(rows)})`);
  }
}

console.log('\nthe tile counts on the All-muscles screen match that rule');
{
  vm.runInContext(`LIB_STATE.view='groups'; LIB_STATE.q=''; renderLibGroups()`, ctx);
  const html = sink.lib2 || '';
  const count = (m) => (html.match(new RegExp(`<div class="mg-card-name">${m}</div><div class="mg-card-count">(\\d+) exercises`)) || [])[1];
  ok(count('triceps') === '2', `Triceps counts 2, not 4 (got ${count('triceps')})`);
  ok(count('chest') === '1' && count('shoulders') === '1', `Chest 1, Shoulders 1 (got chest ${count('chest')}, shoulders ${count('shoulders')})`);
  ok(count('quads') === '1' && count('glutes') === '1' && count('cardio') === '1', `Sled Push counts once in each of Quads, Glutes and Cardio (got ${count('quads')}/${count('glutes')}/${count('cardio')})`);
}

console.log('\nhelper muscles are still on the row, in the detail sheet, and searchable from All muscles');
{
  const row = vm.runInContext(`exRowHtml(window._LIB2[0])`, ctx);
  ok(/chest · triceps/.test(row), `the bench press row subtitle still reads "chest · triceps" (got ${row.match(/ex-mg">([^<]*)/)?.[1]})`);
  ok(vm.runInContext(`exMuscles(window._LIB2[0]).join(' · ')`, ctx) === 'chest · triceps · shoulders', 'the detail sheet lists primaries then helpers');
  vm.runInContext(`LIB_STATE.view='groups'; LIB_STATE.q='triceps'; renderLibGroups()`, ctx);
  const hits = [...(sink.lib2 || '').matchAll(/exDetail\('([^']+)'\)/g)].map(m => m[1]);
  ok(hits.includes('Flat Barbell Bench Press'), `searching "triceps" from All muscles still finds the bench press (got ${JSON.stringify(hits)})`);
}

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
