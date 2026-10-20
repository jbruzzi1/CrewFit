// Oct 20 2026 (app-store readiness review, bot-defense item -- see turnstile.js's header comment
// for the full reasoning and CLAUDE.md's addendum for the "why now, not later" decision).
//
// Two things need proving, same split as Phase 3 Slice 1b's storage.js tests:
//
//   1. UNCONFIGURED behavior (today's actual deploy -- no TURNSTILE_* secrets set yet) must be
//      byte-identical to before this shipped: registration succeeds with no turnstileToken sent
//      at all, exactly what every one of the ~117 other test files that register a user as
//      fixture setup already does, unmodified. That's not asserted here directly (it's proven by
//      the rest of the suite still passing untouched) -- this file proves it explicitly too, as
//      its own first case.
//
//   2. The CONFIGURED path, verified against a REAL local HTTP server standing in for Cloudflare's
//      siteverify endpoint (not a mock of turnstile.js's own internals) -- confirms the actual
//      request server.js sends (method, content-type, exact JSON fields: secret/response/
//      remoteip) matches what Cloudflare's own docs specify, confirms a genuine success response
//      lets registration through, confirms a genuine Cloudflare-reported failure (bad/expired/
//      reused token) is rejected with no account created, confirms a missing token never even
//      reaches the network call, and confirms the disclosed fail-OPEN behavior on a transport
//      error (connection refused) -- registration still succeeds, since this is one layer on top
//      of the existing per-IP rate limit, not the only gate.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { freshTestDb } from './_pgtestdb.mjs';

const SANDBOX_CHROMIUM = '/opt/pw-browsers/chromium';
const LAUNCH_OPTS = existsSync(SANDBOX_CHROMIUM) ? { executablePath: SANDBOX_CHROMIUM } : {};

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const J = { 'Content-Type': 'application/json' };
const CWD = new URL('..', import.meta.url).pathname;
const rand = () => Math.random().toString(36).slice(2, 8);

// Fake siteverify server -- records every request it receives, and replies with whatever
// `nextResponse` currently holds (set per-test) so each case controls Cloudflare's "answer"
// without us guessing at a mock of our own code's internals.
let nextResponse = { status: 200, body: { success: true } };
const receivedRequests = [];
const fakeCf = createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    receivedRequests.push({ method: req.method, contentType: req.headers['content-type'], body: JSON.parse(body || '{}') });
    const { status, body: respBody } = nextResponse;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(respBody));
  });
});
await new Promise(res => fakeCf.listen(0, res));
const FAKE_CF_PORT = fakeCf.address().port;
const FAKE_CF_URL = `http://127.0.0.1:${FAKE_CF_PORT}/verify`;
// A closed port -- nothing listening -- to simulate a real transport/connection error without
// relying on an actual network outage or a slow timeout.
const CLOSED_PORT_URL = 'http://127.0.0.1:1/verify';

function boot(port, dir, databaseUrl, extraEnv) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: databaseUrl, PORT: String(port), ...extraEnv }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    srv.stdout.on('data', d => { if (String(d).includes('CrewFit on')) res(srv); });
    srv.on('exit', () => res(null));
    setTimeout(() => res(srv), 8000);
  });
}

const liveSrvs = new Set();
let cleanedUp = false;
const testDbs = [];
async function cleanup() {
  if (cleanedUp) return; cleanedUp = true;
  for (const s of liveSrvs) { try { s.kill(); } catch {} }
  for (const d of testDbs) { try { await d.drop(); } catch {} }
  try { fakeCf.close(); } catch {}
}
process.on('uncaughtException', async (e) => { console.error('UNCAUGHT', e); await cleanup(); process.exit(1); });
process.on('unhandledRejection', async (e) => { console.error('UNHANDLED', e); await cleanup(); process.exit(1); });

async function bootAt(port, extraEnv) {
  const dir = mkdtempSync(join(tmpdir(), 'turnstile-'));
  const testDb = await freshTestDb('turnstile' + port);
  testDbs.push(testDb);
  const srv = await boot(port, dir, testDb.url, extraEnv);
  if (!srv) { console.log(`FAIL: server did not boot on ${port}`); await cleanup(); process.exit(1); }
  liveSrvs.add(srv);
  return `http://localhost:${port}`;
}
// fly-client-ip mirrors what Fly's own proxy sets in production (see clientIp() in server.js) --
// a bare local test has no proxy in front of it, so clientIp() correctly returns null unless a
// test explicitly supplies this header, same as it would for a real request that genuinely has
// no ingress IP (clientIp()'s own comment: a null IP never reaches it from a real external
// client in production, only from a loopback/local test like these).
const register = (base, body, flyClientIp) => fetch(base + '/api/register', { method: 'POST', headers: { ...J, ...(flyClientIp ? { 'fly-client-ip': flyClientIp } : {}) }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }));

try {

console.log('unconfigured (no TURNSTILE_SECRET_KEY, today\'s real deploy): registration with NO turnstileToken at all still succeeds -- pure no-op, byte-identical to before this shipped');
{
  const base = await bootAt(4991, {});
  const uname = 'ts_noop_' + rand();
  const r = await register(base, { username: uname, pin: '12345678', displayName: 'No Turnstile', ageConfirmed: true });
  ok(r.status === 200 && r.json && r.json.token, `registers fine with no turnstileToken field (got status ${r.status}, body ${JSON.stringify(r.json)})`);
}

console.log('configured + Cloudflare reports success: registration succeeds, and the real request sent to siteverify matches the documented shape');
{
  receivedRequests.length = 0;
  nextResponse = { status: 200, body: { success: true, challenge_ts: new Date().toISOString(), hostname: 'crewfit.test' } };
  const base = await bootAt(4992, { TURNSTILE_SECRET_KEY: 'test-secret-key', TURNSTILE_VERIFY_URL: FAKE_CF_URL });
  const uname = 'ts_ok_' + rand();
  const r = await register(base, { username: uname, pin: '12345678', displayName: 'Real Token', ageConfirmed: true, turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX' }, '203.0.113.42');
  ok(r.status === 200 && r.json && r.json.token, `registers successfully (got status ${r.status}, body ${JSON.stringify(r.json)})`);
  ok(receivedRequests.length === 1, `siteverify was actually called exactly once (got ${receivedRequests.length} calls)`);
  const req0 = receivedRequests[0];
  ok(req0 && req0.contentType && req0.contentType.includes('application/json'), `sent as JSON (got content-type ${req0 && req0.contentType})`);
  ok(req0 && req0.body.secret === 'test-secret-key', `sent the configured secret key (got ${req0 && req0.body.secret})`);
  ok(req0 && req0.body.response === 'XXXX.DUMMY.TOKEN.XXXX', `sent the client's token as "response" (got ${req0 && req0.body.response})`);
  ok(req0 && req0.body.remoteip === '203.0.113.42', `forwards the real client IP (as Fly's proxy sets it) as "remoteip" (got ${JSON.stringify(req0 && req0.body.remoteip)})`);
}

console.log('no fly-client-ip header at all (a bare local request, no proxy in front -- clientIp() correctly returns null): "remoteip" is simply omitted, never sent as a bogus empty value');
{
  receivedRequests.length = 0;
  nextResponse = { status: 200, body: { success: true } };
  const base = await bootAt(4998, { TURNSTILE_SECRET_KEY: 'test-secret-key', TURNSTILE_VERIFY_URL: FAKE_CF_URL });
  const uname = 'ts_noip_' + rand();
  const r = await register(base, { username: uname, pin: '12345678', displayName: 'No IP', ageConfirmed: true, turnstileToken: 'some-token' });
  ok(r.status === 200 && r.json && r.json.token, `registers fine (got status ${r.status})`);
  ok(receivedRequests.length === 1 && !('remoteip' in receivedRequests[0].body), `remoteip key is simply absent, not sent as "" or null (got body ${JSON.stringify(receivedRequests[0] && receivedRequests[0].body)})`);
}

console.log('configured + no turnstileToken sent at all: rejected before ever calling siteverify (cheap fail, no network call, no account created)');
{
  receivedRequests.length = 0;
  nextResponse = { status: 200, body: { success: true } };
  const base = await bootAt(4993, { TURNSTILE_SECRET_KEY: 'test-secret-key', TURNSTILE_VERIFY_URL: FAKE_CF_URL });
  const uname = 'ts_missing_' + rand();
  const r = await register(base, { username: uname, pin: '12345678', displayName: 'No Token', ageConfirmed: true });
  ok(r.status === 400, `missing token is a 400 (got status ${r.status})`);
  ok(r.json && r.json.error === 'We could not verify you are not a bot. Please try again.', `real bot-check error message (got ${JSON.stringify(r.json && r.json.error)})`);
  ok(!r.json.token, `no token issued (got ${JSON.stringify(r.json && r.json.token)})`);
  ok(receivedRequests.length === 0, `siteverify was never called -- failed before the network round trip (got ${receivedRequests.length} calls)`);
  const check = await fetch(base + '/api/register/check?username=' + encodeURIComponent(uname)).then(r => r.json());
  ok(check.available === true, `the username is still available -- no account was actually created (got ${JSON.stringify(check)})`);
}

console.log('configured + Cloudflare genuinely reports a failed/expired/reused token: rejected (fails CLOSED on a real reported failure, not just a transport error)');
{
  receivedRequests.length = 0;
  nextResponse = { status: 200, body: { success: false, 'error-codes': ['timeout-or-duplicate'] } };
  const base = await bootAt(4994, { TURNSTILE_SECRET_KEY: 'test-secret-key', TURNSTILE_VERIFY_URL: FAKE_CF_URL });
  const uname = 'ts_dup_' + rand();
  const r = await register(base, { username: uname, pin: '12345678', displayName: 'Dup Token', ageConfirmed: true, turnstileToken: 'already-used-token' });
  ok(r.status === 400, `a real Cloudflare-reported failure is a 400 (got status ${r.status})`);
  ok(r.json && r.json.error === 'We could not verify you are not a bot. Please try again.', `real bot-check error message (got ${JSON.stringify(r.json && r.json.error)})`);
  ok(receivedRequests.length === 1, `siteverify WAS called this time (the token existed, just failed) -- got ${receivedRequests.length} calls`);
  const check = await fetch(base + '/api/register/check?username=' + encodeURIComponent(uname)).then(r => r.json());
  ok(check.available === true, `no account created on a genuine failure (got ${JSON.stringify(check)})`);
}

console.log('configured + siteverify is UNREACHABLE (connection refused, a real transport error): registration still succeeds -- the disclosed fail-OPEN design, not a bug');
{
  const base = await bootAt(4995, { TURNSTILE_SECRET_KEY: 'test-secret-key', TURNSTILE_VERIFY_URL: CLOSED_PORT_URL });
  const uname = 'ts_failopen_' + rand();
  const r = await register(base, { username: uname, pin: '12345678', displayName: 'Fail Open', ageConfirmed: true, turnstileToken: 'does-not-matter-unreachable' });
  ok(r.status === 200 && r.json && r.json.token, `registration succeeds despite siteverify being unreachable (got status ${r.status}, body ${JSON.stringify(r.json)})`);
}

console.log('/api/config exposes turnstileSiteKey only when configured, empty string when not -- the client reads this to decide whether to render the widget at all');
{
  const baseOff = await bootAt(4996, {});
  const cOff = await fetch(baseOff + '/api/config').then(r => r.json());
  ok(cOff.turnstileSiteKey === '', `unconfigured deploy: turnstileSiteKey is empty string (got ${JSON.stringify(cOff.turnstileSiteKey)})`);
  const baseOn = await bootAt(4997, { TURNSTILE_SITE_KEY: 'real-site-key-for-client', TURNSTILE_SECRET_KEY: 'test-secret-key', TURNSTILE_VERIFY_URL: FAKE_CF_URL });
  const cOn = await fetch(baseOn + '/api/config').then(r => r.json());
  ok(cOn.turnstileSiteKey === 'real-site-key-for-client', `configured deploy: real site key comes through (got ${JSON.stringify(cOn.turnstileSiteKey)})`);
}

console.log('against the REAL Cloudflare endpoint (not the local fake server), using Cloudflare\'s own published test secret keys + the matching dummy token -- confirms turnstile.js\'s actual request shape satisfies the real API, not just a mock of our own guessing (same spirit as the Supabase Storage slice\'s client-against-a-real-port tests)');
{
  const base = await bootAt(4999, { TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA' }); // real "always passes" test key, default (real) TURNSTILE_VERIFY_URL
  const uname = 'ts_cfok_' + rand();
  const r = await register(base, { username: uname, pin: '12345678', displayName: 'Real CF Pass', ageConfirmed: true, turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX' });
  ok(r.status === 200 && r.json && r.json.token, `real Cloudflare "always passes" test key + the real dummy token actually succeeds against the live endpoint (got status ${r.status}, body ${JSON.stringify(r.json)})`);
}
{
  const base = await bootAt(5000, { TURNSTILE_SECRET_KEY: '2x0000000000000000000000000000000AA' }); // real "always fails" test key
  const uname = 'ts_cfbad_' + rand();
  const r = await register(base, { username: uname, pin: '12345678', displayName: 'Real CF Fail', ageConfirmed: true, turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX' });
  ok(r.status === 400, `real Cloudflare "always fails" test key is genuinely rejected by the live endpoint, not just by our own fake server (got status ${r.status})`);
}

console.log('real browser, unconfigured (today\'s actual deploy): the new client-side code (ensureTurnstileWidget/getTurnstileToken) never throws and registration completes end-to-end through the real UI, not just a curl call');
{
  const base = await bootAt(5001, {});
  const browser = await chromium.launch(LAUNCH_OPTS);
  const pageErrors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.on('pageerror', e => pageErrors.push(String(e)));
    await page.goto(base + '/');
    await page.waitForSelector('#lx', { timeout: 10000 });
    await page.click('button:has-text("Create account")'); // showReg() toggle, outside the regbox
    await page.waitForSelector('#rx', { state: 'visible', timeout: 10000 });
    const uname = 'ts_browser_' + rand();
    await page.fill('#rx', uname);
    await page.fill('#rp', '12345678');
    await page.check('#rage');
    await page.click('#regBtn');
    await page.waitForSelector('.nav', { timeout: 10000 }); // home() rendered -- registration succeeded
    ok(true, `real browser registration completes and reaches Home (unconfigured Turnstile, username ${uname})`);
    ok(pageErrors.length === 0, `no uncaught JS errors from the new client code (got ${JSON.stringify(pageErrors)})`);
  } finally {
    await browser.close();
  }
}

console.log('real browser, CONFIGURED with Cloudflare\'s real "invisible, always passes" test sitekey/secret, against the live Cloudflare endpoint end-to-end: widget actually renders and runs, execute()+callback actually produces a real token, the server actually verifies it for real -- the full integration, not a simulation of any piece of it');
{
  const base = await bootAt(5002, { TURNSTILE_SITE_KEY: '1x00000000000000000000BB', TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA' }); // real invisible "always passes" test keys, real (default) TURNSTILE_VERIFY_URL
  const browser = await chromium.launch(LAUNCH_OPTS);
  const pageErrors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.on('pageerror', e => pageErrors.push(String(e)));
    await page.goto(base + '/');
    await page.waitForSelector('#lx', { timeout: 10000 });
    await page.click('button:has-text("Create account")');
    await page.waitForSelector('#rx', { state: 'visible', timeout: 10000 });
    const uname = 'ts_e2e_' + rand();
    await page.fill('#rx', uname);
    await page.fill('#rp', '12345678');
    await page.check('#rage');
    await page.click('#regBtn');
    await page.waitForSelector('.nav', { timeout: 20000 }); // real challenge round trip to Cloudflare -- give it more time
    ok(true, `full real end-to-end flow (real widget, real execute/callback, real server-side verify) completes registration (username ${uname})`);
    ok(pageErrors.length === 0, `no uncaught JS errors anywhere in the real flow (got ${JSON.stringify(pageErrors)})`);
  } finally {
    await browser.close();
  }
}

console.log('regression: a real double-tap on "Create account" never produces a misleading "Network error" alert for an account that actually succeeded -- cold-review caught this live: the old code checked btn.disabled but never SET it, so two concurrent doReg() calls raced through the same Turnstile widget, Cloudflare rejected the duplicate render(), and the losing call alerted a confusing failure for a registration that had, underneath, already gone through. Fixed by disabling the button synchronously before any await (matching every other async-submit handler in this file) and by making ensureTurnstileWidget() itself single-flight.');
console.log('(two earlier versions of this specific test -- real Cloudflare test keys, real network timing, with and without an artificial route-delay on the script load -- both passed 3/3 even against the unpatched, pre-fix code: whether the real render-call race actually lands is apparently sensitive to exact timing this sandbox\'s network conditions didn\'t reliably reproduce, even though an independent cold-review agent DID reproduce it live, repeatedly, with the real Cloudflare script. This version stubs window.turnstile with a fake that reproduces Cloudflare\'s documented, observed behavior exactly -- rejecting a second render() on an already-rendering container -- and opens the register box WITHOUT going through showReg()\'s own pre-warm call, so both doReg() calls make their first-ever call to ensureTurnstileWidget() in the same synchronous tick, guaranteeing their /api/config fetches overlap. Manually confirmed against the pre-fix code before trusting it: fails (no account created at all, or a misleading error dialog) in roughly 2 of every 3 runs -- a genuine, reproducible failure, just not a 100%-every-time one, which is the honest nature of a race condition. Confirmed clean (5/5 runs, no failures) with the fix in place.)');
{
  const base = await bootAt(5003, { TURNSTILE_SITE_KEY: 'fake-stubbed-sitekey', TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA' });
  const browser = await chromium.launch(LAUNCH_OPTS);
  const pageErrors = [];
  const dialogMessages = [];
  const registerRequests = [];
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.on('pageerror', e => pageErrors.push(String(e)));
    page.on('dialog', async d => { dialogMessages.push(d.message()); await d.accept(); });
    page.on('request', req => { if (req.url().endsWith('/api/register') && req.method() === 'POST') registerRequests.push(req); });
    // Installed BEFORE any page script runs. loadTurnstileScript() in app.js checks
    // `if(window.turnstile) return resolve();` before ever fetching the real script -- so with
    // this stub already present, the real challenges.cloudflare.com/turnstile/v0/api.js is never
    // even requested, and app.js's own ensureTurnstileWidget()/getTurnstileToken() logic runs
    // completely for real against this fake, deterministic implementation of the one behavior
    // that actually matters here: a SECOND render() call on a container that's already mid-render
    // is rejected (returns undefined), exactly as Cloudflare's real widget does (confirmed live by
    // the independent cold-review agent's own reproduction, console-warning text included).
    await page.addInitScript(() => {
      window.turnstile = {
        _rendering: false, _widgets: {},
        render(container, opts) {
          window.__renderCalls = (window.__renderCalls || 0) + 1;
          if (window.turnstile._rendering) return undefined; // Cloudflare's real "duplicate render rejected" behavior
          window.turnstile._rendering = true;
          const id = 'fake-widget-1';
          window.turnstile._widgets[id] = opts; // real Turnstile (execution:'execute') doesn't run the challenge on render() -- only execute() does
          return id;
        },
        execute(widgetId) {
          window.__executeCalls = (window.__executeCalls || 0) + 1;
          const opts = window.turnstile._widgets[widgetId];
          if (!opts) throw new Error('Cannot find Widget ' + widgetId + ', consider using turnstile.remove() to clean up a widget.');
          setTimeout(() => { try { opts.callback('FAKE-TOKEN-' + Math.random().toString(36).slice(2)); } catch (e) {} }, 50);
        },
        reset(widgetId) {},
      };
    });
    await page.goto(base + '/');
    await page.waitForSelector('#lx', { timeout: 10000 });
    const uname = 'ts_dbltap_' + rand();
    // Opens the box WITHOUT going through showReg() (which would itself call
    // ensureTurnstileWidget() as a pre-warm, and -- same lesson as the two earlier timing-
    // dependent attempts at this test -- that single pre-warm call reliably finishes (its own
    // /api/config fetch resolves) before a separately-triggered double-tap ever lands, closing
    // the race window before it can be tested). Setting the fields and firing doReg() TWICE,
    // nothing else, means BOTH calls make their OWN first-ever call to ensureTurnstileWidget() in
    // the exact same synchronous tick -- each independently sees _tsSiteKey/_tsWidgetId as not-
    // yet-set, each issues its own real fetch('/api/config'), and since neither can possibly
    // resolve before the NEXT synchronous statement (the second doReg() call) runs, both are
    // guaranteed to be in flight together every time, with no artificial delay needed anywhere.
    await page.evaluate((u) => {
      document.getElementById('regbox').style.display = 'block';
      document.getElementById('rx').value = u;
      document.getElementById('rp').value = '12345678';
      document.getElementById('rage').checked = true;
      doReg(); doReg();
    }, uname);
    await page.waitForTimeout(2000);
    ok(registerRequests.length === 1, `exactly one of the two concurrent doReg() calls reaches the network (got ${registerRequests.length} POSTs to /api/register)`);
    ok(dialogMessages.every(m => !m.includes('Network error')), `no misleading "Network error" alert for an account that actually succeeded (got dialogs: ${JSON.stringify(dialogMessages)})`);
    ok(pageErrors.length === 0, `no uncaught JS errors under the double-tap (got ${JSON.stringify(pageErrors)})`);
    const dupCheck = await page.evaluate((u) => fetch('/api/register/check?username=' + encodeURIComponent(u)).then(r => r.json()), uname);
    ok(dupCheck.available === false, `exactly one account was actually created for this username (got ${JSON.stringify(dupCheck)})`);
  } finally {
    await browser.close();
  }
}

console.log('\nall assertions passed, or failures listed above');

} finally {
  await cleanup();
}

if (fails > 0) { console.log(`\n${fails} FAILURE(S)`); process.exit(1); }
console.log('\nall assertions passed');
