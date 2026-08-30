// A scheduled workout whose day has passed with nothing logged sits on Home looking identical to
// tomorrow's plan — Jeff asked what should happen to it. The answer: flag it "Missed", but never
// hide it, delete it, or block logging late (per CLAUDE.md: discoverability beats minimalism, and
// a claim about the user's history has to be right every time, not just usually — v163 already
// burned us once for stating something false about a session). This runs the REAL public/app.js
// isSessionMissed() and the REAL home() render against realistic session shapes.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const run = f => { try { return { v: f() }; } catch (e) { return { err: e.message }; } };

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

const isMissed = vm.runInContext('isSessionMissed', ctx);
const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString();
const daysAhead = n => new Date(Date.now() + n * 86400000).toISOString();

console.log('\nisSessionMissed() — the rule itself (v187: per-VIEWER now, not per-session)');
{
  // viewerId is explicit throughout — v187 made finishing per-person, so "missed" is now a claim
  // about YOU, checked against YOUR OWN history/logs, never anyone else's.
  const base = { history: [], logs: {} };
  ok(isMissed({ ...base, scheduledAt: daysAgo(2) }, 'u1') === true,
     '2 days ago, not finished, nothing logged -> missed');
  ok(isMissed({ ...base, scheduledAt: daysAgo(60) }, 'u1') === true,
     '60 days ago is still missed, not just "yesterday" — no arbitrary cutoff');
  ok(isMissed({ ...base, scheduledAt: daysAgo(1), history: [{ userId: 'u1', date: '2026-01-01' }] }, 'u1') === false,
     'past but YOU already finished (Log & Finish) -> never missed, regardless of logs');
  ok(isMissed({ ...base, scheduledAt: daysAgo(1), history: [{ userId: 'u2', date: '2026-01-01' }] }, 'u1') === true,
     "past and a training partner finished, but YOU did not -> still missed for you — one person's finish says nothing about yours");
  ok(isMissed({ ...base, scheduledAt: daysAgo(1), logs: { u1: [{ exerciseId: 'e1' }] } }, 'u1') === false,
     'past but YOU actually logged at least one set -> not missed (partial work happened)');
  ok(isMissed({ ...base, scheduledAt: daysAgo(1), logs: { u1: [], u2: [{ exerciseId: 'e1' }] } }, 'u1') === true,
     "past with only YOUR log empty — a partner's sets do not count as yours -> still missed");
  ok(isMissed({ ...base, scheduledAt: new Date().toISOString() }, 'u1') === false,
     'scheduled for later today -> not missed yet (same-day grace, matches fmtWhen\'s "Today")');
  ok(isMissed({ ...base, scheduledAt: daysAhead(3) }, 'u1') === false, 'scheduled in the future -> never missed');
  ok(isMissed({ ...base, scheduledAt: 'not a date' }, 'u1') === false, 'an unparseable date fails safe, not missed');
  ok(isMissed(null, 'u1') === false, 'a null session fails safe, not missed');
  ok(isMissed({ ...base, scheduledAt: daysAgo(2) }, null) === false, 'no viewer to check against fails safe, not missed');
}

console.log('\nthe real Home render — the tag appears only where it should');
{
  vm.runInContext(`ME = { id: 'me1', displayName: 'Me' };`, ctx);
  const sessions = [
    { id: 's-missed', name: 'Leg Day', creatorId: 'me1', participants: ['me1'], invited: [],
      exercises: [{ id: 'e1' }], scheduledAt: daysAgo(3), completed: false, logs: {} },
    { id: 's-upcoming', name: 'Push Day', creatorId: 'me1', participants: ['me1'], invited: [],
      exercises: [{ id: 'e1' }], scheduledAt: daysAhead(2), completed: false, logs: {} },
    { id: 's-done', name: 'Pull Day', creatorId: 'me1', participants: ['me1'], invited: [],
      exercises: [{ id: 'e1' }], scheduledAt: daysAgo(5), completed: true, logs: { me1: [{ exerciseId: 'e1' }] } },
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
  ok(/Missed/.test(rowFor('Leg Day')), 'the overdue, unlogged session shows the Missed tag');
  ok(!/Missed/.test(rowFor('Push Day')), 'the upcoming session does not');
  ok(!/Missed/.test(rowFor('Pull Day')), 'the completed session does not, even though it is also in the past');
  ok(sink.html.includes('Leg Day') && sink.html.includes('Push Day') && sink.html.includes('Pull Day'),
     'and all three still render — nothing is hidden, per the "never hide, just flag" decision');
}

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
