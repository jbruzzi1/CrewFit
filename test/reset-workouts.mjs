// Jeff, Aug 21: "Can you delete all of my workouts and history to let me start over?" — POST
// /api/me/reset-workouts. Scoped to req.userId ONLY (never a body param, so it can never be
// pointed at anyone else). Account/login/username/friends survive untouched — Jeff's own explicit
// choice when asked. For workouts he created where a friend also has real credit, this hands
// ownership off (same mechanic Leave already uses) rather than deleting a friend's earned history
// out from under them.
//
// Ported to the Postgres-backed test harness (Aug 2026 data-layer migration) — the original
// version predates that migration and read data.json directly off disk for its assertions; those
// reads now go through readDb() (a direct Postgres SELECT) instead. Nothing about the reset
// assertions themselves changed.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';
import { PgConnection, parseConnString } from '../pgmini.js';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const J = { 'Content-Type': 'application/json' };
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('reset');

function boot(port, dir) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; srv.stdout.on('data', d => { out += d; if (String(d).includes('CrewFit on')) res({ srv, out }); });
    srv.on('exit', () => res({ srv: null, out }));
    setTimeout(() => res({ srv, out }), 15000);
  });
}
// Direct-Postgres equivalent of the old `JSON.parse(readFileSync(join(DIR, 'data.json'), 'utf8'))`
// — returns the same `{ sessions: { id: data } }` shape every assertion below already expects.
async function readDb(url) {
  const pg = new PgConnection(parseConnString(url));
  const r = await pg.query('SELECT id, data FROM sessions');
  pg.close();
  const sessions = {};
  for (const row of r.rows) sessions[row.id] = JSON.parse(row.data);
  return { sessions };
}

const DIR = mkdtempSync(join(tmpdir(), 'reset-'));
const PORT = 4993, B = `http://localhost:${PORT}`;
const { srv } = await boot(PORT, DIR);
ok(!!srv, 'server boots');

const post = (p, b, tok) => fetch(B + p, { method: 'POST', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b) }).then(r => r.json());
const postRaw = (p, b, tok) => fetch(B + p, { method: 'POST', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b) });
const get = (p, tok) => fetch(B + p, { headers: tok ? { Authorization: 'Bearer ' + tok } : {} });
const reg = (username, pin, displayName) => post('/api/register', { username, pin, displayName });

const jeff = await reg('reset_jeff', 'pass1234', 'Jeff');
const brian = await reg('reset_brian', 'pass1234', 'Brian');
await post('/api/follow/' + brian.user.id, {}, jeff.token);
await post('/api/follow-requests/' + jeff.user.id + '/accept', {}, brian.token);
await post('/api/follow/' + jeff.user.id, {}, brian.token);
await post('/api/follow-requests/' + brian.user.id + '/accept', {}, jeff.token);

console.log('\nguard rails: no confirm, no auth');
{
  const noAuth = await postRaw('/api/me/reset-workouts', { confirm: true });
  ok(noAuth.status === 401 || noAuth.status === 403, `no token is rejected (got ${noAuth.status})`);
  const noConfirm = await postRaw('/api/me/reset-workouts', {}, jeff.token);
  ok(noConfirm.status === 400, `missing confirm:true is rejected, not silently treated as yes (got ${noConfirm.status})`);
  // A body carrying someone else's id must be ignored outright — this route only ever touches the
  // caller's own token identity.
  const spoofed = await post('/api/me/reset-workouts', { confirm: true, userId: brian.user.id }, jeff.token);
  ok(spoofed.ok === true, 'a spoofed userId in the body does not error — it is just ignored');
}

console.log("\na solo workout with nobody else's credit is deleted outright — nothing left for anyone to lose");
{
  const solo = await post('/api/sessions', {
    name: 'Leg Day', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Back Squat' }],
    inviteUsernames: [], visibility: 'private',
  }, jeff.token);
  const exId = solo.exercises[0].id;
  await post('/api/sessions/' + solo.id + '/log', { exerciseId: exId, weight: 225, reps: 5 }, jeff.token);
  await post('/api/sessions/' + solo.id + '/lock', {}, jeff.token);

  const r = await post('/api/me/reset-workouts', { confirm: true }, jeff.token);
  ok(r.ok === true, 'resets ok');
  ok(r.sessionsDeleted === 1, `the solo session was hard-deleted (got ${r.sessionsDeleted})`);
  const db = await readDb(testDb.url);
  ok(!db.sessions[solo.id], 'and is genuinely gone from the database, not just hidden');
}

console.log('\na workout Jeff CREATED where Brian also logged real sets is handed off, not deleted — Brian keeps his credit');
{
  const shared = await post('/api/sessions', {
    name: 'Push Day', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Bench Press' }],
    inviteUsernames: ['reset_brian'], visibility: 'private',
  }, jeff.token);
  await post('/api/sessions/' + shared.id + '/accept', {}, brian.token);
  const exId = shared.exercises[0].id;
  await post('/api/sessions/' + shared.id + '/log', { exerciseId: exId, weight: 185, reps: 6 }, jeff.token);
  await post('/api/sessions/' + shared.id + '/log', { exerciseId: exId, weight: 135, reps: 8 }, brian.token);
  await post('/api/sessions/' + shared.id + '/lock', {}, jeff.token);
  await post('/api/sessions/' + shared.id + '/lock', {}, brian.token);

  const r = await post('/api/me/reset-workouts', { confirm: true }, jeff.token);
  ok(r.sessionsHandedOff >= 1, `at least one session was handed off, not deleted (got ${r.sessionsHandedOff})`);

  const db = await readDb(testDb.url);
  const s = db.sessions[shared.id];
  ok(!!s, "Brian's workout still exists");
  ok(s.creatorId === brian.user.id, 'ownership passed to Brian, the one remaining real participant');
  ok((s.history || []).some(h => h.userId === brian.user.id), "Brian's own credit is untouched");
  ok(!(s.history || []).some(h => h.userId === jeff.user.id), "Jeff's credit is gone from it");
  ok(!(s.participants || []).includes(jeff.user.id), 'Jeff is off the participant list');
  ok((s.logs && s.logs[brian.user.id] && s.logs[brian.user.id].length) > 0, "Brian's actual logged sets (185x6... 135x8) are untouched");
  ok(!s.logs || !s.logs[jeff.user.id], "Jeff's own logs are gone");

  const brianCanEdit = await fetch(B + '/api/sessions/' + shared.id, {
    method: 'PUT', headers: { ...J, Authorization: 'Bearer ' + brian.token },
    body: JSON.stringify({ name: 'Push Day (renamed)' }),
  });
  ok(brianCanEdit.status === 200, 'Brian, the new owner, can edit the workout that is now his');
}

console.log("\na workout Jeff only JOINED (Brian's, not his) is left completely alone for Brian — reset only strips Jeff's own trace");
{
  const briansSession = await post('/api/sessions', {
    name: 'Pull Day', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Deadlift' }],
    inviteUsernames: ['reset_jeff'], visibility: 'private',
  }, brian.token);
  await post('/api/sessions/' + briansSession.id + '/accept', {}, jeff.token);
  const exId = briansSession.exercises[0].id;
  await post('/api/sessions/' + briansSession.id + '/log', { exerciseId: exId, weight: 315, reps: 3 }, brian.token);
  await post('/api/sessions/' + briansSession.id + '/log', { exerciseId: exId, weight: 225, reps: 5 }, jeff.token);
  await post('/api/sessions/' + briansSession.id + '/lock', {}, brian.token);
  await post('/api/sessions/' + briansSession.id + '/lock', {}, jeff.token);

  await post('/api/me/reset-workouts', { confirm: true }, jeff.token);

  const db = await readDb(testDb.url);
  const s = db.sessions[briansSession.id];
  ok(!!s, "Brian's own workout is untouched, still exists");
  ok(s.creatorId === brian.user.id, 'Brian is still the creator — nothing to hand off, he never lost ownership');
  ok((s.history || []).some(h => h.userId === brian.user.id), "Brian's credit is fully intact");
  ok(!(s.participants || []).includes(jeff.user.id), 'Jeff is off the participant list');
  ok(!(s.history || []).some(h => h.userId === jeff.user.id), "Jeff's own credit for it is gone");
}

console.log('\na session Jeff already LEFT earlier (alumni-only credit, no live participation) is also cleared — reset reaches history-only rows too, not just live participation');
{
  const oldSession = await post('/api/sessions', {
    name: 'Arm Day', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Bicep Curl' }],
    inviteUsernames: ['reset_jeff'], visibility: 'private',
  }, brian.token);
  await post('/api/sessions/' + oldSession.id + '/accept', {}, jeff.token);
  const exId = oldSession.exercises[0].id;
  await post('/api/sessions/' + oldSession.id + '/log', { exerciseId: exId, weight: 30, reps: 12 }, jeff.token);
  await post('/api/sessions/' + oldSession.id + '/leave', { keep: true }, jeff.token);

  // confirm the alumni-tier fix actually applies here first (sanity on the fixture)
  const beforeReset = await get('/api/sessions/' + oldSession.id, jeff.token);
  ok(beforeReset.status === 200, 'sanity: alumni tier lets Jeff see this before reset (got ' + beforeReset.status + ')');

  await post('/api/me/reset-workouts', { confirm: true }, jeff.token);

  const afterReset = await get('/api/sessions/' + oldSession.id, jeff.token);
  ok(afterReset.status === 403, `after reset, Jeff has no history row left here either — back to a genuine stranger (got ${afterReset.status})`);
  const db = await readDb(testDb.url);
  ok(!!db.sessions[oldSession.id], "Brian's session itself still exists — Jeff was never its creator");
}

console.log('\nwhen MULTIPLE friends have current credit in a workout Jeff created, the inheritance is deterministic — the same rule /leave already uses, not a coin flip');
{
  const carla = await reg('reset_carla', 'pass1234', 'Carla');
  await post('/api/follow/' + carla.user.id, {}, jeff.token);
  await post('/api/follow-requests/' + jeff.user.id + '/accept', {}, carla.token);
  await post('/api/follow/' + jeff.user.id, {}, carla.token);
  await post('/api/follow-requests/' + carla.user.id + '/accept', {}, jeff.token);

  const trio = await post('/api/sessions', {
    name: 'Squad Day', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Front Squat' }],
    inviteUsernames: ['reset_brian', 'reset_carla'], visibility: 'private',
  }, jeff.token);
  await post('/api/sessions/' + trio.id + '/accept', {}, brian.token);
  await post('/api/sessions/' + trio.id + '/accept', {}, carla.token);
  const exId = trio.exercises[0].id;
  await post('/api/sessions/' + trio.id + '/log', { exerciseId: exId, weight: 245, reps: 5 }, jeff.token);
  await post('/api/sessions/' + trio.id + '/log', { exerciseId: exId, weight: 185, reps: 6 }, brian.token);
  await post('/api/sessions/' + trio.id + '/log', { exerciseId: exId, weight: 155, reps: 8 }, carla.token);

  await post('/api/me/reset-workouts', { confirm: true }, jeff.token);

  const db = await readDb(testDb.url);
  const s = db.sessions[trio.id];
  ok(!!s, 'the workout survives — two other people have real credit in it');
  ok(s.creatorId === brian.user.id || s.creatorId === carla.user.id,
     `ownership landed on one of the two people who actually still have logs, not on Jeff or nobody (got ${s.creatorId})`);
  ok((s.logs[brian.user.id] || []).length > 0 && (s.logs[carla.user.id] || []).length > 0,
     "both Brian's AND Carla's sets survive untouched regardless of who inherited it");
  ok(!s.logs[jeff.user.id], "Jeff's own sets are gone");
}

console.log('\ncreator + the ONLY other credit is a departed (non-current) history row, nobody current to hand it to — creatorId goes null, same as /leave would do in this exact situation');
{
  const ghost = await post('/api/sessions', {
    name: 'Ghost Day', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Hack Squat' }],
    inviteUsernames: ['reset_brian'], visibility: 'private',
  }, jeff.token);
  await post('/api/sessions/' + ghost.id + '/accept', {}, brian.token);
  const exId = ghost.exercises[0].id;
  // Brian logs, then leaves with credit — so he's a HISTORY-only row, not a current participant,
  // by the time Jeff resets.
  await post('/api/sessions/' + ghost.id + '/log', { exerciseId: exId, weight: 90, reps: 10 }, brian.token);
  await post('/api/sessions/' + ghost.id + '/leave', { keep: true }, brian.token);
  await post('/api/sessions/' + ghost.id + '/log', { exerciseId: exId, weight: 65, reps: 12 }, jeff.token);

  await post('/api/me/reset-workouts', { confirm: true }, jeff.token);

  const db = await readDb(testDb.url);
  const s = db.sessions[ghost.id];
  ok(!!s, "Brian's departed-but-credited history row blocked a hard-delete — the session survives");
  ok(s.creatorId === null, `nobody CURRENT to inherit it (Brian already left), so creatorId goes null, exactly like /leave (got ${s.creatorId})`);
  ok((s.history || []).some(h => h.userId === brian.user.id), "Brian's preserved credit from before he left is still intact");
  ok(!(s.history || []).some(h => h.userId === jeff.user.id), "Jeff's own credit for it is gone");
}

console.log("\nv249 (audit finding): a discard-leave-then-reset used to leave a stale recap behind — isTouched only checked participants/invited/history, never s.posts[me]/s.logs[me], so a session where Jeff had posted a recap and then discard-left (no participants, no invited, no history left on it at all) read as 'not touched' and reset-workouts skipped it entirely, leaving that old recap fully visible to Brian even after Jeff asked to erase everything he'd logged");
{
  const dan = await reg('reset_dan', 'pass1234', 'DanHost');
  await post('/api/follow/' + dan.user.id, {}, jeff.token);
  await post('/api/follow-requests/' + jeff.user.id + '/accept', {}, dan.token);
  await post('/api/follow/' + jeff.user.id, {}, dan.token);
  await post('/api/follow-requests/' + dan.user.id + '/accept', {}, jeff.token);

  const s = await post('/api/sessions', {
    name: 'Stale Recap Day', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Lat Pulldown' }],
    inviteUsernames: ['reset_jeff'], visibility: 'private',
  }, dan.token);
  await post('/api/sessions/' + s.id + '/accept', {}, jeff.token);
  const exId = s.exercises[0].id;
  await post('/api/sessions/' + s.id + '/log', { exerciseId: exId, weight: 120, reps: 10 }, jeff.token);
  const posted = await post('/api/sessions/' + s.id + '/post', { notes: 'quick pump', visibility: 'public', media: [] }, jeff.token);
  ok(!posted.error, `Jeff posts a recap while still a participant, as always (got ${posted.error})`);
  const left = await post('/api/sessions/' + s.id + '/leave', { keep: false }, jeff.token);
  ok(!!left.left, `Jeff discard-leaves — no credit kept, no history added (got ${JSON.stringify(left)})`);

  const before = await readDb(testDb.url);
  const sBefore = before.sessions[s.id];
  ok(!(sBefore.participants || []).includes(jeff.user.id), 'sanity: Jeff is off participants after the discard-leave');
  ok(!(sBefore.history || []).some(h => h.userId === jeff.user.id), 'sanity: no history row exists — discard never called creditFinish');
  ok(!!(sBefore.posts && sBefore.posts[jeff.user.id]), "sanity: the recap Jeff posted BEFORE leaving is still sitting on the session — this is the exact gap");

  const r = await post('/api/me/reset-workouts', { confirm: true }, jeff.token);
  ok(r.ok === true, 'reset runs ok');
  ok(r.sessionsCleared === 1, `the session with only a stale recap and no other trace is still recognized as touched and cleared (got ${r.sessionsCleared})`);

  const after = await readDb(testDb.url);
  const sAfter = after.sessions[s.id];
  ok(!!sAfter, "Dan's session itself still exists — Jeff was never its creator");
  ok(!(sAfter.posts && sAfter.posts[jeff.user.id]), "the stale recap is genuinely gone after reset, not left behind for Dan to keep seeing");
  ok(!(sAfter.logs && sAfter.logs[jeff.user.id]), "and there is nothing left in logs for Jeff either");
}

console.log("\naccount identity survives completely untouched — only what Jeff LOGGED is gone");
{
  const meBefore = await get('/api/profile/' + jeff.user.id, jeff.token).then(r => r.json());
  ok(meBefore.username === 'reset_jeff', 'username unchanged');
  ok(meBefore.workoutsCompleted === 0, 'workout count is genuinely zero after all the resets above');
  const friendsList = await get('/api/friends', jeff.token).then(r => r.json());
  ok((friendsList.friends || []).some(f => f.username === 'reset_brian'), 'Jeff and Brian are still friends — reset never touched that relationship');
  const prog = await get('/api/progress?weeks=13', jeff.token).then(r => r.json());
  ok(Array.isArray(prog.prs) && prog.prs.length === 0, 'personal records list is empty (got ' + prog.prs.length + ')');
}

try { srv && srv.kill(); } catch {}
rmSync(DIR, { recursive: true, force: true });
await testDb.drop();

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
