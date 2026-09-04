// Sep 5 (Jeff, exercise-detail sheet: "add in what the users personal best is for that
// exercise"): GET /api/progress/exercise/:name grew a `pr` field, a direct DB.prs[userId][name]
// lookup converted to the caller's current display unit via the same inUnit() call already used
// for `seed` two lines above it. This exercise's own kg<->lb conversion path already had one real
// bug before (v249, test/pr-units.mjs: a PR stored with no `unit` field silently compared as lb
// no matter what it actually was) -- this test exists so a regression in the SAME conversion,
// now reused for this new field, doesn't ship unnoticed a second time.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const J = { 'Content-Type': 'application/json' };
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('progexpr');

function boot(port, dir) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; srv.stdout.on('data', d => { out += d; if (String(d).includes('CrewFit on')) res({ srv, out }); });
    srv.on('exit', () => res({ srv: null, out }));
    setTimeout(() => res({ srv, out }), 15000);
  });
}

const DIR = mkdtempSync(join(tmpdir(), 'progexpr-'));
const PORT = 4985, B = `http://localhost:${PORT}`;
const { srv } = await boot(PORT, DIR);
ok(!!srv, 'server boots');

const post = (p, b, tok) => fetch(B + p, { method: 'POST', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b) }).then(r => r.json());
const get = (p, tok) => fetch(B + p, { headers: tok ? { Authorization: 'Bearer ' + tok } : {} }).then(r => r.json());
const reg = (username, pin, displayName) => post('/api/register', { username, pin, displayName });

const EX = 'Flat Barbell Bench Press';

console.log('no history yet -> pr is null, not a crash or a fabricated value');
{
  const u = await reg('pep_none', 'pass1234', 'None');
  const r = await get('/api/progress/exercise/' + encodeURIComponent(EX), u.token);
  ok(!r.error, `endpoint responds cleanly (got ${JSON.stringify(r.error)})`);
  ok(r.pr === null, `pr is null with no logged history (got ${JSON.stringify(r.pr)})`);
}

console.log('an lb lifter gets their earned PR back in lb, matching what they logged');
{
  const u = await reg('pep_lb', 'pass1234', 'Lb');
  const s = await post('/api/sessions', { name: 'Push', scheduledAt: new Date().toISOString(), exercises: [{ name: EX }], inviteUsernames: [], visibility: 'private' }, u.token);
  await post(`/api/sessions/${s.id}/log`, { exerciseId: s.exercises[0].id, weight: 185, reps: 5 }, u.token);
  await post(`/api/sessions/${s.id}/lock`, {}, u.token);
  const r = await get('/api/progress/exercise/' + encodeURIComponent(EX), u.token);
  ok(!!r.pr, `pr is populated after a logged+locked set (got ${JSON.stringify(r.pr)})`);
  ok(r.pr && r.pr.weight === 185 && r.pr.reps === 5 && r.pr.unit === 'lb', `pr carries the exact logged weight/reps/unit (got ${JSON.stringify(r.pr)})`);
}

console.log("the exact bug class from v249 (pr-units.mjs): a kg lifter's PR must convert to lb correctly, not read raw kg as if it were lb");
{
  const u = await reg('pep_kg', 'pass1234', 'Kilo');
  await post('/api/me/units', { units: 'kg' }, u.token);
  const s = await post('/api/sessions', { name: 'Push', scheduledAt: new Date().toISOString(), exercises: [{ name: EX }], inviteUsernames: [], visibility: 'private' }, u.token);
  await post(`/api/sessions/${s.id}/log`, { exerciseId: s.exercises[0].id, weight: 100, reps: 5 }, u.token);
  await post(`/api/sessions/${s.id}/lock`, {}, u.token);

  const asKg = await get('/api/progress/exercise/' + encodeURIComponent(EX), u.token);
  ok(asKg.pr && asKg.pr.unit === 'kg' && asKg.pr.weight === 100, `viewed in kg, pr reads back as 100 kg unchanged (got ${JSON.stringify(asKg.pr)})`);

  await post('/api/me/units', { units: 'lb' }, u.token);
  const asLb = await get('/api/progress/exercise/' + encodeURIComponent(EX), u.token);
  // 100kg = 220.462 lb, inUnit() rounds to the nearest half-unit -> 220.5
  ok(asLb.pr && asLb.pr.unit === 'lb' && asLb.pr.weight === 220.5, `switched to lb, the same 100kg PR converts to 220.5 lb, not raw "100 lb" (got ${JSON.stringify(asLb.pr)})`);
}

srv.kill(); await testDb.drop();
console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
