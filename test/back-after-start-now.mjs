// Sep 10 2026 (Jeff, real bug report): "After selecting 'Start now' you will be brought to that
// workout - if I then click back, it brings me to the muscle group library. I believe and want it
// to bring me back to the home page. The muscle group library wouldn't make sense."
//
// Root cause: this app tracks its own history stack (CURRENT_NAV_STATE + history.pushState, see
// navigated()/showTab() in app.js) alongside the real browser history, and several success/cancel
// paths called home() directly instead of showTab('home') -- home() only changes what's ON
// SCREEN, it does not push a fresh, correctly-tracked history entry. Creating a workout via
// "+ Add exercise" detours through the exercise library (openAddExercises() -> showTab('lib',
// true), a real tracked push), and libDone()'s return to createFlow() deliberately does NOT
// re-track anything (create-flow never gets its own history step, by design -- see the comment
// above CURRENT_NAV_STATE's declaration in app.js). So after picking an exercise and tapping
// "Create workout", the browser's ACTUAL top-of-stack entry was still the stale library one, even
// though the screen correctly showed Home. Start Now's own (correct) push then landed right on
// top of that stale entry -- one real Back later, Library.
//
// Fixed by routing every one of those "you're conceptually back at Home now" moments through
// showTab('home') instead of a bare home() call (submitSession's success path, cancelCreate,
// deleteSessionConfirmed, leaveWorkoutConfirmed, doResetWorkouts) -- same pattern libDone() itself
// already used for its OWN "abandoned Quick Workout" case, per its own comment.
//
// This test drives the REAL create-workout UI (not the API directly) through the exact repro:
// + New workout -> + Add exercise (real openAddExercises()/libDone() calls) -> leave the name
// blank -> Create workout -> Start now on the resulting Next Up card -> a REAL browser Back
// (page.goBack(), not a scripted history.back() shortcut) -- and asserts the muscle-group library
// grid (.mg-tile) is NOT what's on screen afterward, Home is.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { freshTestDb } from './_pgtestdb.mjs';

const SANDBOX_CHROMIUM = '/opt/pw-browsers/chromium';
const LAUNCH_OPTS = existsSync(SANDBOX_CHROMIUM) ? { executablePath: SANDBOX_CHROMIUM } : {};

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('backafterstart');

function boot(port, dir) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    srv.stdout.on('data', d => { if (String(d).includes('CrewFit on')) res(srv); });
    setTimeout(() => res(null), 15000);
  });
}

const PORT = 4999;
const dir = mkdtempSync(join(tmpdir(), 'crewfit-backafterstart-'));
const srv = await boot(PORT, dir);
if (!srv) { console.log('FAIL server did not boot'); process.exit(1); }
const BASE = `http://localhost:${PORT}`;

const browser = await chromium.launch(LAUNCH_OPTS);
// Oct 19 2026 (Jeff, real bug found while chasing an unrelated CI flake: "fix ALL issues... bug
// also means issue... leave no bug unturned"). This file used to have NO crash-safe cleanup at
// all -- srv.kill()/rmSync/browser.close()/testDb.drop() only ran on the happy path, after every
// assertion below. Any genuinely failing `page.click`/`page.evaluate` (Playwright's own
// actionability timeout, 30s) throws, which was an UNHANDLED rejection here -- Node prints it and
// exits, skipping every line of cleanup. The real-world consequence: this file hardcodes PORT
// 4999, which test/posted-workout-set-reorder.mjs ALSO hardcodes and runs later in the same
// run-all.mjs sequence -- a single flaky timeout in THIS file left its server process orphaned on
// 4999, so the NEXT file's own boot() could never bind that port and failed with "server did not
// boot" -- turning one real (if rare) flake into the exact two-file "2 FAILED" CI run Jeff saw.
// Same uncaughtException/unhandledRejection-triggered cleanup() idiom audit10-avatar-photo-
// everywhere.mjs and crew-sheet-empty-state.mjs already use -- not a new pattern, just missing
// here (and in several sibling Playwright files, each fixed the same way this same pass).
let cleanedUp = false;
async function cleanup() {
  if (cleanedUp) return; cleanedUp = true;
  try { await browser.close(); } catch {}
  try { srv && srv.kill(); } catch {}
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
  try { await testDb.drop(); } catch {}
}
process.on('uncaughtException', async (e) => { console.error('UNCAUGHT', e); await cleanup(); process.exit(1); });
process.on('unhandledRejection', async (e) => { console.error('UNHANDLED', e); await cleanup(); process.exit(1); });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.goto(BASE + '/');

const reg = await page.evaluate(async (BASE) => {
  const r = await fetch(BASE + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ageConfirmed: true, username: 'backstart' + Math.random().toString(36).slice(2, 8), pin: '12345678', displayName: 'Jeff' }) });
  return r.json();
}, BASE);
await page.evaluate((tok) => localStorage.setItem('crewfit_token', tok), reg.token);
await page.reload();
await page.waitForTimeout(300);

console.log('the exact repro: + New workout, add an exercise via the real library detour, leave the name blank, Create, Start now, real Back');
{
  // "+ New workout"
  await page.evaluate(() => window.createFlow());
  await page.waitForTimeout(200);

  // "+ Add exercise" -- the REAL function, which is the actual site that pushes the library's own
  // tracked history entry (this is the detour that used to get left stale).
  await page.evaluate(() => window.openAddExercises());
  await page.waitForTimeout(200);
  const onLibraryPicker = await page.evaluate(() => !!document.querySelector('.mg-tile') || !!document.querySelector('.ex-row'));
  ok(onLibraryPicker, 'openAddExercises() really did land on the library picker (muscle groups or an already-drilled-in exercise list)');

  // Pick an exercise the same way libToggle() would -- the exercise-picker's own click mechanics
  // have separate coverage elsewhere; what this test needs is the REAL libDone() return path.
  await page.evaluate(() => { DRAFT.exercises = [{ name: 'Bench Press', defaultSets: 3, defaultReps: 8 }]; window.libDone(); });
  await page.waitForTimeout(200);
  const backOnCreateForm = await page.evaluate(() => !!document.getElementById('wname'));
  ok(backOnCreateForm, 'libDone() returned to the create-workout form (the name field is back on screen)');

  // Leave the name blank -- Jeff's own repro -- and submit.
  const nameVal = await page.$eval('#wname', el => el.value);
  ok(nameVal === '', `the name field is genuinely blank going into submit (got ${JSON.stringify(nameVal)})`);
  await page.click('button:has-text("Create workout")');
  // Oct 19 2026 (Jeff: "2" -- properly fix this, not just a longer guessed sleep): home() is
  // async and does its ENTIRE render in one shot only after four awaited fetches resolve
  // (/api/sessions, /api/friends, /api/progress, /api/notifications -- see home() in app.js), so
  // nothing from Home is in the DOM at all until that round-trip finishes. A flat
  // waitForTimeout(500) is a guess at how long that takes; under real load (a shared CI runner,
  // the suite's own postgres container) it can legitimately take longer than 500ms, and a guessed
  // sleep is either wastefully long or, on a slow run, still too short. waitForSelector polls for
  // the actual thing this assertion is about, succeeds the instant it's true, and still has a
  // generous ceiling (10s) rather than page.click's full 30s default, so a genuinely broken
  // render fails fast and clearly here instead of masquerading as a "Start now" problem two lines
  // down.
  await page.waitForSelector('.btn-new', { timeout: 10000 });
  const onHomeAfterCreate = await page.evaluate(() => !!document.querySelector('.btn-new'));
  ok(onHomeAfterCreate, 'landed on Home after creating (the "+ New workout" button is on screen)');

  // "Start now" on the Next Up card for the workout just created. page.click() already polls for
  // up to 30s on its own, so this alone isn't what used to time out -- but it only polls for the
  // LOCATOR, not for "Home has actually finished its post-create render pass" (the same async
  // home() from the comment above), so a slow render plus a slow page.click() retry cadence could
  // still eat into that budget before the button exists. Waiting for the Next Up card's own
  // container first makes the two steps independent: by the time this test clicks, "Start now" is
  // either genuinely there or genuinely never coming (nextUp null/mis-scheduled), rather than
  // leaving that ambiguous.
  await page.waitForSelector('.next-card', { timeout: 10000 });
  await page.click('button:has-text("Start now")');
  await page.waitForSelector('#chatbox', { timeout: 10000 });
  const onSessionPage = await page.evaluate(() => !!document.querySelector('#chatbox'));
  ok(onSessionPage, 'Start now landed on the live workout/session page');

  // The actual bug: a REAL browser Back (not a scripted shortcut) after Start Now.
  await page.goBack();
  await page.waitForSelector('.mg-tile, .btn-new', { timeout: 10000 }).catch(() => {});

  const html = await page.evaluate(() => document.getElementById('app').innerHTML);
  const onLibraryAfterBack = html.includes('mg-tile');
  const onHomeAfterBack = html.includes('btn-new');
  ok(!onLibraryAfterBack, 'Back from the session does NOT land on the muscle-group library (the reported bug)');
  ok(onHomeAfterBack, 'Back from the session lands on Home instead, as Jeff wants');
  ok(errors.length === 0, `no console pageerrors along the way (got ${JSON.stringify(errors)})`);
}

await cleanup();

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
