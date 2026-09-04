// Sep 5 (Jeff: "I was having an off day and exhausted so didn't lift my heaviest ... it dropped
// my strength trend a ton overall"): trendFor()'s overall % and each lift's own changePct used to
// read "now" as literally that lift's single most recent session's best set — one rough day,
// especially one that touched several lifts at once, yanked the whole overall number down
// immediately, with nothing to recover it until the NEXT session on every affected lift
// individually beat it. currentEst() (server.js, inside trendFor) now reads "now" as the BEST
// estimated max across a lift's last TREND_SMOOTH_SESSIONS sessions instead — the exact same
// instinct plateausFor() already applies ("one rough or one lucky session ... doesn't flip the
// flag"), reused here. An individual lift's own chart (`lift.points`) stays the raw literal
// per-session values on purpose, so a real off day is still honestly visible there — only the
// OVERALL line/number and changePct (the per-lift headline used in "what's driving it") smooth.
//
// Run:  npm test
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';

const PORT = process.env.TEST_PORT || 4933;
const B = `http://localhost:${PORT}`;
const DIR = mkdtempSync(join(tmpdir(), 'crewfit-test-trendsmooth-'));
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('trendsmooth');
let fails = 0, srv = null;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };

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

async function newUser() {
  const u = 'u' + Math.floor(Math.random() * 1e9);
  const r = await fetch(B + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u, pin: 'pass12', displayName: 'T' }) }).then(x => x.json());
  if (!r.token) throw new Error('register failed: ' + JSON.stringify(r));
  return { H: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + r.token } };
}
// one session, one working set, real reps (no RIR) -- matches "genuinely didn't lift my heaviest,"
// not "held reps back on purpose" (that's estMax's separate RIR bump, already covered by rir.mjs).
async function log({ H }, name, date, weight, reps) {
  const s = await fetch(B + '/api/sessions', { method: 'POST', headers: H,
    body: JSON.stringify({ name, visibility: 'private', scheduledAt: date,
      exercises: [{ name, defaultSets: 3, defaultReps: reps }] }) }).then(x => x.json());
  await fetch(B + `/api/sessions/${s.id}/log`, { method: 'POST', headers: H,
    body: JSON.stringify({ exerciseId: s.exercises[0].id, weight, reps }) });
}
const progress = ({ H }) => fetch(B + '/api/progress?weeks=13', { headers: H }).then(x => x.json());
// Same Epley formula and rounding as estMax()/trendFor() in server.js -- reused to compute
// expected values, not to duplicate the fix under test.
const est = (weight, reps) => Math.round(weight * (1 + reps / 30));

await boot();
try {

console.log('a single off-day session no longer tanks that lift\'s own headline change% -- the raw chart point still shows the real dip');
{
  const u = await newUser();
  const NAME = 'Flat Barbell Bench Press';
  await log(u, NAME, '2026-08-01T18:00:00Z', 200, 5);   // baseline
  await log(u, NAME, '2026-08-08T18:00:00Z', 210, 5);
  await log(u, NAME, '2026-08-15T18:00:00Z', 220, 5);   // this session's peak
  await log(u, NAME, '2026-08-22T18:00:00Z', 180, 5);   // the off day -- genuinely lighter, most recent

  const p = await progress(u);
  const lift = (p.trend.lifts || []).find(l => l.name === NAME);
  ok(!!lift, `${NAME} has a trend entry`);
  ok(lift.points.length === 4, `all 4 real sessions are on the chart (got ${lift.points.length})`);
  ok(lift.points[3].est === est(180, 5), `the chart's own last point is the literal, un-smoothed off-day set (got ${lift.points[3].est}, expected ${est(180, 5)})`);

  const oldWay = Number(((est(180, 5) / est(200, 5) - 1) * 100).toFixed(1));
  const newWay = Number(((est(220, 5) / est(200, 5) - 1) * 100).toFixed(1));
  ok(oldWay < 0, `sanity: the OLD literal-latest-session logic would have read this as a regression (${oldWay}%)`);
  ok(lift.changePct === newWay, `changePct instead reflects the best of the last 3 sessions, 220 not 180 (got ${lift.changePct}%, expected ${newWay}%)`);
  ok(lift.changePct > 0, `so the headline still reads as real progress, not a drop (got ${lift.changePct}%)`);
  ok(lift.currentWeight === 220, `currentWeight names the session changePct actually came from (220), not the off-day's 180 -- "what's driving it" must never show a lighter weight next to a green up-arrow (got ${lift.currentWeight})`);
}

console.log('\nan off day that touches SEVERAL lifts at once no longer craters the overall trend for that date');
{
  const u = await newUser();
  const A = 'Barbell Back Squat', BEX = 'Conventional Deadlift';
  // Three up-trending sessions on both lifts, same three dates.
  await log(u, A, '2026-08-01T18:00:00Z', 200, 5);
  await log(u, BEX, '2026-08-01T18:00:00Z', 250, 5);
  await log(u, A, '2026-08-08T18:00:00Z', 210, 5);
  await log(u, BEX, '2026-08-08T18:00:00Z', 260, 5);
  await log(u, A, '2026-08-15T18:00:00Z', 220, 5);   // peak for both, before the bad day
  await log(u, BEX, '2026-08-15T18:00:00Z', 270, 5);

  const before = await progress(u);
  const pctAtPeak = before.trend.overall.find(d => d.at === '2026-08-15').pct;

  // The off day: BOTH lifts logged lighter than their prior session, same as Jeff's real report.
  await log(u, A, '2026-08-22T18:00:00Z', 180, 5);
  await log(u, BEX, '2026-08-22T18:00:00Z', 230, 5);

  const after = await progress(u);
  const overallByDate = Object.fromEntries(after.trend.overall.map(d => [d.at, d.pct]));
  ok(overallByDate['2026-08-15'] === pctAtPeak, `the earlier date's overall % is unchanged by data logged after it (got ${overallByDate['2026-08-15']}, expected ${pctAtPeak})`);
  ok(overallByDate['2026-08-22'] === pctAtPeak, `the off-day's own overall % holds at the pre-dip level -- the last 3 sessions per lift still peak before the dip (got ${overallByDate['2026-08-22']}, expected ${pctAtPeak})`);
  ok(pctAtPeak > 0, `sanity: there was real progress to preserve here (got ${pctAtPeak}%)`);
}

console.log('\nwith only 2 sessions and real progress, the fix changes nothing -- best-of-window is just the later, heavier session, same as before');
{
  const u = await newUser();
  const NAME = 'Barbell Row';
  await log(u, NAME, '2026-08-01T18:00:00Z', 115, 8);
  await log(u, NAME, '2026-08-08T18:00:00Z', 135, 8);   // heavier second session -- genuine progress

  const p = await progress(u);
  const lift = (p.trend.lifts || []).find(l => l.name === NAME);
  const literalLastWay = Number(((est(135, 8) / est(115, 8) - 1) * 100).toFixed(1));
  ok(lift.changePct === literalLastWay, `best-of-window over only 2 rising points is just those 2 points, same as the old literal-last behavior (got ${lift.changePct}%, expected ${literalLastWay}%)`);
}

console.log('\nwith only 2 sessions and a lighter second one, the fix reads it as "holding steady" (0%) rather than a same-day regression -- there is no 3rd, still-earlier session for the window to fall back on');
{
  const u = await newUser();
  const NAME = 'Lat Pulldown';
  await log(u, NAME, '2026-08-01T18:00:00Z', 135, 8);
  await log(u, NAME, '2026-08-08T18:00:00Z', 115, 8);   // lighter second session, e.g. an off day

  const p = await progress(u);
  const lift = (p.trend.lifts || []).find(l => l.name === NAME);
  const oldWay = Number(((est(115, 8) / est(135, 8) - 1) * 100).toFixed(1));
  ok(oldWay < 0, `sanity: the OLD literal-latest logic would have shown a same-day regression (${oldWay}%)`);
  ok(lift.changePct === 0, `the fix instead holds at 0% -- best-of-window (only 2 sessions available) is the earlier, heavier one, itself the baseline (got ${lift.changePct}%)`);
}

} finally {
  await stop();
  await testDb.drop();
}
console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
