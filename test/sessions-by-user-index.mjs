// Oct 12 2026 (scaling fix round 2): sessionsForUser/weeksFor/volumeFor/volumeTrendFor/
// liftHistoryFor/plateausFor/recommendationsFor used to do `for (const s of
// Object.values(DB.sessions))` to find ONE user's own session history -- so loading anyone's
// Progress page scanned literally every session in the app, and measurably got slower as the app
// grew, for everyone, independent of that one user's own data (see the benchmark in this same PR
// description: 3ms at 6 total sessions, 36ms at 5000). Fixed by adding DB.sessionsByUser, a
// derived, in-memory-only index of "which sessions currently have a logs[userId] entry for this
// user," kept correct incrementally at the handful of places a session's logs[userId] key is
// created (POST /log) or removed (the three `delete s.logs[userId]` sites: leave-with-discard,
// remove-mine, stripUserFromSession).
//
// The real risk in a change like this is the same shape as the PR-rebuild-scoping fix: miss an
// incremental update site, and a real session silently disappears from (or never leaves) someone's
// own stats with nothing to ever self-correct it mid-session. This test's main technique is the
// same ground-truth differential check: rebuildSessionsByUserIndex() is a full, by-construction-
// correct scan, run fresh every server restart -- so if the incremental index had drifted from
// what a full scan would produce, restarting the server and re-fetching the exact same stats
// would show a DIFFERENT number. Every scenario below fetches /api/progress, restarts the server
// against the same Postgres database, and asserts the fetched stats are byte-for-byte IDENTICAL
// before and after -- covering the one CREATE site (a missing add is the dangerous direction: a
// real session silently dropped from someone's stats).
//
// Oct 12 2026 (cold-review catch, same day): a differential/output-equality check like the one
// above CANNOT prove the three indexRemoveUserSession call sites (leave-discard/remove-mine/
// stripUserFromSession) are actually wired up, specifically BECAUSE the index is deliberately
// tolerant of a stale (over-inclusive) entry -- every consumer re-checks `s.logs[userId] &&
// s.logs[userId].length` before trusting it, so a MISSING removal call never changes the
// user-visible answer, only how much scan work the index still saves. An independent review
// proved this by commenting out all three removal calls and confirming this test file's
// restart-diff assertions still passed -- a real coverage gap, not just a hypothetical one. Fixed
// by asserting directly against GET /api/admin/scaling's sessionsByUserIndexEntries count (the
// actual size of the index) after each removal scenario, not just against /api/progress's
// derived output -- that number WOULD drop if a removal call fires, and WOULD NOT if it were
// deleted, which is exactly the distinction the differential check alone could not make.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const J = { 'Content-Type': 'application/json' };
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('sessionsbyuser');
const DIR = mkdtempSync(join(tmpdir(), 'sessions-by-user-index-'));
const PORT = 4996, B = `http://localhost:${PORT}`;
const TODAY = '2026-10-12';

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

let srv = (await boot()).srv;
ok(!!srv, 'server boots');
const adminToken = JSON.parse(readFileSync(join(DIR, 'admin-token.json'), 'utf8')).token;

const post = (p, b, tok) => fetch(B + p, { method: 'POST', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b) }).then(r => r.json());
const del = (p, tok) => fetch(B + p, { method: 'DELETE', headers: { Authorization: 'Bearer ' + tok } }).then(r => r.json());
const get = (p, tok) => fetch(B + p, { headers: { Authorization: 'Bearer ' + tok } }).then(r => r.json());
const reg = (username, pin, displayName) => post('/api/register', { username, pin, displayName });
// Direct check against the index's own real size (not the derived /api/progress output -- see
// this file's own header comment on why the two catch different regressions).
async function indexSize() {
  const r = await fetch(B + '/api/admin/scaling', { headers: { 'x-admin-token': adminToken } }).then(r => r.json());
  return r.sessionsByUserIndexEntries;
}

// The fields that actually run through the new index (volume/weeks/trend/plateaus) -- deliberately
// excluding fields like `prs` which come from the OTHER (already-separately-tested) fix.
function progressSnapshot(progress) {
  const { weeks, thisWeek, avgPerWeek, streakWeeks, volume, volumeAvg, volume3mo, volumeTrend, trend, plateaus } = progress;
  return JSON.stringify({ weeks, thisWeek, avgPerWeek, streakWeeks, volume, volumeAvg, volume3mo, volumeTrend, trend, plateaus });
}
async function progressFor(tok) { return get('/api/progress?weeks=13&localToday=' + TODAY, tok); }

try {

const alice = await reg('sbu_alice', 'pass1234', 'Alice');
const carol = await reg('sbu_carol', 'pass1234', 'Carol');   // unrelated, never touched below

console.log('\nsetup: Carol has her own, completely unrelated session/log history');
for (let i = 0; i < 4; i++) {
  const cs = await post('/api/sessions', { name: 'Carol Day', scheduledAt: `2026-09-${20+i}T12:00:00.000Z`, exercises: [{ name: 'Deadlift' }], visibility: 'private' }, carol.token);
  await post('/api/sessions/' + cs.id + '/log', { exerciseId: cs.exercises[0].id, weight: 200, reps: 5 }, carol.token);
}
const indexAfterCarolSetup = await indexSize();

console.log('\n1. baseline: Alice logs real sets across 2 sessions -- /api/progress is byte-identical before/after a restart');
const s1 = await post('/api/sessions', { name: 'Push Day', scheduledAt: '2026-08-03T12:00:00.000Z', exercises: [{ name: 'Bench Press' }], visibility: 'private' }, alice.token);
await post('/api/sessions/' + s1.id + '/log', { exerciseId: s1.exercises[0].id, weight: 135, reps: 8 }, alice.token);
await post('/api/sessions/' + s1.id + '/lock', { localDate: '2026-08-03' }, alice.token);
const s2 = await post('/api/sessions', { name: 'Pull Day', scheduledAt: '2026-08-17T12:00:00.000Z', exercises: [{ name: 'Row' }], visibility: 'private' }, alice.token);
await post('/api/sessions/' + s2.id + '/log', { exerciseId: s2.exercises[0].id, weight: 100, reps: 10 }, alice.token);
await post('/api/sessions/' + s2.id + '/lock', { localDate: '2026-08-17' }, alice.token);

const indexAfterBaseline = await indexSize();
ok(indexAfterBaseline - indexAfterCarolSetup === 2, `direct index check: logging s1+s2 grew the REAL index by exactly 2 entries, not just the derived output (got delta ${indexAfterBaseline - indexAfterCarolSetup}) -- this is what would catch indexAddUserSession being silently deleted, which the restart-diff below alone cannot`);

const before1 = progressSnapshot(await progressFor(alice.token));
srv = await restartServer(srv);
const after1 = progressSnapshot(await progressFor(alice.token));
ok(before1 === after1, 'baseline progress identical before/after restart (tests the CREATE/indexAddUserSession path)');
{
  const totalDays = JSON.parse(before1).weeks.reduce((a, w) => a + w.days, 0);
  ok(totalDays > 0, `sanity: the snapshot actually has real, non-zero data in it, not two empty objects agreeing by default (got ${totalDays} trained days)`);
}

console.log('\n2. leave-with-discard (keep:false) removes that session\'s credit -- identical before/after restart, AND the real index actually shrinks');
// Deliberately a date with NOTHING else logged anywhere in this test (weeksFor counts distinct
// TRAINED DAYS, not sessions -- reusing a date another still-kept session also lands on would
// mask the day-count change even though the underlying index update is correct).
const bob = await reg('sbu_bob', 'pass1234', 'Bob');
await post('/api/follow/' + bob.user.id, {}, alice.token);
const inv = await post('/api/sessions', { name: 'shared', scheduledAt: '2026-09-01T12:00:00.000Z', exercises: [{ name: 'Lat Pulldown' }], inviteUsernames: ['sbu_bob'], visibility: 'private' }, alice.token);
await post('/api/sessions/' + inv.id + '/accept', {}, bob.token);
await post('/api/sessions/' + inv.id + '/log', { exerciseId: inv.exercises[0].id, weight: 10, reps: 10 }, alice.token);
const beforeLeave = await progressFor(alice.token);
const indexBeforeLeave = await indexSize();
await post('/api/sessions/' + inv.id + '/leave', { keep: false }, alice.token);
const indexAfterLeaveDiscard = await indexSize();
ok(indexBeforeLeave - indexAfterLeaveDiscard === 1, `direct index check: discard-leave shrank the REAL index by exactly 1 (got delta ${indexBeforeLeave - indexAfterLeaveDiscard}) -- proves indexRemoveUserSession actually fired here, which an independent review showed the restart-diff below cannot distinguish from it being silently deleted`);
const before2 = progressSnapshot(await progressFor(alice.token));
srv = await restartServer(srv);
const after2 = progressSnapshot(await progressFor(alice.token));
ok(before2 === after2, 'post-discard-leave progress identical before/after restart (tests the discard indexRemoveUserSession path)');
ok(before2 !== progressSnapshot(beforeLeave), 'sanity: discarding actually changed something (not a no-op)');

console.log('\n3. remove-mine (deleting your own posted recap) removes that session\'s credit -- identical before/after restart, AND the real index actually shrinks');
const s4 = await post('/api/sessions', { name: 'Arm Day', scheduledAt: '2026-09-14T12:00:00.000Z', exercises: [{ name: 'Curl' }], visibility: 'private' }, alice.token);
await post('/api/sessions/' + s4.id + '/log', { exerciseId: s4.exercises[0].id, weight: 30, reps: 12 }, alice.token);
await post('/api/sessions/' + s4.id + '/lock', { localDate: '2026-09-14' }, alice.token);
const beforeRemove = await progressFor(alice.token);
const indexBeforeRemoveMine = await indexSize();
await post('/api/sessions/' + s4.id + '/remove-mine', {}, alice.token);
const indexAfterRemoveMine = await indexSize();
ok(indexBeforeRemoveMine - indexAfterRemoveMine === 1, `direct index check: remove-mine shrank the REAL index by exactly 1 (got delta ${indexBeforeRemoveMine - indexAfterRemoveMine})`);
const before3 = progressSnapshot(await progressFor(alice.token));
srv = await restartServer(srv);
const after3 = progressSnapshot(await progressFor(alice.token));
ok(before3 === after3, 'post-remove-mine progress identical before/after restart (tests that delete s.logs[me] path)');
ok(before3 !== progressSnapshot(beforeRemove), 'sanity: remove-mine actually changed something (not a no-op)');

console.log('\n4. reset-workouts (wipeUserFromAllSessions -> stripUserFromSession) clears ALL credit -- identical before/after restart, AND the real index actually empties for Alice');
const beforeReset = await progressFor(alice.token);
const indexBeforeReset = await indexSize();
const resetRes = await post('/api/me/reset-workouts', { password: 'pass1234' }, alice.token);
ok(!resetRes.error, 'reset-workouts itself succeeded (got ' + JSON.stringify(resetRes.error) + ')');
const indexAfterReset = await indexSize();
// Alice has exactly s1+s2 still indexed at this point (inv and s4 were already removed above) --
// stripUserFromSession must drop both, leaving only Carol's untouched 4.
ok(indexBeforeReset - indexAfterReset === 2 && indexAfterReset === indexAfterCarolSetup, `direct index check: reset-workouts emptied Alice's real index entries (expected drop of 2 down to Carol's untouched ${indexAfterCarolSetup}, got delta ${indexBeforeReset - indexAfterReset} down to ${indexAfterReset}) -- proves the shared stripUserFromSession's indexRemoveUserSession calls actually fired, for both of Alice's remaining sessions`);
const before4 = progressSnapshot(await progressFor(alice.token));
srv = await restartServer(srv);
const after4 = progressSnapshot(await progressFor(alice.token));
ok(before4 === after4, 'post-reset-workouts progress identical before/after restart (tests the shared stripUserFromSession path)');
ok(before4 !== progressSnapshot(beforeReset), 'sanity: reset-workouts actually changed something (not a no-op)');
{
  const totalDaysAfter = JSON.parse(before4).weeks.reduce((a, w) => a + w.days, 0);
  ok(totalDaysAfter === 0, `Alice genuinely has zero trained days anywhere after a full reset (got ${totalDaysAfter})`);
}

console.log('\n5. deleting a single log entry (not the whole logs[userId] key) is tolerated even though the index entry goes stale -- still correctly excluded, before AND after restart');
const bob2 = bob;   // reuse
const s5 = await post('/api/sessions', { name: 'Solo set', scheduledAt: '2026-09-28T12:00:00.000Z', exercises: [{ name: 'Lat Pulldown' }], visibility: 'private' }, bob2.token);
const logRes = await post('/api/sessions/' + s5.id + '/log', { exerciseId: s5.exercises[0].id, weight: 80, reps: 10 }, bob2.token);
const loggedId = logRes.logs[bob2.user.id][logRes.logs[bob2.user.id].length - 1].id;
const beforeDel = progressSnapshot(await progressFor(bob2.token));
await del('/api/sessions/' + s5.id + '/log/' + loggedId, bob2.token);
const afterDelNoRestart = progressSnapshot(await progressFor(bob2.token));
srv = await restartServer(srv);
const afterDelRestart = progressSnapshot(await progressFor(bob2.token));
ok(afterDelNoRestart === afterDelRestart, 'deleting the only log entry reads identically before/after restart (stale index entry is harmless, self-heals anyway)');
ok(beforeDel !== afterDelNoRestart, 'sanity: deleting the set actually changed bob\'s own stats');

console.log("\n6. Carol's totally unrelated history (never touched above) never leaked into or was disturbed by any of Alice's/Bob's index updates");
const carolSnapBefore = progressSnapshot(await progressFor(carol.token));
srv = await restartServer(srv);
const carolSnapAfter = progressSnapshot(await progressFor(carol.token));
ok(carolSnapBefore === carolSnapAfter, "Carol's own progress is unaffected by anything that happened to Alice/Bob, before or after any restart");

console.log('\n7. DELETE /api/sessions/:id (solo creator, hard delete) also shrinks the real index -- not just stripUserFromSession\'s delete-s.logs[userId] path');
// Oct 12 2026 (found by THIS test's own round-4 failure above, fixed in server.js): a
// hard-deleted session (`delete DB.sessions[s.id]`) never went through indexRemoveUserSession at
// all -- only stripUserFromSession's `delete s.logs[userId]` sites did. DELETE /api/sessions/:id
// is the other hard-delete site (wipeUserFromAllSessions' solo-creator branch, already proven by
// scenario 4 above, is the first) -- confirm it got the same fix.
const s6 = await post('/api/sessions', { name: 'Leg Day', scheduledAt: '2026-10-05T12:00:00.000Z', exercises: [{ name: 'Squat' }], visibility: 'private' }, bob2.token);
await post('/api/sessions/' + s6.id + '/log', { exerciseId: s6.exercises[0].id, weight: 150, reps: 5 }, bob2.token);
const indexBeforeHardDelete = await indexSize();
const hardDeleteRes = await del('/api/sessions/' + s6.id, bob2.token);
ok(hardDeleteRes.ok === true, 'solo-creator hard delete itself succeeded (got ' + JSON.stringify(hardDeleteRes) + ')');
const indexAfterHardDelete = await indexSize();
ok(indexBeforeHardDelete - indexAfterHardDelete === 1, `direct index check: DELETE /api/sessions/:id shrank the REAL index by exactly 1 (got delta ${indexBeforeHardDelete - indexAfterHardDelete}) -- proves removeSessionFromAllIndexes actually fired at this hard-delete site too, not just stripUserFromSession's`);

} finally {
  if (srv) srv.kill();
  await testDb.drop();
}

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
