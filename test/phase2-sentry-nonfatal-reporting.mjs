// Oct 18 2026 (Phase 2 -- activate Sentry + structure the scattered console.error calls, per
// Jeff: already has a Sentry account/DSN, and wants non-fatal "caught it, logged it, kept going"
// errors to ALSO report to Sentry, not just real crashes).
//
// This file does not (and cannot, in this sandbox) prove an event actually lands in Jeff's real
// Sentry project -- there is no mock Sentry receiver here, and @sentry/node's own exporter is
// fire-and-forget over the network regardless. What it DOES prove, against the real server
// process, with a real (fake-but-well-formed) SENTRY_DSN so Sentry.init() actually turns on:
//   1. Booting with SENTRY_DSN set still boots cleanly and logs "Sentry error tracking: ON".
//   2. A real rigged route failure (same breakTable/fixTable technique as every other regression
//      file in this suite) that now also calls reportNonFatal() still returns the EXACT SAME
//      status/body it always did, and the server stays fully responsive afterward -- proving the
//      new Sentry call never changes a route's behavior and never blocks/wedges anything, even
//      when SENTRY_ON is genuinely true (not just skipped via the `if (!SENTRY_ON) return` guard
//      every other test file's SENTRY_DSN-less boot already exercises for free).
//   3. The one real, disclosed bug fix in this slice -- a boot-time crash used to bypass
//      fatalCrash() entirely (console.error + process.exit(1) directly, never touching Sentry) --
//      is proven by rigging a real boot-time crash (an unreachable DATABASE_URL) and asserting
//      the process now exits via fatalCrash's own distinctive `=== FATAL: boot ===` log format,
//      not the old bare "FATAL during boot:" text.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';
import { PgConnection, parseConnString } from '../pgmini.js';

const PORT = 5952, B = `http://localhost:${PORT}`;
const DIR = mkdtempSync(join(tmpdir(), 'phase2-sentry-'));
const J = { 'Content-Type': 'application/json' };
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('phase2sentry');
let srv, fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const H = t => ({ ...J, Authorization: 'Bearer ' + t });
const post = (p, b, t) => fetch(B + p, { method: 'POST', headers: t ? H(t) : J, body: JSON.stringify(b) });
const get = (p, t) => fetch(B + p, { headers: t ? H(t) : J });
const j = r => r.json();
process.on('exit', () => { try { srv && srv.kill(); } catch {} try { rmSync(DIR, { recursive: true, force: true }); } catch {} });
// Oct 20 2026: the 'exit' handler above already frees the server's hardcoded PORT and removes DIR
// on any exit, including a crash -- but it can't await testDb.drop() (Node does not wait for
// promises inside an 'exit' listener), so a genuinely unhandled rejection/exception anywhere above
// would skip dropping the throwaway Postgres test database. Added here so that one async resource
// is cleaned up on a crash too, same idiom as test/back-after-start-now.mjs.
let cleanedUpAsync = false;
async function cleanupAsync() {
  if (cleanedUpAsync) return; cleanedUpAsync = true;
  try { await testDb.drop(); } catch {}
}
process.on('uncaughtException', async (e) => { console.error('UNCAUGHT', e); await cleanupAsync(); process.exit(1); });
process.on('unhandledRejection', async (e) => { console.error('UNHANDLED', e); await cleanupAsync(); process.exit(1); });

// A syntactically-valid but entirely fake Sentry DSN -- never actually reaches a real Sentry
// project. Enough for Sentry.init() to set SENTRY_ON = true and for Sentry.captureException() to
// run its real internal code path (it fails to deliver over the network in the background,
// silently, the same way it would for any transient network hiccup in production).
const FAKE_DSN = 'https://abcdef0123456789abcdef0123456789@o000000.ingest.sentry.io/0000000';

function boot(port, dir, databaseUrl, extraEnv) {
  return new Promise(res => {
    const s = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: databaseUrl, PORT: String(port), ...extraEnv }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    s.stdout.on('data', d => { stdout += d; if (String(d).includes('CrewFit on')) res({ srv: s, stdout, stderr }); });
    s.stderr.on('data', d => { stderr += d; process.stderr.write('[server] ' + d); });
    s.on('exit', (code, signal) => res({ srv: null, stdout, stderr, code, signal }));
    setTimeout(() => res({ srv: s, stdout, stderr }), 8000);
  });
}

console.log('boot with a real (fake) SENTRY_DSN -- Sentry actually turns ON, server still boots clean');
let bootResult;
({ srv, stdout: bootResult } = await boot(PORT, DIR, testDb.url, { SENTRY_DSN: FAKE_DSN }));
ok(!!srv, 'server boots with SENTRY_DSN set');
ok(bootResult.includes('Sentry error tracking: ON'), `logs that Sentry turned on, got stdout: ${JSON.stringify(bootResult)}`);

const raw = new PgConnection(parseConnString(testDb.url));
async function breakTable(name) { await raw.query(`ALTER TABLE ${name} RENAME TO ${name}_broken_for_test`); }
async function fixTable(name) { await raw.query(`ALTER TABLE ${name}_broken_for_test RENAME TO ${name}`); }

const alice = await post('/api/register', { username: 'p2_alice', pin: 'pass1234', displayName: 'Alice' }).then(j);

console.log('\na real rigged route failure behaves EXACTLY the same with Sentry on -- same status, same body, server stays responsive after');
{
  await breakTable('users');
  const r = await post('/api/me/display-name', { displayName: 'New Alice' }, alice.token);
  const body = await r.json();
  ok(r.status === 500, `still a real 500 with Sentry on, got ${r.status}`);
  ok(body.error === 'Something went wrong. Please try again.', `the global error handler's response body is unchanged, got ${JSON.stringify(body)}`);
  await fixTable('users');
  const prof = await get('/api/profile/me', alice.token).then(j);
  ok(prof.displayName === 'Alice', 'the revert still happened exactly as it does without Sentry -- reportNonFatal changed no control flow');
  // and the server is still fully alive and responsive right after -- reportNonFatal's
  // Sentry.captureException() call never blocked or wedged the request.
  const rReal = await post('/api/me/display-name', { displayName: 'New Alice' }, alice.token);
  ok(rReal.status === 200, `a completely unrelated follow-up request still succeeds normally, got ${rReal.status}`);
}

console.log('\na brand-new, healthy registration still works cleanly right after everything above (same "no global jam" shape every other regression file in this suite checks)');
{
  const r = await post('/api/register', { username: 'p2_bob', pin: 'pass1234', displayName: 'Bob' });
  ok(r.status === 200, `registration succeeds with Sentry on, got ${r.status}`);
}

srv.kill();
srv = null;

console.log('\nFix verification: a real boot-time crash now goes through fatalCrash() (and therefore attempts Sentry) instead of bypassing it entirely');
{
  // An unreachable port on localhost -- DB.load()'s very first ensureSchema()/getConn() call
  // throws immediately, inside the boot IIFE, before app.listen ever runs.
  const badUrl = 'postgres://postgres:postgres@127.0.0.1:1/nonexistent_phase2_test_db';
  const { srv: deadSrv, code, stderr } = await boot(5953, mkdtempSync(join(tmpdir(), 'phase2-sentry-badboot-')), badUrl, { SENTRY_DSN: FAKE_DSN });
  ok(!deadSrv, 'the process actually exits rather than hanging or half-booting');
  ok(code === 1, `exits with code 1, same as before this fix, got ${code}`);
  // fatalCrash()'s own distinctive label -- "=== FATAL: boot ===" -- is what proves this now
  // goes through the SAME Sentry-reporting code path every other fatal crash already used. The
  // old, pre-fix code printed a plain "FATAL during boot:" line instead, which never touched
  // Sentry at all -- see this file's header comment and CLAUDE.md's Phase 2 section for the full
  // disclosed finding.
  ok(stderr.includes('=== FATAL: boot ==='), `stderr shows fatalCrash's own format, not the old bypass, got: ${JSON.stringify(stderr.slice(-400))}`);
  ok(!stderr.includes('FATAL during boot:'), 'the OLD bare message (the one that bypassed Sentry) is gone');
}

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
