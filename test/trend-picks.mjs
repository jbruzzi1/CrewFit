// Strength trend used to auto-pick which lifts got a chip (whichever had the most logged
// history), unbounded. Jeff, Aug 19: "only select 5 workouts at a time... let the user pick which
// workouts they want to select rather than it using most recent exercises... a tab under it that
// allows us to select." This proves the real server behavior: a saved pick wins (in the order
// chosen), is capped at 5 and deduped server-side regardless of what the client sends, an invalid
// name is dropped rather than breaking the whole feature, and DB.prs / the "Personal Records"
// list (a completely separate feature) is never touched by any of this.
//
// Ported to the Postgres-backed test harness (Aug 2026 data-layer migration) — the original
// version predates that migration and hand-edited data.json directly (readFileSync/
// writeFileSync) to simulate a pre-existing/hand-written trendPicks row. That last case now goes
// through a direct Postgres UPDATE on the users table's `data` column instead, with the same
// stop-the-server/mutate/reboot shape as before (the running server holds DB in memory, loaded
// once at boot — an external write is only visible after a restart, in both the old file-based
// world and this one). No assertions changed.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';
import { PgConnection, parseConnString } from '../pgmini.js';

const PORT = 4996, B = `http://localhost:${PORT}`;
const DIR = mkdtempSync(join(tmpdir(), 'trend-picks-'));
const J = { 'Content-Type': 'application/json' };
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('trendpicks');
let srv, srvDead = false, fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const H = t => ({ ...J, Authorization: 'Bearer ' + t });
const post = (p, b, t) => fetch(B + p, { method: 'POST', headers: t ? H(t) : J, body: JSON.stringify(b) });
const get  = (p, t) => fetch(B + p, { headers: H(t) });
const stop = () => new Promise(r => { if (!srv || srvDead) return r(); srv.once('exit', () => { srvDead = true; r(); }); srv.kill(); });
const boot = () => new Promise(r => {
  srvDead = false;
  srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: DIR, DATABASE_URL: testDb.url, PORT: String(PORT) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.on('exit', () => { srvDead = true; });
  srv.stdout.on('data', d => { if (String(d).includes('CrewFit on')) r(); });
  setTimeout(r, 8000);
});
// Direct-Postgres equivalent of the old readFileSync/writeFileSync(data.json) hand-edit — patches
// one user's JSONB `data` row in place, same as reaching past the app to edit its storage by hand.
async function patchUser(userId, patch) {
  const pg = new PgConnection(parseConnString(testDb.url));
  const r = await pg.query('SELECT data FROM users WHERE id = $1', [userId]);
  const data = Object.assign(JSON.parse(r.rows[0].data), patch);
  await pg.query('UPDATE users SET data = $1 WHERE id = $2', [JSON.stringify(data), userId]);
  pg.close();
}
process.on('exit', () => { try { srv && srv.kill(); } catch {} try { rmSync(DIR, { recursive: true, force: true }); } catch {} });

await boot();

const alice = await post('/api/register', { username: 'alice', pin: 'pass1234', displayName: 'Alice' }).then(r => r.json());

// Log each exercise TWICE (across two sessions) so it clears the "2+ points" trend bar.
const LIFTS = ['Back Squat', 'Bench Press', 'Deadlift', 'Overhead Press', 'Barbell Row', 'Pull-Up'];
for (let round = 0; round < 2; round++) {
  const s = await post('/api/sessions', { name: `Day ${round}`, visibility: 'private',
    scheduledAt: new Date(Date.now() - (1 - round) * 86400000).toISOString(),
    exercises: LIFTS.map(name => ({ name })) }, alice.token).then(r => r.json());
  for (const ex of s.exercises) {
    await post(`/api/sessions/${s.id}/log`, { exerciseId: ex.id, weight: 135, reps: 5, set: 1 }, alice.token);
  }
}

console.log('\ndefault (no picks saved yet) is capped at 5, not unbounded');
{
  const d = await get('/api/progress', alice.token).then(r => r.json());
  ok(d.trend.lifts.length === 5, `6 eligible lifts logged, only 5 shown by default (got ${d.trend.lifts.length})`);
  ok(d.trend.allNames.length === 6, `all 6 are still listed in allNames for the picker (got ${d.trend.allNames.length})`);
  ok(Array.isArray(d.trend.picks) && d.trend.picks.length === 0, 'picks is empty until the user actually chooses');
}

console.log('\na saved pick wins, in the order the user chose it');
{
  const chosen = ['Pull-Up', 'Deadlift'];
  const r = await post('/api/me/trend-picks', { picks: chosen }, alice.token).then(r => r.json());
  ok(JSON.stringify(r.picks) === JSON.stringify(chosen), `save echoes back the picks in order (got ${JSON.stringify(r.picks)})`);

  const d = await get('/api/progress', alice.token).then(r => r.json());
  ok(JSON.stringify(d.trend.lifts.map(l => l.name)) === JSON.stringify(chosen),
    `trend.lifts now shows exactly the picked lifts, in that order (got ${JSON.stringify(d.trend.lifts.map(l => l.name))})`);
  ok(JSON.stringify(d.trend.picks) === JSON.stringify(chosen), 'trend.picks reflects the save, for the picker to pre-check');
}

console.log('\nmore than 5 picks is capped and deduped server-side, not trusted from the client');
{
  const spam = ['Back Squat', 'Back Squat', 'Bench Press', 'Deadlift', 'Overhead Press', 'Barbell Row', 'Pull-Up'];
  const r = await post('/api/me/trend-picks', { picks: spam }, alice.token).then(r => r.json());
  ok(r.picks.length === 5, `7 names (with a dupe) sent, saved list capped at 5 (got ${r.picks.length})`);
  ok(new Set(r.picks).size === r.picks.length, 'no duplicates in the saved list');

  const d = await get('/api/progress', alice.token).then(r => r.json());
  ok(d.trend.lifts.length === 5, 'trend.lifts also stays at 5');
}

console.log('\na non-array body is rejected outright');
{
  const r = await post('/api/me/trend-picks', { picks: 'Deadlift' }, alice.token);
  ok(r.status === 400, `got ${r.status}, expected 400`);
}

console.log('\npicks that no longer match anything fall back to the default, not an empty chart');
{
  await post('/api/me/trend-picks', { picks: ['Some Exercise That Was Renamed Or Deleted'] }, alice.token);
  const d = await get('/api/progress', alice.token).then(r => r.json());
  ok(d.trend.lifts.length === 5, `invalid pick is silently dropped and the default (5 lifts) shows instead of nothing (got ${d.trend.lifts.length})`);
}

console.log('\nnone of this touches DB.prs / the Personal Records list — a separate feature');
{
  await post('/api/me/trend-picks', { picks: ['Pull-Up'] }, alice.token);
  const d = await get('/api/progress', alice.token).then(r => r.json());
  ok(d.trend.lifts.length === 1, 'trend now shows just the one picked lift');
  ok((d.prs || []).length === 6, `all 6 Personal Records are still there regardless of the trend pick (got ${(d.prs||[]).length})`);
}

console.log('\na duplicate name already sitting in trendPicks (hand-edited row, not from the route) does not burn two of the five slots');
{
  // The POST route dedupes what IT writes, but trendFor() has to be defensive about what is
  // already sitting in the field regardless of how it got there - this writes straight into the
  // store, same as a pre-existing row or a future write path that skips the route.
  await stop();
  await patchUser(alice.user.id, { trendPicks: ['Bench Press', 'Bench Press', 'Back Squat'] });
  await boot();

  const d = await get('/api/progress', alice.token).then(r => r.json());
  const names = d.trend.lifts.map(l => l.name);
  ok(new Set(names).size === names.length, `no duplicate chip from a duplicate stored pick (got ${JSON.stringify(names)})`);
  ok(names.includes('Bench Press') && names.includes('Back Squat'), 'both distinct picked lifts still show');
}

try { srv && srv.kill(); } catch {}
rmSync(DIR, { recursive: true, force: true });
await testDb.drop();

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
