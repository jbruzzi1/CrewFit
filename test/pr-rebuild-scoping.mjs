// Oct 12 2026 (scaling fix, Jeff: "it seems we should fix this now"): rebuildAllPrs() used to
// replay EVERY log across EVERY session for EVERY user on nearly every workout action -- measured
// live, this made logging a single set get slower for EVERYONE as the app's total history grew,
// not just the one person logging it. The fix (see rebuildPrsFor's own comment in server.js)
// scopes 6 high-frequency, single-user (or, for /lock, single-SESSION) routes to a NEW
// rebuildPrsFor(userIds) that only touches the targeted users' own DB.prs entries, leaving every
// other user's completely alone -- while rebuildAllPrs() itself is unchanged and still used
// everywhere else (renames, session delete, leave/removal pivots, and the full self-healing
// boot-time replay).
//
// The real risk in a change like this is a SILENT one: scope too narrowly anywhere and another
// user's PR record goes stale and never self-corrects, because nothing ever triggers a full
// rebuild for them again. This test's main technique is a DIFFERENTIAL check against ground
// truth: the boot-time rebuildAllPrs() (completely untouched by this fix) is still, by design, a
// full, always-correct replay of literally everything -- so restarting the server against the
// SAME Postgres database and diffing DB.prs before/after the restart is a direct way to ask "did
// the scoped incremental path already converge to exactly what the proven-correct full rebuild
// would have produced?" with no new test-only code needed in server.js.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';
import { PgConnection, parseConnString } from '../pgmini.js';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const J = { 'Content-Type': 'application/json' };
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('prrebuildscope');
const DIR = mkdtempSync(join(tmpdir(), 'pr-rebuild-scoping-'));
const PORT = 4993, B = `http://localhost:${PORT}`;

function boot() {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: DIR, DATABASE_URL: testDb.url, PORT: String(PORT) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; srv.stdout.on('data', d => { out += d; if (String(d).includes('CrewFit on')) res({ srv, out }); });
    srv.on('exit', () => res({ srv: null, out }));
    setTimeout(() => res({ srv, out }), 15000);
  });
}
async function restartServer(prevSrv) {
  await new Promise(res => { prevSrv.once('exit', res); prevSrv.kill(); });
  const { srv } = await boot();
  return srv;
}
async function rawPrs() {
  const pg = new PgConnection(parseConnString(testDb.url));
  const r = await pg.query('SELECT user_id, data FROM prs');
  pg.close();
  const out = {};
  for (const row of r.rows) out[row.user_id] = JSON.parse(row.data);
  return out;
}

let srv = (await boot()).srv;
ok(!!srv, 'server boots');

const post = (p, b, tok) => fetch(B + p, { method: 'POST', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b) }).then(r => r.json());
const put = (p, b, tok) => fetch(B + p, { method: 'PUT', headers: { ...J, Authorization: 'Bearer ' + tok }, body: JSON.stringify(b) }).then(r => r.json());
const del = (p, tok) => fetch(B + p, { method: 'DELETE', headers: { Authorization: 'Bearer ' + tok } }).then(r => r.json());
const reg = (username, pin, displayName) => post('/api/register', { ageConfirmed: true, username, pin, displayName });

try {

const alice = await reg('prscope_alice', 'pass1234', 'Alice');
const bob = await reg('prscope_bob', 'pass1234', 'Bob');
const carol = await reg('prscope_carol', 'pass1234', 'Carol');

console.log('\nsetup: Carol has her own, completely unrelated session/PR history');
const carolSess = await post('/api/sessions', {
  name: 'Carol Solo', scheduledAt: new Date().toISOString(), visibility: 'private',
  exercises: [{ name: 'Deadlift' }],
}, carol.token);
const carolEx = carolSess.exercises[0].id;
await post(`/api/sessions/${carolSess.id}/log`, { exerciseId: carolEx, weight: 315, reps: 3 }, carol.token);
await post(`/api/sessions/${carolSess.id}/log`, { exerciseId: carolEx, weight: 335, reps: 1 }, carol.token);
const carolPrsBefore = (await rawPrs())[carol.user.id];
ok(!!carolPrsBefore && carolPrsBefore['Deadlift'] && carolPrsBefore['Deadlift'].weight === 335,
  `Carol's own PR is recorded correctly before any of Alice/Bob's actions (got ${carolPrsBefore && carolPrsBefore['Deadlift'] && carolPrsBefore['Deadlift'].weight})`);

console.log('\nAlice and Bob share a session; both log on the same exercise (independent PR tracks per user)');
// Cold-review catch (while writing THIS test): inviteUsernames silently no-ops unless the two
// accounts are already CONNECTED (an approved follow either direction -- see connectionsOf() in
// server.js) -- an uninvited username is just dropped, no error. Without this, Bob would never
// actually become a participant and the risk scenario below would pass vacuously. Full mutual
// dance, same as test/limits.mjs's own alice/bob setup.
await post(`/api/follow/${bob.user.id}`, {}, alice.token);
await post(`/api/follow-requests/${alice.user.id}/accept`, {}, bob.token);
await post(`/api/follow/${alice.user.id}`, {}, bob.token);
await post(`/api/follow-requests/${bob.user.id}/accept`, {}, alice.token);
// Cold-review catch (independent subagent review, Oct 12 2026): scheduledAt MUST be within 24h of
// now, not further back -- markSessionStarted's own back-date condition (server.js) is
// `(nowMs - scheduledMs) < 24h`, and the first version of this test used 2 DAYS in the past, which
// is outside that window. That meant Bob's /lock below never actually rewrote the shared
// s.scheduledAt at all, so the "risk scenario" this test claims to prove was passing vacuously --
// confirmed by reproduction: a deliberately-reintroduced [req.userId]-only regression at /lock
// still passed the old version of this test. 1 hour in the past is well inside the 24h window, so
// the backdate genuinely fires.
const originalScheduledAt = new Date(Date.now() - 3600000).toISOString();
const shared = await post('/api/sessions', {
  name: 'Push Day', scheduledAt: originalScheduledAt, visibility: 'private',
  inviteUsernames: ['prscope_bob'], exercises: [{ name: 'Bench Press' }],
}, alice.token);
ok(shared.invited.includes(bob.user.id), `Bob was actually invited (connectionsOf resolved) -- shared.invited=${JSON.stringify(shared.invited)}`);
const acceptRes = await post(`/api/sessions/${shared.id}/accept`, {}, bob.token);
ok(!acceptRes.error, `Bob's accept succeeds (got ${JSON.stringify(acceptRes.error)})`);
const exId = shared.exercises[0].id;
// Alice logs sets but does NOT finish/post -- she has no s.history/s.posts entry for this session
// yet, so her _performedAt falls back to s.scheduledAt (the exact fallback markSessionStarted can
// rewrite -- see rebuildPrsFor's grouping loop and the comment on /lock's scoping in server.js).
const aliceLog1 = await post(`/api/sessions/${shared.id}/log`, { exerciseId: exId, weight: 185, reps: 5 }, alice.token);
const aliceLog2 = await post(`/api/sessions/${shared.id}/log`, { exerciseId: exId, weight: 205, reps: 3 }, alice.token);
const bobLog1 = await post(`/api/sessions/${shared.id}/log`, { exerciseId: exId, weight: 95, reps: 8 }, bob.token);
ok(!aliceLog1.error && !aliceLog2.error && !bobLog1.error,
  `all three setup logs actually succeeded (got ${JSON.stringify([aliceLog1.error, aliceLog2.error, bobLog1.error])})`);

console.log('\nthe risk scenario: Bob finishes (/lock) first -- nobody ever tapped Start, so this can back-date s.scheduledAt for the WHOLE session, which Alice\'s still-pending PR snapshot depends on');
const lockRes = await post(`/api/sessions/${shared.id}/lock`, {}, bob.token);
ok(!lockRes.error, `Bob's /lock succeeds (got ${JSON.stringify(lockRes.error)})`);

// Prove the mechanism this whole scenario depends on ACTUALLY fired -- not just infer it from
// downstream PR timestamps. Without this, a scheduledAt outside markSessionStarted's 24h window
// would make every assertion below pass vacuously (exactly the gap an independent review caught
// in an earlier version of this test, which used 2 DAYS in the past instead of 1 hour).
const afterLockView = await (await fetch(B + `/api/sessions/${shared.id}`, { headers: { Authorization: 'Bearer ' + alice.token } })).json();
ok(afterLockView.scheduledAt !== originalScheduledAt,
  `sanity: Bob's /lock actually rewrote the shared s.scheduledAt (was ${originalScheduledAt}, now ${afterLockView.scheduledAt}) -- if this fails, the scenario below is testing nothing`);

const prsAfterLockScoped = await rawPrs();
const aliceAtScoped = prsAfterLockScoped[alice.user.id] && prsAfterLockScoped[alice.user.id]['Bench Press'] && prsAfterLockScoped[alice.user.id]['Bench Press'].at;
ok(!!aliceAtScoped, `Alice has a PR snapshot timestamp after Bob's /lock (scoped path) (got ${aliceAtScoped})`);
ok(aliceAtScoped !== originalScheduledAt,
  `Alice's PR snapshot reflects the REWRITTEN scheduledAt, not the stale original -- this is the one assertion that would fail if /lock were wrongly scoped to [req.userId] instead of the whole session (got ${aliceAtScoped})`);

console.log('\nground truth: restart the server against the SAME Postgres data -- this runs the untouched, always-correct full boot-time rebuildAllPrs()');
srv = await restartServer(srv);
ok(!!srv, 'server re-boots against the same data');

const prsAfterRebootFull = await rawPrs();
const aliceAtFull = prsAfterRebootFull[alice.user.id] && prsAfterRebootFull[alice.user.id]['Bench Press'] && prsAfterRebootFull[alice.user.id]['Bench Press'].at;
ok(aliceAtScoped === aliceAtFull,
  `Alice's PR snapshot from the SCOPED /lock path exactly matches what the FULL ground-truth rebuild produces -- proves /lock's session-wide scoping (not just [req.userId]) was the right call (scoped=${aliceAtScoped}, full=${aliceAtFull})`);
ok(JSON.stringify(prsAfterLockScoped[alice.user.id]) === JSON.stringify(prsAfterRebootFull[alice.user.id]),
  "Alice's ENTIRE PR record (not just .at) matches the full rebuild byte-for-byte");
ok(JSON.stringify(prsAfterLockScoped[bob.user.id]) === JSON.stringify(prsAfterRebootFull[bob.user.id]),
  "Bob's PR record also matches the full rebuild byte-for-byte");

console.log("\nCarol's unrelated PR data was never touched by any of Alice/Bob's actions, and still matches ground truth");
ok(JSON.stringify(carolPrsBefore) === JSON.stringify(prsAfterLockScoped[carol.user.id]),
  "Carol's PR record is byte-identical to before Alice/Bob did anything -- the scoped routes never touched her entry");
ok(JSON.stringify(carolPrsBefore) === JSON.stringify(prsAfterRebootFull[carol.user.id]),
  "...and still matches ground truth after the full rebuild too (nothing silently diverged)");

console.log('\nediting and deleting a set (scoped to [req.userId]) also converges exactly to ground truth');
const sessionView = await (await fetch(B + `/api/sessions/${shared.id}`, { headers: { Authorization: 'Bearer ' + alice.token } })).json();
const aliceLogId = sessionView.logs[alice.user.id].find(l => l.weight === 205).id;
await put(`/api/sessions/${shared.id}/log/${aliceLogId}`, { weight: 225 }, alice.token);
const afterEditScoped = await rawPrs();
srv = await restartServer(srv);
const afterEditFull = await rawPrs();
ok(JSON.stringify(afterEditScoped[alice.user.id]) === JSON.stringify(afterEditFull[alice.user.id]),
  'editing a set (PUT /log/:logId, scoped to [req.userId]) converges exactly to the full rebuild');
ok(JSON.stringify(afterEditScoped[carol.user.id]) === JSON.stringify(afterEditFull[carol.user.id]),
  "...and Carol's record is still untouched/correct");

const sessionView2 = await (await fetch(B + `/api/sessions/${shared.id}`, { headers: { Authorization: 'Bearer ' + alice.token } })).json();
const aliceLogId2 = sessionView2.logs[alice.user.id].find(l => l.weight === 185).id;
await del(`/api/sessions/${shared.id}/log/${aliceLogId2}`, alice.token);
const afterDeleteScoped = await rawPrs();
srv = await restartServer(srv);
const afterDeleteFull = await rawPrs();
ok(JSON.stringify(afterDeleteScoped[alice.user.id]) === JSON.stringify(afterDeleteFull[alice.user.id]),
  'deleting a set (DELETE /log/:logId, scoped to [req.userId]) converges exactly to the full rebuild -- including Alice\'s weight record correctly falling back to her remaining 225 set');

console.log('\n/post (recap) and /unlock, both scoped to [req.userId], also converge exactly to ground truth');
await post(`/api/sessions/${shared.id}/post`, { visibility: 'private' }, alice.token);
const afterPostScoped = await rawPrs();
srv = await restartServer(srv);
const afterPostFull = await rawPrs();
ok(JSON.stringify(afterPostScoped[alice.user.id]) === JSON.stringify(afterPostFull[alice.user.id]),
  "posting a recap (scoped to [req.userId]) converges exactly to the full rebuild");

await post(`/api/sessions/${shared.id}/unlock`, {}, bob.token);
const afterUnlockScoped = await rawPrs();
srv = await restartServer(srv);
const afterUnlockFull = await rawPrs();
ok(JSON.stringify(afterUnlockScoped[bob.user.id]) === JSON.stringify(afterUnlockFull[bob.user.id]),
  "unlocking (scoped to [req.userId]) converges exactly to the full rebuild");
ok(JSON.stringify(afterUnlockScoped[alice.user.id]) === JSON.stringify(afterUnlockFull[alice.user.id]),
  "...and Alice's own record (a DIFFERENT user in the same session) is untouched and still correct too");

console.log('\nthe actual point: logging a set for ONE user must stay fast no matter how much OTHER, unrelated history exists in the app');
{
  // A smaller, permanent version of the live capacity benchmark that found this bug: seed a
  // chunk of unrelated history for OTHER users, then time a single /log call for someone NOT in
  // that history. If this ever regresses back to an unscoped rebuild, this call's time grows with
  // the unrelated history instead of staying flat.
  const bulk = await reg('prscope_bulk', 'pass1234', 'Bulk');
  for (let i = 0; i < 25; i++) {
    const s = await post('/api/sessions', { name: 'S' + i, scheduledAt: new Date().toISOString(), visibility: 'private', exercises: [{ name: 'Squat' }] }, bulk.token);
    for (let j = 0; j < 8; j++) await post(`/api/sessions/${s.id}/log`, { exerciseId: s.exercises[0].id, weight: 100 + j, reps: 5 }, bulk.token);
  }
  const t0 = Date.now();
  const soloSess = await post('/api/sessions', { name: 'Timing check', scheduledAt: new Date().toISOString(), visibility: 'private', exercises: [{ name: 'Overhead Press' }] }, carol.token);
  await post(`/api/sessions/${soloSess.id}/log`, { exerciseId: soloSess.exercises[0].id, weight: 95, reps: 5 }, carol.token);
  const ms = Date.now() - t0;
  ok(ms < 2000, `logging a set for an UNRELATED user after seeding 200 unrelated logs elsewhere still completes quickly (${ms}ms)`);
}

} finally {
  if (srv) srv.kill();
  await testDb.drop();
}

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
