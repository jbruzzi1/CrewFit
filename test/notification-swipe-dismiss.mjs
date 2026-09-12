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

// Sep 11 2026 (Jeff, real screenshot: "When I clear out notifications - it leaves the slim bar
// where the notifications used to sit. I don't want that to stay... I want it to show what it
// used to say 'all caught up'"). histDismiss above only ever removed the ONE row being dragged --
// nothing checked whether that left the "Today"/"Last 7 days" card (.card.feed-strip) completely
// empty, so an empty, still-padded, still-shadowed card sat there instead of the page falling back
// to the same "You're all caught up" empty state a normal load with nothing in it shows. A fresh
// user + a single history row (not reusing the ones above, which already share a page with other
// state) makes this reproducible end to end: one real row, dismissed for real, on a page with
// nothing else on it at all.
console.log('\ndismissing the LAST notification collapses the now-empty card and shows "You\'re all caught up", not a leftover empty bar');
{
  const page6 = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await page6.goto(BASE + '/');
  const dana = await registerAndLogin(page6, 'swd' + Math.random().toString(36).slice(2, 8));
  const page7 = await browser.newPage();
  await page7.goto(BASE + '/');
  const erin = await registerAndLogin(page7, 'swe' + Math.random().toString(36).slice(2, 8));
  await page7.evaluate(async ({ BASE, tok, id }) => {
    await fetch(BASE + `/api/follow/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: '{}' });
  }, { BASE, tok: erin.token, id: dana.user.id });
  await page7.close();

  await page6.evaluate(() => window.renderNotifications());
  await page6.waitForTimeout(200);
  const rows = await page6.$$('.hist-swipe');
  ok(rows.length === 1, `sanity: exactly one history row for this fresh user (got ${rows.length})`);
  ok(!!(await page6.$('.card.feed-strip')), 'sanity: the history card is present before dismissing');
  ok(!(await page6.$('.home-empty')), 'sanity: no empty state yet -- there is still a real row on the page');

  const row = rows[0];
  const box = await row.boundingBox();
  const startX = box.x + box.width - 10, y = box.y + box.height / 2;
  await page6.mouse.move(startX, y);
  await page6.mouse.down();
  await page6.mouse.move(startX - box.width * 0.6, y, { steps: 12 });
  await page6.mouse.up();
  await page6.waitForTimeout(500); // histDismiss's own animation + the DELETE request

  const remainingRows = await page6.$$eval('.hist-swipe', els => els.length);
  ok(remainingRows === 0, 'the row is genuinely gone');
  const leftoverCard = await page6.$('.card.feed-strip');
  ok(!leftoverCard, 'the now-empty history card itself is gone too -- no leftover slim bar');
  const leftoverHeader = await page6.$$eval('h2', els => els.map(e => e.textContent));
  ok(!leftoverHeader.includes('Today') && !leftoverHeader.includes('Last 7 days'), `the section header above the emptied card is gone too (got ${JSON.stringify(leftoverHeader)})`);
  const emptyState = await page6.$('.home-empty');
  ok(!!emptyState, 'the "You\'re all caught up" empty state now renders');
  const emptyTitle = emptyState ? await emptyState.$eval('.he-title', el => el.textContent) : '';
  ok(emptyTitle === "You're all caught up", `it's the real empty-state copy, not a blank box (got "${emptyTitle}")`);
  await page6.close();
}

// Sep 11 2026 (cold-review catch on the fix above, before it shipped): histDismiss awaits a real
// 280ms animation AND a network round-trip (the DELETE) before its trailing
// notifCollapseIfEmpty() call runs -- plenty of time for a normal-speed tab tap to land first.
// notifCollapseIfEmpty()'s "is this card empty" check only recognizes notification rows
// (.hist-swipe); .card.feed-strip is the SAME class friends()'s own "Activity" section and
// profileView()'s "Recent Activity" section render their real content into (see friends()'s
// activityHtml). Without a navigation guard, dismissing a notification and then immediately
// switching to the Activity tab would run notifCollapseIfEmpty() against THAT screen once the
// dismiss's delayed work finally resolves -- misreading a real, populated Activity card as
// "empty" (no .hist-swipe inside it) and stripping it out from under the user. Fixed by capturing
// UI_EPOCH at the top of histDismiss and gating the trailing call on nothingNavigatedSince(epoch),
// the same pattern already used throughout app.js for exactly this class of race
// (acceptInvite/declineInvite a few hundred lines up, among others). This proves the guard
// actually holds: a friend finishes a real workout (a real .feed-item lands in the Activity tab's
// .card.feed-strip), then dismissing a notification and switching to Activity mid-flight must
// leave that card and its content completely untouched.
console.log('\ndismissing a notification, then switching tabs before it finishes, must NOT strip real content on the new tab');
{
  // gia is the one performing the swipe-and-switch; she needs BOTH a real dismissible
  // notification of her own AND real friend activity waiting on the tab she switches to.
  const page8 = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await page8.goto(BASE + '/');
  const gia = await registerAndLogin(page8, 'swg' + Math.random().toString(36).slice(2, 8));

  const page9 = await browser.newPage();
  await page9.goto(BASE + '/');
  const finn = await registerAndLogin(page9, 'swf' + Math.random().toString(36).slice(2, 8));

  // gia follows finn -- makes finn a "connection" (connectionsOf), so finn's completed workout
  // below will show up in gia's OWN /api/feed, rendered by friends() as a real .feed-item inside
  // a real .card.feed-strip.
  await page8.evaluate(async ({ BASE, tok, id }) => {
    await fetch(BASE + `/api/follow/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: '{}' });
  }, { BASE, tok: gia.token, id: finn.user.id });
  // finn follows gia back -- a public-profile follow is a real, immediate "New follower" history
  // entry for the person followed (gia), same mechanism the earlier tests in this file use to get
  // a real dismissible row without inventing a fake one.
  await page9.evaluate(async ({ BASE, tok, id }) => {
    await fetch(BASE + `/api/follow/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: '{}' });
  }, { BASE, tok: finn.token, id: gia.user.id });
  // finn finishes a real workout -- this is the 'completed' row that should land in gia's feed.
  const sid = await page9.evaluate(async ({ BASE, tok }) => {
    const r = await fetch(BASE + '/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: JSON.stringify({ exercises: [{ name: 'Bench Press' }] }) });
    const s = await r.json();
    await fetch(BASE + `/api/sessions/${s.id}/lock`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: '{}' });
    return s.id;
  }, { BASE, tok: finn.token });
  ok(!!sid, "sanity: finn has a real finished session for gia's Activity feed to show");
  await page9.close();

  await page8.evaluate(() => window.renderNotifications());
  await page8.waitForTimeout(200);
  const rows2 = await page8.$$('.hist-swipe');
  ok(rows2.length >= 1, `sanity: gia has at least one real history row to dismiss (got ${rows2.length})`);

  const row2 = rows2[0];
  const box2 = await row2.boundingBox();
  const startX2 = box2.x + box2.width - 10, y2 = box2.y + box2.height / 2;
  await page8.mouse.move(startX2, y2);
  await page8.mouse.down();
  await page8.mouse.move(startX2 - box2.width * 0.6, y2, { steps: 12 });
  await page8.mouse.up(); // synchronously kicks off histDismiss -- it's already mid-flight (past its 280ms await) by the time this resolves
  await page8.evaluate(() => window.showTab('friends')); // the race window: switch tabs before histDismiss's delayed work resolves
  await page8.waitForTimeout(700); // well past the 280ms animation + DELETE round-trip

  // Sep 7 2026: the Friends tab's own h1 was relabeled "Activity" (see CLAUDE.md's design-constants
  // history) -- this assertion still checked the old literal "Friends" text and had been failing
  // ever since, undetected because it sits after vapid-persistence.mjs in npm test's `&&` chain: a
  // stray vapid.json left in the repo root from an earlier local `node server.js` run (no DATA_DIR
  // set) made THAT test fail first, which short-circuited the whole chain before this one ever ran.
  const onFriends = await page8.$eval('.h1-row h1', el => el.textContent).catch(() => null);
  ok(onFriends === 'Activity', `sanity: actually landed on the Friends/Activity tab (got ${JSON.stringify(onFriends)})`);
  const activityCard = await page8.$('.card.feed-strip');
  ok(!!activityCard, "the Activity tab's real feed-strip card was NOT stripped by the stale dismiss finishing after the tab switch");
  const feedItems = await page8.$$eval('.feed-item', els => els.length);
  ok(feedItems >= 1, `the real activity item (finn's finished workout) is still there (got ${feedItems} .feed-item rows)`);
  // NOT a bare ".home-empty" check -- friends() legitimately renders its OWN "No crews yet"
  // homeEmpty for a user with no crews (gia has none here), so at least one .home-empty on this
  // page is expected and correct. What must NOT appear is notifCollapseIfEmpty's specific
  // notifications-page empty state (bell icon, "You're all caught up") bleeding onto this screen.
  const emptyTitles = await page8.$$eval('.home-empty .he-title', els => els.map(e => e.textContent));
  ok(!emptyTitles.includes("You're all caught up"), `no incorrect "all caught up" empty state was injected onto the Activity tab (got empty-state titles: ${JSON.stringify(emptyTitles)})`);
  await page8.close();
}

await browser.close();
try { srv && srv.kill(); } catch {}
rmSync(dir, { recursive: true, force: true });
await testDb.drop();

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
