// Oct 2 2026 (Tier 3 audit #157, Jeff's expanded spec, verbatim: "remember, you should not be
// able to view a blocked profile - that profile should no longer be viewable after they are
// blocked. The person that blocked them has access to seeing the profile only in the blocked
// section. The person who was blocked will not be able to see them anywhere. until they are
// unblocked."):
//
// Before this fix, profileOf (server.js) already folded isBlocked into isApproved, but isApproved
// only ever gated the PRs/streak/recentActivity block -- everything else (publicUser's name/
// avatar/bio/follower counts, myWorkouts, youFollow, workoutsCompleted) kept returning in full, so
// a blocked relationship rendered client-side as the exact same "This profile is private" shape a
// merely-private-and-not-following stranger's profile gets, right down to a Follow button that
// always 403'd. That is the mislabeling bug: both sides could still open a full-looking profile
// page for someone they're blocked with, just a thinner one -- not "no longer viewable."
//
// Fixed by having profileOf short-circuit to a minimal {id, blocked:true} shape (no identifying
// fields at all) whenever isBlocked(id, viewerId) is true and it isn't a self-view, and having the
// client's profileView() render a distinct "This profile isn't available" dead-end screen for that
// shape instead of falling through to the normal profile markup. The one deliberate exception,
// confirmed by reading the existing code rather than built from scratch here, is Settings ->
// Blocked accounts (GET /api/blocked / blockedAccountsScreen): it reads publicUser() directly off
// the blocker's own me.blocked array and never calls profileOf or profileView, so it already
// satisfies "the person that blocked them can still see them, only in the blocked section" -- this
// test proves that stayed true rather than changing it.
//
// Run:  npm test
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { freshTestDb } from './_pgtestdb.mjs';

const PORT = process.env.TEST_PORT_OCT2BLOCKPROFILE || 4987;
const B = `http://localhost:${PORT}`;
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('oct2blockprofile');
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
const DIR = mkdtempSync(join(tmpdir(), 'oct2blockprofile-'));
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

const alice = await reg('oct2bp_alice');
const bob = await reg('oct2bp_bob');
const carol = await reg('oct2bp_carol'); // uninvolved third party
await connect(alice, bob);   // alice <-> bob, mutual follow, so there's a real relationship to sever

console.log('sanity: before any block, a normal profile view works as always');
{
  const bobFromAlice = await get('/api/profile/' + bob.user.id, alice.token);
  ok(bobFromAlice.username === 'oct2bp_bob', 'alice sees bob\'s real username before blocking');
  ok(bobFromAlice.youFollow === 'following', 'and the real follow state');
  ok(!bobFromAlice.blocked, 'and no blocked flag');
}

console.log('\nTier 3 #157: alice blocks bob -- the profile becomes unviewable, bidirectionally, with no identifying fields at all');
{
  const blockResult = await post('/api/block/' + bob.user.id, {}, alice.token);
  ok(blockResult.ok === true && blockResult.blocked === true, `block succeeds (${JSON.stringify(blockResult)})`);

  const bobFromAlice = await get('/api/profile/' + bob.user.id, alice.token);
  ok(bobFromAlice.blocked === true, 'alice viewing bob\'s profile gets the blocked shape');
  ok(bobFromAlice.id === bob.user.id, 'the shape still names which id this was, for the client\'s own bookkeeping');
  ok(bobFromAlice.username === undefined && bobFromAlice.displayName === undefined && bobFromAlice.avatar === undefined,
     `no name/avatar leak (got keys: ${Object.keys(bobFromAlice).join(',')})`);
  ok(bobFromAlice.bio === undefined && bobFromAlice.followers === undefined && bobFromAlice.following === undefined,
     'no bio or follower/following counts either -- this is not just a thinner private profile');
  ok(bobFromAlice.workoutsCompleted === undefined && bobFromAlice.myWorkouts === undefined && bobFromAlice.prs === undefined,
     'no workout count, workout list, or PRs');
  ok(bobFromAlice.youFollow === undefined && bobFromAlice.limited === undefined,
     'and not even the old "limited" private-profile flag -- this is a genuinely different, minimal shape');

  console.log('  and it is truly bidirectional -- bob viewing ALICE\'s profile gets the identical treatment, even though bob never blocked anyone himself');
  const aliceFromBob = await get('/api/profile/' + alice.user.id, bob.token);
  ok(aliceFromBob.blocked === true, 'bob viewing alice\'s profile also gets the blocked shape');
  ok(aliceFromBob.username === undefined, 'and the same withheld fields');

  console.log('  POST /api/follow still refuses (regression check -- this was the "always-403ing Follow button" Jeff flagged, now simply never rendered client-side, but the server guard itself is untouched)');
  const followAttempt = await api('/api/follow/' + bob.user.id, 'POST', alice.token, {});
  ok(followAttempt.status === 403, `follow attempt is refused (got ${followAttempt.status})`);

  console.log('  the carve-out: Settings -> Blocked accounts still shows alice the real name/avatar of who she blocked');
  const blockedList = await get('/api/blocked', alice.token);
  ok(Array.isArray(blockedList) && blockedList.length === 1, 'alice\'s blocked list has exactly one entry');
  ok(blockedList[0].id === bob.user.id && blockedList[0].username === 'oct2bp_bob',
     `and it is bob, with his real identity (${JSON.stringify(blockedList[0])})`);

  console.log('  but bob never gets told he was blocked, or by whom -- his own /api/blocked (what HE has blocked) stays empty, there is no "who blocked me" anywhere');
  const bobsOwnBlockedList = await get('/api/blocked', bob.token);
  ok(Array.isArray(bobsOwnBlockedList) && bobsOwnBlockedList.length === 0,
     `bob blocked nobody, so his own list is empty, not populated with alice (${JSON.stringify(bobsOwnBlockedList)})`);

  console.log('  self-view is completely unaffected -- blocking someone else never touches your own profile');
  const aliceSelf = await get('/api/profile/me', alice.token);
  ok(aliceSelf.username === 'oct2bp_alice' && !aliceSelf.blocked, 'alice viewing her own profile is normal');
  const bobSelf = await get('/api/profile/me', bob.token);
  ok(bobSelf.username === 'oct2bp_bob' && !bobSelf.blocked, 'and so is bob\'s');

  console.log('  an uninvolved third party is completely unaffected');
  const bobFromCarol = await get('/api/profile/' + bob.user.id, carol.token);
  ok(bobFromCarol.username === 'oct2bp_bob' && !bobFromCarol.blocked, 'carol, uninvolved in the block, still sees bob\'s real profile normally');
  const aliceFromCarol = await get('/api/profile/' + alice.user.id, carol.token);
  ok(aliceFromCarol.username === 'oct2bp_alice' && !aliceFromCarol.blocked, 'and alice\'s too');

  console.log('  the follow relationship itself was actually severed, not just hidden (sanity -- this part was already correct, pre-existing blockUser() behavior)');
  const bobFollowers = await get('/api/profile/' + bob.user.id + '/followers', carol.token);
  ok(!bobFollowers.some(u => u.id === alice.user.id), 'alice no longer shows in bob\'s followers list at all, viewed by an uninvolved third party');
}

console.log('\nreversibility: unblocking restores the normal profile for both sides');
{
  const unblockResult = await post('/api/unblock/' + bob.user.id, {}, alice.token);
  ok(unblockResult.ok === true && unblockResult.blocked === false, `unblock succeeds (${JSON.stringify(unblockResult)})`);
  const bobFromAlice = await get('/api/profile/' + bob.user.id, alice.token);
  ok(bobFromAlice.username === 'oct2bp_bob' && !bobFromAlice.blocked, 'alice viewing bob\'s profile again sees the real thing, not the blocked shape');
  const aliceFromBob = await get('/api/profile/' + alice.user.id, bob.token);
  ok(aliceFromBob.username === 'oct2bp_alice' && !aliceFromBob.blocked, 'and bob viewing alice\'s is restored too');
  ok(bobFromAlice.youFollow !== 'following', 'the SEVERED follow relationship itself does not come back just from unblocking -- unblocking only lifts the block, it does not re-follow anyone (pre-existing behavior, unaffected by this fix)');
}

console.log('\n---- client render: the REAL public/app.js profileView() against the REAL running server ----');
{
  // re-block for the client-render portion, same two accounts
  await post('/api/block/' + bob.user.id, {}, alice.token);

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
  const doc = { getElementById: () => el(), querySelector: () => null, querySelectorAll: () => [],
    createElement: () => el(), addEventListener() {}, body: el(), documentElement: el(), head: el(),
    cookie: '', readyState: 'complete' };
  function makeCtx() {
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
    vm.runInContext(SRC, ctx, { filename: 'public/app.js' });
    return ctx;
  }

  console.log('alice opening bob\'s profile renders the "not available" dead-end, not the normal profile and not the old "This profile is private" copy');
  const aliceCtx = makeCtx();
  vm.runInContext(`TOKEN = ${JSON.stringify(alice.token)}; ME = ${JSON.stringify(alice.user)};`, aliceCtx);
  sink.html = '';
  await vm.runInContext('profileView', aliceCtx)(bob.user.id);
  ok(sink.html.includes("This profile isn't available."), `the new copy renders (got: ${sink.html.slice(0, 400)})`);
  ok(!sink.html.includes('This profile is private'), 'the OLD mislabeling copy does not render for a blocked relationship');
  ok(!sink.html.includes('oct2bp_bob') && !sink.html.includes('oct2bp_Bob'),
     'bob\'s username/displayName is not in the markup anywhere');
  ok(!sink.html.includes('Follow</button>') && !/onclick="toggleFollow/.test(sink.html),
     'no Follow button -- this closes the exact "always-403ing Follow button" bug Jeff flagged');
  ok(!/onclick="togglePostMenu/.test(sink.html), 'no profile ⋯ menu (Report/Block/Unblock) either -- there is nothing here to act on');
  ok(sink.html.includes('aria-label="Back"'), 'a working Back control is still offered, same as every other drill-down dead end in this app (followList\'s own "This list is private" case)');

  console.log('\nbidirectional on the client too -- bob opening alice\'s profile gets the identical dead end');
  const bobCtx = makeCtx();
  vm.runInContext(`TOKEN = ${JSON.stringify(bob.token)}; ME = ${JSON.stringify(bob.user)};`, bobCtx);
  sink.html = '';
  await vm.runInContext('profileView', bobCtx)(alice.user.id);
  ok(sink.html.includes("This profile isn't available."), 'bob sees the same dead-end screen for alice\'s profile');
  ok(!sink.html.includes('oct2bp_alice') && !sink.html.includes('oct2bp_Alice'), 'alice\'s identity is not in the markup either');

  console.log('\nregression: an ordinary, non-blocked profile view still renders completely normally through the same code path');
  const carolCtx = makeCtx();
  vm.runInContext(`TOKEN = ${JSON.stringify(carol.token)}; ME = ${JSON.stringify(carol.user)};`, carolCtx);
  sink.html = '';
  await vm.runInContext('profileView', carolCtx)(bob.user.id);
  ok(sink.html.includes('oct2bp_bob'), 'carol (uninvolved) still sees bob\'s real profile with his username');
  ok(!sink.html.includes("This profile isn't available."), 'and not the blocked dead-end');

  console.log('\nSettings -> Blocked accounts (the carve-out) renders bob\'s real name/avatar and an Unblock button, with no tap-through to a profile at all');
  sink.html = '';
  await vm.runInContext('blockedAccountsScreen', aliceCtx)();
  ok(sink.html.includes('oct2bp_bob') || sink.html.includes('Oct2bp_bob'), `alice\'s Blocked accounts screen shows bob\'s real identity (got: ${sink.html.slice(0, 400)})`);
  ok(/onclick="unblockUser\(/.test(sink.html), 'and an Unblock button');
  ok(!/onclick="profileView\(/.test(sink.html), 'but no profileView(...) tap-through anywhere on this screen -- the row itself is not a link into the (now-unavailable) profile');
}

try { srv && srv.kill(); } catch {}
rmSync(DIR, { recursive: true, force: true });
await testDb.drop();

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
