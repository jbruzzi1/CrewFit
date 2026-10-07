// Sep 27 2026 (Jeff): "Its a long screen with all of the selected exercises. I think we keep only
// the active exerise open and showing everything. All other exercises collapse into just the
// name. Once we click on it - it uncollapses and the previous open one collapses." Asked directly
// which exercise should start expanded and what a collapsed row should show, Jeff picked
// "wherever you left off" (falling back to the first exercise for a brand new session) and
// "name + progress indicator" (a checkmark once you've hit the target set count, otherwise a
// count) over the literal "just the name".
//
// Real end-to-end UI test: a real session with three exercises, real clicks between them (not
// scripted calls to openExercise), a real page reload to confirm the open one survives a return
// visit (persisted via localStorage, see getOpenExercise/setOpenExercise in app.js), and a real
// ?openLog= deep link to confirm it always opens the exercise it targets, overriding whatever this
// session last remembered.
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
const testDb = await freshTestDb('exaccordion');

function boot(port, dir) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    srv.stdout.on('data', d => { if (String(d).includes('CrewFit on')) res(srv); });
    setTimeout(() => res(null), 15000);
  });
}

const PORT = 4994;
const dir = mkdtempSync(join(tmpdir(), 'crewfit-exaccordion-'));
const srv = await boot(PORT, dir);
if (!srv) { console.log('FAIL server did not boot'); process.exit(1); }
const BASE = `http://localhost:${PORT}`;

const browser = await chromium.launch(LAUNCH_OPTS);
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.goto(BASE + '/');

const reg = await page.evaluate(async (BASE) => {
  const r = await fetch(BASE + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'exa' + Math.random().toString(36).slice(2, 8), pin: '12345678', displayName: 'Jeff' }) });
  return r.json();
}, BASE);
await page.evaluate((tok) => localStorage.setItem('crewfit_token', tok), reg.token);
await page.reload();
await page.waitForSelector('.nav', { timeout: 10000 });

const s = await page.evaluate(async (BASE) => {
  const r = await fetch(BASE + '/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('crewfit_token') },
    body: JSON.stringify({ name: 'Push day', visibility: 'private', scheduledAt: new Date().toISOString(),
      exercises: [{ name: 'Flat Barbell Bench Press', defaultSets: 3, defaultReps: 8, defaultRepsMax: 10 },
                  { name: 'Incline Dumbbell Press', defaultSets: 2, defaultReps: 8, defaultRepsMax: 10 },
                  { name: 'Cable Fly', defaultSets: 3, defaultReps: 12 }] }) });
  return r.json();
}, BASE);
const [exId1, exId2, exId3] = s.exercises.map(e => e.id);

await page.evaluate((id) => window.openSession(id), s.id);
await page.waitForSelector(`.ex-log[data-ex="${exId1}"]`, { timeout: 8000 });

console.log('a brand new session opens with only the FIRST exercise expanded; the rest are collapsed to just their name');
{
  const w1 = await page.$(`.ex-log[data-ex="${exId1}"] [data-f="w"]`);
  ok(w1 !== null, 'exercise 1 (first in the list) is the one rendering a real logger');
  const w2 = await page.$(`.ex-log[data-ex="${exId2}"] [data-f="w"]`);
  const w3 = await page.$(`.ex-log[data-ex="${exId3}"] [data-f="w"]`);
  ok(w2 === null && w3 === null, 'exercises 2 and 3 have no logger inputs at all while collapsed');
  // The exercise library resolves "Incline Dumbbell Press" to its canonical full name -- not
  // under test here, just what the fixture actually ends up called.
  const name2 = await page.$eval(`.ex-log[data-ex="${exId2}"] .ex-name`, el => el.textContent.trim());
  ok(/Incline Dumbbell/.test(name2), `exercise 2's collapsed row still shows its real name (got ${JSON.stringify(name2)})`);
  const count2 = await page.$eval(`.ex-log[data-ex="${exId2}"] .ex-collapsed-count`, el => el.textContent.trim());
  ok(count2 === '0/2 sets', `never-logged exercise with a real 2-set target reads "0/2 sets" (got ${JSON.stringify(count2)})`);
}

console.log('tapping a collapsed exercise expands it and collapses whichever one was open before');
{
  await page.click(`.ex-log[data-ex="${exId2}"] .ex-head`);
  await page.waitForSelector(`.ex-log[data-ex="${exId2}"] [data-f="w"]`, { timeout: 5000 });
  const w1 = await page.$(`.ex-log[data-ex="${exId1}"] [data-f="w"]`);
  ok(w1 === null, 'exercise 1 collapsed back down the moment exercise 2 was opened');
  const w3 = await page.$(`.ex-log[data-ex="${exId3}"] [data-f="w"]`);
  ok(w3 === null, 'exercise 3 was never opened at all -- still collapsed');
  const name1 = await page.$eval(`.ex-log[data-ex="${exId1}"] .ex-name`, el => el.textContent.trim());
  ok(name1 === 'Flat Barbell Bench Press', 'exercise 1, now collapsed, still shows its real name');
}

console.log('the collapsed progress readout updates as sets are logged, and shows a checkmark once the target is hit -- Jeff\'s pick over "just the name" when asked directly');
{
  // Exercise 2's target is 2 sets (defaultSets above). Log one on the now-open card.
  await page.fill(`.ex-log[data-ex="${exId2}"] [data-f="w"]`, '30');
  await page.fill(`.ex-log[data-ex="${exId2}"] [data-f="r"]`, '10');
  await page.click(`.ex-log[data-ex="${exId2}"] .add-btn`);
  await page.waitForTimeout(300);
  // Switch to exercise 3 to see exercise 2 collapse with its updated readout.
  await page.click(`.ex-log[data-ex="${exId3}"] .ex-head`);
  await page.waitForSelector(`.ex-log[data-ex="${exId3}"] [data-f="w"]`, { timeout: 5000 });
  const count2 = await page.$eval(`.ex-log[data-ex="${exId2}"] .ex-collapsed-count`, el => el.textContent.trim());
  ok(count2 === '1/2 sets', `one set logged against a target of 2 reads "1/2 sets" (got ${JSON.stringify(count2)})`);

  // Go back to exercise 2 and log the second (target-hitting) set.
  await page.click(`.ex-log[data-ex="${exId2}"] .ex-head`);
  await page.waitForSelector(`.ex-log[data-ex="${exId2}"] [data-f="w"]`, { timeout: 5000 });
  await page.fill(`.ex-log[data-ex="${exId2}"] [data-f="w"]`, '30');
  await page.fill(`.ex-log[data-ex="${exId2}"] [data-f="r"]`, '10');
  await page.click(`.ex-log[data-ex="${exId2}"] .add-btn`);
  await page.waitForTimeout(300);
  // Collapse it again by opening exercise 1.
  await page.click(`.ex-log[data-ex="${exId1}"] .ex-head`);
  await page.waitForSelector(`.ex-log[data-ex="${exId1}"] [data-f="w"]`, { timeout: 5000 });
  const doneBadge = await page.$(`.ex-log[data-ex="${exId2}"] .ex-collapsed-done`);
  ok(doneBadge !== null, 'hitting the 2-set target swaps the count for a checkmark once collapsed');
  const staleCount = await page.$(`.ex-log[data-ex="${exId2}"] .ex-collapsed-count`);
  ok(staleCount === null, 'the plain count is gone now that the checkmark is showing -- not both at once');
}

console.log('reloading the page reopens wherever you left off -- persisted per session, not always exercise #1');
{
  // Exercise 1 is the one currently open (set by the block above). Switch to exercise 3 instead,
  // then reload the whole page cold and confirm exercise 3 -- not exercise 1 -- comes back open.
  await page.click(`.ex-log[data-ex="${exId3}"] .ex-head`);
  await page.waitForSelector(`.ex-log[data-ex="${exId3}"] [data-f="w"]`, { timeout: 5000 });
  await page.reload();
  await page.waitForSelector('.nav', { timeout: 10000 });
  await page.evaluate((id) => window.openSession(id), s.id);
  await page.waitForSelector(`.ex-log[data-ex="${exId3}"] [data-f="w"]`, { timeout: 8000 });
  const w1After = await page.$(`.ex-log[data-ex="${exId1}"] [data-f="w"]`);
  ok(w1After === null, 'exercise 1 is collapsed after the reload -- the remembered open exercise won, not the default first one');
}

console.log('a ?openLog= deep link always opens the exercise it targets, overriding whatever this session last remembered');
{
  // The session currently remembers exercise 3 as open (from the block above). Deep-link straight
  // to exercise 1 and confirm IT is the one that actually renders expanded.
  await page.goto(`${BASE}/?openLog=${s.id}:${exId1}`);
  await page.waitForSelector(`.ex-log[data-ex="${exId1}"] [data-f="w"]`, { timeout: 8000 });
  const w3After = await page.$(`.ex-log[data-ex="${exId3}"] [data-f="w"]`);
  ok(w3After === null, 'exercise 3 (the previously-remembered one) is collapsed -- the deep link\'s own target won instead');
  const focused = await page.evaluate((exId) => {
    const b = document.querySelector(`.ex-log[data-ex="${exId}"]`);
    return b && b.contains(document.activeElement) && document.activeElement.dataset.f === 'w';
  }, exId1);
  ok(focused, 'the deep-linked exercise\'s weight input actually received focus (focusLogBlock), same as before this feature');
}

console.log('Oct 7 2026 (Jeff: "click on an active exercise and it closes -- allow all of them to be closed at once, not always having one opened"): tapping the OPEN card\'s own header collapses it, leaving every exercise collapsed');
{
  // Exercise 1 is the one currently open (the deep link above). Tap its own header, not a
  // different exercise's -- this is the new behavior, distinct from switching.
  await page.click(`.ex-log[data-ex="${exId1}"] .ex-head-open .ex-name`);
  await page.waitForTimeout(300);
  const anyOpen = await page.$('.ex-log [data-f="w"]');
  ok(anyOpen === null, 'no exercise has a logger open -- every card is collapsed, not just a different one');
  const collapsedCount = await page.$$eval('.ex-collapsed', els => els.length);
  ok(collapsedCount === 3, `all three exercises are collapsed (got ${collapsedCount})`);
}

console.log('tapping the exercise-detail "i" button on an open card does NOT also collapse it (stopPropagation)');
{
  // Reopen exercise 1 first (closed by the block above).
  await page.click(`.ex-log[data-ex="${exId1}"] .ex-head-collapsed`);
  await page.waitForSelector(`.ex-log[data-ex="${exId1}"] [data-f="w"]`, { timeout: 5000 });
  await page.click(`.ex-log[data-ex="${exId1}"] .ex-info-btn`);
  await page.waitForTimeout(200);
  const stillOpen = await page.$(`.ex-log[data-ex="${exId1}"] [data-f="w"]`);
  ok(stillOpen !== null, 'the card is still open after tapping the info button -- its own click did not bubble into closeExercise');
  // Dismiss whatever the info tap opened so the next block starts clean.
  await page.evaluate(() => { document.querySelectorAll('.sheet-back').forEach(sb => sb.remove()); });
}

console.log('the "all collapsed" state persists across a reload -- it does not snap back to the first exercise the way "never opened" does');
{
  await page.click(`.ex-log[data-ex="${exId1}"] .ex-head-open .ex-name`);
  await page.waitForTimeout(300);
  await page.reload();
  await page.waitForSelector('.nav', { timeout: 10000 });
  await page.evaluate((id) => window.openSession(id), s.id);
  await page.waitForSelector('.ex-log', { timeout: 8000 });
  const anyOpenAfterReload = await page.$('.ex-log [data-f="w"]');
  ok(anyOpenAfterReload === null, 'still nothing open after a cold reload -- "deliberately closed" is remembered, not treated as "nothing remembered yet"');
}

console.log('a collapsed row still opens normally from the "all collapsed" state');
{
  await page.click(`.ex-log[data-ex="${exId2}"] .ex-head-collapsed`);
  await page.waitForSelector(`.ex-log[data-ex="${exId2}"] [data-f="w"]`, { timeout: 5000 });
  const onlyOneOpen = await page.$$eval('.ex-log [data-f="w"]', els => els.length);
  ok(onlyOneOpen === 1, `exactly one exercise opened (got ${onlyOneOpen} loggers)`);
}

console.log('Oct 7 2026 cold-review catch: tapping "Swap ->" on a non-creator participant\'s OPEN card opens the swap sheet WITHOUT also collapsing the card');
{
  // canSwapHere (app.js) -- canEdit && !isCreator && !myPost && !pendingSwap && !v -- only ever
  // renders inside the OPEN card's own header (exLogBlockHtml's o.statusTag), the one tap zone
  // this whole feature turned into closeExercise(). The info button and the swap-undo note both
  // already had their own stopPropagation; this link didn't, so tapping it also wrote the
  // OPEN_EX_NONE sentinel out from under the sheet it just opened. Reproduce the exact branch: a
  // real second user, invited (not the creator) into a brand-new session, with nothing pending
  // and no swap of her own yet.
  const rileyCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const riley = await rileyCtx.newPage();
  await riley.goto(BASE + '/');
  const rileyReg = await riley.evaluate(async (BASE) => {
    const r = await fetch(BASE + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'exariley' + Math.random().toString(36).slice(2, 8), pin: '12345678', displayName: 'Riley' }) });
    return r.json();
  }, BASE);

  // Profiles are public by default, so a single follow lands immediately as an approved
  // connection (no accept round trip) -- see POST /api/follow/:id in server.js -- which is all
  // inviteUsernames below needs (connectionsOf: an approved follow either direction).
  await page.evaluate(async ({ BASE, id, tok }) => {
    await fetch(BASE + '/api/follow/' + id, { method: 'POST', headers: { Authorization: 'Bearer ' + tok } });
  }, { BASE, id: rileyReg.user.id, tok: reg.token });

  const swapSession = await page.evaluate(async ({ BASE, tok, username }) => {
    const r = await fetch(BASE + '/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
      body: JSON.stringify({ name: 'Swap Test', visibility: 'private', scheduledAt: new Date().toISOString(),
        exercises: [{ name: 'Barbell Back Squat' }], inviteUsernames: [username] }) });
    return r.json();
  }, { BASE, tok: reg.token, username: rileyReg.user.username });
  const swapExId = swapSession.exercises[0].id;

  await riley.evaluate((tok) => localStorage.setItem('crewfit_token', tok), rileyReg.token);
  await riley.reload();
  await riley.waitForSelector('.nav', { timeout: 10000 });
  await riley.evaluate(async ({ BASE, tok, sid }) => {
    await fetch(BASE + '/api/sessions/' + sid + '/accept', { method: 'POST', headers: { Authorization: 'Bearer ' + tok } });
  }, { BASE, tok: rileyReg.token, sid: swapSession.id });

  await riley.evaluate((id) => window.openSession(id), swapSession.id);
  await riley.waitForSelector(`.ex-log[data-ex="${swapExId}"] [data-f="w"]`, { timeout: 8000 });
  const swapLink = await riley.$(`.ex-log[data-ex="${swapExId}"] .swap-link`);
  ok(swapLink !== null, 'Riley (invited, non-creator participant) sees the "Swap ->" link on her open card -- canSwapHere is true for her');

  await riley.click(`.ex-log[data-ex="${swapExId}"] .swap-link`);
  await riley.waitForSelector('.sheet-head h2', { timeout: 3000 });
  const sheetTitle = await riley.$eval('.sheet-head h2', el => el.textContent.trim());
  ok(sheetTitle === 'Swap this exercise', `tapping "Swap ->" opened the swap-choice sheet (got title ${JSON.stringify(sheetTitle)})`);
  const stillOpenAfterSwapTap = await riley.$(`.ex-log[data-ex="${swapExId}"] [data-f="w"]`);
  ok(stillOpenAfterSwapTap !== null, 'the card is STILL open after tapping Swap -> -- the click did not bubble up into closeExercise (the regression this fixes)');

  await riley.evaluate(() => { document.querySelectorAll('.sheet-back').forEach(sb => sb.remove()); });
  await rileyCtx.close();
}

ok(errors.length === 0, `no console pageerrors along the way (got ${JSON.stringify(errors)})`);

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
try { srv.kill(); } catch {}
rmSync(dir, { recursive: true, force: true });
await browser.close();
await testDb.drop();
process.exit(fails ? 1 : 0);
