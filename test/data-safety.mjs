// The database is one JSON file. These assertions exist because on Aug 17, 2026 a copy of
// production went from 639,995 bytes and 377 users to 112 bytes and 0 users on a single boot,
// silently, with the server reporting healthy afterwards.
//
// Run:  npm test
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, copyFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = process.env.TEST_PORT2 || 4941;
const B = `http://localhost:${PORT}`;
const CWD = new URL('..', import.meta.url).pathname;
let fails = 0, srv = null, srvDead = true;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };

// Resolves { started:true } or { started:false, err } — never rejects, because "does not start"
// is the expected result in half of these tests.
function boot(dir) {
  return new Promise(res => {
    srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, PORT: String(PORT) },
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
async function seed(dir) {
  const r = await boot(dir);
  if (!r.started) throw new Error('could not seed: ' + r.err);
  const h = { 'Content-Type': 'application/json' };
  const u = await fetch(B + '/api/register', { method: 'POST', headers: h,
    body: JSON.stringify({ username: 'u' + Math.floor(Math.random() * 1e9), pin: '1234', displayName: 'T' }) }).then(x => x.json());
  const H = { ...h, Authorization: 'Bearer ' + u.token };
  const s = await fetch(B + '/api/sessions', { method: 'POST', headers: H,
    body: JSON.stringify({ name: 'Push', visibility: 'private', scheduledAt: '2026-08-12T18:00:00Z',
      exercises: [{ name: 'Flat Barbell Bench Press', defaultSets: 3, defaultReps: 8, defaultRepsMax: 10 }] }) }).then(x => x.json());
  await fetch(B + `/api/sessions/${s.id}/log`, { method: 'POST', headers: H,
    body: JSON.stringify({ exerciseId: s.exercises[0].id, weight: 185, reps: 10 }) });
  await stop();
  return { H, username: u.username || JSON.parse(readFileSync(join(dir,'data.json'),'utf8')) && Object.values(JSON.parse(readFileSync(join(dir,'data.json'),'utf8')).users)[0].username };
}
// Tokens live in memory only, so every restart invalidates them — log back in.
async function login(username) {
  const r = await fetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, pin: '1234' }) }).then(x => x.json());
  if (!r.token) throw new Error('login failed after restart: ' + JSON.stringify(r));
  return { 'Content-Type': 'application/json', Authorization: 'Bearer ' + r.token };
}
const users = f => Object.keys(JSON.parse(readFileSync(f, 'utf8')).users).length;

const dirs = [];
try {

// ─────────────────────────────────────────────────────────────────────────────
console.log('a damaged data.json must NOT be overwritten');
for (const [label, damage] of [
  ['truncated mid-write (what an interrupted save leaves)', s => s.slice(0, Math.floor(s.length * 0.6))],
  ['empty file (0 bytes)',                                  () => ''],
  ['valid JSON but not a database ({})',                    () => '{}'],
  ['valid JSON, wrong shape (an array)',                    () => '[]'],
]) {
  const dir = freshDir(); dirs.push(dir);
  await seed(dir);
  const f = join(dir, 'data.json');
  const before = readFileSync(f, 'utf8');
  writeFileSync(f, damage(before));
  const damaged = readFileSync(f, 'utf8');

  const r = await boot(dir);
  await stop();
  const after = readFileSync(f, 'utf8');

  ok(!r.started, `${label} -> the server refuses to start`);
  ok(after === damaged, `${label} -> the file is byte-for-byte untouched (${after.length} bytes)`);
  ok(/REFUSING TO START/.test(r.err || ''), `${label} -> says why, and where the backups are`);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\na healthy data.json still boots, and is backed up before migrations touch it');
{
  const dir = freshDir(); dirs.push(dir);
  await seed(dir);
  const f = join(dir, 'data.json');
  const n = users(f);
  const r = await boot(dir);
  ok(r.started, 'boots normally');
  const bdir = join(dir, 'backups');
  const backups = existsSync(bdir) ? readdirSync(bdir).filter(x => x.endsWith('.json')) : [];
  ok(backups.length === 1, `one backup written on boot (found ${backups.length})`);
  ok(backups.length === 1 && users(join(bdir, backups[0])) === n,
     `the backup holds the same ${n} user(s) as the live file`);
  const h = await fetch(B + '/healthz').then(x => x.json());
  ok(h.ok === true && h.users === n, `/healthz reports the real count, not a constant (${JSON.stringify(h)})`);
  await stop();
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nbackups are pruned, so they cannot fill the volume');
{
  const dir = freshDir(); dirs.push(dir);
  await seed(dir);
  for (let i = 0; i < 13; i++) { const r = await boot(dir); if (!r.started) throw new Error('boot ' + i); await stop(); }
  const kept = readdirSync(join(dir, 'backups')).filter(x => x.endsWith('.json'));
  ok(kept.length === 10, `14 boots -> the newest 10 backups kept (found ${kept.length})`);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\na first run with no data.json is not treated as damage');
{
  const dir = freshDir(); dirs.push(dir);
  const r = await boot(dir);
  ok(r.started, 'empty DATA_DIR boots');
  const h = await fetch(B + '/healthz').then(x => x.json());
  ok(h.ok === true && h.users === 0, 'healthy with zero users');
  await stop();
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nconcurrent writes never leave a half-written file');
{
  const dir = freshDir(); dirs.push(dir);
  const { username } = await seed(dir);
  const r = await boot(dir); if (!r.started) throw new Error('boot failed');
  const H = await login(username);                       // the seed token died with the restart
  const s = await fetch(B + '/api/sessions', { method: 'POST', headers: H,
    body: JSON.stringify({ name: 'Pull', visibility: 'private', scheduledAt: '2026-08-13T18:00:00Z',
      exercises: [{ name: 'Barbell Row', defaultSets: 3, defaultReps: 8, defaultRepsMax: 10 }] }) }).then(x => x.json());
  await Promise.all(Array.from({ length: 40 }, (_, i) =>
    fetch(B + `/api/sessions/${s.id}/log`, { method: 'POST', headers: H,
      body: JSON.stringify({ exerciseId: s.exercises[0].id, weight: 135 + i, reps: 8 }) })));
  await stop();
  const f = join(dir, 'data.json');
  let parsed = true;
  try { JSON.parse(readFileSync(f, 'utf8')); } catch (e) { parsed = false; }
  ok(parsed, '40 concurrent logged sets -> data.json is still valid JSON');
  ok(!existsSync(f + '.tmp'), 'no .tmp file left behind');
  const r2 = await boot(dir);
  ok(r2.started, 'and it still boots afterwards');
  await stop();
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nthe documented recovery actually works');
{
  const dir = freshDir(); dirs.push(dir);
  await seed(dir);
  const f = join(dir, 'data.json');
  const n = users(f);
  await boot(dir); await stop();                                    // makes a backup
  const bdir = join(dir, 'backups');
  const newest = readdirSync(bdir).filter(x => x.endsWith('.json')).sort().pop();
  writeFileSync(f, '{"users":');                                    // destroy it
  const bad = await boot(dir); await stop();
  ok(!bad.started, 'damaged -> down');
  copyFileSync(join(bdir, newest), f);                              // the documented fix
  const good = await boot(dir);
  ok(good.started, 'restore the newest backup over it -> back up');
  const h = await fetch(B + '/healthz').then(x => x.json());
  ok(h.users === n, `and the ${n} user(s) are there (${h.users})`);
  await stop();
}

} finally {
  await stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

console.log(fails ? `\n${fails} FAILURE(S)\n` : '\nall assertions passed\n');
process.exit(fails ? 1 : 0);
