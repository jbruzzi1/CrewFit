// Does every button call something that exists?
//
// Run:  npm test
//
// Nine buttons in this app did nothing when tapped. Five of them were the entire swap-and-approve
// flow — Approve, Reject, the join-request pair, and the door into the swap picker — and they were
// dead for months. Every server endpoint behind them worked. The functions the onclick attributes
// named had simply never been written, so tapping threw an error internally and stopped. Nothing
// appeared on screen. A dead button looks exactly like a working one until you press it, which is
// why this is a test and not a thing anyone was ever going to notice by reading the code.
//
// This walks every onclick/onchange/oninput in public/app.js, pulls out the function being called,
// and fails if it is not defined anywhere. It is deliberately dumb — no browser, no server, no
// state — because the bug it guards is dumb.
import { readFileSync } from 'node:fs';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };

// Comments are stripped before scanning. A comment that SHOWS you the shape of a handler —
// `onclick="fn('HERE')"` — is documentation, not markup, and reporting fn() as a dead button is a
// false positive that would block a deploy. Only whole comment lines go: a `//` inside a string or
// a URL keeps its line.
const stripComments = t => t.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const src = stripComments(readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'));
const html = stripComments(readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'));

// things that are not app functions and are expected inside a handler
// This list exists so the test cannot fail on correct code. A false positive here blocks a
// deploy in CI, which is worse than the bug it guards — so when in doubt, add the name.
const BUILTIN = new Set([
  'event', 'this', 'return', 'if', 'else', 'for', 'while', 'switch', 'typeof', 'void', 'new',
  'delete', 'in', 'of', 'await', 'true', 'false', 'null', 'undefined', 'function', 'catch',
  'window', 'document', 'console', 'alert', 'confirm', 'prompt', 'fetch', 'localStorage',
  'sessionStorage', 'navigator', 'location', 'history', 'FormData', 'URL', 'URLSearchParams',
  'Number', 'String', 'Boolean', 'JSON', 'Math', 'Array', 'Object', 'Date', 'RegExp', 'Error',
  'Promise', 'Set', 'Map', 'WeakMap', 'WeakSet', 'Symbol', 'BigInt', 'Proxy', 'Reflect',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent',
  'encodeURI', 'decodeURI', 'escape', 'unescape', 'structuredClone', 'queueMicrotask',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame',
  'cancelAnimationFrame', 'Image', 'Blob', 'File', 'FileReader', 'Audio', 'CustomEvent', 'Event',
]);

// every function this file defines, in any of the shapes it uses
const defined = new Set();
// No ^ anchors and no assumption about parentheses: a definition can be indented, nested, or
// written `const f = v => …` with a single bare parameter. Missing one of those shapes reports a
// perfectly good function as dead.
for (const re of [
  /(?:^|\W)(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g,   // function foo(  /  async function* foo(
  /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\(|[A-Za-z_$][\w$]*\s*=>)/g, // const foo = ( | function | v =>
  /(?:window|globalThis)\.([A-Za-z_$][\w$]*)\s*=/g,                     // window.foo =
]) for (const m of src.matchAll(re)) defined.add(m[1]);

// every function NAMED by a handler — inline in markup AND assigned in JS
const called = new Map();          // name -> where it appeared
const EVENTS = 'click|change|input|submit|keydown|keyup|keypress|focus|blur|scroll|touchstart|touchend';
const noteCall = (name, where) => {
  if (BUILTIN.has(name)) return;           // method calls are excluded by the leading char class
  if (!called.has(name)) called.set(name, where.slice(0, 70));
};

// 1. inline attributes:  onclick="foo('x')"
for (const m of (src + '\n' + html).matchAll(new RegExp(`\\bon(?:${EVENTS})\\s*=\\s*(["'\`])([\\s\\S]*?)\\1`, 'g'))) {
  const body = m[2];
  for (const c of body.matchAll(/(^|[;{}\s(,&|!?:])([A-Za-z_$][\w$]*)\s*\(/g)) noteCall(c[2], body);
}
// 2. assigned in JS:  el.onclick = () => foo(x)   /   el.onclick = foo
// This is how the BOTTOM NAV is wired. It was unchecked, so renaming showTab left every nav
// button dead with the suite still green.
for (const m of src.matchAll(new RegExp(`\\.on(?:${EVENTS})\\s*=\\s*([^;\\n]+)`, 'g'))) {
  const rhs = m[1];
  for (const c of rhs.matchAll(/(^|[;{}\s(,&|!?:=>])([A-Za-z_$][\w$]*)\s*\(/g)) noteCall(c[2], rhs);
  const bare = rhs.match(/^\s*([A-Za-z_$][\w$]*)\s*$/);        // el.onclick = foo
  if (bare) noteCall(bare[1], rhs);
}

console.log(`every button calls something that exists`);
ok(called.size > 0, `found the handlers to check (${called.size} distinct functions called from markup)`);
ok(defined.size > 0, `found the definitions to check against (${defined.size} functions defined)`);

const dead = [...called.entries()].filter(([n]) => !defined.has(n));
for (const [name, where] of dead) ok(false, `${name}() is called by a button but defined NOWHERE — «${where}…»`);
ok(dead.length === 0, dead.length ? `${dead.length} dead button handler(s)` : 'no button calls a function that does not exist');

// the five that were actually dead, named explicitly so a revert is unmistakable
console.log('\nthe five that were dead');
for (const fn of ['approve', 'reject', 'approveJoin', 'rejectJoin', 'openSwapPicker'])
  ok(defined.has(fn), `${fn}() exists`);

// and the duplicate-definition bug: submitSession was written twice, the second silently won,
// and the second could only create — so "Save changes" duplicated the workout and lost the edit
console.log('\nno function is defined twice');
const counts = {};
for (const re of [
  /(?:^|\W)(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g,
  /(?:^|\W)(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g,
]) for (const m of src.matchAll(re)) counts[m[1]] = (counts[m[1]] || 0) + 1;
const dupes = Object.entries(counts).filter(([, n]) => n > 1);
for (const [name, n] of dupes) ok(false, `${name}() is defined ${n} times — the last one silently wins`);
ok(dupes.length === 0, dupes.length ? `${dupes.length} duplicated definition(s)` : 'every function is defined exactly once');

console.log(fails ? `\n${fails} FAILURE(S)\n` : '\nall assertions passed\n');
process.exit(fails ? 1 : 0);
