// Training focus (NASM OPT Model phase), Sep 15 2026. Jeff asked for the NASM mapping, then to see
// it as a preview, then to build it for real. See TRAINING_PHASE_RANGES/repRange()'s own comment
// in server.js for the full reasoning.
//
// Verifies: a user with no phase set gets EXACTLY today's repRange() behavior (the exercise's own
// configured range) -- nothing silently changes for anyone who hasn't opened the picker; an invalid
// phase is rejected; a saved phase overrides every exercise's own range for FUTURE logged sets only
// (a set logged before the phase was set keeps its original target, same "snapshot at log time"
// rule PUT /api/sessions/:id already relies on for defaultReps/defaultRepsMax); switching phases
// changes the target again; GET /api/profile/me reports trainingPhase accurately (null until set);
// and the route requires auth.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const J = { 'Content-Type': 'application/json' };
const ROOT = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('trainingphase');

function boot(port, dir) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port) }, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; srv.stdout.on('data', d => { out += d; if (String(d).includes('CrewFit on')) res({ srv, out }); });
    srv.on('exit', () => res({ srv: null, out }));
    setTimeout(() => res({ srv, out }), 15000);
  });
}

const DIR = mkdtempSync(join(tmpdir(), 'trainingphase-'));
const PORT = 4995, B = `http://localhost:${PORT}`;
const { srv } = await boot(PORT, DIR);
ok(!!srv, 'server boots');

const post = (p, b, tok) => fetch(B + p, { method: 'POST', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b) }).then(r => r.json());
const get = (p, tok) => fetch(B + p, { headers: tok ? { Authorization: 'Bearer ' + tok } : {} }).then(r => r.json());
const reg = (username, pin, displayName) => post('/api/register', { username, pin, displayName });

async function logSquat(u) {
  const s = await post('/api/sessions', { name: 'Legs', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Barbell Back Squat' }], visibility: 'private' }, u.token);
  await post(`/api/sessions/${s.id}/log`, { exerciseId: s.exercises[0].id, weight: 225, reps: 5, setType: 'normal' }, u.token);
  const view = await get(`/api/sessions/${s.id}`, u.token);
  return { ...view.logs[u.user ? u.user.id : u.userId][0], sessionId: s.id };
}

console.log('unset phase reads null, and repRange() behaves exactly as before this feature existed');
{
  const u = await reg('phase_a', 'pass1234', 'Phase A');
  const prof = await get('/api/profile/me', u.token);
  ok(prof.trainingPhase === null, `trainingPhase is null before any pick (got ${JSON.stringify(prof.trainingPhase)})`);
  const entry = await logSquat(u);
  // Barbell Back Squat: compound + barbell + pattern 'legs' -> defaultTargetFor returns {reps:5},
  // no repsMax -- repRange()'s fallback collapses that to lo=hi=5 (targetRepsMax omitted when equal).
  ok(entry.targetReps === 5, `no phase set -> squat's OWN configured target of 5 reps, unchanged (got ${entry.targetReps})`);
  ok(entry.targetRepsMax === undefined, `no repsMax stamped when lo===hi, same as always (got ${entry.targetRepsMax})`);
}

console.log('an invalid phase is rejected, valid ones are not');
{
  const u = await reg('phase_b', 'pass1234', 'Phase B');
  const bad = await post('/api/me/training-phase', { phase: 'bulking_szn' }, u.token);
  ok(!!bad.error, `garbage phase key refused (got ${JSON.stringify(bad)})`);
  const good = await post('/api/me/training-phase', { phase: 'stabilization' }, u.token);
  ok(good.trainingPhase === 'stabilization', `valid phase accepted and echoed back (got ${JSON.stringify(good)})`);
}

console.log('a saved phase overrides the target on a NEW logged set, and does not retroactively touch one logged before the pick');
{
  const u = await reg('phase_c', 'pass1234', 'Phase C');
  const before = await logSquat(u);
  ok(before.targetReps === 5 && before.targetRepsMax === undefined, `set logged before any phase pick keeps squat's own 5-rep target (got ${JSON.stringify([before.targetReps, before.targetRepsMax])})`);

  const r = await post('/api/me/training-phase', { phase: 'stabilization' }, u.token);
  ok(r.trainingPhase === 'stabilization', 'phase saved');

  const after = await logSquat(u);
  ok(after.targetReps === 12 && after.targetRepsMax === 20, `set logged AFTER picking Stabilization gets its 12-20 range instead of squat's own (got ${JSON.stringify([after.targetReps, after.targetRepsMax])})`);

  const prof = await get('/api/profile/me', u.token);
  ok(prof.trainingPhase === 'stabilization', `GET /api/profile/me reports the saved phase (got ${prof.trainingPhase})`);

  // The earlier, pre-phase set is untouched -- a genuine re-GET of its session, not the stale
  // in-memory object from before the phase was saved, so this actually proves nothing was
  // recomputed on read.
  const beforeReread = await get(`/api/sessions/${before.sessionId}`, u.token);
  const beforeEntryNow = beforeReread.logs[u.user.id][0];
  ok(beforeEntryNow.targetReps === 5 && beforeEntryNow.targetRepsMax === undefined, `earlier entry, freshly re-fetched after the phase pick, still shows its original 5-rep target (got ${JSON.stringify([beforeEntryNow.targetReps, beforeEntryNow.targetRepsMax])})`);
}

console.log('switching to a different phase changes the target again');
{
  const u = await reg('phase_d', 'pass1234', 'Phase D');
  await post('/api/me/training-phase', { phase: 'hypertrophy' }, u.token);
  const hyp = await logSquat(u);
  ok(hyp.targetReps === 6 && hyp.targetRepsMax === 12, `Hypertrophy -> 6-12 (got ${JSON.stringify([hyp.targetReps, hyp.targetRepsMax])})`);

  await post('/api/me/training-phase', { phase: 'max_strength' }, u.token);
  const max = await logSquat(u);
  ok(max.targetReps === 1 && max.targetRepsMax === 5, `switched to Maximal Strength -> 1-5 (got ${JSON.stringify([max.targetReps, max.targetRepsMax])})`);
}

console.log('clearing a set phase (phase: null) returns to unset, and a set logged after clearing gets the exercise\'s own range back');
{
  const u = await reg('phase_e', 'pass1234', 'Phase E');
  await post('/api/me/training-phase', { phase: 'hypertrophy' }, u.token);
  const hyp = await logSquat(u);
  ok(hyp.targetReps === 6 && hyp.targetRepsMax === 12, `Hypertrophy set as a baseline -> 6-12 (got ${JSON.stringify([hyp.targetReps, hyp.targetRepsMax])})`);

  const cleared = await post('/api/me/training-phase', { phase: null }, u.token);
  ok(cleared.trainingPhase === null, `clearing echoes trainingPhase: null (got ${JSON.stringify(cleared)})`);

  const prof = await get('/api/profile/me', u.token);
  ok(prof.trainingPhase === null, `GET /api/profile/me reports null again after clearing (got ${prof.trainingPhase})`);

  const after = await logSquat(u);
  ok(after.targetReps === 5 && after.targetRepsMax === undefined, `set logged AFTER clearing gets squat's own 5-rep target back, not Hypertrophy's (got ${JSON.stringify([after.targetReps, after.targetRepsMax])})`);

  // The Hypertrophy-era set from before clearing is untouched -- same snapshot-at-log-time
  // guarantee as the earlier "does not retroactively touch" case above.
  const hypReread = await get(`/api/sessions/${hyp.sessionId}`, u.token);
  const hypEntryNow = hypReread.logs[u.user.id][0];
  ok(hypEntryNow.targetReps === 6 && hypEntryNow.targetRepsMax === 12, `earlier Hypertrophy-era entry, re-fetched after clearing, still shows 6-12 (got ${JSON.stringify([hypEntryNow.targetReps, hypEntryNow.targetRepsMax])})`);
}

console.log('auth required');
{
  const r = await post('/api/me/training-phase', { phase: 'hypertrophy' }, null);
  ok(!!r.error, `unauthenticated POST is refused (got ${JSON.stringify(r)})`);
}

srv.kill();
await testDb.drop();
console.log(fails === 0 ? '\nall assertions passed' : `\n${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
