// v250 audit finding: sessionTier()'s 'reader' tier exists ONLY so a published recap isn't
// blocked by session privacy (see the comment above anyVisiblePost in server.js) -- a stranger who
// can see just ONE participant's public recap was never meant to get the rest of the session along
// with it. But sessionView() built one shared `view` object for friend/invited/reader/alumni alike,
// so a 'reader' unconditionally got the creator's private note, the gym location, and the pending
// swap-suggestion conversation -- none of which that one person's "make my recap public" choice was
// ever meant to expose about the SESSION. Nothing in the code defended this as deliberate, unlike
// every other field-visibility choice in sessionView (which are all explained by a comment).
//
// The fix scopes location/creatorNote/suggestedEdits to tiers that actually have (or are being
// offered) a real place in the workout -- friend/invited (deciding whether to join) and alumni
// (actually trained it) -- and withholds them from reader. participants/exercises are left as they
// were for every tier: exercises are needed to label the one recap a reader may see; raw participant
// ids without resolvable names (nameOf only resolves an ACTUAL friend) are a much smaller exposure
// than free-text personal content.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const J = { 'Content-Type': 'application/json' };
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('readerprivacy');

function boot(port, dir) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; srv.stdout.on('data', d => { out += d; if (String(d).includes('CrewFit on')) res({ srv, out }); });
    srv.on('exit', () => res({ srv: null, out }));
    setTimeout(() => res({ srv, out }), 15000);
  });
}

const DIR = mkdtempSync(join(tmpdir(), 'readerprivacy-'));
const PORT = 4986, B = `http://localhost:${PORT}`;
const { srv } = await boot(PORT, DIR);
ok(!!srv, 'server boots');

const post = (p, b, tok) => fetch(B + p, { method: 'POST', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b) }).then(r => r.json());
const get = (p, tok) => fetch(B + p, { headers: tok ? { Authorization: 'Bearer ' + tok } : {} }).then(r => r.json());
const reg = (username, pin, displayName) => post('/api/register', { username, pin, displayName });

console.log('the exact leak: a stranger who can see one participant\'s PUBLIC recap gets the whole private session along with it');
{
  const alice = await reg('rp_alice', 'pass1234', 'Alice');
  const bob = await reg('rp_bob', 'pass1234', 'Bob');
  const carol = await reg('rp_carol', 'pass1234', 'Carol'); // no relationship to alice or bob at all
  // v190 (Sep 2026): 'public' post visibility means canSeeProfile(authorId, viewer) -- a genuine
  // total stranger only reaches it if bob's own profile is ALSO Public (every account defaults to
  // Private). Opt bob in so "reaches a total stranger" is the true statement this block tests.
  await post('/api/me/profile-visibility', { visibility: 'public' }, bob.token);
  await post('/api/follow/' + bob.user.id, {}, alice.token);
  await post('/api/follow-requests/' + alice.user.id + '/accept', {}, bob.token);
  await post('/api/follow/' + alice.user.id, {}, bob.token);
  await post('/api/follow-requests/' + bob.user.id + '/accept', {}, alice.token);

  const s = await post('/api/sessions', {
    name: 'Leg Day', scheduledAt: new Date().toISOString(),
    exercises: [{ name: 'Squat' }], inviteUsernames: [], visibility: 'private',
    location: 'Alice\'s Home Gym, 42 Elm St', creatorNote: 'bring the good playlist',
  }, alice.token);
  await fetch(B + '/api/sessions/' + s.id, {
    method: 'PUT', headers: { ...J, Authorization: 'Bearer ' + alice.token },
    body: JSON.stringify({ inviteUsernames: ['rp_bob'] }),
  }).then(r => r.json());
  await post('/api/sessions/' + s.id + '/accept', {}, bob.token);
  await post('/api/sessions/' + s.id + '/log', { exerciseId: s.exercises[0].id, weight: 135, reps: 8 }, bob.token);
  // Bob's own recap choice -- entirely about HIS post, not the session's own privacy.
  const posted = await post('/api/sessions/' + s.id + '/post', { notes: 'good session', visibility: 'public', media: [] }, bob.token);
  ok(!posted.error, `bob posts a public recap (got ${posted.error})`);

  const carolTier = await get('/api/sessions/' + s.id, carol.token);
  ok(!carolTier.error, `carol (a total stranger) can reach the session via bob's public recap (got ${carolTier.error})`);
  ok(carolTier.posts && carolTier.posts[bob.user.id] && !carolTier.posts[bob.user.id].hidden, 'and does see the recap bob actually published -- that half is not the bug');

  ok(carolTier.creatorNote === undefined, `but alice's private creatorNote is NOT leaked to her (got ${JSON.stringify(carolTier.creatorNote)})`);
  ok(carolTier.location === undefined, `and the gym location is NOT leaked either (got ${JSON.stringify(carolTier.location)})`);
  ok(Array.isArray(carolTier.suggestedEdits) && carolTier.suggestedEdits.length === 0, `and the pending swap conversation is NOT leaked (got ${JSON.stringify(carolTier.suggestedEdits)})`);

  console.log('\ncontrol: a genuine friend/invited/alumni tier must keep seeing all of this -- the fix must not overcorrect');
  const dave = await reg('rp_dave', 'pass1234', 'Dave');
  await post('/api/follow/' + dave.user.id, {}, alice.token);
  await post('/api/follow-requests/' + alice.user.id + '/accept', {}, dave.token);
  await post('/api/follow/' + alice.user.id, {}, dave.token);
  await post('/api/follow-requests/' + dave.user.id + '/accept', {}, alice.token);
  const s2 = await post('/api/sessions', {
    name: 'Pull Day', scheduledAt: new Date().toISOString(),
    exercises: [{ name: 'Row' }], inviteUsernames: [], visibility: 'public',
    location: 'Community Gym', creatorNote: 'wear the good shoes',
  }, alice.token);
  const daveView = await get('/api/sessions/' + s2.id, dave.token); // friend tier: not invited, not a member, just eligible to join
  ok(daveView.location === 'Community Gym', `a friend deciding whether to join still sees the location (got ${JSON.stringify(daveView.location)})`);
  ok(daveView.creatorNote === 'wear the good shoes', `and the creator's note (got ${JSON.stringify(daveView.creatorNote)})`);

  await fetch(B + '/api/sessions/' + s2.id, {
    method: 'PUT', headers: { ...J, Authorization: 'Bearer ' + alice.token },
    body: JSON.stringify({ inviteUsernames: ['rp_dave'] }),
  }).then(r => r.json());
  const daveInvited = await get('/api/sessions/' + s2.id, dave.token);
  ok(daveInvited.location === 'Community Gym' && daveInvited.creatorNote === 'wear the good shoes', 'and still does once actually invited');
}

try { srv && srv.kill(); } catch {}
rmSync(DIR, { recursive: true, force: true });
await testDb.drop();

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
