// v253 audit findings (client-side), verified here against the REAL public/app.js via node:vm —
// same harness family as test/confirm-sheet-stack.mjs / test/text-entry-double-tap.mjs /
// test/stale-save-race.mjs.
//
// 1. TPL_MODE leak (tplBack/newWorkout/workoutNow/tplUse): TPL_MODE (the "currently building or
//    editing a routine" flag) used to survive backing out of the routine editor via "< Back"
//    (which was `closeSheet();templatesPage()` inline — nothing reset TPL_MODE) and survive
//    tplUse() loading a DIFFERENT routine's exercises into an ordinary new-workout draft.
//    libDone() branches on TPL_MODE.active to decide whether "+ Add exercise" -> "Done" returns to
//    the routine editor or the create-flow — with the leak, an ordinary new workout's own "Done"
//    tap could silently route back into the editor for whichever OTHER routine was last opened,
//    and "Save changes" there overwrites it with whatever was just picked, while the actual new
//    workout is never created. No error, no confirmation. Traced by hand end to end (Templates ->
//    Edit "Push Day" -> Back -> "Use" a DIFFERENT routine -> + Add exercise -> Done) before fixing
//    — see the comments at tplBack/newWorkout/workoutNow/tplUse in app.js.
// 2. openCropper's fit() used Math.min (a CONTAIN fit) where clampCrop's own comment requires a
//    COVER fit (Math.max) — confirmed by computing the real base scale for a non-square photo.
// 3. Boot used to wipe the token and show the login screen on ANY /api/profile/me failure, not
//    just a real 401 (which already clears itself inside H._req). tryBoot() now only does that for
//    a confirmed-invalid session; anything else (network blip, 500, cold start) gets a retry
//    screen with the token left intact.
// 4. addLogSet() — the single most-tapped action in the app — had no double-tap guard. A fast
//    double-tap fired two overlapping POSTs and logged the same set twice. ADDLOG_BUSY now blocks
//    re-entry for the duration of the round-trip.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };

const SRC = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

function makeEl(tag) {
  const el = {
    tagName: tag || 'DIV', className: '', style: {}, innerHTML: '',
    parentNode: null, _children: [], _removed: false,
    _classes: new Set(),
    appendChild(child) { child.parentNode = el; el._children.push(child); return child; },
    remove() { el._removed = true; if (el.parentNode) el.parentNode._children = el.parentNode._children.filter(c => c !== el); },
    querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener() {}, setAttribute() {}, getAttribute() { return null; },
  };
  el.classList = {
    add: (...c) => c.forEach(x => el._classes.add(x)),
    remove: (...c) => c.forEach(x => el._classes.delete(x)),
    contains: c => el._classes.has(c),
  };
  return el;
}
const body = makeEl('BODY');
const navEl = makeEl('DIV');
const appEl = makeEl('DIV'); // real, inspectable innerHTML -- every screen render below is checked through this
const genericEl = () => new Proxy(function () {}, {
  get: (t, k) => k === 'children' || k === 'childNodes' ? [] : (k === 'innerText' || k === 'value' || k === 'textContent') ? '' : genericEl(),
  set: () => true, apply: () => genericEl(), has: () => true,
});
// Controllable stand-ins for the handful of fields these flows actually read .value from, plus the
// avatar cropper's two DOM handles. Anything else falls through to genericEl() below, same as
// every other vm-harness test in this suite.
const logW = { value: '' }, logR = { value: '' }, logRir = { value: '' };
const byId = {
  app: appEl, nav: navEl, logW, logR, logRir,
  logTypeSeg: null, logSetList: null, logRest: null,   // real DOM absence, not "unknown id"
};
const doc = {
  body,
  createElement: () => makeEl('DIV'),
  getElementById: (id) => (id in byId) ? byId[id] : genericEl(),
  querySelector: (sel) => sel === '.nav button.active' ? { dataset: { tab: 'me' } } : sel === '.sheet-back' ? (body._children.filter(c => c.className === 'sheet-back').at(-1) || null) : genericEl(),
  querySelectorAll: () => [],
  addEventListener() {}, documentElement: genericEl(), head: genericEl(), cookie: '', readyState: 'complete',
};

// URL-routed mock fetch, shared across all four sections below (each section sets what it needs
// right before driving its own flow). Anything unmatched resolves to {} immediately -- harmless
// for the fire-and-forget re-renders these flows trigger afterward (e.g. openSession(...,{silent:true})).
let templatesDB = { mine: [], shared: [] };
let profileMeResponder = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ id: 'me1', displayName: 'Me' }) });
// url -> queue of resolve fns, for the double-tap timing test. A queue (not a single slot) so
// that IF the guard under test were ever missing/broken and two overlapping requests actually go
// out to the same URL, both get their own resolver instead of the second silently clobbering the
// first's -- an unguarded double-tap then fails the assertion cleanly (extra POST counted) instead
// of hanging the whole test on a promise nothing will ever release.
const pending = new Map();
// Drains (releases) every currently-queued request for a URL, not just the oldest one -- so if
// the guard under test were missing and two requests really did queue up, this still resolves
// both rather than leaving the second to hang an `await Promise.all(...)` forever.
function pendingReleaseAll(url) { const q = pending.get(url) || []; pending.set(url, []); q.forEach(fn => fn()); }
function mockFetch(url, opts) {
  const method = (opts && opts.method) || 'GET';
  if (url === '/api/templates' && method === 'GET') {
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(templatesDB) });
  }
  if (/^\/api\/templates\/[^/]+$/.test(url) && method === 'PUT') {
    const b = JSON.parse(opts.body);
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, ...b }) });
  }
  if (url === '/api/friends') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ friends: [] }) });
  if (url === '/api/exercises') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
  if (url === '/api/sessions') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
  if (url === '/api/feed') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
  if (/^\/api\/progress/.test(url)) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
  if (/^\/api\/profile\/me/.test(url)) return profileMeResponder();
  if (/^\/api\/sessions\/[^/]+\/log$/.test(url) && method === 'POST') {
    return new Promise(resolve => {
      const q = pending.get(url) || []; pending.set(url, q);
      q.push(() => resolve({ ok: true, status: 200, json: () => Promise.resolve({ logs: { me1: [] } }) }));
    });
  }
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
}
const ctx = {
  console: { log() {}, warn() {}, error() {} }, document: doc,
  localStorage: {
    _store: {},
    getItem(k) { return Object.prototype.hasOwnProperty.call(this._store, k) ? this._store[k] : null; },
    setItem(k, v) { this._store[k] = v; },
    removeItem(k) { delete this._store[k]; },
  },
  fetch: (...a) => mockFetch(...a),
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
  ResizeObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
  addEventListener() {}, removeEventListener() {},
};
ctx.window = ctx; ctx.globalThis = ctx; ctx.self = ctx;
vm.createContext(ctx);
vm.runInContext(SRC, ctx, { filename: 'public/app.js' });
// The boot IIFE at the bottom of app.js runs the instant the script loads. This fresh localStorage
// stub has no token, so it takes the quick "no token -> authScreen()" path harmlessly. Give it a
// tick to settle before any test below starts driving state of its own.
await new Promise(r => setTimeout(r, 0));

const tplEdit = vm.runInContext('tplEdit', ctx);
const tplBack = vm.runInContext('tplBack', ctx);
const tplUse = vm.runInContext('tplUse', ctx);
const newWorkout = vm.runInContext('newWorkout', ctx);
const workoutNow = vm.runInContext('workoutNow', ctx);
const tryBoot = vm.runInContext('tryBoot', ctx);
const addLogSet = vm.runInContext('addLogSet', ctx);
const openCropper = vm.runInContext('openCropper', ctx);

function setTplMode(active, id) {
  vm.runInContext(`TPL_MODE.active=${active}; TPL_MODE.id=${id === null ? 'null' : JSON.stringify(id)}; TPL_MODE.name=${JSON.stringify(id || '')}; TPL_MODE.copy=false;`, ctx);
}
function getTplMode() { return vm.runInContext('({active:TPL_MODE.active, id:TPL_MODE.id})', ctx); }

console.log('=== TPL_MODE leak (routine editor Back / new workout / Use a routine) ===');
{
  templatesDB = {
    mine: [
      { id: 'tpl1', name: 'Push Day', ownerId: 'me1', exercises: [{ name: 'Bench Press', defaultSets: 3, defaultReps: 8 }] },
      { id: 'tpl2', name: 'Leg Day', ownerId: 'me1', exercises: [{ name: 'Squat', defaultSets: 3, defaultReps: 5 }] },
    ],
    shared: [],
  };
  vm.runInContext('ME = {id:"me1"}; TOKEN = "t";', ctx);

  await tplEdit('tpl1');
  ok(getTplMode().active === true && getTplMode().id === 'tpl1',
    `tplEdit enters TPL_MODE for the routine being edited (got ${JSON.stringify(getTplMode())})`);

  tplBack();
  await new Promise(r => setTimeout(r, 0)); // tplBack's templatesPage() is async
  ok(getTplMode().active === false && getTplMode().id === null,
    `tplBack() clears TPL_MODE instead of leaving it pointed at Push Day (got ${JSON.stringify(getTplMode())})`);

  // newWorkout()'s and workoutNow()'s OWN defensive clears, isolated from tplBack by forcing the
  // leak directly first -- proves each one independently guards the entry into a new workout.
  // Each of these calls a real render (createFlow()/openAddExercises()) the same fire-and-forget
  // way a real onclick would -- settling a tick after each keeps that dangling render from landing
  // asynchronously in a LATER section and clobbering whatever it renders next (caught by hand: an
  // unsettled tplUse()->createFlow() from here once landed mid-way through the boot section below).
  setTplMode(true, 'tpl1');
  newWorkout();
  ok(getTplMode().active === false,
    `newWorkout() clears a leaked TPL_MODE on its own (got ${JSON.stringify(getTplMode())})`);
  await new Promise(r => setTimeout(r, 0));

  setTplMode(true, 'tpl1');
  workoutNow();
  ok(getTplMode().active === false,
    `workoutNow() clears a leaked TPL_MODE on its own too (got ${JSON.stringify(getTplMode())})`);
  await new Promise(r => setTimeout(r, 0));

  // tplUse()'s own clear -- this is the exact step that turned the leak into silent data loss in
  // the real repro: Use loads a DIFFERENT routine's exercises into what the user believes is an
  // ordinary new-workout draft.
  setTplMode(true, 'tpl1');
  await tplUse('tpl2');
  ok(getTplMode().active === false,
    `tplUse() clears TPL_MODE when loading a different routine into a new-workout draft (got ${JSON.stringify(getTplMode())})`);
  // tplUse()'s own trailing createFlow() call is fire-and-forget too (matches the real onclick) --
  // settle it out before the next section renders into the same $('app').
  await new Promise(r => setTimeout(r, 0));
  await new Promise(r => setTimeout(r, 0));
}

console.log('\n=== Avatar cropper: cover-fit, not contain-fit ===');
{
  // 1600x900 (landscape) photo into a 300x300 circular stage -- the exact numbers traced by hand
  // in the app.js comment. A contain-fit (the old Math.min) leaves the image only 168.75px tall
  // against a 300px stage even after the 1.2x start zoom; a cover-fit (Math.max) must not.
  const stageEl = { clientWidth: 300, clientHeight: 300, addEventListener() {} };
  const imgEl = { naturalWidth: 1600, naturalHeight: 900, complete: true, style: {} };
  byId.cropStage = stageEl; byId.cropImg = imgEl;

  openCropper('data:image/jpeg;base64,xx', 'image/jpeg');
  const crop = vm.runInContext('_crop', ctx);
  const expectedBase = Math.max(300 / 1600, 300 / 900); // cover: the LARGER ratio
  ok(Math.abs(crop.base - expectedBase) < 1e-9,
    `fit() computes a cover-fit base scale, not a contain-fit one (base=${crop.base}, expected ${expectedBase})`);
  const w = imgEl.naturalWidth * crop.base * crop.scale, h = imgEl.naturalHeight * crop.base * crop.scale;
  ok(w >= stageEl.clientWidth - 1e-9 && h >= stageEl.clientHeight - 1e-9,
    `the scaled image covers the stage on BOTH axes -- no gap around the circular crop (w=${w.toFixed(1)}, h=${h.toFixed(1)}, stage=300x300)`);
}

console.log('\n=== Boot: a network/server hiccup must not log out a valid session ===');
{
  // Case A: the server is unreachable, or errors in a way that is NOT a confirmed 401 -- the
  // token might be completely fine. Must not be wiped; must offer a retry, not the login screen.
  vm.runInContext('TOKEN = "validtoken123";', ctx);
  ctx.localStorage.setItem('crewfit_token', 'validtoken123');
  profileMeResponder = () => Promise.reject(new Error('network down'));
  await tryBoot();
  ok(vm.runInContext('TOKEN', ctx) === 'validtoken123',
    `a network failure at boot does NOT wipe a possibly-still-valid token (got TOKEN=${JSON.stringify(vm.runInContext('TOKEN', ctx))})`);
  ok(ctx.localStorage.getItem('crewfit_token') === 'validtoken123', `localStorage keeps the token too`);
  ok(/Retry/i.test(appEl.innerHTML) && appEl.innerHTML.includes('tryBoot()'),
    `shows a retry screen wired back to tryBoot(), not the login form`);
  ok(!/Create new user/.test(appEl.innerHTML), `and specifically not the login screen`);

  // Case B: a genuinely invalid/expired token -- H._req itself sees a real 401 and clears
  // everything. Confirms the fix didn't regress this (already-correct) behavior.
  vm.runInContext('TOKEN = "staletoken";', ctx);
  ctx.localStorage.setItem('crewfit_token', 'staletoken');
  profileMeResponder = () => Promise.resolve({ ok: true, status: 401, json: () => Promise.resolve({ error: 'invalid' }) });
  await tryBoot();
  ok(vm.runInContext('TOKEN', ctx) === '',
    `a REAL 401 still clears the token exactly as before (got TOKEN=${JSON.stringify(vm.runInContext('TOKEN', ctx))})`);
  ok(ctx.localStorage.getItem('crewfit_token') === null, `and clears it from localStorage too`);

  // Case C: happy path -- a successful load still reaches home(), token untouched. Like the real
  // code, tryBoot() fires home() without awaiting it (home() itself is async and does its own
  // fetches) -- settle a couple of ticks so its render actually lands before checking $('app').
  vm.runInContext('TOKEN = "goodtoken";', ctx);
  profileMeResponder = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ id: 'me1', displayName: 'Me' }) });
  await tryBoot();
  await new Promise(r => setTimeout(r, 0));
  await new Promise(r => setTimeout(r, 0));
  ok(vm.runInContext('TOKEN', ctx) === 'goodtoken',
    `a successful profile load keeps the token (got ${JSON.stringify(vm.runInContext('TOKEN', ctx))})`);
  ok(/Good (morning|afternoon|evening)/.test(appEl.innerHTML), `and renders home(), not a retry or login screen`);
}

console.log('\n=== addLogSet(): double-tap guard ===');
{
  vm.runInContext('LOGVIEW = {sid:"sess1", exId:"ex1"}; ME = {id:"me1"};', ctx);
  logW.value = '135'; logR.value = '8'; logRir.value = '';
  pending.clear();
  let postCount = 0;
  const baseMock = mockFetch;
  ctx.fetch = (url, opts) => {
    if (/^\/api\/sessions\/[^/]+\/log$/.test(url) && (opts && opts.method) === 'POST') postCount++;
    return baseMock(url, opts);
  };

  const p1 = addLogSet(); // first tap
  const p2 = addLogSet(); // accidental fast second tap, before the first request has resolved
  ok(postCount === 1, `a fast double-tap on Log Set only fires ONE request, not two (posted ${postCount} times)`);
  pendingReleaseAll('/api/sessions/sess1/log'); // release whatever actually went out
  await Promise.all([p1, p2]);
  ok(postCount === 1, `still only one request once the first resolves -- the second tap was dropped, not queued (posted ${postCount} times)`);

  // The guard must release afterward -- a genuinely later, separate tap must still work normally.
  // (addLogSet() clears the weight/reps fields on a successful save, same as the real UI does --
  // put them back, same as the user typing the next set.)
  postCount = 0; pending.clear();
  logW.value = '145'; logR.value = '6';
  const p3 = addLogSet();
  pendingReleaseAll('/api/sessions/sess1/log');
  await p3;
  ok(postCount === 1, `the guard releases once the request completes -- a later tap logs a new set normally (posted ${postCount} times)`);
}

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
