// Sep 9 2026 (Jeff: "How do we feel on having a PR icon for heaviest weight for a rep and also a
// total volume for a set?... a set of 10 at my heaviest weight ive ever done is just as
// significant as a set of 2 just trying my max out on a weight"): rebuildAllPrs() grew a SECOND,
// independent "best ever" search per (user, exercise) -- weight x reps for a single set -- that
// runs alongside the existing heaviest-weight search without ever comparing against it. A set
// flags isSetPr on the log entry and lands in DB.prs[userId][name] as setWeight/setReps/setUnit/
// setAt/setFirstLog, the same object the weight record already lives on (see the comment in
// rebuildAllPrs -- no new persistence table, it rides the existing `prs` jsonb column in db.js).
// This test exists because the whole point of the feature is a case the old single-record system
// silently dropped: a big high-rep set at a real (not-quite-max) weight earned NOTHING under the
// weight-only rule. Real server + real Postgres.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const J = { 'Content-Type': 'application/json' };
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('prsetrec');

function boot(port, dir) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; srv.stdout.on('data', d => { out += d; if (String(d).includes('CrewFit on')) res({ srv, out }); });
    srv.on('exit', () => res({ srv: null, out }));
    setTimeout(() => res({ srv, out }), 15000);
  });
}

const DIR = mkdtempSync(join(tmpdir(), 'prsetrec-'));
const PORT = 4986, B = `http://localhost:${PORT}`;
const { srv } = await boot(PORT, DIR);
ok(!!srv, 'server boots');

const post = (p, b, tok) => fetch(B + p, { method: 'POST', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b) }).then(r => r.json());
const get = (p, tok) => fetch(B + p, { headers: tok ? { Authorization: 'Bearer ' + tok } : {} }).then(r => r.json());
const reg = (username, pin, displayName) => post('/api/register', { username, pin, displayName });

const EX = 'Flat Barbell Bench Press';
const logSet = (sid, exId, tok, weight, reps) => post(`/api/sessions/${sid}/log`, { exerciseId: exId, weight, reps }, tok);

console.log("Jeff's exact scenario: 245x2 stays the weight PR, 225x10 (never heavier) earns its own record instead of nothing");
{
  const u = await reg('psr_core', 'pass1234', 'Core');
  const s = await post('/api/sessions', { name: 'Push', scheduledAt: new Date().toISOString(), exercises: [{ name: EX }], inviteUsernames: [], visibility: 'private' }, u.token);
  const exId = s.exercises[0].id;

  await logSet(s.id, exId, u.token, 185, 8);   // baseline: weight PR AND set PR (first log wins both, nothing to beat yet)
  const afterMar = await logSet(s.id, exId, u.token, 225, 5);
  const afterMarLog = afterMar.logs[u.user.id].find(l => l.weight === 225 && l.reps === 5);
  ok(afterMarLog.isPr === true, `225x5 (heavier than 185x8) is a new weight PR (got isPr=${afterMarLog.isPr})`);
  // volume: 185x8=1480 vs 225x5=1125 -- 225x5 must NOT steal the set record from the still-bigger 185x8
  ok(afterMarLog.isSetPr === false, `225x5 (volume 1125 < 185x8's 1480) does NOT earn the set record (got isSetPr=${afterMarLog.isSetPr})`);

  const afterJun = await logSet(s.id, exId, u.token, 245, 2);
  const afterJunLog = afterJun.logs[u.user.id].find(l => l.weight === 245 && l.reps === 2);
  ok(afterJunLog.isPr === true, '245x2 (heaviest yet) is a new weight PR');
  ok(afterJunLog.isSetPr === false, `245x2 (volume 490) does not touch the set record either (got isSetPr=${afterJunLog.isSetPr})`);

  const afterToday = await logSet(s.id, exId, u.token, 225, 10);
  const mine = afterToday.logs[u.user.id];
  const todayLog = mine.find(l => l.weight === 225 && l.reps === 10);
  ok(todayLog.isPr === false, `225x10 is lighter than the standing 245 weight PR, so it does NOT get the PR badge (got isPr=${todayLog.isPr})`);
  ok(todayLog.isSetPr === true, `225x10 (volume 2250, beats 185x8's 1480) IS a new set record (got isSetPr=${todayLog.isSetPr})`);

  // and the 245x2 set must still be sitting there as the current weight PR -- logging 225x10 must not have stolen it
  const stillWeightPr = mine.find(l => l.weight === 245 && l.reps === 2);
  ok(stillWeightPr.isPr === true, "245x2 is still flagged isPr after a later set beat only the volume record");

  const r = await get('/api/progress/exercise/' + encodeURIComponent(EX), u.token);
  ok(r.pr && r.pr.weight === 245 && r.pr.reps === 2, `GET .../exercise's pr field reports the weight record (245x2), got ${JSON.stringify(r.pr)}`);
  ok(r.setPr && r.setPr.weight === 225 && r.setPr.reps === 10, `GET .../exercise's setPr field reports the set record (225x10), got ${JSON.stringify(r.setPr)}`);
}

console.log('one set can win both records at once');
{
  const u = await reg('psr_both', 'pass1234', 'Both');
  const s = await post('/api/sessions', { name: 'Push', scheduledAt: new Date().toISOString(), exercises: [{ name: EX }], inviteUsernames: [], visibility: 'private' }, u.token);
  const exId = s.exercises[0].id;
  await logSet(s.id, exId, u.token, 185, 5);
  const r2 = await logSet(s.id, exId, u.token, 250, 10);   // heavier AND bigger single-set volume
  const log = r2.logs[u.user.id].find(l => l.weight === 250 && l.reps === 10);
  ok(log.isPr === true && log.isSetPr === true, `a set that's both heavier and higher-volume gets both flags (got isPr=${log.isPr}, isSetPr=${log.isSetPr})`);
}

console.log('warm-ups and drop sets are excluded from the set record, same as they already are for the weight record');
{
  const u = await reg('psr_warm', 'pass1234', 'Warm');
  const s = await post('/api/sessions', { name: 'Push', scheduledAt: new Date().toISOString(), exercises: [{ name: EX }], inviteUsernames: [], visibility: 'private' }, u.token);
  const exId = s.exercises[0].id;
  // A huge warm-up set (would trivially "win" on raw weight*reps if counted)
  const warm = await post(`/api/sessions/${s.id}/log`, { exerciseId: exId, weight: 400, reps: 20, setType: 'warmup' }, u.token);
  const warmLog = warm.logs[u.user.id].find(l => l.setType === 'warmup');
  ok(warmLog.isSetPr === false, `a warm-up set never earns the set record however big it is (got isSetPr=${warmLog.isSetPr})`);
  const real = await logSet(s.id, exId, u.token, 135, 8);
  const realLog = real.logs[u.user.id].find(l => l.setType !== 'warmup');
  ok(realLog.isSetPr === true, 'the first real working set becomes the set record instead, ignoring the bigger warm-up');
}

console.log('a bodyweight exercise (weight always 0) must not let the first-ever set become an unbeatable set record -- volume is 0x(any reps)=0 for every bodyweight set, so the tie-break has to fall back to reps, same fix already applied to the weight record for the same reason');
{
  const u = await reg('psr_bw', 'pass1234', 'Bw');
  const s = await post('/api/sessions', { name: 'Pull', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Pull-Up' }], inviteUsernames: [], visibility: 'private' }, u.token);
  const exId = s.exercises[0].id;
  const first = await logSet(s.id, exId, u.token, 0, 3);
  const firstLog = first.logs[u.user.id].find(l => l.reps === 3);
  ok(firstLog.isSetPr === true, 'the first-ever bodyweight set starts as the set record (nothing to beat yet)');
  const bigger = await logSet(s.id, exId, u.token, 0, 15);
  const mine = bigger.logs[u.user.id];
  const biggerLog = mine.find(l => l.reps === 15);
  const firstAfter = mine.find(l => l.reps === 3);
  ok(biggerLog.isSetPr === true, `a harder bodyweight set (15 reps vs 3) takes over the set record (got isSetPr=${biggerLog.isSetPr})`);
  ok(firstAfter.isSetPr === false, `...and the smaller 3-rep set loses it (got isSetPr=${firstAfter.isSetPr})`);
}

srv.kill(); await testDb.drop();
console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
