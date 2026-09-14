// Sep 14 2026 (Jeff, crew/notification follow-up): a first pass at "blocking someone should end
// your crew relationship with them" got reverted the same day -- Jeff realized removing a blocked
// pair from a shared crew makes the OWNER notice a member is missing and start asking why, which
// is exactly the awkwardness blocking exists to avoid, not create. His actual ask: "leave them in
// the crew... maybe the people blocked can still see messages from the blocker or vice versa - but
// don't have access to their profile or anything." This test proves the final shape: membership,
// chat, and crew notifications are completely untouched by blocking (nothing about the crew looks
// different to anyone), a blocked pair's crew-roster streak figure is hidden from each other only
// ("I'd say strip"), and their actual profiles were ALREADY limited by the pre-existing, app-wide
// canSeeProfile()/isBlocked() gate -- no new code needed for that part, just confirmed here. Real
// server, real Postgres.
import { mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';

const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('blockstreak');
const PORT = 4953, BASE = `http://localhost:${PORT}`;
const J = { 'Content-Type': 'application/json' };
const post = (p, b, tok) => fetch(BASE + p, { method: 'POST', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b) }).then(r => r.json());
const put = (p, b, tok) => fetch(BASE + p, { method: 'PUT', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b) }).then(r => r.json());
const get = (p, tok) => fetch(BASE + p, { headers: tok ? { Authorization: 'Bearer ' + tok } : {} }).then(r => r.json());

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };

const DIR = mkdtempSync(join(tmpdir(), 'blockstreak-'));
const srv = await new Promise(res => {
  const p = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: DIR, DATABASE_URL: testDb.url, PORT: String(PORT) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stderr.on('data', d => process.stderr.write(String(d)));
  p.stdout.on('data', d => { if (String(d).includes('CrewFit on')) res(p); });
  setTimeout(() => res(null), 15000);
});
if (!srv) { console.log('FAIL boot'); process.exit(1); }
async function cleanup() { try { srv.kill(); } catch {} try { rmSync(DIR, { recursive: true, force: true }); } catch {} try { await testDb.drop(); } catch {} }
process.on('uncaughtException', async (e) => { console.error('UNCAUGHT', e); await cleanup(); process.exit(1); });
process.on('unhandledRejection', async (e) => { console.error('UNHANDLED', e); await cleanup(); process.exit(1); });

const rand = Math.floor(Math.random() * 90000) + 10000;
const alice = await post('/api/register', { username: `bsp_a_${rand}`, pin: 'pass1234', displayName: 'Alice' });
const bob = await post('/api/register', { username: `bsp_b_${rand}`, pin: 'pass1234', displayName: 'Bob' });
const carol = await post('/api/register', { username: `bsp_c_${rand}`, pin: 'pass1234', displayName: 'Carol' });

await post('/api/follow/' + bob.user.id, {}, alice.token);
await post('/api/follow/' + carol.user.id, {}, alice.token);

// Give Bob a real streak (a working set today, then /lock -- that's what actually credits a
// streak, per test/local-streak.mjs's own pattern; /post alone does not) so a hidden-vs-shown
// streak is an actual, visible difference, not two zeros that would pass by coincidence.
{
  const s = await post('/api/sessions', { exercises: [{ name: 'Bench Press' }] }, bob.token);
  await post(`/api/sessions/${s.id}/log`, { exerciseId: s.exercises[0].id, weight: 135, reps: 8, setType: 'normal' }, bob.token);
  await post(`/api/sessions/${s.id}/lock`, {}, bob.token);
}

const crew = await post('/api/crews', { name: 'Push Day Crew', memberIds: [bob.user.id, carol.user.id] }, alice.token);

console.log('\n1) Alice blocks Bob -- crew membership, chat, and notifications are all untouched');
{
  const blockRes = await post('/api/block/' + bob.user.id, {}, alice.token);
  ok(blockRes.ok === true, 'block succeeds, got ' + JSON.stringify(blockRes));

  const crewAsAlice = await get('/api/crews/' + crew.id, alice.token);
  ok(crewAsAlice.members.some(m => m.id === bob.user.id), 'Bob is STILL in the roster Alice sees');
  const crewAsCarol = await get('/api/crews/' + crew.id, carol.token);
  ok(crewAsCarol.members.some(m => m.id === bob.user.id) && crewAsCarol.members.some(m => m.id === alice.user.id), 'both are still in the roster Carol (uninvolved) sees -- nothing looks different to a bystander');

  const renameRes = await put('/api/crews/' + crew.id, { name: 'Renamed Crew' }, alice.token);
  ok(!renameRes.error, 'Alice can still rename the crew, got ' + JSON.stringify(renameRes.error || 'ok'));
  const bobNotifs = await get('/api/notifications', bob.token);
  ok(bobNotifs.history.some(h => h.body && h.body.includes('renamed the crew')), 'Bob (blocked) STILL gets the normal rename notification -- nothing suppressed');

  const msgRes = await post('/api/crews/' + crew.id + '/messages', { text: 'hey team' }, alice.token);
  ok(!msgRes.error, 'Alice can still post in the shared chat, got ' + JSON.stringify(msgRes.error || 'ok'));
  const bobNotifs2 = await get('/api/notifications', bob.token);
  ok(bobNotifs2.history.some(h => h.body && h.body.includes('commented in')), 'Bob still gets the normal chat notification too');
  const bobMessages = await get('/api/crews/' + crew.id + '/messages', bob.token);
  ok(bobMessages.some(m => m.text === 'hey team'), 'Bob can still read the message itself in the shared thread');
}

console.log('\n2) The crew roster hides Bob\'s streak from Alice specifically, but not from Carol');
{
  const crewAsAlice = await get('/api/crews/' + crew.id, alice.token);
  const bobRowForAlice = crewAsAlice.members.find(m => m.id === bob.user.id);
  ok(bobRowForAlice.streak === null, `Bob's streak is hidden (null) in the roster Alice sees, got ${JSON.stringify(bobRowForAlice.streak)}`);

  const crewAsCarol = await get('/api/crews/' + crew.id, carol.token);
  const bobRowForCarol = crewAsCarol.members.find(m => m.id === bob.user.id);
  ok(typeof bobRowForCarol.streak === 'number' && bobRowForCarol.streak > 0, `Bob's real streak still shows normally to Carol (uninvolved), got ${JSON.stringify(bobRowForCarol.streak)}`);

  // Symmetric -- Bob viewing the SAME roster also can't see Alice's streak (isBlocked is
  // direction-agnostic), even though Bob isn't the one who blocked.
  const crewAsBob = await get('/api/crews/' + crew.id, bob.token);
  const aliceRowForBob = crewAsBob.members.find(m => m.id === alice.user.id);
  ok(aliceRowForBob.streak === null, `Alice's streak is hidden from Bob too (block is mutual), got ${JSON.stringify(aliceRowForBob.streak)}`);
}

console.log('\n3) Actual profile detail (PRs/streak/activity) was already blocked-aware app-wide, before any of this -- confirmed, not newly built');
{
  const bobProfileForAlice = await get('/api/profile/' + bob.user.id, alice.token);
  const bobProfileForCarol = await get('/api/profile/' + bob.user.id, carol.token);
  ok(!bobProfileForAlice.streak && !(bobProfileForAlice.prs||[]).length, `Alice (blocked) gets no streak/PRs on Bob's actual profile page, got streak=${bobProfileForAlice.streak} prs=${JSON.stringify(bobProfileForAlice.prs)}`);
  ok(typeof bobProfileForCarol.streak === 'number', `Carol (uninvolved) still sees Bob's real profile detail normally, got streak=${bobProfileForCarol.streak}`);
}

console.log('\n4) Unblocking brings the streak back -- isBlocked() reads live arrays, no caching');
{
  const unblockRes = await post('/api/unblock/' + bob.user.id, {}, alice.token);
  ok(unblockRes.ok === true, 'unblock succeeds, got ' + JSON.stringify(unblockRes));

  const crewAsAlice = await get('/api/crews/' + crew.id, alice.token);
  const bobRowForAlice = crewAsAlice.members.find(m => m.id === bob.user.id);
  ok(typeof bobRowForAlice.streak === 'number' && bobRowForAlice.streak > 0, `Bob's streak reappears for Alice after unblock, got ${JSON.stringify(bobRowForAlice.streak)}`);
}

console.log(`\n${fails === 0 ? 'all assertions passed' : fails + ' assertion(s) FAILED'}`);
await cleanup();
process.exit(fails === 0 ? 0 : 1);
