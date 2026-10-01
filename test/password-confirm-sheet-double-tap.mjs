// Oct 1 2026 (cold-review catch on the round-2 Tier 1 #1 fix, Jeff: "lets fix the small gap you
// found too"). The four password-confirmation sheets -- confirmResetWorkouts, changePasswordSheet,
// confirmDeleteAccount, and the new editUsernameSheet -- had no guard against a fast double-tap
// stacking two copies of the same sheet, the exact bug class TE_EL/CONFIRM_EL were already fixed
// for elsewhere in app.js (v250/v251): a second sheet with the same field ids gets appended on top,
// but getElementById resolves to the FIRST (hidden, stale) one, so the visible sheet's Save/Delete/
// Reset button reads and submits the wrong (empty/stale) fields. For a sheet whose whole purpose is
// proving you know your own password, that's a real foot-gun, not just a cosmetic double-tap
// annoyance. Fixed with one shared PWCONFIRM_EL guard across all four (see its own comment in
// app.js, just above confirmResetWorkouts) -- this file proves the guard actually works for each of
// the four, not just the one (editUsernameSheet) it was first found on.
import { existsSync, mkdtempSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { freshTestDb } from './_pgtestdb.mjs';

const SANDBOX_CHROMIUM = existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome')
  ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
  : '/opt/pw-browsers/chromium';
const LAUNCH_OPTS = existsSync(SANDBOX_CHROMIUM) ? { executablePath: SANDBOX_CHROMIUM } : {};

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('pwconfirmdbltap');

function boot(port, dir) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; srv.stdout.on('data', d => { out += d; if (String(d).includes('CrewFit on')) res({ srv, out }); });
    srv.on('exit', () => res({ srv: null, out }));
    setTimeout(() => res({ srv, out }), 15000);
  });
}

const PORT = 4984;
const dir = mkdtempSync(join(tmpdir(), 'pwconfirmdbltap-'));
const { srv } = await boot(PORT, dir);
if (!srv) { console.log('  FAIL server did not boot'); process.exit(1); }
ok(true, 'server boots');
const BASE = `http://localhost:${PORT}`;

async function api(path, method, token, body) {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return r.json();
}

const browser = await chromium.launch(LAUNCH_OPTS);

// One shared page/account -- each case opens its own sheet via closeAllSheets() first, so they
// don't interfere with each other, and the account is real so the "did it actually submit against
// the live, visible sheet" check at the end of each case is a genuine end-to-end proof, not a DOM-
// only assertion.
const rand = () => Math.random().toString(36).slice(2, 8);
const uname = 'dbltap_' + rand();
const reg = await api('/api/register', 'POST', null, { username: uname, pin: 'pass1234', displayName: 'DblTap' });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.goto(BASE + '/');
await page.evaluate((tok) => localStorage.setItem('crewfit_token', tok), reg.token);
await page.reload();
await page.waitForSelector('.nav', { timeout: 10000 });
await page.evaluate(() => openSettings());
await page.waitForSelector('#settingsUsernameVal', { timeout: 8000 });

async function doubleTapCase({ label, openFn, fieldId, extraFieldIds }) {
  await page.evaluate(() => window.closeAllSheets());
  await page.waitForTimeout(200);
  const baseline = await page.evaluate(() => document.querySelectorAll('.sheet-back').length);
  ok(baseline === 0, `${label}: clean baseline before the double-tap (got ${baseline} .sheet-back elements)`);

  await page.evaluate((fn) => { window[fn](); window[fn](); }, openFn);
  await page.waitForTimeout(150);
  const afterCount = await page.evaluate(() => document.querySelectorAll('.sheet-back').length);
  ok(afterCount === 1, `${label}: double-tapping ${openFn}() back-to-back leaves exactly ONE sheet open, not stacked (got ${afterCount})`);
  const fieldCount = await page.evaluate((id) => document.querySelectorAll('#' + id).length, fieldId);
  ok(fieldCount === 1, `${label}: exactly one #${fieldId} field exists in the DOM, no hidden stale duplicate (got ${fieldCount})`);
  return { extraFieldIds };
}

console.log('\nUsername sheet (editUsernameSheet) -- the sheet this bug was first caught on');
{
  await doubleTapCase({ label: 'editUsernameSheet', openFn: 'editUsernameSheet', fieldId: 'euVal' });
  const newName = 'dbltap2_' + rand();
  await page.fill('#euVal', newName);
  await page.fill('#euPass', 'pass1234');
  await page.evaluate(() => window.doEditUsername());
  await page.waitForTimeout(300);
  const loginNew = await api('/api/login', 'POST', null, { username: newName, pin: 'pass1234' });
  ok(!!loginNew.token, `the VISIBLE sheet after the double-tap is the real, live one -- the save actually went through (new username logs in: ${!!loginNew.token})`);
}

console.log('\nChange password sheet (changePasswordSheet)');
{
  await doubleTapCase({ label: 'changePasswordSheet', openFn: 'changePasswordSheet', fieldId: 'cpCur' });
  await page.fill('#cpCur', 'pass1234');
  await page.fill('#cpNew', 'newpassdbl1');
  await page.fill('#cpNew2', 'newpassdbl1');
  let dialogMsg = null;
  page.once('dialog', d => { dialogMsg = d.message(); d.accept(); });
  await page.evaluate(() => window.doChangePassword());
  await page.waitForTimeout(300);
  ok(dialogMsg === 'Password changed.', `the visible sheet after the double-tap actually submitted and succeeded (got alert: ${JSON.stringify(dialogMsg)})`);
}

console.log('\nReset workouts sheet (confirmResetWorkouts) -- render + guard only, NOT actually run (would wipe the account this file still needs below)');
{
  await doubleTapCase({ label: 'confirmResetWorkouts', openFn: 'confirmResetWorkouts', fieldId: 'rwPass' });
  await page.evaluate(() => window.closeAllSheets());
  await page.waitForTimeout(200);
}

console.log('\nDelete account sheet (confirmDeleteAccount) -- render + guard only, NOT actually run (this is the last case; deleting here would just make this the end of the file anyway, but the point is proving the guard, not exercising the real delete, which account-settings.mjs already covers end to end)');
{
  await doubleTapCase({ label: 'confirmDeleteAccount', openFn: 'confirmDeleteAccount', fieldId: 'daPass' });
  await page.evaluate(() => window.closeAllSheets());
  await page.waitForTimeout(200);
}

ok(errors.length === 0, `no page errors across any of the four double-tap cases (got ${JSON.stringify(errors)})`);

await page.close();
await browser.close();
srv.kill();
await testDb.drop();

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
