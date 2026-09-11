// Sep 11 2026 (Jeff, verbatim): "I need you to do better and learn better with exercises and how
// they work for logging and tracking - for example, assisted machine pull ups - the more weight
// actually makes it easier and more of an assist. the less weight the better. Except its the
// opposite when tracking." A machine-assisted pull-up's entered number runs backwards from every
// other exercise in the app: LESS weight is the harder, more-improved set. Before this fix, every
// "bigger number wins" comparison in the app (PR detection, beatSeed, progression suggestions,
// the strength-trend chart's own per-session pick and changePct, plateau detection) silently
// judged it the wrong way.
//
// Real server + real Postgres, same harness family as test/progression.mjs / test/pr-set-record.mjs
// / test/plateau-flagging.mjs. Only "Machine-Assisted Pull-Up" (loadType:"assisted" in
// exercise-library.json) is affected today.
//
// Covers:
//   - rebuildAllPrs' weight record: LOWER assist wins, strictly (a tie does not steal the PR)
//   - the VOLUME/set-PR is never awarded to an assisted exercise, no matter how large the volume
//   - recordsFor's beatSeed: beating a seed means going lighter than it, not heavier
//   - recommendationsFor's ready suggestion: suggests LESS assist, clamped at 0, and stops
//     appearing entirely once already at 0 (nothing left to suggest)
//   - sessionsForUser's per-session "top set" pick: the LOWEST-weight set of a multi-set session
//     is the representative one, not the heaviest
//   - trendFor's own (separate) per-session pick, plus changePct/overall direction: assist
//     dropping over time must read as a POSITIVE change, not negative
//   - plateausFor's direction: a flat assist weight over the trailing window is a plateau; a
//     genuinely DROPPING assist weight is real progress, not a plateau
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const J = { 'Content-Type': 'application/json' };
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('assistedex');

function boot(port, dir) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; srv.stdout.on('data', d => { out += d; if (String(d).includes('CrewFit on')) res({ srv, out }); });
    srv.on('exit', () => res({ srv: null, out }));
    setTimeout(() => res({ srv, out }), 15000);
  });
}

const DIR = mkdtempSync(join(tmpdir(), 'assistedex-'));
const PORT = 4988, B = `http://localhost:${PORT}`;
const { srv } = await boot(PORT, DIR);
ok(!!srv, 'server boots');

const post = (p, b, tok) => fetch(B + p, { method: 'POST', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b) }).then(r => r.json());
const put = (p, b, tok) => fetch(B + p, { method: 'PUT', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b) }).then(r => r.json());
const get = (p, tok) => fetch(B + p, { headers: tok ? { Authorization: 'Bearer ' + tok } : {} }).then(r => r.json());
const reg = (username, pin, displayName) => post('/api/register', { username, pin, displayName });

const EX = 'Machine-Assisted Pull-Up';
function isoDaysAgo(n) {
  const d = new Date(); d.setUTCDate(d.getUTCDate() - n); d.setUTCHours(15, 0, 0, 0);
  return d.toISOString();
}
// One session, one working set -- mirrors test/progression.mjs's log() but returns the log
// response so the caller can inspect isPr/isSetPr on the exact set just posted.
async function logOne(u, whenIso, weight, reps, lo = 8, hi = 10) {
  const s = await post('/api/sessions', { name: EX, scheduledAt: whenIso,
    exercises: [{ name: EX, defaultSets: 3, defaultReps: lo, defaultRepsMax: hi }],
    inviteUsernames: [], visibility: 'private' }, u.token);
  const r = await post(`/api/sessions/${s.id}/log`, { exerciseId: s.exercises[0].id, weight, reps }, u.token);
  return r;
}
// One session, MULTIPLE working sets for the same exercise -- for exercising the "which set
// represents this session" pickers (sessionsForUser / trendFor's own inline one).
async function logMany(u, whenIso, sets, lo = 8, hi = 10) {
  const s = await post('/api/sessions', { name: EX, scheduledAt: whenIso,
    exercises: [{ name: EX, defaultSets: sets.length, defaultReps: lo, defaultRepsMax: hi }],
    inviteUsernames: [], visibility: 'private' }, u.token);
  let last;
  for (const [weight, reps] of sets) last = await post(`/api/sessions/${s.id}/log`, { exerciseId: s.exercises[0].id, weight, reps }, u.token);
  return last;
}
const ask = (u) => get('/api/progress/exercise/' + encodeURIComponent(EX), u.token);
const progress = (u) => get('/api/progress?weeks=13', u.token);
function shown(r) {
  if (r.ready) return 'READY';
  if (r.hold) return 'HOLD';
  if (r.soon) return 'ALMOST';
  return r.seed ? 'NOT_YET_SEEDED' : 'NOT_YET';
}

console.log('PR direction: LOWER assist weight wins, strictly -- a tie does not steal the record');
{
  const u = await reg('asex_pr', 'pass1234', 'PR');
  const r1 = await logOne(u, isoDaysAgo(21), 60, 8);
  const log1 = r1.logs[u.user.id].find(l => l.weight === 60 && l.reps === 8);
  ok(log1.isPr === true, `baseline 60 lb assist is a PR (nothing to beat yet), got isPr=${log1.isPr}`);

  let a = await ask(u);
  ok(a.pr && a.pr.weight === 60, `record reports 60 lb assist, got ${JSON.stringify(a.pr)}`);

  // Deliberately huge reps (volume 40*20=800, far bigger than 60*8=480) -- if the VOLUME/set-PR
  // logic ever leaked into an assisted exercise, THIS is the set it would wrongly crown.
  const r2 = await logOne(u, isoDaysAgo(14), 40, 20);
  const log2 = r2.logs[u.user.id].find(l => l.weight === 40 && l.reps === 20);
  ok(log2.isPr === true, `40 lb assist (less than 60) is a new PR, got isPr=${log2.isPr}`);
  ok(log2.isSetPr === false, `...but NOT a set/VOLUME PR -- assisted exercises never get one, got isSetPr=${log2.isSetPr}`);

  a = await ask(u);
  ok(a.pr && a.pr.weight === 40 && a.pr.reps === 20, `record now reports 40 lb assist, got ${JSON.stringify(a.pr)}`);
  ok(a.setPr === null, `setPr stays null for an assisted exercise however large the volume, got ${JSON.stringify(a.setPr)}`);

  // MORE assist (easier) must not steal the record even though 50 > 40.
  const r3 = await logOne(u, isoDaysAgo(7), 50, 5);
  const log3 = r3.logs[u.user.id].find(l => l.weight === 50 && l.reps === 5);
  ok(log3.isPr === false, `50 lb assist (more/easier than the 40 lb record) is NOT a PR, got isPr=${log3.isPr}`);
  a = await ask(u);
  ok(a.pr && a.pr.weight === 40, `record still reports 40 lb assist after a lighter/easier 50 lb set, got ${JSON.stringify(a.pr)}`);
}

console.log('\nbeatSeed direction: beating a seeded assist weight means going LIGHTER than it');
{
  const u = await reg('asex_seed', 'pass1234', 'Seed');
  await put('/api/me/seeds', { exercise: EX, weight: 45, reps: 5 }, u.token);

  // Earned PR (50) is MORE assist than the seed (45) -- easier, so the seed is not beaten.
  await logOne(u, isoDaysAgo(7), 50, 5);
  let prog = await progress(u);
  let rec = (prog.prs || []).find(p => p.exercise === EX);
  ok(!!rec, `an earned record for ${EX} exists`);
  ok(rec && rec.beatSeed === false, `50 lb assist (more than the 45 lb seed) has NOT beaten it, got beatSeed=${rec && rec.beatSeed}`);

  // Now a genuinely harder set (40, less than the 45 lb seed) -- this SHOULD beat the seed.
  await logOne(u, isoDaysAgo(0), 40, 5);
  prog = await progress(u);
  rec = (prog.prs || []).find(p => p.exercise === EX);
  ok(rec && rec.beatSeed === true, `40 lb assist (less than the 45 lb seed) HAS beaten it, got beatSeed=${rec && rec.beatSeed}`);
}

console.log('\nprogression suggestion: suggests LESS assist next time, clamped at 0, and stops once already at 0');
{
  const u = await reg('asex_prog', 'pass1234', 'Prog');
  // Session 1: TWO sets in one session -- 60x8 (not topped out) and 40x10 (topped out, top of an
  // 8-10 range). sessionsForUser must pick the LIGHTER (40) set as this session's representative
  // "top" set, not the heavier 60 -- picking 60 instead would read as not-topped-out (8 of 10) and
  // this exercise would never reach READY.
  await logMany(u, isoDaysAgo(14), [[60, 8], [40, 10]], 8, 10);
  // Session 2: 40x10 again -- topped out, same assist weight as session 1's (correctly-picked) top.
  await logOne(u, isoDaysAgo(7), 40, 10, 8, 10);

  const a = await ask(u);
  ok(shown(a) === 'READY', `two clean sessions at the same (correctly-picked) assist weight -> READY, got ${shown(a)} (${JSON.stringify(a)})`);
  if (a.ready) {
    ok(a.ready.weight === 40, `judged against the lighter 40 lb set, not the heavier 60 lb one, got ${a.ready.weight}`);
    ok(a.ready.suggested === 20, `suggests LESS assist next time (40 - 20 lb machine step = 20), got ${a.ready.suggested}`);
    ok(a.ready.lessIsMore === true, `flagged lessIsMore so the UI shows a down-arrow / "try X assist", got ${a.ready.lessIsMore}`);
  }
}
{
  const u = await reg('asex_clamp', 'pass1234', 'Clamp');
  // Topped out twice at 15 lb assist -- the naive suggestion (15 - 20) would go negative.
  await logOne(u, isoDaysAgo(14), 15, 10, 8, 10);
  await logOne(u, isoDaysAgo(7), 15, 10, 8, 10);
  const a = await ask(u);
  ok(shown(a) === 'READY' && a.ready && a.ready.suggested === 0, `15 lb assist twice -> suggestion clamps at 0 instead of going negative, got ${a.ready && a.ready.suggested}`);
}
{
  const u = await reg('asex_floor', 'pass1234', 'Floor');
  // Already at 0 assist (fully unassisted) twice -- nothing left to suggest, so this must NOT
  // show up as "ready" at all (suggesting "0 lb" again would be nonsense).
  await logOne(u, isoDaysAgo(14), 0, 10, 8, 10);
  await logOne(u, isoDaysAgo(7), 0, 10, 8, 10);
  const a = await ask(u);
  ok(!a.ready, `already at 0 lb assist twice -> no further suggestion offered, got ${JSON.stringify(a.ready)}`);
}

console.log("\nstrength trend: assist dropping over time reads as a POSITIVE change, and a session's own pick is the lighter set");
{
  const u = await reg('asex_trend', 'pass1234', 'Trend');
  // Session 1 has two sets -- trendFor's own per-session picker (separate code path from
  // sessionsForUser above) must also pick the LIGHTER (50) set as this session's point, not 70.
  await logMany(u, isoDaysAgo(21), [[70, 8], [50, 8]], 6, 10);
  await logOne(u, isoDaysAgo(7), 30, 8, 6, 10);

  const prog = await progress(u);
  const lift = (prog.trend && prog.trend.lifts || []).find(l => l.name === EX);
  ok(!!lift, `${EX} appears in the strength trend (2+ sessions), got ${JSON.stringify(prog.trend)}`);
  if (lift) {
    ok(lift.points[0].weight === 50, `session 1's point is the lighter 50 lb set, not the heavier 70 lb one, got ${lift.points[0].weight}`);
    ok(lift.points[1].weight === 30, `session 2's point is 30 lb, got ${lift.points[1].weight}`);
    ok(lift.lessIsMore === true, `flagged lessIsMore so the client flips its chart axis, got ${lift.lessIsMore}`);
    ok(lift.changePct > 0, `assist dropping from 50 to 30 lb reads as a POSITIVE changePct (improvement), got ${lift.changePct}`);
    ok(lift.currentWeight === 30, `currentWeight (the session changePct is computed against) is the lighter 30 lb set, got ${lift.currentWeight}`);
  }
  const overallLast = (prog.trend && prog.trend.overall || []).slice(-1)[0];
  ok(overallLast && overallLast.pct > 0, `overall trend also reads positive for an assisted lift's real improvement, got ${overallLast && overallLast.pct}`);
}

console.log('\nplateau detection: flat assist weight over the window is a plateau; a genuinely DROPPING one is not');
{
  const u = await reg('asex_plat_flat', 'pass1234', 'PlatFlat');
  await logOne(u, isoDaysAgo(70), 50, 8, 6, 10);   // baseline, well before the 6-week window
  await logOne(u, isoDaysAgo(30), 50, 8, 6, 10);   // 3 sessions inside the window, same assist
  await logOne(u, isoDaysAgo(20), 50, 8, 6, 10);
  await logOne(u, isoDaysAgo(10), 50, 8, 6, 10);
  const prog = await progress(u);
  const p = (prog.plateaus || []).find(x => x.exercise === EX);
  ok(!!p, `flat assist weight (no real change) IS flagged as a plateau, got ${JSON.stringify(prog.plateaus)}`);
}
{
  const u = await reg('asex_plat_prog', 'pass1234', 'PlatProg');
  await logOne(u, isoDaysAgo(70), 50, 8, 6, 10);   // baseline
  await logOne(u, isoDaysAgo(30), 30, 8, 6, 10);   // real progress: assist genuinely dropping
  await logOne(u, isoDaysAgo(20), 30, 8, 6, 10);
  await logOne(u, isoDaysAgo(10), 30, 8, 6, 10);
  const prog = await progress(u);
  const p = (prog.plateaus || []).find(x => x.exercise === EX);
  ok(!p, `assist weight genuinely dropping (50 -> 30) is NOT flagged as a plateau, got ${JSON.stringify(p)}`);
}

console.log('\nzero assist weight (a full, unassisted rep) is the BEST possible assisted set, not "incomplete" data -- estMax() returns 0 at weight 0, which is correctly treated as "nothing to compare" for every other loadType, but must not silently drop an assisted session from the trend chart / plateau detection the moment someone actually reaches it');
{
  const u = await reg('asex_zero_trend', 'pass1234', 'ZeroTrend');
  await logOne(u, isoDaysAgo(21), 20, 8, 6, 10);
  await logOne(u, isoDaysAgo(7), 0, 8, 6, 10);   // reached full, unassisted reps
  const prog = await progress(u);
  const lift = (prog.trend && prog.trend.lifts || []).find(l => l.name === EX);
  ok(!!lift, `a session at 0 lb assist does not get dropped as "incomplete" -- the lift still has 2 trend points, got ${JSON.stringify(prog.trend && prog.trend.lifts)}`);
  if (lift) {
    ok(lift.points.length === 2, `both sessions present, including the 0 lb one, got ${lift.points.length}`);
    ok(lift.points[1].weight === 0, `the most recent point is the 0 lb (fully unassisted) set, got ${lift.points[1].weight}`);
    ok(lift.changePct > 0, `dropping all the way to 0 lb assist reads as a POSITIVE changePct, got ${lift.changePct}`);
    ok(lift.currentWeight === 0, `currentWeight reports the 0 lb set, got ${lift.currentWeight}`);
  }
  // The overall blend divides by the SAME "best in window" est across every lift feeding it --
  // a 0 lb best would divide by zero there too, and because overall is one accumulator summed
  // across every lift, that would corrupt the WHOLE trend line (NaN/Infinity), not just this lift.
  const overallLast = (prog.trend && prog.trend.overall || []).slice(-1)[0];
  ok(overallLast && Number.isFinite(overallLast.pct), `overall trend stays a real, finite number even once a lift reaches 0 lb assist, got ${overallLast && overallLast.pct}`);
  ok(overallLast && overallLast.pct > 0, `...and reads positive, got ${overallLast && overallLast.pct}`);
}
{
  const u = await reg('asex_zero_plat', 'pass1234', 'ZeroPlat');
  // Baseline AND every in-window session at 0 lb assist -- flat at the floor, no further room to
  // drop. If 0 lb sessions were silently excluded (the bug), this exercise would never even reach
  // plateausFor's comparison (no points at all) and would look identical to "not flagged" for the
  // right reason -- so this asserts the POSITIVE case (flagged) to actually prove inclusion.
  await logOne(u, isoDaysAgo(70), 0, 8, 6, 10);
  await logOne(u, isoDaysAgo(30), 0, 8, 6, 10);
  await logOne(u, isoDaysAgo(20), 0, 8, 6, 10);
  await logOne(u, isoDaysAgo(10), 0, 8, 6, 10);
  const prog = await progress(u);
  const p = (prog.plateaus || []).find(x => x.exercise === EX);
  ok(!!p, `flat at 0 lb assist (baseline and every in-window session) IS flagged -- proves 0 lb sessions are counted, not dropped, got ${JSON.stringify(prog.plateaus)}`);
}

srv.kill(); await testDb.drop();
console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
