// Sep 10 2026 (Jeff, real bug report): "the logging page is saying 'one more set like that'
// before I even logged a set. If I just logged a set - this saying would be appropriate ...
// If I haven't logged a set yet - it should say something that depicts what we did last time
// and one more like that."
//
// The "when to add weight" box's ALMOST state (recommendationsFor's r.soon, refreshLogRec in
// app.js) is computed purely from PAST sessions -- it has no idea whether today's in-progress
// workout has a set logged for this exercise yet. "One more set like that" reads fine once you
// HAVE logged one today (there's a real "one" for "one more" to refer to); shown before that,
// on a card you haven't touched yet this workout, it has nothing to point back to.
//
// Fix: refreshLogRec now takes the current session object and checks whether ME has a log for
// this exerciseId in it. Not yet logged today -> "Last time: {weight} x {reps}" / "Match that
// today and the weight goes up next time" (Jeff's pick, from three rendered options). Already
// logged at least one set today -> the original "One more set like that" wording, unchanged.
//
// This test drives the real UI: opens the actual live-workout session (window.openSession, the
// same call every other screen test in this repo uses to enter a session), reads the real DOM
// text of the recommendation box BEFORE touching the exercise, then performs a REAL click on the
// "+ Add" button after filling the real weight/reps inputs -- not a scripted call to addLogSet --
// and reads the box again.
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
const testDb = await freshTestDb('logrecnotyet');

function boot(port, dir) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    srv.stdout.on('data', d => { if (String(d).includes('CrewFit on')) res(srv); });
    setTimeout(() => res(null), 15000);
  });
}

const PORT = 4998;
const dir = mkdtempSync(join(tmpdir(), 'crewfit-logrecnotyet-'));
const srv = await boot(PORT, dir);
if (!srv) { console.log('FAIL server did not boot'); process.exit(1); }
const BASE = `http://localhost:${PORT}`;
const J = { 'Content-Type': 'application/json' };
const post = (p, b, tok) => fetch(BASE + p, { method: 'POST', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b) }).then(r => r.json());

const EX = 'Flat Barbell Bench Press';

// Same recipe test/progression.mjs already uses (and asserts) to land in the ALMOST/soon state:
// one session that falls short of the 8-10 target, then one that tops out at the SAME weight.
// toppedOut(latest) is true, but toppedOut(prev) is false, so recommendationsFor lands in `soon`,
// not `ready` -- exactly the state whose wording Jeff reported as wrong.
async function past(tok, daysAgo, weight, reps) {
  const s = await post('/api/sessions', { name: 'past', visibility: 'private',
    scheduledAt: new Date(Date.now() - daysAgo * 864e5).toISOString(),
    exercises: [{ name: EX, defaultSets: 3, defaultReps: 8, defaultRepsMax: 10 }] }, tok);
  await post(`/api/sessions/${s.id}/log`, { exerciseId: s.exercises[0].id, weight, reps, setType: 'normal' }, tok);
}

const reg = await post('/api/register', { username: 'lrn' + Math.random().toString(36).slice(2, 8), pin: '123456', displayName: 'Jeff' });
const tok = reg.token;
await past(tok, 14, 185, 7);    // fell short of 8 -- does not top out
await past(tok, 7, 185, 10);    // tops out -- this becomes "latest"

// Today's workout -- the exercise sits here with NOTHING logged for it yet.
const s = await post('/api/sessions', { name: 'Push day', visibility: 'private',
  scheduledAt: new Date().toISOString(), exercises: [{ name: EX, defaultSets: 3, defaultReps: 8, defaultRepsMax: 10 }] }, tok);
const exId = s.exercises[0].id;

const browser = await chromium.launch(LAUNCH_OPTS);
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.goto(BASE + '/');
await page.evaluate((t) => localStorage.setItem('crewfit_token', t), tok);
await page.reload();
await page.waitForSelector('.nav', { timeout: 10000 });
await page.waitForTimeout(300);

await page.evaluate((id) => window.openSession(id), s.id);
await page.waitForSelector(`.ex-log[data-ex="${exId}"]`, { timeout: 8000 });

// refreshLogRec's own GET is fire-and-forget after the page paints -- poll for the box to fill in
// rather than a fixed sleep, same shape as the rest of this box's own state ("up"/"hold"/"soon").
async function recText(deadlineMs) {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    const t = await page.evaluate((id) => {
      const b = document.querySelector(`.ex-log[data-ex="${id}"]`); if (!b) return null;
      const title = b.querySelector('.lr-t'), why = b.querySelector('.lr-why');
      return title ? { title: title.textContent.trim(), why: why ? why.textContent.trim() : '' } : null;
    }, exId);
    if (t && t.title) return t;
    await page.waitForTimeout(150);
  }
  return null;
}

console.log('before logging any set today: states last time, not "one more"');
{
  const t = await recText(8000);
  ok(!!t, 'the box rendered something at all (never blank once there is a soon recommendation)');
  ok(!!t && t.title === 'Last time: 185 lb × 10', `headline states last time\'s numbers, got ${JSON.stringify(t && t.title)}`);
  ok(!!t && t.why === 'Match that today and the weight goes up next time', `subtext carries the forward-looking ask, got ${JSON.stringify(t && t.why)}`);
  ok(!!t && !/one more set like that/i.test(t.title), 'the old "One more set like that" wording is NOT shown before a set is logged today');
}

console.log('a real tap on "+ Add" logs a set for today, then the box switches to "one more set like that"');
{
  // recommendationsFor() reads whatever is in s.logs for TODAY's session too (see the comment
  // above refreshLogRec) -- logging AT THE SAME weight/reps as the last real session (185x10)
  // would immediately satisfy double progression and flip the state to READY, which is correct
  // app behavior but not what this test is checking. Logging at a DIFFERENT weight that still
  // tops out (190x10) keeps the state at ALMOST/soon -- toppedOut(latest=today) and
  // toppedOut(prev=185x10) are both true, but sameLoad fails (190 != 185) -- so this is still
  // exactly the "already logged a set today" case this fix is about, without also exercising the
  // (separately, already-tested) progression rule.
  await page.fill(`.ex-log[data-ex="${exId}"] [data-f="w"]`, '190');
  await page.fill(`.ex-log[data-ex="${exId}"] [data-f="r"]`, '10');
  await page.click(`.ex-log[data-ex="${exId}"] .add-btn`);
  await page.waitForTimeout(400);   // let addLogSet's POST land before polling the box that follows it

  const t = await recText(8000);
  ok(!!t && t.title === 'One more set like that', `headline switches back to the original wording once today has a real set, got ${JSON.stringify(t && t.title)}`);
  ok(!!t && t.why === 'hit 10 reps at 190 lb next time and the weight goes up', `subtext unchanged from before this fix (now reflecting today's own logged set as "latest"), got ${JSON.stringify(t && t.why)}`);
  ok(!!t && !/^Last time:/.test(t.title), 'the "Last time" wording is gone now that a set is logged');
}

ok(errors.length === 0, `no console pageerrors along the way (got ${JSON.stringify(errors)})`);

try { srv.kill(); } catch {}
rmSync(dir, { recursive: true, force: true });
await browser.close();
await testDb.drop();

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
