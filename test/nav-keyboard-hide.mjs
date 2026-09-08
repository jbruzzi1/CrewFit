// Jeff, Sep 8, screenshot from Create workout's "Length (min)" field: opening the on-screen
// keyboard on that screen (a plain full-page form, not a modal sheet) dragged the bottom nav bar
// up to float mid-screen, riding the top edge of the keyboard, instead of just disappearing behind
// it the way a native tab bar would.
//
// Root cause: .nav is a real flex sibling of #app at the bottom of body's flex column (see the
// comment above .nav in public/index.html), and syncFrameToViewport() in app.js -- built earlier
// (Aug 28/v363) so #app stays scrollable above the keyboard -- shrinks body's OWN height to
// window.visualViewport.height whenever the keyboard opens. Since .nav is still the last thing in
// that now-shorter flex column, it rides up along with it instead of staying pinned to the real
// (keyboard-covered) bottom of the screen.
//
// Fix: syncFrameToViewport() now also toggles a `.kb-hide` class on #nav -- a class distinct from
// the auth flow's own `.hidden` (toggled in setToken/logout) specifically so closing the keyboard
// while logged out can't accidentally reveal the nav again.
//
// This runs the REAL public/app.js in a node:vm context, same harness shape as
// test/home-live-window-and-workouts-view.mjs, but with a minimal stub tailored to this one
// function: a stable #nav element with a real (Set-backed) classList so add/remove actually
// persist across calls (the shared el() Proxy used elsewhere returns a fresh object every access,
// which can't hold state), a stable document.body.style object, and a controllable
// window.visualViewport whose height we move by hand to simulate the keyboard opening and closing
// (no real on-screen keyboard exists in this harness or in headless Chromium either).
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };

const SRC = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

function makeClassList(state) {
  return {
    add: (...cs) => cs.forEach(c => state.add(c)),
    remove: (...cs) => cs.forEach(c => state.delete(c)),
    contains: c => state.has(c),
    toggle: (c, force) => { const has = state.has(c); const on = force === undefined ? !has : force; if (on) state.add(c); else state.delete(c); return on; },
  };
}

const navClasses = new Set(['hidden']);   // starts logged-out, same as a fresh page load
const navEl = { get classList() { return makeClassList(navClasses); } };
const bodyStyle = {};
const bodyEl = { style: bodyStyle };

const genericEl = () => new Proxy(function () {}, {
  get: (t, k) => k === 'style' || k === 'classList' || k === 'dataset' ? genericEl()
    : k === 'innerHTML' ? '' : k === 'children' || k === 'childNodes' ? [] : genericEl(),
  set: () => true, apply: () => genericEl(), has: () => true,
});
const doc = {
  getElementById: (id) => id === 'nav' ? navEl : id === 'app' ? genericEl() : genericEl(),
  querySelector: () => genericEl(), querySelectorAll: () => [],
  createElement: () => genericEl(), addEventListener() {}, body: bodyEl, documentElement: genericEl(), head: genericEl(),
  cookie: '', readyState: 'complete',
};

const vvListeners = {};
const vv = {
  height: 800,
  addEventListener(type, fn) { (vvListeners[type] = vvListeners[type] || []).push(fn); },
  removeEventListener() {},
};

const ctx = { console: { log() {}, warn() {}, error() {} }, document: doc,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  // Deliberately NO `fetch` here (unlike the home-render test harness): app.js's boot code
  // registers a real 10-minute `setInterval(checkAppVersion, ...)` at load time, but only when
  // `typeof fetch === 'function'` passes its feature-detect guard. This test never calls anything
  // networked, and a live un-refed interval would keep this process (and `npm test`) alive well
  // past its normal exit -- leaving `fetch` undefined keeps that guard false without touching
  // anything this test actually exercises.
  location: { href: '/', pathname: '/', search: '', hash: '' },
  history: { replaceState() {}, pushState() {} }, addEventListener() {}, removeEventListener() {},
  scrollTo() {}, innerHeight: 800, visualViewport: vv,
  navigator: { userAgent: 'node', serviceWorker: { register: () => Promise.resolve() }, onLine: true },
  setTimeout, clearTimeout, setInterval, clearInterval, alert() {}, confirm: () => true, prompt: () => null,
  requestAnimationFrame: f => setTimeout(f, 0), matchMedia: () => ({ matches: false, addEventListener() {} }),
  FileReader: function () {}, Image: function () {}, URL, Blob: function () {}, FormData: function () {},
  IntersectionObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
  ResizeObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
  Date, Math };
ctx.window = ctx; ctx.globalThis = ctx; ctx.self = ctx;
vm.createContext(ctx);
vm.runInContext(SRC, ctx, { filename: 'public/app.js' });

console.log('syncFrameToViewport() hides/restores #nav around the on-screen keyboard, independent of auth-hidden state');
{
  ok(Array.isArray(vvListeners.resize) && vvListeners.resize.length >= 2, 'syncFrameToViewport is actually wired up as a visualViewport resize listener (not just definable, but really registered)');

  // Fire every registered resize listener (as a real 'resize' event would), not just call
  // syncFrameToViewport directly -- proves the wiring itself works, not only the function in
  // isolation. syncSheetsToViewport (also registered) is a harmless no-op here: no .sheet-back
  // exists in this DOM stub.
  const sync = () => vvListeners.resize.forEach(fn => fn());

  // No keyboard yet -- nothing should change.
  sync();
  ok(bodyStyle.height === undefined, 'no keyboard up: body height is left alone');
  ok(!navClasses.has('kb-hide'), 'no keyboard up: nav has no kb-hide class');
  ok(navClasses.has('hidden'), 'nav is still logged-out-hidden throughout (untouched so far)');

  // Keyboard opens (visualViewport shrinks well below innerHeight) -- same trigger as focusing the
  // Length (min) field on Create workout.
  vv.height = 400;
  sync();
  ok(bodyStyle.height === '400px', 'keyboard up: body is shrunk to the visible (above-keyboard) area, so #app stays scrollable');
  ok(navClasses.has('kb-hide'), 'keyboard up: nav gets kb-hide -- it disappears instead of riding up with the shrunk body');
  ok(vm.runInContext('FRAME_SHRUNK', ctx) === true, 'FRAME_SHRUNK flips true while the keyboard is up');
  ok(navClasses.has('hidden'), 'the pre-existing (auth) hidden class is untouched by the keyboard toggle');

  // Keyboard closes.
  vv.height = 800;
  sync();
  ok(bodyStyle.height === '', 'keyboard down: body height is restored');
  ok(!navClasses.has('kb-hide'), 'keyboard down: kb-hide is removed');
  ok(vm.runInContext('FRAME_SHRUNK', ctx) === false, 'FRAME_SHRUNK flips back false once the keyboard closes');
  ok(navClasses.has('hidden'), 'and the logged-out nav stays hidden -- closing the keyboard did not resurrect it (the whole reason kb-hide is a separate class from .hidden)');

  // Now the logged-in case: same keyboard cycle, but .hidden was never present (setToken removed
  // it) -- kb-hide must not depend on .hidden's absence either.
  navClasses.delete('hidden');
  vv.height = 400; sync();
  ok(navClasses.has('kb-hide') && !navClasses.has('hidden'), 'logged in: keyboard up hides nav via kb-hide alone');
  vv.height = 800; sync();
  ok(!navClasses.has('kb-hide') && !navClasses.has('hidden'), 'logged in: keyboard down restores nav (neither class present)');
}

console.log('\nclient markup / CSS');
{
  const html = readFileSync(new URL('../public/index.html', import.meta.url).pathname, 'utf8');
  ok(/\.nav\.kb-hide\s*\{\s*display:none;?\s*\}/.test(html), '.nav.kb-hide { display:none } rule is present');
  const vMatch = html.match(/app\.js\?v=(\d+)/);
  ok(!!vMatch && Number(vMatch[1]) >= 378, `cache-bust bumped to >= 378 (got ${vMatch && vMatch[1]})`);
}

console.log(fails ? `\n${fails} FAILURE(S)\n` : '\nall assertions passed\n');
if (fails) process.exit(1);
