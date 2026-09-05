// Crews (Sep 2026, Jeff: "make the collaboration side stronger"). Everything else collaborative
// in this app is either 1:1 (a connection) or scoped to one workout (invited/participants) -- a
// crew is the missing standing group: name it once, invite the whole thing to a workout in one
// tap (client-side pre-check, not tested here -- see app.js), and talk in one thread that
// outlives any single workout. This file locks in the server-side rules:
//   - a crew can only be built from people you're already connected to (connectionsOf) -- never a
//     way to add a stranger to a group thread
//   - the owner is always a member too (no separate owner-list to keep in sync)
//   - only members can read/post the crew's messages; only the owner can rename/edit membership/
//     delete; a non-owner can leave, the owner can't (must delete instead, since a crew with no
//     owner has nobody left who could rename it or edit who's in it)
//
// Run:  npm test
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';

const PORT = process.env.TEST_PORT || 4934;
const B = `http://localhost:${PORT}`;
const DIR = mkdtempSync(join(tmpdir(), 'crewfit-test-crews-'));
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('crews');
let fails = 0, srv = null;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const J = { 'Content-Type': 'application/json' };

function boot() {
  return new Promise((res, rej) => {
    srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: DIR, DATABASE_URL: testDb.url, PORT: String(PORT) },
      cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    srv.stderr.on('data', d => { err += d; });
    srv.stdout.on('data', d => { if (String(d).includes('CrewFit on')) res(); });
    srv.on('exit', c => rej(new Error(`server exited (${c}):\n${err}`)));
    setTimeout(() => rej(new Error('server never started:\n' + err)), 15000);
  });
}
const stop = () => new Promise(r => { if (!srv) return r(); srv.on('exit', r); srv.kill(); });

async function reg(n) {
  const r = await fetch(B + '/api/register', { method: 'POST', headers: J,
    body: JSON.stringify({ username: n, pin: 'pass1234', displayName: n }) }).then(x => x.json());
  if (!r.token) throw new Error('register failed: ' + JSON.stringify(r));
  return { id: r.user.id, token: r.token, H: { ...J, Authorization: 'Bearer ' + r.token } };
}
const get = (who, p) => fetch(B + p, { headers: who.H }).then(r => r.json());
const post = (who, p, body) => fetch(B + p, { method: 'POST', headers: who.H, body: JSON.stringify(body || {}) });
const put = (who, p, body) => fetch(B + p, { method: 'PUT', headers: who.H, body: JSON.stringify(body || {}) });
const del = (who, p) => fetch(B + p, { method: 'DELETE', headers: who.H });
// Profiles default public (Sep 2026) -- one-directional follow auto-approves, and connectionsOf()
// unions followers+following on BOTH sides, so this alone makes owner and friend mutually
// "connected" without needing an explicit accept step.
const connect = (owner, friend) => post(owner, `/api/follow/${friend.id}`);

await boot();
try {

console.log('a crew can only be built from real connections');
{
  const owner = await reg('crewowner1'), pal = await reg('crewpal1'), stranger = await reg('crewstranger1');
  await connect(owner, pal);
  const r = await post(owner, '/api/crews', { name: 'Leg Day', memberIds: [pal.id, stranger.id] }).then(x => x.json());
  ok(r.id, 'crew created');
  ok(r.name === 'Leg Day', 'name saved');
  ok(r.ownerId === owner.id && r.isOwner === true, 'creator is the owner');
  const memberIds = r.members.map(m => m.id);
  ok(memberIds.includes(owner.id), 'owner is a member of their own crew');
  ok(memberIds.includes(pal.id), 'a real connection made it in');
  ok(!memberIds.includes(stranger.id), 'a non-connection was silently dropped, not added');
  ok(r.members.length === 2, `exactly owner + pal (got ${r.members.length})`);
}

console.log('\nempty name is rejected');
{
  const owner = await reg('crewowner2');
  const res = await post(owner, '/api/crews', { name: '   ', memberIds: [] });
  ok(res.status === 400, `empty name rejected (got ${res.status})`);
}

console.log('\nGET /api/crews lists only crews you belong to');
{
  const owner = await reg('crewowner3'), pal = await reg('crewpal3'), outsider = await reg('crewoutsider3');
  await connect(owner, pal);
  const c = await post(owner, '/api/crews', { name: 'Push Day', memberIds: [pal.id] }).then(x => x.json());
  const ownerList = await get(owner, '/api/crews');
  ok(ownerList.some(x => x.id === c.id), 'owner sees it in their list');
  const palList = await get(pal, '/api/crews');
  ok(palList.some(x => x.id === c.id), 'a member (not the owner) sees it too');
  const outsiderList = await get(outsider, '/api/crews');
  ok(!outsiderList.some(x => x.id === c.id), 'someone outside the crew does not see it at all');
  const outsiderGet = await get(outsider, `/api/crews/${c.id}`);
  ok(outsiderGet.error === 'forbidden', 'and a direct fetch by id is forbidden, not just hidden from the list');
}

console.log('\nonly members can read or post crew messages; posting is visible to other members');
{
  const owner = await reg('crewowner4'), pal = await reg('crewpal4'), outsider = await reg('crewoutsider4');
  await connect(owner, pal);
  const c = await post(owner, '/api/crews', { name: 'Pull Day', memberIds: [pal.id] }).then(x => x.json());

  const blocked = await get(outsider, `/api/crews/${c.id}/messages`);
  ok(blocked.error === 'forbidden', 'a non-member cannot read the thread');
  const blockedPost = await post(outsider, `/api/crews/${c.id}/messages`, { text: 'hi' });
  ok(blockedPost.status === 403, `a non-member cannot post into it either (got ${blockedPost.status})`);

  const m = await post(owner, `/api/crews/${c.id}/messages`, { text: 'leg day friday, who is in' }).then(x => x.json());
  ok(m.id && m.userId === owner.id, 'the owner can post');
  const seenByPal = await get(pal, `/api/crews/${c.id}/messages`);
  ok(seenByPal.some(x => x.id === m.id), 'a plain member sees the owner\'s message');

  const empty = await post(pal, `/api/crews/${c.id}/messages`, { text: '   ' });
  ok(empty.status === 400, `whitespace-only text is rejected (got ${empty.status})`);
}

console.log('\nonly the owner can rename the crew or edit its membership');
{
  const owner = await reg('crewowner5'), pal = await reg('crewpal5'), newFriend = await reg('crewnewfriend5');
  await connect(owner, pal); await connect(owner, newFriend);
  const c = await post(owner, '/api/crews', { name: 'Original', memberIds: [pal.id] }).then(x => x.json());

  const deniedRename = await put(pal, `/api/crews/${c.id}`, { name: 'Hijacked' });
  ok(deniedRename.status === 403, `a non-owner member cannot rename it (got ${deniedRename.status})`);

  const renamed = await put(owner, `/api/crews/${c.id}`, { name: 'Renamed' }).then(x => x.json());
  ok(renamed.name === 'Renamed', 'the owner can rename it');

  const edited = await put(owner, `/api/crews/${c.id}`, { memberIds: [newFriend.id] }).then(x => x.json());
  const editedIds = edited.members.map(m => m.id);
  ok(editedIds.includes(owner.id), 'owner stays a member no matter what memberIds is set to');
  ok(editedIds.includes(newFriend.id) && !editedIds.includes(pal.id), 'membership fully replaced (pal out, newFriend in)');
}

console.log('\nleaving vs. deleting: a member can leave, the owner cannot (must delete instead)');
{
  const owner = await reg('crewowner6'), pal = await reg('crewpal6');
  await connect(owner, pal);
  const c = await post(owner, '/api/crews', { name: 'Squad', memberIds: [pal.id] }).then(x => x.json());

  const ownerLeave = await post(owner, `/api/crews/${c.id}/leave`, {});
  ok(ownerLeave.status === 400, `the owner cannot leave their own crew (got ${ownerLeave.status})`);

  const palLeave = await post(pal, `/api/crews/${c.id}/leave`, {});
  ok(palLeave.status === 200, 'a plain member can leave');
  const afterLeave = await get(owner, `/api/crews/${c.id}`);
  ok(!afterLeave.members.some(m => m.id === pal.id), 'they are actually gone from the member list');
  const palsView = await get(pal, `/api/crews/${c.id}`);
  ok(palsView.error === 'forbidden', 'and can no longer see the crew at all once they have left');

  const deniedDelete = await del(pal, `/api/crews/${c.id}`);
  // pal already left, so this also exercises "not a member anymore" -> still correctly forbidden,
  // not merely "not the owner" -- either reason is fine, the point is pal can never delete it.
  ok(deniedDelete.status === 403, `a non-owner cannot delete the crew (got ${deniedDelete.status})`);

  const ownerDelete = await del(owner, `/api/crews/${c.id}`);
  ok(ownerDelete.status === 200, 'the owner can delete it');
  const gone = await get(owner, `/api/crews/${c.id}`);
  ok(gone.error === 'not found', 'and it is actually gone afterward');
}

console.log('\nmembership is deduped and capped, never silently duplicated or unbounded');
{
  const owner = await reg('crewowner7');
  const pals = [];
  for (let i = 0; i < 25; i++) pals.push(await reg('crewbig' + i + '7'));
  for (const p of pals) await connect(owner, p);
  const ids = pals.map(p => p.id);
  const c = await post(owner, '/api/crews', { name: 'Huge', memberIds: [...ids, ...ids] }).then(x => x.json());
  ok(c.members.length <= 20, `capped at a sane crew size, not 26 (got ${c.members.length})`);
  const unique = new Set(c.members.map(m => m.id));
  ok(unique.size === c.members.length, 'no duplicate members even though the request repeated every id twice');
}

} finally {
  await stop();
  await testDb.drop();
}
console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
