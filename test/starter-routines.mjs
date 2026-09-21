// Sep 21 2026 (Jeff, feature request): "I want to update the routines page with default routines
// that new users and already created users can choose from. Such as 'Push/Pull' days 'Leg' days,
// etc. I think we make the routines page better." Clarified via AskUserQuestion (Jeff picked all
// four offered splits plus free text: "I think having a library to choose from (maybe all of the
// above) is good? Not just a select two or so.") and a follow-up ("These would be pre made
// routines to select from").
//
// Architecture (see the long comment above starterTemplates() in server.js for the full
// reasoning): a static starter-routines.json, the same convention as exercise-library.json --
// not real DB.templates rows owned by a fake "system" user, so there is no fake account that
// could leak into search/friend-suggestion/follow flows elsewhere in the app. GET /api/templates
// grew a third `starter` array alongside the existing `mine`/`shared`; the client's existing
// tplView/tplUse lookups (`[...mine, ...shared].find(...)`) were extended to `...starter` too, so
// viewing and using a starter routine reuses the exact same screens a real routine already has --
// with no ⋯ menu (no Edit/Delete/Remove -- nothing to own or hide) since a starter routine belongs
// to no one.
//
// This test drives the real server + real Postgres + real UI, not a mock: registers a real user,
// opens the real Routines page, and clicks through exactly what Jeff would tap on his phone.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { freshTestDb } from './_pgtestdb.mjs';

const SANDBOX_CHROMIUM = '/opt/pw-browsers/chromium';
const LAUNCH_OPTS = existsSync(SANDBOX_CHROMIUM) ? { executablePath: SANDBOX_CHROMIUM } : {};

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('starterroutines');

function boot(port, dir) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    srv.stdout.on('data', d => { if (String(d).includes('CrewFit on')) res(srv); });
    setTimeout(() => res(null), 15000);
  });
}

const PORT = 4997;
const dir = mkdtempSync(join(tmpdir(), 'crewfit-starterroutines-'));
const srv = await boot(PORT, dir);
if (!srv) { console.log('FAIL server did not boot'); process.exit(1); }
const BASE = `http://localhost:${PORT}`;

// The exact source of truth for exercise names -- the test asserts against real library entries,
// not hand-typed strings that could quietly drift from what starter-routines.json actually says.
const RAW_STARTER = JSON.parse(readFileSync(join(CWD, 'starter-routines.json'), 'utf8')).routines;

const browser = await chromium.launch(LAUNCH_OPTS);
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.goto(BASE + '/');

async function register(name) {
  const r = await page.evaluate(async ({ BASE, name }) => {
    const res = await fetch(BASE + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: name + Math.random().toString(36).slice(2, 8), pin: '123456', displayName: name }) });
    return res.json();
  }, { BASE, name });
  return r;
}

const me = await register('Jeff');

console.log('GET /api/templates carries a real starter array -- checked at the API level first, before any UI');
{
  const resp = await page.evaluate(async ({ BASE, tok }) => {
    const r = await fetch(BASE + '/api/templates', { headers: { Authorization: 'Bearer ' + tok } });
    return r.json();
  }, { BASE, tok: me.token });
  ok(Array.isArray(resp.starter), 'response has a starter array');
  ok(resp.starter.length === RAW_STARTER.length, `starter array has all ${RAW_STARTER.length} routines (got ${resp.starter.length})`);
  ok(resp.mine.length === 0, 'a brand-new user\'s own routines (mine) are still empty -- starter routines never get mixed into it');
  ok(resp.starter.every(t => t.starter === true), 'every starter routine is flagged starter:true');
  ok(resp.starter.every(t => t.ownerId === undefined), 'no starter routine carries an ownerId -- not owned by anyone, per the architecture decision');
  const pushDay = resp.starter.find(t => t.id === 'starter_push_day');
  ok(!!pushDay, 'Push Day is present by its real id');
  const realNames = new Set(JSON.parse(readFileSync(join(CWD, 'exercise-library.json'), 'utf8')).exercises.map(e => e.name));
  ok(resp.starter.every(t => t.exercises.every(e => realNames.has(e.name))), 'every exercise name in every starter routine is a real exercise-library.json entry, not invented');
  ok(pushDay.exercises.every(e => e.defaultSets > 0), 'withDefaults filled in real defaultSets for every starter exercise (not left blank)');
  const plankRoutine = resp.starter.find(t => t.exercises.some(e => e.name === 'Plank'));
  const plank = plankRoutine.exercises.find(e => e.name === 'Plank');
  ok(plank.defaultReps === undefined, 'a timed exercise (Plank) correctly gets no rep target, same rule every other timed exercise in the app follows');
}

await page.evaluate((tok) => localStorage.setItem('crewfit_token', tok), me.token);
await page.reload();
await page.waitForTimeout(300);

console.log('\nJeff, after seeing the first version: "Do we think we should make the list look better instead of just a scrollable field with all of them listed" -> picked collapsible groups by split. The real Routines page groups the 10 starter routines into 4 group cards (one per split), collapsed by default -- real taps only, no scripted state pokes');
{
  await page.evaluate(() => window.templatesPage());
  await page.waitForTimeout(300);
  const hasSectionHeader = await page.evaluate(() => !!Array.from(document.querySelectorAll('.lib-cat')).find(el => el.textContent === 'Starter routines'));
  ok(hasSectionHeader, 'the "Starter routines" section header is on screen');

  const splitNames = [...new Set(RAW_STARTER.map(r => r.split))];
  ok(splitNames.length === 4, `sanity: starter-routines.json really does carry 4 distinct splits (got ${splitNames.length})`);
  const headerTexts = await page.evaluate(() => Array.from(document.querySelectorAll('.card.tpl-list > .lib-item')).map(el => el.textContent));
  for (const s of splitNames) ok(headerTexts.some(t => t.includes(s)), `"${s}" group header is visible`);

  const rowNamesBefore = await page.evaluate(() => Array.from(document.querySelectorAll('.tpl-row .tpl-name')).map(el => el.textContent));
  ok(rowNamesBefore.length === 0, 'collapsed by default -- no individual routine rows show until a group is actually tapped open');

  // Measured, not eyeballed (CLAUDE.md hard rule #10): the group header's name and its chevron are
  // genuinely vertically centered against each other, not just "looks about right".
  const pplGroup = RAW_STARTER.find(r => r.id === 'starter_push_day').split;
  const headGeom = await page.evaluate((label) => {
    const head = Array.from(document.querySelectorAll('.lib-item')).find(el => el.textContent.includes(label));
    const nameRect = head.firstElementChild.getBoundingClientRect();
    const svgRect = head.querySelector('svg').getBoundingClientRect();
    return { nameMid: nameRect.top + nameRect.height / 2, svgMid: svgRect.top + svgRect.height / 2 };
  }, pplGroup);
  ok(Math.abs(headGeom.nameMid - headGeom.svgMid) <= 1, `group header name and chevron are vertically centered (name mid=${headGeom.nameMid}, chevron mid=${headGeom.svgMid})`);

  // Real tap on the Push/Pull/Legs group header -- not a scripted toggleStarterGroup() call.
  await page.click(`.lib-item:has-text("${pplGroup}")`);
  await page.waitForTimeout(300);
  const rowNamesAfter = await page.evaluate(() => Array.from(document.querySelectorAll('.tpl-row .tpl-name')).map(el => el.textContent));
  const pplRoutines = RAW_STARTER.filter(r => r.split === pplGroup);
  for (const r of pplRoutines) ok(rowNamesAfter.includes(r.name), `after tapping "${pplGroup}" open, "${r.name}" row is visible`);
  const otherSplitNames = RAW_STARTER.filter(r => r.split !== pplGroup).map(r => r.name);
  ok(otherSplitNames.every(n => !rowNamesAfter.includes(n)), 'other groups stay collapsed -- expanding one does not expand the rest');
  const scrollY1 = await page.evaluate(() => window.scrollY);
  ok(scrollY1 === 0, 'expanding a group does not yank the page (still at the top, nothing to scroll yet)');

  // Real tap to collapse it back.
  await page.click(`.lib-item:has-text("${pplGroup}")`);
  await page.waitForTimeout(300);
  const rowNamesCollapsedAgain = await page.evaluate(() => Array.from(document.querySelectorAll('.tpl-row .tpl-name')).map(el => el.textContent));
  ok(rowNamesCollapsedAgain.length === 0, 'tapping the same header again collapses it back');

  // Re-open it for the rest of this test (tapping into Push Day's own detail screen next).
  await page.click(`.lib-item:has-text("${pplGroup}")`);
  await page.waitForTimeout(300);

  ok(errors.length === 0, `no console pageerrors expanding/collapsing groups (got ${JSON.stringify(errors)})`);
}

console.log('\ntapping a starter routine opens the real detail screen (tplView), with real exercises and real sets x reps -- but no ⋯ menu, since it belongs to no one');
{
  await page.click('.tpl-row:has-text("Push Day")');
  await page.waitForTimeout(300);
  const title = await page.evaluate(() => document.querySelector('h1')?.textContent);
  ok(title === 'Push Day', `landed on Push Day's own detail screen (got ${JSON.stringify(title)})`);
  const exNames = await page.evaluate(() => Array.from(document.querySelectorAll('.card .lib-item')).map(el => el.textContent));
  const pushDaySpec = RAW_STARTER.find(r => r.id === 'starter_push_day');
  for (const ex of pushDaySpec.exercises) ok(exNames.some(t => t.includes(ex.name)), `Push Day's detail screen lists "${ex.name}"`);
  const hasDots = await page.evaluate(() => !!document.querySelector('.pp-dots'));
  ok(!hasDots, 'no ⋯ menu renders for a starter routine -- nothing to Edit/Delete/Remove');
  const hasUseBtn = await page.evaluate(() => !!Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Use routine'));
  ok(hasUseBtn, '"Use routine" is still there');
  const hasBackBtn = await page.evaluate(() => !!document.querySelector('button[aria-label="Back"]'));
  ok(hasBackBtn, 'the real Back button is there too');

  // Measured, not eyeballed (CLAUDE.md hard rule #10): confirm omitting the empty dots span left
  // no dead gap -- "Use routine" sits flush at the header's right edge, same as it would for any
  // owned routine that simply had no menu items, not shifted left by a phantom empty child.
  const geom = await page.evaluate(() => {
    const head = document.querySelector('.pp-head.tpl-head').getBoundingClientRect();
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Use routine').getBoundingClientRect();
    return { headRight: head.right, btnRight: btn.right };
  });
  ok(Math.abs(geom.headRight - geom.btnRight) <= 2, `Use routine sits flush at the header's right edge (head right=${geom.headRight}, button right=${geom.btnRight})`);
}

console.log('\ntapping "Use routine" on a starter routine loads its exercises into a real new workout, exactly like any other routine');
{
  await page.click('button:has-text("Use routine")');
  await page.waitForTimeout(300);
  const nameField = await page.evaluate(() => $('wname') ? $('wname').value : null);
  ok(nameField === 'Push Day', `the new workout is pre-named "Push Day" (got ${JSON.stringify(nameField)})`);
  const draftNames = await page.evaluate(() => Array.from(document.querySelectorAll('.draft-ex .draft-name')).map(el => el.textContent));
  const pushDaySpec2 = RAW_STARTER.find(r => r.id === 'starter_push_day');
  ok(draftNames.length === pushDaySpec2.exercises.length, `the draft workout has all ${pushDaySpec2.exercises.length} of Push Day's exercises loaded (found ${draftNames.length})`);
  for (const ex of pushDaySpec2.exercises) ok(draftNames.includes(ex.name), `"${ex.name}" is in the loaded draft`);
}

try { srv.kill(); } catch {}
rmSync(dir, { recursive: true, force: true });
await browser.close();
await testDb.drop();

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
