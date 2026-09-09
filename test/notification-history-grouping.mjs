// Sep 8 2026 (Jeff: "this notification list should show notifications for 7 days (today and then
// last 7 days -- two groups)"). renderNotifications() in public/app.js used to render the whole
// `history` array under one flat "Past notifications" heading; it now splits into "Today" and
// "Last 7 days" using dayDiff() (a real calendar-day boundary, same one fmtWhen already uses for
// each row's own Today/Yesterday wording) rather than a raw 24-hour window -- see the long comment
// above historyHtml in app.js. Rows are also now individually tappable via historyTapAttrs(), which
// dispatches to openSession/viewPost/profileView/crewView depending on n.link's type, deep-linking
// exactly the same destinations openDeepLink() (see test/deeplink-dispatch.mjs) does for a live push.
//
// This runs the real renderNotifications() end to end (real app.js, mocked H.get('/api/notifications')
// response) and inspects the actual rendered HTML written to #app -- not a source-text check -- same
// node:vm harness family as the other client-side tests in this suite.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };

const SRC = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

// A real (non-Proxy) #app element so innerHTML assignments are actually captured and inspectable,
// same reasoning as makeEl() in the other client-side harnesses in this suite -- the shared
// Proxy-based genericEl() used for everything else returns a fresh object on every property
// access, which can't hold an assigned innerHTML string.
function makeAppEl() {
  // Sep 9: renderNotifications() now also calls historySwipeInit($('app')) when there's any
  // history, which does container.querySelectorAll('.hist-swipe') -- needs a real method here,
  // not the undefined this plain object had before. [] is fine: this harness isn't exercising the
  // swipe gesture itself (see test/notification-swipe-dismiss.mjs for that), just making sure
  // rendering a page with history rows doesn't throw.
  const el = { tagName: 'DIV', id: 'app', style: {}, scrollTop: 0, _html: '', querySelectorAll: () => [] };
  Object.defineProperty(el, 'innerHTML', { get() { return el._html; }, set(v) { el._html = v; } });
  return el;
}
const genericEl = () => new Proxy(function () {}, {
  get: (t, k) => k === 'children' || k === 'childNodes' ? [] : (k === 'innerText' || k === 'value' || k === 'textContent') ? '' : genericEl(),
  set: () => true, apply: () => genericEl(), has: () => true,
});

function jsonRes(v) { return Promise.resolve({ json: () => Promise.resolve(v), ok: true, status: 200, text: () => Promise.resolve('') }); }

function freshCtx(historyRows) {
  const appEl = makeAppEl();
  const doc = {
    getElementById: (id) => id === 'app' ? appEl : genericEl(),
    querySelector: () => genericEl(), querySelectorAll: () => [],
    createElement: () => genericEl(), addEventListener() {}, body: genericEl(), documentElement: genericEl(), head: genericEl(),
    cookie: '', readyState: 'complete',
  };
  const historyStub = { pushState() {}, replaceState() {}, go() {}, length: 1 };
  const seenCalls = [];
  const ctx = {
    console: { log() {}, warn() {}, error() {} }, document: doc,
    localStorage: { getItem: (k) => k === 'crewfit_token' ? 'tok' : null, setItem() {}, removeItem() {} },
    fetch: (url, opts) => {
      if (/\/api\/notifications\/seen$/.test(url)) { seenCalls.push(1); return jsonRes({ ok: true }); }
      if (/\/api\/notifications$/.test(url)) return jsonRes({ invites: [], followRequests: [], joinRequests: [], history: historyRows, count: historyRows.length });
      return jsonRes({});
    },
    location: { href: '/', pathname: '/', search: '', hash: '' },
    history: historyStub, addEventListener() {}, removeEventListener() {}, scrollTo() {},
    navigator: { userAgent: 'node', serviceWorker: { register: () => Promise.resolve(), addEventListener() {}, removeEventListener() {} }, onLine: true },
    setTimeout, clearTimeout, setInterval, clearInterval, alert() {}, confirm: () => true, prompt: () => null,
    requestAnimationFrame: f => setTimeout(f, 0), matchMedia: () => ({ matches: false, addEventListener() {} }),
    FileReader: function () {}, Image: function () {}, URL, Blob: function () {}, FormData: function () {},
    IntersectionObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
    ResizeObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
    Date, Math,
  };
  ctx.window = ctx; ctx.globalThis = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  // Unlike nav-keyboard-hide.mjs, this test needs a real `fetch` (H.get('/api/notifications') must
  // actually resolve), so app.js's checkAppVersion 10-minute setInterval WILL register here. That's
  // fine -- this file calls process.exit() unconditionally at the end (see the bottom), which tears
  // the process down regardless of any pending timers, same as deeplink-dispatch.mjs and
  // lockscreen-deeplink-guard.mjs already do for the same reason.
  vm.runInContext(SRC, ctx, { filename: 'public/app.js' });
  return { ctx, appEl, seenCalls };
}
const isoDaysAgo = (n, hour) => { const d = new Date(); d.setDate(d.getDate() - n); if (hour !== undefined) d.setHours(hour, 0, 0, 0); return d.toISOString(); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

console.log('Today vs Last 7 days -- split on a real calendar-day boundary, not a raw 24h window');
{
  const rows = [
    { type: 'history', id: 'n1', title: 'A', body: 'nalice started following you', at: isoDaysAgo(0, 23), link: null },     // today, 11pm
    { type: 'history', id: 'n2', title: 'B', body: 'nbob reacted to your workout', at: isoDaysAgo(0, 1), link: null },       // today, 1am -- 22h apart from n1, still both "Today"
    { type: 'history', id: 'n3', title: 'C', body: 'ncarol joined your workout', at: isoDaysAgo(1, 23), link: null },        // yesterday 11pm -- only ~2h before n2's 1am, but a DIFFERENT calendar day
    { type: 'history', id: 'n4', title: 'D', body: 'ndave commented', at: isoDaysAgo(6), link: null },                       // 6 days ago -- still within the 7-day window
  ];
  const { ctx, appEl, seenCalls } = freshCtx(rows);
  await vm.runInContext('renderNotifications()', ctx);
  await sleep(5);
  const html = appEl.innerHTML;
  const h2s = [...html.matchAll(/<h2[^>]*>([^<]*)<\/h2>/g)].map(m => m[1]);
  ok(h2s.includes('Today') && h2s.includes('Last 7 days'), `both section headers render (got ${JSON.stringify(h2s)})`);
  ok(!html.includes('Past notifications'), `the old single "Past notifications" heading is gone (got section headers ${JSON.stringify(h2s)})`);
  // Bound each section by its own HEADING tag specifically (>Today</h2> / >Last 7 days</h2>), not
  // a bare substring search for the word "Today" -- every row's own fmtWhen() timestamp ALSO
  // contains the literal text "Today" (e.g. "Today, 11:00 PM"), which would otherwise split the
  // string apart mid-row and silently truncate the section being checked.
  const todayHeadingAt = html.indexOf('>Today</h2>');
  const laterHeadingAt = html.indexOf('>Last 7 days</h2>');
  const todaySection = html.slice(todayHeadingAt, laterHeadingAt === -1 ? undefined : laterHeadingAt);
  const laterSection = laterHeadingAt === -1 ? '' : html.slice(laterHeadingAt);
  ok(todaySection.includes('nalice started following you') && todaySection.includes('nbob reacted to your workout'),
    'Today holds both same-calendar-day rows despite a 22h gap between them');
  ok(!todaySection.includes('ncarol joined your workout'), 'Today does NOT include yesterday 11pm, even though it is only ~2h before today 1am');
  ok(laterSection.includes('ncarol joined your workout') && laterSection.includes('ndave commented'),
    'Last 7 days holds both the yesterday and the 6-day-old row');
  ok(seenCalls.length === 1, 'a real (non-silent) render still marks the page seen exactly once');
}

console.log('\nonly "Today" renders when everything is from today (no empty "Last 7 days" heading)');
{
  const rows = [{ type: 'history', id: 'n1', title: 'A', body: 'fresh one', at: isoDaysAgo(0), link: null }];
  const { ctx, appEl } = freshCtx(rows);
  await vm.runInContext('renderNotifications()', ctx);
  await sleep(5);
  const html = appEl.innerHTML;
  ok(html.includes('Today'), 'Today heading renders');
  ok(!html.includes('Last 7 days'), `no empty "Last 7 days" heading when nothing falls in it (got ${html.includes('Last 7 days')})`);
}

console.log('\nonly "Last 7 days" renders when nothing is from today');
{
  const rows = [{ type: 'history', id: 'n1', title: 'A', body: 'old one', at: isoDaysAgo(3), link: null }];
  const { ctx, appEl } = freshCtx(rows);
  await vm.runInContext('renderNotifications()', ctx);
  await sleep(5);
  const html = appEl.innerHTML;
  ok(html.includes('Last 7 days'), 'Last 7 days heading renders');
  ok(!html.includes('>Today<'), `no empty "Today" heading when nothing falls in it (got ${html.includes('>Today<')})`);
}

console.log('\nhistory rows tap through to the right screen, matching n.link (same destinations as openDeepLink)');
{
  const rows = [
    { type: 'history', id: 'n1', title: 'T', body: 'session link row', at: isoDaysAgo(0), link: { type: 'session', sessionId: 's_1' } },
    // Sep 8 2026: 'session-chat'/'crew-chat' -- a comment notification (Jeff: "if brian commented
    // in our crew or workout - it brings me to see his comments") routes to a DIFFERENT function
    // than plain 'session'/'crew' (openSessionChat/openCrewChat, which additionally scroll to the
    // messages), so these need their own tap-through coverage, not just the plain-link cases.
    { type: 'history', id: 'n1b', title: 'T', body: 'session-chat link row', at: isoDaysAgo(0), link: { type: 'session-chat', sessionId: 's_1b' } },
    { type: 'history', id: 'n2', title: 'T', body: 'post link row', at: isoDaysAgo(0), link: { type: 'post', sessionId: 's_2', authorId: 'u_2' } },
    { type: 'history', id: 'n3', title: 'T', body: 'profile link row', at: isoDaysAgo(0), link: { type: 'profile', userId: 'u_3' } },
    { type: 'history', id: 'n4', title: 'T', body: 'crew link row', at: isoDaysAgo(0), link: { type: 'crew', crewId: 'c_4' } },
    { type: 'history', id: 'n4b', title: 'T', body: 'crew-chat link row', at: isoDaysAgo(0), link: { type: 'crew-chat', crewId: 'c_4b' } },
    { type: 'history', id: 'n5', title: 'T', body: 'no link at all row', at: isoDaysAgo(0), link: null },
    { type: 'history', id: 'n6', title: 'T', body: 'inert notifications-type row', at: isoDaysAgo(0), link: { type: 'notifications' } },
  ];
  const { ctx, appEl } = freshCtx(rows);
  await vm.runInContext('renderNotifications()', ctx);
  await sleep(5);
  const html = appEl.innerHTML;
  ok(html.includes(`onclick="openSession('s_1')"`), "session-linked row calls openSession('s_1')");
  ok(html.includes(`onclick="openSessionChat('s_1b')"`), "session-chat-linked row calls openSessionChat('s_1b'), not plain openSession");
  ok(html.includes(`onclick="viewPost('s_2','u_2')"`), "post-linked row calls viewPost('s_2','u_2')");
  ok(html.includes(`onclick="profileView('u_3')"`), "profile-linked row calls profileView('u_3')");
  ok(html.includes(`onclick="crewView('c_4')"`), "crew-linked row calls crewView('c_4')");
  ok(html.includes(`onclick="openCrewChat('c_4b')"`), "crew-chat-linked row calls openCrewChat('c_4b'), not plain crewView");
  // Rows 5 and 6 must NOT be tappable -- extract each row's own markup (by its distinguishing body
  // text) rather than asserting on the whole page, since rows 1-4 legitimately DO have onclick.
  const rowFor = text => { const i = html.indexOf(text); const start = html.lastIndexOf('<div class="feed-item"', i); const end = html.indexOf('</div></div>', i) + '</div></div>'.length; return html.slice(start, end); };
  ok(!rowFor('no link at all row').includes('onclick'), 'a row with no link at all has no onclick');
  ok(!rowFor('inert notifications-type row').includes('onclick'), "a {type:'notifications'} row (already-here destination) has no onclick either");
}

console.log(fails === 0 ? '\nall assertions passed' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
