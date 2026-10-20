// Oct 19 2026 (Phase 3 Slice 1a -- getting off a single machine, per Jeff: "we build for long
// term... build them to prepare for doomsday"). loadOrCreateSecret() (server.js) used to be the
// ONE secret among auth-secret.json/vapid.json/admin-token.json that had no env-var override at
// all -- VAPID and ADMIN_TOKEN already checked an env var first (see their own comments right
// above loadOrCreateSecret in server.js), but the auth signing secret only ever read/wrote the
// local volume. That's a real blocker for ANY second machine: without a shared secret, a token
// issued by machine A would fail signature verification on machine B, logging everyone out the
// instant traffic ever lands on a different host than the one that signed their token.
//
// This test proves three things against the REAL server process, not just reading the diff:
//   1. Nothing changes for today's single-machine deploy when AUTH_SECRET isn't set (same
//      generate-once-and-persist-to-the-volume behavior as before this change).
//   2. When AUTH_SECRET IS set, the file is never touched at all -- the env var path returns
//      before any filesystem I/O, so a machine with no volume (or a fresh one) boots fine.
//   3. The actual payoff: two independent "machines" (two different DATA_DIRs, simulating two
//      hosts with no shared disk) booted with the SAME AUTH_SECRET env var trust each other's
//      tokens -- a token issued by one is accepted by the other. This is the thing that was
//      impossible before this change, and it's the whole point of the fix.
// Also checks the length>=32 guard (mirrors the existing file-based validation) rejects a
// too-short env var rather than silently signing with a weak secret.
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('phase3authsecret');

function boot(port, dir, extraEnv) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port), ...extraEnv }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; srv.stdout.on('data', d => { out += d; if (String(d).includes('CrewFit on')) res({ srv, out }); });
    srv.on('exit', () => res({ srv: null, out }));
    setTimeout(() => res({ srv, out }), 15000);
  });
}
async function killAndWait(srv) {
  return new Promise(res => { srv.once('exit', res); srv.kill(); setTimeout(res, 2000); });
}

let cleanedUp = false;
const liveSrvs = new Set();
const liveDirs = new Set();
async function cleanup() {
  if (cleanedUp) return; cleanedUp = true;
  for (const s of liveSrvs) { try { s.kill(); } catch {} }
  for (const d of liveDirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
  try { await testDb.drop(); } catch {}
}
process.on('uncaughtException', async (e) => { console.error('UNCAUGHT', e); await cleanup(); process.exit(1); });
process.on('unhandledRejection', async (e) => { console.error('UNHANDLED', e); await cleanup(); process.exit(1); });

const PORT_A = 5961, PORT_B = 5962;
const REAL_SECRET = 'a'.repeat(48); // well-formed, >=32 chars, same shape as crypto.randomBytes(48).toString('hex')
const TOO_SHORT_SECRET = 'short-secret-under-32-chars';

console.log('\nAUTH_SECRET unset -- unchanged behavior: generates and persists to the volume, same as before this change');
{
  const dir = mkdtempSync(join(tmpdir(), 'phase3auth-unset-')); liveDirs.add(dir);
  const { srv } = await boot(PORT_A, dir, {});
  ok(!!srv, 'server boots with no AUTH_SECRET set');
  if (srv) liveSrvs.add(srv);
  ok(existsSync(join(dir, 'auth-secret.json')), 'auth-secret.json was written to DATA_DIR, exactly like before');
  if (srv) { await killAndWait(srv); liveSrvs.delete(srv); }
}

console.log('\nAUTH_SECRET set -- the file is never touched at all (a volume-less machine boots fine)');
{
  const dir = mkdtempSync(join(tmpdir(), 'phase3auth-envset-')); liveDirs.add(dir);
  const { srv } = await boot(PORT_A, dir, { AUTH_SECRET: REAL_SECRET });
  ok(!!srv, 'server boots with AUTH_SECRET set');
  if (srv) liveSrvs.add(srv);
  ok(!existsSync(join(dir, 'auth-secret.json')), 'auth-secret.json was NOT written -- the env-var path skipped the file entirely');
  if (srv) { await killAndWait(srv); liveSrvs.delete(srv); }
}

console.log('\nthe actual payoff: two independent "machines" (separate DATA_DIRs, no shared disk) with the SAME AUTH_SECRET trust each other\'s tokens');
{
  const dirA = mkdtempSync(join(tmpdir(), 'phase3auth-machineA-'));
  const dirB = mkdtempSync(join(tmpdir(), 'phase3auth-machineB-'));
  liveDirs.add(dirA); liveDirs.add(dirB);

  const { srv: srvA } = await boot(PORT_A, dirA, { AUTH_SECRET: REAL_SECRET });
  ok(!!srvA, '"machine A" boots');
  if (srvA) liveSrvs.add(srvA);
  const BASE_A = `http://localhost:${PORT_A}`;
  const reg = await fetch(BASE_A + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ageConfirmed: true, username: 'phase3auth_' + Math.random().toString(36).slice(2, 8), pin: '12345678', displayName: 'Jeff' }) }).then(r => r.json());
  ok(!!reg.token, `"machine A" issued a real token (got ${JSON.stringify(reg.token && reg.token.slice(0, 12))}...)`);
  if (srvA) { await killAndWait(srvA); liveSrvs.delete(srvA); }

  // "Machine B" never saw machine A's DATA_DIR, never saw its auth-secret.json -- the only thing
  // they share is the AUTH_SECRET env var, same as two real Fly machines would via a Fly secret.
  const { srv: srvB } = await boot(PORT_B, dirB, { AUTH_SECRET: REAL_SECRET });
  ok(!!srvB, '"machine B" boots, with its own separate, empty DATA_DIR');
  if (srvB) liveSrvs.add(srvB);
  ok(!existsSync(join(dirA, 'auth-secret.json')) && !existsSync(join(dirB, 'auth-secret.json')), 'confirmed: neither machine ever wrote a secret file -- there is genuinely no shared disk between them');
  const BASE_B = `http://localhost:${PORT_B}`;
  const prof = await fetch(BASE_B + '/api/profile/me', { headers: { Authorization: 'Bearer ' + reg.token } }).then(r => r.json());
  ok(prof && prof.displayName === 'Jeff' && !prof.error, `"machine B" accepts the token "machine A" issued -- the thing that was impossible before this fix (got ${JSON.stringify(prof)})`);
  if (srvB) { await killAndWait(srvB); liveSrvs.delete(srvB); }
}

console.log('\na too-short AUTH_SECRET is ignored, not trusted as a weak signing key');
{
  const dir = mkdtempSync(join(tmpdir(), 'phase3auth-tooshort-')); liveDirs.add(dir);
  const { srv } = await boot(PORT_A, dir, { AUTH_SECRET: TOO_SHORT_SECRET });
  ok(!!srv, 'server still boots (falls through to the file-based path rather than refusing to start)');
  if (srv) liveSrvs.add(srv);
  ok(existsSync(join(dir, 'auth-secret.json')), 'fell through to generating+persisting a real secret instead of trusting the too-short env var');
  if (srv) { await killAndWait(srv); liveSrvs.delete(srv); }
}

console.log('\nnegative control: two "machines" with DIFFERENT AUTH_SECRET values do NOT trust each other\'s tokens -- proves the shared secret is actually what\'s doing the work above, not a verification bypass');
{
  const dirA = mkdtempSync(join(tmpdir(), 'phase3auth-neg-machineA-'));
  const dirB = mkdtempSync(join(tmpdir(), 'phase3auth-neg-machineB-'));
  liveDirs.add(dirA); liveDirs.add(dirB);
  const OTHER_SECRET = 'b'.repeat(48);

  const { srv: srvA } = await boot(PORT_A, dirA, { AUTH_SECRET: REAL_SECRET });
  ok(!!srvA, '"machine A" (secret #1) boots');
  if (srvA) liveSrvs.add(srvA);
  const reg = await fetch(`http://localhost:${PORT_A}/api/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ageConfirmed: true, username: 'phase3authneg_' + Math.random().toString(36).slice(2, 8), pin: '12345678', displayName: 'Jeff' }) }).then(r => r.json());
  ok(!!reg.token, '"machine A" issued a token under secret #1');
  if (srvA) { await killAndWait(srvA); liveSrvs.delete(srvA); }

  const { srv: srvB } = await boot(PORT_B, dirB, { AUTH_SECRET: OTHER_SECRET });
  ok(!!srvB, '"machine B" (a DIFFERENT secret) boots');
  if (srvB) liveSrvs.add(srvB);
  const r = await fetch(`http://localhost:${PORT_B}/api/profile/me`, { headers: { Authorization: 'Bearer ' + reg.token } });
  const body = await r.json().catch(() => ({}));
  ok(r.status === 401 || r.status === 403 || !!body.error, `"machine B" rejects machine A's token under a different secret, got status ${r.status} body ${JSON.stringify(body)}`);
  if (srvB) { await killAndWait(srvB); liveSrvs.delete(srvB); }
}

await cleanup();
console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
