// Sep 10 2026 (Jeff, real bug report): "When making a new workout (not quick workout), if I
// don't select a name it allows me to finish and click 'Create workout' but no workout appears."
// Two real bugs stacked: (1) POST/PUT /api/sessions let a blank/whitespace name through
// unmodified (server.js), and (2) home()'s "Your sessions" and friends' "joinable" filters in
// app.js both used `s.name` as a truthy existence check, so a session created with a blank name
// was real (a real row in the DB, a real id) but invisible on every Home surface -- reading as
// "no workout appears" even though creation actually succeeded. Jeff's fix: "if someone doesn't
// label it lets default to 'New workout' -- but while they are creating the workout if they click
// on the name section their is no pre loaded text. It only defaults ... after its created." The
// input's placeholder-only behavior (public/app.js's createFlow(), `value="${esc(DRAFT.name||'')}"`)
// was already correct and needed no change -- only the server-side default (POST/PUT
// /api/sessions in server.js) and the two dead `s.name &&` filter gates (app.js) needed fixing.
//
// Part A below proves the server-side default end to end through Postgres (same real-server-over-
// HTTP pattern test/notifications-dismiss.mjs uses). Part B proves the client-side filter fix
// directly against the real home() render (same node:vm harness
// test/home-live-window-and-workouts-view.mjs uses) -- this is the defense-in-depth half: it
// covers a session that already has a blank name sitting in the DB from before this fix (the
// server-side default alone would never produce one going forward, but old data could still have
// one), which the server-only test in Part A can't exercise.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { freshTestDb } from './_pgtestdb.mjs';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const J = { 'Content-Type': 'application/json' };
const CWD = new URL('..', import.meta.url).pathname;

console.log('Part A: server-side default (POST/PUT /api/sessions), real server + real Postgres');
{
  function boot(port, dir, databaseUrl) {
    return new Promise(res => {
      const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: databaseUrl, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
      srv.stderr.on('data', d => process.stderr.write(d));
      srv.stdout.on('data', d => { if (String(d).includes('CrewFit on')) res(srv); });
      setTimeout(() => res(null), 15000);
    });
  }

  const DIR = mkdtempSync(join(tmpdir(), 'blank-name-'));
  const testDb = await freshTestDb('blankworkoutname');
  const PORT = 4997, B = `http://localhost:${PORT}`;
  const srv = await boot(PORT, DIR, testDb.url);
  if (!srv) { console.log('FAIL boot'); process.exit(1); }

  const H = t => ({ ...J, Authorization: 'Bearer ' + t });
  const reg = n => fetch(B + '/api/register', { method: 'POST', headers: J, body: JSON.stringify({ username: n, pin: 'pass1234', displayName: n }) }).then(r => r.json());
  const P = (who, p, body) => fetch(B + p, { method: 'POST', headers: H(who.token), body: JSON.stringify(body || {}) }).then(r => r.json());
  const PUT = (who, p, body) => fetch(B + p, { method: 'PUT', headers: H(who.token), body: JSON.stringify(body || {}) }).then(r => r.json());
  const G = (who, p) => fetch(B + p, { headers: H(who.token) }).then(r => r.json());

  const me = await reg('blankname' + Math.random().toString(36).slice(2, 8));

  console.log('creating a workout with no name at all defaults to "New workout"');
  {
    const s = await P(me, '/api/sessions', { exercises: [{ name: 'Bench Press' }], visibility: 'private' });
    ok(!s.error, `session created without error (got ${JSON.stringify(s.error)})`);
    ok(s.name === 'New workout', `defaulted to "New workout" (got ${JSON.stringify(s.name)})`);

    const list = await G(me, '/api/sessions');
    ok(list.some(x => x.id === s.id && x.name === 'New workout'), 'and it really shows up in GET /api/sessions with that name -- not silently missing');
  }

  console.log('\na whitespace-only name (not just empty string) also defaults');
  {
    const s = await P(me, '/api/sessions', { exercises: [{ name: 'Squat' }], visibility: 'private', name: '   ' });
    ok(s.name === 'New workout', `whitespace-only name also defaulted (got ${JSON.stringify(s.name)})`);
  }

  console.log('\na real name is left completely untouched');
  {
    const s = await P(me, '/api/sessions', { exercises: [{ name: 'Deadlift' }], visibility: 'private', name: 'Leg Day' });
    ok(s.name === 'Leg Day', `real name is not overridden (got ${JSON.stringify(s.name)})`);
  }

  console.log('\nediting a named workout down to a blank name also defaults, not just creation');
  {
    const s = await P(me, '/api/sessions', { exercises: [{ name: 'Row' }], visibility: 'private', name: 'Pull Day' });
    const edited = await PUT(me, `/api/sessions/${s.id}`, { name: '' });
    ok(edited.name === 'New workout', `clearing the name on edit defaults instead of saving blank (got ${JSON.stringify(edited.name)})`);
  }

  try { srv && srv.kill(); } catch {}
  rmSync(DIR, { recursive: true, force: true });
  await testDb.drop();
}

console.log('\nPart B: client-side filter fix (home()\'s "Your sessions"), defense-in-depth for legacy blank-named data');
{
  // Same node:vm harness as test/home-live-window-and-workouts-view.mjs -- runs the REAL
  // public/app.js, real home().
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

  const minsFromNow = n => new Date(FIXED_NOW.getTime() + n * 60000).toISOString();
  const base = { history: [], logs: {}, posts: {} };

  const sessions = [
    // A legacy/edge-case session with a blank name -- must still show up in "Your sessions" now
    // that the `s.name &&` truthy gate is gone.
    { id: 's-blank-name', name: '', creatorId: 'me1', participants: ['me1'], invited: [],
      exercises: [{ id: 'e1' }], scheduledAt: minsFromNow(240), ...base },
    { id: 's-named', name: 'Push Day', creatorId: 'me1', participants: ['me1'], invited: [],
      exercises: [{ id: 'e1' }], scheduledAt: minsFromNow(300), ...base },
  ];
  vm.runInContext(`
    H.get = (p) => Promise.resolve(
      p === '/api/sessions' ? ${JSON.stringify(sessions)} :
      p === '/api/feed' ? [] :
      p === '/api/friends' ? { friends: [] } : []
    );
  `, ctx);
  sink.html = '';
  vm.runInContext('window.HOME_ALL_SESSIONS = true', ctx);
  await vm.runInContext('home', ctx)({ silent: true });

  // The blank-named session is scheduled sooner (240 min out vs. 300), so it's the one that wins
  // the single "Next up" card slot (home()'s own soonest-first pick) -- ".next-top" only ever
  // renders when nextUp is truthy, so its presence here directly proves the blank-named session
  // was NOT filtered out by the (now-removed) `s.name &&` gate. Before the fix, `yours` would have
  // excluded it entirely, nextUp would have fallen through to the OTHER (named) session instead,
  // and no amount of scrolling would have surfaced the blank-named one anywhere on Home -- exactly
  // Jeff's "no workout appears" bug, just with an existing session instead of a freshly-created one.
  ok(sink.html.includes('next-top'), 'the blank-named (soonest) session still won the Next up card -- not filtered out');
  ok(sink.html.includes('Push Day'), 'the other, normally-named session still renders as a row too');
}

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
