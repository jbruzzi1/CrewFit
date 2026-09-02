// Jeff, Aug 22: "I made a workout joinable - buit after I made the workout i deafaulted
// back to private." Traced to openAddExercises(): tapping "+ Add exercise" mid-create
// stashed DRAFT.location/lengthMin/creatorNote/name before navigating to the exercise
// library, but NOT DRAFT.visibility or the scheduled date/time (DRAFT._dt). Returning via
// libDone() -> createFlow() fully re-renders the form, including a fresh <select id="vis">
// whose `selected` state is computed from that stale, never-updated DRAFT.visibility --
// silently reverting Friends-only back to Private. Since adding an exercise is essentially
// mandatory when creating a workout, this reproduced every time.
//
// The same gap existed in templatesPage(): "Routines" (also reachable mid-create) stashed
// nothing at all, and tplUse() also returns via createFlow() -- so browsing routines
// mid-create would have reverted name/visibility/date/location/length/note too.
//
// Both are fixed by stashing the same fields openAddExercises already stashed for the
// other inputs. This test drives the real rendered app in a real browser (not a DOM mock)
// so it exercises the actual click handlers, not a reimplementation of them.
//
// Ported to the Postgres-backed test harness (Aug 2026 data-layer migration) — the original
// version predates that migration and relied on DATA_DIR alone to boot the server; server.js
// now requires DATABASE_URL unconditionally. No assertions changed, just how the server boots.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { freshTestDb } from './_pgtestdb.mjs';

// This sandbox has Chromium pre-installed at a fixed path (PLAYWRIGHT_BROWSERS_PATH) and skips
// Playwright's own download to save re-fetching it every session. CI (and any other machine) has
// no such path -- there, Playwright must resolve its own browser, installed via the
// "npx playwright install" step in .github/workflows/deploy.yml. Only pass executablePath when
// the sandbox-specific binary actually exists, so this test still runs everywhere else.
const SANDBOX_CHROMIUM = '/opt/pw-browsers/chromium';
const LAUNCH_OPTS = existsSync(SANDBOX_CHROMIUM) ? { executablePath: SANDBOX_CHROMIUM } : {};

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('createflow');

function boot(port, dir) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; srv.stdout.on('data', d => { out += d; if (String(d).includes('CrewFit on')) res({ srv, out }); });
    srv.on('exit', () => res({ srv: null, out }));
    setTimeout(() => res({ srv, out }), 15000);
  });
}

const PORT = 4712;
const dir = mkdtempSync(join(tmpdir(), 'crewfit-visfix-'));
const { srv } = await boot(PORT, dir);
if (!srv) { console.log('  FAIL server did not boot'); process.exit(1); }
const BASE = `http://localhost:${PORT}`;

const browser = await chromium.launch(LAUNCH_OPTS);
async function freshPage() {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const uname = 'vfx' + Math.random().toString(36).slice(2, 8);
  await page.goto(BASE + '/');
  const reg = await page.evaluate(async ({ BASE, uname }) => {
    const r = await fetch(BASE + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: uname, pin: '123456', displayName: 'Vis Fix Test' }) });
    return r.json();
  }, { BASE, uname });
  await page.evaluate((tok) => localStorage.setItem('crewfit_token', tok), reg.token);
  await page.reload();
  await page.waitForTimeout(300);
  return page;
}

console.log('"+ Add exercise" mid-create must not revert the form on return');
{
  const page = await freshPage();
  await page.evaluate(() => window.createFlow());
  await page.waitForTimeout(200);
  await page.fill('#wname', 'Leg Day');
  await page.selectOption('#vis', 'public');
  await page.click('button:has-text("+ Add exercise")');
  await page.waitForTimeout(300);
  await page.evaluate(() => window.libDone());
  await page.waitForTimeout(300);
  const vis = await page.$eval('#vis', el => el.value);
  const name = await page.$eval('#wname', el => el.value);
  ok(vis === 'public', `visibility survives "+ Add exercise" round trip (got ${vis})`);
  ok(name === 'Leg Day', `workout name survives "+ Add exercise" round trip (got "${name}")`);
  await page.close();
}

console.log('\n"Routines" mid-create must not revert the form on return');
{
  const page = await freshPage();
  await page.evaluate(() => window.createFlow());
  await page.waitForTimeout(200);
  await page.fill('#wname', 'Push Day');
  await page.selectOption('#vis', 'public');
  await page.click('.tpl-actions button:has-text("Routines")');
  await page.waitForTimeout(300);
  // No routines exist yet, so just navigate straight back the way createFlow() would be
  // re-entered from any return path off templatesPage (e.g. the Workouts nav).
  await page.evaluate(() => window.createFlow());
  await page.waitForTimeout(300);
  const vis = await page.$eval('#vis', el => el.value);
  const name = await page.$eval('#wname', el => el.value);
  ok(vis === 'public', `visibility survives "Routines" round trip (got ${vis})`);
  ok(name === 'Push Day', `workout name survives "Routines" round trip (got "${name}")`);
  await page.close();
}

await browser.close();
try { srv && srv.kill(); } catch {}
rmSync(dir, { recursive: true, force: true });
await testDb.drop();

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
