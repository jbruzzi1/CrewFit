// Oct 2 2026 (Tier 3 audit #159, Jeff: "the crew challenge mini-card can show 'No one's logged
// yet' directly under a progress meter that's showing real numbers"):
//
// Root cause, traced through server.js and public/app.js: publicChallenge() (server.js) nulls OUT
// a blocked crew-mate's own `count` on the per-viewer leaderboard it returns (a Sep 24 2026 fix,
// so a blocked pair can't see each other's exact weekly number here, matching the roster's own
// streak-hiding rule) -- but `total` (what actually drives the meter/progress bar) is computed by
// challengeProgress() BEFORE any of that per-viewer blocking logic runs, so it still includes a
// blocked contributor's real sets. The mini card's client-side leaderRows filters on `m.count>0`,
// and `null>0` is false, so a blocked contributor who is the ONLY one who's logged anything gets
// filtered out of the leaderboard entirely while their contribution still counts toward the total
// -- "No one's logged yet" rendered directly under a meter honestly showing real progress.
//
// Fixed by gating the mini card's empty-state text on `ch.total===0` (an actual fact) instead of
// "leaderRows happened to come back empty" -- see the comment above that line in app.js. This test
// proves the real end-to-end shape: real server, real blocking, real challenge progress, and the
// REAL public/app.js crewChallengeHtml() rendering function via node:vm.
//
// Run:  npm test
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { freshTestDb } from './_pgtestdb.mjs';

const PORT = process.env.TEST_PORT_OCT2CHALCONTRA || 4988;
const B = `http://localhost:${PORT}`;
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('oct2chalcontra');
let fails = 0, srv = null;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const J = { 'Content-Type': 'application/json' };

function boot(dir) {
  return new Promise((res, rej) => {
    srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(PORT) },
      cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    srv.stderr.on('data', d => { err += d; });
    srv.stdout.on('data', d => { if (String(d).includes('CrewFit on')) res(); });
    srv.on('exit', c => rej(new Error(`server exited (${c}):\n${err}`)));
    setTimeout(() => rej(new Error('server never started:\n' + err)), 15000);
  });
}
const DIR = mkdtempSync(join(tmpdir(), 'oct2chalcontra-'));
await boot(DIR);

async function api(path, method, token, body) {
  const r = await fetch(B + path, { method, headers: { ...J, ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
}
const post = (p, b, tok) => api(p, 'POST', tok, b).then(r => r.body);
const get = (p, tok) => api(p, 'GET', tok).then(r => r.body);
const reg = (u) => post('/api/register', { username: u, pin: 'pass1234', displayName: u[0].toUpperCase() + u.slice(1) });
const connect = async (a, b) => { await post('/api/follow/' + b.user.id, {}, a.token); await post('/api/follow-requests/' + a.user.id + '/accept', {}, b.token); };

const owner = await reg('oct2cc_owner');
const member = await reg('oct2cc_member');
await connect(owner, member);
const crew = await post('/api/crews', { name: 'Oct2 Challenge Crew', memberIds: [member.user.id] }, owner.token);
ok(!crew.error, `crew created (${crew.error})`);

const ch = await post('/api/crews/' + crew.id + '/challenge', { type: 'workouts', target: 10 }, owner.token);
ok(!ch.error, `challenge started (${ch.error})`);

// member logs and finishes a real workout -- the ONLY contribution to this challenge so far.
const s = await post('/api/sessions', { name: 'Push Day', exercises: [{ name: 'Bench Press' }], visibility: 'private' }, member.token);
await post('/api/sessions/' + s.id + '/log', { exerciseId: s.exercises[0].id, weight: 135, reps: 8 }, member.token);
await post('/api/sessions/' + s.id + '/lock', {}, member.token);

console.log('sanity: before any block, owner sees the real total AND member in the leaderboard');
{
  const crewView = await get('/api/crews/' + crew.id, owner.token);
  ok(crewView.challenge.total === 1, `total is 1 (the member's one finished workout), got ${crewView.challenge.total}`);
  const memberRow = crewView.challenge.leaderboard.find(m => m.id === member.user.id);
  ok(memberRow && memberRow.count === 1, `member's real count (1) shows in the leaderboard, got ${JSON.stringify(memberRow)}`);
}

console.log('\nowner blocks member -- the leaderboard row is hidden (count:null), but the TOTAL must stay honest');
{
  await post('/api/block/' + member.user.id, {}, owner.token);
  const crewView = await get('/api/crews/' + crew.id, owner.token);
  ok(crewView.challenge.total === 1, `total is STILL 1 -- challengeProgress doesn't know about blocking, got ${crewView.challenge.total}`);
  const memberRow = crewView.challenge.leaderboard.find(m => m.id === member.user.id);
  ok(memberRow && memberRow.count === null, `but the member's count on the leaderboard is nulled out for the blocker, got ${JSON.stringify(memberRow)}`);

  console.log('\nTHE BUG: this is exactly the shape that produced the self-contradiction -- total>0 but every leaderboard row filtered out (count===null)');
  const visibleRows = crewView.challenge.leaderboard.filter(m => m.count > 0);
  ok(visibleRows.length === 0, `zero rows pass the mini-card's own count>0 filter despite total=${crewView.challenge.total} (this is the exact mismatch Jeff saw)`);
}

const APP_SRC = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const el = () => new Proxy(function () {}, {
  get: (t, k) => k === 'style' || k === 'classList' || k === 'dataset' ? el()
    : k === 'innerHTML' ? ''
    : k === 'innerText' || k === 'value' || k === 'textContent' ? ''
    : k === 'children' || k === 'childNodes' ? [] : el(),
  set: () => true, apply: () => el(), has: () => true,
});
const doc = { getElementById: () => el(), querySelector: () => null, querySelectorAll: () => [],
  createElement: () => el(), addEventListener() {}, body: el(), documentElement: el(), head: el(),
  cookie: '', readyState: 'complete' };
function makeAppCtx() {
  const ctx = { console: { log() {}, warn() {}, error() {} }, document: doc,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: (url, opts) => fetch(B + url, opts),
    location: { href: '/', pathname: '/', search: '', hash: '' },
    history: { replaceState() {}, pushState() {} }, addEventListener() {}, removeEventListener() {}, scrollTo() {},
    navigator: { userAgent: 'node', serviceWorker: { register: () => Promise.resolve() }, onLine: true },
    setTimeout, clearTimeout, setInterval, clearInterval, alert() {}, confirm: () => true, prompt: () => null,
    requestAnimationFrame: f => setTimeout(f, 0), matchMedia: () => ({ matches: false, addEventListener() {} }),
    FileReader: function () {}, Image: function () {}, URL, Blob: function () {}, FormData: function () {},
    IntersectionObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
    ResizeObserver: function () { this.observe = () => {}; this.disconnect = () => {}; } };
  ctx.window = ctx; ctx.globalThis = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(APP_SRC, ctx, { filename: 'public/app.js' });
  return ctx;
}

console.log('\n---- client render: the REAL crewChallengeHtml() (public/app.js) must not contradict its own meter ----');
{
  const ctx = makeAppCtx();
  const crewView = await get('/api/crews/' + crew.id, owner.token);
  // crewChallengeHtml(c) only reads c.challenge/c.isOwner/c.challengesCompleted/c.id off the crew
  // object -- feed it the REAL server response for the owner's own view, exactly what crewView()
  // would hand it in the live app.
  const html = vm.runInContext('crewChallengeHtml', ctx)(crewView);

  ok(/>\s*1\s*<span class="mv-of">\s*\/\s*10\s*<\/span>/.test(html) || html.includes('>1<span class="mv-of"> / 10</span>'),
     `the meter still honestly shows 1 / 10 (got: ${html.match(/<span class="mv-n">[\s\S]*?<\/span><\/span>/)}`);
  ok(!html.includes("No one's logged yet"),
     `THE FIX: "No one's logged yet" no longer renders when the meter above it shows real (nonzero) progress (got: ${html.slice(0, 900)})`);
}

// Unblock before the remaining regression checks below -- they're specifically proving the
// NORMAL, no-blocking-involved shape still works, and owner/member are still blocked from the
// section just above otherwise (same two accounts, reused on purpose so the regression checks are
// run against the identical pair the bug was reproduced with, not a fresh pair that could coincide
// with some other difference). Unblocking does NOT restore the severed follow relationship (see
// test/audit-oct2-blocked-profile.mjs's own reversibility coverage of that exact fact) -- re-follow
// too, since the crew3 regression check below needs owner/member to be real CONNECTIONS again for
// crew membership to actually take (validCrewMemberIds, server.js) to add member to a NEW crew.
await post('/api/unblock/' + member.user.id, {}, owner.token);
await connect(owner, member);

console.log('\nregression: when total is GENUINELY zero (nobody blocked, nobody has logged anything), the empty-state text still renders correctly');
{
  const crew2 = await post('/api/crews', { name: 'Oct2 Empty Crew', memberIds: [member.user.id] }, owner.token);
  await post('/api/crews/' + crew2.id + '/challenge', { type: 'workouts', target: 10 }, owner.token);
  const crewView2 = await get('/api/crews/' + crew2.id, owner.token);
  ok(crewView2.challenge.total === 0, `sanity: genuinely nothing logged yet, total is 0 (got ${crewView2.challenge.total})`);

  const ctx = makeAppCtx();
  const html = vm.runInContext('crewChallengeHtml', ctx)(crewView2);
  ok(html.includes("No one's logged yet"), 'the empty-state text DOES still render here -- this is a genuinely accurate claim, not a regression removing it entirely');
  ok(html.includes('>0<span class="mv-of"> / 10</span>'), 'and the meter agrees (0 / 10) -- no contradiction either way');
}

console.log('\nregression: an uninvolved-in-any-block crew (member never blocked) still shows the real leaderboard row, not the empty state');
{
  const crew3 = await post('/api/crews', { name: 'Oct2 Normal Crew', memberIds: [member.user.id] }, owner.token);
  await post('/api/crews/' + crew3.id + '/challenge', { type: 'workouts', target: 5 }, owner.token);
  const s3 = await post('/api/sessions', { name: 'Leg Day', exercises: [{ name: 'Back Squat' }], visibility: 'private' }, member.token);
  await post('/api/sessions/' + s3.id + '/log', { exerciseId: s3.exercises[0].id, weight: 225, reps: 5 }, member.token);
  await post('/api/sessions/' + s3.id + '/lock', {}, member.token);
  const crewView3 = await get('/api/crews/' + crew3.id, owner.token);

  const ctx = makeAppCtx();
  const html = vm.runInContext('crewChallengeHtml', ctx)(crewView3);
  ok(html.includes('Oct2cc_member') || html.includes('oct2cc_member'), `member's real leaderboard row still renders normally when nobody's blocked (got: ${html.slice(0, 900)})`);
  ok(!html.includes("No one's logged yet"), 'and the empty-state text correctly does not render');
}

try { srv && srv.kill(); } catch {}
rmSync(DIR, { recursive: true, force: true });
await testDb.drop();

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
