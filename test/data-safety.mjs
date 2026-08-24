// Aug 17, 2026: a copy of production went from 639,995 bytes / 377 users to 112 bytes / 0
// users on a single boot, silently, with the server reporting healthy afterwards — a code
// bug caught a JSON parse failure and quietly substituted an empty database, which the boot
// migrations then wrote back over the real file. That specific failure mode (a shared JSON
// file that can be truncated/corrupted mid-write, and a parser that can silently paper over
// it) is what moving to Postgres actually eliminates — a transaction either fully commits or
// fully rolls back, and a SELECT can't return "corrupted" data, only real rows or a loud
// connection/query error. This file tests what's true of the NEW mechanism: Postgres being
// unreachable is loud and fatal (not silently empty), the JSON snapshot backup still gets
// written and pruned exactly as before, concurrent writes don't lose data, and there's a real
// documented recovery path if the live database is ever wrong.
//
// Run:  npm test
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';
import { PgConnection, parseConnString } from '../pgmini.js';

const PORT = process.env.TEST_PORT2 || 4941;
const B = `http://localhost:${PORT}`;
const CWD = new URL('..', import.meta.url).pathname;
let fails = 0, srv = null, srvDead = true;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };

// Resolves { started:true } or { started:false, err } — never rejects, because "does not start"
// is the expected result in some of these tests.
function boot(dir, databaseUrl) {
  return new Promise(res => {
    srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: databaseUrl, PORT: String(PORT) },
      cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    srvDead = false;
    let err = '', out = '', done = false;
    const finish = v => { if (!done) { done = true; res(v); } };
    srv.stderr.on('data', d => { err += d; });
    srv.stdout.on('data', d => { out += d; if (String(d).includes('CrewFit on')) finish({ started: true, out }); });
    // A process killed by a SIGNAL has exitCode null, so track liveness explicitly — stop()
    // waiting on an 'exit' that already fired hangs the whole suite.
    srv.on('exit', () => { srvDead = true; finish({ started: false, err, out }); });
    setTimeout(() => finish({ started: false, err: err || 'timeout', out }), 12000);
  });
}
const stop = () => new Promise(r => { if (!srv || srvDead) return r(); srv.on('exit', r); srv.kill(); });

function freshDir() { return mkdtempSync(join(tmpdir(), 'crewfit-safety-')); }
async function seed(dir, dbUrl) {
  const r = await boot(dir, dbUrl);
  if (!r.started) throw new Error('could not seed: ' + r.err);
  const h = { 'Content-Type': 'application/json' };
  const u = await fetch(B + '/api/register', { method: 'POST', headers: h,
    body: JSON.stringify({ username: 'u' + Math.floor(Math.random() * 1e9), pin: 'pass12', displayName: 'T' }) }).then(x => x.json());
  const H = { ...h, Authorization: 'Bearer ' + u.token };
  const s = await fetch(B + '/api/sessions', { method: 'POST', headers: H,
    body: JSON.stringify({ name: 'Push', visibility: 'private', scheduledAt: '2026-08-12T18:00:00Z',
      exercises: [{ name: 'Flat Barbell Bench Press', defaultSets: 3, defaultReps: 8, defaultRepsMax: 10 }] }) }).then(x => x.json());
  await fetch(B + `/api/sessions/${s.id}/log`, { method: 'POST', headers: H,
    body: JSON.stringify({ exerciseId: s.exercises[0].id, weight: 185, reps: 10 }) });
  await stop();
  return { H, username: u.user.username };
}
// Tokens live in memory only, so every restart invalidates them — log back in.
async function login(username) {
  const r = await fetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, pin: 'pass12' }) }).then(x => x.json());
  if (!r.token) throw new Error('login failed after restart: ' + JSON.stringify(r));
  return { 'Content-Type': 'application/json', Authorization: 'Bearer ' + r.token };
}
async function userCount(dbUrl) {
  const pg = new PgConnection(parseConnString(dbUrl));
  const r = await pg.query('SELECT count(*) as n FROM users');
  pg.close();
  return Number(r.rows[0].n);
}

const dirs = [];
const testDbs = [];
try {

// ─────────────────────────────────────────────────────────────────────────────
console.log('Postgres being unreachable is loud and fatal — never silently empty');
{
  const dir = freshDir(); dirs.push(dir);
  // A port nothing is listening on, so the connection fails fast and deterministically
  // rather than depending on DNS behavior for a fake hostname.
  const r = await boot(dir, 'postgres://postgres:wrong@127.0.0.1:1/nope');
  await stop();
  ok(!r.started, 'the server refuses to start rather than boot on an empty/unreachable database');
  ok(/FATAL/.test(r.err || '') || /FATAL/.test(r.out || ''), 'and says so loudly (was: silently serve an empty app reporting healthy)');
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\na healthy boot is backed up (JSON snapshot) before migrations touch the database');
{
  const dir = freshDir(); dirs.push(dir);
  const testDb = await freshTestDb('safety1'); testDbs.push(testDb);
  await seed(dir, testDb.url);
  const n = await userCount(testDb.url);
  const bdir = join(dir, 'backups');
  // seed()'s own boot (to register the user over HTTP) already wrote one backup of its own —
  // clear it so the assertion below is scoped to the ONE boot this test is actually about.
  rmSync(bdir, { recursive: true, force: true });
  const r = await boot(dir, testDb.url);
  ok(r.started, 'boots normally');
  const backups = existsSync(bdir) ? readdirSync(bdir).filter(x => x.endsWith('.json')) : [];
  ok(backups.length === 1, `one backup snapshot written on boot (found ${backups.length})`);
  ok(backups.length === 1 && Object.keys(JSON.parse(readFileSync(join(bdir, backups[0]), 'utf8')).users).length === n,
     `the snapshot holds the same ${n} user(s) as the live database`);
  const h = await fetch(B + '/healthz').then(x => x.json());
  ok(h.ok === true && h.users === n, `/healthz reports the real count, not a constant (${JSON.stringify(h)})`);
  await stop();
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nbackups are pruned, so they cannot fill the volume');
{
  const dir = freshDir(); dirs.push(dir);
  const testDb = await freshTestDb('safety2'); testDbs.push(testDb);
  await seed(dir, testDb.url);
  for (let i = 0; i < 13; i++) { const r = await boot(dir, testDb.url); if (!r.started) throw new Error('boot ' + i); await stop(); }
  const kept = readdirSync(join(dir, 'backups')).filter(x => x.endsWith('.json'));
  ok(kept.length === 10, `14 boots -> the newest 10 backups kept (found ${kept.length})`);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\na first run against an empty (but reachable) database is not treated as damage');
{
  const dir = freshDir(); dirs.push(dir);
  const testDb = await freshTestDb('safety3'); testDbs.push(testDb);
  const r = await boot(dir, testDb.url);
  ok(r.started, 'a genuinely empty database boots fine');
  const h = await fetch(B + '/healthz').then(x => x.json());
  ok(h.ok === true && h.users === 0, 'healthy with zero users');
  await stop();
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nconcurrent writes to the same session all land — nothing lost to a race');
{
  const dir = freshDir(); dirs.push(dir);
  const testDb = await freshTestDb('safety4'); testDbs.push(testDb);
  const { username } = await seed(dir, testDb.url);
  const r = await boot(dir, testDb.url); if (!r.started) throw new Error('boot failed');
  const H = await login(username);                       // the seed token died with the restart
  const s = await fetch(B + '/api/sessions', { method: 'POST', headers: H,
    body: JSON.stringify({ name: 'Pull', visibility: 'private', scheduledAt: '2026-08-13T18:00:00Z',
      exercises: [{ name: 'Barbell Row', defaultSets: 3, defaultReps: 8, defaultRepsMax: 10 }] }) }).then(x => x.json());
  await Promise.all(Array.from({ length: 40 }, (_, i) =>
    fetch(B + `/api/sessions/${s.id}/log`, { method: 'POST', headers: H,
      body: JSON.stringify({ exerciseId: s.exercises[0].id, weight: 135 + i, reps: 8 }) })));
  const after = await fetch(B + `/api/sessions/${s.id}`, { headers: H }).then(x => x.json());
  ok(Object.values(after.logs).flat().length === 40, `all 40 concurrently-logged sets are present (got ${Object.values(after.logs).flat().length})`);
  await stop();
  const r2 = await boot(dir, testDb.url);
  ok(r2.started, 'and it still boots afterwards');
  await stop();
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nthe documented recovery path (restore the newest JSON snapshot into Postgres) actually works');
{
  const dir = freshDir(); dirs.push(dir);
  const testDb = await freshTestDb('safety5'); testDbs.push(testDb);
  await seed(dir, testDb.url);
  const n = await userCount(testDb.url);
  await boot(dir, testDb.url); await stop();                            // makes a snapshot
  const bdir = join(dir, 'backups');
  const newest = readdirSync(bdir).filter(x => x.endsWith('.json')).sort().pop();

  // Simulate the database being wrong/lost — the scenario the recovery path exists for.
  const pg = new PgConnection(parseConnString(testDb.url));
  await pg.query('DELETE FROM users'); await pg.query('DELETE FROM sessions');
  pg.close();
  const wiped = await boot(dir, testDb.url); await stop();
  ok(wiped.started, 'a wiped-but-reachable database still boots (this is why backups matter — nothing here would stop it)');

  // The documented fix: re-run the migration script against the newest snapshot.
  const { execFileSync } = await import('node:child_process');
  execFileSync('node', ['scripts/migrate-to-postgres.mjs', join(bdir, newest)], { cwd: CWD, env: { ...process.env, DATABASE_URL: testDb.url } });

  const good = await boot(dir, testDb.url);
  ok(good.started, 'restoring the newest snapshot -> back up');
  const h = await fetch(B + '/healthz').then(x => x.json());
  ok(h.users === n, `and the ${n} user(s) are there (${h.users})`);
  await stop();
}

} finally {
  await stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  for (const d of testDbs) { try { await d.drop(); } catch (e) {} }
}

console.log(fails ? `\n${fails} FAILURE(S)\n` : '\nall assertions passed\n');
process.exit(fails ? 1 : 0);
