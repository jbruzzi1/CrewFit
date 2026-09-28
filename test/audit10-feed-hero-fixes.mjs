// Sep 28 2026 -- a second-pass review (another Claude, reading over the audit9 batch before it
// shipped) caught two small gaps in the Activity feed's hero-card/compact-row split, both left
// inside the existing design rather than changing it:
//
// 1. heroCardHtml's own hero card for YOUR OWN PR showed a "Y" fallback avatar instead of your
//    real initial/photo. actorOf's ME-branch substituted the literal string 'You' into
//    displayName so the headline text would read "You hit a new PR..." -- but that same object
//    is what avatarHtml(actorOf(ff.by),...) reads its fallback-initial from, so the "You" label
//    leaked into the avatar too. Fixed in app.js: actorOf now always carries your REAL
//    displayName (avatarHtml's initial is correct); actorName is the only place 'You' is
//    substituted, for headline text only.
//
// 2. When a PR ages out of "today" it demotes from a big hero card to a small compact row (see
//    heroCardHtml/compactRowHtml in app.js) -- worth confirming the compact row still carries the
//    actual number (e.g. "hit a new PR on Leg Curl (60 lb x 10)"), not just a generic "got a PR"
//    with no detail. Traced this through server.js: a 'pr' feed event's `text` is stamped once,
//    at log time (POST /api/sessions/:id/log), already including the weight/reps
//    (`hit a new PR on ${exerciseName} (${weightPart})`) -- the SAME event object is what both
//    heroCardHtml and compactRowHtml render, just through a different template once `isToday`
//    flips false, so the number was never at risk of being dropped. This test locks that in as a
//    real regression test instead of leaving it as an unverified read of the code.
//
// Real server + real Postgres + real Chromium (Playwright), same technique as
// test/audit9-pr-visibility.mjs. Single user throughout -- GET /api/feed includes the viewer's
// own activity (Sep 11 2026), so no second "friend" account is needed to see your own hero card
// and your own demoted compact row side by side.
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

const testDb = await freshTestDb('audit10feed');
function boot(port, dir) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    srv.stdout.on('data', d => { if (String(d).includes('CrewFit on')) res(srv); });
    setTimeout(() => res(null), 15000);
  });
}
const PORT = 4996, BASE = `http://localhost:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), 'audit10feed-'));
const srv = await boot(PORT, dir);
if (!srv) { console.log('FAIL server did not boot'); process.exit(1); }
async function cleanup() { try { srv.kill(); } catch {} try { await testDb.drop(); } catch {} }
process.on('uncaughtException', async (e) => { console.error('UNCAUGHT', e); await cleanup(); process.exit(1); });
process.on('unhandledRejection', async (e) => { console.error('UNHANDLED', e); await cleanup(); process.exit(1); });

async function api(path, method, token, body) {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
}
const reg = async (u) => {
  const r = await api('/api/register', 'POST', null, { username: u + Math.random().toString(36).slice(2, 8), pin: '123456', displayName: u });
  return { token: r.token, id: r.user.id, displayName: r.user.displayName };
};

const browser = await chromium.launch(LAUNCH_OPTS);
const errors = [];
async function loginAs(page, token) {
  await page.goto(BASE + '/');
  await page.evaluate((tok) => localStorage.setItem('crewfit_token', tok), token);
  await page.reload();
  await page.waitForSelector('.nav', { timeout: 10000 });
}
async function logNormal(page, exId, w, r) {
  await page.evaluate(({ exId }) => window.logSetType(exId, 'normal'), { exId });
  await page.fill(`.ex-log[data-ex="${exId}"] input[data-f="w"]`, String(w));
  await page.fill(`.ex-log[data-ex="${exId}"] input[data-f="r"]`, String(r));
  await page.click(`.ex-log[data-ex="${exId}"] button.add-btn`);
  await page.waitForTimeout(150);
}

const u = await reg('Dakota');   // displayName's real initial is 'D' -- must never render as 'Y'
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
page.on('pageerror', e => errors.push(String(e)));
await loginAs(page, u.token);

// --- Today's hero card: Incline Bench, a genuine PR logged today ---
const baseA = await api('/api/sessions', 'POST', u.token, { name: 'Push Baseline', scheduledAt: new Date(Date.now() - 10 * 86400e3).toISOString(), visibility: 'private', exercises: [{ name: 'Incline Bench Press' }] });
await page.evaluate((id) => window.openSession(id), baseA.id);
await page.waitForSelector('.ex-log', { timeout: 8000 });
await logNormal(page, baseA.exercises[0].id, 100, 10);   // baseline, not a PR (first-ever log)

const prA = await api('/api/sessions', 'POST', u.token, { name: 'Push Today', scheduledAt: new Date().toISOString(), visibility: 'private', exercises: [{ name: 'Incline Bench Press' }] });
await page.evaluate((id) => window.openSession(id), prA.id);
await page.waitForSelector('.ex-log', { timeout: 8000 });
await logNormal(page, prA.exercises[0].id, 110, 10);   // real PR, today, unlocked -- stays hero-eligible

// --- Yesterday's PR: Leg Curl, a genuine PR that should already render as a compact row ---
const baseB = await api('/api/sessions', 'POST', u.token, { name: 'Leg Baseline', scheduledAt: new Date(Date.now() - 10 * 86400e3).toISOString(), visibility: 'private', exercises: [{ name: 'Leg Curl' }] });
await page.evaluate((id) => window.openSession(id), baseB.id);
await page.waitForSelector('.ex-log', { timeout: 8000 });
await logNormal(page, baseB.exercises[0].id, 50, 12);   // baseline, not a PR (first-ever log)

const prB = await api('/api/sessions', 'POST', u.token, { name: 'Leg Yesterday', scheduledAt: new Date(Date.now() - 1 * 86400e3).toISOString(), visibility: 'private', exercises: [{ name: 'Leg Curl' }] });
await page.evaluate((id) => window.openSession(id), prB.id);
await page.waitForSelector('.ex-log', { timeout: 8000 });
await logNormal(page, prB.exercises[0].id, 60, 10);   // real PR, yesterday, unlocked -- _performedAt falls back to scheduledAt (see rebuildAllPrs)

console.log("A 'pr' feed event's own `at` follows the workout's scheduled date when it's neither locked nor posted (so a backdated PR reads as backdated, not as breaking news today)");
{
  const feed = await api('/api/feed', 'GET', u.token);
  const evA = Array.isArray(feed) && feed.find(f => f.type === 'pr' && f.exerciseName === 'Incline Bench Press');
  const evB = Array.isArray(feed) && feed.find(f => f.type === 'pr' && f.exerciseName === 'Leg Curl');
  ok(!!evA, 'the Incline Bench Press PR event exists in the feed');
  ok(!!evB, 'the Leg Curl PR event exists in the feed');
  const isToday = iso => new Date(iso).toDateString() === new Date().toDateString();
  ok(evA && isToday(evA.at), `Incline Bench Press PR's at is today (got ${evA && evA.at})`);
  ok(evB && !isToday(evB.at), `Leg Curl PR's at is yesterday, not today (got ${evB && evB.at})`);
  ok(evB && /60 lb × 10/.test(evB.text || ''), `and its own text already carries the real number, before any rendering (got: ${evB && evB.text})`);
}

await page.evaluate(() => window.showTab('friends'));
await page.waitForTimeout(300);
await page.evaluate(() => window.setFriendsTab && window.setFriendsTab('activity'));
await page.waitForTimeout(400);

console.log("\nYour own hero card shows your REAL avatar initial, not the literal headline word \"You\"");
{
  // heroCardHtml renders one .ar-card per hero item; the avatar sits in .ar-card-top's first
  // child. With no photo, avatarHtml falls back to a colored initial div -- assert it's Dakota's
  // real initial ('D'), the exact bug report: it was rendering 'Y' (from the 'You' headline
  // string) instead.
  const heroAvatarText = await page.evaluate(() => {
    const card = document.querySelector('.ar-card.ar-pr, .ar-card');
    if (!card) return null;
    const av = card.querySelector('.ar-card-top > *:first-child');
    return av ? av.textContent.trim() : null;
  });
  ok(heroAvatarText === 'D', `hero card avatar reads Dakota's real initial "D" (got: ${JSON.stringify(heroAvatarText)}) -- must never be "Y"`);
  const heroText = await page.evaluate(() => document.getElementById('app').innerText);
  ok(/\bYou\b/.test(heroText), 'the headline text itself still correctly reads "You" (that part was never wrong)');
}

console.log("\nYesterday's PR, demoted to a compact row, still carries the real weight x reps -- nothing lost in the hero-to-row demotion");
{
  const text = await page.evaluate(() => document.getElementById('app').innerText);
  // .light headers render text-transform:uppercase, and Chromium's innerText reflects that CSS
  // transform (not the literal DOM text) -- match case-insensitively rather than assume casing.
  ok(/this week/i.test(text), 'a "This week" section exists for the demoted (non-today) PR');
  ok(/Leg Curl/.test(text), 'the compact row names the exercise (Leg Curl)');
  ok(/60 lb × 10/.test(text), `the compact row still shows the real number, 60 lb × 10 (got: ${text.match(/Leg Curl.{0,60}/)?.[0] || 'Leg Curl not found'})`);
}

console.log(errors.length ? '\nPAGE ERRORS:\n' + errors.join('\n') : '\nno page errors');
await page.close();
await browser.close();
await cleanup();
console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails || errors.length ? 1 : 0);
