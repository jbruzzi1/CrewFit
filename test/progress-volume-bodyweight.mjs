// Progress page additions (Aug 31): weekly volume-per-muscle-group meter rows, and body weight
// tracking. Both approved by Jeff ("Yes lets build these") after the gap analysis -- the page
// tracked WHEN you trained and single-lift trend, but never WHAT muscle groups you'd actually
// been training, and had no way to log bodyweight at all.
//
// volumeFor(): working sets logged THIS calendar week (Monday-Sunday UTC), attributed to every
// muscle group the exercise targets, full credit each -- same "touch it, it counts" rule
// creditFinish already uses for history.muscleGroups. Verifies: multi-muscle attribution (a squat
// counts for both quads AND glutes), single-muscle attribution, warm-ups/drop sets excluded (same
// WORKING_SET_TYPES rule as everywhere else on this page), a set logged in a PAST week does not
// bleed into this week's count, and a CUSTOM exercise (not in EX_LIB, only in DB.customExercises)
// still gets credited via findExLibEntry's fallback lookup.
//
// bodyweightFor()/POST+DELETE /api/me/bodyweight: one entry per calendar day (same-day re-log
// upserts rather than piling up), read back converted into whatever unit the user is on now
// (same "typed unit frozen, read unit live" rule as logged sets), and deletable.
//
// volumeFor(userId, weeks)/volumeAvg (Aug 31, round 2): "should weekly volume show monthly?" led
// to a trailing 4-week average alongside the existing this-week count rather than a separate
// monthly section. Verifies weeks=1 is byte-identical to the original behavior, the trailing
// window correctly sums+averages across Monday-anchored weeks (including the current partial
// week), a week outside the window doesn't leak in, and the avg row keeps the same per-group
// target as the weekly row.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const J = { 'Content-Type': 'application/json' };
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('progvolbw');

function boot(port, dir) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; srv.stdout.on('data', d => { out += d; if (String(d).includes('CrewFit on')) res({ srv, out }); });
    srv.on('exit', () => res({ srv: null, out }));
    setTimeout(() => res({ srv, out }), 15000);
  });
}

const DIR = mkdtempSync(join(tmpdir(), 'progvolbw-'));
const PORT = 4993, B = `http://localhost:${PORT}`;
const { srv } = await boot(PORT, DIR);
ok(!!srv, 'server boots');

const post = (p, b, tok) => fetch(B + p, { method: 'POST', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b) }).then(r => r.json());
const get = (p, tok) => fetch(B + p, { headers: tok ? { Authorization: 'Bearer ' + tok } : {} }).then(r => r.json());
const del = (p, tok) => fetch(B + p, { method: 'DELETE', headers: tok ? { Authorization: 'Bearer ' + tok } : {} }).then(r => r.json());
const reg = (username, pin, displayName) => post('/api/register', { username, pin, displayName });

function isoDaysAgo(n) {
  const d = new Date(); d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString();
}
function localToday() { return new Date().toISOString().slice(0, 10); }
// Monday-anchored, same boundary volumeFor() itself uses -- weeksAgo=0 is THIS week's Monday,
// weeksAgo=3 is 3 Mondays back. dayOffset nudges a day or two into the week so the timestamp
// doesn't sit exactly on the boundary.
function mondayOffsetIso(weeksAgo, dayOffset = 1) {
  const now = new Date();
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7) - weeksAgo * 7);
  monday.setUTCDate(monday.getUTCDate() + dayOffset);
  monday.setUTCHours(15, 0, 0, 0);
  return monday.toISOString();
}

console.log('weekly volume: multi-muscle attribution, warm-ups excluded, past week excluded');
{
  const u = await reg('vol_u1', 'pass1234', 'Vol One');
  // this week: 3 working sets of a squat (quads+glutes) + 1 warm-up (must not count)
  const s1 = await post('/api/sessions', {
    name: 'Legs', scheduledAt: new Date().toISOString(),
    exercises: [{ name: 'Barbell Back Squat' }], visibility: 'private',
  }, u.token);
  const exId = s1.exercises[0].id;
  for (let i = 0; i < 3; i++) await post(`/api/sessions/${s1.id}/log`, { exerciseId: exId, weight: 135, reps: 8, setType: 'normal' }, u.token);
  await post(`/api/sessions/${s1.id}/log`, { exerciseId: exId, weight: 95, reps: 8, setType: 'warmup' }, u.token);

  // last week (14 days ago): 5 working sets of a curl (biceps only) -- must NOT show up this week
  const s2 = await post('/api/sessions', {
    name: 'Arms (old)', scheduledAt: isoDaysAgo(14),
    exercises: [{ name: 'Barbell Curl' }], visibility: 'private',
  }, u.token);
  const exId2 = s2.exercises[0].id;
  for (let i = 0; i < 5; i++) await post(`/api/sessions/${s2.id}/log`, { exerciseId: exId2, weight: 60, reps: 10, setType: 'normal' }, u.token);

  const prog = await get('/api/progress', u.token);
  ok(!prog.error, `progress loads (got ${prog.error})`);
  const byGroup = {}; (prog.volume.groups || []).forEach(g => byGroup[g.group] = g);
  ok(byGroup.quads && byGroup.quads.sets === 3, `quads: 3 sets this week (got ${byGroup.quads && byGroup.quads.sets})`);
  ok(byGroup.glutes && byGroup.glutes.sets === 3, `glutes: 3 sets this week, same squat credited to both (got ${byGroup.glutes && byGroup.glutes.sets})`);
  ok(byGroup.biceps && byGroup.biceps.sets === 0, `biceps: 0 -- last week's curls do not bleed into this week (got ${byGroup.biceps && byGroup.biceps.sets})`);
  ok(byGroup.quads.target > 0, `quads has a nonzero default target (got ${byGroup.quads.target})`);
  ok(!('cardio' in byGroup), 'cardio is excluded from the volume meter (not a sets-against-a-target thing)');
}

console.log('weekly volume: a custom exercise (not in EX_LIB) still gets credited');
{
  const u = await reg('vol_u2', 'pass1234', 'Vol Two');
  const custom = await post('/api/exercises/custom', { name: 'Vol Test Custom Row', muscle_groups: ['lats', 'biceps'] }, u.token);
  ok(!custom.error, `custom exercise created (got ${custom.error})`);
  const s = await post('/api/sessions', {
    name: 'Back', scheduledAt: new Date().toISOString(),
    exercises: [{ name: 'Vol Test Custom Row' }], visibility: 'private',
  }, u.token);
  const exId = s.exercises[0].id;
  for (let i = 0; i < 4; i++) await post(`/api/sessions/${s.id}/log`, { exerciseId: exId, weight: 100, reps: 8, setType: 'normal' }, u.token);
  const prog = await get('/api/progress', u.token);
  const byGroup = {}; (prog.volume.groups || []).forEach(g => byGroup[g.group] = g);
  ok(byGroup.lats.sets === 4, `custom exercise credits lats (got ${byGroup.lats.sets})`);
  ok(byGroup.biceps.sets === 4, `custom exercise credits biceps too (got ${byGroup.biceps.sets})`);
}

console.log('weekly volume: two different users\' same-named custom exercises do not cross-contaminate (cold-review catch)');
{
  // Custom exercise names are not unique -- not even per user (POST /api/exercises/custom
  // enforces nothing) -- and every user's custom exercises are visible/loggable by everyone else.
  // findExLibEntry used to scan ALL users' custom lists and return the first name match, so user
  // B logging their OWN "Collision Press" could get credited with user A's muscle_groups instead
  // of their own, just because A's array happened to iterate first.
  const a = await reg('vol_collide_a', 'pass1234', 'Collide A');
  const b = await reg('vol_collide_b', 'pass1234', 'Collide B');
  const customA = await post('/api/exercises/custom', { name: 'Collision Press', muscle_groups: ['triceps'] }, a.token);
  ok(!customA.error, `user A creates "Collision Press" -> triceps (got ${customA.error})`);
  const customB = await post('/api/exercises/custom', { name: 'Collision Press', muscle_groups: ['chest', 'shoulders'] }, b.token);
  ok(!customB.error, `user B creates a DIFFERENT "Collision Press" -> chest/shoulders (got ${customB.error})`);

  const sB = await post('/api/sessions', {
    name: 'B Push Day', scheduledAt: new Date().toISOString(),
    exercises: [{ name: 'Collision Press' }], visibility: 'private',
  }, b.token);
  for (let i = 0; i < 5; i++) await post(`/api/sessions/${sB.id}/log`, { exerciseId: sB.exercises[0].id, weight: 90, reps: 8, setType: 'normal' }, b.token);

  const progB = await get('/api/progress', b.token);
  const byGroupB = {}; (progB.volume.groups || []).forEach(g => byGroupB[g.group] = g);
  ok(byGroupB.chest.sets === 5, `B's own sets credit B's OWN muscle groups (chest), not A's (got ${byGroupB.chest.sets})`);
  ok(byGroupB.shoulders.sets === 5, `...and shoulders too (got ${byGroupB.shoulders.sets})`);
  ok(byGroupB.triceps.sets === 0, `B's sets do NOT bleed into A's triceps just because A's exercise shares the name (got ${byGroupB.triceps.sets})`);
}

console.log('weekly volume: 4-week average (volumeAvg) -- trailing window, per-week average, weeks=1 untouched');
{
  // Jeff, Aug 31: "should weekly volume show monthly?" -- landed on a "4-wk avg" secondary view
  // rather than a separate monthly section. /api/progress now always returns BOTH volume (this
  // week, weeks=1, byte-identical to before this existed) and volumeAvg (trailing 4 Monday-
  // anchored weeks including the current partial week, summed then divided by 4, rounded to 1
  // decimal) -- same trailing-window-includes-partial-current-week precedent weeksFor() already
  // sets for the Consistency chart.
  const u = await reg('vol_avg_u1', 'pass1234', 'Vol Avg One');
  async function seedWeek(weeksAgo, n) {
    const s = await post('/api/sessions', {
      name: `Push -${weeksAgo}w`, scheduledAt: mondayOffsetIso(weeksAgo),
      exercises: [{ name: 'Flat Barbell Bench Press' }], visibility: 'private',
    }, u.token);
    const exId = s.exercises[0].id;
    for (let i = 0; i < n; i++) await post(`/api/sessions/${s.id}/log`, { exerciseId: exId, weight: 135, reps: 8, setType: 'normal' }, u.token);
  }
  // This week: 2 sets. Prior 3 weeks: 5, 4, 5 -- a light current week after solid recent training,
  // exactly the "looks artificially empty" scenario that prompted the feature.
  await seedWeek(0, 2);
  await seedWeek(1, 5);
  await seedWeek(2, 4);
  await seedWeek(3, 5);
  // 5 weeks ago -- outside the trailing-4 window, must NOT be pulled into the average.
  await seedWeek(5, 9);

  const prog = await get('/api/progress', u.token);
  ok(!prog.error, `progress loads (got ${prog.error})`);
  ok(!!prog.volumeAvg, `progress includes volumeAvg (got ${JSON.stringify(prog.volumeAvg)})`);
  const week = {}; (prog.volume.groups || []).forEach(g => week[g.group] = g);
  const avg = {}; (prog.volumeAvg.groups || []).forEach(g => avg[g.group] = g);
  ok(week.chest.sets === 2, `weeks=1 (default) unchanged -- this week's raw count (got ${week.chest.sets})`);
  ok(avg.chest.sets === 4, `4-wk avg: (2+5+4+5)/4 = 4 (got ${avg.chest.sets})`);
  ok(avg.chest.target === week.chest.target, `avg row keeps the same target as the weekly row (got ${avg.chest.target} vs ${week.chest.target})`);

  // A single, isolated-week sanity check that weeks=1 truly is untouched: same shape/values as
  // the pre-existing plain volumeFor(userId) call would have produced.
  ok(week.quads.sets === 0 && avg.quads.sets === 0, `an untouched muscle group reads 0 in both views (got ${week.quads.sets}/${avg.quads.sets})`);
}

console.log('body weight: log, upsert same day, unit conversion, delete');
{
  const u = await reg('bw_u1', 'pass1234', 'BW One');
  const today = localToday();

  const first = await post('/api/me/bodyweight', { weight: 180, unit: 'lb', date: today }, u.token);
  ok(!first.error, `first log goes through (got ${first.error})`);
  ok(first.entries.length === 1 && first.entries[0].weight === 180, `one entry at 180 (got ${JSON.stringify(first.entries)})`);

  const again = await post('/api/me/bodyweight', { weight: 179, unit: 'lb', date: today }, u.token);
  ok(again.entries.length === 1, `same-day re-log UPSERTS, not a second row (got ${again.entries.length} entries)`);
  ok(again.entries[0].weight === 179, `upsert replaced the value (got ${again.entries[0].weight})`);

  const bad = await post('/api/me/bodyweight', { weight: 0, unit: 'lb', date: today }, u.token);
  ok(bad.error === 'Enter your weight', `zero weight refused (got ${JSON.stringify(bad)})`);

  await post('/api/me/units', { units: 'kg' }, u.token);
  const prog = await get('/api/progress', u.token);
  ok(prog.bodyweight.unit === 'kg', `progress reports the user's current unit (got ${prog.bodyweight.unit})`);
  const expectedKg = Math.round((179 / 2.2046226218) * 2) / 2;
  ok(Math.abs(prog.bodyweight.entries[0].weight - expectedKg) < 0.01,
    `179 lb reads back converted to ~${expectedKg} kg (got ${prog.bodyweight.entries[0].weight})`);

  const gone = await del(`/api/me/bodyweight/${today}`, u.token);
  ok(gone.entries.length === 0, `delete removes the entry (got ${gone.entries.length} left)`);
}

console.log('body weight: two distinct days both show up, sorted ascending');
{
  const u = await reg('bw_u2', 'pass1234', 'BW Two');
  const today = localToday();
  const yestDate = new Date(); yestDate.setUTCDate(yestDate.getUTCDate() - 1);
  const yest = yestDate.toISOString().slice(0, 10);
  await post('/api/me/bodyweight', { weight: 200, unit: 'lb', date: yest }, u.token);
  await post('/api/me/bodyweight', { weight: 198, unit: 'lb', date: today }, u.token);
  const prog = await get('/api/progress', u.token);
  ok(prog.bodyweight.entries.length === 2, `two distinct days both stored (got ${prog.bodyweight.entries.length})`);
  ok(prog.bodyweight.entries[0].date === yest && prog.bodyweight.entries[1].date === today,
    `sorted ascending, oldest first (got ${JSON.stringify(prog.bodyweight.entries.map(e => e.date))})`);
}

console.log('body weight: auth required');
{
  const noAuth = await post('/api/me/bodyweight', { weight: 180, unit: 'lb' }, null);
  ok(noAuth.error !== undefined, `unauthenticated POST is refused (got ${JSON.stringify(noAuth)})`);
}

console.log(fails ? `\n${fails} FAILURE(S)\n` : '\nall assertions passed\n');
if (srv) srv.kill();
rmSync(DIR, { recursive: true, force: true });
await testDb.drop();
process.exit(fails ? 1 : 0);
