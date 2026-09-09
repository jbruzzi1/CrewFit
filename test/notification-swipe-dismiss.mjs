// Sep 9 2026 (Jeff: "I would like to be able to slide notifications away (slide them to the
// left) to remove them from the list if I don't want to wait the full 7 days for them to be
// removed" -- "no need for the confirmation liek you said - lets build this.").
//
// First built as an iOS-Mail-style reveal-a-red-Delete-button-behind-the-row interaction. Jeff's
// reaction: "That looks terrible... I ultimately think we simply just be able to slide the pill
// box to the left and it removes the notification... its almost instinctive to do so." Rebuilt
// as a direct swipe-to-dismiss: drag the row itself far enough left (past HIST_DISMISS_RATIO of
// its own width, in app.js) and IT slides away and is deleted -- no button to land on separately.
//
// This is a genuinely new gesture for this app -- there was no swipe pattern anywhere in it
// before (the closest analogue, dragReorder() in app.js, is a vertical drag). A node:vm DOM mock
// (the harness the OTHER notifications test, notification-history-grouping.mjs, uses) has no
// real classList/getBoundingClientRect/CSS-transform behavior to check against -- exercising it
// meaningfully needs a real browser, same reasoning as test/create-flow-draft-persist.mjs, which
// this is modeled on: register real users through the real API, boot the real server against a
// throwaway Postgres db, and drive the actual rendered page.
//
// Drag mechanics: histSwipeAttach() in app.js supports mouse OR touch through the same
// onHistDown/onHistMove/onHistUp handlers (e.touches ? ... : e.clientX), the same dual-support
// dragReorder() already uses. This test drives it with page.mouse -- exercising the identical JS
// path a touch drag would, just not Chromium's own touch-event plumbing. Per CLAUDE.md's
// sandbox-rendering rule: this sandbox has no WebKit and no San Francisco font, and touch
// gesture "feel" (exact drag distance, momentum, whether it reads as natural under a real
// finger) is something only Jeff's own iPhone can actually confirm -- this proves the mechanism
// (drag/snap-back/slide-away-and-delete) works, not that it feels right on his device.
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
const testDb = await freshTestDb('notifswipe');

function boot(port, dir) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; srv.stdout.on('data', d => { out += d; if (String(d).includes('CrewFit on')) res({ srv, out }); });
    srv.on('exit', () => res({ srv: null, out }));
    setTimeout(() => res({ srv, out }), 15000);
  });
}

const PORT = 4713;
const dir = mkdtempSync(join(tmpdir(), 'crewfit-swipe-'));
const { srv } = await boot(PORT, dir);
if (!srv) { console.log('  FAIL server did not boot'); process.exit(1); }
const BASE = `http://localhost:${PORT}`;

const browser = await chromium.launch(LAUNCH_OPTS);

async function registerAndLogin(page, uname) {
  const reg = await page.evaluate(async ({ BASE, uname }) => {
    const r = await fetch(BASE + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: uname, pin: '123456', displayName: uname }) });
    return r.json();
  }, { BASE, uname });
  await page.evaluate((tok) => localStorage.setItem('crewfit_token', tok), reg.token);
  await page.reload();
  await page.waitForTimeout(300);
  return reg;
}

// Two rows -- both real history rows, made the same way test/notifications.mjs's own
// actual-bug case does (a public follow completes instantly and logs a real history entry for
// the person followed) -- so one row can be dragged away while the other proves the rest of the
// list is untouched.
console.log('setup: two real notification history rows for one user');
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
await page.goto(BASE + '/');
const me = await registerAndLogin(page, 'swp' + Math.random().toString(36).slice(2, 8));

const page2 = await browser.newPage();
await page2.goto(BASE + '/');
const alice = await registerAndLogin(page2, 'swa' + Math.random().toString(36).slice(2, 8));
const page3 = await browser.newPage();
await page3.goto(BASE + '/');
const bob = await registerAndLogin(page3, 'swb' + Math.random().toString(36).slice(2, 8));
await page2.evaluate(async ({ BASE, tok, id }) => {
  await fetch(BASE + `/api/follow/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: '{}' });
}, { BASE, tok: alice.token, id: me.user.id });
await page3.evaluate(async ({ BASE, tok, id }) => {
  await fetch(BASE + `/api/follow/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: '{}' });
}, { BASE, tok: bob.token, id: me.user.id });
await page2.close(); await page3.close();

await page.evaluate(() => window.renderNotifications());
await page.waitForTimeout(200);
const rowCount = await page.$$eval('.hist-swipe', els => els.length);
ok(rowCount === 2, `both history rows rendered as swipeable (.hist-swipe) rows (got ${rowCount})`);

async function dragRow(row, deltaX, steps = 10) {
  const box = await row.boundingBox();
  const startX = box.x + box.width - 10, y = box.y + box.height / 2;
  await page.mouse.move(startX, y);
  await page.mouse.down();
  await page.mouse.move(startX + deltaX, y, { steps });
  await page.mouse.up();
}

console.log('\na plain tap on a closed row (no drag at all) still fires its deep-link, same as before this feature');
{
  // The swipe wrapper must not get in the way of the ordinary case, which is still the vast
  // majority of taps on this page -- a closed row with no drag involved at all.
  const row = (await page.$$('.hist-swipe'))[0];
  const box = await row.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2); // dead center, no movement
  await page.waitForTimeout(200);
  const stillOnNotifications = await page.$('.pp-head h1');
  ok(!stillOnNotifications, 'a plain tap navigated away from the Notifications page (the deep-link fired)');
  // Back to the Notifications page, freshly rendered, for the rest of this file's drag tests.
  await page.evaluate(() => window.renderNotifications());
  await page.waitForTimeout(200);
  const backCount = await page.$$eval('.hist-swipe', els => els.length);
  ok(backCount === 2, `back on Notifications with both rows again (got ${backCount})`);
}

console.log('\na short drag (under the dismiss threshold) snaps the row back, does not delete it, and does not navigate either');
{
  const row = (await page.$$('.hist-swipe'))[1];
  const box = await row.boundingBox();
  await dragRow(row, -20, 5); // well under HIST_DISMISS_RATIO (32%) of a ~330px-wide row
  await page.waitForTimeout(400); // the snap-back transition (180ms) plus a margin
  const transform = await row.$eval('.hist-swipe-row', el => getComputedStyle(el).transform);
  ok(transform === 'none' || transform === 'matrix(1, 0, 0, 1, 0, 0)', `the row snapped back to its resting position (got transform: ${transform})`);
  const stillThere = await page.$$eval('.hist-swipe', els => els.length);
  ok(stillThere === 2, 'the row was not deleted by a short drag');
  const stillOnNotifications = await page.$('.pp-head h1');
  ok(!!stillOnNotifications, 'and the aborted drag did not also navigate away (the trailing click was swallowed)');
}

console.log('\ndragging a row past the threshold sends it away, deletes it for real, and leaves the other row untouched');
{
  const rowsBefore = await page.$$eval('.hist-swipe', els => els.map(el => el.getAttribute('data-nid')));
  ok(rowsBefore.length === 2, `sanity: two rows present before dragging (got ${rowsBefore.length})`);
  const row = (await page.$$('.hist-swipe'))[0];
  const targetId = await row.getAttribute('data-nid');
  const box = await row.boundingBox();
  await dragRow(row, -(box.width * 0.6), 12); // well past the 32% threshold
  // The row's own content should already be sliding/faded mid-gesture, before the collapse settles.
  await page.waitForTimeout(80);
  const midDragOpacity = await row.$eval('.hist-swipe-row', el => Number(getComputedStyle(el).opacity));
  ok(midDragOpacity < 1, `the row visibly fades as it's dragged away (mid-drag opacity ${midDragOpacity})`);

  await page.waitForTimeout(500); // histDismiss's own animation + the DELETE request
  const rowsAfter = await page.$$eval('.hist-swipe', els => els.map(el => el.getAttribute('data-nid')));
  ok(!rowsAfter.includes(targetId), `the dragged-away row is gone from the DOM entirely (had ${JSON.stringify(rowsBefore)}, now ${JSON.stringify(rowsAfter)})`);
  ok(rowsAfter.length === 1 && rowsAfter.includes(rowsBefore.find(id => id !== targetId)), 'the OTHER row is still there, untouched');

  // Confirm it is really gone server-side too, not just removed from the DOM client-side.
  const data = await page.evaluate(async (BASE) => (await fetch(BASE + '/api/notifications', { headers: { Authorization: 'Bearer ' + localStorage.getItem('crewfit_token') } })).json(), BASE);
  ok(!data.history.some(h => h.id === targetId), 'the server no longer has this notification either -- this was a real DELETE, not just a DOM removal');
  ok(data.history.some(h => rowsAfter.includes(h.id)), 'and the other notification is still there server-side too');
}

console.log('\na second drag started on a row that is already mid-dismiss is ignored (no double-delete, no crash)');
{
  // A fresh third row for this one, made the same way as setup.
  const page5 = await browser.newPage();
  await page5.goto(BASE + '/');
  const carol = await registerAndLogin(page5, 'swc' + Math.random().toString(36).slice(2, 8));
  await page5.evaluate(async ({ BASE, tok, id }) => {
    await fetch(BASE + `/api/follow/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: '{}' });
  }, { BASE, tok: carol.token, id: me.user.id });
  await page5.close();

  await page.evaluate(() => window.renderNotifications());
  await page.waitForTimeout(200);
  const rows = await page.$$('.hist-swipe');
  const target = rows[rows.length - 1]; // the just-added one
  const targetId = await target.getAttribute('data-nid');
  const box = await target.boundingBox();

  await dragRow(target, -(box.width * 0.6), 12); // crosses the threshold -- histDismiss starts (280ms animation)
  await page.waitForTimeout(30); // still mid-animation, row not yet removed
  let threw = false;
  try {
    await dragRow(target, -(box.width * 0.6), 6); // a second drag attempt on the SAME row while it's dismissing
  } catch (e) { threw = true; }
  ok(!threw, 'a second drag on an already-dismissing row does not throw');
  await page.waitForTimeout(500);

  const rowsAfter = await page.$$eval('.hist-swipe', els => els.map(el => el.getAttribute('data-nid')));
  ok(!rowsAfter.includes(targetId), 'the row is still gone (the re-entrant drag did not leave it stuck half-animated)');
  const data = await page.evaluate(async (BASE) => (await fetch(BASE + '/api/notifications', { headers: { Authorization: 'Bearer ' + localStorage.getItem('crewfit_token') } })).json(), BASE);
  ok(!data.history.some(h => h.id === targetId), 'and it is really gone server-side -- one DELETE landed cleanly, not a broken double-fire');
}

console.log('\nthe remaining row is still perfectly normal afterward -- a plain tap on it still navigates');
{
  const row = await page.$('.hist-swipe');
  const box = await row.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(200);
  const stillOnNotifications = await page.$('.pp-head h1');
  ok(!stillOnNotifications, "the surviving row's deep-link still works after a sibling row was dismissed");
}

await browser.close();
try { srv && srv.kill(); } catch {}
rmSync(dir, { recursive: true, force: true });
await testDb.drop();

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
