// Oct 19 2026 (Phase 3 Slice 2 -- found while verifying the plan's "wire a failed-boot signal
// into Sentry" item against what was actually shipped in Phase 2). fatalCrash() (server.js, the
// one function all three of uncaughtException/unhandledRejection/the boot IIFE's rejection funnel
// through) used to call `Sentry.captureException(err)` then `process.exit(1)` immediately, with
// a comment claiming an earlier `await Sentry.flush(2000)` draft "would silently wedge the
// process" on a network stall. That reasoning was never actually verified, and it was wrong on
// both halves:
//   1. captureException() only ENQUEUES an event -- the real HTTP POST happens asynchronously,
//      later. process.exit(1) tears the process down with no grace period for pending I/O.
//      Checked directly (outside this repo, against a throwaway local HTTP server standing in
//      for Sentry's ingestion endpoint): under the OLD code's exact shape, the fake server never
//      received a single request, ever. Every crash alert this app's Sentry wiring was built to
//      send had silently never actually been delivered since Phase 2 shipped it.
//   2. The feared "hung flush() wedges the process forever" risk doesn't describe what
//      Sentry.flush(timeoutMs)/close(timeoutMs) actually do -- both are BOUNDED by the timeout
//      argument. Checked directly: against a genuinely unreachable (non-routable) address,
//      Sentry.close(2000) still returned in ~2018ms, resolving false (didn't finish in time)
//      rather than hanging.
// Fixed: fatalCrash is now async, calls `server.close()` immediately (stop taking new traffic
// before the delay below) and awaits a 2-second-bounded `Sentry.close()` before exiting.
//
// Phase 2's own test (test/phase2-sentry-nonfatal-reporting.mjs) explicitly disclaimed proving
// real delivery: "there is no mock Sentry receiver here... fire-and-forget over the network
// regardless" -- true of the OLD code (delivery could never be proven because it never happened),
// but no longer true of the FIXED code, where delivery is now real enough to actually verify. This
// file is that verification: a from-scratch local HTTP server standing in for Sentry's ingestion
// endpoint -- not a mock of this app's own code, the real @sentry/node client's real HTTP call,
// landing on a server this test controls -- proving the event genuinely arrives before/by the
// time the crashed process is gone, and that an unreachable endpoint still lets the process exit
// within a bounded few seconds rather than hanging.
//
// Scope, same as Phase 2's own test and for the same reason: this exercises the boot-crash path
// (an unreachable DATABASE_URL, rejecting the boot IIFE) because it's the one path reachable from
// outside without adding test-only production routes. uncaughtException/unhandledRejection during
// live request handling funnel through the exact same fatalCrash() function -- same code, same
// fix, not independently re-provable here without adding a forced-crash route that would exist in
// production for no reason other than this one test.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

const CWD = new URL('..', import.meta.url).pathname;
let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };

function boot(port, dir, databaseUrl, extraEnv) {
  return new Promise(res => {
    const t0 = Date.now();
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: databaseUrl, PORT: String(port), ...extraEnv }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    srv.stdout.on('data', d => { stdout += d; });
    srv.stderr.on('data', d => { stderr += d; });
    let resolved = false;
    srv.on('exit', (code) => { if (!resolved) { resolved = true; res({ exited: true, code, ms: Date.now() - t0, stdout, stderr }); } });
    setTimeout(() => { if (!resolved) { resolved = true; try { srv.kill(); } catch {} res({ exited: false, ms: Date.now() - t0, stdout, stderr }); } }, 15000);
  });
}

console.log('=== a real boot-time crash, with a real (local, fake) Sentry receiver -- the event actually arrives now ===');
{
  const received = [];
  const fakeSentry = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      received.push({ url: req.url, bytes: Buffer.concat(chunks).length, at: Date.now() });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise(res => fakeSentry.listen(0, res));
  const fakePort = fakeSentry.address().port;
  // Sentry DSN shape: https://<publicKey>@<host>:<port>/<projectId> -- http here (not https),
  // since this fake receiver has no TLS cert and the real client follows whatever scheme the
  // DSN gives it.
  const DSN = `http://fakekey@127.0.0.1:${fakePort}/1`;

  const dir = mkdtempSync(join(tmpdir(), 'phase3sentryflush-'));
  const badUrl = 'postgres://postgres:wrong@127.0.0.1:1/nope'; // same rigged-boot-crash technique as phase2-sentry-nonfatal-reporting.mjs
  const r = await boot(5966, dir, badUrl, { SENTRY_DSN: DSN });

  ok(r.exited, `process actually exits rather than hanging (took ${r.ms}ms)`);
  ok(r.code === 1, `exits with code 1, same as before this fix (got ${r.code})`);
  ok(r.stderr.includes('=== FATAL: boot ==='), `fatalCrash's own log format still appears (got tail: ${r.stderr.slice(-300)})`);
  ok(received.length >= 1, `the fake Sentry receiver actually got a real HTTP request before the process finished exiting -- THIS is the bug: it never did before this fix (received ${received.length} request(s))`);
  ok(received.length >= 1 && /envelope/.test(received[0].url), `and it's the real Sentry envelope endpoint, not some other request (got ${received[0] && received[0].url})`);
  ok(received.length >= 1 && received[0].bytes > 0, `with a real, non-empty body (got ${received[0] && received[0].bytes} bytes)`);
  // Total boot-to-exit time should comfortably clear the 2000ms Sentry.close() bound plus normal
  // boot-crash overhead, but stay well under the test's own 15s giveup -- proves the delay is the
  // bounded one this fix adds, not an open-ended hang.
  ok(r.ms < 10000, `total time from spawn to exit stays bounded, nowhere near a hang (took ${r.ms}ms)`);

  fakeSentry.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n=== a real boot-time crash with an UNREACHABLE Sentry endpoint -- the process still exits within the bounded window, never hangs ===');
{
  const dir = mkdtempSync(join(tmpdir(), 'phase3sentryflush-unreachable-'));
  const badUrl = 'postgres://postgres:wrong@127.0.0.1:1/nope';
  // 203.0.113.0/24 is the RFC 5737 TEST-NET-3 block -- guaranteed non-routable, so this connect
  // attempt genuinely stalls rather than getting an immediate ECONNREFUSED, the real "network
  // stall" scenario the original (incorrect) comment was worried about.
  const DSN = 'http://fakekey@203.0.113.1:1/1';
  const r = await boot(5967, dir, badUrl, { SENTRY_DSN: DSN });

  ok(r.exited, `process still exits rather than hanging forever against a genuinely unreachable Sentry endpoint (took ${r.ms}ms)`);
  ok(r.code === 1, `still exits with code 1 (got ${r.code})`);
  // Should be close to boot-crash-time + the ~2000ms Sentry.close() bound, comfortably under the
  // test's 15s giveup -- if this fix had reintroduced an unbounded wait, this would time out at
  // 15000ms+ instead.
  ok(r.ms < 10000, `exits well within a bounded window, not stuck waiting on the unreachable endpoint (took ${r.ms}ms)`);
  // Cold-review catch (Oct 19 2026): the upper bound alone doesn't prove the 2s-bounded Sentry.close()
  // wait was actually exercised for the unreachable case -- a regression that made captureException()
  // throw synchronously and get swallowed before close() is ever reached would ALSO exit fast and pass
  // the check above for the wrong reason. A floor well under the full 2000ms bound (but comfortably
  // above ordinary boot-crash overhead, which the reachable-receiver case above shows is under ~1s)
  // catches that: this run should be spending real time waiting on the unreachable connect, not
  // skipping the wait entirely.
  ok(r.ms > 1500, `and that bounded wait was actually exercised, not skipped (took ${r.ms}ms, expected to be spending most of the ~2000ms Sentry.close() bound waiting on the unreachable endpoint)`);

  rmSync(dir, { recursive: true, force: true });
}

console.log('\n=== two concurrent fatal errors: the second must not race the first one\'s Sentry.close() -- cold-review catch, Oct 19 2026 ===');
{
  // Two independent rejections fired back-to-back during the same boot-crash window. Without the
  // crashHandled latch, both calls to fatalCrash would call Sentry.captureException() and race two
  // concurrent Sentry.close(2000) calls against the same shared global client -- whichever resolves
  // first disables it, risking the other capture being silently dropped. With the latch, only the
  // first one gets the full report-then-wait treatment; the second just logs and exits immediately.
  // This can't be forced without a test-only double-crash hook, so this only proves the externally
  // observable half: the process still exits cleanly and quickly even when more than one fatal path
  // could plausibly fire close together -- this is the boot path re-run to confirm no regression from
  // adding the latch (the latch's actual race-prevention is structural, argued in server.js's own
  // comment, not independently re-provable here without a forced-double-crash test route that would
  // exist in production for no reason other than this one test, same limitation already disclosed
  // above for the live-request-handling paths).
  const dir = mkdtempSync(join(tmpdir(), 'phase3sentryflush-latch-'));
  const badUrl = 'postgres://postgres:wrong@127.0.0.1:1/nope';
  const r = await boot(5968, dir, badUrl, { SENTRY_DSN: 'http://fakekey@203.0.113.1:1/1' });
  ok(r.exited, `still exits cleanly with the crashHandled latch in place (took ${r.ms}ms)`);
  ok(r.code === 1, `still exits with code 1 (got ${r.code})`);
  rmSync(dir, { recursive: true, force: true });
}

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
