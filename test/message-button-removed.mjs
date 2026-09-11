// Sep 11 2026 (Jeff): the "Message {host}" shortcut on the invite-response screens never opened
// a private message — it just focused the shared Chat box already rendered above it on the same
// screen (crewBlock + chatBlock), and reading it as a private-DM feature that doesn't exist was
// exactly the confusion Jeff flagged from a real screenshot. Removed entirely (not relabeled) in
// both places it rendered: the respondHere branch (an actual pending invite) and the joinable
// branch (a public session you can ask to join, including the canChat-gated overlap case where a
// genuinely invited person lands here because the host already posted a recap — see the old v249
// audit-finding comment, removed alongside the button it explained). openChat() itself is gone too.
//
// This replaces test/joinable-message-crash.mjs, which existed to prove that same button didn't
// crash for a never-invited viewer — moot now that the button is gone for everyone, not just that
// tier. What matters now is simpler: the button and its wiring are actually gone, the screens it
// used to sit on still render correctly without it, and nothing else broke.
//
// Runs the REAL server AND the REAL public/app.js via node:vm (same harness as
// test/leave-workout.mjs and the file this replaces), so what's asserted is the page
// openSession() actually renders, not a re-implementation of its branching.
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
const testDb = await freshTestDb('msgbtnremoved');

function boot(port, dir) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; srv.stdout.on('data', d => { out += d; if (String(d).includes('CrewFit on')) res({ srv, out }); });
    srv.on('exit', () => res({ srv: null, out }));
    setTimeout(() => res({ srv, out }), 15000);
  });
}

const DIR = mkdtempSync(join(tmpdir(), 'msgbtnremoved-'));
const PORT = 4986, B = `http://localhost:${PORT}`;
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
// Matches only the removed button itself (a linkbtn whose label starts with "Message"), not the
// unrelated "Message the crew" placeholder text that legitimately still lives on the chat input.
const hasMessageButton = html => /<button class="linkbtn"[^>]*>Message\b/.test(html);
let chatInputPresent = false;
const doc = { getElementById: (id) => id === 'chatInput' ? (chatInputPresent ? el() : null) : el(), querySelector: () => null, querySelectorAll: () => [],
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

console.log('openChat is gone entirely, not just unused');
{
  const ctx = makeCtx();
  const type = vm.runInContext('typeof openChat', ctx);
  ok(type === 'undefined', `openChat is undefined in the rendered client (got ${type})`);
}

console.log('\nan actual pending INVITE (respondHere) renders Accept/Decline and Save this routine, with no "Message" button');
{
  const host = await reg('mbr_host', 'pass1234', 'Host');
  const invitee = await reg('mbr_invitee', 'pass1234', 'Invitee');
  await post('/api/follow/' + invitee.user.id, {}, host.token);
  await post('/api/follow-requests/' + host.user.id + '/accept', {}, invitee.token);
  await post('/api/follow/' + host.user.id, {}, invitee.token);
  await post('/api/follow-requests/' + invitee.user.id + '/accept', {}, host.token);
  const s = await post('/api/sessions', {
    name: 'Pull Day', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Pull-Up' }],
    inviteUsernames: [], visibility: 'private',
  }, host.token);
  await fetch(B + '/api/sessions/' + s.id, {
    method: 'PUT', headers: { ...J, Authorization: 'Bearer ' + host.token },
    body: JSON.stringify({ inviteUsernames: ['mbr_invitee'] }),
  }).then(r => r.json());

  const ctx = makeCtx();
  vm.runInContext(`TOKEN = ${JSON.stringify(invitee.token)}; ME = ${JSON.stringify(invitee.user)};`, ctx);
  sink.html = '';
  chatInputPresent = true; // pendingMe -> canChat true, #chatInput really renders here
  await vm.runInContext('openSession', ctx)(s.id);
  ok(sink.html.includes('Accept'), 'Accept is still offered');
  ok(sink.html.includes('Decline'), 'Decline is still offered');
  ok(sink.html.includes('Save this routine'), 'Save this routine is still offered, standing alone now');
  ok(!hasMessageButton(sink.html), 'the "Message {host}" button is gone');
  ok(!sink.html.includes('aside-dot'), 'the now-pointless separator dot is gone too');
}

console.log('\na never-invited viewer of a public session (joinable) still gets "Join in?" with no "Message" button and no #chatInput');
{
  const host2 = await reg('mbr_host2', 'pass1234', 'Host2');
  const friend2 = await reg('mbr_friend2', 'pass1234', 'Friend2');
  await post('/api/follow/' + friend2.user.id, {}, host2.token);
  await post('/api/follow-requests/' + host2.user.id + '/accept', {}, friend2.token);
  await post('/api/follow/' + host2.user.id, {}, friend2.token);
  await post('/api/follow-requests/' + friend2.user.id + '/accept', {}, host2.token);
  const s2 = await post('/api/sessions', {
    name: 'Open Gym', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Deadlift' }],
    inviteUsernames: [], visibility: 'public',
  }, host2.token);

  const ctx2 = makeCtx();
  vm.runInContext(`TOKEN = ${JSON.stringify(friend2.token)}; ME = ${JSON.stringify(friend2.user)};`, ctx2);
  sink.html = '';
  chatInputPresent = false; // this tier has no canChat, same as before
  await vm.runInContext('openSession', ctx2)(s2.id);
  ok(sink.html.includes('Join in?'), 'the "Join in?" button still renders');
  ok(!hasMessageButton(sink.html), 'no "Message" button for this tier');
}

console.log('\na genuinely invited person bumped into the joinable branch (host already posted) also gets no "Message" button, even though they can chat');
{
  const host3 = await reg('mbr_host3', 'pass1234', 'Host3');
  const invitee3 = await reg('mbr_invitee3', 'pass1234', 'Invitee3');
  await post('/api/follow/' + invitee3.user.id, {}, host3.token);
  await post('/api/follow-requests/' + host3.user.id + '/accept', {}, invitee3.token);
  await post('/api/follow/' + host3.user.id, {}, invitee3.token);
  await post('/api/follow-requests/' + invitee3.user.id + '/accept', {}, host3.token);
  const s3 = await post('/api/sessions', {
    name: 'Already Posted Day', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Row' }],
    inviteUsernames: ['mbr_invitee3'], visibility: 'public',
  }, host3.token);
  await post('/api/sessions/' + s3.id + '/log', { exerciseId: s3.exercises[0].id, weight: 95, reps: 10 }, host3.token);
  const posted3 = await post('/api/sessions/' + s3.id + '/post', { notes: 'done', visibility: 'public', media: [] }, host3.token);
  ok(!posted3.error, `host posts a recap before the invitee responds (got ${posted3.error})`);

  const ctx3 = makeCtx();
  vm.runInContext(`TOKEN = ${JSON.stringify(invitee3.token)}; ME = ${JSON.stringify(invitee3.user)};`, ctx3);
  sink.html = '';
  chatInputPresent = true; // pendingMe still true here -> canChat true, #chatInput still renders
  await vm.runInContext('openSession', ctx3)(s3.id);
  ok(sink.html.includes('Join in?'), 'still lands on the "Join in?" screen (sessionHasAnyPost bumped them out of respondHere)');
  ok(!hasMessageButton(sink.html), 'no "Message" button here either, even though this tier can genuinely chat');
}

try { srv && srv.kill(); } catch {}
rmSync(DIR, { recursive: true, force: true });
await testDb.drop();

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
