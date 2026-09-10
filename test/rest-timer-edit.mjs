// Sep 10 2026 (Jeff): "We should be able to edit the rest timer to what we want it do be - having
// it be clickable and opening a pop up to put what we want it to be (keeping it only to allow
// minutes not past 60 minutes to keep it tighter seems best)." Confirmed over a few rounds of
// follow-up: tapping the countdown opens the edit popup (dismiss moved to its own small x),
// setting a time only overrides the current countdown (not a new default), and half-minute steps
// are allowed (not whole minutes only), capped at 60:00.
//
// Round 2 (same day): Jeff saw the first build (full sheet, Minutes field + :00/:30 toggle) and
// asked for something smaller and simpler -- an iPhone-timer-style scroll wheel. Rebuilt as a
// small centered popup (.rest-pop) with one scroll wheel in 30-second steps; Jeff picked the safer
// interaction, so scrolling only stages a value and nothing applies until "Set rest time" is
// actually tapped.
//
// Real end-to-end UI test: logs a set through the actual log sheet to start a real rest timer,
// taps the widget (a real click, not a scripted call to editRestTime) to open the real wheel
// popup, scrolls the real wheel with real wheel events (not a scripted scrollTop set) to confirm
// the CSS scroll-snap actually lands on a value, confirms scrolling alone does NOT change the
// running countdown until "Set rest time" is tapped, and confirms the wheel is inherently bounded
// at 0:30/60:00 (nothing to clamp -- there's no value past the ends of the list to scroll to).
// Also confirms the small x still dismisses without opening the editor.
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
const testDb = await freshTestDb('resttimeredit');

function boot(port, dir) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    srv.stdout.on('data', d => { if (String(d).includes('CrewFit on')) res(srv); });
    setTimeout(() => res(null), 15000);
  });
}

const PORT = 4992;
const dir = mkdtempSync(join(tmpdir(), 'crewfit-resttimeredit-'));
const srv = await boot(PORT, dir);
if (!srv) { console.log('FAIL server did not boot'); process.exit(1); }
const BASE = `http://localhost:${PORT}`;

const browser = await chromium.launch(LAUNCH_OPTS);
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.goto(BASE + '/');

const reg = await page.evaluate(async (BASE) => {
  const r = await fetch(BASE + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'rte' + Math.random().toString(36).slice(2, 8), pin: '123456', displayName: 'Jeff' }) });
  return r.json();
}, BASE);
await page.evaluate((tok) => localStorage.setItem('crewfit_token', tok), reg.token);
await page.reload();
await page.waitForSelector('.nav', { timeout: 10000 });

const s = await page.evaluate(async (BASE) => {
  const r = await fetch(BASE + '/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('crewfit_token') },
    body: JSON.stringify({ name: 'Push day', visibility: 'private', scheduledAt: new Date().toISOString(),
      exercises: [{ name: 'Flat Barbell Bench Press', defaultSets: 3, defaultReps: 8, defaultRepsMax: 10 },
                  { name: 'Incline Dumbbell Press', defaultSets: 3, defaultReps: 8, defaultRepsMax: 10 }] }) });
  return r.json();
}, BASE);
const exId = s.exercises[0].id, exId2 = s.exercises[1].id;

await page.evaluate((id) => window.openSession(id), s.id);
await page.waitForSelector(`.ex-log[data-ex="${exId}"]`, { timeout: 8000 });
await page.waitForSelector(`.ex-log[data-ex="${exId2}"]`, { timeout: 8000 });

console.log('logging a real set starts a real rest timer, showing the new "tap to edit" wording');
{
  await page.fill(`.ex-log[data-ex="${exId}"] [data-f="w"]`, '135');
  await page.fill(`.ex-log[data-ex="${exId}"] [data-f="r"]`, '8');
  await page.click(`.ex-log[data-ex="${exId}"] .add-btn`);
  await page.waitForSelector(`.ex-log[data-ex="${exId}"] .rest`, { timeout: 5000 });
  const txt = await page.$eval(`.ex-log[data-ex="${exId}"] .rest`, el => el.textContent);
  ok(/tap to edit/i.test(txt), `the widget invites editing, not the old "tap to dismiss" (got ${JSON.stringify(txt)})`);
  ok(!/tap to dismiss/i.test(txt), 'the old "tap to dismiss" wording is gone');
  const hasX = await page.$(`.ex-log[data-ex="${exId}"] .rest-x`) !== null;
  ok(hasX, 'a separate small x exists for dismissing');
}

console.log('a real tap on the countdown (not the x) opens the wheel popup, prefilled to the running time');
{
  await page.click(`.ex-log[data-ex="${exId}"] .rest b`);   // tap the number itself, not the x
  await page.waitForSelector('.rest-pop', { timeout: 5000 });
  const heading = await page.$eval('.rest-pop-head span', el => el.textContent.trim());
  ok(heading === 'Rest time', `the popup opened with the right heading (got ${JSON.stringify(heading)})`);
  const sel = await page.$eval('.rw-item.sel', el => el.textContent.trim());
  ok(sel === '1:00', `wheel starts centered on the running ~60s countdown (got ${JSON.stringify(sel)})`);
}

console.log('a real scroll on the wheel moves the highlighted value, but does NOT touch the running countdown yet');
{
  const beforeLabel = await page.$eval(`.ex-log[data-ex="${exId}"] .rest [data-f="restN"]`, el => el.textContent.trim());
  await page.hover('#restWheel');
  await page.mouse.wheel(0, 126);            // 3 items x 42px -- 1:00 -> 2:30
  await page.waitForTimeout(250);            // let scroll-snap settle on a value
  const sel = await page.$eval('.rw-item.sel', el => el.textContent.trim());
  ok(sel === '2:30', `a real wheel scroll landed the snap on 2:30 (got ${JSON.stringify(sel)})`);

  const stillLabel = await page.$eval(`.ex-log[data-ex="${exId}"] .rest [data-f="restN"]`, el => el.textContent.trim());
  ok(stillLabel === beforeLabel, `scrolling alone did not change the live countdown yet (still ${JSON.stringify(stillLabel)}, safer-by-design per Jeff's pick)`);
}

console.log('tapping "Set rest time" applies the staged value to the real running countdown');
{
  await page.click('.rest-pop .blue:has-text("Set rest time")');
  await page.waitForTimeout(300);   // sheet close + startRest re-render

  const popGone = await page.$('.sheet-back.show') === null;
  ok(popGone, 'the popup closed after setting the time');

  const label = await page.$eval(`.ex-log[data-ex="${exId}"] .rest [data-f="restN"]`, el => el.textContent.trim());
  // 2:30 = 150s -- allow a couple seconds of real elapsed time during the test itself
  const [m, sec] = label.split(':').map(Number);
  const totalNow = m * 60 + sec;
  ok(totalNow > 145 && totalNow <= 150, `countdown now reflects ~2:30, not the original ~1:00 (got ${JSON.stringify(label)}, ${totalNow}s)`);
}

console.log('the small x still dismisses on its own, without opening the editor');
{
  await page.click(`.ex-log[data-ex="${exId}"] .rest-x`);
  await page.waitForTimeout(200);
  const widgetGone = await page.$(`.ex-log[data-ex="${exId}"] .rest`) === null;
  ok(widgetGone, 'the rest widget is gone after tapping the x');
  const popOpened = await page.$('.sheet-back.show') !== null;
  ok(!popOpened, 'tapping the x did NOT also open the wheel popup');
}

console.log('the wheel is bounded by its own values -- overscrolling either end cannot go past 0:30 / 60:00');
{
  await page.fill(`.ex-log[data-ex="${exId}"] [data-f="w"]`, '140');
  await page.fill(`.ex-log[data-ex="${exId}"] [data-f="r"]`, '8');
  await page.click(`.ex-log[data-ex="${exId}"] .add-btn`);
  await page.waitForSelector(`.ex-log[data-ex="${exId}"] .rest`, { timeout: 5000 });

  await page.click(`.ex-log[data-ex="${exId}"] .rest b`);
  await page.waitForSelector('.rest-pop', { timeout: 5000 });
  await page.hover('#restWheel');
  await page.mouse.wheel(0, 200000);   // absurdly large real scroll past the bottom of the list
  await page.waitForTimeout(300);
  let sel = await page.$eval('.rw-item.sel', el => el.textContent.trim());
  ok(sel === '60:00', `overscrolling past the end lands on the real ceiling, not something absurd (got ${JSON.stringify(sel)})`);
  await page.click('.rest-pop .blue:has-text("Set rest time")');
  await page.waitForTimeout(300);
  let label = await page.$eval(`.ex-log[data-ex="${exId}"] .rest [data-f="restN"]`, el => el.textContent.trim());
  let [m, sec] = label.split(':').map(Number);
  ok(m * 60 + sec <= 3600 && m * 60 + sec > 3590, `applied ceiling reads as ~60:00 on the widget (got ${JSON.stringify(label)})`);

  await page.click(`.ex-log[data-ex="${exId}"] .rest b`);
  await page.waitForSelector('.rest-pop', { timeout: 5000 });
  await page.hover('#restWheel');
  await page.mouse.wheel(0, -200000);   // absurdly large real scroll past the top of the list
  await page.waitForTimeout(300);
  sel = await page.$eval('.rw-item.sel', el => el.textContent.trim());
  ok(sel === '0:30', `overscrolling past the start lands on the real floor, not a dead 0:00 (got ${JSON.stringify(sel)})`);
  await page.click('.rest-pop .blue:has-text("Set rest time")');
  await page.waitForTimeout(300);
  label = await page.$eval(`.ex-log[data-ex="${exId}"] .rest [data-f="restN"]`, el => el.textContent.trim());
  [m, sec] = label.split(':').map(Number);
  ok(m * 60 + sec >= 27 && m * 60 + sec <= 30, `applied floor reads as a real 0:30 on the widget (got ${JSON.stringify(label)})`);
}

console.log('the wheel is keyboard-operable, not scroll-only (real a11y path: focus, arrow, confirm)');
{
  // exId2 (exercise 2) has never logged a set yet in this test -- start its own real rest timer first.
  await page.fill(`.ex-log[data-ex="${exId2}"] [data-f="w"]`, '30');
  await page.fill(`.ex-log[data-ex="${exId2}"] [data-f="r"]`, '10');
  await page.click(`.ex-log[data-ex="${exId2}"] .add-btn`);
  await page.waitForSelector(`.ex-log[data-ex="${exId2}"] .rest`, { timeout: 5000 });

  await page.click(`.ex-log[data-ex="${exId2}"] .rest b`);
  await page.waitForSelector('.rest-pop', { timeout: 5000 });
  const before = await page.$eval('.rw-item.sel', el => el.textContent.trim());
  await page.focus('#restWheel');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(150);
  const after = await page.$eval('.rw-item.sel', el => el.textContent.trim());
  ok(after !== before, `two real ArrowDown keypresses actually moved the selection (before=${JSON.stringify(before)}, after=${JSON.stringify(after)})`);
  const wheelRole = await page.$eval('#restWheel', el => el.getAttribute('role'));
  ok(wheelRole === 'slider', 'the wheel exposes an ARIA role for assistive tech, not a bare scroll div');
  await page.click('.rest-pop .blue:has-text("Set rest time")');
  await page.waitForTimeout(300);
  const label = await page.$eval(`.ex-log[data-ex="${exId2}"] .rest [data-f="restN"]`, el => el.textContent.trim());
  ok(label === after, `the keyboard-selected value (${JSON.stringify(after)}) actually got applied on confirm (widget now shows ${JSON.stringify(label)})`);
}

console.log('a stale popup left open while a DIFFERENT exercise starts its own timer must not clobber that timer on confirm');
{
  // exId (exercise 1) has had no running timer since the overscroll block above applied to it;
  // start a fresh one, then open its edit popup and leave it open without confirming.
  await page.fill(`.ex-log[data-ex="${exId}"] [data-f="w"]`, '135');
  await page.fill(`.ex-log[data-ex="${exId}"] [data-f="r"]`, '8');
  await page.click(`.ex-log[data-ex="${exId}"] .add-btn`);
  await page.waitForSelector(`.ex-log[data-ex="${exId}"] .rest`, { timeout: 5000 });
  await page.click(`.ex-log[data-ex="${exId}"] .rest b`);
  await page.waitForSelector('.rest-pop', { timeout: 5000 });
  await page.hover('#restWheel');
  await page.mouse.wheel(0, 400);   // stage some other value in what's about to become a stale popup, never confirmed

  // The popup's own backdrop covers the whole screen and blocks pointer events on the rest of the
  // page (confirmed by hand: a real page.click on exercise 2's own +Add times out, intercepted by
  // the backdrop) -- so THIS user cannot tap a different exercise's +Add while the popup is open.
  // The real way REST_EX/REST_UNTIL can still change out from under an open popup is a caller that
  // doesn't go through a click on this screen at all: a training partner's set syncing in on a
  // shared session, or the "Say 'Drop set, 90 for 12'" voice quick-log. Both ultimately call the
  // exact same real startRest() -- invoke it directly here to stand in for that background trigger,
  // since simulating a full second participant's socket update is more harness than this is worth.
  await page.evaluate((id) => window.startRest(id, Date.now() + 45000), exId2);
  await page.waitForSelector(`.ex-log[data-ex="${exId2}"] .rest`, { timeout: 5000 });
  const ex2LabelBefore = await page.$eval(`.ex-log[data-ex="${exId2}"] .rest [data-f="restN"]`, el => el.textContent.trim());

  // exercise 1's own widget is gone -- startRest() clears every .rest box on the page when a new
  // one starts; that's existing/intended "one timer for the page" behavior, not what's under test.
  const ex1WidgetGone = await page.$(`.ex-log[data-ex="${exId}"] .rest`) === null;
  ok(ex1WidgetGone, "exercise 1's widget is gone now that exercise 2's timer is the page's live one");

  // now confirm the STALE popup (still open, still showing the value staged before exercise 2's
  // timer started)
  await page.click('.rest-pop .blue:has-text("Set rest time")');
  await page.waitForTimeout(300);

  const popGone = await page.$('.sheet-back.show') === null;
  ok(popGone, 'the stale popup still closes on confirm even though its staged value was not applied');

  const ex1WidgetStillGone = await page.$(`.ex-log[data-ex="${exId}"] .rest`) === null;
  ok(ex1WidgetStillGone, "confirming the stale popup did NOT resurrect exercise 1's timer");

  const ex2LabelAfter = await page.$eval(`.ex-log[data-ex="${exId2}"] .rest [data-f="restN"]`, el => el.textContent.trim());
  const [m1, s1] = ex2LabelBefore.split(':').map(Number), [m2, s2] = ex2LabelAfter.split(':').map(Number);
  const secBefore = m1 * 60 + s1, secAfter = m2 * 60 + s2;
  // exercise 2's timer just keeps counting down normally (a second or two less than before) -- it
  // must NOT have been reset/overwritten by the stale popup's staged value.
  ok(secAfter <= secBefore && secAfter > secBefore - 5, `exercise 2's own running timer was left alone by the stale popup (before=${secBefore}s, after=${secAfter}s)`);
}

ok(errors.length === 0, `no console pageerrors along the way (got ${JSON.stringify(errors)})`);

try { srv.kill(); } catch {}
rmSync(dir, { recursive: true, force: true });
await browser.close();
await testDb.drop();

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
