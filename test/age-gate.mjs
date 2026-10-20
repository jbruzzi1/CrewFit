// Oct 20 2026 (app-store readiness review -- "13+ self-attestation", Jeff's call: a checkbox,
// not a collected birthdate). POST /api/register (server.js, right after the username+pin
// required check) now hard-refuses registration without `ageConfirmed` truthy -- same
// enforcement level as the username/password checks right next to it, not a UI-only nicety.
// That change required updating every one of the ~117 other test files that register a user
// purely as fixture setup (none of them exercise the gate itself). THIS file is the one that
// actually tests the feature: missing/falsy ageConfirmed is rejected with the real error
// message and no account is created; a truthy ageConfirmed succeeds and the attestation is
// persisted on the user record (nothing more than the yes/no fact -- no birthdate stored).
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';
import { PgConnection, parseConnString } from '../pgmini.js';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const J = { 'Content-Type': 'application/json' };
const CWD = new URL('..', import.meta.url).pathname;

function boot(port, dir, databaseUrl) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: databaseUrl, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; srv.stdout.on('data', d => { out += d; if (String(d).includes('CrewFit on')) res(srv); });
    srv.on('exit', () => res(null));
    setTimeout(() => res(srv), 8000);
  });
}

const DIR = mkdtempSync(join(tmpdir(), 'agegate-'));
const testDb = await freshTestDb('agegate');
const PORT = 4797, BASE = `http://localhost:${PORT}`;

let srv = null;
let cleanedUp = false;
async function cleanup() {
  if (cleanedUp) return; cleanedUp = true;
  try { if (srv) srv.kill(); } catch {}
  try { await testDb.drop(); } catch {}
}
process.on('uncaughtException', async (e) => { console.error('UNCAUGHT', e); await cleanup(); process.exit(1); });
process.on('unhandledRejection', async (e) => { console.error('UNHANDLED', e); await cleanup(); process.exit(1); });

srv = await boot(PORT, DIR, testDb.url);
if (!srv) { console.log('FAIL: server did not boot'); await cleanup(); process.exit(1); }

const api = (body) => fetch(BASE + '/api/register', { method: 'POST', headers: J, body: JSON.stringify(body) }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }));
const rand = () => Math.random().toString(36).slice(2, 8);

try {

console.log('registration without ageConfirmed at all is refused with the real error message, no account created');
{
  const uname = 'ag_missing_' + rand();
  const r = await api({ username: uname, pin: '12345678', displayName: 'No Flag' });
  ok(r.status === 400, `omitting ageConfirmed gets a 400 (got status ${r.status})`);
  ok(r.json && r.json.error === 'You must confirm you are at least 13 years old to create an account.',
    `error message matches the real server copy (got ${JSON.stringify(r.json && r.json.error)})`);
  ok(!r.json.token, `no token is issued (got ${JSON.stringify(r.json && r.json.token)})`);

  const login = await fetch(BASE + '/api/login', { method: 'POST', headers: J, body: JSON.stringify({ username: uname, pin: '12345678' }) }).then(r => r.json());
  ok(!!login.error, `and the account genuinely doesn't exist -- a login attempt for it also fails (got ${JSON.stringify(login)})`);
}

console.log('\nevery falsy value for ageConfirmed is refused the same way -- this is a hard gate, not a loose truthy/falsy UI nicety');
{
  for (const bad of [false, 0, '', null]) {
    const uname = 'ag_falsy_' + rand();
    const r = await api({ username: uname, pin: '12345678', displayName: 'Falsy', ageConfirmed: bad });
    ok(r.status === 400 && r.json && r.json.error === 'You must confirm you are at least 13 years old to create an account.',
      `ageConfirmed: ${JSON.stringify(bad)} is refused (got status ${r.status}, error ${JSON.stringify(r.json && r.json.error)})`);
  }
}

console.log('\nageConfirmed: true succeeds, and the attestation (not a birthdate) is what actually gets persisted');
{
  const uname = 'ag_ok_' + rand();
  const r = await api({ username: uname, pin: '12345678', displayName: 'Has Flag', ageConfirmed: true });
  ok(r.status === 200, `registration succeeds (got status ${r.status}, body ${JSON.stringify(r.json)})`);
  ok(!!r.json.token, `a real token is issued (got ${JSON.stringify(r.json && r.json.token)})`);
  ok(r.json.user && r.json.user.username === uname, `the created user's username matches (got ${JSON.stringify(r.json.user)})`);

  // ageConfirmed has no dedicated scalar column (db.js's users table) and no public-profile
  // field (publicUser/profileOf never return it) -- it only ever lives in the row's jsonb
  // 'data' blob, so reading it back means querying Postgres directly, same pattern used by
  // test/backup-roundtrip.mjs and the migration-differential suite.
  const admin = new PgConnection(parseConnString(testDb.url));
  const blobRows = await admin.query(`SELECT data FROM users WHERE id = $1`, [r.json.user.id]);
  admin.close();
  const data = blobRows.rows[0] ? JSON.parse(blobRows.rows[0].data) : null;
  ok(data && data.ageConfirmed === true, `the persisted row stores ageConfirmed: true in its data blob (got ${JSON.stringify(data && data.ageConfirmed)})`);
  ok(data && data.dateOfBirth === undefined && data.birthdate === undefined && data.dob === undefined,
    `and nothing more than that yes/no flag -- no birthdate field of any spelling was introduced (got keys: ${Object.keys(data || {}).join(', ')})`);
}

console.log('\nageConfirmed truthy-but-not-boolean (the real shape a checkbox\'s DOM value can take) still works -- the gate checks truthiness, not strict ===true');
{
  const uname = 'ag_truthy_' + rand();
  const r = await api({ username: uname, pin: '12345678', displayName: 'Truthy', ageConfirmed: 'on' });
  ok(r.status === 200 && !!r.json.token, `a truthy non-boolean ageConfirmed still succeeds (got status ${r.status}, ${JSON.stringify(r.json)})`);
}

} finally {
  await cleanup();
}

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
