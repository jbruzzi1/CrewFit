// Sep 10 2026 (Jeff): sent a real iPhone screenshot of the live logging page and asked "Do we feel
// it's cluttered or proper?... I want you to challenge my thinking and the visual." The honest
// critique: every exercise card shows the Normal/Warm up/Drop/Failure segmented control at full
// prominence at all times, even before any set is logged, when "Normal" is the pick ~90%+ of the
// time. Jeff approved a mockup of collapsing it to a small "Normal [caret]" pill that expands into
// the real segmented control on tap.
//
// NOTE ON HISTORY: v259 originally had a near-identical collapsed pill; v313 (Sep 4) explicitly
// REMOVED it ("remove the menu for selecting what type of set it is and have them all listed").
// Before building this, that history was surfaced back to Jeff directly, quoting v313. His answer,
// with full awareness of the earlier reversal: "I feel this extra tap isn't really an issue. It
// helps with the clutter and it's one simple tap." That is what authorizes bringing the pill back.
//
// Real end-to-end UI test: logs a set through the actual log sheet (matching Jeff's own screenshot
// data), then drives the pill with real clicks (not scripted calls to openTypeSeg/logSetType) --
// confirms the pill is what's visible by default (not the segmented row), a real click expands it
// to the real .seg.type-seg control, a real click on a non-Normal chip both re-collapses back to
// the pill AND updates the pill's own label/aria-label to match the picked type, and that the type
// actually picked this way is what really gets posted when a set is logged (not just a cosmetic
// label swap). Also confirms opening the pill on one exercise card does not affect a second card's
// own independent pill state (each .ex-log is its own logger, per the comment above lf() in app.js).
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
const testDb = await freshTestDb('typepillcollapse');

function boot(port, dir) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    srv.stdout.on('data', d => { if (String(d).includes('CrewFit on')) res(srv); });
    setTimeout(() => res(null), 15000);
  });
}

const PORT = 4993;
const dir = mkdtempSync(join(tmpdir(), 'crewfit-typepillcollapse-'));
const srv = await boot(PORT, dir);
if (!srv) { console.log('FAIL server did not boot'); process.exit(1); }
const BASE = `http://localhost:${PORT}`;

const browser = await chromium.launch(LAUNCH_OPTS);
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.goto(BASE + '/');

const reg = await page.evaluate(async (BASE) => {
  const r = await fetch(BASE + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'tpc' + Math.random().toString(36).slice(2, 8), pin: '123456', displayName: 'Jeff' }) });
  return r.json();
}, BASE);
await page.evaluate((tok) => localStorage.setItem('crewfit_token', tok), reg.token);
await page.reload();
await page.waitForSelector('.nav', { timeout: 10000 });

// Same two exercises as Jeff's own screenshot: Barbell Row (logged set) and Bent-Over Dumbbell Row.
const s = await page.evaluate(async (BASE) => {
  const r = await fetch(BASE + '/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('crewfit_token') },
    body: JSON.stringify({ name: 'Pull day', visibility: 'private', scheduledAt: new Date().toISOString(),
      exercises: [{ name: 'Barbell Row', defaultSets: 3, defaultReps: 6, defaultRepsMax: 8 },
                  { name: 'Bent-Over Dumbbell Row', defaultSets: 3, defaultReps: 8, defaultRepsMax: 12 }] }) });
  return r.json();
}, BASE);
const exId = s.exercises[0].id, exId2 = s.exercises[1].id;

await page.evaluate((id) => window.openSession(id), s.id);
await page.waitForSelector(`.ex-log[data-ex="${exId}"]`, { timeout: 8000 });
await page.waitForSelector(`.ex-log[data-ex="${exId2}"]`, { timeout: 8000 });

console.log('by default, the collapsed pill is what shows -- not the full segmented control');
{
  const pillVisible = await page.$eval(`.ex-log[data-ex="${exId}"] [data-f="typePill"]`, el => !el.classList.contains('hidden'));
  const segHidden = await page.$eval(`.ex-log[data-ex="${exId}"] [data-f="typeSeg"]`, el => el.classList.contains('hidden'));
  ok(pillVisible, 'the "Normal ▾" pill is visible by default');
  ok(segHidden, 'the full Normal/Warm up/Drop/Failure row is hidden by default');
  const label = await page.$eval(`.ex-log[data-ex="${exId}"] [data-f="typePillLabel"]`, el => el.textContent.trim());
  ok(label === 'Normal', `pill defaults to reading "Normal" (got ${JSON.stringify(label)})`);
}

console.log('a real tap on the pill expands it to the real segmented control, right where the pill was');
{
  await page.click(`.ex-log[data-ex="${exId}"] [data-f="typePill"]`);
  const pillHidden = await page.$eval(`.ex-log[data-ex="${exId}"] [data-f="typePill"]`, el => el.classList.contains('hidden'));
  const segVisible = await page.$eval(`.ex-log[data-ex="${exId}"] [data-f="typeSeg"]`, el => !el.classList.contains('hidden'));
  ok(pillHidden, 'the pill hides once expanded');
  ok(segVisible, 'the real segmented control (all 4 options) is now visible');
  const chipCount = await page.$$eval(`.ex-log[data-ex="${exId}"] [data-f="typeSeg"] .chip`, els => els.length);
  ok(chipCount === 4, `all 4 real set-type chips are present (got ${chipCount})`);
  // Cold-review catch (Sep 10 2026): hiding the focused pill button used to drop focus to <body>
  // with nothing to catch it -- a real regression for keyboard/AT users, since nothing was ever
  // hidden out from under focus before this change. Fixed by giving the seg tabindex="-1" and
  // focusing it the moment it's revealed.
  const focusedIsSeg = await page.evaluate((exId) => document.activeElement === document.querySelector(`.ex-log[data-ex="${exId}"] [data-f="typeSeg"]`), exId);
  ok(focusedIsSeg, 'opening the pill moves focus onto the revealed seg, not dropped to <body>');
}

console.log('picking a non-Normal chip (a real click) collapses back to the pill AND updates its label');
{
  await page.click(`.ex-log[data-ex="${exId}"] [data-f="typeSeg"] .chip[data-t="drop"]`);
  const pillVisible = await page.$eval(`.ex-log[data-ex="${exId}"] [data-f="typePill"]`, el => !el.classList.contains('hidden'));
  const segHidden = await page.$eval(`.ex-log[data-ex="${exId}"] [data-f="typeSeg"]`, el => el.classList.contains('hidden'));
  ok(pillVisible, 'collapsed back to the pill after picking "Drop"');
  ok(segHidden, 'the segmented row is hidden again');
  const label = await page.$eval(`.ex-log[data-ex="${exId}"] [data-f="typePillLabel"]`, el => el.textContent.trim());
  ok(label === 'Drop', `the pill's own label now reads the picked type, not still "Normal" (got ${JSON.stringify(label)})`);
  const ariaLabel = await page.$eval(`.ex-log[data-ex="${exId}"] [data-f="typePill"]`, el => el.getAttribute('aria-label'));
  ok(/Drop/.test(ariaLabel), `the pill's aria-label was also updated for assistive tech (got ${JSON.stringify(ariaLabel)})`);
  const focusedIsPill = await page.evaluate((exId) => document.activeElement === document.querySelector(`.ex-log[data-ex="${exId}"] [data-f="typePill"]`), exId);
  ok(focusedIsPill, 'picking a chip returns focus to the pill, not dropped to <body>');
}

console.log('a PROGRAMMATIC type restore (not a real click inside the seg) must NOT steal focus from elsewhere on the page');
{
  await page.focus(`.ex-log[data-ex="${exId}"] [data-f="w"]`);
  await page.evaluate((exId) => window.logSetType(exId, 'warmup'), exId);
  const focusedIsWeightBox = await page.evaluate((exId) => document.activeElement === document.querySelector(`.ex-log[data-ex="${exId}"] [data-f="w"]`), exId);
  ok(focusedIsWeightBox, 'a programmatic logSetType call (state restore / voice parse shape) left focus on the weight box alone');
  // Leave it back on Normal via a real, in-seg interaction so the state matches what the rest of
  // this test expects going forward.
  await page.click(`.ex-log[data-ex="${exId}"] [data-f="typePill"]`);
  await page.click(`.ex-log[data-ex="${exId}"] [data-f="typeSeg"] .chip[data-t="drop"]`);
}

console.log('the type picked through the collapsed pill is what actually gets posted -- not just a cosmetic label swap');
{
  await page.fill(`.ex-log[data-ex="${exId}"] [data-f="w"]`, '45');
  await page.fill(`.ex-log[data-ex="${exId}"] [data-f="r"]`, '8');
  const postPromise = page.waitForResponse(r => r.url().includes('/log') && r.request().method() === 'POST');
  await page.click(`.ex-log[data-ex="${exId}"] .add-btn`);
  const resp = await postPromise;
  const body = JSON.parse(resp.request().postData());
  ok(body.setType === 'drop', `the logged set really carries setType "drop" (got ${JSON.stringify(body.setType)})`);
}

console.log('reopening the pill after a log picks back up from the last-picked type, not reset to Normal');
{
  const pillVisible = await page.$eval(`.ex-log[data-ex="${exId}"] [data-f="typePill"]`, el => !el.classList.contains('hidden'));
  const label = await page.$eval(`.ex-log[data-ex="${exId}"] [data-f="typePillLabel"]`, el => el.textContent.trim());
  ok(pillVisible, 'still collapsed to the pill after logging');
  ok(label === 'Drop', `the pill still reads the last-picked type after logging (got ${JSON.stringify(label)})`);
  await page.click(`.ex-log[data-ex="${exId}"] [data-f="typePill"]`);
  const dropChipOn = await page.$eval(`.ex-log[data-ex="${exId}"] [data-f="typeSeg"] .chip[data-t="drop"]`, el => el.classList.contains('on'));
  ok(dropChipOn, 'expanding again shows "Drop" as the still-selected chip, not reset to Normal');
  await page.click(`.ex-log[data-ex="${exId}"] [data-f="typeSeg"] .chip[data-t="normal"]`); // leave it back on Normal
}

console.log('the second exercise card has its own, completely independent pill state');
{
  const label2 = await page.$eval(`.ex-log[data-ex="${exId2}"] [data-f="typePillLabel"]`, el => el.textContent.trim());
  const pill2Visible = await page.$eval(`.ex-log[data-ex="${exId2}"] [data-f="typePill"]`, el => !el.classList.contains('hidden'));
  ok(label2 === 'Normal', `card 2's pill was never touched by card 1's picks (got ${JSON.stringify(label2)})`);
  ok(pill2Visible, 'card 2 is still collapsed to its own pill, unaffected by card 1 being expanded/collapsed');
}

ok(errors.length === 0, `no console pageerrors along the way (got ${JSON.stringify(errors)})`);

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
try { srv.kill(); } catch {}
rmSync(dir, { recursive: true, force: true });
await browser.close();
await testDb.drop();
process.exit(fails ? 1 : 0);
