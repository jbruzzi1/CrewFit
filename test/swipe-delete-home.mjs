// Sep 18 2026 (Jeff): "I think we should add the slide delete ability (like we have for
// notifications) to workouts on this page - for both my sessions and friends workouts." First built
// as a reveal-a-trash-button design; Jeff saw it rendered and corrected course twice (see
// swipeRowConfirm's own long comment in app.js for the full history) before landing on reusing the
// SAME drag-it-away mechanic the notification list already has (histSwipeAttach/HIST_DISMISS_RATIO)
// rather than a revealed button. The one real difference from notifications: deleting or leaving a
// shared workout is a bigger deal than dismissing a notification, so dragging a row past the
// threshold does NOT commit the way histDismiss does -- it opens the exact same confirm sheet the
// in-workout "..." menu already uses (deleteSession/leaveWorkout/hideJoinable, reused verbatim), and
// canceling that sheet slides the row back into place.
//
// Confirmed with Jeff before building (three real ambiguities, not guessed at): a non-creator row
// in "Your sessions" falls back to the exact same Leave Workout flow a creator row's Delete does; a
// friend's joinable workout can't actually be deleted (you don't own it) so it's a personal
// remove-from-my-list only (POST /api/sessions/:id/hide-joinable); and there's a real confirm sheet
// before anything happens, not a direct removal.
//
// Same reasoning as test/notification-swipe-dismiss.mjs for why this needs a real browser rather
// than the node:vm harness other tests use: a real drag, real CSS transform, real confirm-sheet DOM.
// Drives the actual rendered page against a real server + throwaway Postgres db. Per CLAUDE.md's
// sandbox-rendering caveat: this proves the mechanism (drag/snap-back/drag-then-confirm/cancel-
// resets/real server action) works, not that the gesture "feels" right on Jeff's own iPhone -- only
// his device confirms that.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { freshTestDb } from './_pgtestdb.mjs';

const SANDBOX_CHROMIUM = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const LAUNCH_OPTS = existsSync(SANDBOX_CHROMIUM) ? { executablePath: SANDBOX_CHROMIUM } : {};

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('swipehome');

function boot(port, dir) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; srv.stdout.on('data', d => { out += d; if (String(d).includes('CrewFit on')) res({ srv, out }); });
    srv.on('exit', () => res({ srv: null, out }));
    setTimeout(() => res({ srv, out }), 15000);
  });
}

const PORT = 4907;
const dir = mkdtempSync(join(tmpdir(), 'crewfit-swipehome-'));
const { srv } = await boot(PORT, dir);
if (!srv) { console.log('  FAIL server did not boot'); process.exit(1); }
ok(true, 'server boots');
const BASE = `http://localhost:${PORT}`;
const api = async (path, body, tok) => (await fetch(BASE + path, { method: 'POST', headers: tok ? { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok } : { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })).json();
const apiGet = async (path, tok) => (await fetch(BASE + path, { headers: tok ? { Authorization: 'Bearer ' + tok } : {} })).json();

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

console.log('setup: three rows for one user -- a session they created, one they joined, and a friend\'s joinable one');
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
await page.goto(BASE + '/');
const rand = () => Math.random().toString(36).slice(2, 8);
const uMe = 'swm' + rand();
const me = await registerAndLogin(page, uMe);

const page2 = await browser.newPage();
await page2.goto(BASE + '/');
const uFriend = 'swf' + rand();
const friend = await registerAndLogin(page2, uFriend);
await page2.close();

// home1 follows friend so friend can invite them (invite eligibility = connected, either
// direction -- see connectionsOf()'s own comment in server.js).
await api(`/api/follow/${friend.user.id}`, {}, me.token);

// All three past-dated -- see home()'s nextUp logic in app.js: a "now"-scheduled, not-yet-started
// session competes for the single Next Up card slot, which is NOT wrapped in .swipe-row. Past-dating
// keeps all three reliably landing as plain "Your sessions"/"Friends' workouts" swipe-rows.
const joinableS = await api('/api/sessions', { name: 'Friend Joinable', scheduledAt: new Date(Date.now() - 86400000).toISOString(), exercises: [{ name: 'Bench Press' }], visibility: 'public' }, friend.token);
const invitedS = await api('/api/sessions', { name: 'Friend Invited Me', scheduledAt: new Date(Date.now() - 172800000).toISOString(), exercises: [{ name: 'Deadlift' }], visibility: 'private', inviteUsernames: [uMe] }, friend.token);
await api(`/api/sessions/${invitedS.id}/accept`, {}, me.token);
const ownS = await api('/api/sessions', { name: 'My Own Session', scheduledAt: new Date(Date.now() - 259200000).toISOString(), exercises: [{ name: 'Squat' }], visibility: 'private' }, me.token);

await page.evaluate(() => window.home());
await page.waitForTimeout(300);

const rowInfo = await page.$$eval('.swipe-row', els => els.map(el => ({ sid: el.dataset.sid, action: el.dataset.action })));
ok(rowInfo.length === 3, `all three rows render as swipeable (got ${rowInfo.length})`);
ok(rowInfo.find(r => r.sid === ownS.id && r.action === 'delete') !== undefined, `own-created session carries data-action="delete" (got ${JSON.stringify(rowInfo.find(r=>r.sid===ownS.id))})`);
ok(rowInfo.find(r => r.sid === invitedS.id && r.action === 'leave') !== undefined, `joined-but-not-created session carries data-action="leave" (got ${JSON.stringify(rowInfo.find(r=>r.sid===invitedS.id))})`);
ok(rowInfo.find(r => r.sid === joinableS.id && r.action === 'hide-joinable') !== undefined, `friend's joinable session carries data-action="hide-joinable" (got ${JSON.stringify(rowInfo.find(r=>r.sid===joinableS.id))})`);

function rowFg(sid) { return page.$(`.swipe-row[data-sid="${sid}"] .swipe-row-fg`); }
async function dragFg(fg, deltaX, steps = 10) {
  const box = await fg.boundingBox();
  const startX = box.x + box.width - 10, y = box.y + box.height / 2;
  await page.mouse.move(startX, y);
  await page.mouse.down();
  await page.mouse.move(startX + deltaX, y, { steps });
  await page.mouse.up();
}

console.log('\na plain tap on a closed row (no drag) still navigates, same as before this feature');
{
  const fg = await rowFg(joinableS.id);
  const box = await fg.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(200);
  const onHome = await page.$('h2:has-text("Your sessions")');
  ok(!onHome, 'a plain tap navigated away from Home (openSession fired)');
  await page.evaluate(() => window.home());
  await page.waitForTimeout(300);
}

console.log('\na short drag (under the dismiss threshold) snaps back, and does not navigate or open anything');
{
  const fg = await rowFg(joinableS.id);
  await dragFg(fg, -15, 5); // well under 32% of the row's ~334px width
  await page.waitForTimeout(300);
  const transform = await fg.evaluate(el => getComputedStyle(el).transform);
  ok(transform === 'none' || transform === 'matrix(1, 0, 0, 1, 0, 0)', `row snapped back closed (got transform: ${transform})`);
  const onHome = await page.$('h2:has-text("Your sessions")');
  ok(!!onHome, 'still on Home -- the aborted drag did not also navigate (trailing click swallowed)');
  const noSheet = await page.$('.sheet-back');
  ok(!noSheet, 'no confirm sheet opened for an aborted drag');
}

console.log('\ndragging a friend\'s joinable workout past the threshold slides it away and opens the real confirm sheet');
{
  const fg = await rowFg(joinableS.id);
  await dragFg(fg, -160, 12); // past 32% of ~334px (~107px)
  await page.waitForTimeout(500); // the slide-away transition (.2s) + swipeRowConfirm's own 220ms delay before opening the sheet
  const heading = await page.$eval('.sheet-head h2', el => el.textContent);
  ok(/remove this workout/i.test(heading), `confirm sheet shown, titled appropriately (got "${heading}")`);
}

console.log('\ncanceling that confirm sheet slides the row back into place -- nothing happened server-side');
{
  const cancelBtn = await page.$('.sheet-row:not(.red)');
  await cancelBtn.click();
  await page.waitForTimeout(400); // dismissConfirm's fade + SHEET_CANCEL_CB's resetRow transition
  const noSheet = await page.$('.sheet-back');
  ok(!noSheet, 'the confirm sheet is gone');
  const fg = await rowFg(joinableS.id);
  const transform = await fg.evaluate(el => getComputedStyle(el).transform);
  ok(transform === 'none' || transform === 'matrix(1, 0, 0, 1, 0, 0)', `the row slid back to its normal place, not left half-gone (got transform: ${transform})`);
  const opacity = await fg.evaluate(el => getComputedStyle(el).opacity);
  ok(opacity === '1', `the row's opacity reset too, not left faded (got ${opacity})`);
  const meAfter = await apiGet('/api/sessions', me.token);
  const rowAfter = meAfter.find(s => s.id === joinableS.id);
  ok(rowAfter && rowAfter.hiddenForMe === false, `canceling did not actually hide it server-side (got ${JSON.stringify(rowAfter && rowAfter.hiddenForMe)})`);
  const stillOnHome = await page.$('h2:has-text("Your sessions")');
  ok(!!stillOnHome, 'still on Home, nothing navigated');
}

console.log('\nfriend\'s joinable workout: dragging past the threshold and confirming for real removes it from just my list -- real server round trip');
{
  const fg = await rowFg(joinableS.id);
  await dragFg(fg, -160, 12);
  await page.waitForTimeout(500);
  const confirmBtn = await page.$('.sheet-row.red');
  await confirmBtn.click();
  await page.waitForTimeout(400);
  const onHome = await page.$('h2:has-text("Your sessions")');
  ok(!!onHome, 'landed back on Home after confirming');
  const stillThere = await page.$(`.swipe-row[data-sid="${joinableS.id}"]`);
  ok(!stillThere, 'the row is gone from the page');
  const meAfter = await apiGet('/api/sessions', me.token);
  const rowAfter = meAfter.find(s => s.id === joinableS.id);
  ok(rowAfter && rowAfter.hiddenForMe === true, `server confirms hiddenForMe:true for me now (got ${JSON.stringify(rowAfter && rowAfter.hiddenForMe)})`);
  const friendAfter = await apiGet('/api/sessions', friend.token);
  const friendRow = friendAfter.find(s => s.id === joinableS.id);
  ok(friendRow && friendRow.name === 'Friend Joinable' && (friendRow.participants||[]).includes(friend.user.id), 'the workout itself is completely untouched for the friend who created it');
}

console.log('\nmy own session: dragging past the threshold reuses the real Delete-workout confirm sheet, confirming actually deletes it server-side');
{
  const fg = await rowFg(ownS.id);
  await dragFg(fg, -160, 12);
  await page.waitForTimeout(500);
  const heading = await page.$eval('.sheet-head h2', el => el.textContent);
  ok(/delete workout/i.test(heading), `the exact same Delete-workout confirm sheet the in-workout "..." menu uses (got "${heading}")`);
  const confirmBtn = await page.$('.sheet-row.red');
  await confirmBtn.click();
  await page.waitForTimeout(400);
  const meAfter = await apiGet('/api/sessions', me.token);
  ok(!meAfter.some(s => s.id === ownS.id), 'the session no longer exists in my sessions list at all -- a real delete, not a dismiss');
  const direct = await fetch(BASE + `/api/sessions/${ownS.id}`, { headers: { Authorization: 'Bearer ' + me.token } });
  ok(direct.status === 404, `fetching it directly now 404s -- genuinely deleted server-side (got ${direct.status})`);
}

console.log('\na workout I joined but did not create: dragging past the threshold opens the real Leave Workout sheet; canceling (X) slides it back');
{
  await page.evaluate(() => window.home());
  await page.waitForTimeout(300);
  const fg = await rowFg(invitedS.id);
  await dragFg(fg, -160, 12);
  await page.waitForTimeout(500);
  const heading = await page.$eval('.sheet-head h2', el => el.textContent);
  ok(/leave workout/i.test(heading), `the exact same Leave Workout sheet the in-workout Leave button uses (got "${heading}")`);
  const discardBtn = await page.$('button:has-text("Discard today\'s sets")');
  ok(!!discardBtn, 'the Save/Discard choice sheet rendered (I have no logged sets yet, but the choice is still offered)');
  // Leave Workout's sheet is a raw openSheetHtml, not confirmSheet -- its ✕ is a genuinely different
  // codepath from the confirmSheet-based Cancel tested above (SHEET_CANCEL_CB armed directly by
  // leaveWorkout(), read by closeSheet() rather than dismissConfirm()) and worth covering on its own.
  const closeX = await page.$('.sheet-head button.sec.sm');
  await closeX.click();
  await page.waitForTimeout(400);
  const noSheet = await page.$('.sheet-back');
  ok(!noSheet, 'the Leave Workout sheet is gone after tapping X');
  const fgAfterCancel = await rowFg(invitedS.id);
  const transform = await fgAfterCancel.evaluate(el => getComputedStyle(el).transform);
  ok(transform === 'none' || transform === 'matrix(1, 0, 0, 1, 0, 0)', `canceling via X also slid the row back (got transform: ${transform})`);
  const meStillIn = await apiGet('/api/sessions', me.token);
  ok(meStillIn.some(s => s.id === invitedS.id), 'canceling did not actually remove me from the workout');
}

console.log('\nthe same workout, for real this time: dragging past the threshold and choosing Discard actually removes me as a participant');
{
  const fg = await rowFg(invitedS.id);
  await dragFg(fg, -160, 12);
  await page.waitForTimeout(500);
  const discardBtn = await page.$('button:has-text("Discard today\'s sets")');
  await discardBtn.click();
  await page.waitForTimeout(400);
  const meAfter = await apiGet('/api/sessions', me.token);
  ok(!meAfter.some(s => s.id === invitedS.id), 'the workout no longer shows up for me at all');
  const friendAfter = await apiGet('/api/sessions', friend.token);
  const friendRow = friendAfter.find(s => s.id === invitedS.id);
  ok(friendRow && !friendRow.participants.includes(me.user.id) && friendRow.creatorId === friend.user.id, 'the workout still exists for the friend who created it, just without me in it -- a real Leave, not a delete');
}

console.log('\ncold-review catch (Sep 18): a non-creator row whose viewer already finished it (real history credit) must NOT silently leave with zero confirmation when dragged past the threshold');
{
  // swipeRowConfirm's dispatch used to call leaveWorkout() unconditionally for every 'leave' row,
  // and leaveWorkout(id, alreadyFinished=true) has always had an early-return straight to
  // leaveWorkoutConfirmed with NO sheet at all (fine for the in-workout Leave button, a deliberate
  // tap -- not fine for a drag gesture that's supposed to always pause on a real confirm sheet
  // first). Fixed by special-casing hasFinished inside swipeRowConfirm's dispatch to show its own
  // lightweight single-button confirmSheet instead of calling leaveWorkout() directly.
  //
  // IMPORTANT caveat discovered while writing this test (verified against the real server, not
  // assumed): a finished session can never actually render as a swipe-row on Home in the first
  // place. home()'s own "Your sessions" list (`yours`, app.js ~line 711) filters OUT anything
  // hasFinishedSession() is true for BEFORE swipeRowWrap ever runs, and hasFinishedSession is a
  // strict superset of the history-only check swipeRowWrap's own `hasFinished` flag uses -- so
  // any row that reaches swipeRowWrap is guaranteed hasFinished=false. Confirmed empirically: a
  // real invited+accepted+logged+finished session (real history credit via /lock) does not appear
  // in .swipe-row at all after a real home() render. So this exact scenario cannot currently be
  // triggered by a real drag on Home -- the fix is still correct and worth keeping (defense in
  // depth in case that filter is ever relaxed and finished sessions start showing here), but it is
  // not closing a reachable live bug today. Exercised directly below (bypassing the unreachable
  // natural render) against a REAL server session with a real history credit, so the dispatch
  // logic itself -- not just the filter that currently hides it -- is what's actually verified.
  const invitedFinishedS = await api('/api/sessions', { name: 'Friend Invited Me, Finished', scheduledAt: new Date(Date.now() - 345600000).toISOString(), exercises: [{ name: 'Overhead Press' }], visibility: 'private', inviteUsernames: [uMe] }, friend.token);
  await api(`/api/sessions/${invitedFinishedS.id}/accept`, {}, me.token);
  const exId = invitedFinishedS.exercises[0].id;
  await api(`/api/sessions/${invitedFinishedS.id}/log`, { exerciseId: exId, weight: 95, reps: 8, set: 1 }, me.token);
  await api(`/api/sessions/${invitedFinishedS.id}/lock`, { localDate: new Date().toISOString().slice(0, 10) }, me.token);
  const directCheck = await (await fetch(BASE + `/api/sessions/${invitedFinishedS.id}`, { headers: { Authorization: 'Bearer ' + me.token } })).json();
  ok((directCheck.history || []).some(h => h.userId === me.user.id), 'setup: the session really carries a real history credit for me now, not just a client-side assumption');

  await page.evaluate(() => window.home());
  await page.waitForTimeout(300);
  const notOnHome = await page.$(`.swipe-row[data-sid="${invitedFinishedS.id}"]`);
  ok(!notOnHome, 'confirms the caveat above: a finished session really does not render as a swipe-row on Home');

  // Inject a synthetic row matching swipeRowWrap's exact markup (data-finished="1") and invoke the
  // real dispatch function directly -- same function, same real server session/token, just skipping
  // the drag gesture and the now-confirmed-unreachable natural render.
  await page.evaluate((sid) => {
    document.getElementById('app').insertAdjacentHTML('beforeend', `<div class="swipe-row" data-sid="${sid}" data-action="leave" data-finished="1"><div class="lib-item swipe-row-fg">Synthetic test row</div></div>`);
  }, invitedFinishedS.id);
  const synthRow = await page.$(`.swipe-row[data-sid="${invitedFinishedS.id}"]`);
  const synthFg = await synthRow.$('.swipe-row-fg');
  await page.evaluate(([row, fg]) => window.swipeRowConfirm(row, fg), [synthRow, synthFg]);
  await page.waitForTimeout(500); // swipeRowConfirm's own 220ms dispatch delay + sheet-open

  const heading = await page.$eval('.sheet-head h2', el => el.textContent);
  ok(/leave workout/i.test(heading), `a real confirm sheet opened, not a silent leave (got "${heading}")`);
  const discardBtn2 = await page.$('button:has-text("Discard today\'s sets")');
  ok(!discardBtn2, 'this is the lightweight single-button sheet, not the Save/Discard two-choice one -- already finished, nothing left to choose between');
  const cancelBtn2 = await page.$('.sheet-row:not(.red)');
  ok(!!cancelBtn2, 'a real Cancel control exists on this sheet');
  const confirmBtn2 = await page.$('.sheet-row.red');
  ok(!!confirmBtn2, 'a real confirm control exists on this sheet');

  await cancelBtn2.click();
  await page.waitForTimeout(400);
  const noSheet2 = await page.$('.sheet-back');
  ok(!noSheet2, 'canceling closed the sheet');
  const meStillIn2 = await apiGet('/api/sessions', me.token);
  ok(meStillIn2.some(s => s.id === invitedFinishedS.id), 'canceling did not actually remove me from the workout');

  // Re-fire the same dispatch (fresh synthetic row -- the first was left mid-slide by resetRow's
  // own transition, easiest to just re-inject) and confirm for real this time.
  await page.evaluate((sid) => {
    const old = document.querySelector(`.swipe-row[data-sid="${sid}"]`); if (old) old.remove();
    document.getElementById('app').insertAdjacentHTML('beforeend', `<div class="swipe-row" data-sid="${sid}" data-action="leave" data-finished="1"><div class="lib-item swipe-row-fg">Synthetic test row</div></div>`);
  }, invitedFinishedS.id);
  const synthRow2 = await page.$(`.swipe-row[data-sid="${invitedFinishedS.id}"]`);
  const synthFg2 = await synthRow2.$('.swipe-row-fg');
  await page.evaluate(([row, fg]) => window.swipeRowConfirm(row, fg), [synthRow2, synthFg2]);
  await page.waitForTimeout(500);
  const confirmBtn3 = await page.$('.sheet-row.red');
  await confirmBtn3.click();
  await page.waitForTimeout(400);
  // This branch calls leaveWorkoutConfirmed(sid, true) -- a KEEP-leave, deliberately, the same
  // "you'll keep credit for today's sets" the sheet's own body text promises. That's a real
  // difference from the not-yet-finished Discard test just above: a keep-leave's history row
  // survives (see sessionTier's 'alumni' branch and its long comment in server.js), so the
  // workout is SUPPOSED to keep showing up in my own /api/sessions -- that's the credit being
  // kept, not a bug -- just no longer as a participant. Confirmed directly against my own view,
  // not inferred from absence.
  const mineDirect = await (await fetch(BASE + `/api/sessions/${invitedFinishedS.id}`, { headers: { Authorization: 'Bearer ' + me.token } })).json();
  ok(!(mineDirect.participants || []).includes(me.user.id), 'a real Leave happened server-side -- I am no longer a participant');
  ok((mineDirect.history || []).some(h => h.userId === me.user.id), "my history credit survived the leave -- it's a real keep-leave, matching the sheet's own promise");
  const friendAfter2 = await apiGet('/api/sessions', friend.token);
  const friendRow2 = friendAfter2.find(s => s.id === invitedFinishedS.id);
  ok(friendRow2 && !friendRow2.participants.includes(me.user.id), 'the same is true from the creator\'s side -- I am no longer a participant there either');
}

console.log('\ncold-review catch, round 3: dragging TWO different rows within the same dispatch window must not strand the first row -- confirmSheet-vs-leaveWorkout collision, not just confirmSheet-vs-confirmSheet');
{
  // The round-2 fix (confirmSheet's own stomp guard) only ever fired a stale SHEET_CANCEL_CB when
  // the sheet already showing had been opened BY confirmSheet (tracked via CONFIRM_EL). leaveWorkout
  // opens its Save/Discard sheet through raw openSheetHtml and never registered CONFIRM_EL, so a
  // hide-joinable/delete row (confirmSheet) racing against a not-yet-finished leave row
  // (leaveWorkout's raw sheet) -- in either order -- fell straight through that check: the loser's
  // SHEET_CANCEL_CB got silently overwritten with no reset, AND its sheet's DOM node was never
  // removed, just covered up. Fixed by having leaveWorkout register CONFIRM_EL too and both
  // functions share one stomp-guard (stompPendingSwipeSheet). Driven here via direct calls to the
  // real swipeRowConfirm dispatch (not two literal drags racing in real time, which real-drag timing
  // in a sandboxed browser can't guarantee lands inside the same ~220ms window reliably) -- same
  // technique the hasFinished test above uses, same real function, same real server session.
  const raceHideS = await api('/api/sessions', { name: 'Race Hide Candidate', scheduledAt: new Date(Date.now() - 432000000).toISOString(), exercises: [{ name: 'Lat Pulldown' }], visibility: 'public' }, friend.token);
  const raceLeaveS = await api('/api/sessions', { name: 'Race Leave Candidate', scheduledAt: new Date(Date.now() - 518400000).toISOString(), exercises: [{ name: 'Leg Press' }], visibility: 'private', inviteUsernames: [uMe] }, friend.token);
  await api(`/api/sessions/${raceLeaveS.id}/accept`, {}, me.token);

  await page.evaluate(() => window.home());
  await page.waitForTimeout(300);
  const rowHide = await page.$(`.swipe-row[data-sid="${raceHideS.id}"]`);
  const fgHide = await rowHide.$('.swipe-row-fg');
  const rowLeave = await page.$(`.swipe-row[data-sid="${raceLeaveS.id}"]`);
  const fgLeave = await rowLeave.$('.swipe-row-fg');
  ok(!!rowHide && !!rowLeave, 'both race fixtures rendered as real swipe-rows to start from');

  // Fire both dispatches back to back in one synchronous browser call -- both land inside the same
  // ~220ms window this way, deterministically, rather than hoping two real drags race in time.
  await page.evaluate(([rh, fh, rl, fl]) => { window.swipeRowConfirm(rh, fh); window.swipeRowConfirm(rl, fl); }, [rowHide, fgHide, rowLeave, fgLeave]);
  await page.waitForTimeout(600);

  const sheets = await page.$$('.sheet-back');
  ok(sheets.length === 1, `only one sheet is showing, not two stacked -- the loser's DOM node was actually removed (got ${sheets.length})`);
  const heading = await page.$eval('.sheet-head h2', el => el.textContent);
  ok(/leave workout/i.test(heading), `the SECOND dispatch (leave) is the one left showing (got "${heading}")`);

  const fgHideAfter = await rowFg(raceHideS.id);
  const transform = await fgHideAfter.evaluate(el => getComputedStyle(el).transform);
  ok(transform === 'none' || transform === 'matrix(1, 0, 0, 1, 0, 0)', `the FIRST row (hide-joinable, bumped by the race) was actually reset, not stranded mid-slide (got transform: ${transform})`);
  const confirmingFlag = await page.$eval(`.swipe-row[data-sid="${raceHideS.id}"]`, el => el.dataset.confirming);
  ok(confirmingFlag === undefined, `the bumped row's data-confirming flag was cleared too, so it's draggable again (got ${JSON.stringify(confirmingFlag)})`);
  const meCheck = await apiGet('/api/sessions', me.token);
  const hideRowCheck = meCheck.find(s => s.id === raceHideS.id);
  ok(hideRowCheck && hideRowCheck.hiddenForMe === false, 'nothing actually happened server-side to the bumped row -- it was reset, not silently actioned');

  // And the sheet left showing (leave) still works normally -- canceling it resets ITS row too.
  const closeX = await page.$('.sheet-head button.sec.sm');
  await closeX.click();
  await page.waitForTimeout(400);
  const noSheet = await page.$('.sheet-back');
  ok(!noSheet, 'the surviving sheet closes normally afterward');
  const fgLeaveAfter = await rowFg(raceLeaveS.id);
  const transformLeave = await fgLeaveAfter.evaluate(el => getComputedStyle(el).transform);
  ok(transformLeave === 'none' || transformLeave === 'matrix(1, 0, 0, 1, 0, 0)', `its own row reset normally too (got transform: ${transformLeave})`);
  const meStillIn = await apiGet('/api/sessions', me.token);
  ok(meStillIn.some(s => s.id === raceLeaveS.id), 'canceling did not remove me from that workout either');
}

console.log('\nJeff, real bug report + "Smarter routing" follow-up (Sep 18/20 2026): swiping-to-delete MY OWN session, when a friend has joined it but hasn\'t logged anything yet, must not wipe it out from under them -- and must not even show Delete language, since it can never actually delete here');
{
  // "if we delete a workout we created and others have joined — it shouldn't delete the workout
  // for everyone — it should just let you leave, keeping that workout active for the others who
  // are currently still in the workout." Exercised here through the actual swipe gesture on Home,
  // not just the server-side/vm-level coverage in test/leave-workout.mjs -- this is the literal
  // feature Jeff was looking at when he reported it.
  // Sep 20 2026 follow-up ("Smarter routing", Jeff's pick over the simpler reworded-text option):
  // since Delete can never actually delete once someone else has joined, the row should never show
  // Delete language at all -- it goes straight to the same Leave sheet a non-creator sees. data-
  // action stays "delete" in the DOM (it's still true this is MY session), but data-other-stake
  // drives swipeRowConfirm to dispatch it exactly like a 'leave' row -- see sessionHasOtherStake's
  // own comment in app.js.
  const ownSharedS = await api('/api/sessions', { name: 'Shared With Sam', scheduledAt: new Date(Date.now() - 604800000).toISOString(), exercises: [{ name: 'Incline Press' }], visibility: 'private', inviteUsernames: [uFriend] }, me.token);
  await api(`/api/sessions/${ownSharedS.id}/accept`, {}, friend.token);
  // Neither of us has logged a single set here.

  await page.evaluate(() => window.home());
  await page.waitForTimeout(300);
  const rowShared = await page.$(`.swipe-row[data-sid="${ownSharedS.id}"]`);
  const actionAttr = await rowShared.evaluate(el => el.dataset.action);
  ok(actionAttr === 'delete', `it's my own session, so the row still carries data-action="delete" as always (got ${actionAttr})`);
  const otherStakeAttr = await rowShared.evaluate(el => el.dataset.otherStake);
  ok(otherStakeAttr === '1', `and data-other-stake reflects that my friend is really in it (got ${JSON.stringify(otherStakeAttr)})`);
  const fgShared = await rowShared.$('.swipe-row-fg');
  await dragFg(fgShared, -160, 12);
  await page.waitForTimeout(500);
  const heading = await page.$eval('.sheet-head h2', el => el.textContent);
  ok(/leave workout/i.test(heading), `goes straight to the real Leave sheet -- no Delete-workout language shown at all (got "${heading}")`);
  const discardBtn = await page.$('button:has-text("Discard today\'s sets")');
  ok(!!discardBtn, 'the same Save/Discard choice a non-creator Leave gets');
  await discardBtn.click();
  await page.waitForTimeout(400);

  const direct = await fetch(BASE + `/api/sessions/${ownSharedS.id}`, { headers: { Authorization: 'Bearer ' + friend.token } });
  ok(direct.status === 200, `the workout still exists -- fetching it as my friend does NOT 404 (got ${direct.status})`);
  const friendView = await direct.json();
  ok(!(friendView.participants || []).includes(me.user.id), 'I am gone as a participant (I left, not deleted it)');
  ok((friendView.participants || []).includes(friend.user.id), 'my friend is still right there, workout intact for them');
  ok(friendView.creatorId === friend.user.id, `ownership transferred to my friend, the one remaining current participant (got ${friendView.creatorId})`);
  const meAfterShared = await apiGet('/api/sessions', me.token);
  ok(!meAfterShared.some(s => s.id === ownSharedS.id && (s.participants || []).includes(me.user.id)), 'and it no longer shows as mine to keep managing');
}

await browser.close();
srv.kill();
await testDb.drop();
console.log(fails === 0 ? '\nall assertions passed' : `\n${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
