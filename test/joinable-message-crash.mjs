// v249 audit finding: a friend viewing a joinable (visibility:'friends') session they were never
// invited to and haven't joined gets a "Join in?" screen with a "Message {host}" button next to
// it, wired to openChat(id) = document.getElementById('chatInput').focus(). That button was dead:
// #chatInput only renders when canChat is true (isCreator || isParticipant || pendingMe, in
// openSession), and none of those hold for this tier — pendingMe specifically requires an actual
// invite on file, which this viewer doesn't have. Tapping it called .focus() on null and threw,
// every time, for anyone who saw this screen without having been invited.
//
// The fix removes the button for this tier entirely rather than making it "work": the server's
// own POST /api/sessions/:id/comments gate (tier === 'member' || tier === 'invited' only) would
// still 403 a message from this tier even with a working input box, so there was never a real
// feature to restore — same "don't render a promise the app can't keep" principle the chat INPUT
// box already followed (see the comment above chatBlock in app.js), just missed for the button
// that opened it. openChat() also got a defensive null-guard as a second line of defense.
//
// This runs the REAL server AND the REAL public/app.js via node:vm (same harness as
// test/leave-workout.mjs), so what's asserted is the page openSession() actually renders, not a
// re-implementation of its branching.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { freshTestDb } from './_pgtestdb.mjs';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const J = { 'Content-Type': 'application/json' };
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('joinablemsg');

function boot(port, dir) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; srv.stdout.on('data', d => { out += d; if (String(d).includes('CrewFit on')) res({ srv, out }); });
    srv.on('exit', () => res({ srv: null, out }));
    setTimeout(() => res({ srv, out }), 15000);
  });
}

const DIR = mkdtempSync(join(tmpdir(), 'joinablemsg-'));
const PORT = 4985, B = `http://localhost:${PORT}`;
const { srv } = await boot(PORT, DIR);
ok(!!srv, 'server boots');

const post = (p, b, tok) => fetch(B + p, { method: 'POST', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b) }).then(r => r.json());
const reg = (username, pin, displayName) => post('/api/register', { username, pin, displayName });

// ---- render the REAL client against the REAL running server (same harness as leave-workout.mjs) ----
const SRC = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const sink = { html: '' };
let focusCalls = 0;
const el = () => new Proxy(function () {}, {
  get: (t, k) => k === 'style' || k === 'classList' || k === 'dataset' ? el()
    : k === 'innerHTML' ? sink.html
    : k === 'innerText' || k === 'value' || k === 'textContent' ? ''
    : k === 'focus' ? (() => { focusCalls++; })
    : k === 'children' || k === 'childNodes' ? [] : el(),
  set: (t, k, v) => { if (k === 'innerHTML') sink.html += String(v); return true; },
  apply: () => el(), has: () => true,
});
// getElementById('chatInput') mirrors whether openSession's own chatBlock actually put an
// id="chatInput" element in the HTML it just rendered (checked after each render below) — null
// when it did not, same as a real DOM. Every OTHER id still gets the generic always-present stub,
// same as leave-workout.mjs.
let chatInputPresent = false;
const doc = { getElementById: (id) => id === 'chatInput' ? (chatInputPresent ? el() : null) : el(), querySelector: () => null, querySelectorAll: () => [],
  createElement: () => el(), addEventListener() {}, body: el(), documentElement: el(), head: el(),
  cookie: '', readyState: 'complete' };
function makeCtx() {
  const ctx = { console: { log() {}, warn() {}, error() {} }, document: doc,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: (url, opts) => fetch(B + url, opts),
    location: { href: '/', pathname: '/', search: '', hash: '' }, history: { replaceState() {}, pushState() {} },
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

console.log('the exact bug: a friend viewing a joinable session they were never invited to gets no dead "Message" button, and the crash is gone even if one somehow fires');
{
  const host = await reg('jm_host', 'pass1234', 'Host');
  const friend = await reg('jm_friend', 'pass1234', 'Friend');
  await post('/api/friends/request', { username: 'jm_friend' }, host.token);
  await post('/api/friends/accept', { from: host.user.id }, friend.token);
  const s = await post('/api/sessions', {
    name: 'Open Gym', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Deadlift' }],
    inviteUsernames: [], visibility: 'friends',
  }, host.token);

  const ctx = makeCtx();
  vm.runInContext(`TOKEN = ${JSON.stringify(friend.token)}; ME = ${JSON.stringify(friend.user)};`, ctx);
  sink.html = '';
  await vm.runInContext('openSession', ctx)(s.id);
  chatInputPresent = sink.html.includes('id="chatInput"');
  ok(sink.html.includes('Join in?'), 'the friend still sees the "Join in?" button — that half was never broken');
  ok(!sink.html.includes('Message'), 'the dead "Message {host}" button is gone for this tier, not left dangling');
  ok(!chatInputPresent, 'and indeed #chatInput itself is genuinely absent for this tier (confirms the bug was real)');

  console.log('  and openChat() itself no longer throws even if something still calls it with no #chatInput on the page');
  focusCalls = 0;
  let threw = false;
  try { await vm.runInContext('openChat', ctx)(s.id); } catch (e) { threw = true; }
  ok(!threw, 'openChat() does not throw when #chatInput is absent (defensive null-guard)');
  ok(focusCalls === 0, 'and it correctly does nothing — there is no box to focus');
}

console.log('\ncontrol case: an actual pending INVITE still gets a working "Message {host}" — this tier was never broken and must stay that way');
{
  const host2 = await reg('jm_host2', 'pass1234', 'Host2');
  const invitee = await reg('jm_invitee', 'pass1234', 'Invitee');
  await post('/api/friends/request', { username: 'jm_invitee' }, host2.token);
  await post('/api/friends/accept', { from: host2.user.id }, invitee.token);
  const s2 = await post('/api/sessions', {
    name: 'Pull Day', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Pull-Up' }],
    inviteUsernames: [], visibility: 'private',
  }, host2.token);
  await fetch(B + '/api/sessions/' + s2.id, {
    method: 'PUT', headers: { ...J, Authorization: 'Bearer ' + host2.token },
    body: JSON.stringify({ inviteUsernames: ['jm_invitee'] }),
  }).then(r => r.json());

  const ctx2 = makeCtx();
  vm.runInContext(`TOKEN = ${JSON.stringify(invitee.token)}; ME = ${JSON.stringify(invitee.user)};`, ctx2);
  sink.html = '';
  await vm.runInContext('openSession', ctx2)(s2.id);
  chatInputPresent = sink.html.includes('id="chatInput"');
  ok(sink.html.includes('Message'), 'a genuine pending invitee still gets the "Message {host}" button');
  ok(chatInputPresent, 'and #chatInput really is on the page for this tier (canChat via pendingMe)');

  focusCalls = 0;
  let threw2 = false;
  try { await vm.runInContext('openChat', ctx2)(s2.id); } catch (e) { threw2 = true; }
  ok(!threw2, 'openChat() does not throw for a real pending invitee either');
  ok(focusCalls === 1, 'and it actually focuses the real input this time — the fix did not just delete the working case');
}

console.log('\ncold-review catch: a genuinely INVITED person still gets "Message {host}" even when the session lands them in the joinable branch, not respondHere');
{
  // respondHere requires !sessionHasAnyPost(s) — once the host has posted a recap, an invitee who
  // has not yet answered gets bumped into the SAME joinable branch as someone who was never
  // invited at all, but pendingMe (and therefore canChat) is still true for them: they really do
  // have #chatInput on the page. The first pass at this fix removed the button for the whole
  // joinable branch unconditionally, which silently broke this working case too — this proves the
  // canChat-gated version keeps it working here while still killing it for the never-invited case
  // covered above.
  const host3 = await reg('jm_host3', 'pass1234', 'Host3');
  const invitee3 = await reg('jm_invitee3', 'pass1234', 'Invitee3');
  await post('/api/friends/request', { username: 'jm_invitee3' }, host3.token);
  await post('/api/friends/accept', { from: host3.user.id }, invitee3.token);
  const s3 = await post('/api/sessions', {
    name: 'Already Posted Day', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Row' }],
    inviteUsernames: ['jm_invitee3'], visibility: 'friends',
  }, host3.token);
  await post('/api/sessions/' + s3.id + '/log', { exerciseId: s3.exercises[0].id, weight: 95, reps: 10 }, host3.token);
  const posted3 = await post('/api/sessions/' + s3.id + '/post', { notes: 'done', visibility: 'friends', media: [] }, host3.token);
  ok(!posted3.error, `host posts a recap before the invitee responds (got ${posted3.error})`);

  const ctx3 = makeCtx();
  vm.runInContext(`TOKEN = ${JSON.stringify(invitee3.token)}; ME = ${JSON.stringify(invitee3.user)};`, ctx3);
  sink.html = '';
  await vm.runInContext('openSession', ctx3)(s3.id);
  chatInputPresent = sink.html.includes('id="chatInput"');
  ok(sink.html.includes('Join in?'), 'the still-unanswered invitee lands on the "Join in?" screen (sessionHasAnyPost bumped them out of respondHere)');
  ok(chatInputPresent, 'and #chatInput really is present for them (canChat via pendingMe, unaffected by which screen they landed on)');
  ok(sink.html.includes('Message'), 'so "Message {host}" correctly still shows here — the canChat-gated fix does not remove a working button');

  focusCalls = 0;
  let threw3 = false;
  try { await vm.runInContext('openChat', ctx3)(s3.id); } catch (e) { threw3 = true; }
  ok(!threw3, 'openChat() does not throw for this invitee either');
  ok(focusCalls === 1, 'and it actually focuses the real input');
}

try { srv && srv.kill(); } catch {}
rmSync(DIR, { recursive: true, force: true });
await testDb.drop();

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
