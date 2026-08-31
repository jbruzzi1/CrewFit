// Jeff, Aug 31, two asks in one message:
//  1. "My Workouts" (the profile page's workout grid/list) should default to List view, and the
//     Grid/List toggle buttons should swap on-screen positions to match (List first/left now,
//     Grid second/right -- same ids/handlers, just reordered).
//  2. A session shouldn't show "Live now" until 10 minutes before its scheduled time -- earlier
//     today it should read "Upcoming" instead. Once inside the 10-minute window (or the scheduled
//     time has already passed today), it flips to Live and stays Live the rest of the day, same
//     as before -- only the START of the Live window moved.
// This runs the REAL public/app.js: isSessionLiveNow/isSessionUpcoming directly, and the real
// home()/profileView() renders, same harness shape as test/session-missed.mjs and the profileView
// block in test/follow.mjs.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };

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
// Cold-review catch: minute/day offsets built from the REAL Date.now() can silently cross a
// midnight or year boundary depending on what moment the suite happens to run at (e.g.
// minsFromNow(240) landing "tomorrow" if run in the evening), flipping same-day-dependent
// assertions for reasons that have nothing to do with the app. Pin the vm's own notion of "now"
// to a fixed instant well clear of midnight (2pm local) instead, so isSessionLiveNow/
// isSessionUpcoming's internal `new Date()`/`Date.now()` calls are 100% deterministic regardless
// of when this file actually runs. Only the zero-arg / no-arg form is pinned -- `new Date(iso)`
// (used throughout app.js for parsing scheduledAt etc.) still parses normally.
const FIXED_NOW = new Date(2026, 7, 31, 14, 0, 0);
class FixedDate extends Date {
  constructor(...args) { args.length ? super(...args) : super(FIXED_NOW.getTime()); }
  static now() { return FIXED_NOW.getTime(); }
}
const ctx = { console: { log() {}, warn() {}, error() {} }, document: doc,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  fetch: () => Promise.resolve({ json: () => Promise.resolve([]), ok: true, status: 200, text: () => Promise.resolve('') }),
  location: { href: '/', pathname: '/', search: '', hash: '' },
  history: { replaceState() {}, pushState() {} }, addEventListener() {}, removeEventListener() {}, scrollTo() {},
  navigator: { userAgent: 'node', serviceWorker: { register: () => Promise.resolve() }, onLine: true },
  setTimeout, clearTimeout, setInterval, clearInterval, alert() {}, confirm: () => true, prompt: () => null,
  requestAnimationFrame: f => setTimeout(f, 0), matchMedia: () => ({ matches: false, addEventListener() {} }),
  FileReader: function () {}, Image: function () {}, URL, Blob: function () {}, FormData: function () {},
  IntersectionObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
  ResizeObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
  Date: FixedDate, Math };
ctx.window = ctx; ctx.globalThis = ctx; ctx.self = ctx;
vm.createContext(ctx);
vm.runInContext(SRC, ctx, { filename: 'public/app.js' });
vm.runInContext(`ME = { id: 'me1', displayName: 'Me' };`, ctx);

const isLive = vm.runInContext('isSessionLiveNow', ctx);
const isUpcoming = vm.runInContext('isSessionUpcoming', ctx);
// Built from the SAME fixed reference the vm's Date.now() resolves to, not the real wall clock.
const minsFromNow = n => new Date(FIXED_NOW.getTime() + n * 60000).toISOString();
const daysAhead = n => new Date(FIXED_NOW.getTime() + n * 86400000).toISOString();
const daysAgo = n => new Date(FIXED_NOW.getTime() - n * 86400000).toISOString();
const base = { history: [], logs: {}, posts: {} };

console.log('isSessionLiveNow() / isSessionUpcoming() -- the 10-minute window, unit level');
{
  ok(isLive({ ...base, scheduledAt: minsFromNow(11) }) === false, '11 min before scheduled time -> not live yet');
  ok(isUpcoming({ ...base, scheduledAt: minsFromNow(11) }) === true, '...and reads as Upcoming instead');

  ok(isLive({ ...base, scheduledAt: minsFromNow(9) }) === true, '9 min before scheduled time (inside the 10-min window) -> live');
  ok(isUpcoming({ ...base, scheduledAt: minsFromNow(9) }) === false, '...and is NOT also Upcoming (mutually exclusive)');

  ok(isLive({ ...base, scheduledAt: minsFromNow(10) }) === true, 'exactly 10 min before -> live (boundary is inclusive)');

  ok(isLive({ ...base, scheduledAt: minsFromNow(-180) }) === true, 'scheduled time already passed, same day -> still live (unchanged behavior)');
  ok(isUpcoming({ ...base, scheduledAt: minsFromNow(-180) }) === false, '...and not Upcoming');

  ok(isLive({ ...base, scheduledAt: daysAhead(1) }) === false, 'a different (future) day -> not live regardless of time-of-day math');
  ok(isUpcoming({ ...base, scheduledAt: daysAhead(1) }) === false, '...and not Upcoming either -- Upcoming is "today", not "someday"');

  ok(isLive({ ...base, scheduledAt: daysAgo(1) }) === false, 'yesterday -> not live');
  ok(isUpcoming({ ...base, scheduledAt: daysAgo(1) }) === false, 'yesterday -> not upcoming (that is Missed territory)');

  const finished = { ...base, scheduledAt: minsFromNow(2), history: [{ userId: 'me1', date: '2026-01-01' }] };
  ok(isLive(finished) === false, 'already finished by me -> never live, even inside the window');
  ok(isUpcoming(finished) === false, 'already finished by me -> never upcoming either');

  ok(isLive({ ...base, scheduledAt: 'garbage' }) === false, 'unparseable date fails safe for live');
  ok(isUpcoming({ ...base, scheduledAt: 'garbage' }) === false, 'unparseable date fails safe for upcoming');
  ok(isLive(null) === false && isUpcoming(null) === false, 'a null session fails safe for both');
}

console.log('\nthe real Home render -- Live/Upcoming/Missed badges and the amber highlight');
{
  const sessions = [
    { id: 's-live-soon', name: 'Leg Day', creatorId: 'me1', participants: ['me1'], invited: [],
      exercises: [{ id: 'e1' }], scheduledAt: minsFromNow(5), ...base },
    { id: 's-upcoming-today', name: 'Push Day', creatorId: 'me1', participants: ['me1'], invited: [],
      exercises: [{ id: 'e1' }], scheduledAt: minsFromNow(240), ...base },
    { id: 's-missed', name: 'Pull Day', creatorId: 'me1', participants: ['me1'], invited: [],
      exercises: [{ id: 'e1' }], scheduledAt: daysAgo(2), ...base },
    { id: 's-future', name: 'Arms Day', creatorId: 'me1', participants: ['me1'], invited: [],
      exercises: [{ id: 'e1' }], scheduledAt: daysAhead(3), ...base },
  ];
  vm.runInContext(`
    H.get = (p) => Promise.resolve(
      p === '/api/sessions' ? ${JSON.stringify(sessions)} :
      p === '/api/feed' ? [] :
      p === '/api/friends' ? { friends: [] } : []
    );
  `, ctx);
  sink.html = '';
  await vm.runInContext('home', ctx)();

  const rows = sink.html.split('lib-item').slice(1);
  const rowFor = name => rows.find(r => r.includes(name)) || '';

  ok(/Live now/.test(rowFor('Leg Day')), 'a session 5 min out shows "Live now"');
  ok(/Upcoming/.test(rowFor('Push Day')), 'a session 4 hours out today shows "Upcoming"');
  ok(!/Live now/.test(rowFor('Push Day')), '...and NOT "Live now"');
  ok(/Missed/.test(rowFor('Pull Day')), 'a 2-day-old unfinished session still shows "Missed", unaffected by this change');
  ok(!/Upcoming/.test(rowFor('Pull Day')) && !/Live now/.test(rowFor('Pull Day')), '...and never Upcoming/Live');
  ok(!/Missed|Upcoming|Live now/.test(rowFor('Arms Day')), 'a session 3 days out shows no badge at all (not "today", per Jeff\'s framing)');

  // session-live (the amber highlighted row) is reserved for true Live, not Upcoming.
  const liveIdx = sink.html.indexOf('Leg Day');
  const upcomingIdx = sink.html.indexOf('Push Day');
  const liveRowStart = sink.html.lastIndexOf('lib-item', liveIdx);
  const upcomingRowStart = sink.html.lastIndexOf('lib-item', upcomingIdx);
  ok(sink.html.slice(liveRowStart, liveIdx).includes('session-live'), 'the Live row gets the amber "session-live" highlight class');
  ok(!sink.html.slice(upcomingRowStart, upcomingIdx).includes('session-live'), 'the Upcoming row does NOT get the amber highlight (reserved for true Live)');

  // Both today's sessions (live or upcoming) still get pulled to the top, ahead of the missed one.
  ok(liveIdx < sink.html.indexOf('Pull Day'), 'the live-soon session still sorts ahead of the missed one');
  ok(upcomingIdx < sink.html.indexOf('Pull Day'), 'the upcoming-today session also still sorts ahead of the missed one (unchanged "today" priority)');
}

console.log('\nMy Workouts (profile page): defaults to List view, buttons swapped on screen');
{
  const PROFILE = {
    id: 'owner1', username: 'owner', displayName: 'Owner', workoutsCompleted: 1, following: 0, followers: 0,
    youFollow: 'none', followsYou: false, limited: false, prCount: null, prs: [], streak: null, recentActivity: [],
    myWorkouts: [{ id: 'w1', name: 'Leg Day', at: '2026-08-10T00:00:00.000Z', firstExercises: ['Squat'], exerciseCount: 1 }],
  };
  vm.runInContext(`H.get = () => Promise.resolve(${JSON.stringify(PROFILE)}); window.__wview = undefined;`, ctx);
  sink.html = '';
  await vm.runInContext('profileView', ctx)('owner1');

  ok(sink.html.includes('id="vtList"'), 'the List button renders');
  ok(sink.html.includes('id="vtGrid"'), 'the Grid button renders');
  const listBtnPos = sink.html.indexOf('id="vtList"');
  const gridBtnPos = sink.html.indexOf('id="vtGrid"');
  ok(listBtnPos < gridBtnPos, 'List button now comes FIRST in the markup (was Grid, then List -- now swapped)');

  // "on" (the active-state class) should land on List by default now, not Grid.
  const listBtnTag = sink.html.slice(listBtnPos - 30, listBtnPos + 10);
  const gridBtnTag = sink.html.slice(gridBtnPos - 30, gridBtnPos + 10);
  ok(/class="on"/.test(listBtnTag), `List button is marked active by default (got: ${listBtnTag})`);
  ok(!/class="on"/.test(gridBtnTag), `Grid button is NOT active by default (got: ${gridBtnTag})`);

  // And the actual rendered workout view uses the list layout (wlist class), not the grid-only one.
  const viewSectionStart = sink.html.indexOf('id="workoutView"');
  const viewSection = sink.html.slice(viewSectionStart, viewSectionStart + 400);
  ok(viewSection.includes('wlist'), `the default rendered view is the List layout, not Grid (got: ${viewSection.slice(0, 200)})`);
}

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
