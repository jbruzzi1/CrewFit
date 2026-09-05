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
import { PgConnection, parseConnString } from '../pgmini.js';

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
// Backdates a challenge directly in Postgres to simulate its 7-day window running out, the same
// stop-the-server / patch-the-jsonb-column / reboot shape test/streak-reminders.mjs uses to backdate
// s.history rows -- the server holds everything in memory and only re-reads from Postgres at boot,
// so there is no in-process way to fake the passage of days.
async function withCrewsDb(mutator) {
  await stop();
  const pg = new PgConnection(parseConnString(testDb.url));
  const r = await pg.query('SELECT id, data FROM crews');
  const rows = r.rows.map(row => ({ id: row.id, data: JSON.parse(row.data) }));
  await mutator(rows);
  for (const row of rows) await pg.query('UPDATE crews SET data = $1::jsonb WHERE id = $2', [JSON.stringify(row.data), row.id]);
  pg.close();
  await boot();
}

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
// Creates a session, logs one working set, and locks it (credits s.history) -- the one real path
// that makes a workout count toward anything (streak, volume, and now a crew challenge). Mirrors
// the same create -> log -> lock shape test/streak-reminders.mjs and _verify_streak_fix.mjs use.
async function logWorkout(who, sets = 1) {
  const s = await post(who, '/api/sessions', { name: 'Session', exercises: [{ name: 'Bench Press', defaultReps: 8 }],
    inviteUsernames: [], visibility: 'private' }).then(x => x.json());
  for (let i = 0; i < sets; i++) {
    await post(who, `/api/sessions/${s.id}/log`, { exerciseId: s.exercises[0].id, weight: 135, reps: 8 });
  }
  await post(who, `/api/sessions/${s.id}/lock`, {});
  return s;
}

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

console.log('\ncrew challenges: only the owner can start one, and only when none is already running');
{
  const owner = await reg('chalowner1'), pal = await reg('chalpal1');
  await connect(owner, pal);
  const c = await post(owner, '/api/crews', { name: 'Challengers', memberIds: [pal.id] }).then(x => x.json());
  ok(c.challenge === null, 'a brand-new crew has no challenge running');

  const deniedStart = await post(pal, `/api/crews/${c.id}/challenge`, { type: 'workouts', target: 5 });
  ok(deniedStart.status === 403, `a non-owner cannot start a challenge (got ${deniedStart.status})`);

  const badTarget = await post(owner, `/api/crews/${c.id}/challenge`, { type: 'workouts', target: 0 });
  ok(badTarget.status === 400, `a zero/blank target is rejected (got ${badTarget.status})`);

  const started = await post(owner, `/api/crews/${c.id}/challenge`, { type: 'workouts', target: 5 }).then(x => x.json());
  ok(started.challenge && started.challenge.target === 5 && started.challenge.type === 'workouts', 'challenge started with the requested type/target');
  ok(started.challenge.total === 0 && started.challenge.completed === false, 'starts at zero progress, not complete');

  const secondAttempt = await post(owner, `/api/crews/${c.id}/challenge`, { type: 'sets', target: 10 });
  ok(secondAttempt.status === 400, `cannot start a second challenge while one is already running (got ${secondAttempt.status})`);
}

console.log('\ncrew challenges: progress is a real shared total, and the leaderboard credits who actually did the work');
{
  const owner = await reg('chalowner2'), pal = await reg('chalpal2'), outsider = await reg('chaloutsider2');
  await connect(owner, pal);
  const c = await post(owner, '/api/crews', { name: 'Volume Crew', memberIds: [pal.id] }).then(x => x.json());
  await post(owner, `/api/crews/${c.id}/challenge`, { type: 'workouts', target: 3 });

  await logWorkout(owner);
  await logWorkout(pal);
  await logWorkout(outsider);   // not a crew member -- must not count toward the shared total

  const view = await get(owner, `/api/crews/${c.id}`);
  ok(view.challenge.total === 2, `only crew members' workouts count (got ${view.challenge.total})`);
  ok(!view.challenge.completed, 'not complete yet -- 2 of 3');
  const board = view.challenge.leaderboard;
  ok(board.length === 2 && board.every(m => m.count === 1), 'both contributors show up on the leaderboard with their own count');
}

console.log('\ncrew challenges: hitting the target marks it complete, posts a celebration message, and frees up a new one');
{
  const owner = await reg('chalowner3'), pal = await reg('chalpal3');
  await connect(owner, pal);
  const c = await post(owner, '/api/crews', { name: 'Finish Line', memberIds: [pal.id] }).then(x => x.json());
  await post(owner, `/api/crews/${c.id}/challenge`, { type: 'workouts', target: 2 });

  await logWorkout(owner);
  let view = await get(owner, `/api/crews/${c.id}`);
  ok(!view.challenge.completed, 'still short after just one workout');

  await logWorkout(pal);
  view = await get(owner, `/api/crews/${c.id}`);
  ok(view.challenge.completed === true, 'marked complete the moment the target is actually hit');
  ok(view.challengesCompleted === 1, 'counted in the crew\'s win history');

  const messages = await get(owner, `/api/crews/${c.id}/messages`);
  const sysMsg = messages.find(m => m.system);
  ok(!!sysMsg, 'a system celebration message was posted into the chat');
  ok(sysMsg && sysMsg.userId == null, 'the celebration message is not attributed to any one person');

  const restart = await post(owner, `/api/crews/${c.id}/challenge`, { type: 'sets', target: 20 });
  ok(restart.status === 200, `a completed challenge does not block starting a new one (got ${restart.status})`);
  const after = await restart.json();
  ok(after.challenge && after.challenge.type === 'sets' && after.challenge.total === 0, 'a fresh challenge starts immediately, at zero, once the previous one is won');
}

console.log('\ncrew challenges: the "sets" type counts working sets, not just finished workouts');
{
  const owner = await reg('chalowner4'), pal = await reg('chalpal4');
  await connect(owner, pal);
  const c = await post(owner, '/api/crews', { name: 'Set Crew', memberIds: [pal.id] }).then(x => x.json());
  await post(owner, `/api/crews/${c.id}/challenge`, { type: 'sets', target: 10 });

  await logWorkout(owner, 4);
  await logWorkout(pal, 3);
  const view = await get(owner, `/api/crews/${c.id}`);
  ok(view.challenge.total === 7, `sums individual working sets across the crew, not workout count (got ${view.challenge.total})`);
}

console.log('\ncrew challenges: a member who leaves drops their share from the total and the leaderboard');
{
  const owner = await reg('chalowner5'), pal = await reg('chalpal5');
  await connect(owner, pal);
  const c = await post(owner, '/api/crews', { name: 'Leavers', memberIds: [pal.id] }).then(x => x.json());
  await post(owner, `/api/crews/${c.id}/challenge`, { type: 'workouts', target: 5 });
  await logWorkout(owner);
  await logWorkout(pal);
  let view = await get(owner, `/api/crews/${c.id}`);
  ok(view.challenge.total === 2, `both contributions counted before anyone leaves (got ${view.challenge.total})`);

  await post(pal, `/api/crews/${c.id}/leave`, {});
  view = await get(owner, `/api/crews/${c.id}`);
  ok(view.challenge.total === 1, `pal's contribution drops out of the shared total once they leave (got ${view.challenge.total})`);
  ok(!view.challenge.leaderboard.some(m => m.id === pal.id), 'and they no longer appear on the leaderboard at all');
}

console.log('\ncrew challenges: a solo (owner-only) crew can still run and win one');
{
  const owner = await reg('chalowner6');
  const c = await post(owner, '/api/crews', { name: 'Solo', memberIds: [] }).then(x => x.json());
  ok(c.members.length === 1, 'just the owner in this crew');
  await post(owner, `/api/crews/${c.id}/challenge`, { type: 'workouts', target: 1 });
  await logWorkout(owner);
  const view = await get(owner, `/api/crews/${c.id}`);
  ok(view.challenge.completed === true, 'a single-member crew can complete a challenge on its own');
  ok(view.challenge.leaderboard.length === 1 && view.challenge.leaderboard[0].count === 1, 'the leaderboard is just them, credited correctly');
}

console.log('\ncrew challenges: adding a member whose own logging already clears the target completes it immediately, not on the next unrelated finish');
{
  const owner = await reg('chalowner7'), pal = await reg('chalpal7'), lateAdd = await reg('challateadd7');
  await connect(owner, pal); await connect(owner, lateAdd);
  const c = await post(owner, '/api/crews', { name: 'Late Add', memberIds: [pal.id] }).then(x => x.json());
  await post(owner, `/api/crews/${c.id}/challenge`, { type: 'workouts', target: 2 });
  await logWorkout(owner);
  let view = await get(owner, `/api/crews/${c.id}`);
  ok(!view.challenge.completed, 'short of target with just the owner\'s workout');

  // lateAdd trains on their own, unrelated to this crew, while the challenge is already running --
  // then gets added to the roster. Their workout falls inside the challenge's window purely by
  // virtue of timing, and joining alone (no new /log call from anyone) has to be what notices the
  // target's actually been cleared (server.js: checkChallengeCompletion called from PUT /api/crews/:id).
  await logWorkout(lateAdd);
  const edited = await put(owner, `/api/crews/${c.id}`, { memberIds: [pal.id, lateAdd.id] }).then(x => x.json());
  ok(edited.challenge.completed === true, `completion is noticed the moment the roster edit itself clears the target (got total=${edited.challenge.total}, completed=${edited.challenge.completed})`);
  const messages = await get(owner, `/api/crews/${c.id}/messages`);
  ok(messages.some(m => m.system), 'the celebration message was posted here too, not only from a workout finish');
}

console.log('\ncrew challenges: a challenge that runs out its full week without hitting the target reopens the door to start a new one');
{
  const owner = await reg('chalowner8'), pal = await reg('chalpal8');
  await connect(owner, pal);
  const c = await post(owner, '/api/crews', { name: 'Missed Week', memberIds: [pal.id] }).then(x => x.json());
  await post(owner, `/api/crews/${c.id}/challenge`, { type: 'workouts', target: 50 }); // unreachable in this test
  await logWorkout(owner);

  const longAgo = new Date(Date.now() - 20 * 86400000).toISOString();
  await withCrewsDb(async rows => {
    const row = rows.find(r => r.data.id === c.id);
    const ch = row.data.challenges[row.data.challenges.length - 1];
    ch.createdAt = longAgo;
    ch.startDate = longAgo.slice(0, 10);
    ch.endDate = new Date(Date.now() - 13 * 86400000).toISOString().slice(0, 10); // ended a week ago
  });

  const view = await get(owner, `/api/crews/${c.id}`);
  ok(view.challenge && view.challenge.completed === false, 'still shown, still not marked complete -- it was genuinely missed');
  ok(view.challenge.expired === true, `server flags it expired once its endDate has passed (got ${JSON.stringify(view.challenge && view.challenge.expired)})`);

  // The whole point of `expired`: runningChallenge() already lets a new one start server-side once
  // the old one is stale, even though lastChallenge() (what `challenge` above reflects) keeps
  // showing it. Before `expired` existed, the client had no way to tell "still running" apart from
  // "over and done," and the UI's Start-CTA branch depended on `challenge` being null -- which it
  // never was again once one had been started (cold-review catch: a missed week was a dead end).
  const restarted = await post(owner, `/api/crews/${c.id}/challenge`, { type: 'workouts', target: 2 });
  ok(restarted.status === 200, `starting a fresh challenge is allowed once the old one has expired (got ${restarted.status})`);
}

} finally {
  await stop();
  await testDb.drop();
}
console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
