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
    // v364: a SECOND live session -- the first one is the Next up card, this one must still be a
    // row with the amber highlight.
    { id: 's-live-2', name: 'Core Day', creatorId: 'me1', participants: ['me1'], invited: [],
      exercises: [{ id: 'e1' }], scheduledAt: minsFromNow(8), ...base },
  ];
  vm.runInContext(`
    H.get = (p) => Promise.resolve(
      p === '/api/sessions' ? ${JSON.stringify(sessions)} :
      p === '/api/feed' ? [] :
      p === '/api/friends' ? { friends: [] } : []
    );
  `, ctx);
  sink.html = '';
  // v364: Home caps "Your sessions" at 3 rows behind a "See all" button; this fixture has 5 open
  // sessions (1 card + 4 rows), so render with the expansion on to see every row.
  vm.runInContext('window.HOME_ALL_SESSIONS = true', ctx);
  await vm.runInContext('home', ctx)({ silent: true });

  const rows = sink.html.split('lib-item').slice(1);
  const rowFor = name => rows.find(r => r.includes(name)) || '';

  // v364 (Sep 7): the live session is Home's single "Next up" card now, not a row -- the badge
  // moves with it. Everything else still renders as rows under "Your sessions".
  const card = (sink.html.match(/<div class="next-card"[\s\S]*?<div class="next-actions"/) || [''])[0];
  ok(card.includes('Leg Day') && /Live now/.test(card), 'a session 5 min out is the Next up card and shows "Live now"');
  ok(/Upcoming/.test(rowFor('Push Day')), 'a session 4 hours out today shows "Upcoming"');
  ok(!/Live now/.test(rowFor('Push Day')), '...and NOT "Live now"');
  ok(/Missed/.test(rowFor('Pull Day')), 'a 2-day-old unfinished session still shows "Missed", unaffected by this change');
  ok(!/Upcoming/.test(rowFor('Pull Day')) && !/Live now/.test(rowFor('Pull Day')), '...and never Upcoming/Live');
  ok(!/Missed|Upcoming|Live now/.test(rowFor('Arms Day')), 'a session 3 days out shows no badge at all (not "today", per Jeff\'s framing)');

  // session-live (the amber highlighted row) is reserved for true Live, not Upcoming. The live one
  // is the card here (v364), so the row-level check is that the Upcoming row stays un-highlighted.
  const upcomingIdx = sink.html.indexOf('Push Day');
  const upcomingRowStart = sink.html.lastIndexOf('lib-item', upcomingIdx);
  ok(!sink.html.slice(upcomingRowStart, upcomingIdx).includes('session-live'), 'the Upcoming row does NOT get the amber highlight (reserved for true Live)');
  ok(!card.includes('Push Day') && !card.includes('Arms Day') && !card.includes('Core Day'), 'only ONE session is in the Next up card -- the rest are rows');
  const live2Idx = sink.html.indexOf('Core Day'); const live2RowStart = sink.html.lastIndexOf('lib-item', live2Idx);
  ok(/Live now/.test(rowFor('Core Day')) && sink.html.slice(live2RowStart, live2Idx).includes('session-live'), 'a second live session is a row with "Live now" AND the amber session-live highlight');

  // Both today's sessions (live or upcoming) still get pulled to the top, ahead of the missed one.
  ok(sink.html.indexOf('Leg Day') < sink.html.indexOf('Pull Day'), 'the live-soon session (the card) still sits ahead of the missed one');
  ok(upcomingIdx < sink.html.indexOf('Pull Day'), 'the upcoming-today session also still sorts ahead of the missed one (unchanged "today" priority)');
}

console.log('\nHome week strip / expandable month calendar (Sep 8, Jeff: "have the calendar expandable... selecting the days open the workouts")');
{
  // FIXED_NOW is Mon Aug 31 2026 -- deliberately: the Monday-first grid for THIS month (August)
  // needs 5 leading days (back to Mon Jul 27) AND 6 trailing days (through Sun Sep 6) to fill out
  // a 6-row grid, so this one fixture exercises both boundaries at once, plus the "today is also
  // the grid's very first live day" edge.
  const doneSession = { id: 's-done-825', name: 'Pull Day', creatorId: 'me1', participants: ['me1'], invited: [],
    exercises: [{ id: 'e1' }], scheduledAt: '2026-08-25T18:00:00.000Z', logs: {}, posts: {},
    history: [{ userId: 'me1', date: '2026-08-25' }] };
  // Scheduled for Sep 3 -- inside the grid's TRAILING (next-month) days when viewing August expanded.
  const plannedSession = { id: 's-plan-sep3', name: 'Leg Day', creatorId: 'me1', participants: ['me1'], invited: [],
    exercises: [{ id: 'e1' }], scheduledAt: daysAhead(3), history: [], logs: {}, posts: {} };
  const sessions = [doneSession, plannedSession];
  vm.runInContext(`
    H.get = (p) => Promise.resolve(
      p === '/api/sessions' ? ${JSON.stringify(sessions)} :
      p === '/api/feed' ? [] :
      p === '/api/friends' ? { friends: [] } : []
    );
  `, ctx);

  // --- Collapsed (default): unchanged 7-day strip, Aug 31 (today) through Sep 6 ---
  sink.html = '';
  vm.runInContext('window.HOME_CAL_EXPANDED = undefined', ctx);
  await vm.runInContext('home', ctx)({ silent: true });
  const stripHtml = (sink.html.match(/<div class="week-strip">[\s\S]*?<\/div>\s*<\/div>/) || [''])[0];
  const wkCells = sink.html.match(/<div class="wk[^"]*"[^>]*>/g) || [];
  ok(wkCells.length === 7, `collapsed strip renders exactly 7 day cells (got ${wkCells.length})`);
  ok(sink.html.includes('Show full month'), 'the toggle link offers to expand, collapsed by default');
  ok(!sink.html.includes('Show week only'), 'and does not simultaneously offer to collapse');
  ok(/class="wk today"[^>]*><div class="dot"><\/div>Mon/.test(sink.html) || /"wk[^"]*today[^"]*"/.test(sink.html), 'today (Aug 31, a blank/open day) is marked .today');
  ok(sink.html.includes(`onclick="planDayFor('2026-09-01')"`), 'tomorrow (a blank future day) is tappable to plan, same as before this change');

  // --- Expanded: August 2026, Monday-first, 6 rows (5 leading + 31 + 6 trailing = 42 cells) ---
  vm.runInContext('window.HOME_CAL_EXPANDED = true', ctx);
  sink.html = '';
  await vm.runInContext('home', ctx)({ silent: true });
  ok(sink.html.includes('August 2026'), `month label renders (got no match in: ${sink.html.slice(sink.html.indexOf('cal-lbl'), sink.html.indexOf('cal-lbl')+60)})`);
  ok(sink.html.includes('cal-hdr'), 'the Mon..Sun weekday-initials header renders');
  const monthWkCells = sink.html.match(/<div class="wk[^"]*"[^>]*>/g) || [];
  ok(monthWkCells.length === 42, `expanded grid renders 5 leading + 31 August + 6 trailing = 42 day cells (got ${monthWkCells.length})`);
  ok(sink.html.includes('Show week only'), 'the toggle now offers to collapse back');
  ok(!sink.html.includes('Show full month'), 'and no longer offers to expand (already expanded)');

  // The done day (Aug 25) -- real date, checkmark, opens the recap, NOT dimmed (it's inside August).
  const doneCellIdx = sink.html.indexOf('viewPost(\'s-done-825\'');
  ok(doneCellIdx > -1, 'Aug 25 (a finished session, via history date -- no logs needed) opens its recap on tap');
  const doneCellTag = sink.html.slice(Math.max(0, doneCellIdx - 120), doneCellIdx);
  ok(/class="wk done"/.test(doneCellTag) || /"wk[^"]*done[^"]*"/.test(doneCellTag), 'Aug 25\'s cell carries the done class (green check)');
  ok(!/dim/.test(doneCellTag), 'Aug 25 is inside the current month, so it is NOT dimmed');

  // Sep 3 (the planned session) -- inside the grid's TRAILING days -- still opens the real session,
  // but IS dimmed since it belongs to the next month, not August.
  const planCellIdx = sink.html.indexOf(`openSession('s-plan-sep3')`);
  ok(planCellIdx > -1, 'Sep 3 (a planned session, shown as a trailing day of the August grid) opens the real session on tap');
  const planCellTag = sink.html.slice(Math.max(0, planCellIdx - 120), planCellIdx);
  ok(/dim/.test(planCellTag), 'Sep 3 is dimmed -- it belongs to September, not the August month being shown');

  // Sep 1 (a blank trailing day) -- still tappable to plan, still its own real date, still dimmed.
  const blankTrailIdx = sink.html.indexOf(`planDayFor('2026-09-01')`);
  ok(blankTrailIdx > -1, 'Sep 1 (blank, trailing) is still tappable to plan that exact real date');
  ok(/dim/.test(sink.html.slice(Math.max(0, blankTrailIdx - 120), blankTrailIdx)), 'Sep 1 is dimmed too, same as any other day outside August');

  // A blank PAST day within August itself (before today, nothing done/planned) stays fully inert --
  // unaffected by expanding, same "no dead-end plan button on a day that already happened" rule.
  ok(!sink.html.includes(`planDayFor('2026-08-20')`), 'a blank day BEFORE today (Aug 20) is not tappable to plan, expanded or not');

  // Collapsing back drops the month grid and restores exactly the 7-cell strip.
  vm.runInContext('window.HOME_CAL_EXPANDED = false', ctx);
  sink.html = '';
  await vm.runInContext('home', ctx)({ silent: true });
  ok((sink.html.match(/<div class="wk[^"]*"[^>]*>/g) || []).length === 7, 'toggling back to the week strip returns to exactly 7 cells');
  ok(!sink.html.includes('cal-hdr'), 'and the month header is gone');

  // A real (non-silent) navigation to Home resets the expansion, same rule HOME_ALL_SESSIONS
  // already follows -- expanding the calendar should not silently persist across a real revisit.
  vm.runInContext('window.HOME_CAL_EXPANDED = true', ctx);
  await vm.runInContext('home', ctx)({});
  ok(vm.runInContext('!!window.HOME_CAL_EXPANDED', ctx) === false, 'a real navigation to Home resets HOME_CAL_EXPANDED back to false');
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
