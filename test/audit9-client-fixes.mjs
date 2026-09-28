// Sep 28 2026 -- client-side (app.js) fixes from Jeff's second-pass audit: warm-up set numbering
// (setBadges), muscle-group display labels (muscleLabel), and the exercise-sheet rep target now
// matching the workout card (repLabel). Same node:vm technique as test/library-primary-muscle.mjs.
import { readFileSync } from 'node:fs';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };

const src = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const ctx = {
  console: { log() {}, warn() {}, error() {} },
  document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} } }), documentElement: { style: {}, classList: { toggle() {} } }, body: { style: {} }, addEventListener() {}, head: {}, cookie: '', readyState: 'complete' },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  fetch: () => Promise.resolve({ json: () => Promise.resolve([]) }),
  location: { href: '/', pathname: '/', search: '', hash: '' },
  history: { replaceState() {}, pushState() {} }, addEventListener() {}, removeEventListener() {}, scrollTo() {},
  navigator: { userAgent: 'node', onLine: true },
  setTimeout, clearTimeout, setInterval, clearInterval, alert() {}, confirm: () => true, prompt: () => null,
  requestAnimationFrame: f => setTimeout(f, 0), matchMedia: () => ({ matches: false, addEventListener() {} }),
};
ctx.window = ctx; ctx.globalThis = ctx; ctx.self = ctx;
const vm = await import('node:vm');
vm.createContext(ctx);
vm.runInContext(src, ctx, { filename: 'public/app.js' });

console.log('setBadges: a warm-up (or drop) set no longer consumes a number in the working-set sequence');
{
  const rows = [
    { setType: 'warmup', set: 1 },
    { setType: 'normal', set: 2 },
    { setType: 'normal', set: 3 },
  ];
  const badges = vm.runInContext('setBadges', ctx)(rows);
  ok(badges[0].t === 'W' && badges[0].c === 'warm', `row 0 (warm-up) still reads W (got ${JSON.stringify(badges[0])})`);
  ok(badges[1].t === 1, `row 1, the FIRST real working set, now reads 1 -- not 2 (got ${badges[1].t}) -- this is Jeff's "Sets show W, 2, 3 ... should be W, 1, 2"`);
  ok(badges[2].t === 2, `row 2, the second working set, reads 2 (got ${badges[2].t})`);
}
{
  // Failure sets still get their own "F" badge, unchanged behavior -- not part of Jeff's report,
  // confirming this fix didn't touch it.
  const rows = [{ setType: 'normal', set: 1 }, { setType: 'failure', set: 2 }, { setType: 'normal', set: 3 }];
  const badges = vm.runInContext('setBadges', ctx)(rows);
  ok(badges[0].t === 1 && badges[1].t === 'F' && badges[1].c === 'fail' && badges[2].t === 2,
    `normal/failure/normal reads 1, F, 2 unchanged (got ${JSON.stringify(badges.map(b => b.t))})`);
}
{
  // Two warm-ups in a row before the first real set -- still 1, not 3.
  const rows = [{ setType: 'warmup', set: 1 }, { setType: 'warmup', set: 2 }, { setType: 'normal', set: 3 }];
  const badges = vm.runInContext('setBadges', ctx)(rows);
  ok(badges[2].t === 1, `two warm-ups then a real set still reads 1 for that first real set (got ${badges[2].t})`);
}

console.log('\nmuscleLabel: the same display names Trends already used (Back/Abs) now apply everywhere a muscle key is shown');
{
  const label = vm.runInContext('muscleLabel', ctx);
  ok(label('lats') === 'Back', `lats -> "Back" (got ${label('lats')})`);
  ok(label('abdominals') === 'Abs', `abdominals -> "Abs" (got ${label('abdominals')})`);
  ok(label('chest') === 'Chest', `chest -> "Chest" (got ${label('chest')})`);
  ok(label('made_up_key') === 'Made_up_key', `an unknown key still falls back to a capitalized version rather than showing nothing (got ${label('made_up_key')})`);
}

console.log('\nrepLabel: the exercise-detail sheet\'s "Suggested" reads a real 10-15 range now, matching the workout card\'s "Target", instead of dropping the max');
{
  const repLabel = vm.runInContext('repLabel', ctx);
  ok(repLabel({ defaultReps: 10, defaultRepsMax: 15 }) === '10–15', `a real range renders "10-15" (got ${repLabel({ defaultReps: 10, defaultRepsMax: 15 })})`);
  ok(repLabel({ defaultReps: 10 }) === '10', `no max -> just "10" (got ${repLabel({ defaultReps: 10 })})`);
}

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
