// Plateau flagging on the Progress page (Task #154, Sep 1). Approved list of "worth doing next"
// items -- designed and built without a separate spec round-trip with Jeff (same pattern as
// favorites / the top-right save button / seed-your-lifts itself: build it, show him the result).
//
// plateausFor(): a lift counts as "plateaued" only when BOTH (a) it's been trained
// PLATEAU_MIN_SESSIONS+ times WITHIN the trailing PLATEAU_WEEKS window (an abandoned lift is
// never flagged -- CLAUDE.md: never state something about the user you can't stand behind) AND
// (b) its best estimated max during that window never beats its best estimated max from BEFORE
// the window by more than PLATEAU_THRESHOLD. Reuses estMax's own Epley scoring, same function the
// Strength trend chart already uses, so a plateau is judged the same way progress already is.
//
// Verifies: a flat lift with enough recent sessions and a pre-window baseline IS flagged; a lift
// with real progress (reps or weight) is NOT; a lift with too few sessions inside the window is
// NOT (even if flat); a lift with no session before the window at all is NOT (no baseline to
// compare against); a bodyweight exercise never enters the pool at all (estMax returns 0 for it,
// same exclusion trendFor already relies on); weight is reported converted to the user's CURRENT
// unit (recordsFor/recommendationsFor's precedent, not trendFor's looser raw-weight one); and
// sort order follows the same push/pull/legs/core/cardio/other split recommendationsFor uses.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { freshTestDb } from './_pgtestdb.mjs';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const J = { 'Content-Type': 'application/json' };
const ROOT = new URL('..', import.meta.url).pathname;
const CWD = ROOT;
const testDb = await freshTestDb('plateau');

function boot(port, dir) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; srv.stdout.on('data', d => { out += d; if (String(d).includes('CrewFit on')) res({ srv, out }); });
    srv.on('exit', () => res({ srv: null, out }));
    setTimeout(() => res({ srv, out }), 15000);
  });
}

const DIR = mkdtempSync(join(tmpdir(), 'plateau-'));
const PORT = 4994, B = `http://localhost:${PORT}`;
const { srv } = await boot(PORT, DIR);
ok(!!srv, 'server boots');

const post = (p, b, tok) => fetch(B + p, { method: 'POST', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b) }).then(r => r.json());
const get = (p, tok) => fetch(B + p, { headers: tok ? { Authorization: 'Bearer ' + tok } : {} }).then(r => r.json());
const reg = (username, pin, displayName) => post('/api/register', { username, pin, displayName });

function isoDaysAgo(n) {
  const d = new Date(); d.setUTCDate(d.getUTCDate() - n); d.setUTCHours(15, 0, 0, 0);
  return d.toISOString();
}
async function logSession(u, name, exName, daysAgo, weight, reps) {
  const s = await post('/api/sessions', {
    name, scheduledAt: isoDaysAgo(daysAgo),
    exercises: [{ name: exName }], visibility: 'private',
  }, u.token);
  await post(`/api/sessions/${s.id}/log`, { exerciseId: s.exercises[0].id, weight, reps, setType: 'normal' }, u.token);
  return s;
}
function findPlateau(prog, name) { return (prog.plateaus || []).find(p => p.exercise === name); }

console.log('flat lift, enough recent sessions, pre-window baseline -> flagged');
{
  const u = await reg('plat_flat', 'pass1234', 'Plat Flat');
  // baseline well before the 6-week window
  await logSession(u, 'Legs -10w', 'Barbell Back Squat', 70, 200, 5);
  // 3 sessions inside the window, same weight/reps -- no real gain
  await logSession(u, 'Legs -30d', 'Barbell Back Squat', 30, 200, 5);
  await logSession(u, 'Legs -20d', 'Barbell Back Squat', 20, 200, 5);
  const last = await logSession(u, 'Legs -10d', 'Barbell Back Squat', 10, 200, 5);

  const prog = await get('/api/progress', u.token);
  ok(!prog.error, `progress loads (got ${prog.error})`);
  const p = findPlateau(prog, 'Barbell Back Squat');
  ok(!!p, `flat squat IS flagged as a plateau (got ${JSON.stringify(prog.plateaus)})`);
  if (p) {
    ok(p.group === 'legs', `group is legs (got ${p.group})`);
    ok(p.sessions === 3, `sessions counts only the 3 inside the trailing window (got ${p.sessions})`);
    ok(p.weeks === 6, `weeks reports the 6-week window (got ${p.weeks})`);
    ok(p.reps === 5, `reps is the most recent session's reps (got ${p.reps})`);
    ok(p.weight === 200, `weight is the most recent session's weight, in the user's unit (got ${p.weight})`);
    ok(p.bodyweight === false, `not flagged bodyweight (got ${p.bodyweight})`);
  }
}

console.log('real progress inside the window -> NOT flagged');
{
  const u = await reg('plat_progress', 'pass1234', 'Plat Progress');
  await logSession(u, 'Legs -10w', 'Barbell Back Squat', 70, 200, 5);          // baseline est ~233
  await logSession(u, 'Legs -30d', 'Barbell Back Squat', 30, 225, 5);          // window est ~262 -- real gain
  await logSession(u, 'Legs -20d', 'Barbell Back Squat', 20, 225, 5);
  await logSession(u, 'Legs -10d', 'Barbell Back Squat', 10, 225, 5);

  const prog = await get('/api/progress', u.token);
  const p = findPlateau(prog, 'Barbell Back Squat');
  ok(!p, `a lift that genuinely progressed is NOT flagged (got ${JSON.stringify(p)})`);
}

console.log('too few sessions inside the window -> NOT flagged, even though flat');
{
  const u = await reg('plat_toofew', 'pass1234', 'Plat Too Few');
  await logSession(u, 'Legs -10w', 'Barbell Back Squat', 70, 200, 5);   // baseline
  await logSession(u, 'Legs -20d', 'Barbell Back Squat', 20, 200, 5);   // only 2 in-window sessions
  await logSession(u, 'Legs -10d', 'Barbell Back Squat', 10, 200, 5);

  const prog = await get('/api/progress', u.token);
  const p = findPlateau(prog, 'Barbell Back Squat');
  ok(!p, `only 2 recent sessions (below the 3-session minimum) is NOT flagged -- an abandoned lift must never be flagged (got ${JSON.stringify(p)})`);
}

console.log('no session before the window at all -> NOT flagged (nothing to compare against)');
{
  const u = await reg('plat_nobaseline', 'pass1234', 'Plat No Baseline');
  // 3 sessions, all inside the trailing window, no history before it -- e.g. a brand new lift
  await logSession(u, 'Legs -30d', 'Barbell Back Squat', 30, 200, 5);
  await logSession(u, 'Legs -20d', 'Barbell Back Squat', 20, 200, 5);
  await logSession(u, 'Legs -10d', 'Barbell Back Squat', 10, 200, 5);

  const prog = await get('/api/progress', u.token);
  const p = findPlateau(prog, 'Barbell Back Squat');
  ok(!p, `no pre-window baseline -- not enough history to call it a plateau (got ${JSON.stringify(p)})`);
}

console.log('bodyweight exercise never enters the pool, no matter how flat');
{
  const u = await reg('plat_bw', 'pass1234', 'Plat Bodyweight');
  await logSession(u, 'Pull -10w', 'Pull-Up', 70, 0, 8);
  await logSession(u, 'Pull -30d', 'Pull-Up', 30, 0, 8);
  await logSession(u, 'Pull -20d', 'Pull-Up', 20, 0, 8);
  await logSession(u, 'Pull -10d', 'Pull-Up', 10, 0, 8);

  const prog = await get('/api/progress', u.token);
  const p = findPlateau(prog, 'Pull-Up');
  ok(!p, `a bodyweight exercise is never flagged -- estMax excludes it entirely, same as the trend chart (got ${JSON.stringify(p)})`);
}

console.log('weight is converted to the user\'s CURRENT unit (recommendationsFor precedent, not trendFor\'s raw one)');
{
  const u = await reg('plat_units', 'pass1234', 'Plat Units');
  await logSession(u, 'Legs -10w', 'Barbell Back Squat', 70, 200, 5);
  await logSession(u, 'Legs -30d', 'Barbell Back Squat', 30, 200, 5);
  await logSession(u, 'Legs -20d', 'Barbell Back Squat', 20, 200, 5);
  await logSession(u, 'Legs -10d', 'Barbell Back Squat', 10, 200, 5);

  await post('/api/me/units', { units: 'kg' }, u.token);
  const prog = await get('/api/progress', u.token);
  ok(prog.unit === 'kg', `progress reports the user's current unit (got ${prog.unit})`);
  const p = findPlateau(prog, 'Barbell Back Squat');
  ok(!!p, `still flagged after switching units (got ${JSON.stringify(prog.plateaus)})`);
  if (p) {
    ok(p.unit === 'kg', `plateau row's unit matches the user's current unit (got ${p.unit})`);
    const expectedKg = Math.round((200 / 2.2046226218) * 2) / 2;
    ok(Math.abs(p.weight - expectedKg) < 0.6, `200 lb logged reads back converted to ~${expectedKg} kg (got ${p.weight})`);
  }
}

console.log('sort order: legs before push before pull, matching recommendationsFor\'s group order');
{
  const u = await reg('plat_order', 'pass1234', 'Plat Order');
  // push
  await logSession(u, 'Push -10w', 'Flat Barbell Bench Press', 70, 135, 8);
  await logSession(u, 'Push -30d', 'Flat Barbell Bench Press', 30, 135, 8);
  await logSession(u, 'Push -20d', 'Flat Barbell Bench Press', 20, 135, 8);
  await logSession(u, 'Push -10d', 'Flat Barbell Bench Press', 10, 135, 8);
  // legs
  await logSession(u, 'Legs -10w', 'Barbell Back Squat', 70, 200, 5);
  await logSession(u, 'Legs -30d', 'Barbell Back Squat', 30, 200, 5);
  await logSession(u, 'Legs -20d', 'Barbell Back Squat', 20, 200, 5);
  await logSession(u, 'Legs -10d', 'Barbell Back Squat', 10, 200, 5);

  const prog = await get('/api/progress', u.token);
  ok((prog.plateaus || []).length === 2, `both lifts flagged (got ${(prog.plateaus || []).length})`);
  const names = (prog.plateaus || []).map(p => p.exercise);
  ok(names[0] === 'Barbell Back Squat' && names[1] === 'Flat Barbell Bench Press',
    `legs sorts before push (got ${JSON.stringify(names)})`);
}

console.log('auth required');
{
  const noAuth = await get('/api/progress', null);
  ok(noAuth.error !== undefined, `unauthenticated GET is refused (got ${JSON.stringify(noAuth)})`);
}

console.log(fails ? `\n${fails} FAILURE(S)\n` : '\nserver assertions passed\n');
if (srv) srv.kill();
rmSync(DIR, { recursive: true, force: true });
await testDb.drop();

// --- client markup checks ---------------------------------------------------------------------
console.log('client markup');
{
  const app = readFileSync(join(ROOT, 'public/app.js'), 'utf8');
  const html = readFileSync(join(ROOT, 'public/index.html'), 'utf8');

  ok(app.includes('const PLATEAU_MIN_SESSIONS = 3'), 'PLATEAU_MIN_SESSIONS constant present, mirroring the server');
  ok(app.includes('plateauHtml'), 'plateauHtml variable present in progressScreen');
  ok(/if\(\(d\.plateaus\|\|\[\]\)\.length\)/.test(app), 'plateau card only renders when d.plateaus has entries');
  ok(app.includes('Plateau watch'), 'section heading present');
  ok(app.includes('${plateauHtml}'), 'plateauHtml is wired into the rendered template');
  ok(/No change in estimated strength/.test(app), 'plateau section sub-heading present');
  ok(/no increase in estimated strength/.test(app), 'per-row explanation copy present');

  const vMatch = html.match(/app\.js\?v=(\d+)/);
  ok(!!vMatch && Number(vMatch[1]) >= 281, `cache-bust bumped to >= 281 (got ${vMatch && vMatch[1]})`);
}

console.log(fails ? `\n${fails} FAILURE(S)\n` : '\nall assertions passed\n');
process.exit(fails ? 1 : 0);
