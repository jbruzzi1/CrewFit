// Following is approval-based (private-account model): a follow is a REQUEST until the target
// accepts. An approved follower sees the private profile (workouts, PRs, streak, activity); everyone
// else sees only the public counts. Friends (mutual) are a SEPARATE relationship, for workouts, and
// do NOT by themselves grant profile access. A one-time migration turns existing friends into
// approved followers (so nothing changes for current users) and old one-directional follows into
// pending requests (nobody silently gains access).
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const J = { 'Content-Type': 'application/json' };
const CWD = new URL('..', import.meta.url).pathname;

function boot(port, dir) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, PORT: String(port) }, cwd: CWD, stdio: ['ignore','pipe','pipe'] });
    let out=''; srv.stdout.on('data', d => { out+=d; if (String(d).includes('CrewFit on')) res({ srv, out }); });
    srv.on('exit', ()=>res({ srv:null, out }));
    setTimeout(()=>res({ srv, out }), 8000);
  });
}

// ---------- live flow ----------
{
  const DIR = mkdtempSync(join(tmpdir(), 'follow-'));
  const PORT = 4990, B = `http://localhost:${PORT}`;
  const { srv } = await boot(PORT, DIR);
  const H = t => ({ ...J, Authorization: 'Bearer ' + t });
  const reg = n => fetch(B+'/api/register', { method:'POST', headers:J, body:JSON.stringify({ username:n, pin:'pass1234', displayName:n }) }).then(r=>r.json());
  const prof = (who, id) => fetch(B+`/api/profile/${id}`, { headers:H(who.token) }).then(r=>r.json());
  const P = (who, p) => fetch(B+p, { method:'POST', headers:H(who.token) });

  const alice = await reg('alicef'), bob = await reg('bobf'), stranger = await reg('strangerf');
  // give bob a logged PR so there is private detail to gate
  const s = await fetch(B+'/api/sessions', { method:'POST', headers:H(bob.token), body:JSON.stringify({ name:'D', visibility:'private', scheduledAt:'2026-08-20T18:00:00Z', exercises:[{name:'Bench Press'}] }) }).then(r=>r.json());
  await fetch(B+`/api/sessions/${s.id}/log`, { method:'POST', headers:H(bob.token), body:JSON.stringify({ exerciseId:s.exercises[0].id, weight:225, reps:5, set:1 }) });

  console.log('a follow is a request until approved');
  let p = await prof(alice, bob.user.id);
  ok(p.limited === true && (p.prs||[]).length === 0, 'before following, alice sees bob\'s profile as limited (no PRs)');
  ok(typeof p.workoutsCompleted === 'number' && typeof p.followers === 'number' && typeof p.following === 'number', 'but the public counts are present');

  const r1 = await P(alice, `/api/follow/${bob.user.id}`).then(r=>r.json());
  ok(r1.status === 'requested', `following sends a request (status ${r1.status})`);
  p = await prof(alice, bob.user.id);
  ok(p.limited === true && p.youFollow === 'requested', 'while pending, still limited, and the button reads "requested"');

  const fr = await fetch(B+'/api/friends', { headers:H(bob.token) }).then(r=>r.json());
  ok((fr.followRequests||[]).some(u=>u.id===alice.user.id), 'bob sees the incoming follow request on his friends page');

  console.log('\nonce approved, the follower sees the private profile');
  const acc = await P(bob, `/api/follow-requests/${alice.user.id}/accept`);
  ok(acc.status === 200, `bob accepts (got ${acc.status})`);
  p = await prof(alice, bob.user.id);
  ok(p.limited === false && p.youFollow === 'following', 'alice is now an approved follower');
  ok((p.prs||[]).some(x=>x.weight===225), 'and sees bob\'s PR (225)');
  const bp = await prof(stranger, bob.user.id);
  ok(bp.followers === 1 && p.limited === false, `bob's follower count is 1 (${bp.followers})`);
  const ap = await prof(stranger, alice.user.id);
  ok(ap.following === 1, `alice's following count is 1 (${ap.following})`);

  console.log('\na stranger sees only the public line');
  const sp = await prof(stranger, bob.user.id);
  ok(sp.limited === true && (sp.prs||[]).length===0 && sp.streak == null && sp.prCount == null, 'no PRs, streak or PR count');
  ok(typeof sp.workoutsCompleted === 'number' && typeof sp.followers === 'number', 'but workout count and follower count are visible');

  console.log('\nunfollowing removes access; rejecting never grants it');
  await P(alice, `/api/unfollow/${bob.user.id}`);
  p = await prof(alice, bob.user.id);
  ok(p.limited === true && p.youFollow === 'none', 'after unfollow, alice is limited again');

  const carol = await reg('carolf');
  await P(carol, `/api/follow/${bob.user.id}`);
  await P(bob, `/api/follow-requests/${carol.user.id}/reject`);
  p = await prof(carol, bob.user.id);
  ok(p.limited === true && p.youFollow === 'none', 'a rejected request grants nothing');
  const fr2 = await fetch(B+'/api/friends', { headers:H(bob.token) }).then(r=>r.json());
  ok(!(fr2.followRequests||[]).some(u=>u.id===carol.user.id), 'and the rejected request is gone from the list');

  try { srv && srv.kill(); } catch {} rmSync(DIR, { recursive:true, force:true });
}

// ---------- migration ----------
{
  const DIR = mkdtempSync(join(tmpdir(), 'followmig-'));
  const PORT = 4989;
  const u = (id, extra) => Object.assign({ id, username: id, displayName: id, friends: [], units: 'lb', createdAt: '2026-01-01T00:00:00.000Z', pinHash: 'x', pinSalt: 'y' }, extra);
  writeFileSync(join(DIR, 'data.json'), JSON.stringify({
    users: {
      u1: u('u1', { friends: ['u2'] }),                 // u1 & u2 are mutual friends
      u2: u('u2', { friends: ['u1'], followers: ['u3'] }), // u3 followed u2 the OLD way, not a friend
      u3: u('u3', {}),
      u4: u('u4', { friends: 'oops' }),  // a hand-edited row — friends is not even an array
    },
    sessions: {}, prs: {}, pushSubs: {}, templates: {}, seeds: {}, customExercises: {}, friendships: {},
  }));
  const { srv, out } = await boot(PORT, DIR);
  ok(!!srv, 'server boots on pre-migration data, including a row with a non-array friends field');
  const db = JSON.parse(readFileSync(join(DIR, 'data.json'), 'utf8'));
  console.log('\nthe migration grandfathers friends and pends old follows');
  ok(db.users.u1.followers.includes('u2') && db.users.u2.followers.includes('u1'), 'mutual friends became mutual approved followers');
  ok(!db.users.u2.followers.includes('u3'), 'the old one-directional follower is NOT auto-approved');
  ok((db.users.u2.followReqs||[]).includes('u3'), 'it became a pending follow request instead');
  ok(db.users.u1.following.includes('u2'), 'following is rebuilt from approved followers');
  ok(Array.isArray(db.users.u4.followers) && db.users.u4.followers.length === 0, 'the malformed friends row is treated as having none, not a crash');
  ok(db.followApprovalV1 === true, 'and the migration marks itself done (idempotent)');
  try { srv && srv.kill(); } catch {} rmSync(DIR, { recursive:true, force:true });
}

// ---------- client render: a private profile still shows workouts you legitimately share ----------
// The server computes myWorkouts for a shared/participant session regardless of follow status (that
// access comes from actually training together, a separate concern from following). A prior version
// of profileView() replaced the ENTIRE workouts section with the "this profile is private" card
// whenever limited=true — discarding those legitimately-visible workouts along with the PRs/streak/
// activity that SHOULD be hidden. This runs the real public/app.js and checks the rendered output.
{
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
  vm.runInContext(`ME = { id: 'viewer1' };`, ctx);

  const PROFILE = {
    id: 'owner1', username: 'owner', displayName: 'Owner', workoutsCompleted: 5, following: 2, followers: 3,
    youFollow: 'none', followsYou: false, limited: true, prCount: null, prs: [], streak: null, recentActivity: [],
    myWorkouts: [{ id: 'w1', name: 'Leg Day', at: '2026-08-10T00:00:00.000Z', firstExercises: ['Squat'], exerciseCount: 1 }],
  };
  vm.runInContext(`H.get = () => Promise.resolve(${JSON.stringify(PROFILE)});`, ctx);
  sink.html = '';
  await vm.runInContext('profileView', ctx)('owner1');

  console.log('\na private profile still shows a workout you actually shared with them');
  ok(/wtile/.test(sink.html), 'the shared workout tile renders on the profile page');
  ok(/Leg Day/.test(sink.html), 'and its name is present');
  ok(/private/i.test(sink.html), 'the private-profile notice for PRs/activity still shows');
  ok(!/Personal Records/.test(sink.html), 'but the PR section itself is not rendered (prs is empty while limited)');
}

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
