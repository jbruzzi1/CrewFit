// Jeff, Sep 1: "add a filter in the exercise library for favorites? Allowing you to favorite when
// building a workout or in the library also. Then when adding exercises to a workout you can
// click the favorite tab for each individual muscle group to make things more convenient when
// creating workouts."
//
// Server half: GET /api/favorites and POST /api/favorites/toggle, a per-user list of exercise
// NAMES (exercises have no id anywhere in this app — see sanitizeExercise's own comment — so
// favorites key off name, same as everything else: DRAFT.exercises.find(x=>x.name===e.name),
// libToggle, swapPick, ...). Private to the user who set it: never returned from any route another
// user can read (profileOf, publicUser, etc. are untouched).
//
// Client half: FAVORITES (a Set, loaded alongside window._LIB2 in library()), the ★ Favorites pill
// in libOpenMuscle's eq-pills row (mutually exclusive with the equipment pills, same single-select
// interaction), and the star toggle on each exercise row in both plain-browsing and LIB_ADDMODE
// (building a workout), checked here by source regex against the real app.js — the same style
// test/sharing.mjs already uses for renderWorkoutEdit's markup.
//
// Run:  npm test
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';

const PORT = process.env.TEST_PORT_FAV || 4959;
const B = `http://localhost:${PORT}`;
const DIR = mkdtempSync(join(tmpdir(), 'crewfit-test-fav-'));
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('favorite_exercises');
let fails = 0, srv = null;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };

function boot() {
  return new Promise((res, rej) => {
    srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: DIR, DATABASE_URL: testDb.url, PORT: String(PORT) },
      cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    srv.stderr.on('data', d => { err += d; });
    srv.stdout.on('data', d => { if (String(d).includes('CrewFit on')) res(); });
    srv.on('exit', c => rej(new Error(`server exited (${c}):\n${err}`)));
    setTimeout(() => rej(new Error('server never started:\n' + err)), 15000);
  });
}
const stop = () => new Promise(r => { if (!srv) return r(); srv.on('exit', r); srv.kill(); });

async function newUser() {
  const u = 'u' + Math.floor(Math.random() * 1e9);
  const r = await fetch(B + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u, pin: 'pass12', displayName: 'T' }) }).then(x => x.json());
  if (!r.token) throw new Error('register failed: ' + JSON.stringify(r));
  return { H: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + r.token }, username: u, id: r.user.id };
}
const getFavorites = ({ H }) => fetch(B + '/api/favorites', { headers: H }).then(x => x.json());
const toggleFavorite = ({ H }, name) => fetch(B + '/api/favorites/toggle', { method: 'POST', headers: H,
  body: JSON.stringify({ name }) }).then(x => x.json());

await boot();
try {

console.log('a fresh user has no favorites');
{
  const u = await newUser();
  const r = await getFavorites(u);
  ok(Array.isArray(r.exercises) && r.exercises.length === 0, `starts empty (got ${JSON.stringify(r)})`);
}

console.log('\ntoggling favorites an exercise, toggling again un-favorites it');
{
  const u = await newUser();
  const on = await toggleFavorite(u, 'Barbell Back Squat');
  ok(on.favorited === true, `first toggle favorites it (got ${JSON.stringify(on)})`);
  let r = await getFavorites(u);
  ok(r.exercises.includes('Barbell Back Squat'), 'shows up in the list');

  const off = await toggleFavorite(u, 'Barbell Back Squat');
  ok(off.favorited === false, `second toggle un-favorites it (got ${JSON.stringify(off)})`);
  r = await getFavorites(u);
  ok(!r.exercises.includes('Barbell Back Squat'), 'and is gone from the list');
}

console.log('\nfavorites are per-user, not shared or global');
{
  const a = await newUser(), b = await newUser();
  await toggleFavorite(a, 'Front Squat');
  const ra = await getFavorites(a), rb = await getFavorites(b);
  ok(ra.exercises.includes('Front Squat'), "shows up in A's own list");
  ok(!rb.exercises.includes('Front Squat'), "does not leak into B's list");
}

console.log('\nmultiple favorites accumulate independently, in toggle order');
{
  const u = await newUser();
  await toggleFavorite(u, 'Front Squat');
  await toggleFavorite(u, 'Barbell Back Squat');
  const r = await getFavorites(u);
  ok(r.exercises.length === 2, `both present (got ${JSON.stringify(r.exercises)})`);
  ok(r.exercises.includes('Front Squat') && r.exercises.includes('Barbell Back Squat'), 'both names present');
}

console.log('\nan empty/missing name is rejected, not silently favorited');
{
  const u = await newUser();
  const r = await fetch(B + '/api/favorites/toggle', { method: 'POST', headers: u.H, body: JSON.stringify({}) });
  ok(r.status === 400, `missing name -> 400 (got ${r.status})`);
  const r2 = await fetch(B + '/api/favorites/toggle', { method: 'POST', headers: u.H, body: JSON.stringify({ name: '' }) });
  ok(r2.status === 400, `empty name -> 400 (got ${r2.status})`);
}

console.log('\nGET /api/favorites requires login, same as every other per-user route');
{
  const r = await fetch(B + '/api/favorites');
  ok(r.status === 401, `no token -> 401 (got ${r.status})`);
}

console.log('\nfavorites never leak through a public/other-user-facing route');
{
  const u = await newUser();
  await toggleFavorite(u, 'Barbell Back Squat');
  const prof = await fetch(B + '/api/profile/' + u.id, { headers: u.H }).then(x => x.json());
  ok(JSON.stringify(prof).indexOf('Barbell Back Squat') === -1, 'the profile response does not echo favorited exercise names');
}

} finally {
  await stop();
  rmSync(DIR, { recursive: true, force: true });
  await testDb.drop();
}

console.log('\n--- client markup (source regex, same style as test/sharing.mjs) ---\n');
{
  const src = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

  ok(/async function toggleFavorite\(name, ?btnEl\)\{/.test(src.replace(/\s+/g, ' ')) || /async function toggleFavorite\(/.test(src),
     'toggleFavorite() exists');
  ok(/H\.post\('\/api\/favorites\/toggle'/.test(src), 'it calls the real POST /api/favorites/toggle endpoint');

  ok(/<span class="cat-pill fav-pill" data-fav="1" onclick="pickFav2\(this\)">★ Favorites<\/span>/.test(src),
     'the ★ Favorites pill is rendered in libOpenMuscle\'s eq-pills row');
  ok(/function pickFav2\(el\)\{/.test(src.replace(/\s+/g, ' ')), 'pickFav2() exists');
  ok(/LIB_STATE\.fav = false/.test(src), 'picking an equipment pill (pickEq2) clears the favorites filter — mutually exclusive, not combinable');

  // renderLibExercises must actually filter by it, not just carry the flag
  const renderFn = (src.match(/function renderLibExercises\(\)\{[\s\S]*?\n\}/) || [''])[0];
  ok(/fav.*=.*LIB_STATE/.test(renderFn.replace(/\s+/g, ' ')) || /\{muscle,eq,q,fav\}=LIB_STATE/.test(renderFn),
     'renderLibExercises reads LIB_STATE.fav');
  ok(/FAVORITES\.has\(e\.name\)/.test(renderFn), 'and actually filters the list by FAVORITES membership');

  // the star renders in BOTH plain-browsing rows and LIB_ADDMODE rows (Jeff: "when building a
  // workout or in the library also") — count call sites of the helper inside exRowHtml specifically
  const exRowFn = (src.match(/function exRowHtml\(e\)\{[\s\S]*?\n\}/) || [''])[0];
  const favBtnCallsInRow = (exRowFn.match(/\$\{favBtnHtml\(e\)\}/g) || []).length;
  ok(favBtnCallsInRow === 2, `favBtnHtml(e) is called twice inside exRowHtml — once for the plain-browsing row, once for the LIB_ADDMODE row (got ${favBtnCallsInRow})`);
  // ...but NOT in the SWAP_MODE / SUGGEST_ADD_MODE branches, which this feature deliberately
  // doesn't touch (out of scope — those are exercise-replacement pickers, not "browsing the
  // library" or "building a workout" in the sense Jeff described)
  const swapBranch = (exRowFn.match(/if\(SWAP_MODE\)\{[\s\S]*?\n {2}\}/) || [''])[0];
  const suggestBranch = (exRowFn.match(/if\(SUGGEST_ADD_MODE\)\{[\s\S]*?\n {2}\}/) || [''])[0];
  ok(!swapBranch.includes('favBtnHtml'), 'the swap-replacement picker rows are untouched — no star there');
  ok(!suggestBranch.includes('favBtnHtml'), 'the suggest-add picker rows are untouched — no star there');

  // exDetail (the library's own exercise detail sheet) also gets the star
  ok(/<h2>\$\{esc\(e\.name\)\}<\/h2>\$\{favBtnHtml\(e\)\}<button class="sec sm" onclick="closeSheet\(\)">/.test(src),
     'exDetail\'s sheet header includes the favorite star next to the exercise name');

  // CSS actually exists — not an invisible/unstyled button
  ok(/\.ex-fav-btn\s*\{/.test(css), '.ex-fav-btn is styled');

  // v=278 was current when this test was written (this feature's own ship); a later, unrelated
  // feature bumping the cache-bust further is correct, not a regression, so this checks "at least
  // that far" rather than hard-coding a version that would go stale on every future ship.
  const vMatch = css.match(/\?v=(\d+)/);
  ok(!!vMatch && Number(vMatch[1]) >= 278, 'cache-bust bumped to v=278 or later (got ' + (vMatch && vMatch[1]) + ')');
}

console.log('\n--- toggleFavorite: a fast double-tap on the same star must not race (cold-review catch) ---\n');
{
  // Cold-review finding: two overlapping POSTs from a fast double-tap can resolve OUT of send
  // order, and since each response used to unconditionally overwrite FAVORITES/the button icon
  // with its OWN r.favorited, whichever response ARRIVED last (not whichever was SENT last) could
  // decide the final visible state -- easy to land on a star showing the opposite of what's
  // actually stored. Fixed with a FAV_BUSY guard, same shape as addLogSet's ADDLOG_BUSY. Driven
  // via node:vm against the real toggleFavorite() in app.js, same technique as
  // test/text-entry-double-tap.mjs -- a controllable fetch lets this test hold the first request
  // open and prove the second tap never sent a request at all while it's in flight.
  const src = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const genericEl = () => new Proxy(function () {}, {
    get: (t, k) => k === 'children' || k === 'childNodes' ? [] : (k === 'innerText' || k === 'value' || k === 'textContent') ? '' : genericEl(),
    set: () => true, apply: () => genericEl(), has: () => true,
  });
  const doc = {
    body: genericEl(), createElement: () => genericEl(), getElementById: () => genericEl(),
    querySelector: () => genericEl(), querySelectorAll: () => [],
    addEventListener() {}, documentElement: genericEl(), head: genericEl(), cookie: '', readyState: 'complete',
  };
  let postCount = 0;
  const pending = [];
  const ctx = {
    console: { log() {}, warn() {}, error() {} }, document: doc,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: (url) => {
      if (String(url).includes('/api/favorites/toggle')) {
        postCount++;
        return new Promise(resolve => pending.push(() => resolve({
          status: 200, json: () => Promise.resolve({ favorited: true }),
        })));
      }
      return Promise.resolve({ json: () => Promise.resolve([]), status: 200, text: () => Promise.resolve('') });
    },
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
  const vmMod = await import('node:vm');
  vmMod.createContext(ctx);
  vmMod.runInContext(src, ctx, { filename: 'public/app.js' });
  ctx._LIB2 = []; // renderLibGroups()/applyLibSearch() (called at the end of toggleFavorite) reads window._LIB2
  const toggleFavorite = vmMod.runInContext('toggleFavorite', ctx);

  const p1 = toggleFavorite('Barbell Back Squat', null);
  const p2 = toggleFavorite('Barbell Back Squat', null); // fired while the first is still in flight
  ok(postCount === 1, `only ONE POST fired for two fast taps on the same star while the first is in flight (got ${postCount})`);
  pending[0]();
  await p1; await p2;

  // Once the first request has actually resolved, a genuine NEXT tap must go through normally —
  // the guard must release, not permanently jam the star.
  const p3 = toggleFavorite('Barbell Back Squat', null);
  ok(postCount === 2, `the guard releases after the in-flight request resolves — a real follow-up tap still sends its own POST (got ${postCount})`);
  pending[1]();
  await p3;

  // Two DIFFERENT exercises must never block each other.
  const p4 = toggleFavorite('Front Squat', null);
  ok(postCount === 3, `favoriting a DIFFERENT exercise while one is in flight is never blocked (got ${postCount})`);
  pending[2]();
  await p4;
}

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
