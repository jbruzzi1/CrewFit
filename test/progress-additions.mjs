// Sep 14 2026 (Jeff, "what else can we add to the progress page" -- picked options 1-3 of 5
// suggested): three additions, each grounded in data the app already computed somewhere but never
// surfaced together:
//   1. Top lifts -- topLiftsFor() in server.js. Auto-picks your 3 most-logged lifts (shares
//      liftHistoryFor()/bestPointOfWindow() with trendFor(), refactored out of trendFor() this
//      same session -- see the comment above liftHistoryFor for why); topLiftPicks lets a user
//      override which 3 show, same lazy-validate-at-read pattern as the existing trendPicks.
//   2. Muscle balance -- muscleBalanceFor(). Flags a muscle group only when it's missed its Volume
//      trend weekly target for the last 2 FULLY COMPLETED weeks running (never the current
//      in-progress week), and only once the user has enough real history for that comparison to
//      be fair to them (firstLogDateFor gate) -- a brand-new account should never see "behind" on
//      a muscle it hasn't had the chance to train yet.
//   3. Goals -- goalProgress, computed once inside recordsFor() so the new Goals card and the
//      inline bar on the SAME PR row in Personal records never disagree. Skipped (null) for a
//      bodyweight lift (weight 0) or an assisted exercise (no clean starting point for a percent).
//
// Real server, real Postgres -- same pattern as plateau-flagging.mjs/block-crew-streak-privacy.mjs.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const J = { 'Content-Type': 'application/json' };
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('progadd');

const DIR = mkdtempSync(join(tmpdir(), 'progadd-'));
const PORT = 4955, BASE = `http://localhost:${PORT}`;
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

const post = (p, b, tok) => fetch(BASE + p, { method: 'POST', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b) }).then(r => r.json());
const put = (p, b, tok) => fetch(BASE + p, { method: 'PUT', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b) }).then(r => r.json());
const get = (p, tok) => fetch(BASE + p, { headers: tok ? { Authorization: 'Bearer ' + tok } : {} }).then(r => r.json());
const reg = (username, pin, displayName) => post('/api/register', { username, pin, displayName });

// Same UTC-Monday-bucket math as volumeTrendFor() in server.js -- lets the test place a session in
// exactly the "2 weeks ago", "1 week ago", or "current" bucket regardless of what real-world day
// the suite happens to run on.
function mondayUTC(d) {
  const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  m.setUTCDate(m.getUTCDate() - ((m.getUTCDay() + 6) % 7));
  return m;
}
const THIS_MONDAY = mondayUTC(new Date());
function dateInWeek(weeksAgo, dayOffset = 2) {
  const d = new Date(THIS_MONDAY);
  d.setUTCDate(d.getUTCDate() - weeksAgo * 7 + dayOffset);
  d.setUTCHours(15, 0, 0, 0);
  return d.toISOString();
}
async function logSession(u, exName, scheduledAt, weight, reps) {
  const s = await post('/api/sessions', { name: exName, scheduledAt, exercises: [{ name: exName }], visibility: 'private' }, u.token);
  await post(`/api/sessions/${s.id}/log`, { exerciseId: s.exercises[0].id, weight, reps, setType: 'normal' }, u.token);
  return s;
}

console.log('\n=== Top lifts ===');
{
  const u = await reg('tl_user', 'pass1234', 'TL User');
  const A = 'Flat Barbell Bench Press', B = 'Barbell Back Squat', C = 'Barbell Row', D = 'Conventional Deadlift';
  // Distinct, unambiguous counts so "most-logged first" has no ties to worry about.
  for (let i = 0; i < 5; i++) await logSession(u, A, dateInWeek(0, i % 7), 135, 8);
  for (let i = 0; i < 4; i++) await logSession(u, B, dateInWeek(0, i % 7), 185, 5);
  for (let i = 0; i < 3; i++) await logSession(u, C, dateInWeek(0, i % 7), 95, 8);
  for (let i = 0; i < 2; i++) await logSession(u, D, dateInWeek(0, i % 7), 225, 5);

  console.log('auto-picks top 3 most-logged when no picks are saved');
  {
    const prog = await get('/api/progress', u.token);
    ok(!prog.error, `progress loads (got ${prog.error})`);
    const names = (prog.topLifts.lifts || []).map(l => l.name);
    ok(JSON.stringify(names) === JSON.stringify([A, B, C]), `top 3 by frequency, most-logged first (got ${JSON.stringify(names)})`);
    ok(prog.topLifts.lifts[0].sessions === 5, `A reports 5 sessions (got ${prog.topLifts.lifts[0].sessions})`);
    ok(typeof prog.topLifts.lifts[0].weight === 'number' && typeof prog.topLifts.lifts[0].est === 'number', 'tile carries numeric weight/est');
  }

  console.log('saved picks override the auto top-3, in the order saved, capped at 3');
  {
    const saveRes = await post('/api/me/top-lift-picks', { picks: [D, A] }, u.token);
    ok(JSON.stringify(saveRes.picks) === JSON.stringify([D, A]), `save echoes exactly [D, A] (got ${JSON.stringify(saveRes.picks)})`);
    const prog = await get('/api/progress', u.token);
    const names = (prog.topLifts.lifts || []).map(l => l.name);
    ok(JSON.stringify(names) === JSON.stringify([D, A]), `shown lifts follow the saved pick order, NOT padded to 3 (got ${JSON.stringify(names)})`);
  }

  console.log('a saved pick that was never actually logged is dropped at read time, not saved-time (lazy validation, same as trendPicks)');
  {
    await post('/api/me/top-lift-picks', { picks: ['Totally Fake Exercise', B] }, u.token);
    const prog = await get('/api/progress', u.token);
    ok(JSON.stringify(prog.topLifts.picks) === JSON.stringify([B]), `fake name silently dropped, real one kept (got ${JSON.stringify(prog.topLifts.picks)})`);
    ok(prog.topLifts.lifts.length === 1 && prog.topLifts.lifts[0].name === B, 'only the one valid pick is shown, not backfilled to 3');
  }

  console.log('more than 3 picks sent to the save route are capped at 3, same as trend-picks caps at 5');
  {
    const saveRes = await post('/api/me/top-lift-picks', { picks: [A, B, C, D] }, u.token);
    ok(saveRes.picks.length === 3, `save caps at 3 regardless of how many were sent (got ${JSON.stringify(saveRes.picks)})`);
  }
}

console.log('\n=== Muscle balance ===');
{
  console.log('brand-new account: never flagged, even though every muscle is technically at 0 sets');
  {
    const u = await reg('mbal_new', 'pass1234', 'New');
    // One single recent session so the account isn't completely history-free, but nowhere near
    // long enough for a fair 2-completed-weeks comparison.
    await logSession(u, 'Flat Barbell Bench Press', dateInWeek(0, 1), 135, 8);
    const prog = await get('/api/progress', u.token);
    ok(!prog.error, `progress loads (got ${prog.error})`);
    ok((prog.muscleBalance.groups || []).length === 0, `nothing flagged for a brand-new account (got ${JSON.stringify(prog.muscleBalance.groups)})`);
  }

  console.log('chest under target BOTH of the last 2 completed weeks -> flagged');
  {
    const u = await reg('mbal_both', 'pass1234', 'Both Under');
    // Old enough that firstLogDateFor is safely before the 2-weeks-ago bucket even starts.
    await logSession(u, 'Barbell Back Squat', dateInWeek(6, 1), 185, 5);
    // 2 chest sets each in the last 2 completed weeks -- well under the 16/week target either way.
    await logSession(u, 'Flat Barbell Bench Press', dateInWeek(2, 1), 135, 8);
    await logSession(u, 'Flat Barbell Bench Press', dateInWeek(2, 2), 135, 8);
    await logSession(u, 'Flat Barbell Bench Press', dateInWeek(1, 1), 135, 8);
    await logSession(u, 'Flat Barbell Bench Press', dateInWeek(1, 2), 135, 8);
    const prog = await get('/api/progress', u.token);
    const chest = (prog.muscleBalance.groups || []).find(g => g.group === 'chest');
    ok(!!chest, `chest IS flagged (got ${JSON.stringify(prog.muscleBalance.groups)})`);
    if (chest) {
      ok(chest.target === 16, `target is 16 (got ${chest.target})`);
      ok(JSON.stringify(chest.weeks) === JSON.stringify([2, 2]), `both weeks report 2 sets each (got ${JSON.stringify(chest.weeks)})`);
    }
  }

  console.log("boundary: first-ever log exactly on the 2-weeks-ago Monday IS old enough (gate is strictly-greater-than, not >=)");
  {
    const u = await reg('mbal_bound', 'pass1234', 'Boundary');
    // First log dated exactly at twoAgo's own start (dayOffset 0 -- volumeTrendFor's own bucket
    // boundary) -- should count as old enough, not be suppressed as "too new."
    await logSession(u, 'Flat Barbell Bench Press', dateInWeek(2, 0), 135, 8);
    await logSession(u, 'Flat Barbell Bench Press', dateInWeek(1, 0), 135, 8);
    const prog = await get('/api/progress', u.token);
    const chest = (prog.muscleBalance.groups || []).find(g => g.group === 'chest');
    ok(!!chest, `flagged -- an account whose first log lands exactly on the boundary is old enough for a fair comparison (got ${JSON.stringify(prog.muscleBalance.groups)})`);
  }

  console.log('chest under target only ONE of the last 2 completed weeks -> NOT flagged');
  {
    const u = await reg('mbal_one', 'pass1234', 'One Under');
    await logSession(u, 'Barbell Back Squat', dateInWeek(6, 1), 185, 5);
    // Meets target (16+) two weeks ago...
    for (let i = 0; i < 16; i++) await logSession(u, 'Flat Barbell Bench Press', dateInWeek(2, i % 7), 135, 8);
    // ...but well under target last week.
    await logSession(u, 'Flat Barbell Bench Press', dateInWeek(1, 1), 135, 8);
    const prog = await get('/api/progress', u.token);
    const chest = (prog.muscleBalance.groups || []).find(g => g.group === 'chest');
    ok(!chest, `NOT flagged -- only one of the two weeks was under target (got ${JSON.stringify(prog.muscleBalance.groups)})`);
  }

  console.log("current, in-progress week doesn't count toward the flag either way");
  {
    const u = await reg('mbal_cur', 'pass1234', 'Current Week');
    await logSession(u, 'Barbell Back Squat', dateInWeek(6, 1), 185, 5);
    // Meets target in BOTH completed weeks...
    for (let i = 0; i < 16; i++) await logSession(u, 'Flat Barbell Bench Press', dateInWeek(2, i % 7), 135, 8);
    for (let i = 0; i < 16; i++) await logSession(u, 'Flat Barbell Bench Press', dateInWeek(1, i % 7), 135, 8);
    // ...but has logged nothing at all yet THIS week (in progress, day may not be over).
    const prog = await get('/api/progress', u.token);
    const chest = (prog.muscleBalance.groups || []).find(g => g.group === 'chest');
    ok(!chest, `NOT flagged -- the current in-progress week is never counted (got ${JSON.stringify(prog.muscleBalance.groups)})`);
  }
}

console.log('\n=== Goal progress ===');
{
  const u = await reg('goal_user', 'pass1234', 'Goal User');

  console.log('an entered (not-yet-earned) seed with a goal gets a progress fraction');
  {
    await put('/api/me/seeds', { exercise: 'Flat Barbell Bench Press', weight: 185, reps: 5, goal: 225 }, u.token);
    const prog = await get('/api/progress', u.token);
    const pr = prog.prs.find(p => p.exercise === 'Flat Barbell Bench Press');
    ok(!!pr && !!pr.goalProgress, `goalProgress present (got ${JSON.stringify(pr)})`);
    if (pr && pr.goalProgress) {
      ok(pr.goalProgress.pct === 82, `pct is round(100*185/225)=82 (got ${pr.goalProgress.pct})`);
      ok(pr.goalProgress.remaining === 40, `remaining is 225-185=40 (got ${pr.goalProgress.remaining})`);
      ok(pr.goalProgress.reached === false, `not yet reached (got ${pr.goalProgress.reached})`);
    }
  }

  console.log('beating the goal with a real earned PR caps pct at 100 and flags reached');
  {
    await logSession(u, 'Flat Barbell Bench Press', dateInWeek(0, 1), 230, 5);
    const prog = await get('/api/progress', u.token);
    const pr = prog.prs.find(p => p.exercise === 'Flat Barbell Bench Press');
    ok(pr.source === 'earned', `now an earned record (got ${pr.source})`);
    ok(!!pr.goalProgress, 'goalProgress carried over to the earned record (goal comes from the surviving seed)');
    if (pr.goalProgress) {
      ok(pr.goalProgress.pct === 100, `pct capped at 100, not 102 (got ${pr.goalProgress.pct})`);
      ok(pr.goalProgress.remaining === 0, `remaining floored at 0, not negative (got ${pr.goalProgress.remaining})`);
      ok(pr.goalProgress.reached === true, `reached is true (got ${pr.goalProgress.reached})`);
    }
  }

  console.log('a bodyweight exercise (weight 0) with a numeric goal gets no progress bar -- math doesn\'t apply');
  {
    await put('/api/me/seeds', { exercise: 'Pull-Up', weight: 0, reps: 8, goal: 15 }, u.token);
    const prog = await get('/api/progress', u.token);
    const pr = prog.prs.find(p => p.exercise === 'Pull-Up');
    ok(!!pr, 'Pull-Up seed is present');
    ok(pr && pr.goalProgress === null, `goalProgress is null for a bodyweight entry (got ${JSON.stringify(pr && pr.goalProgress)})`);
  }

  console.log('an assisted exercise with a goal also gets no progress bar -- no clean starting point to measure a percent against');
  {
    await put('/api/me/seeds', { exercise: 'Machine-Assisted Pull-Up', weight: 40, reps: 5, goal: 10 }, u.token);
    const prog = await get('/api/progress', u.token);
    const pr = prog.prs.find(p => p.exercise === 'Machine-Assisted Pull-Up');
    ok(!!pr, 'assisted seed is present');
    ok(pr && pr.goalProgress === null, `goalProgress is null for an assisted entry (got ${JSON.stringify(pr && pr.goalProgress)})`);
  }

  console.log('no goal set at all -> goalProgress stays null, nothing invented');
  {
    await put('/api/me/seeds', { exercise: 'Barbell Row', weight: 135, reps: 8 }, u.token);
    const prog = await get('/api/progress', u.token);
    const pr = prog.prs.find(p => p.exercise === 'Barbell Row');
    ok(!!pr && pr.goalProgress === null, `no goal -> null (got ${JSON.stringify(pr)})`);
  }

  console.log('cold-review catch: a goal set in one unit is converted correctly once the user switches units and later earns the record in the other unit');
  {
    const u2 = await reg('goal_unit', 'pass1234', 'Goal Unit');
    await post('/api/me/units', { units: 'kg' }, u2.token);
    // 100 kg goal, seeded while the account is on kg.
    await put('/api/me/seeds', { exercise: 'Barbell Row', weight: 40, reps: 8, goal: 100 }, u2.token);
    await post('/api/me/units', { units: 'lb' }, u2.token);
    // The account is on lb by the time the real record is logged, so the earned PR's own unit is
    // 'lb' -- the goal must be converted (100 kg ~= 220.5 lb), never compared to 185 raw.
    await logSession(u2, 'Barbell Row', dateInWeek(0, 1), 185, 5);
    const prog = await get('/api/progress', u2.token);
    const pr = prog.prs.find(p => p.exercise === 'Barbell Row');
    ok(pr.source === 'earned' && pr.unit === 'lb', `earned in lb (got ${JSON.stringify({ source: pr.source, unit: pr.unit })})`);
    ok(pr.goal === 220.5, `goal converted from 100 kg to 220.5 lb, not left as raw 100 (got ${pr.goal})`);
    ok(!!pr.goalProgress, 'goalProgress present');
    if (pr.goalProgress) {
      ok(pr.goalProgress.pct === 84, `pct computed against the CONVERTED goal (round(100*185/220.5)=84), not raw 100 (got ${pr.goalProgress.pct})`);
      ok(pr.goalProgress.reached === false, `NOT reached -- 185 lb is nowhere near a 220.5 lb goal, even though it would wrongly read >=100% against the raw unconverted number 100 (got ${pr.goalProgress.reached})`);
    }
  }
}

console.log(`\n${fails === 0 ? 'all assertions passed' : fails + ' assertion(s) FAILED'}`);
await cleanup();
process.exit(fails === 0 ? 0 : 1);
