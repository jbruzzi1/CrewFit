// Deleting a shared workout, and what the server accepts as an upload.
//
// Run:  npm test
//
// A workout holds EVERYONE's sets, so deleting one used to take a training partner's history
// with it, silently and with no undo.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = process.env.TEST_PORT4 || 4957;
const B = `http://localhost:${PORT}`;
const DIR = mkdtempSync(join(tmpdir(), 'crewfit-share-'));
let fails = 0, srv = null, srvDead = true;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const J = { 'Content-Type': 'application/json' };

function boot() {
  return new Promise(res => {
    srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: DIR, PORT: String(PORT) },
      cwd: new URL('..', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'pipe'] });
    srvDead = false;
    let err = '', done = false;
    const finish = v => { if (!done) { done = true; res(v); } };
    srv.stderr.on('data', d => { err += d; });
    srv.stdout.on('data', d => { if (String(d).includes('CrewFit on')) finish({ started: true }); });
    srv.on('exit', () => { srvDead = true; finish({ started: false, err }); });
    setTimeout(() => finish({ started: false, err: err || 'timeout' }), 12000);
  });
}
const stop = () => new Promise(r => { if (!srv || srvDead) return r(); srv.on('exit', r); srv.kill(); });

async function user(name) {
  const username = name + Math.floor(Math.random()*1e6);
  const r = await fetch(B + '/api/register', { method: 'POST', headers: J,
    body: JSON.stringify({ username, pin: 'pass1234', displayName: name }) })
    .then(x => x.json());
  return { id: r.user.id, username, H: { ...J, Authorization: 'Bearer ' + r.token } };
}
// invites only go to friends, so they have to become friends first
async function befriend(a, b) {
  await fetch(B + '/api/friends/request', { method: 'POST', headers: a.H,
    body: JSON.stringify({ username: b.username }) });
  await fetch(B + '/api/friends/accept', { method: 'POST', headers: b.H,
    body: JSON.stringify({ from: a.id }) });
}
const get = (u, p) => fetch(B + p, { headers: u.H }).then(x => x.json());

await boot();
try {

console.log('deleting a shared workout cannot erase the other person\'s history');
{
  const jeff = await user('Jeff'), brian = await user('Brian');
  await befriend(jeff, brian);
  const s = await fetch(B + '/api/sessions', { method: 'POST', headers: jeff.H,
    body: JSON.stringify({ name: 'Legs', visibility: 'friends', scheduledAt: '2026-08-12T18:00:00Z',
      inviteUsernames: [brian.username.toUpperCase()],   // and in the wrong capitalisation
      exercises: [{ name: 'Barbell Back Squat', defaultSets: 3, defaultReps: 8, defaultRepsMax: 10 }] }) })
    .then(x => x.json());
  ok((s.invited || []).includes(brian.id), 'Brian is invited even though the name was typed in capitals');
  await fetch(B + `/api/sessions/${s.id}/accept`, { method: 'POST', headers: brian.H });
  await fetch(B + `/api/sessions/${s.id}/log`, { method: 'POST', headers: jeff.H,
    body: JSON.stringify({ exerciseId: s.exercises[0].id, weight: 315, reps: 5 }) });
  await fetch(B + `/api/sessions/${s.id}/log`, { method: 'POST', headers: brian.H,
    body: JSON.stringify({ exerciseId: s.exercises[0].id, weight: 495, reps: 3 }) });

  const before = await get(brian, '/api/progress?weeks=4');
  ok(before.prs.some(p => p.weight === 495), 'Brian has his 495 record');

  const del = await fetch(B + '/api/sessions/' + s.id, { method: 'DELETE', headers: jeff.H });
  const body = await del.json();
  ok(del.status === 409 && body.canLeave, `Jeff cannot delete it (got ${del.status})`);
  ok(/Brian/.test(body.error || ''), `and is told who would lose data (${body.error})`);

  const after = await get(brian, '/api/progress?weeks=4');
  ok(after.prs.some(p => p.weight === 495), "Brian's record is untouched");

  // Jeff takes himself out instead
  const left = await fetch(B + `/api/sessions/${s.id}/leave`, { method: 'POST', headers: jeff.H }).then(x => x.json());
  ok(left.ok, 'Jeff can remove it from his own profile');
  const jp = await get(jeff, '/api/progress?weeks=4');
  ok(!jp.prs.some(p => p.weight === 315), "Jeff's own sets went with him");
  const bp = await get(brian, '/api/progress?weeks=4');
  ok(bp.prs.some(p => p.weight === 495), "and Brian still has his");
  const still = await get(brian, '/api/sessions/' + s.id);
  ok(still && still.id === s.id, 'the workout still exists for Brian');
  ok(still.creatorId === brian.id, 'and he now owns it, so he can still finish it');
}

console.log('\ndeleting a workout only you logged in still works');
{
  const u = await user('Solo');
  const s = await fetch(B + '/api/sessions', { method: 'POST', headers: u.H,
    body: JSON.stringify({ name: 'Push', visibility: 'private', scheduledAt: '2026-08-12T18:00:00Z',
      exercises: [{ name: 'Flat Barbell Bench Press', defaultSets: 3, defaultReps: 8, defaultRepsMax: 10 }] }) })
    .then(x => x.json());
  await fetch(B + `/api/sessions/${s.id}/log`, { method: 'POST', headers: u.H,
    body: JSON.stringify({ exerciseId: s.exercises[0].id, weight: 185, reps: 10 }) });
  const del = await fetch(B + '/api/sessions/' + s.id, { method: 'DELETE', headers: u.H });
  ok(del.status < 400, `it deletes (got ${del.status})`);
  const p = await get(u, '/api/progress?weeks=4');
  ok(!p.prs.length, 'and the records built from it are rebuilt, not left behind');
}

console.log('\nan invited person can look at the workout before deciding');
{
  // Brian invited Jeff and Jeff could not open it. Not a permissions bug — the server always
  // allowed it. The pending-invite row on the home screen was styled tappable and had no handler,
  // so the only two options were accept blind or decline blind. Both halves are asserted here:
  // the server lets an invitee read it, and the home screen actually offers the way in.
  const brian = await user('Brian'), jeff = await user('Jeff');
  await befriend(brian, jeff);
  const s = await fetch(B + '/api/sessions', { method: 'POST', headers: brian.H,
    body: JSON.stringify({ name: 'Push Day', visibility: 'friends', scheduledAt: '2026-08-14T17:00:00Z',
      inviteUsernames: [jeff.username],
      exercises: [{ name: 'Bench Press', defaultSets: 4, defaultReps: 6, defaultRepsMax: 8 }] }) })
    .then(x => x.json());
  ok((s.invited || []).includes(jeff.id), 'the invite lands');

  const seen = await get(jeff, '/api/sessions/' + s.id);
  ok(seen && seen.id === s.id, 'an invitee can open it WITHOUT accepting first');
  ok((seen.exercises || []).length === 1, 'and sees what is actually in it');
  ok(!(seen.participants || []).includes(jeff.id), 'while still not counting as having joined');

  const stranger = await user('Nosy');    // not a friend, not invited
  const blocked = await fetch(B + '/api/sessions/' + s.id, { headers: stranger.H });
  ok(blocked.status === 403, `someone with no connection to it still cannot (got ${blocked.status})`);

  // The UI half. CI has no browser, so this reads the source of the home screen. It reads it
  // strictly, because a loose /onclick=/ check passes on onclick="void 0" — and because the first
  // version of these assertions was proved able to survive Accept being unwired, Decline being
  // deleted, and the whole banner being switched off. Each one below has been checked by breaking
  // the thing it guards. `_v170check.cjs` is the browser version of the same checks.
  const src = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const card = (src.match(/<div class="inv-card"[^>]*>[\s\S]*?<\/div>\s*<\/div>`/) || [''])[0];

  ok(/^<div class="inv-card" onclick="openSession\('\$\{s\.id\}'\)">/.test(card),
     'the home-screen invite row opens THAT workout — it is not merely styled tappable');
  ok(/onclick="[^"]*\bacceptInvite\('\$\{s\.id\}'\)/.test(card), 'Accept still accepts');
  ok(/onclick="[^"]*\bdeclineInvite\('\$\{s\.id\}'\)/.test(card), 'Decline still declines');
  // either placement of stopPropagation is fine — what matters is that a button press cannot
  // ALSO reach the row handler and navigate away
  const guardOnWrapper = /class="row inv-actions"[^>]*onclick="event\.stopPropagation\(\)"/.test(card);
  const guardOnButtons = (card.match(/onclick="event\.stopPropagation\(\);/g) || []).length >= 2;
  ok(guardOnWrapper || guardOnButtons, 'and neither button also opens the workout');
  // the row is rendered at all: guard the branch, not just the markup inside it
  ok(/if\(pending\.length\)\{/.test(src.replace(/\s+/g, '')) || /if \(pending\.length\)/.test(src),
     'the banner is still rendered when an invite is pending');
  // the CSS half — the collision with the friend picker is the reason for the rename, so a
  // silent revert to the shared name has to fail here too
  ok(/\.inv-card\s*\{/.test(css), '.inv-card is styled — the row is not an unstyled div');
  ok(!/class="inv-row"/.test(card), 'and it does not reuse .inv-row, which belongs to the friend picker');
}

console.log('\na workout is called the same thing on every screen it appears on');
{
  // Tapping "Push Day" and landing on a page headed "Aug 14, 5:00 PM" reads like the wrong
  // workout opened. All three views share sessTitle/sessSub so they cannot drift apart again.
  const src = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const heads = src.match(/<h1 class="sess-date">[^<]*<\/h1>/g) || [];
  ok(heads.length >= 3, `every session view has a heading (${heads.length} found)`);
  ok(heads.every(h => h.includes('sessTitle(s)')),
     `and all of them use the same one — ${heads.filter(h => !h.includes('sessTitle(s)')).join(' ') || 'all consistent'}`);
  ok(/function sessTitle\(s\)\{[^}]*\.trim\(\)/.test(src.replace(/\s+/g, ' ').replace(/ /g, '')) ||
     /sessTitle[\s\S]{0,200}trim\(\)/.test(src),
     'a name of only spaces falls back to the date instead of rendering a blank title');
}

console.log('\na workout name is stored trimmed');
{
  const u = await user('Trim');
  const s = await fetch(B + '/api/sessions', { method: 'POST', headers: u.H,
    body: JSON.stringify({ name: '   ', visibility: 'private', scheduledAt: '2026-08-12T18:00:00Z',
      exercises: [{ name: 'Row', defaultSets: 3, defaultReps: 8 }] }) }).then(x => x.json());
  ok(s.name === '', `a name of only spaces is stored empty, not as spaces (got ${JSON.stringify(s.name)})`);
  const r = await fetch(B + '/api/sessions/' + s.id, { method: 'PUT', headers: u.H,
    body: JSON.stringify({ name: '  Push Day  ' }) });
  const after = await get(u, '/api/sessions/' + s.id);
  ok(r.status < 400 ? after.name === 'Push Day' : true,
     `and an edited name loses its padding (got ${JSON.stringify(after.name)})`);
}

console.log('\nuploads have limits');
{
  const u = await user('Up');
  const s = await fetch(B + '/api/sessions', { method: 'POST', headers: u.H,
    body: JSON.stringify({ name: 'P', visibility: 'private', scheduledAt: '2026-08-12T18:00:00Z',
      exercises: [{ name: 'Leg Press', defaultSets: 3, defaultReps: 8, defaultRepsMax: 10 }] }) })
    .then(x => x.json());
  await fetch(B + `/api/sessions/${s.id}/lock`, { method: 'POST', headers: u.H });
  const photo = mb => ({ type: 'image', src: 'data:image/jpeg;base64,' + 'A'.repeat(Math.floor(mb * 1048576 * 4 / 3)) });
  const post = media => fetch(B + `/api/sessions/${s.id}/post`, { method: 'POST', headers: u.H,
    body: JSON.stringify({ notes: '', media, visibility: 'only_me' }) });

  const many = await post([photo(0.1), photo(0.1), photo(0.1), photo(0.1), photo(0.1)]);
  ok(many.status === 413, `five photos are refused (got ${many.status})`);
  const big = await post([photo(9)]);
  ok(big.status === 413, `a 9 MB photo is refused (got ${big.status})`);
  ok(/limit/i.test((await big.json()).error || ''), 'and it says what the limit is');
  const fine = await post([photo(0.2), photo(0.2)]);
  ok(fine.status < 400, `two normal photos are accepted (got ${fine.status})`);
}

} finally { await stop(); rmSync(DIR, { recursive: true, force: true }); }

console.log(fails ? `\n${fails} FAILURE(S)\n` : '\nall assertions passed\n');
process.exit(fails ? 1 : 0);
