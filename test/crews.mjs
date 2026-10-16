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
// Direct access to db.js's own functions, from this test process -- a second, independent
// connection to the SAME database the spawned server uses (its own DATABASE_URL is set
// explicitly in boot()'s env below, so this assignment only affects this process, not the
// child). Used by the pgCompleteCrewChallengeIfNotAlready concurrency test further down.
process.env.DATABASE_URL = testDb.url;
const db = await import('../db.js');

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
// Oct 16 2026 (crews deep-dive, decision #1 -- messages/challenges moved to their own tables):
// this used to read/rewrite the WHOLE crews.data blob (challenges lived embedded inside it). Now
// challenges are their own one-row-per-challenge table, so this operates on crew_challenges
// directly instead -- same stop/patch/reboot shape, just against the new table.
async function withCrewChallengesDb(mutator) {
  await stop();
  const pg = new PgConnection(parseConnString(testDb.url));
  const r = await pg.query('SELECT id, data FROM crew_challenges');
  const rows = r.rows.map(row => ({ id: row.id, data: JSON.parse(row.data) }));
  await mutator(rows);
  for (const row of rows) await pg.query('UPDATE crew_challenges SET data = $1::jsonb WHERE id = $2', [JSON.stringify(row.data), row.id]);
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

console.log('\na message can only be edited/deleted through the crew it actually belongs to, not through some OTHER crew the caller happens to belong to');
{
  // Oct 16 2026 (adversarial review finding, SEVERE, reproduced live). The first version of
  // pgUpdateCrewMessageText/pgDeleteCrewMessage scoped ownership on userId alone, with no crew_id
  // in the WHERE clause -- the ROUTE checks isCrewMember() against the crew id in the URL, but the
  // db.js call underneath never checked that the message actually belongs to THAT crew. Since a
  // user's own message id is stable and guessable-in-practice (it's returned straight back to
  // them by POST), this let someone edit/delete their own message via ANY crew they currently
  // belong to -- including one that has nothing to do with where the message actually lives, or
  // one they're still in after having been removed from the crew the message is really in.
  const owner = await reg('scopeowner1'), pal = await reg('scopepal1');
  await connect(owner, pal);
  const crewA = await post(owner, '/api/crews', { name: 'Crew A', memberIds: [pal.id] }).then(x => x.json());
  const crewB = await post(owner, '/api/crews', { name: 'Crew B', memberIds: [pal.id] }).then(x => x.json());
  const m = await post(pal, `/api/crews/${crewA.id}/messages`, { text: 'posted in crew A' }).then(x => x.json());
  ok(m.id, 'pal posted a message in crew A');

  const wrongCrewEdit = await put(pal, `/api/crews/${crewB.id}/messages/${m.id}`, { text: 'sneaked in via crew B' });
  ok(wrongCrewEdit.status === 404, `editing crew A's message through crew B's URL 404s (not forbidden-but-silently-allowed), got ${wrongCrewEdit.status}`);
  const stillOriginal = await get(owner, `/api/crews/${crewA.id}/messages`);
  const stillThere = stillOriginal.find(x => x.id === m.id);
  ok(stillThere && stillThere.text === 'posted in crew A' && !stillThere.editedAt, 'the message in crew A is completely untouched by the cross-crew edit attempt');

  const wrongCrewDelete = await del(pal, `/api/crews/${crewB.id}/messages/${m.id}`);
  ok(wrongCrewDelete.status === 404, `deleting crew A's message through crew B's URL 404s too, got ${wrongCrewDelete.status}`);
  const stillThere2 = await get(owner, `/api/crews/${crewA.id}/messages`);
  ok(stillThere2.some(x => x.id === m.id), 'the message in crew A survives the cross-crew delete attempt');

  // The real same-crew edit/delete still work, same as every other test in this file already
  // covers -- this isn't locking pal out of their own message, just out of reaching it from the
  // wrong crew.
  const realEdit = await put(pal, `/api/crews/${crewA.id}/messages/${m.id}`, { text: 'edited through the right crew' });
  ok(realEdit.status === 200, `editing through the ACTUAL crew the message is in still works, got ${realEdit.status}`);
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

console.log('\nmembership is deduped, and an over-the-cap request is REJECTED, never silently truncated');
{
  // Sep 24 2026 audit round 4 (low finding, cold-review of round 3): this used to silently
  // `.slice(0, 19)` an over-the-cap memberIds list with no error at all -- unlike every other cap
  // in this codebase, which returns an explicit 400. At a full crew, adding one more member could
  // silently drop an arbitrary EXISTING member (order-dependent) instead of rejecting the add.
  // Updated to assert the new, correct behavior: over-cap is a real error, and dedup still applies
  // when a request is genuinely within the cap but repeats ids.
  const owner = await reg('crewowner7');
  const pals = [];
  for (let i = 0; i < 25; i++) pals.push(await reg('crewbig' + i + '7'));
  for (const p of pals) await connect(owner, p);
  const ids = pals.map(p => p.id);
  const overCap = await post(owner, '/api/crews', { name: 'Huge', memberIds: [...ids, ...ids] }).then(x => x.json());
  ok(overCap.error && /limit/i.test(overCap.error), `25 unique members (owner + 25 = 26, over the 20-member cap) is refused with a real error, not silently truncated (got ${JSON.stringify(overCap)})`);

  const atCapIds = ids.slice(0, 19);
  const c = await post(owner, '/api/crews', { name: 'Just Right', memberIds: [...atCapIds, ...atCapIds] }).then(x => x.json());
  ok(c.members.length === 20, `exactly at the cap (owner + 19) still works, deduped from a doubled list (got ${c.members && c.members.length})`);
  const unique = new Set(c.members.map(m => m.id));
  ok(unique.size === c.members.length, 'no duplicate members even though the request repeated every id twice');
}

console.log('\nediting a crew never duplicates the owner, even if their own id is resubmitted in memberIds');
{
  // Sep 24 2026 cold-review catch (round 4 audit): validCrewMemberIds() gained an
  // existingMemberIds param so an already-member stays valid even after unfollowing. But
  // existingMemberIds (passed as c.memberIds) always includes the owner's own id, so without
  // excluding ownerId explicitly, a direct PUT that resubmits the owner's own id in memberIds
  // could slip it past the filter and get it duplicated into c.memberIds (every call site does
  // [req.userId, ...validCrewMemberIds(...)] with no dedup of its own) -- doubling the owner's
  // roster row and PR-challenge credit, and possibly tripping the member cap for a legitimately-
  // sized crew. Not reachable via the shipped client (which filters the owner out of its own
  // picker state), but reachable by anyone calling the API directly as the owner.
  const owner = await reg('crewowner8'), pal = await reg('crewpal8');
  await connect(owner, pal);
  const c = await post(owner, '/api/crews', { name: 'Self Resubmit', memberIds: [pal.id] }).then(x => x.json());

  const edited = await put(owner, `/api/crews/${c.id}`, { memberIds: [pal.id, owner.id] }).then(x => x.json());
  const ownerCount = edited.members.filter(m => m.id === owner.id).length;
  ok(ownerCount === 1, `the owner appears exactly once even after resubmitting their own id in memberIds (got ${ownerCount})`);
  ok(edited.members.length === 2, `member count stays correct, not inflated by a phantom owner duplicate (got ${edited.members.length})`);
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

console.log('\ncrew challenges: marking one complete cannot double-fire under real concurrency -- exactly one of many simultaneous attempts wins');
{
  // Oct 16 2026 (correctness/concurrency review finding, SEVERE, reproduced live). Before this
  // fix, checkChallengeCompletion's "is it already complete?" check (runningChallenge, now async
  // to reach Postgres) and its completedAt WRITE were two SEPARATE enqueue()'d Postgres calls --
  // two near-simultaneous triggers (two members finishing qualifying workouts within milliseconds
  // of each other, both routed through checkCrewChallenges) could each run their own SELECT before
  // either one's UPDATE landed, both see "not yet completed," and both go on to celebrate: two
  // system messages, doubled notifications, two challenge_completed feed events. Fixed the same
  // way pgInsertCrewChallengeIfNoneRunning already closes the equivalent race for challenge-START:
  // pgCompleteCrewChallengeIfNotAlready does the "not already completed" check and the write as
  // ONE atomic statement. Proven directly against db.js's own function (the actual mechanism the
  // fix lives in) under real concurrency, same technique as the custom-exercise cap race
  // regression test -- many genuinely concurrent attempts to complete the SAME challenge, and
  // exactly one of them must win.
  const owner = await reg('racechalowner1'), pal = await reg('racechalpal1');
  await connect(owner, pal);
  const c = await post(owner, '/api/crews', { name: 'Completion Race', memberIds: [pal.id] }).then(x => x.json());
  const started = await post(owner, `/api/crews/${c.id}/challenge`, { type: 'workouts', target: 50 }).then(x => x.json());
  const chId = started.challenge.id;
  ok(!started.challenge.completed, 'sanity: freshly started, not already complete');

  const completedAt = new Date().toISOString();
  const results = await Promise.all(Array.from({ length: 10 }, () => db.pgCompleteCrewChallengeIfNotAlready(chId, c.id, completedAt)));
  const winners = results.filter(r => r !== null);
  ok(winners.length === 1, `exactly one of 10 genuinely concurrent completion attempts on the same challenge wins, got ${winners.length}`);

  const retry = await db.pgCompleteCrewChallengeIfNotAlready(chId, c.id, new Date().toISOString());
  ok(retry === null, 'and a later attempt on the already-completed challenge correctly no-ops instead of re-completing it');
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
  await withCrewChallengesDb(async rows => {
    const row = rows.find(r => r.data.crewId === c.id);
    const ch = row.data;
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

console.log('\ncrew challenges: the "volume" type normalizes kg into lb before summing (CLAUDE.md rule 6: units)');
{
  const owner = await reg('chalowner9'), pal = await reg('chalpal9');
  await connect(owner, pal);
  await post(pal, '/api/me/units', { units: 'kg' });
  const c = await post(owner, '/api/crews', { name: 'Volume Types', memberIds: [pal.id] }).then(x => x.json());
  await post(owner, `/api/crews/${c.id}/challenge`, { type: 'volume', target: 100000 });

  await logWorkout(owner, 1);   // 135 lb x 8 reps, logged in owner's own unit (lb) = 1080 lb
  await logWorkout(pal, 1);     // 135 x 8 reps, logged in pal's unit (kg) -> toLb(135,'kg')*8 rounds to 2381 lb

  const view = await get(owner, `/api/crews/${c.id}`);
  const board = view.challenge.leaderboard;
  const ownerCount = board.find(m => m.id === owner.id).count;
  const palCount = board.find(m => m.id === pal.id).count;
  ok(ownerCount === 1080, `owner's lb-logged volume counts at face value (got ${ownerCount})`);
  ok(palCount === 2381, `pal's kg-logged volume is converted to lb before summing, not counted as raw kg (got ${palCount})`);
  ok(view.challenge.total === ownerCount + palCount, `shared total is the sum of both already-normalized contributions (got ${view.challenge.total})`);
}

console.log('\ncrew challenges: the "prs" type counts only genuinely-earned PRs, never a first-ever-logged baseline (CLAUDE.md rule 6: PRs)');
{
  const owner = await reg('chalowner10'), pal = await reg('chalpal10');
  await connect(owner, pal);
  const c = await post(owner, '/api/crews', { name: 'PR Types', memberIds: [pal.id] }).then(x => x.json());
  await post(owner, `/api/crews/${c.id}/challenge`, { type: 'prs', target: 10 });

  // owner: two logs on the SAME exercise -- the first is just a baseline (firstLog), the second,
  // heavier one is a genuine improvement and should be the only thing counted.
  const os = await post(owner, '/api/sessions', { name: 'Session', exercises: [{ name: 'Deadlift', defaultReps: 5 }], inviteUsernames: [], visibility: 'private' }).then(x => x.json());
  await post(owner, `/api/sessions/${os.id}/log`, { exerciseId: os.exercises[0].id, weight: 225, reps: 5 });
  await post(owner, `/api/sessions/${os.id}/log`, { exerciseId: os.exercises[0].id, weight: 275, reps: 5 });
  await post(owner, `/api/sessions/${os.id}/lock`, {});

  // pal: ONE log on a brand-new exercise -- a baseline only, never actually beat anything, so it
  // must not count even though it's technically "their current PR" on their own profile.
  const ps = await post(pal, '/api/sessions', { name: 'Session', exercises: [{ name: 'Overhead Press', defaultReps: 5 }], inviteUsernames: [], visibility: 'private' }).then(x => x.json());
  await post(pal, `/api/sessions/${ps.id}/log`, { exerciseId: ps.exercises[0].id, weight: 95, reps: 5 });
  await post(pal, `/api/sessions/${ps.id}/lock`, {});

  const view = await get(owner, `/api/crews/${c.id}`);
  const board = view.challenge.leaderboard;
  ok(board.find(m => m.id === owner.id).count === 1, `owner's genuine improvement (225 -> 275) counts once (got ${board.find(m => m.id === owner.id).count})`);
  ok(board.find(m => m.id === pal.id).count === 0, `pal's first-ever-logged baseline does not count as an earned PR (got ${board.find(m => m.id === pal.id).count})`);
  ok(view.challenge.total === 1, `shared total reflects only the one genuinely-earned PR (got ${view.challenge.total})`);
}

console.log('\ncrew challenges: "custom" goals require a title, track no number, and only surface posts the viewer may see');
{
  const owner = await reg('chalowner11'), pal = await reg('chalpal11'), outsider = await reg('chaloutsider11');
  await connect(owner, pal);
  const c = await post(owner, '/api/crews', { name: 'Custom Types', memberIds: [pal.id] }).then(x => x.json());

  const blankTitle = await post(owner, `/api/crews/${c.id}/challenge`, { type: 'custom', title: '  ' });
  ok(blankTitle.status === 400, `a blank/whitespace-only custom title is rejected (got ${blankTitle.status})`);

  const started = await post(owner, `/api/crews/${c.id}/challenge`, { type: 'custom', title: 'No skipping leg day' }).then(x => x.json());
  ok(started.challenge && started.challenge.type === 'custom' && started.challenge.title === 'No skipping leg day', 'custom challenge started with the given title');
  ok(started.challenge.target === undefined && started.challenge.total === undefined, 'a custom goal has no numeric target/total to track');
  ok(Array.isArray(started.challenge.posts) && started.challenge.posts.length === 0, 'no posted workouts yet');

  // owner posts a PRIVATE recap -- session participants see it, but pal (a crew member who was
  // never in that session) is not a participant, so the crew's shared visibility rule must not
  // leak it to them just because they're in the same crew (canSeePostAuthor, unchanged by this
  // feature -- membership in the crew is not membership in the session).
  const s1 = await post(owner, '/api/sessions', { name: 'Leg Day', exercises: [{ name: 'Back Squat', defaultReps: 8 }], inviteUsernames: [], visibility: 'private' }).then(x => x.json());
  await post(owner, `/api/sessions/${s1.id}/log`, { exerciseId: s1.exercises[0].id, weight: 225, reps: 5 });
  await post(owner, `/api/sessions/${s1.id}/lock`, {});
  await post(owner, `/api/sessions/${s1.id}/post`, { notes: 'crushed it', visibility: 'private' });

  const ownerView = await get(owner, `/api/crews/${c.id}`);
  ok(ownerView.challenge.posts.some(p => p.sessionId === s1.id && p.authorId === owner.id), 'the author always sees their own posted workout in the feed');

  const palView = await get(pal, `/api/crews/${c.id}`);
  ok(!palView.challenge.posts.some(p => p.sessionId === s1.id), 'a crew member who is not a session participant does NOT see a private posted workout, just for sharing a crew');

  const outsiderBlocked = await get(outsider, `/api/crews/${c.id}`);
  ok(outsiderBlocked.error === 'forbidden', 'a non-crew-member cannot see any of this at all');

  // Same recap, made PUBLIC -- now everyone who can see the crew's challenge should see it.
  await post(owner, `/api/sessions/${s1.id}/post`, { notes: 'crushed it', visibility: 'public' });
  const palViewAfterPublic = await get(pal, `/api/crews/${c.id}`);
  ok(palViewAfterPublic.challenge.posts.some(p => p.sessionId === s1.id && p.authorId === owner.id), 'once the recap is made public, a fellow crew member sees it in the goal\'s posted-workouts feed');

  // A custom goal never auto-completes (no target exists to hit) -- confirmed here rather than
  // just trusted, since checkChallengeCompletion's short-circuit is exactly the kind of "nothing
  // visibly breaks, it just silently never fires" logic that deserves its own assertion.
  ok(palViewAfterPublic.challenge.completed === false, 'a custom goal never marks itself complete, no matter what gets posted');
}

console.log('\ncrew challenges: canceling one is a single atomic delete, and the feed-event cleanup is best-effort');
{
  // Oct 16 2026 (crews deep-dive, decision #1 -- messages/challenges moved to their own tables).
  // This test used to rely on withCrewLock + a revert-on-failure around TWO awaited calls (an
  // optional feed-event delete, then save(DB)) -- a rigged feed_events failure used to 500 the
  // whole cancel (see the git history for that version's own writeup). Now pgDeleteCrewChallenge
  // is the one atomic statement that actually cancels a challenge, and the feed-event cleanup
  // after it is explicitly best-effort (caught and logged, never re-thrown -- see server.js's own
  // comment on this route). Two different failure points now behave two different ways, both
  // asserted here: breaking feed_events must NOT fail the cancel at all (the challenge is already
  // genuinely gone); breaking crew_challenges itself must fail it cleanly, with the challenge left
  // exactly as it was (nothing to revert -- the delete simply never happened). Same
  // breakTable/fixTable technique as test/mutate-before-save-ordering-regression.mjs: a second,
  // independent raw connection to the SAME database the spawned server uses.
  const owner = await reg('cancelowner1'), pal = await reg('cancelpal1');
  await connect(owner, pal);
  const c = await post(owner, '/api/crews', { name: 'Cancel Test', memberIds: [pal.id] }).then(x => x.json());
  const raw = new PgConnection(parseConnString(testDb.url));
  const breakT = name => raw.query(`ALTER TABLE ${name} RENAME TO ${name}_broken_for_test`);
  const fixT = name => raw.query(`ALTER TABLE ${name}_broken_for_test RENAME TO ${name}`);

  console.log('  feed_events broken: cancel still succeeds (best-effort cleanup, not part of the cancel\'s atomicity)');
  {
    const started = await post(owner, `/api/crews/${c.id}/challenge`, { type: 'workouts', target: 5 }).then(x => x.json());
    ok(started.challenge && started.challenge.id, 'challenge started');
    await breakT('feed_events');
    const cancelled = await del(owner, `/api/crews/${c.id}/challenge/${started.challenge.id}`);
    ok(cancelled.status === 200, `cancel succeeds even though its feed-event cleanup can't run, got ${cancelled.status}`);
    await fixT('feed_events');
    const after = await get(owner, `/api/crews/${c.id}`);
    ok(after.challenge === null, 'and the challenge really is canceled, not left running because of the unrelated feed_events failure');
  }

  console.log('  crew_challenges broken: cancel fails cleanly, challenge left exactly as it was');
  {
    const started = await post(owner, `/api/crews/${c.id}/challenge`, { type: 'workouts', target: 5 }).then(x => x.json());
    ok(started.challenge && started.challenge.id, 'a fresh challenge started');
    await breakT('crew_challenges');
    const failed = await del(owner, `/api/crews/${c.id}/challenge/${started.challenge.id}`);
    ok(failed.status === 500, `cancel returns a real error while crew_challenges is broken, got ${failed.status}`);
    await fixT('crew_challenges');

    const health = await get(owner, '/healthz');
    ok(health.ok === true, 'server is still up after the rigged cancel failure, not crashed');

    const afterFail = await get(owner, `/api/crews/${c.id}`);
    ok(afterFail.challenge && afterFail.challenge.id === started.challenge.id && afterFail.challenge.completed === false,
      `the "failed" cancel never actually took effect -- the atomic delete simply never ran, so there was nothing to revert; the challenge is still shown as running, got ${JSON.stringify(afterFail.challenge)}`);

    // Not just a lucky in-memory echo that would vanish on restart -- prove it by actually
    // canceling the SAME challenge for real now that the table is fixed.
    const real = await del(owner, `/api/crews/${c.id}/challenge/${started.challenge.id}`);
    ok(real.status === 200, `with the table fixed, the SAME challenge can now actually be canceled, got ${real.status}`);
    const afterReal = await get(owner, `/api/crews/${c.id}`);
    ok(afterReal.challenge === null, 'and now it really is gone');
  }

  raw.close();
}

console.log('\nPUT /api/crews/:id: concurrent membership edits are fully serialized -- each response reflects exactly what IT persisted, never a borrowed read of the other request\'s overwrite');
{
  // Oct 16 2026 (crews deep-dive audit, Jeff: "find any additional [bugs] like you have and fix
  // them" -- found and reproduced live, then fixed via withCrewLock -- see server.js's own
  // comment on PUT /api/crews/:id / withCrewLock). PUT here is a full-roster REPLACE, not an
  // additive patch (see validCrewMemberIds) -- so this test does NOT claim both concurrent
  // additions survive together; whichever request's critical section runs second always fully
  // overwrites the first's addition, and that part is unchanged, inherent to this endpoint's
  // contract, not something a per-crew lock can or should fix. What WAS actually broken, and is
  // what this locks in: the memberIds assignment and the final res.json used to be separated by
  // real awaited Postgres calls (the per-new-member emitFeedEvent loop, then save(DB)) -- long
  // enough for a genuinely concurrent second request to run its OWN assignment against the same
  // shared crew object in between, so the first request's res.json (reading that live, shared
  // object at response time) could echo the SECOND request's roster instead of the one it itself
  // had just set. Reproduced live before the fix: one request's own 200 body showed a roster it
  // never asked for.
  const owner = await reg('raceowner1');
  const existing = [];
  for (let i = 0; i < 3; i++) {
    const f = await reg(`racefriend${i}1`);
    await connect(owner, f);
    existing.push(f);
  }
  const friendA = await reg('racefrienda1'), friendB = await reg('racefriendb1');
  await connect(owner, friendA);
  await connect(owner, friendB);
  const baseIds = existing.map(f => f.id);
  const c = await post(owner, '/api/crews', { name: 'Race Test', memberIds: baseIds }).then(x => x.json());
  ok(c.members.length === existing.length + 1, `sanity: crew starts with owner + ${existing.length} friends (got ${c.members.length})`);

  const [ra, rb] = await Promise.all([
    put(owner, `/api/crews/${c.id}`, { memberIds: [...baseIds, friendA.id] }),
    put(owner, `/api/crews/${c.id}`, { memberIds: [...baseIds, friendB.id] }),
  ]);
  ok(ra.status === 200 && rb.status === 200, `both concurrent PUTs succeed, got ${ra.status}/${rb.status}`);
  const [bodyA, bodyB] = await Promise.all([ra.json(), rb.json()]);

  const idSet = body => new Set(body.members.map(m => m.id));
  const eq = (s1, s2) => s1.size === s2.size && [...s1].every(x => s2.has(x));
  const wantA = new Set([owner.id, ...baseIds, friendA.id]);
  const wantB = new Set([owner.id, ...baseIds, friendB.id]);
  ok(eq(idSet(bodyA), wantA), `request A's own response shows exactly what A itself set, never borrowed from B's edit (got ${JSON.stringify([...idSet(bodyA)])})`);
  ok(eq(idSet(bodyB), wantB), `request B's own response shows exactly what B itself set, never borrowed from A's edit (got ${JSON.stringify([...idSet(bodyB)])})`);

  const final = await get(owner, `/api/crews/${c.id}`);
  const idsFinal = idSet(final);
  ok(eq(idsFinal, wantA) || eq(idsFinal, wantB), `the final persisted roster matches exactly ONE of the two requests' own full state -- whichever genuinely ran last -- never a mix of both and never something neither request asked for (got ${JSON.stringify([...idsFinal])})`);
}

console.log('\ncrews: the other 6 crew-editing actions fail cleanly on a save/insert failure too, not just cancel covered above');
{
  // Oct 16 2026 (crews deep-dive part 2, Jeff: "find any additional [bugs]... and fix them" --
  // widening withCrewLock to every crew-editing action, decision #2 of the crews pre-mortem).
  // Mapping out the actual migration turned up the SAME mutate-before-maybe-failing-save hazard
  // already fixed once for challenge-cancel, independently, in all 6 of the remaining
  // crew-mutating routes -- each one mutated the live, shared crew object before an awaited
  // save(DB) that can fail. Reproduced live BEFORE fixing (a throwaway script, not kept as a
  // permanent test, broke the relevant table for each of the 6 and confirmed the stranded
  // in-memory state); this locked in the fix the same way, one block per route, same
  // breakTable/fixTable technique as test/mutate-before-save-ordering-regression.mjs.
  //
  // Oct 16 2026, same day (decision #1 -- messages/challenges moved to their own tables): the 4
  // message/challenge-start sub-blocks below no longer go through withCrewLock + revert at all --
  // each one is now a single atomic Postgres statement (pgInsertCrewMessage,
  // pgUpdateCrewMessageText, pgDeleteCrewMessage, pgInsertCrewChallengeIfNoneRunning), so the
  // table that actually has to be broken to force their failure changed from `crews` to
  // `crew_messages`/`crew_challenges` -- breaking `crews` alone no longer touches these 4 routes
  // at all, since nothing they do reads or writes the crews table any more. The outward behavior
  // asserted is the same as before (a clean 500, no phantom change) -- only which table is broken,
  // and why there's nothing left to "revert" (the atomic statement simply never ran), changed.
  // POST /:id/leave and DELETE /api/crews/:id are UNCHANGED by this migration (still mutate
  // c.memberIds / DB.crews directly) and still correctly break `crews`.
  const owner = await reg('revertowner1'), pal = await reg('revertpal1');
  await connect(owner, pal);
  const c = await post(owner, '/api/crews', { name: 'Revert Test', memberIds: [pal.id] }).then(x => x.json());
  const raw = new PgConnection(parseConnString(testDb.url));
  const breakT = name => raw.query(`ALTER TABLE ${name} RENAME TO ${name}_broken_for_test`);
  const fixT = name => raw.query(`ALTER TABLE ${name}_broken_for_test RENAME TO ${name}`);

  console.log('  POST /:id/messages');
  {
    await breakT('crew_messages');
    const r = await post(pal, `/api/crews/${c.id}/messages`, { text: 'ghost message' });
    ok(r.status === 500, `returns a real error while crew_messages is broken, got ${r.status}`);
    await fixT('crew_messages');
    const msgs = await get(owner, `/api/crews/${c.id}/messages`);
    ok(msgs.length === 0, `the "failed" post never actually took effect -- the insert simply never ran, no phantom message, got ${JSON.stringify(msgs)}`);
  }

  console.log('  PUT /:id/messages/:messageId');
  {
    const posted = await post(pal, `/api/crews/${c.id}/messages`, { text: 'original text' }).then(x => x.json());
    await breakT('crew_messages');
    const r = await put(pal, `/api/crews/${c.id}/messages/${posted.id}`, { text: 'EDITED ghost text' });
    ok(r.status === 500, `returns a real error while crew_messages is broken, got ${r.status}`);
    await fixT('crew_messages');
    const msgs = await get(owner, `/api/crews/${c.id}/messages`);
    const m = msgs.find(x => x.id === posted.id);
    ok(m && m.text === 'original text' && !m.editedAt, `the "failed" edit never actually took effect -- the atomic UPDATE simply never ran, text/editedAt still original, got ${JSON.stringify(m)}`);
  }

  console.log('  DELETE /:id/messages/:messageId');
  {
    const posted = await post(pal, `/api/crews/${c.id}/messages`, { text: 'to be ghost-deleted' }).then(x => x.json());
    await breakT('crew_messages');
    const r = await del(pal, `/api/crews/${c.id}/messages/${posted.id}`);
    ok(r.status === 500, `returns a real error while crew_messages is broken, got ${r.status}`);
    await fixT('crew_messages');
    const msgs = await get(owner, `/api/crews/${c.id}/messages`);
    ok(msgs.some(x => x.id === posted.id), `the "failed" delete never actually took effect -- message is still there, got ${JSON.stringify(msgs.map(x => x.id))}`);
  }

  console.log('  POST /:id/leave');
  {
    await breakT('crews');
    const r = await post(pal, `/api/crews/${c.id}/leave`);
    ok(r.status === 500, `returns a real error while crews is broken, got ${r.status}`);
    await fixT('crews');
    const view = await get(owner, `/api/crews/${c.id}`);
    ok(view.members.some(m => m.id === pal.id), `the "failed" leave never actually took effect -- pal is still a member, got ${JSON.stringify(view.members.map(m => m.id))}`);
  }

  console.log('  POST /:id/challenge (start)');
  {
    await breakT('crew_challenges');
    const r = await post(owner, `/api/crews/${c.id}/challenge`, { type: 'workouts', target: 5 });
    ok(r.status === 500, `returns a real error while crew_challenges is broken, got ${r.status}`);
    await fixT('crew_challenges');
    const view = await get(owner, `/api/crews/${c.id}`);
    ok(view.challenge === null, `the "failed" challenge-start never actually took effect -- the atomic check-then-insert simply never ran, no challenge running, got ${JSON.stringify(view.challenge)}`);
    // Confirm it's genuinely still startable, not left in some half-stranded state.
    const real = await post(owner, `/api/crews/${c.id}/challenge`, { type: 'workouts', target: 5 });
    ok(real.status === 200, `with the table fixed, a challenge can now actually be started, got ${real.status}`);
  }

  console.log('  DELETE /api/crews/:id');
  {
    await breakT('crews');
    const r = await del(owner, `/api/crews/${c.id}`);
    ok(r.status === 500, `returns a real error while crews is broken, got ${r.status}`);
    await fixT('crews');
    const view = await get(owner, `/api/crews/${c.id}`);
    ok(view.id === c.id, `the "failed" delete never actually took effect -- the crew is still there, got ${JSON.stringify(view.id)}`);
  }

  raw.close();
  const health = await get(owner, '/healthz');
  ok(health.ok === true, 'server is still up after all 6 rigged failures');
}

} finally {
  await stop();
  await testDb.drop();
}
console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
