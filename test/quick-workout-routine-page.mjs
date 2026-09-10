// Sep 10 2026 (Jeff): "In quick workout and selecting routines - a pop up window for the routines
// you've created shows where you can only select which one to use. We cannot see the routine or
// edit. I think it would be simple to just have the normal routines page show here and where you
// can click in to see the exercises and or edit or just click use and then it builds that as the
// quick workout."
//
// The old picker (quickPickRoutine/quickUseRoutine -- a bare sheet: name, exercise count, a Use
// button, nothing else) is gone. Quick Workout's "Routine" button now opens the exact same
// templatesPage()/tplView() screens the Workouts tab uses, and tplUse() (shared by every entry
// point) branches on QUICK_ADD_MODE to build+start the quick workout instead of routing into the
// full create-flow wizard.
//
// Real end-to-end UI test: seeds a real routine via the API, drives Quick Workout with real clicks
// (workoutNow() -> "Routine" -> the real routines list -> tap in to the real detail screen -> real
// Back -> back into the picker -> real "Use routine" tap), and proves the picked routine's
// exercises are what actually gets posted when the quick workout session is created.
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
const testDb = await freshTestDb('quickworkoutroutinepage');

function boot(port, dir) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    srv.stdout.on('data', d => { if (String(d).includes('CrewFit on')) res(srv); });
    setTimeout(() => res(null), 15000);
  });
}

const PORT = 4997;
const dir = mkdtempSync(join(tmpdir(), 'crewfit-quickworkoutroutinepage-'));
const srv = await boot(PORT, dir);
if (!srv) { console.log('FAIL server did not boot'); process.exit(1); }
const BASE = `http://localhost:${PORT}`;

const browser = await chromium.launch(LAUNCH_OPTS);
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.goto(BASE + '/');

const reg = await page.evaluate(async (BASE) => {
  const r = await fetch(BASE + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'qwr' + Math.random().toString(36).slice(2, 8), pin: '123456', displayName: 'Jeff' }) });
  return r.json();
}, BASE);
await page.evaluate((tok) => localStorage.setItem('crewfit_token', tok), reg.token);
await page.reload();
await page.waitForSelector('.nav', { timeout: 10000 });

// A real saved routine, seeded via the API exactly like "Build one from the Workouts tab" would.
const tplName = 'Push Day A';
await page.evaluate(async ({ BASE, tplName }) => {
  const r = await fetch(BASE + '/api/templates', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('crewfit_token') },
    body: JSON.stringify({ name: tplName, exercises: [
      { name: 'Flat Barbell Bench Press', defaultSets: 4, defaultReps: 6, defaultRepsMax: 8 },
      { name: 'Incline Dumbbell Bench Press', defaultSets: 3, defaultReps: 8, defaultRepsMax: 12 },
    ] }) });
  return r.json();
}, { BASE, tplName });

console.log('tapping + Quick Workout, then Routine, opens the REAL routines page -- not the old stripped popup');
{
  await page.goto(BASE + '/');
  await page.waitForSelector('.nav', { timeout: 10000 });
  await page.evaluate(() => window.workoutNow());
  await page.waitForSelector('.pick-head h1', { timeout: 8000 });
  const h1 = await page.$eval('.pick-head h1', el => el.textContent.trim());
  ok(h1 === 'Quick Workout', `landed on the Quick Workout picker (got ${JSON.stringify(h1)})`);

  await page.click('.pick-head button:has-text("Routine")');
  await page.waitForSelector('.tpl-h1', { timeout: 8000 });
  const routinesH1 = await page.$eval('.tpl-h1', el => el.textContent.trim());
  ok(routinesH1 === 'Routines', `the real Routines PAGE opened (got ${JSON.stringify(routinesH1)})`);
  // The old popup only ever showed a name + a bare exercise count. This page's row previews the
  // actual exercise names -- proof it's the real templatesPage(), not a relabeled clone of the sheet.
  const rowText = await page.$eval('.tpl-row', el => el.textContent);
  ok(rowText.includes('Flat Barbell Bench Press'), `the row previews real exercise names, not just a count (got ${JSON.stringify(rowText)})`);
  const hasOldPopup = await page.$('.sheet-back') !== null;
  ok(!hasOldPopup, 'no sheet/popup involved -- this is a real full-screen page');
}

console.log('tapping into the routine shows every exercise AND the owner Edit/Delete menu -- both missing from the old popup');
{
  await page.click('.tpl-row');
  // .tpl-h1 is used by BOTH the list's own h1 and the detail screen's -- wait for something only
  // the detail screen renders (the ⋯ menu) so this doesn't race the still-present list heading.
  await page.waitForSelector('.pp-dots', { timeout: 8000 });
  const title = await page.$eval('.tpl-h1', el => el.textContent.trim());
  ok(title === tplName, `landed on the routine's own detail screen (got ${JSON.stringify(title)})`);
  const exNames = await page.$$eval('.card .lib-item', els => els.map(e => e.textContent));
  ok(exNames.some(t => t.includes('Flat Barbell Bench Press')) && exNames.some(t => t.includes('Incline Dumbbell Bench Press')),
    `both exercises are really listed (got ${JSON.stringify(exNames)})`);
  await page.click('.pp-dots');
  const menuText = await page.$eval('.pp-menu', el => el.textContent);
  ok(/Edit/.test(menuText), `an Edit option is really there (got ${JSON.stringify(menuText)})`);
  await page.click('.pp-dots'); // close the menu again before navigating away
}

console.log('real Back from the routine detail, then real Back from the routines list, lands you right back in the Quick Workout picker');
{
  await page.click('button:has-text("← Back")'); // detail -> list
  await page.waitForSelector('.tpl-page', { timeout: 8000 });
  await page.click('button:has-text("← Back")'); // list -> quick workout picker
  await page.waitForSelector('.pick-head h1', { timeout: 8000 });
  const h1 = await page.$eval('.pick-head h1', el => el.textContent.trim());
  ok(h1 === 'Quick Workout', `back on the real Quick Workout picker, not a plain Workouts tab (got ${JSON.stringify(h1)})`);
  const hasRoutineBtn = await page.$('.pick-head button:has-text("Routine")') !== null;
  ok(hasRoutineBtn, 'the Routine button is still there -- QUICK_ADD_MODE survived the round trip');
}

console.log('"Use routine", tapped from the detail screen, actually builds and starts the quick workout with that routine\'s real exercises');
{
  await page.click('.pick-head button:has-text("Routine")');
  await page.waitForSelector('.tpl-row', { timeout: 8000 });
  await page.click('.tpl-row'); // into detail
  await page.waitForSelector('button:has-text("Use routine")', { timeout: 8000 });

  const postPromise = page.waitForResponse(r => r.url().includes('/api/sessions') && r.request().method() === 'POST');
  await page.click('button:has-text("Use routine")');
  // Naming prompt defaults to the routine's own name -- confirm it, matching the old
  // quickUseRoutine()'s "Start" behavior.
  await page.waitForSelector('button:has-text("Start")', { timeout: 5000 });
  const nameVal = await page.$eval('input', el => el.value);
  ok(nameVal === tplName, `the naming prompt defaults to the routine's own name (got ${JSON.stringify(nameVal)})`);
  await page.click('button:has-text("Start")');
  const resp = await postPromise;
  const body = JSON.parse(resp.request().postData());
  ok(body.name === tplName, `the session was created with the routine's name (got ${JSON.stringify(body.name)})`);
  ok(body.visibility === 'private', `a quick workout stays private regardless of the routine (got ${JSON.stringify(body.visibility)})`);
  const exNames = (body.exercises || []).map(e => e.name);
  ok(exNames.includes('Flat Barbell Bench Press') && exNames.includes('Incline Dumbbell Bench Press'),
    `the real routine's exercises are what got posted (got ${JSON.stringify(exNames)})`);

  await page.waitForSelector('.ex-log', { timeout: 8000 });
  const cardNames = await page.$$eval('.ex-name', els => els.map(e => e.textContent));
  ok(cardNames.includes('Flat Barbell Bench Press') && cardNames.includes('Incline Dumbbell Bench Press'),
    `landed on the real live session with both exercises logged as cards (got ${JSON.stringify(cardNames)})`);
}

console.log('the ordinary (non-quick) Routines entry point is UNCHANGED -- Use still opens the full New Workout form');
{
  await page.goto(BASE + '/');
  await page.waitForSelector('.nav', { timeout: 10000 });
  // The plain Workouts tab's own "Routines" button (not Quick Workout's).
  await page.click('button[data-tab="lib"]');
  await page.waitForSelector('.pick-head', { timeout: 8000 });
  await page.click('.pick-head button:has-text("Routines")');
  await page.waitForSelector('.tpl-row', { timeout: 8000 });
  await page.click('.tpl-row .txt-btn'); // the list row's own inline "Use", not the detail screen
  await page.waitForSelector('#wname', { timeout: 8000 });
  const wnameVal = await page.$eval('#wname', el => el.value);
  ok(wnameVal === tplName, `Use from the plain Routines list still lands on the full New Workout form, prefilled (got ${JSON.stringify(wnameVal)})`);
}

console.log('detouring into Edit on a routine, then Cancel, still resumes the real Quick Workout picker on Back -- not a plain library');
{
  // A deeper edge case: entering the routine editor (Edit) mid-Quick-Workout clears QUICK_ADD_MODE/
  // LIB_ADDMODE via resetTransientModes() (same as walking away via the bottom nav always has), and
  // Cancel out of the editor lands back on the routines list -- routinesBack()'s own TPL_FROM_QUICK
  // flag has to survive that detour (it isn't touched by resetTransientModes(), same as
  // TPL_FROM_CREATE isn't) for the list's "← Back" to still know to rebuild the picker afterward.
  await page.goto(BASE + '/');
  await page.waitForSelector('.nav', { timeout: 10000 });
  await page.evaluate(() => window.workoutNow());
  await page.waitForSelector('.pick-head h1', { timeout: 8000 });
  await page.click('.pick-head button:has-text("Routine")');
  await page.waitForSelector('.tpl-row', { timeout: 8000 });
  await page.click('.tpl-row .pp-dots, .tpl-row'); // open detail (row itself, not the dots -- list rows have no dots)
  await page.waitForSelector('.pp-dots', { timeout: 8000 });
  await page.click('.pp-dots');
  await page.click('.pp-menu button:has-text("Edit")');
  await page.waitForSelector('#tplNameEdit, input', { timeout: 8000 });
  // Cancel out of the editor -- whatever its real Cancel/Back control is.
  const cancelBtn = await page.$('button:has-text("Cancel")');
  if (cancelBtn) await cancelBtn.click(); else await page.click('button:has-text("← Back")');
  await page.waitForSelector('.tpl-page', { timeout: 8000 });
  await page.click('button:has-text("← Back")'); // list -> should rebuild the quick workout picker
  await page.waitForSelector('.pick-head h1', { timeout: 8000 });
  const h1 = await page.$eval('.pick-head h1', el => el.textContent.trim());
  ok(h1 === 'Quick Workout', `survives an Edit/Cancel detour -- still the real Quick Workout picker (got ${JSON.stringify(h1)})`);
}

console.log('cold-review catch: tapping "Use" DIRECTLY after an Edit/Cancel detour (no Back first) must still build the quick workout, not silently open the full wizard');
{
  // The Edit detour above clears QUICK_ADD_MODE via resetTransientModes() same as any walk-away
  // does; tplBack() (the editor's own Cancel) restores it again right afterward specifically so
  // this -- the more natural next tap than Back -- takes the right path too.
  await page.goto(BASE + '/');
  await page.waitForSelector('.nav', { timeout: 10000 });
  await page.evaluate(() => window.workoutNow());
  await page.waitForSelector('.pick-head h1', { timeout: 8000 });
  await page.click('.pick-head button:has-text("Routine")');
  await page.waitForSelector('.tpl-row', { timeout: 8000 });
  await page.click('.tpl-row');
  await page.waitForSelector('.pp-dots', { timeout: 8000 });
  await page.click('.pp-dots');
  await page.click('.pp-menu button:has-text("Edit")');
  await page.waitForSelector('#tplNameEdit, input', { timeout: 8000 });
  const cancelBtn = await page.$('button:has-text("Cancel")');
  if (cancelBtn) await cancelBtn.click(); else await page.click('button:has-text("← Back")');
  await page.waitForSelector('.tpl-page', { timeout: 8000 });
  // Straight to Use on the list row -- no Back tap first.
  const postPromise = page.waitForResponse(r => r.url().includes('/api/sessions') && r.request().method() === 'POST');
  await page.click('.tpl-row .txt-btn');
  const stillOnNewWorkoutForm = await page.$('#wname') !== null;
  ok(!stillOnNewWorkoutForm, 'did NOT silently fall through to the full New Workout wizard');
  await page.waitForSelector('button:has-text("Start")', { timeout: 5000 });
  await page.click('button:has-text("Start")');
  const resp = await postPromise;
  const body = JSON.parse(resp.request().postData());
  ok(body.visibility === 'private' && (body.exercises || []).some(e => e.name === 'Flat Barbell Bench Press'),
    `Use after the detour really built the quick workout from the routine (got ${JSON.stringify(body)})`);
}

console.log('repeated Routine -> Back cycling stays correct and bounded (a known, accepted small-stack-growth trade-off, not runaway)');
{
  // routinesBack()'s TPL_FROM_QUICK branch reconstructs the picker via a direct call
  // (QUICK_ADD_MODE=true; openAddExercises()), the exact same shape as the pre-existing
  // TPL_FROM_CREATE branch uses for createFlow() -- NOT a real history.back(). A "smarter"
  // history.back()-based version was tried first and reverted: closeSheet()'s
  // history.replaceState() after cancelling a sheet (e.g. "+ New routine") relabels the sheet's
  // own pushed entry back to the underlying screen's state rather than truly popping it, so the
  // stack can end up with the SAME state sitting at two adjacent positions -- making a single
  // history.back() pop the wrong (duplicate) entry and land back on an unchanged-looking screen
  // instead of the picker, needing an unpredictable second Back tap. The direct-call approach
  // sidesteps that correctness risk entirely at the cost of a small, bounded, already-precedented
  // amount of history growth each round trip (routinesBack() pushes a fresh {t:'tab',tab:'lib'}
  // entry on top of the still-there 'routines' one) -- this only proves that growth stays linear
  // and small, not that it's zero.
  await page.goto(BASE + '/');
  await page.waitForSelector('.nav', { timeout: 10000 });
  await page.evaluate(() => window.workoutNow());
  await page.waitForSelector('.pick-head h1', { timeout: 8000 });
  const lenBefore = await page.evaluate(() => history.length);
  for (let i = 0; i < 3; i++) {
    await page.click('.pick-head button:has-text("Routine")');
    await page.waitForSelector('.tpl-row', { timeout: 8000 });
    await page.click('button:has-text("← Back")');
    await page.waitForSelector('.pick-head h1', { timeout: 8000 });
    const h1 = await page.$eval('.pick-head h1', el => el.textContent.trim());
    ok(h1 === 'Quick Workout', `round trip ${i + 1}: Back correctly lands on the picker in exactly one tap`);
  }
  const lenAfter = await page.evaluate(() => history.length);
  ok(lenAfter - lenBefore <= 12, `history.length growth over 3 round trips stays small and bounded, not runaway (before=${lenBefore}, after=${lenAfter}, delta=${lenAfter - lenBefore})`);
}

console.log('cold-review catch: tapping "← Back" immediately after Cancel on the "New routine" name sheet (its .sheet-back still fading) must not get swallowed');
{
  // The global popstate handler's first check is "if any .sheet-back exists, this Back was just
  // dismissing a sheet -- swallow it, don't navigate" -- closeSheet() leaves its own .sheet-back
  // fading in the DOM for up to 200ms AFTER a sheet is functionally closed. This is exactly the
  // race that made the direct-call reconstruction in routinesBack() (see its own comment) the
  // right choice over a history.back()-based one: bypassing history/popstate entirely here means
  // this timing can't swallow anything, tested with no artificial delay between Cancel and Back.
  await page.goto(BASE + '/');
  await page.waitForSelector('.nav', { timeout: 10000 });
  await page.evaluate(() => window.workoutNow());
  await page.waitForSelector('.pick-head h1', { timeout: 8000 });
  await page.click('.pick-head button:has-text("Routine")');
  await page.waitForSelector('.tpl-row', { timeout: 8000 });
  await page.click('button:has-text("+ New routine")');
  await page.waitForSelector('#tplName', { timeout: 5000 });
  await page.click('.sheet button:has-text("Cancel")');
  // No wait here -- back-to-back with Cancel, deliberately inside the fade window.
  await page.click('button:has-text("← Back")');
  await page.waitForSelector('.pick-head h1', { timeout: 8000 });
  const h1 = await page.$eval('.pick-head h1', el => el.textContent.trim());
  ok(h1 === 'Quick Workout', `real Back landed on the Quick Workout picker, not swallowed by the fading sheet backdrop (got ${JSON.stringify(h1)})`);
}

ok(errors.length === 0, `no console pageerrors along the way (got ${JSON.stringify(errors)})`);

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
try { srv.kill(); } catch {}
rmSync(dir, { recursive: true, force: true });
await browser.close();
await testDb.drop();
process.exit(fails ? 1 : 0);
