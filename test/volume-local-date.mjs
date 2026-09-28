// Sep 28 2026 audit finding (Jeff, live on his real account): "Chest shows 0 / 16 sets 'this
// week' even though my Wednesday Cable Fly set counted as a working set (the finish screen said
// '1 working set', Home says '1 PR this week', Progress header says '1 day trained this week').
// The volume tracker seems to be using a different week window or not counting that set."
//
// Root cause: volumeFor/volumeTrendFor/firstLogDateFor bucketed sessions by s.scheduledAt/perfDate
// and the server's own bare UTC clock, instead of preferring the session's finished-history date
// (h.date, stamped from the caller's own localDate at the moment they hit Finish) and an optional
// caller-supplied localToday for the week boundary -- the EXACT bug weeksFor/currentStreak already
// hit and fixed in v247 (see the comment above weeksFor in server.js). Once a session is finished,
// its scheduledAt (when it was PLANNED) and its history date (when it was actually TRAINED,
// credited in the trainer's own local day) can legitimately disagree, and the server's bare
// `new Date()` "today" has no idea what the caller's own local day even is -- either gap alone is
// enough to bucket a real, counted set into the wrong week (or drop it out of the window
// entirely), while weeksFor/Home/the finish screen all agreed it counted THIS week.
//
// This file locks in the fix: a finished session whose scheduledAt and finish-time localDate land
// in DIFFERENT weeks must be bucketed by the finish date (matching weeksFor), and passing
// localToday to GET /api/progress must move volume's own week boundary the same way it already
// moves weeksFor's.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const J = { 'Content-Type': 'application/json' };
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('volumelocaldate');

function boot(port, dir) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; srv.stdout.on('data', d => { out += d; if (String(d).includes('CrewFit on')) res({ srv, out }); });
    srv.on('exit', () => res({ srv: null, out }));
    setTimeout(() => res({ srv, out }), 15000);
  });
}

const DIR = mkdtempSync(join(tmpdir(), 'volumelocaldate-'));
const PORT = 4994, B = `http://localhost:${PORT}`;
const { srv } = await boot(PORT, DIR);
ok(!!srv, 'server boots');
// Kill the spawned server on ANY exit path -- a thrown error (not just a clean run) must not leave
// it orphaned on this port, which would otherwise fail every subsequent run of this file with a
// confusing "server boots: FAIL" that has nothing to do with the actual code under test (this bit
// the very first run of this file: a leaked server.js from a previous invocation held port 4994).
async function cleanup() { try { if (srv) srv.kill(); } catch {} try { await testDb.drop(); } catch {} }
process.on('uncaughtException', async (e) => { console.error('UNCAUGHT', e); await cleanup(); process.exit(1); });
process.on('unhandledRejection', async (e) => { console.error('UNHANDLED', e); await cleanup(); process.exit(1); });

const post = (p, b, tok) => fetch(B + p, { method: 'POST', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b) }).then(r => r.json());
const get = (p, tok) => fetch(B + p, { headers: tok ? { Authorization: 'Bearer ' + tok } : {} }).then(r => r.json());
const reg = (username, pin, displayName) => post('/api/register', { username, pin, displayName });

// Real "today", used only to compute a scheduledAt that's unambiguously in a DIFFERENT week from
// the fixed localDate/localToday values below (never both close to a real week boundary at once).
function isoDaysAgo(n) {
  const d = new Date(); d.setUTCDate(d.getUTCDate() - n);
  d.setUTCHours(15, 0, 0, 0);
  return d.toISOString();
}

console.log('a finished session bucketed by its finish-time local date, not its (different-week) scheduledAt');
{
  const u = await reg('vld_u1', 'pass1234', 'VLD One');
  // Scheduled 21 days ago -- an entirely different week from "now" under any reasonable clock.
  const s = await post('/api/sessions', {
    name: 'Push', scheduledAt: isoDaysAgo(21),
    exercises: [{ name: 'Flat Barbell Bench Press' }], visibility: 'private',
  }, u.token);
  const exId = s.exercises[0].id;
  for (let i = 0; i < 3; i++) await post(`/api/sessions/${s.id}/log`, { exerciseId: exId, weight: 135, reps: 8, setType: 'normal' }, u.token);
  // Finished "today" in the trainer's own local day -- same as tapping Log & Finish right now.
  const today = new Date().toISOString().slice(0, 10);
  const lockRes = await post(`/api/sessions/${s.id}/lock`, { localDate: today }, u.token);
  ok(!lockRes.error, `session locks (got ${lockRes.error})`);

  const prog = await get('/api/progress?localToday=' + today, u.token);
  ok(!prog.error, `progress loads (got ${prog.error})`);
  ok(prog.thisWeek === 1, `weeksFor already agrees this counts as trained this week (got ${prog.thisWeek})`);
  const chest = prog.volume.groups.find(g => g.group === 'chest');
  ok(chest.sets === 3, `volume (This week) now credits the 3 chest sets from the SAME session weeksFor already counted (got ${chest.sets}) -- this is exactly Jeff's "Chest shows 0/16" report`);
  const chestTrend = prog.volumeTrend.weeks[prog.volumeTrend.weeks.length - 1].groups.find(g => g.group === 'chest');
  ok(chestTrend.sets === 3, `volumeTrend's current-week bucket agrees (got ${chestTrend.sets})`);
}

console.log('\na session finished with NO explicit localDate still falls back to scheduledAt, same as before this fix (logged-but-unfinished has no better source)');
{
  const u = await reg('vld_u2', 'pass1234', 'VLD Two');
  const s = await post('/api/sessions', {
    name: 'Legs', scheduledAt: new Date().toISOString(),
    exercises: [{ name: 'Barbell Back Squat' }], visibility: 'private',
  }, u.token);
  const exId = s.exercises[0].id;
  await post(`/api/sessions/${s.id}/log`, { exerciseId: exId, weight: 185, reps: 5, setType: 'normal' }, u.token);
  // Not locked/finished at all -- an in-progress session has no history row, so this must still
  // count via the scheduledAt fallback (unchanged behavior, verified by test/progress-volume-
  // bodyweight.mjs already, re-checked here in the same file as the fix for good measure).
  const prog = await get('/api/progress', u.token);
  const quads = prog.volume.groups.find(g => g.group === 'quads');
  ok(quads.sets === 1, `an unfinished session's set still counts via scheduledAt (got ${quads.sets})`);
}

console.log('\npassing localToday moves the volume week boundary the same way it already moves weeksFor\'s (Consistency)');
{
  const u = await reg('vld_u3', 'pass1234', 'VLD Three');
  // Fixed pretend-Monday far from the real current date, so there is no chance of it coinciding
  // with today's actual week by accident.
  const pretendToday = '2026-03-18'; // a Wednesday
  const s = await post('/api/sessions', {
    name: 'Pull', scheduledAt: '2026-03-16T15:00:00.000Z', // that same pretend week's Monday
    exercises: [{ name: 'Barbell Row' }], visibility: 'private',
  }, u.token);
  const exId = s.exercises[0].id;
  for (let i = 0; i < 4; i++) await post(`/api/sessions/${s.id}/log`, { exerciseId: exId, weight: 135, reps: 8, setType: 'normal' }, u.token);
  const lockRes = await post(`/api/sessions/${s.id}/lock`, { localDate: pretendToday }, u.token);
  ok(!lockRes.error, `session locks (got ${lockRes.error})`);

  const progPretend = await get('/api/progress?localToday=' + pretendToday, u.token);
  const backAtLats = progPretend.volume.groups.find(g => g.group === 'lats');
  ok(backAtLats.sets === 4, `with localToday pinned to that pretend week, the 4 rows count as THIS week (got ${backAtLats.sets})`);
  ok(progPretend.thisWeek === 1, `weeksFor agrees under the same pinned localToday (got ${progPretend.thisWeek})`);

  // Without localToday, the server falls back to its own real "now" -- a real week nowhere near
  // March 2026 -- so the same session must NOT show up as this week's volume.
  const progReal = await get('/api/progress', u.token);
  const backAtLatsReal = progReal.volume.groups.find(g => g.group === 'lats');
  ok(backAtLatsReal.sets === 0, `without localToday, the server's own real "now" does not see that March session as this week (got ${backAtLatsReal.sets})`);
}

console.log('\nmuscleBalanceFor\'s "behind target 2 weeks running" flag agrees with the fixed volume data, not the old scheduledAt-only bucketing');
{
  const u = await reg('vld_u4', 'pass1234', 'VLD Four');
  const pretendToday = '2026-05-20'; // a Wednesday, 3 Mondays after the session below
  // Scheduled long before, but actually trained (finished) exactly on the "2-completed-weeks-ago"
  // Monday relative to pretendToday -- enough real volume to clear chest's target both completed
  // weeks, so the flag must NOT fire for chest even though its scheduledAt is far away.
  const s1 = await post('/api/sessions', {
    name: 'Chest A', scheduledAt: '2026-01-01T15:00:00.000Z',
    exercises: [{ name: 'Flat Barbell Bench Press' }], visibility: 'private',
  }, u.token);
  const exId1 = s1.exercises[0].id;
  for (let i = 0; i < 16; i++) await post(`/api/sessions/${s1.id}/log`, { exerciseId: exId1, weight: 135, reps: 8, setType: 'normal' }, u.token);
  await post(`/api/sessions/${s1.id}/lock`, { localDate: '2026-05-04' }, u.token); // 2 completed weeks before pretendToday's Monday
  const s2 = await post('/api/sessions', {
    name: 'Chest B', scheduledAt: '2026-01-02T15:00:00.000Z',
    exercises: [{ name: 'Flat Barbell Bench Press' }], visibility: 'private',
  }, u.token);
  const exId2 = s2.exercises[0].id;
  for (let i = 0; i < 16; i++) await post(`/api/sessions/${s2.id}/log`, { exerciseId: exId2, weight: 135, reps: 8, setType: 'normal' }, u.token);
  await post(`/api/sessions/${s2.id}/lock`, { localDate: '2026-05-11' }, u.token); // 1 completed week before pretendToday's Monday

  const prog = await get('/api/progress?localToday=' + pretendToday, u.token);
  const chestFlag = (prog.muscleBalance.groups || []).find(g => g.group === 'chest');
  ok(!chestFlag, `chest is NOT flagged -- both completed weeks actually hit target once bucketed by finish date, not scheduledAt (got ${JSON.stringify(chestFlag)})`);
}

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
await cleanup();
process.exit(fails ? 1 : 0);
