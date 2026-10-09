// Oct 9 2026 (Jeff, from a real screenshot of his own phone showing the "Who's in" chip row
// inside a live workout): "I want to be able to click on those users and it brings me to their
// profile pages - with the back button on the top as normal and then click back brings me back
// to the workout." The chip row (favChip() inside openSession, public/app.js) already existed --
// an avatar + name for everyone currently in the workout, plus anyone still invited and not yet
// answered -- it just wasn't a tap target. Now `onclick="profileView(...)"` on the chip itself,
// same pattern every other person-row in the app already uses (feed items, crew member rows,
// friend rows), so Back works for free: profileView pushes its own real history entry, and the
// app's existing history.back()-based Back button lands you right back on this exact workout.
//
// Real end-to-end UI test: a real session with one JOINED participant and one still-INVITED
// (pending) one -- the two distinct chip states favChip renders -- a real click on each, a real
// browser Back, and a check that the creator-only remove (x) button (which already had its own
// stopPropagation, same pattern as the info button/swap-undo note elsewhere in this file) still
// works without ALSO opening the profile out from under it.
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
const testDb = await freshTestDb('whosinchip');

function boot(port, dir) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    srv.stdout.on('data', d => { if (String(d).includes('CrewFit on')) res(srv); });
    setTimeout(() => res(null), 15000);
  });
}

const PORT = 4988;
const dir = mkdtempSync(join(tmpdir(), 'crewfit-whosinchip-'));
const srv = await boot(PORT, dir);
if (!srv) { console.log('FAIL server did not boot'); process.exit(1); }
const BASE = `http://localhost:${PORT}`;

async function api(path, method, token, body) {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
}
const reg = (u) => api('/api/register', 'POST', null, { username: u + Math.random().toString(36).slice(2, 8), pin: '12345678', displayName: u });
const befriend = async (a, b) => {
  await api('/api/follow/' + b.user.id, 'POST', a.token);
  await api('/api/follow-requests/' + a.user.id + '/accept', 'POST', b.token);
  await api('/api/follow/' + a.user.id, 'POST', b.token);
  await api('/api/follow-requests/' + b.user.id + '/accept', 'POST', a.token);
};

const jeff = await reg('Jeff');
const brian = await reg('Brian');
const casey = await reg('Casey');
await befriend(jeff, brian);
await befriend(jeff, casey);

const sess = await api('/api/sessions', 'POST', jeff.token, {
  name: 'Full Body', visibility: 'private', scheduledAt: new Date().toISOString(),
  exercises: [{ name: 'Push Press' }], inviteUsernames: [brian.user.username, casey.user.username],
});
await api(`/api/sessions/${sess.id}/accept`, 'POST', brian.token, {}); // Brian joined; Casey stays pending.

const browser = await chromium.launch(LAUNCH_OPTS);
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.goto(BASE + '/');
await page.evaluate((tok) => localStorage.setItem('crewfit_token', tok), jeff.token);
await page.reload();
await page.waitForSelector('.nav', { timeout: 10000 });
await page.evaluate((id) => window.openSession(id), sess.id);
await page.waitForSelector('.fav', { timeout: 8000 });

console.log('the "Who\'s in" section renders both chip states: a joined participant and a still-invited one');
{
  const joined = await page.$$('.fav:not(.pending)');
  ok(joined.length === 1, `exactly one joined (non-pending) chip (got ${joined.length})`);
  const joinedText = joined.length ? await joined[0].innerText() : '';
  ok(/Brian/.test(joinedText), `the joined chip is Brian (got ${JSON.stringify(joinedText)})`);
  const pending = await page.$('.fav.pending');
  ok(pending !== null, 'the still-invited chip rendered too, under "Invited · waiting to respond"');
  const pendingText = pending ? await pending.innerText() : '';
  ok(/Casey/.test(pendingText), `the pending chip is Casey (got ${JSON.stringify(pendingText)})`);
}

console.log('Oct 9 2026 feature: tapping a JOINED participant\'s chip opens their real profile');
{
  const chip = await page.$('.fav:not(.pending)');
  await chip.click();
  await page.waitForSelector('.profile-head', { timeout: 5000 });
  const bodyText = await page.evaluate(() => document.getElementById('app').innerText);
  ok(bodyText.includes('Brian'), `landed on Brian's own profile (got a snippet: ${JSON.stringify(bodyText.slice(0, 60))})`);
  ok(!bodyText.includes('Full Body'), 'this is genuinely a different screen -- the workout\'s own name is gone');
}

console.log('tapping Back returns to the EXACT workout screen (its name, its exercise), not Home or anywhere else');
{
  await page.goBack();
  await page.waitForSelector('.fav', { timeout: 5000 });
  const bodyText = await page.evaluate(() => document.getElementById('app').innerText);
  ok(bodyText.includes('Full Body'), 'back on the right workout by name');
  ok(bodyText.includes('Push Press'), 'the workout\'s own exercise is still there -- this is the real session screen, not a fresh/different render');
  // The h2 renders visually uppercase via CSS text-transform (innerText reflects that), same as
  // "NOTES"/"CHAT"/"WORKOUT" elsewhere on this exact screen -- match case-insensitively.
  ok(/who's in/i.test(bodyText), 'the "Who\'s in" section itself is back too');
}

console.log('tapping the still-PENDING (not-yet-accepted) chip also opens a profile -- viewing someone doesn\'t require them to have joined yet');
{
  const pendingChip = await page.$('.fav.pending');
  await pendingChip.click();
  await page.waitForSelector('.profile-head', { timeout: 5000 });
  const bodyText = await page.evaluate(() => document.getElementById('app').innerText);
  ok(bodyText.includes('Casey'), `landed on Casey's own profile (got a snippet: ${JSON.stringify(bodyText.slice(0, 60))})`);
  await page.goBack();
  await page.waitForSelector('.fav', { timeout: 5000 });
}

console.log('the creator-only remove (x) on a chip still works on its own, without also opening the profile out from under it (pre-existing stopPropagation)');
{
  const before = await page.evaluate(() => document.getElementById('app').innerText);
  ok(before.includes('Full Body'), 'sanity: back on the workout screen before this check');
  const removeBtn = await page.$('.fav button.linkbtn');
  ok(removeBtn !== null, 'the creator sees the remove (x) button on the joined chip');
  // A real click lands on the (x) button element itself -- Playwright targets the element handle
  // directly, the same way the earlier "stopPropagation on a nested control" fixes in this
  // codebase were verified (see test/ex-accordion-collapse.mjs's swap-link regression test).
  await removeBtn.click();
  await page.waitForTimeout(200);
  // confirmRemoveParticipant opens a confirm SHEET (an overlay on top of this same screen), never
  // a navigation -- the (x) tap must have reached that handler, not bubbled up into the chip's own
  // profileView onclick (which would have navigated away to a profile instead).
  const sheetTitle = await page.$eval('.sheet-head h2', el => el.textContent.trim()).catch(() => '');
  ok(/Remove Brian/.test(sheetTitle), `a real "Remove Brian?" confirm sheet opened, not a profile navigation (got ${JSON.stringify(sheetTitle)})`);
  await page.evaluate(() => { document.querySelectorAll('.sheet-back').forEach(sb => sb.remove()); });
  const stillOnWorkout = await page.$('.fav');
  ok(stillOnWorkout !== null, 'still on the workout screen underneath -- the (x) tap did not bubble into profileView');
}

ok(errors.length === 0, `no console pageerrors along the way (got ${JSON.stringify(errors)})`);

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
try { srv.kill(); } catch {}
rmSync(dir, { recursive: true, force: true });
await browser.close();
await testDb.drop();
process.exit(fails ? 1 : 0);
