// v249 audit finding: rebuildAllPrs() (server.js) picks a PR's winning set by comparing every
// candidate through toLb(l.weight, l.unit) — correctly unit-aware — but then stored the winner as
// `{ weight: bestLog.weight, reps: ..., at: ..., firstLog }` with NO unit field. recordsFor()'s
// beatSeed check reads it right back through the same toLb(e.weight, e.unit) helper, and with
// e.unit missing, toLb silently treated a kg PR's raw number as if it were that many POUNDS —
// wrong by a factor of ~2.2x, low enough that a real kg improvement could read as "did not beat
// your seed." The client (prLabel in app.js) had the same blind spot for DISPLAY: it labelled
// every PR with the page's CURRENT unit preference rather than the unit that specific record was
// actually logged in, so a record set before a later unit switch could show the right number next
// to the wrong unit.
//
// This test proves both halves: the server API contract (unit carried through, beatSeed computed
// correctly for a kg lifter) and the client display functions (prLabel/unitOf, pulled directly out
// of the REAL public/app.js via node:vm, same technique as test/sheet-stacking.mjs) doing the
// labelling correctly regardless of the viewer's current unit preference.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { freshTestDb } from './_pgtestdb.mjs';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const J = { 'Content-Type': 'application/json' };
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('prunits');

function boot(port, dir) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; srv.stdout.on('data', d => { out += d; if (String(d).includes('CrewFit on')) res({ srv, out }); });
    srv.on('exit', () => res({ srv: null, out }));
    setTimeout(() => res({ srv, out }), 15000);
  });
}

const DIR = mkdtempSync(join(tmpdir(), 'prunits-'));
const PORT = 4984, B = `http://localhost:${PORT}`;
const { srv } = await boot(PORT, DIR);
ok(!!srv, 'server boots');

const post = (p, b, tok) => fetch(B + p, { method: 'POST', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b) }).then(r => r.json());
const get = (p, tok) => fetch(B + p, { headers: tok ? { Authorization: 'Bearer ' + tok } : {} }).then(r => r.json());
const reg = (username, pin, displayName) => post('/api/register', { username, pin, displayName });

console.log("the exact bug: a kg lifter's earned PR must beat a kg seed correctly — with the old missing-unit code, toLb(100, undefined) reads as 100 (treated as lb), which is LESS than the seed's own toLb(90,'kg')≈198.4, so a real 100kg improvement over a 90kg seed would have silently failed beatSeed");
{
  const kilo = await reg('pru_kilo', 'pass1234', 'Kilo');
  await post('/api/me/units', { units: 'kg' }, kilo.token);
  const seeded = await fetch(B + '/api/me/seeds', { method: 'PUT', headers: { ...J, Authorization: 'Bearer ' + kilo.token }, body: JSON.stringify({ exercise: 'Barbell Back Squat', weight: 90, reps: 5 }) }).then(r => r.json());
  ok(!seeded.error, `seeding a 90kg starting best works (got ${seeded.error})`);

  const s = await post('/api/sessions', {
    name: 'Leg Day', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Barbell Back Squat' }],
    inviteUsernames: [], visibility: 'private',
  }, kilo.token);
  // 100kg (~220.5 lb) genuinely beats a 90kg (~198.4 lb) seed — but only if compared unit-aware.
  await post('/api/sessions/' + s.id + '/log', { exerciseId: s.exercises[0].id, weight: 100, reps: 5 }, kilo.token);
  await post('/api/sessions/' + s.id + '/lock', {}, kilo.token);

  const progress = await get('/api/progress', kilo.token);
  const pr = (progress.prs || []).find(p => p.exercise === 'Barbell Back Squat' && p.source === 'earned');
  ok(!!pr, `the 100kg set produced an earned PR record (got ${JSON.stringify(progress.prs)})`);
  ok(pr && pr.unit === 'kg', `the PR record carries its own unit, kg (got ${pr && pr.unit})`);
  ok(pr && Number(pr.weight) === 100, `and the right raw number, 100 — not silently converted (got ${pr && pr.weight})`);
  ok(pr && pr.beatSeed === true, `100kg correctly beats the 90kg seed once compared unit-aware (got ${pr && pr.beatSeed})`);
}

console.log('\nclient display: prLabel/unitOf (pulled directly from the real public/app.js) must label a PR by the unit IT was recorded in, not the viewer\'s current preference');
{
  const SRC = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  // Same minimal DOM stub as test/leave-workout.mjs — loading app.js runs its boot IIFE
  // immediately (it calls authScreen()/$()/document.getElementById at the bottom of the file), so
  // this needs the full stub even though this block only ever calls bare functions off ctx.
  const el = () => new Proxy(function () {}, {
    get: (t, k) => k === 'style' || k === 'classList' || k === 'dataset' ? el()
      : k === 'innerHTML' || k === 'innerText' || k === 'value' || k === 'textContent' ? ''
      : k === 'children' || k === 'childNodes' ? [] : el(),
    set: () => true, apply: () => el(), has: () => true,
  });
  const doc = { getElementById: () => el(), querySelector: () => null, querySelectorAll: () => [],
    createElement: () => el(), addEventListener() {}, body: el(), documentElement: el(), head: el(),
    cookie: '', readyState: 'complete' };
  const ctx = { console: { log() {}, warn() {}, error() {} }, document: doc,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: (url, opts) => fetch(B + url, opts),
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
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx, { filename: 'public/app.js' });
  // A record set in kg, viewed while the app's CURRENT preference is lb (simulating a unit switch
  // AFTER the PR was earned) — must still read "kg", per the app's own stated rule that a logged
  // number keeps reading in the unit it was typed in (see the comment above unitOf in app.js).
  vm.runInContext(`ME = { units: 'lb' };`, ctx);
  const kgPr = { exercise: 'Barbell Back Squat', weight: 100, unit: 'kg', reps: 5, source: 'earned' };
  const label = vm.runInContext('prLabel', ctx)(kgPr);
  ok(label === '100 kg × 5', `a kg PR labels as kg even while the viewer's current preference is lb (got "${label}")`);

  vm.runInContext(`ME = { units: 'kg' };`, ctx);
  const lbPr = { exercise: 'Bench Press', weight: 220, unit: 'lb', reps: 3, source: 'earned' };
  const label2 = vm.runInContext('prLabel', ctx)(lbPr);
  ok(label2 === '220 lb × 3', `and an lb PR still labels as lb even while the viewer's current preference is kg (got "${label2}")`);

  const bwPr = { exercise: 'Pull-Up', weight: 0, unit: 'lb', reps: 8, source: 'earned' };
  const label3 = vm.runInContext('prLabel', ctx)(bwPr);
  ok(label3 === '8 reps', `a bodyweight PR (weight 0) still reads as plain reps, unaffected by the unit fix (got "${label3}")`);

  const unitOf = vm.runInContext('unitOf', ctx);
  ok(unitOf(kgPr) === 'kg' && unitOf(lbPr) === 'lb', 'unitOf itself reads the record\'s own unit either way');
  ok(unitOf({}) === 'lb', 'and defaults to lb for a legacy record with no unit at all, same as it always has for logged sets');
}

try { srv && srv.kill(); } catch {}
rmSync(DIR, { recursive: true, force: true });
await testDb.drop();

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
