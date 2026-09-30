// Sep 30 2026 (cold-review catch on the Sep 29 audit batch's custom-exercise-management feature,
// caught by a fresh-eyes subagent review of the diff before showing Jeff -- see CLAUDE.md's
// "Verifying your own work" section). Two real bugs in the SAME piece of new client-side code
// (submitCreateExConfirmed / submitEditEx in app.js), both from the same root cause: when you're
// on a muscle-group screen inside the exercise picker (LIB_STATE.view==='muscle'), the "refresh
// this screen after a create/edit" path called libOpenMuscle() directly instead of going through
// library() -- and unlike library(), libOpenMuscle() does NOT refetch window._LIB2 itself, it just
// re-filters whatever's already sitting in it.
//
//   1. Create: window._LIB2 was never refreshed before the same-screen re-render, so the
//      duplicate-name heads-up Jeff asked for ("anyone should be able to use whatever name they
//      like" -- option A, a heads-up not a block) silently never fired on a second back-to-back
//      create of the same name without leaving the muscle screen -- the exact flow the feature
//      exists for.
//   2. Edit (reached from Settings > "My exercises", NOT the muscle picker -- so LIB_STATE.view is
//      whatever it was left at from an earlier, unrelated visit to the picker): submitEditEx used
//      to NULL _LIB2 and then call libOpenMuscle() SYNCHRONOUSLY when LIB_STATE.view was still
//      'muscle' from that earlier visit -- a real, reachable `TypeError: Cannot read properties of
//      null (reading 'filter')`, since libOpenMuscle does `window._LIB2.filter(...)` with no null
//      guard and no fetch of its own.
//
// Both fixed by awaiting a real GET /api/exercises before calling libOpenMuscle in either spot,
// instead of assuming (create) or nulling-and-hoping (edit). This file drives the real rendered
// page against a real server + throwaway Postgres db -- fetch-only tests (see
// test/audit-sep30-fixes.mjs's own header comment on why UI-only changes aren't covered there)
// cannot catch either of these; both are pure client-side DOM/state bugs.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
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
const testDb = await freshTestDb('exliborefresh');

function boot(port, dir) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; srv.stdout.on('data', d => { out += d; if (String(d).includes('CrewFit on')) res({ srv, out }); });
    srv.on('exit', () => res({ srv: null, out }));
    setTimeout(() => res({ srv, out }), 15000);
  });
}

const PORT = 5002;
const dir = mkdtempSync(join(tmpdir(), 'crewfit-exliborefresh-'));
const { srv } = await boot(PORT, dir);
if (!srv) { console.log('  FAIL server did not boot'); process.exit(1); }
ok(true, 'server boots');
const BASE = `http://localhost:${PORT}`;

const browser = await chromium.launch(LAUNCH_OPTS);
const errors = [];
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
page.on('pageerror', e => errors.push(String(e)));
await page.goto(BASE + '/');

const rand = () => Math.random().toString(36).slice(2, 8);
const uname = 'exlr' + rand();
const reg = await page.evaluate(async ({ BASE, uname }) => {
  const r = await fetch(BASE + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: uname, pin: '12345678', displayName: uname }) });
  return r.json();
}, { BASE, uname });
await page.evaluate((tok) => localStorage.setItem('crewfit_token', tok), reg.token);
await page.reload();
await page.waitForTimeout(300);

console.log('\nsetup: land on a muscle-group screen inside the exercise picker (LIB_STATE.view==="muscle"), same as tapping a muscle tile while building a workout');
await page.evaluate(() => { window.LIB_ADDMODE = true; window.library(); });
await page.waitForSelector('.mg-tile', { timeout: 8000 });
await page.evaluate(() => window.libOpenMuscle('chest'));
await page.waitForSelector('#lib2', { timeout: 8000 });

console.log('\n#1: create the same exercise name twice back-to-back, WITHOUT leaving the muscle screen -- the dupe heads-up must fire the second time');
const exName = 'ExLibRefresh Fly ' + rand();
await page.evaluate(() => window.openCreateEx('chest'));
await page.waitForSelector('#ceName', { timeout: 8000 });
await page.fill('#ceName', exName);
await page.evaluate(() => window.submitCreateEx());
await page.waitForTimeout(400);
// confirmSheet() stacks its own sheet-back ON TOP of (rather than replacing) the still-open
// Create-exercise sheet underneath, so there can be two `.sheet-head h2` elements at once --
// check all of them, not just the first in document order.
const firstCreateDupeShown = await page.evaluate(() => {
  return Array.from(document.querySelectorAll('.sheet-head h2')).some(h => h.textContent.includes('already have this one'));
});
ok(!firstCreateDupeShown, 'the FIRST create of this name is not treated as a dupe (nothing to collide with yet)');

// Still on the muscle screen (submitCreateExConfirmed's silent same-screen refresh). Create the
// exact same name again without navigating anywhere else in between.
await page.evaluate(() => window.openCreateEx('chest'));
await page.waitForSelector('#ceName', { timeout: 8000 });
await page.fill('#ceName', exName);
await page.evaluate(() => window.submitCreateEx());
await page.waitForTimeout(400);
const secondCreateDupeShown = await page.evaluate(() => {
  return Array.from(document.querySelectorAll('.sheet-head h2')).some(h => h.textContent.includes('already have this one'));
});
ok(secondCreateDupeShown, 'the SECOND back-to-back create of the same name, same muscle screen, DOES trigger the dupe heads-up -- this is the exact bug: window._LIB2 must have been refreshed after the first create for this to fire');
// Confirm it anyway (the feature is a heads-up, not a block) so the exercise actually exists for part 2.
if (secondCreateDupeShown) {
  await page.evaluate(() => window.runConfirmCb());
  await page.waitForTimeout(300);
}

console.log('\n#2: edit that exercise reached via "My exercises" (Settings), with LIB_STATE.view still stuck on "muscle" from the picker visit above -- must not crash');
const exId = await page.evaluate((name) => (window._LIB2 || []).find(e => e.mine && e.name === name)?.id, exName);
ok(!!exId, `the created exercise is findable in a fresh _LIB2 (got id ${JSON.stringify(exId)})`);
await page.evaluate(() => window.closeSheet());
await page.waitForTimeout(200);
// Simulate arriving at "My exercises" from Settings -- NOT from the picker -- while LIB_STATE.view
// is still whatever it was left at ('muscle', from libOpenMuscle('chest') above). This mirrors the
// real reachable path: picker -> Create sheet's "Manage your exercises ›" link -> Settings later ->
// back into My exercises -> Edit, all without library() ever running again to reset LIB_STATE.
await page.evaluate(() => window.myCustomExercisesSheet());
await page.waitForSelector('.sheet-list', { timeout: 8000 });
await page.evaluate((id) => { window.closeSheet(); window.openEditEx(id); }, exId);
await page.waitForSelector('#cePattern', { timeout: 8000 });
await page.evaluate(() => { document.querySelector('#ceLv').value = 'advanced'; });
const beforeErrCount = errors.length;
await page.evaluate((id) => window.submitEditEx(id), exId);
await page.waitForTimeout(500);
ok(errors.length === beforeErrCount, `saving the edit does not throw a page error (got: ${JSON.stringify(errors.slice(beforeErrCount))})`);
const libStillArray = await page.evaluate(() => Array.isArray(window._LIB2));
ok(libStillArray, 'window._LIB2 is a real refreshed array afterward, not left null');
const stillOnMuscleScreen = await page.evaluate(() => document.getElementById('lib2') !== null);
ok(stillOnMuscleScreen, 'the muscle-group screen re-rendered cleanly after the edit (silent refresh actually completed)');

await page.close();
await browser.close();
srv.kill();

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
