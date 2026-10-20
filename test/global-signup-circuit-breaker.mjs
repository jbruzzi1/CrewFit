// Oct 20 2026 (rate-limiting re-evaluation): proves the new app-wide registration circuit breaker
// (server.js, just above and inside POST /api/register) actually closes the gap the readiness-
// review item flagged -- a rotating-IP adversary (or a Turnstile misconfiguration/fail-open) has NO
// aggregate ceiling today beyond the per-IP cap, which such an adversary can trivially sidestep by
// using enough distinct IPs. This proves: (1) the budget counts real, successfully-created accounts
// only, never rejected attempts; (2) once tripped, the cap blocks EVERY IP, including one that has
// never registered before -- the whole point, since a per-IP cap alone cannot do this; (3) the
// specific 429 message and status code.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';

const PORT = 4998, B = `http://localhost:${PORT}`;
const DIR = mkdtempSync(join(tmpdir(), 'gsb-'));
const testDb = await freshTestDb('globalsignupbreaker');
const J = { 'Content-Type': 'application/json' };
let srv, fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const post = (p, b, ip) => fetch(B + p, { method: 'POST', headers: ip ? { ...J, 'fly-client-ip': ip } : J, body: JSON.stringify(b) });

let cleanedUp = false;
async function cleanup() {
  if (cleanedUp) return; cleanedUp = true;
  try { srv && srv.kill(); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
  try { await testDb.drop(); } catch {}
}
process.on('uncaughtException', async (e) => { console.error('UNCAUGHT', e); await cleanup(); process.exit(1); });
process.on('unhandledRejection', async (e) => { console.error('UNHANDLED', e); await cleanup(); process.exit(1); });

await new Promise(res => {
  srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: DIR, DATABASE_URL: testDb.url, PORT: String(PORT) }, cwd: new URL('..', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stdout.on('data', d => { if (String(d).includes('CrewFit on')) res(); });
  setTimeout(res, 8000);
});

const reg = (u, ip) => post('/api/register', { ageConfirmed: true, username: u, pin: 'pass1234', displayName: 'U' }, ip);

console.log('rejected attempts do not count toward the global budget');
{
  // 20 attempts that never create a real account (missing ageConfirmed -> 400), all from local
  // (no proxy header) traffic so the per-IP cap never interferes either.
  for (let i = 0; i < 20; i++) {
    const r = await post('/api/register', { username: 'bad' + i, pin: 'pass1234', displayName: 'B' }, null);
    if (r.status !== 400) { ok(false, `expected a 400 on attempt ${i}, got ${r.status}`); break; }
  }
  ok(true, '20 rejected (no-ageConfirmed) attempts sent, none should count');
}

console.log('\n140 real accounts can be created sequentially -- the budget was not consumed by the rejected attempts above');
{
  let last;
  // Spread across several distinct IPs (well under each one's own 20/hour per-IP cap) so this
  // exercises the GLOBAL ceiling specifically, not the pre-existing per-IP one. Stops at 140, not
  // 150, to leave room for the genuine concurrency test right below.
  for (let i = 0; i < 140; i++) {
    const ip = '20.0.0.' + (1 + (i % 15));   // 15 IPs x ~9-10 signups each, each IP well under its own 20/hour cap
    last = await reg('gsb' + i, ip);
    if (last.status !== 200) { ok(false, `signup #${i + 1} unexpectedly failed (got ${last.status}): ${await last.text()}`); break; }
  }
  ok(last && last.status === 200, `the 140th real account is created successfully (got ${last && last.status})`);
}

let burstSucceeded = 0;
console.log('\nCRITICAL regression: a genuine concurrent burst right at the boundary must never blow past the cap');
{
  // The first version of this breaker checked the budget once near the top of the route, then only
  // claimed it after Turnstile + hashPin + save had already run -- a large gap full of real awaits
  // during which many concurrent requests could all read the same stale "under budget" count and all
  // get admitted, overshooting 150 by an unbounded amount. A sequential test (like the block above)
  // can NEVER catch this -- it would pass unchanged against the broken code, since each registration
  // only starts once the previous one has fully finished. This fires 20 GENUINELY CONCURRENT
  // registrations (via Promise.all, each its own fresh IP) while only 10 budget slots remain (140
  // used of 150), and asserts that AT MOST 10 of them succeed -- proving the admission check is
  // actually atomic, not just correct when called one at a time.
  const burst = await Promise.all(
    Array.from({ length: 20 }, (_, i) => reg('gsb-burst' + i, '21.0.0.' + (1 + i)))
  );
  burstSucceeded = burst.filter(r => r.status === 200).length;
  const rejected = burst.filter(r => r.status === 429).length;
  ok(burstSucceeded + rejected === 20, `every concurrent request got either a 200 or a 429, nothing else (got ${burstSucceeded} 200s, ${rejected} 429s, ${20 - burstSucceeded - rejected} other)`);
  ok(burstSucceeded <= 10, `at most the 10 remaining budget slots were granted under real concurrency (got ${burstSucceeded} successes -- a number above 10 means the cap was blown through)`);
  ok(burstSucceeded >= 1, `at least one of the 20 concurrent requests succeeded (got ${burstSucceeded}) -- sanity check that the budget wasn't already exhausted before this block`);

  // The total actually-created-account count must match exactly: 140 (sequential) + however many of
  // this burst really won, confirmed by asking the server itself rather than trusting our own count.
  let availableCount = 0;
  for (let i = 0; i < 20; i++) {
    const r = await fetch(`${B}/api/register/check?username=gsb-burst${i}`);
    const body = await r.json();
    if (!body.available) availableCount++;   // "not available" = that username really got created
  }
  ok(availableCount === burstSucceeded, `the number of real accounts the server actually has matches the number of 200s this test counted (server has ${availableCount}, test counted ${burstSucceeded})`);
}

console.log('\ntopping off to exactly 150, then the 151st real-account attempt trips the global breaker, from a completely fresh IP');
{
  // The burst above used 140 + burstSucceeded slots (somewhere between 141 and 150, depending on how
  // many of the 20 concurrent requests actually won -- real concurrency, not a fixed number by
  // design). Top off deterministically to exactly 150 before testing the boundary, so this section
  // doesn't depend on exactly how the race above resolved.
  const remaining = 150 - (140 + burstSucceeded);
  let topOffLast;
  for (let i = 0; i < remaining; i++) topOffLast = await reg('gsb-topoff' + i, '22.0.0.' + (1 + i));
  if (remaining > 0) ok(topOffLast && topOffLast.status === 200, `top-off signup succeeded (got ${topOffLast && topOffLast.status})`);

  // A brand-new IP that has never registered before -- proves this is a GLOBAL ceiling, not a
  // per-IP one that a rotating-IP adversary could just sidestep with one more fresh address.
  const r = await reg('gsb-overflow', '20.0.0.99');
  ok(r.status === 429, `a fresh IP's sign-up is refused once the global budget is spent (got ${r.status})`);
  const body = await r.json();
  ok(/high sign-up volume/i.test(body.error || ''), `the error message explains why (got ${JSON.stringify(body)})`);
  // And a SECOND fresh IP is blocked too -- confirms this isn't coincidentally still a per-IP effect.
  const r2 = await reg('gsb-overflow2', '20.0.0.100');
  ok(r2.status === 429, `a second, different fresh IP is also refused (got ${r2.status})`);
}

await cleanup();
console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
