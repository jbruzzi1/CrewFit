// Oct 6 2026 (Jeff: "For reactivating a workout - it would be nice to be able to re-arrange the
// sets we completed - lets say i forgot a warm up and wanted to add an additional warm up set for
// example. and we can drag it to its proper position." Then, after an initial reactivate-gated
// draft was built and reviewed, Jeff re-scoped it: "Sorry - i just want to be able to edit sets to
// a published workout - I don't need to reactivate it at this time. Just want the reorder function
// when editing sets to a posted workout and adding a missed set.") Design confirmed via
// AskUserQuestion: a dedicated grab-handle icon per row (not press-and-hold the row), fully
// freeform ordering (any set can go anywhere; badges just relabel based on the new order).
//
// Lives on viewPost (the posted-recap screen), in the exact same "small edits without reactivating"
// surface as editPostedSet/addPostedSet (Sep 29 2026) -- own-recap only (isAuthor), no reactivation
// needed or involved. No new server route: PUT /api/sessions/:id/log/:logId already accepts a bare
// {set} update (the same route the Edit-set sheet uses), and .set is a pure display-order integer
// decoupled from the real timestamp every PR/streak/chronological computation uses (rebuildAllPrs
// sorts by _performedAt/.at, never by .set) -- so renumbering it is safe and touches nothing else.
// The client reuses the exact drag-reorder engine already shipped for the routine builder's
// exercise list (dragReorder()/.draft-ex/.drag-handle in app.js), just pointed at the posted-recap
// set list instead.
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

const testDb = await freshTestDb('postedreorder');
function boot(port, dir) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    srv.stdout.on('data', d => { if (String(d).includes('CrewFit on')) res(srv); });
    setTimeout(() => res(null), 15000);
  });
}
const PORT = 4999, BASE = `http://localhost:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), 'postedreorder-'));
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
const jordan = await reg('preorder_jordan', 'Jordan');
const taylor = await reg('preorder_taylor', 'Taylor'); // a training partner, to prove scoping

// A normal finished + posted workout -- NOT reactivated, matching Jeff's re-scoped request.
const sess = await api('/api/sessions', 'POST', jordan.token, { name: 'Pull Day', visibility: 'public', scheduledAt: new Date().toISOString(),
  exercises: [{ name: 'Barbell Row', defaultSets: 3, defaultReps: 8, defaultRepsMax: 10 }], invited: [] });
const exId = sess.exercises[0].id;
// A: normal 135x8 (set 1), B: normal 185x5 (set 2), C: warmup 95x10 (set 3) -- forgot the warmup
// until the end, exactly Jeff's own example.
const logA = await api(`/api/sessions/${sess.id}/log`, 'POST', jordan.token, { exerciseId: exId, weight: 135, reps: 8 });
const idA = logA.logs[jordan.id].find(l => l.weight === 135).id;
const logB = await api(`/api/sessions/${sess.id}/log`, 'POST', jordan.token, { exerciseId: exId, weight: 185, reps: 5 });
const idB = logB.logs[jordan.id].find(l => l.weight === 185).id;
const logC = await api(`/api/sessions/${sess.id}/log`, 'POST', jordan.token, { exerciseId: exId, weight: 95, reps: 10, setType: 'warmup' });
const idC = logC.logs[jordan.id].find(l => l.weight === 95).id;
await api(`/api/sessions/${sess.id}/lock`, 'POST', jordan.token, {});
await api(`/api/sessions/${sess.id}/post`, 'POST', jordan.token, { notes: '', media: [], visibility: 'public' });

const browser = await chromium.launch(LAUNCH_OPTS);
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.goto(BASE + '/');
await page.evaluate((tok) => localStorage.setItem('crewfit_token', tok), jordan.token);
await page.reload();
await page.waitForSelector('.nav', { timeout: 10000 });

console.log('UI: a LIVE (never-finished) session shows NO drag handles -- this feature never touches the live log sheet');
{
  const live = await api('/api/sessions', 'POST', jordan.token, { name: 'Leg Day', visibility: 'private', scheduledAt: new Date().toISOString(),
    exercises: [{ name: 'Back Squat', defaultSets: 3, defaultReps: 8, defaultRepsMax: 10 }] });
  const liveExId = live.exercises[0].id;
  await api(`/api/sessions/${live.id}/log`, 'POST', jordan.token, { exerciseId: liveExId, weight: 225, reps: 5 });
  await page.evaluate((id) => openSession(id), live.id);
  await page.waitForSelector('.ex-card', { timeout: 8000 });
  await page.waitForTimeout(150);
  const handles = await page.locator('.drag-handle').count();
  ok(handles === 0, `no drag handles on the live, in-progress log sheet (got ${handles})`);
}

console.log('UI: NO reactivation needed -- a normal, still-finished posted recap shows drag handles directly');
{
  await page.evaluate(({ id, authorId }) => viewPost(id, authorId), { id: sess.id, authorId: jordan.id });
  await page.waitForSelector('.pp-ex', { timeout: 8000 });
  await page.waitForTimeout(150);
  const hasReactivateBtn = await page.evaluate(() => Array.from(document.querySelectorAll('button')).some(b => b.textContent.includes('Reactivate workout')));
  ok(hasReactivateBtn, 'sanity: Reactivate workout is still offered (this workout was never touched by it) -- proves reordering did not require tapping it');
  const rows = await page.locator('.pp-set.pp-set-mine').count();
  ok(rows === 3, `3 set rows render (got ${rows})`);
  const handles = await page.locator('.drag-handle').count();
  ok(handles === 3, `one grab handle per set row, with zero reactivation involved (got ${handles})`);
  const addSetBtn = await page.locator('.pp-add-set').count();
  ok(addSetBtn === 1, 'the existing "+ Add set" button (small-edits-without-reactivating) is still right there alongside the handles');
  const order = await page.evaluate(() => Array.from(document.querySelectorAll('.pp-set-val')).map(e => e.textContent.trim()));
  ok(order[0].startsWith('135') && order[1].startsWith('185') && order[2].startsWith('95'), `initial order is 135, 185, 95 -- got ${order.join(' | ')}`);
  const badges = await page.evaluate(() => Array.from(document.querySelectorAll('.pp-set-n')).map(e => e.textContent.trim()));
  ok(badges[0] === '1' && badges[1] === '2' && badges[2] === 'W', `initial badges are 1, 2, W (got ${badges.join(',')})`);
}

console.log('UI: a training partner viewing MY recap never sees drag handles or the ability to reorder MY sets');
{
  // Taylor isn't in this session at all, but the recap is public -- viewable, never editable.
  await page.context().clearCookies();
  await page.evaluate((tok) => localStorage.setItem('crewfit_token', tok), taylor.token);
  await page.reload();
  await page.waitForSelector('.nav', { timeout: 10000 });
  await page.evaluate(({ id, authorId }) => viewPost(id, authorId), { id: sess.id, authorId: jordan.id });
  await page.waitForSelector('.pp-ex', { timeout: 8000 });
  await page.waitForTimeout(150);
  const handles = await page.locator('.drag-handle').count();
  ok(handles === 0, `no drag handles when viewing someone else's posted recap (got ${handles})`);
  // switch back to Jordan for the rest of the test
  await page.evaluate((tok) => localStorage.setItem('crewfit_token', tok), jordan.token);
  await page.reload();
  await page.waitForSelector('.nav', { timeout: 10000 });
}

console.log('UI: tapping a plain row (not the handle) still opens Edit set, unaffected by the new handle');
{
  await page.evaluate(({ id, authorId }) => viewPost(id, authorId), { id: sess.id, authorId: jordan.id });
  await page.waitForSelector('.pp-set.pp-set-mine', { timeout: 8000 });
  await page.locator('.pp-set.pp-set-mine').first().locator('.pp-set-val').click();
  await page.waitForSelector('.sheet-back', { timeout: 5000 });
  ok(true, 'Edit set sheet opened from a tap on the row body');
  await page.evaluate(() => closeSheet());
  await page.waitForTimeout(250);
}

console.log('UI: a plain tap on the handle itself (no movement) does NOT open Edit set');
{
  const handle = page.locator('.drag-handle').first();
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(200);
  const sheetOpen = await page.locator('.sheet-back').count();
  ok(sheetOpen === 0, `no Edit-set sheet opened from a plain tap on the grab handle (got ${sheetOpen} sheets)`);
}

console.log('UI: dragging the warm-up row (bottom) above the top row reorders it AND relabels the badges -- without any reactivation');
{
  const rowsBefore = page.locator('.pp-set.pp-set-mine');
  const lastHandle = rowsBefore.last().locator('.drag-handle');
  const lastBox = await lastHandle.boundingBox();
  const firstRowBox = await rowsBefore.first().boundingBox();

  await page.mouse.move(lastBox.x + lastBox.width / 2, lastBox.y + lastBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(lastBox.x + lastBox.width / 2, lastBox.y - 10, { steps: 5 });
  await page.mouse.move(firstRowBox.x + firstRowBox.width / 2, firstRowBox.y - 5, { steps: 10 });
  await page.waitForTimeout(100);
  await page.mouse.up();
  await page.waitForTimeout(500); // let the PUT round-trip + viewPost re-render settle

  const sheetOpen = await page.locator('.sheet-back').count();
  ok(sheetOpen === 0, 'dragging never opened the Edit-set sheet');

  const orderAfter = await page.evaluate(() => Array.from(document.querySelectorAll('.pp-set-val')).map(e => e.textContent.trim()));
  ok(orderAfter[0].startsWith('95'), `the warmup (95) is now first, got "${orderAfter[0]}"`);
  ok(orderAfter[1].startsWith('135'), `135 is now second, got "${orderAfter[1]}"`);
  ok(orderAfter[2].startsWith('185'), `185 is now third, got "${orderAfter[2]}"`);

  const badgesAfter = await page.evaluate(() => Array.from(document.querySelectorAll('.pp-set-n')).map(e => e.textContent.trim()));
  ok(badgesAfter[0] === 'W', `the warmup badge stays W regardless of position, got "${badgesAfter[0]}"`);
  ok(badgesAfter[1] === '1' && badgesAfter[2] === '2', `the two normal sets relabel to 1, 2 in their new order, got ${badgesAfter.slice(1).join(',')}`);

  const fresh = await api('/api/sessions/' + sess.id, 'GET', jordan.token);
  const byId = Object.fromEntries(fresh.logs[jordan.id].map(l => [l.id, l]));
  ok(byId[idC].set === 1 && byId[idA].set === 2 && byId[idB].set === 3,
    `server-side .set values persisted the new order (C=${byId[idC].set}, A=${byId[idA].set}, B=${byId[idB].set})`);
  ok(byId[idB].isPr === true, 'the 185x5 set (the real weight PR) keeps its PR flag after reordering -- .set never feeds PR logic');

  const stillCredited = (fresh.history || []).some(h => h.userId === jordan.id);
  ok(stillCredited, 'reordering sets never touches Log & Finish credit -- still finished, never reactivated');
  ok(!!(fresh.posts && fresh.posts[jordan.id]), 'the posted recap itself is untouched (still posted)');
}

console.log('server-level: lastSetChipHtml (live log sheet) still reflects chronological order, not the new freeform .set, in case this same session is ever separately reactivated');
{
  // The 95lb warmup (C) was logged THIRD/last chronologically -- but the drag above moved it to be
  // FIRST in display order, with the new .set values landing 185 (B) last (.set=3). If this exact
  // session is later reactivated (its own separate, pre-existing button) and its live log sheet
  // reopens, a .set-based "last set" would wrongly suggest 185; the cold-review fix sorts by .at
  // instead, so it must still correctly show the 95lb warmup.
  await api(`/api/sessions/${sess.id}/unlock`, 'POST', jordan.token, {});
  await page.evaluate((id) => openSession(id), sess.id);
  await page.waitForSelector('.ex-card', { timeout: 8000 });
  await page.waitForTimeout(150);
  const chipVal = await page.locator('.last-set-chip .lsc-val').textContent();
  ok(chipVal.trim().startsWith('95'), `Last-set chip shows 95 (chronologically last logged, the warmup), not 185 (now last in .set display order) -- got "${chipVal.trim()}"`);
}

console.log('geometry: the new handle does not crowd the badge or get clipped, and breathes against its neighbors (hard rule #4/#10)');
{
  await api(`/api/sessions/${sess.id}/lock`, 'POST', jordan.token, {}); // undo the unlock above
  await page.evaluate(({ id, authorId }) => viewPost(id, authorId), { id: sess.id, authorId: jordan.id });
  await page.waitForSelector('.pp-set.pp-set-mine', { timeout: 8000 });
  await page.waitForTimeout(150);
  const handle = page.locator('.drag-handle').first();
  const badge = page.locator('.pp-set-n').first();
  const row = page.locator('.pp-set.pp-set-mine').first();
  const hb = await handle.boundingBox(), bb = await badge.boundingBox(), rb = await row.boundingBox();
  ok(hb.x + hb.width <= bb.x, `handle sits fully left of the badge with no overlap (handle right edge ${hb.x + hb.width}, badge left ${bb.x})`);
  const gap = bb.x - (hb.x + hb.width);
  ok(gap >= 4, `at least 4px of breathing room between handle and badge, got ${gap.toFixed(1)}px`);
  ok(hb.y >= rb.y - 1 && (hb.y + hb.height) <= (rb.y + rb.height) + 1, `handle is vertically contained within its row, got handle [${hb.y},${hb.y+hb.height}] vs row [${rb.y},${rb.y+rb.height}]`);
}

console.log(errors.length ? '\nPAGE ERRORS:\n' + errors.join('\n') : '\nno page errors');
await page.close();
await browser.close();
srv.kill();
await testDb.drop();
console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails || errors.length ? 1 : 0);
