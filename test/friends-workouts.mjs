// Jeff, Aug 20: "If i follow someone on the app and they approve ... I want to be able to see all
// active workouts they have that are public. Even ones they have before I followed them that are
// still active or awaiting." Home's "Friends' Workouts" card used to drop ANY past-dated joinable
// workout outright — dayDiff(s.scheduledAt) >= 0 was the whole rule — even one the creator had
// never finished. Now a past-dated one stays as long as the creator has not finished it yet
// (server.js's sessionView exposes that one fact as `creatorFinished`, stripped of everything
// else in `history`). This runs the REAL public/app.js home() against realistic session shapes,
// the same vm-harness pattern as test/session-missed.mjs.
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
  ResizeObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
  Math };
ctx.window = ctx; ctx.globalThis = ctx; ctx.self = ctx;
vm.createContext(ctx);
vm.runInContext(SRC, ctx, { filename: 'public/app.js' });

const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString();
const daysAhead = n => new Date(Date.now() + n * 86400000).toISOString();

vm.runInContext(`ME = { id: 'me1', displayName: 'Me' };`, ctx);
const FRIEND = { id: 'friend1', displayName: 'Priya' };

async function renderJoinable(sessions) {
  vm.runInContext(`
    H.get = (p) => Promise.resolve(
      p === '/api/sessions' ? ${JSON.stringify(sessions)} :
      p === '/api/feed' ? [] :
      p === '/api/friends' ? { friends: ${JSON.stringify([FRIEND])} } : []
    );
  `, ctx);
  sink.html = '';
  await vm.runInContext('home', ctx)();
  // Isolate the "Friends' Workouts" card from "Your Sessions" — a scenario deliberately testing
  // "already joined" puts the SAME session name in participants, so it can legitimately also
  // render in Your Sessions above; only the Friends' Workouts section answers the filter question.
  const start = sink.html.indexOf("Friends' Workouts");
  const end = sink.html.indexOf("Friends' Activity");
  return sink.html.slice(start, end === -1 ? undefined : end);
}

const base = (over) => Object.assign({
  id: 's-' + Math.random().toString(36).slice(2), name: 'Push Day', creatorId: FRIEND.id,
  participants: [FRIEND.id], invited: [], visibility: 'friends', exercises: [{ id: 'e1' }],
  myJoinRequest: null,
}, over);

console.log("\nFriends' Workouts — a friend's joinable session, by date and finish state");
{
  const future = base({ name: 'Future Pull', scheduledAt: daysAhead(2), creatorFinished: false });
  const pastOpen = base({ name: 'Past Open Squat', scheduledAt: daysAgo(3), creatorFinished: false });
  const pastFinished = base({ name: 'Past Finished Bench', scheduledAt: daysAgo(3), creatorFinished: true });
  const html = await renderJoinable([future, pastOpen, pastFinished]);
  const rows = html.split('lib-item').slice(1);
  const rowFor = name => rows.find(r => r.includes(name)) || '';

  ok(rowFor('Future Pull') !== '', 'a future-dated joinable workout always shows (unchanged behavior)');
  ok(rowFor('Past Open Squat') !== '',
     'a past-dated one the creator has NOT finished still shows — the actual fix');
  ok(rowFor('Past Finished Bench') === '',
     'a past-dated one the creator HAS finished is gone — it does not sit here forever');
}

console.log('\nregression: everything the filter already required still applies');
{
  const notAFriend = base({ name: 'Stranger Session', creatorId: 'nobody', scheduledAt: daysAgo(1), creatorFinished: false });
  const alreadyJoined = base({ name: 'Already In It', scheduledAt: daysAgo(1), creatorFinished: false, participants: [FRIEND.id, 'me1'] });
  const stillInvited = base({ name: 'Pending Invite', scheduledAt: daysAgo(1), creatorFinished: false, invited: ['me1'] });
  const privateOne = base({ name: 'Private Session', scheduledAt: daysAgo(1), creatorFinished: false, visibility: 'private' });
  const openOne = base({ name: 'Genuinely Open', scheduledAt: daysAgo(1), creatorFinished: false });
  const html = await renderJoinable([notAFriend, alreadyJoined, stillInvited, privateOne, openOne]);
  const rows = html.split('lib-item').slice(1);
  const rowFor = name => rows.find(r => r.includes(name)) || '';

  ok(rowFor('Stranger Session') === '', 'a friends-visibility session from a non-friend still stays out');
  ok(rowFor('Already In It') === '', 'one you are already a participant in still stays out');
  ok(rowFor('Pending Invite') === '', 'one you have an unanswered invite for still stays out — that belongs on the invite banner');
  ok(rowFor('Private Session') === '', 'a private-visibility session still stays out regardless of creatorFinished');
  ok(rowFor('Genuinely Open') !== '', 'and a real candidate still shows');
}

console.log('\nmissing creatorFinished (older session shape, or the member/reader-tier fields) fails safe');
{
  // A session object with no creatorFinished at all should behave like "not finished" for a
  // still-open past-dated workout (Boolean-ish truthiness of undefined is falsy -> !undefined is
  // true), not silently vanish the row because of a field that did not exist yet.
  const noField = base({ name: 'No Field Yet', scheduledAt: daysAgo(1) });
  delete noField.creatorFinished;
  const html = await renderJoinable([noField]);
  ok(html.includes('No Field Yet'), 'a session shape missing creatorFinished still shows while past-dated (fails open, not hidden)');
}

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
