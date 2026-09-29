// Sep 29 2026 (Jeff, real bug report: "Trying to edit a logged and finished workout on my
// profile - forgot to record a set. It didn't allow to add a set or properly edit a set as if it
// was active. Clicked re-activate workout and nothing really happened. The workout was properly
// re-activated. For small edits - we want to be able to make after its been posted without also
// needing to fully reactivate the workout. Small edits should be allowed, and reactivate would be
// if we accidentally closed, or needed to reopen if we planned to continue on instead of going
// home.")
//
// Two real fixes, both in app.js (server-side /api/sessions/:id/log never checked finished/lock
// state to begin with -- Log & Finish is a per-person s.history credit, not a session-wide lock;
// see /lock and /unlock's own server.js comments):
// 1. addPostedSet/savePostedNewSet -- a "+ Add set" button per exercise on your OWN posted recap
//    (viewPost), own-recap only, that POSTs a brand-new set with zero reactivation. Confirms the
//    set lands AND that Log & Finish credit (s.history), streak/volume-relevant state, and the
//    "Reactivate workout" menu option are all completely untouched by it -- this is explicitly a
//    small edit, not an undo of finishing.
// 2. reactivateWorkoutConfirmed -- used to re-render viewPost() (the same static recap either
//    way) after unlocking, so tapping Reactivate visibly did nothing even though the unlock
//    itself worked. Now lands on the live openSession() view instead.
import { existsSync, mkdtempSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { freshTestDb } from './_pgtestdb.mjs';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };

const SANDBOX_CHROMIUM = '/opt/pw-browsers/chromium';
const LAUNCH_OPTS = existsSync(SANDBOX_CHROMIUM) ? { executablePath: SANDBOX_CHROMIUM } : {};
const CWD = new URL('..', import.meta.url).pathname;

const testDb = await freshTestDb('postedaddset');
function boot(port, dir) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    srv.stdout.on('data', d => { if (String(d).includes('CrewFit on')) res(srv); });
    setTimeout(() => res(null), 15000);
  });
}
const PORT = 4995, BASE = `http://localhost:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), 'postedaddset-'));
const srv = await boot(PORT, dir);
if (!srv) { console.log('FAIL server did not boot'); process.exit(1); }

async function api(path, method, token, body) {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
}
async function reg(username, displayName) {
  const r = await api('/api/register', 'POST', null, { username, pin: '12345678', displayName });
  return { token: r.token, id: r.user.id, username };
}
const jordan = await reg('addset_jordan', 'Jordan');

const sess = await api('/api/sessions', 'POST', jordan.token, { name: 'Push Day', visibility: 'private', scheduledAt: new Date().toISOString(),
  exercises: [{ name: 'Barbell Bench Press', defaultSets: 3, defaultReps: 8, defaultRepsMax: 12 }, { name: 'Overhead Press', defaultSets: 3, defaultReps: 8, defaultRepsMax: 12 }] });
const benchId = sess.exercises[0].id, ohpId = sess.exercises[1].id;
// Log two sets on Bench, none on OHP (forgot it entirely -- the "add to an empty exercise" case).
await api(`/api/sessions/${sess.id}/log`, 'POST', jordan.token, { exerciseId: benchId, weight: 135, reps: 10 });
await api(`/api/sessions/${sess.id}/log`, 'POST', jordan.token, { exerciseId: benchId, weight: 135, reps: 9 });
await api(`/api/sessions/${sess.id}/lock`, 'POST', jordan.token, {});
await api(`/api/sessions/${sess.id}/post`, 'POST', jordan.token, { notes: '', media: [], visibility: 'private' });

console.log('server-level: /log still accepts a new set on an already-finished (Log & Finish credited) session');
{
  const before = await api('/api/sessions/' + sess.id, 'GET', jordan.token);
  const hadCredit = (before.history || []).some(h => h.userId === jordan.id);
  ok(hadCredit, 'sanity: finish credit exists before adding the forgotten set');

  const r = await api(`/api/sessions/${sess.id}/log`, 'POST', jordan.token, { exerciseId: benchId, weight: 135, reps: 8 });
  ok(!r.error, `adding a 3rd Bench set post-finish is accepted, not rejected (got ${JSON.stringify(r.error)})`);
  const benchLogs = (r.logs && r.logs[jordan.id] || []).filter(l => l.exerciseId === benchId);
  ok(benchLogs.length === 3, `all 3 Bench sets present, including the newly-added one (got ${benchLogs.length})`);

  const stillCredited = (r.history || []).some(h => h.userId === jordan.id);
  ok(stillCredited, 'Log & Finish credit is untouched by adding a set -- this is a small edit, not an undo of finishing');
}

console.log('server-level: /log also accepts a FIRST set on an exercise that was skipped entirely, post-finish');
{
  const r = await api(`/api/sessions/${sess.id}/log`, 'POST', jordan.token, { exerciseId: ohpId, weight: 65, reps: 10 });
  ok(!r.error, `adding OHP's first-ever set post-finish is accepted (got ${JSON.stringify(r.error)})`);
  const ohpLogs = (r.logs && r.logs[jordan.id] || []).filter(l => l.exerciseId === ohpId);
  ok(ohpLogs.length === 1, `the new OHP set is there (got ${ohpLogs.length})`);
}

const browser = await chromium.launch(LAUNCH_OPTS);
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.goto(BASE + '/');
await page.evaluate((tok) => localStorage.setItem('crewfit_token', tok), jordan.token);
await page.reload();
await page.waitForSelector('.nav', { timeout: 10000 });

console.log('UI: "+ Add set" is on your own posted recap, per exercise, and actually adds a set with zero reactivation');
{
  await page.evaluate((id) => viewPost(id, ME.id), sess.id);
  await page.waitForSelector('.pp-ex', { timeout: 8000 });
  await page.waitForTimeout(200);

  const btnCount = await page.locator('.pp-add-set').count();
  ok(btnCount === 2, `an "+ Add set" button on both exercise cards, including the one with sets already (got ${btnCount})`);

  // Tap Bench's (first) Add set, fill it in, save.
  await page.locator('.pp-add-set').first().click();
  await page.waitForSelector('#ppAddW', { timeout: 5000 });
  await page.fill('#ppAddW', '140');
  await page.fill('#ppAddR', '6');
  await page.evaluate(() => { const btns = Array.from(document.querySelectorAll('.sheet button.blue')); const b = btns.find(x => x.textContent.trim() === 'Add set'); if (b) b.click(); });
  await page.waitForTimeout(400);

  const afterCount = await page.evaluate(() => document.querySelectorAll('.pp-set').length);
  ok(afterCount === 5, `5 total set rows now shown across both exercises (3 Bench + 1 OHP from the API calls above + 1 just added via the UI) (got ${afterCount})`);

  // Reactivate option must still be there -- adding a set must not have reactivated anything.
  const stillHasReactivate = await page.evaluate(() => Array.from(document.querySelectorAll('button')).some(b => b.textContent.includes('Reactivate workout')));
  ok(stillHasReactivate, '"Reactivate workout" is still offered -- adding a set did not silently finish-undo the workout');
}

console.log('UI: Reactivate workout actually lands on the live session view, not the same static recap');
{
  // The recap screen has no "Log & Finish" button (it already happened); the live session view
  // does. That presence/absence is the real, observable signal this bug was about.
  const hadFinishBtnBefore = await page.evaluate(() => Array.from(document.querySelectorAll('button')).some(b => b.textContent.includes('Log & Finish')));
  ok(!hadFinishBtnBefore, "sanity: the static recap has no Log & Finish button before reactivating");

  await page.evaluate(() => { const btns = Array.from(document.querySelectorAll('button')); const b = btns.find(x => x.textContent.includes('Reactivate workout')); if (b) b.click(); });
  await page.waitForTimeout(200);
  // confirmSheet's own confirm button.
  await page.evaluate(() => { const btns = Array.from(document.querySelectorAll('.sheet button')); const b = btns.find(x => x.textContent.trim() === 'Reactivate workout'); if (b) b.click(); });
  await page.waitForTimeout(500);

  const nowHasFinishBtn = await page.evaluate(() => Array.from(document.querySelectorAll('button')).some(b => b.textContent.includes('Log & Finish')));
  ok(nowHasFinishBtn, 'after Reactivate, the live session view is showing (Log & Finish button present) -- not still the static recap');
}

console.log(errors.length ? '\nPAGE ERRORS:\n' + errors.join('\n') : '\nno page errors');
await page.close();
await browser.close();
srv.kill();
await testDb.drop();
console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails || errors.length ? 1 : 0);
