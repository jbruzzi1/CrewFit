// A custom exercise is authored by one user and renders in EVERY other user's library, so its
// fields are one person's input arriving in another person's browser. This file runs the REAL
// public/app.js and calls the REAL render functions against input a hostile author could store.
//
// Two earlier versions of this file were regexes over the source, and reviews destroyed both: the
// first passed with the functions it guarded deleted; the second passed with a second, vulnerable
// copy of mgIcon added below the fixed one (declarations hoist, so the browser ran the bad one),
// and with esc() gutted. The lesson is that checking source TEXT cannot tell you what the code
// does. So the file is loaded and executed exactly as written — hoisting, redefinition and
// last-declaration-wins all behave the way they will in the browser, because it is the same file.
//
// It also means the checks are on RENDER OUTPUT, not on helpers in isolation: a helper that is
// correct but no longer called is a bug this must catch, and testing the helper alone cannot.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// `let LIB_STATE = ...` at the top level of a script is a LEXICAL binding — it is NOT a property of
// the context object, so assigning ctx.LIB_STATE creates a shadow the app never reads. Setting it
// from INSIDE the vm is the only thing that works. A mutation battery caught this: the library-list
// checks below were silently running against an empty list until it was fixed.
const setIn = (name, value) => vm.runInContext(`${name} = ${JSON.stringify(value)};`, ctx);

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const run = f => { try { return { v: f() }; } catch (e) { return { err: e.message }; } };

// ---- load the real client ----------------------------------------------------------------
const SRC = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const sink = { html: '' };
const el = () => new Proxy(function () {}, {
  get: (t, k) => k === 'style' || k === 'classList' || k === 'dataset' ? el()
    : k === 'innerHTML' ? sink.html
    : k === 'innerText' || k === 'value' || k === 'textContent' ? ''
    : k === 'children' || k === 'childNodes' ? [] : el(),
  set: (t, k, v) => { if (k === 'innerHTML') sink.html += String(v); return true; },
  apply: () => el(), has: () => true,
});
const doc = { getElementById: () => el(), querySelector: () => el(), querySelectorAll: () => [],
  createElement: () => el(), addEventListener() {}, body: el(), documentElement: el(), head: el(),
  cookie: '', readyState: 'complete' };
const ctx = { console: { log() {}, warn() {}, error() {} }, document: doc,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  fetch: () => Promise.resolve({ json: () => Promise.resolve([]), ok: true, status: 200, text: () => Promise.resolve('') }),
  location: { href: '/', pathname: '/', search: '', hash: '' },
  // v254: app.js now registers a top-level window.addEventListener('popstate', ...) (the Back-
  // button fix) and calls history.pushState/replaceState from openSheetHtml/closeSheet/navigated/
  // landOn -- these need to be real enough not to throw, even in tests that don't care about nav.
  history: { replaceState() {}, pushState() {} }, addEventListener() {}, removeEventListener() {}, scrollTo() {},
  navigator: { userAgent: 'node', serviceWorker: { register: () => Promise.resolve() }, onLine: true },
  setTimeout, clearTimeout, setInterval, clearInterval, alert() {}, confirm: () => true, prompt: () => null,
  requestAnimationFrame: f => setTimeout(f, 0), matchMedia: () => ({ matches: false, addEventListener() {} }),
  FileReader: function () {}, Image: function () {}, URL, Blob: function () {}, FormData: function () {},
  IntersectionObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
  ResizeObserver: function () { this.observe = () => {}; this.disconnect = () => {}; } };
ctx.window = ctx; ctx.globalThis = ctx; ctx.self = ctx;
try {
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx, { filename: 'public/app.js' });
} catch (e) {
  console.log('  FAIL public/app.js does not load at all — ' + e.message);
  process.exit(1);
}

// Read the bindings from INSIDE the vm. `ctx.name` only sees function declarations and var; a
// `const eqList = (e) => …` refactor is lexical and would look deleted from out here, reddening the
// deploy over a style change. Evaluating the identifier in the vm sees both.
const F = {};
for (const n of ['esc', 'jsq', 'eqList', 'exName', 'eqFamilies', 'mgIcon', 'exThumb', 'exRowHtml',
                 'renderLibGroups', 'renderLibExercises', 'exDetail', 'rcDay', 'fmtDate',
                 'showSavePage']) {
  const got = run(() => vm.runInContext(n, ctx));
  if (typeof got.v !== 'function') { console.log(`  FAIL public/app.js no longer defines ${n}()`); process.exit(1); }
  F[n] = got.v;
}

// ---- what a hostile author can store -------------------------------------------------------
const PAYLOADS = [
  'x" onerror="window.__PWNED=1" data-z="',
  '<img src=x onerror=window.__PWNED=1>',
  '"><script>window.__PWNED=1</script>',
  "x' onerror='window.__PWNED=1' b='",
  '<svg/onload=window.__PWNED=1>',
];
// Anything here would have thrown inside .map(x=>x.toLowerCase()) and taken the muscle group down.
const HOSTILE_EQUIPMENT = [42, {}, null, undefined, ['barbell'], true, [{}, 'barbell', 42], 'barbell'];

// Escaped text is fine and expected — the payload SHOULD be visible as the exercise's name, just
// inert. So "does the output contain the word onerror" is the wrong question: it does, harmlessly,
// inside escaped text, and the app emits its own legitimate onclick handlers besides.
//
// The right question is whether the payload survived VERBATIM. esc() turns & < > " ' into entities
// and jsq() backslashes the quote inside an onclick, so if the raw string is still findable in the
// output then one of them did not run. Gut esc() for any single character and the payload
// containing it reappears here.
const leaks = (html, payload) => html.includes(payload)
  || /<\s*(script|iframe)\b/i.test(html);

console.log('\na hostile exercise renders inert in someone else\'s library');
// exRowHtml has THREE branches — swap mode, add mode, and the plain row — and all three ship: swap
// from a session card, add from "Add exercises", plain from browsing. Testing only the default one
// left two live paths where the escaping could be removed with the suite still green.
for (const [mode, state] of [['browsing', { SWAP_MODE: false, LIB_ADDMODE: false }],
                             ['swap mode', { SWAP_MODE: true, LIB_ADDMODE: false }],
                             ['add mode', { SWAP_MODE: false, LIB_ADDMODE: true }]]) {
  for (const k of Object.keys(state)) setIn(k, state[k]);
  for (const p of PAYLOADS) {
    // The hostile group is FIRST, so exThumb -> mgIcon runs on it. mgIcon tested on its own could
    // not catch its call site being rewritten back to the inline unescaped form.
    const ex = { name: p, muscle_groups: [p, 'biceps'], equipment: [p], level: p, is_compound: false };
    const r = run(() => F.exRowHtml(ex));
    ok(!r.err && !leaks(r.v, p), `${mode}: ${p.slice(0, 26)}… -> ${r.err ? 'THREW: ' + r.err : leaks(r.v, p) ? 'LEAKS VERBATIM' : 'inert'}`);
  }
}
for (const k of ['SWAP_MODE', 'LIB_ADDMODE']) setIn(k, false);
{
  // esc() covers five characters. Assert all five actually survive a round trip through a real
  // render — a version of esc that only handled the double quote passed an earlier draft of this
  // file while a name of <img src=x onerror=...> still executed.
  const r = run(() => F.exRowHtml({ name: `&<>"'`, muscle_groups: ['biceps'], equipment: [] }));
  const got = ((r.v || '').match(/<div class="ex-name">([^<]*)<\/div>/) || [])[1];
  ok(got === '&amp;&lt;&gt;&quot;&#39;', `all five escaped characters survive a real row render (${got})`);
}

{
  // The onclick is a JS string inside an HTML attribute. esc() alone is not enough there — the HTML
  // parser decodes &#39; back to an apostrophe BEFORE the JS is parsed — so this checks the real
  // handler that ships, for a name people actually have.
  const r = run(() => F.exRowHtml({ name: "Farmer's Carry", muscle_groups: ['forearms'], equipment: [] }));
  const onclick = ((r.v || '').match(/onclick="([^"]*)"/) || [])[1] || '';
  ok(/\\&#39;|\\'/.test(onclick), `an apostrophe in a name is backslash-escaped in the handler (${onclick})`);
  const q = run(() => F.exRowHtml({ name: "x'); window.__PWNED=1; ('", muscle_groups: ['biceps'], equipment: [] }));
  const oc = ((q.v || '').match(/onclick="([^"]*)"/) || [])[1] || '';
  // Decode the way the HTML parser does, THEN ask what the JS parser would see. Every apostrophe
  // from the name must still be backslashed at that point, so only the two delimiters are live.
  const asJsSees = oc.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  const live = (asJsSees.replace(/\\'/g, '').match(/'/g) || []).length;
  ok(live === 2, `and a name that tries to close the call cannot — ${live} live quotes, want 2 (${asJsSees.slice(0, 46)}…)`);
}

console.log('\nhostile equipment cannot take down a muscle group');
for (const equipment of HOSTILE_EQUIPMENT) {
  const ex = { name: 'X', muscle_groups: ['biceps'], equipment };
  const a = run(() => F.eqFamilies(ex)), b = run(() => F.exRowHtml(ex));
  ok(!a.err && !b.err && Array.isArray(a.v),
     `${JSON.stringify(equipment) || 'undefined'} -> ${a.err || b.err || JSON.stringify(a.v)}`);
}
{
  const r = run(() => F.eqFamilies({ equipment: [{}, 'barbell', 42] }));
  ok(JSON.stringify(r.v) === '["barbell"]', `the one real entry in a poisoned list is still read (${r.err || JSON.stringify(r.v)})`);
  const n = run(() => F.eqFamilies({ equipment: ['Cable', 'Bar'] }));
  ok(JSON.stringify(n.v) === '["barbell","cable"]', `and an ordinary exercise is unaffected (${n.err || JSON.stringify(n.v)})`);
}

console.log('\nthe library list itself survives a poisoned row');
{
  // The real search and sort paths, through the real functions, over a library containing one bad
  // row. This is what catches a helper that is correct but no longer called: revert any call site
  // to the raw field and these throw.
  const poisoned = [
    { name: 'Barbell Curl', muscle_groups: ['biceps'], equipment: ['barbell'], level: 'beginner' },
    { name: 42, muscle_groups: ['biceps'], equipment: [42, {}], level: 'beginner' },
    { name: PAYLOADS[0], muscle_groups: ['biceps'], equipment: 'not-an-array', level: 'beginner' },
    { name: 'No Fields' },
  ];
  for (const [label, state] of [['browsing', { view: 'muscle', muscle: 'biceps', eq: '', q: '' }],
                                ['searching', { view: 'muscle', muscle: 'biceps', eq: '', q: 'curl' }],
                                ['filtering by equipment', { view: 'muscle', muscle: 'biceps', eq: 'barbell', q: '' }]]) {
    ctx.window._LIB2 = poisoned; setIn('LIB_STATE', state); sink.html = '';
    const r = run(() => F.renderLibExercises());
    ok(!r.err, `${label} a poisoned muscle group: ${r.err || 'renders'}`);
    ok(/ex-row/.test(sink.html), `${label} — and rows actually rendered (an empty list would assert nothing)`);
    ok(!PAYLOADS.some(p => leaks(sink.html, p)), `${label} — and no payload reaches the output verbatim`);
  }
  ctx.window._LIB2 = poisoned; setIn('LIB_STATE', { view: 'groups', muscle: '', eq: '', q: 'curl' }); sink.html = '';
  const g = run(() => F.renderLibGroups());
  ok(!g.err, `searching from the muscle list: ${g.err || 'renders'}`);
}

{
  // The detail sheet. esc() coerces, so a poisoned equipment list here is not a crash — but it
  // would print "42, [object Object]" as this exercise's equipment, which is the app stating
  // something about the exercise that is not true. Junk is not equipment; show nothing.
  ctx.window._LIB2 = [{ name: 'Junk Equip', muscle_groups: ['biceps'], equipment: [42, {}],
                        level: 'beginner', is_compound: false, defaultSets: 3, defaultReps: 10 }];
  sink.html = '';
  const r = run(() => F.exDetail('Junk Equip'));
  ok(!r.err, `the detail sheet opens for a poisoned row: ${r.err || 'yes'}`);
  ok(!/\[object Object\]/.test(sink.html), 'and does not print [object Object] as equipment');

  // exDetail -> exThumb -> mgIcon is the ONE render path that puts an attacker-controlled muscle
  // group into an image URL, and it is where the stored XSS actually fired. Testing mgIcon on its
  // own could not catch this call site being rewritten back to the old inline unescaped form.
  for (const p of PAYLOADS) {
    ctx.window._LIB2 = [{ name: 'Poison Thumb', muscle_groups: [p, 'biceps'], equipment: [],
                          level: 'beginner', is_compound: false, defaultSets: 3, defaultReps: 10 }];
    sink.html = '';
    const d = run(() => F.exDetail('Poison Thumb'));
    const srcs = String(sink.html).match(/src="[^"]*"/g) || [];
    ok(!d.err && srcs.length > 0 && srcs.every(x => /^src="muscle-icons\/[a-z]+\.png"$/.test(x)),
       `the detail thumbnail for ${p.slice(0, 24)}… -> ${d.err ? 'THREW: ' + d.err : srcs.join(' ') || 'NO IMAGE RENDERED'}`);
    ok(!leaks(sink.html, p), `and that sheet does not leak the payload verbatim`);
  }
}

console.log("\na muscle group cannot break out of the icon's URL");
{
  // There is a fixed set of icon files, so a group outside it has no picture to point at and must
  // never reach the attribute. The whole tag is pinned: esc() turns " into &quot;, so a raw " can
  // only be a delimiter, and an injected attribute would not match this shape.
  const SHAPE = /^<img class="mg-img" src="muscle-icons\/[a-z]+\.png" alt="[^"]*" loading="lazy">$/;
  for (const p of [...PAYLOADS, '../../../etc/passwd', 'javascript:alert(1)',
                   'constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    const r = run(() => F.mgIcon(p));
    ok(!r.err && SHAPE.test(r.v), `${p.slice(0, 30)}… -> ${r.err || String(r.v).slice(0, 58)}…`);
  }
  ok(/src="muscle-icons\/biceps\.png"/.test(F.mgIcon('biceps')), 'and a real group still gets its own icon');
  ok(/src="muscle-icons\/core\.png"/.test(F.mgIcon('abdominals')), 'including one that maps to a different file (abdominals -> core)');
  ok(/alt="x&quot; onerror/.test(F.mgIcon(PAYLOADS[0])), 'the group is still shown in alt, escaped');
}

console.log('\na date the creator chose cannot kill a participant\'s Save screen');
{
  // Run the REAL showSavePage. Asserting that fmtDate() survives a bad value would prove nothing —
  // new Date(anything).toLocaleString() never throws, so such a check passes against any app.js.
  // What actually broke was `s.scheduledAt.slice(0,10)` at the call site, and only calling the
  // function reaches that. scheduledAt is stored exactly as sent, and a participant can open this
  // screen, so this is one person's input rendering on another's.
  setIn('ME', { id: 'u_me', displayName: 'Me' });
  const results = [];
  for (const [label, scheduledAt] of [['a number', 1755000000000], ['an object', {}],
                                      ['an array', []], ['a real ISO string', '2026-08-19T17:30:00.000Z']]) {
    const session = { id: 's1', creatorId: 'u_other', scheduledAt, name: 'Legs',
      exercises: [{ id: 'e1', name: 'Barbell Back Squat' }], variations: {}, logs: {}, post: null,
      participants: ['u_me', 'u_other'] };
    vm.runInContext(`H.get = () => Promise.resolve(${JSON.stringify(session)});`, ctx);
    sink.html = '';
    results.push(F.showSavePage('s1').then(() => ({ label, ok: true }), e => ({ label, ok: false, err: e.message })));
  }
  const settled = await Promise.all(results);
  for (const r of settled) ok(r.ok, `${r.label}: ${r.ok ? 'the Save screen renders' : 'THREW: ' + r.err}`);
}

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
