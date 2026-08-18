// Registration and login are open to the whole internet. This proves the per-IP caps fire for real
// external traffic (identified by Fly's proxy header, which Fly sets and a client cannot spoof) and
// that the account lockout no longer lets one attacker lock the REAL user out — while confirming
// loopback/local traffic with no proxy header is NOT limited (so the app's own tests and health
// checks are unaffected).
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 4999, B = `http://localhost:${PORT}`;
const DIR = mkdtempSync(join(tmpdir(), 'rl-'));
const J = { 'Content-Type': 'application/json' };
let srv, fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
// post from a given "client IP" (or none) by setting the Fly proxy header
const post = (p, b, ip) => fetch(B + p, { method: 'POST', headers: ip ? { ...J, 'fly-client-ip': ip } : J, body: JSON.stringify(b) });
process.on('exit', () => { try { srv && srv.kill(); } catch {} try { rmSync(DIR, { recursive: true, force: true }); } catch {} });

await new Promise(res => {
  srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: DIR, PORT: String(PORT) }, cwd: new URL('..', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stdout.on('data', d => { if (String(d).includes('CrewFit on')) res(); });
  setTimeout(res, 8000);
});

console.log('registration is capped per client IP');
{
  let last;
  for (let i = 0; i < 21; i++) last = await post('/api/register', { username: 'reg' + i, pin: 'pass1234', displayName: 'R' }, '9.9.9.1');
  ok(last.status === 429, `the 21st sign-up from one IP is refused (got ${last.status})`);

  // a different IP is unaffected
  const other = await post('/api/register', { username: 'otheruser', pin: 'pass1234', displayName: 'O' }, '9.9.9.2');
  ok(other.status === 200, `a different IP can still sign up (got ${other.status})`);

  // NO proxy header (loopback / tests) is never limited
  let localLast;
  for (let i = 0; i < 30; i++) localLast = await post('/api/register', { username: 'local' + i, pin: 'pass1234', displayName: 'L' }, null);
  ok(localLast.status === 200, `30 local (no-proxy-header) sign-ups are all allowed (got ${localLast.status})`);
}

console.log('\nlogin is throttled per client IP');
{
  let last;
  // distinct usernames so the per-account lockout (8) never fires first — this isolates the IP cap
  for (let i = 0; i < 61; i++) last = await post('/api/login', { username: 'ghost' + i, pin: 'x' }, '8.8.8.8');
  ok(last.status === 429, `the 61st login attempt from one IP is refused (got ${last.status})`);
}

console.log('\nthe account lockout no longer lets an attacker lock out the real user');
{
  await post('/api/register', { username: 'victim', pin: 'realpin12', displayName: 'V' }, null);
  const ATT = '10.0.0.1', REAL = '10.0.0.2';
  let att;
  for (let i = 0; i < 8; i++) att = await post('/api/login', { username: 'victim', pin: 'wrong' + i }, ATT);
  const attNext = await post('/api/login', { username: 'victim', pin: 'realpin12' }, ATT);
  ok(attNext.status === 429, `the attacker's IP is locked out of the account (got ${attNext.status})`);

  const real = await post('/api/login', { username: 'victim', pin: 'realpin12' }, REAL);
  ok(real.status === 200, `but the REAL user, on their own IP, logs in fine (got ${real.status})`);
}

console.log('\na distributed guesser is still capped per account, across many IPs');
{
  await post('/api/register', { username: 'victim2', pin: 'realpin12', displayName: 'V2' }, null);
  // 5 IPs x 8 wrong guesses = 40 account-level failures (each IP hits its own per-IP lock at 8)
  for (let ipn = 1; ipn <= 5; ipn++)
    for (let i = 0; i < 8; i++)
      await post('/api/login', { username: 'victim2', pin: 'no' + i }, '11.0.0.' + ipn);
  // a fresh 6th IP now hits the global per-account ceiling — even with the correct PIN
  const fresh = await post('/api/login', { username: 'victim2', pin: 'realpin12' }, '11.0.0.6');
  ok(fresh.status === 429, `after 40 failures spread across IPs the account is globally rate-limited (got ${fresh.status})`);
}

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
