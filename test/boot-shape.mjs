// A malformed session row must not stop the server booting, and must heal itself on load.
//
// This app has a documented history of hand-editing data.json to repair accounts
// (migrateMergeDuplicateBrian, the PIN-reset note in DEPLOY.md). A row shaped by an older schema or
// a hand edit fails two different ways, both closed by migrateSessionShapes() healing every row at
// boot before anything walks it:
//   - BOOT CRASH: a non-array logs[uid], a null set slot, or a non-array `invited` throws inside a
//     boot migration (which walk logs/invited before app.listen, no try/catch) — the whole app
//     fails to start, for everyone, until the file is hand-fixed.
//   - READ 500: a non-array history or a null history row throws in profileOf — the Profile/feed
//     tab 500s for everyone, though the server itself boots.
// This proves both, by booting a real server on each malformed shape.
//
// It also proves the heal is a NO-OP on well-formed data (the "healed" log line never appears), so
// the fix cannot quietly rewrite a healthy database.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const CWD = new URL('..', import.meta.url).pathname;
const J = { 'Content-Type': 'application/json' };

function seedAndBoot(sessionRow, port, extraSessions = {}, extraUsers = {}) {
  const DIR = mkdtempSync(join(tmpdir(), 'bootshape-'));
  const db = {
    users: Object.assign({ u1: { id: 'u1', username: 'alice', displayName: 'Alice', friends: [], units: 'lb',
      createdAt: '2026-01-01T00:00:00.000Z', pinHash: 'x', pinSalt: 'y' } }, extraUsers),
    sessions: Object.assign({ s1: sessionRow === null ? null : Object.assign({ id: 's1', creatorId: 'u1',
      scheduledAt: '2026-01-01T00:00:00.000Z', status: 'draft', visibility: 'private', name: 'Legacy',
      participants: ['u1'], exercises: [{ id: 'e1', name: 'Bench Press' }] }, sessionRow) }, extraSessions),
    prs: {}, pushSubs: {}, templates: {}, seeds: {}, customExercises: {}, friendships: {},
  };
  writeFileSync(join(DIR, 'data.json'), JSON.stringify(db));
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: DIR, PORT: String(port) },
      cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', booted = false;
    srv.stdout.on('data', d => { out += d; if (String(d).includes('CrewFit on')) { booted = true; res({ srv, DIR, booted, out }); } });
    srv.on('exit', () => { if (!booted) res({ srv: null, DIR, booted: false, out }); });
    setTimeout(() => { if (!booted) res({ srv, DIR, booted: false, out }); }, 8000);
  });
}
const rd = h => JSON.parse(readFileSync(join(h.DIR, 'data.json'), 'utf8'));
const done = h => { try { h.srv && h.srv.kill(); } catch {} try { rmSync(h.DIR, { recursive: true, force: true }); } catch {} };

console.log('a malformed session row heals at boot instead of crashing the server');

// 1. logs[uid] as an object (not an array) — crashed the boot migration before app.listen
let h = await seedAndBoot({ logs: { u1: { not: 'an array' } }, history: [] }, 4991);
ok(h.booted, 'boots with logs[uid] as an object (was: crash before app.listen)');
if (h.booted) ok(Array.isArray(rd(h).sessions.s1.logs.u1), 'and logs[uid] is healed to an array on disk');
ok(/migrateSessionShapes: healed 1/.test(h.out), 'and the boot log reports it healed the row');
done(h);

// 2. a null slot inside logs[uid] — crashed on l.exerciseName
h = await seedAndBoot({ logs: { u1: [null, { exerciseId: 'e1', exerciseName: 'Bench Press', weight: 100, reps: 8, set: 1, setType: 'normal', at: '2026-01-02T00:00:00.000Z' }] }, history: [] }, 4992);
ok(h.booted, 'boots with a null slot in logs[uid]');
if (h.booted) { const a = rd(h).sessions.s1.logs.u1; ok(Array.isArray(a) && a.length === 1 && a[0].reps === 8, 'null slot dropped, real set kept'); }
done(h);

// 3. history as a non-array object — 500'd /api/profile for everyone
h = await seedAndBoot({ logs: {}, history: { bogus: true } }, 4993);
ok(h.booted, 'boots with a non-array history');
if (h.booted) {
  const reg = await fetch('http://localhost:4993/api/register', { method: 'POST', headers: J, body: JSON.stringify({ username: 'bob', pin: 'pass1234', displayName: 'Bob' }) }).then(r => r.json());
  const pr = await fetch('http://localhost:4993/api/profile/me', { headers: { Authorization: 'Bearer ' + reg.token } });
  ok(pr.status === 200, `GET /api/profile/me returns ${pr.status}, not 500`);
}
done(h);

// 4. a null row inside history — passes Array.isArray, but h.userId throws
h = await seedAndBoot({ logs: {}, history: [null, { userId: 'u1', date: '2026-01-02' }] }, 4994);
ok(h.booted, 'boots with a null slot in history');
if (h.booted) {
  const reg = await fetch('http://localhost:4994/api/register', { method: 'POST', headers: J, body: JSON.stringify({ username: 'carol', pin: 'pass1234', displayName: 'Carol' }) }).then(r => r.json());
  const pr = await fetch('http://localhost:4994/api/profile/u1', { headers: { Authorization: 'Bearer ' + reg.token } });
  ok(pr.status === 200, `GET /api/profile/:id with a null history row returns ${pr.status}, not 500`);
  const hh = rd(h).sessions.s1.history; ok(Array.isArray(hh) && hh.length === 1, 'null history row dropped, real one kept');
}
done(h);

// 5. a session that is itself null — must not crash the heal loop or the migrations after it
h = await seedAndBoot({ logs: {}, history: [] }, 4995, { bad: null });
ok(h.booted, 'boots with a null session entry alongside a good one');
if (h.booted) { const ss = rd(h).sessions; ok(!('bad' in ss) && 's1' in ss, 'null session dropped, good one kept'); }
done(h);

// 6. NO-OP PROOF: a fully well-formed DB must heal nothing (the fix cannot rewrite healthy data)
h = await seedAndBoot({ invited: [], logs: { u1: [{ exerciseId: 'e1', exerciseName: 'Bench Press', weight: 100, reps: 8, set: 1, setType: 'normal', at: '2026-01-02T00:00:00.000Z' }] }, history: [{ userId: 'u1', date: '2026-01-02' }], attendance: {}, comments: [], suggestedEdits: [], variations: {}, joinRequests: [] }, 4996);
ok(h.booted, 'boots with a fully well-formed session');
ok(!/migrateSessionShapes: healed/.test(h.out), 'and heals NOTHING — the boot log line never appears on clean data');
if (h.booted) { const a = rd(h).sessions.s1.logs.u1; ok(Array.isArray(a) && a.length === 1 && a[0].reps === 8, 'the well-formed set is untouched'); }
done(h);

// 7. a non-array `invited` crashes migrateMergeDuplicateBrian (a BOOT migration) when both of the
//    real duplicate-Brian accounts are present — the exact residual boot-crash a cold review found.
const BRIAN_KEEP = '3o09ct9a', BRIAN_DROP = 'f91omrrz';
h = await seedAndBoot({ invited: { bogus: true }, logs: {}, history: [] }, 4997, {}, {
  [BRIAN_KEEP]: { id: BRIAN_KEEP, username: 'brian', displayName: 'Brian', friends: [], units: 'lb', createdAt: '2026-01-01T00:00:00.000Z', pinHash: 'x', pinSalt: 'y' },
  [BRIAN_DROP]: { id: BRIAN_DROP, username: 'brian2', displayName: 'Brian2', friends: [], units: 'lb', createdAt: '2026-01-01T00:00:00.000Z', pinHash: 'x', pinSalt: 'y' },
});
ok(h.booted, 'boots with a non-array invited while the Brian-merge migration is pending (was: crash before app.listen)');
if (h.booted) ok(Array.isArray(rd(h).sessions.s1.invited), 'and invited is healed to an array on disk');
done(h);

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
