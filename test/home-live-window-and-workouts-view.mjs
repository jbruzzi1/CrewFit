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

console.log('\nNext up vs Your sessions now keys on startedAt, not raw live-window timing (Sep 9 2026, Jeff: "I want to create a workout and it show up in what\'s up next until I click \'Start now\' then it moves to your sessions")');
{
  // Before this change, a session that's today and past its own scheduled time satisfies
  // isSessionLiveNow() forever (it's a pure clock check) -- which is exactly why a Quick Workout
  // (scheduled for the literal instant it's created) or any same-day "New workout" never left the
  // Next up card once its time arrived, no matter how long ago you actually opened it. The ONLY
  // thing that changed is which sessions are ELIGIBLE for the Next up slot: unstarted ones still
  // win it by the same live-then-soonest priority as before; a started one is never a candidate,
  // full stop, regardless of how "live" it looks by the clock.
  const started = { id: 's-started-live', name: 'Bench Day', creatorId: 'me1', participants: ['me1'], invited: [],
    exercises: [{ id: 'e1' }], scheduledAt: minsFromNow(-30), startedAt: minsFromNow(-30), ...base };
  vm.runInContext(`H.get = (p) => Promise.resolve(p === '/api/sessions' ? ${JSON.stringify([started])} : p === '/api/feed' ? [] : p === '/api/friends' ? { friends: [] } : []);`, ctx);
  sink.html = '';
  vm.runInContext('window.HOME_ALL_SESSIONS = true', ctx);
  await vm.runInContext('home', ctx)({ silent: true });
  ok(!sink.html.includes('class="next-card"'), 'the ONLY open session is live by the clock, but it is already started -- no Next up card at all');
  const startedRow = sink.html.split('lib-item').slice(1).find(r => r.includes('Bench Day')) || '';
  ok(/Live now/.test(startedRow), 'instead it is a row under Your sessions, still correctly badged "Live now" (badge logic is untouched, still time-based)');
  const startedRowIdx = sink.html.indexOf('Bench Day'); const startedRowStart = sink.html.lastIndexOf('lib-item', startedRowIdx);
  ok(sink.html.slice(startedRowStart, startedRowIdx).includes('session-live'), 'and gets the amber session-live highlight, same as any other live row');

  // Same session, minus startedAt -- the exact control case proving startedAt (not something else
  // about this fixture) is what moved it in the assertions just above.
  const notStartedYet = { ...started, startedAt: null };
  vm.runInContext(`H.get = (p) => Promise.resolve(p === '/api/sessions' ? ${JSON.stringify([notStartedYet])} : p === '/api/feed' ? [] : p === '/api/friends' ? { friends: [] } : []);`, ctx);
  sink.html = '';
  await vm.runInContext('home', ctx)({ silent: true });
  const card2 = (sink.html.match(/<div class="next-card"[\s\S]*?<div class="next-actions"[^>]*>[\s\S]*?<\/div>\s*<\/div>/) || [''])[0];
  ok(card2.includes('Bench Day') && /Live now/.test(card2), 'the identical session WITHOUT startedAt set is the Next up card instead, control case');
  ok(card2.includes(`startSession('${notStartedYet.id}')`), 'its primary action (and the card\'s own tap target) calls startSession(), not a plain openSession() -- tapping it is what is supposed to mark it started');
  ok(!card2.includes(`openSession('${notStartedYet.id}')`), '...and does not ALSO wire a plain openSession() call anywhere on the card (no inconsistent tap target)');

  // A genuinely future-day session (not today, not live) is never something you "start" by looking
  // at it -- its card stays a plain Open/openSession(), same as before this change.
  const future = { id: 's-future-plan', name: 'Future Day', creatorId: 'me1', participants: ['me1'], invited: [],
    exercises: [{ id: 'e1' }], scheduledAt: daysAhead(3), startedAt: null, ...base };
  vm.runInContext(`H.get = (p) => Promise.resolve(p === '/api/sessions' ? ${JSON.stringify([future])} : p === '/api/feed' ? [] : p === '/api/friends' ? { friends: [] } : []);`, ctx);
  sink.html = '';
  await vm.runInContext('home', ctx)({ silent: true });
  const card3 = (sink.html.match(/<div class="next-card"[\s\S]*?<div class="next-actions"[^>]*>[\s\S]*?<\/div>\s*<\/div>/) || [''])[0];
  ok(card3.includes('Future Day') && card3.includes('Open') && card3.includes(`openSession('${future.id}')`), 'a future (non-today) session\'s Next up card uses plain "Open"/openSession()');
  ok(!card3.includes(`startSession('${future.id}')`), '...never startSession() -- merely viewing a future plan does not start it');
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
  ok(sink.html.includes('August 2026'), `month label renders (got no match in: ${sink.html.slice(sink.html.indexOf('cal-nav'), sink.html.indexOf('cal-nav')+80)})`);
  ok(sink.html.includes('cal-hdr'), 'the Mon..Sun weekday-initials header renders');
  // Sep 8, round 2: the prev/next month arrows reuse the app's existing .cal-nav/.icon-btn
  // idiom (same as the "Pick a day" sheet's own month browser) rather than a bespoke control.
  ok(sink.html.includes('class="cal-nav"'), 'the month-nav row renders with the app\'s existing calendar-nav class');
  ok(sink.html.includes(`onclick="navHomeCalMonth(-1)"`) && sink.html.includes(`onclick="navHomeCalMonth(1)"`), 'both a previous- and next-month arrow render, wired to navHomeCalMonth');
  const monthWkCells = sink.html.match(/<div class="wk[^"]*"[^>]*>/g) || [];
  ok(monthWkCells.length === 42, `expanded grid renders 5 leading + 31 August + 6 trailing = 42 day cells (got ${monthWkCells.length})`);
  ok(sink.html.includes('Show week only'), 'the toggle now offers to collapse back');
  ok(!sink.html.includes('Show full month'), 'and no longer offers to expand (already expanded)');

  // cold-review catch (self-caught): a plain indexOf/backward-slice search for these onclick
  // strings also matches an UNRELATED control elsewhere on Home -- the "Share your recap" tip
  // card links to the same most-recent-finished session via the identical viewPost(...) call, and
  // it sits earlier in the page than the calendar grid, so a loose search silently grabbed THAT
  // markup instead of the actual .wk cell and read its (always non-dim) classes as the day's own.
  // This helper anchors the match to the day cell's OWN opening tag (class="wk ..." immediately
  // followed by the onclick, exactly how dayCell emits it) so it can never cross into other markup.
  const wkClassesFor = (onclickFrag) => {
    const m = sink.html.match(new RegExp(`<div class="(wk[^"]*)"\\s+onclick="${onclickFrag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
    return m ? m[1] : null;
  };

  // The done day (Aug 25) -- real date, checkmark, opens the recap, NOT dimmed (it's inside August).
  const doneCls = wkClassesFor(`viewPost('s-done-825','me1')`);
  ok(doneCls !== null, 'Aug 25 (a finished session, via history date -- no logs needed) opens its recap on tap');
  ok(/\bdone\b/.test(doneCls || ''), `Aug 25's cell carries the done class -- green check (got: ${doneCls})`);
  ok(!/\bdim\b/.test(doneCls || ''), 'Aug 25 is inside the current month, so it is NOT dimmed');

  // Sep 3 (the planned session) -- inside the grid's TRAILING days -- still opens the real session,
  // but IS dimmed since it belongs to the next month, not August.
  const planCls = wkClassesFor(`openSession('s-plan-sep3')`);
  ok(planCls !== null, 'Sep 3 (a planned session, shown as a trailing day of the August grid) opens the real session on tap');
  ok(/\bdim\b/.test(planCls || ''), `Sep 3 is dimmed -- it belongs to September, not the August month being shown (got: ${planCls})`);

  // Sep 1 (a blank trailing day) -- still tappable to plan, still its own real date, still dimmed.
  const blankTrailCls = wkClassesFor(`planDayFor('2026-09-01')`);
  ok(blankTrailCls !== null, 'Sep 1 (blank, trailing) is still tappable to plan that exact real date');
  ok(/\bdim\b/.test(blankTrailCls || ''), `Sep 1 is dimmed too, same as any other day outside August (got: ${blankTrailCls})`);

  // A blank PAST day within August itself (before today, nothing done/planned) stays fully inert --
  // unaffected by expanding, same "no dead-end plan button on a day that already happened" rule.
  ok(!sink.html.includes(`planDayFor('2026-08-20')`), 'a blank day BEFORE today (Aug 20) is not tappable to plan, expanded or not');

  // --- Paging with the arrows: navHomeCalMonth moves HOME_CAL_MONTH_OFFSET and re-renders ---
  const navHomeCalMonth = vm.runInContext('navHomeCalMonth', ctx);
  sink.html = '';
  navHomeCalMonth(1);   // -> September 2026
  await new Promise(r => setTimeout(r, 0));
  ok(sink.html.includes('September 2026'), `next-month arrow advances to September (got: ${sink.html.slice(sink.html.indexOf('cal-nav'), sink.html.indexOf('cal-nav')+80)})`);
  // September's Monday-first grid needs exactly ONE leading day (Sep 1 2026 is a Tuesday), and
  // that one leading day IS today (Aug 31) -- a genuinely useful edge: the real "today" still
  // needs to read as today even when it's only on screen as filler for the NEXT month's grid, and
  // .wk.dim.today (previously dead code when the grid was locked to the current month) is now the
  // real, reachable state this exercises.
  const todayCls = wkClassesFor(`planDayFor('2026-08-31')`);
  ok(todayCls !== null, 'Aug 31 (today, still blank/open) is September grid\'s one leading day, and still tappable to plan');
  ok(/\btoday\b/.test(todayCls || ''), `...still carries .today (the real date, not the viewed month, decides this) (got: ${todayCls})`);
  ok(/\bdim\b/.test(todayCls || ''), `...AND is dimmed, since September (not August) is the month on screen (got: ${todayCls})`);

  sink.html = '';
  navHomeCalMonth(-2);   // September -> August -> July
  await new Promise(r => setTimeout(r, 0));
  ok(sink.html.includes('July 2026'), `two steps back from September lands on July (got: ${sink.html.slice(sink.html.indexOf('cal-nav'), sink.html.indexOf('cal-nav')+80)})`);

  // Collapsing resets the paged offset -- re-expanding later starts back at the current month,
  // not wherever the user last browsed to.
  // Cold-review catch (self-caught): hand-poking the two globals to the values the toggle button
  // is SUPPOSED to produce doesn't actually exercise the button's own onclick ternary
  // (`${calExpanded?'window.HOME_CAL_MONTH_OFFSET=0;':''}` in home()) -- a dropped semicolon or a
  // flipped condition there would still pass. Extract the REAL rendered onclick string off the
  // "Show week only" button (still on screen from July, above) and run that verbatim instead.
  const collapseOnclick = (sink.html.match(/onclick="([^"]+)">Show week only</) || [])[1];
  ok(!!collapseOnclick && /HOME_CAL_MONTH_OFFSET=0/.test(collapseOnclick), 'the real collapse-button onclick actually zeroes HOME_CAL_MONTH_OFFSET, not just HOME_CAL_EXPANDED');
  sink.html = '';
  vm.runInContext(collapseOnclick, ctx);
  await new Promise(r => setTimeout(r, 0));
  ok((sink.html.match(/<div class="wk[^"]*"[^>]*>/g) || []).length === 7, 'clicking "Show week only" (the real onclick) collapses back to exactly 7 cells');
  ok(!sink.html.includes('cal-hdr'), 'and the month header is gone');

  // Now re-expand via the real "Show full month" onclick (also just rendered) and confirm the
  // offset it zeroed on collapse actually stuck -- lands back on August, not July where we paged to.
  const expandOnclick = (sink.html.match(/onclick="([^"]+)">Show full month</) || [])[1];
  ok(!!expandOnclick, 'the real "Show full month" button onclick string is present to extract');
  sink.html = '';
  vm.runInContext(expandOnclick, ctx);
  await new Promise(r => setTimeout(r, 0));
  ok(sink.html.includes('August 2026'), 're-expanding via the real button onclick lands back on the real current month, not July where we last paged to');

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
