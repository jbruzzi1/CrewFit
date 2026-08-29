// The v243 quick-log parser: one spoken/typed line becomes weight / reps / RIR / set type.
// Jeff, Aug 29: "voice text 'I did 45lbs at 8 reps' and it will log that set... say 'normal
// set, 45lbs at 8 reps, 2 RIR' and it fills everything in for me."
//
// The contract under test: DETERMINISTIC and conservative. Every phrasing below either parses
// to exactly the right fields or to null/partial - never to a wrong number. iOS dictation
// output shapes (commas, "I did", capitalized words, digits for spoken numbers) are the
// canonical inputs.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };

// same minimal vm harness as client-hostile.mjs - parseQuickLog is a pure function
const SRC = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const el = () => new Proxy(function () {}, {
  get: (t, k) => k === 'children' || k === 'childNodes' ? [] : (k === 'innerText' || k === 'value' || k === 'textContent') ? '' : el(),
  set: () => true, apply: () => el(), has: () => true,
});
const doc = { getElementById: () => el(), querySelector: () => el(), querySelectorAll: () => [],
  createElement: () => el(), addEventListener() {}, body: el(), documentElement: el(), head: el(),
  cookie: '', readyState: 'complete' };
const ctx = { console: { log() {}, warn() {}, error() {} }, document: doc,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  fetch: () => Promise.resolve({ json: () => Promise.resolve([]), ok: true, status: 200, text: () => Promise.resolve('') }),
  location: { href: '/', pathname: '/', search: '', hash: '' }, history: { replaceState() {}, pushState() {} },
  navigator: { userAgent: 'node', serviceWorker: { register: () => Promise.resolve() }, onLine: true },
  setTimeout, clearTimeout, setInterval, clearInterval, alert() {}, confirm: () => true, prompt: () => null,
  requestAnimationFrame: f => setTimeout(f, 0), matchMedia: () => ({ matches: false, addEventListener() {} }),
  FileReader: function () {}, Image: function () {}, URL, Blob: function () {}, FormData: function () {},
  IntersectionObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
  ResizeObserver: function () { this.observe = () => {}; this.disconnect = () => {}; } };
ctx.window = ctx; ctx.globalThis = ctx; ctx.self = ctx;
vm.createContext(ctx);
vm.runInContext(SRC, ctx, { filename: 'public/app.js' });
const parse = vm.runInContext('parseQuickLog', ctx);

const eq = (got, want) => JSON.stringify(got) === JSON.stringify(want);
const P = (input, want, label) => {
  const got = parse(input);
  ok(eq(got, want), `${label || JSON.stringify(input)} -> ${JSON.stringify(got)}${eq(got, want) ? '' : ' (wanted ' + JSON.stringify(want) + ')'}`);
};
const base = { setType: null, weight: null, reps: null, rir: null, unit: null };

console.log("Jeff's exact asks");
P('I did 45lbs at 8 reps', { ...base, weight: 45, reps: 8, unit: 'lb' });
P('Normal set, 45lbs at 8 reps, 2 RIR', { ...base, setType: 'normal', weight: 45, reps: 8, rir: 2, unit: 'lb' });

console.log('\nseparators and orderings');
P('185 for 5', { ...base, weight: 185, reps: 5 });
P('225 x 3', { ...base, weight: 225, reps: 3 });
P('225 by 3', { ...base, weight: 225, reps: 3 });
P('225 times 3', { ...base, weight: 225, reps: 3 });
P('45 at 8 reps', { ...base, weight: 45, reps: 8 });
P('8 reps at 45', { ...base, weight: 45, reps: 8 }, 'reps-first: "8 reps at 45"');
P('182.5 for 5', { ...base, weight: 182.5, reps: 5 }, 'decimal weight');

console.log('\nset types');
P('warm up 135 for 10', { ...base, setType: 'warmup', weight: 135, reps: 10 });
P('warmup 135 for 10', { ...base, setType: 'warmup', weight: 135, reps: 10 });
P('drop set 90 for 12', { ...base, setType: 'drop', weight: 90, reps: 12 });
P('185 for 9 to failure', { ...base, setType: 'failure', weight: 185, reps: 9 });
P('failure 185 for 9', { ...base, setType: 'failure', weight: 185, reps: 9 });

console.log('\nRIR shapes');
P('185 for 5, 2 RIR', { ...base, weight: 185, reps: 5, rir: 2 });
P('185 for 5 RIR 2', { ...base, weight: 185, reps: 5, rir: 2 });
P('185 for 5, 2 in reserve', { ...base, weight: 185, reps: 5, rir: 2 });
P('185 for 5, left 2 in the tank', { ...base, weight: 185, reps: 5, rir: 2 });
P('3 RIR', { ...base, rir: 3 }, 'RIR alone fills only RIR');

console.log('\nunits');
P('100 kg for 5', { ...base, weight: 100, reps: 5, unit: 'kg' });
P('245 pounds', { ...base, weight: 245, unit: 'lb' }, 'weight-only with unit');
// the CALLER refuses a conflicting unit; the parser just reports what was said - asserted here
// so the conflict check in qlParse always has the unit to look at
ok(parse('100 kg for 5').unit === 'kg', 'parser reports the spoken unit for the conflict check');

console.log('\nconservative on partial or garbage');
P('8 reps', { ...base, reps: 8 }, 'reps alone (bodyweight)');
P('felt great today', null, 'no numbers, no fields -> null');
P('', null, 'empty -> null');
P('   ', null, 'whitespace -> null');
P(undefined, null, 'undefined -> null');
P('45', null, 'a bare number with no unit or keyword is NOT guessed at');

console.log('\ncold-review traps');
// dictation dropping the pause in "5, 2 in reserve" must NOT swallow the whole line into an RIR
P('185 for 52 in reserve', { ...base, weight: 185, reps: 52 }, 'merged-number artifact keeps weight/reps, drops RIR');
P('185 for 5 2 in reserve', { ...base, weight: 185, reps: 5, rir: 2 }, 'same phrase with the pause intact');
// the whole client must stay parseable on iOS Safari < 16.4 - regex lookbehind is a PARSE-time
// SyntaxError there and would brick the entire app, not just this feature
ok(!/\(\?<[=!]/.test(SRC), 'public/app.js contains no regex lookbehind (old-iOS-Safari parse safety)');

console.log("\nout of habit, out of order (Jeff, Aug 29: 'what if it's not in order')");
P('8 reps at 85 lbs with 2rir', { ...base, weight: 85, reps: 8, rir: 2, unit: 'lb' }, "Jeff's exact: reps first, RIR last, no space in 2rir");
P('2 RIR, 85 at 8 reps', { ...base, weight: 85, reps: 8, rir: 2 }, 'RIR said first');
P('85 lbs 8 reps', { ...base, weight: 85, reps: 8, unit: 'lb' }, 'no connecting word, weight first');
P('8 reps 85 lbs', { ...base, weight: 85, reps: 8, unit: 'lb' }, 'no connecting word, reps first');
P('8 reps 85', { ...base, weight: 85, reps: 8 }, 'no connecting word, no unit');
P('warm up, 2 rir, 10 reps at 95', { ...base, setType: 'warmup', weight: 95, reps: 10, rir: 2 }, 'everything backwards');
P('3 sets of 8 reps', { ...base, reps: 8 }, 'a sets COUNT is never misread as a weight');
P('3 sets of 8 reps at 135', { ...base, weight: 135, reps: 8 }, 'sets count stripped, weight still found');
P('8 reps 85 60', { ...base, reps: 8 }, 'TWO leftover bare numbers: keep the reps that were plainly said, refuse to guess which number is the weight');

console.log('\ndictation noise');
P('I just did 225 x 3', { ...base, weight: 225, reps: 3 });
P('Warm-up. 95 for 12.', { ...base, setType: 'warmup', weight: 95, reps: 12 }, 'punctuation + hyphen');
P('NORMAL SET 45 AT 8 REPS', { ...base, setType: 'normal', weight: 45, reps: 8 }, 'all caps');

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
