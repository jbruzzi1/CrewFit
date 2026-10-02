// Oct 1 2026 (Jeff, re-raising the Sep 29 "if they are blocked they shouldn't show at all --
// similar to how instagram is" rule, this time for OTHER people's followers/following lists, not
// just the search box): GET /api/users/search already excluded a blocked relationship both
// directions (test/audit-sep30-fixes.mjs covers that). followListFor() -- which powers
// GET /api/profile/:id/followers and .../following -- only ever checked canSeeProfile(id, viewer),
// the relationship between the viewer and the PROFILE OWNER, never the people actually listed
// inside it. Browsing a third party's followers was a real, reachable way to find someone you'd
// blocked (or who'd blocked you) by name -- the exact same leak the search box had, just reached
// from a different screen. Fixed by filtering each entry against isBlocked(fid, viewerId), same
// bidirectional rule as everywhere else: the entry simply isn't in the list, no error, same as a
// blocked search result just not turning up.
// Run:  npm test
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';

const PORT = process.env.TEST_PORT_OCT1BLOCKLIST || 4986;
const B = `http://localhost:${PORT}`;
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('oct1blocklist');
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
const DIR = mkdtempSync(join(tmpdir(), 'oct1blocklist-'));
await boot(DIR);

async function api(path, method, token, body) {
  const r = await fetch(B + path, { method, headers: { ...J, ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
}
const post = (p, b, tok) => api(p, 'POST', tok, b).then(r => r.body);
const get = (p, tok) => api(p, 'GET', tok).then(r => r.body);
const reg = (u) => post('/api/register', { username: u, pin: 'pass1234', displayName: u });
const connect = async (a, b) => { await post('/api/follow/' + b.user.id, {}, a.token); await post('/api/follow-requests/' + a.user.id + '/accept', {}, b.token); };

console.log('A blocked co-follower of a third party is hidden from that third party\'s followers/following lists, both directions');
{
  // host is a public figure everyone follows -- alice, bob, and carol are all genuinely connected
  // to host, and host to them, so canSeeProfile(host, viewer) is never the thing under test here.
  const host = await reg('oct1bl_host');
  const alice = await reg('oct1bl_alice');
  const bob = await reg('oct1bl_bob');
  const carol = await reg('oct1bl_carol');
  await connect(alice, host);
  await connect(bob, host);
  await connect(carol, host);

  const beforeFollowers = await get('/api/profile/' + host.user.id + '/followers', alice.token);
  ok(beforeFollowers.some(u => u.id === bob.user.id) && beforeFollowers.some(u => u.id === carol.user.id), 'sanity: alice sees bob and carol in host\'s followers list before any block');
  const beforeFollowing = await get('/api/profile/' + alice.user.id + '/following', bob.token);
  ok(beforeFollowing.some(u => u.id === host.user.id), 'sanity: bob sees host in alice\'s following list before any block');

  // alice blocks bob -- a totally separate relationship from either of their ties to host.
  await post('/api/block/' + bob.user.id, {}, alice.token);

  const afterFollowers = await get('/api/profile/' + host.user.id + '/followers', alice.token);
  ok(!afterFollowers.some(u => u.id === bob.user.id), 'alice browsing HOST\'s followers list no longer sees bob -- same as a search result just not turning up');
  ok(afterFollowers.some(u => u.id === carol.user.id), 'carol, uninvolved in the block, is completely unaffected and still shows');

  const fromBobsSide = await get('/api/profile/' + host.user.id + '/followers', bob.token);
  ok(!fromBobsSide.some(u => u.id === alice.user.id), 'the block is bidirectional -- bob browsing the SAME list no longer sees alice either, same as Instagram');

  const stillFollowing = await get('/api/profile/' + alice.user.id + '/following', carol.token);
  ok(stillFollowing.some(u => u.id === host.user.id), 'sanity: an uninvolved viewer (carol) still sees everything normally -- this is not a global change to the list, only to the two blocked parties\' own view of it');
}

console.log('\nscope check: the profile owner themselves is unaffected by a block between two people IN their list -- canSeeProfile\'s own gate is untouched');
{
  const host2 = await reg('oct1bl_host2');
  const alice2 = await reg('oct1bl_alice2');
  const bob2 = await reg('oct1bl_bob2');
  await connect(alice2, host2);
  await connect(bob2, host2);
  await post('/api/block/' + bob2.user.id, {}, alice2.token);

  const hostOwnView = await get('/api/profile/' + host2.user.id + '/followers', host2.token);
  ok(hostOwnView.some(u => u.id === alice2.user.id) && hostOwnView.some(u => u.id === bob2.user.id), 'host, who is blocked with neither alice2 nor bob2, still sees both of them in their own followers list');
}

console.log('\nregression check: an ordinary followers/following lookup between people who never blocked anyone is completely unaffected');
{
  const host3 = await reg('oct1bl_host3');
  const alice3 = await reg('oct1bl_alice3');
  await connect(alice3, host3);
  const list = await get('/api/profile/' + host3.user.id + '/followers', alice3.token);
  ok(list.some(u => u.id === alice3.user.id), 'an ordinary followers list still shows everyone normally when no block is involved');
}

srv.kill();
await testDb.drop();
console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
