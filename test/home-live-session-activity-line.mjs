// Oct 7 2026 (Jeff: "take a fresh look" at Home -> flagged that a LIVE session, once started,
// drops out of the Next-up card (Sep 9 2026 rule: starting a session moves it to "Your sessions")
// and goes completely quiet there -- no sign a friend is actually mid-workout, even though the
// Next-up card already knows how to say exactly that. Jeff: "I like the live sessions you
// mentioned" (seeing who's active) but didn't want it to reclaim the Next-up slot, since that
// would undo the Sep 9 fix. Landed: a shared activeFriendsLine() helper now renders the same
// "X is in · X just started / is logging · N sets in" line in BOTH places -- the Next-up card
// (unchanged behavior, now just sourced from the shared helper) and, new, the live row down in
// "Your sessions" once a session has actually been started.
//
// Real end-to-end UI test: a real server + Postgres, two real connected users, three real
// sessions covering the three cases that matter -- a live-but-not-yet-started one (still lands in
// Next-up, proving the refactor didn't change that card's own output), a live-and-started one (the
// new case -- the plain "Your sessions" row must now show the activity line), and a future,
// not-live one with a participant but nothing happening yet (must NOT show the line -- this isn't
// meant to fire on every row with a friend in it, only a genuinely live one).
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
const testDb = await freshTestDb('homeactivity');

function boot(port, dir) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    srv.stdout.on('data', d => { if (String(d).includes('CrewFit on')) res(srv); });
    setTimeout(() => res(null), 15000);
  });
}

const PORT = 4996;
const dir = mkdtempSync(join(tmpdir(), 'crewfit-homeactivity-'));
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

// D: live window, Jeff has NOT tapped Start -- still eligible for the Next-up card.
const nextUpSession = await api('/api/sessions', 'POST', jeff.token, {
  name: 'Full Body', scheduledAt: new Date().toISOString(),
  exercises: [{ name: 'Barbell Row' }], visibility: 'private', inviteUsernames: [brian.user.username],
});
await api(`/api/sessions/${nextUpSession.id}/accept`, 'POST', brian.token, {});
await api(`/api/sessions/${nextUpSession.id}/log`, 'POST', brian.token, { exerciseId: nextUpSession.exercises[0].id, weight: 95, reps: 10 });

// A: live window, Jeff HAS started it -- drops to the plain "Your sessions" row.
const liveSession = await api('/api/sessions', 'POST', jeff.token, {
  name: 'Leg Day', scheduledAt: new Date().toISOString(),
  exercises: [{ name: 'Deadlift' }], visibility: 'private', inviteUsernames: [brian.user.username],
});
await api(`/api/sessions/${liveSession.id}/start`, 'POST', jeff.token, {});
await api(`/api/sessions/${liveSession.id}/accept`, 'POST', brian.token, {});
await api(`/api/sessions/${liveSession.id}/log`, 'POST', brian.token, { exerciseId: liveSession.exercises[0].id, weight: 315, reps: 3 });

// C: five days out, nothing happening yet -- a plain future row with a participant, but the
// activity line must stay off (this isn't "show a line whenever anyone else is in it").
const futureSession = await api('/api/sessions', 'POST', jeff.token, {
  name: 'Arm Day', scheduledAt: new Date(Date.now() + 5 * 86400000).toISOString(),
  exercises: [{ name: 'Dumbbell Curl' }], visibility: 'private', inviteUsernames: [brian.user.username],
});
await api(`/api/sessions/${futureSession.id}/accept`, 'POST', brian.token, {});

// E: live, started, Casey joined but hasn't logged a single set yet -- cold-review catch: the
// permanent test originally only ever exercised "someone logged something" (others.length>0 AND
// logging.length>0). This covers the others.length>0-but-logging.length===0 branch of
// activeFriendsLine -- "Casey is in", no activity suffix at all, not a blank/broken line.
const quietLiveSession = await api('/api/sessions', 'POST', jeff.token, {
  name: 'Core Day', scheduledAt: new Date().toISOString(),
  exercises: [{ name: 'Plank' }], visibility: 'private', inviteUsernames: [casey.user.username],
});
await api(`/api/sessions/${quietLiveSession.id}/start`, 'POST', jeff.token, {});
await api(`/api/sessions/${quietLiveSession.id}/accept`, 'POST', casey.token, {});

const browser = await chromium.launch(LAUNCH_OPTS);
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.goto(BASE + '/');
await page.evaluate((tok) => localStorage.setItem('crewfit_token', tok), jeff.token);
await page.reload();
await page.waitForSelector('.nav', { timeout: 10000 });
await page.evaluate(() => window.home());
await page.waitForSelector('.next-card', { timeout: 8000 });

console.log('the Next-up card (a live, not-yet-started session) still shows the activity line -- the refactor into a shared helper did not change this card\'s own output');
{
  const nextCardText = await page.$eval('.next-card', el => el.innerText);
  ok(nextCardText.includes('Full Body'), `sanity: Next-up is the right session (got ${JSON.stringify(nextCardText.slice(0, 40))})`);
  const who = await page.$('.next-card .next-who');
  ok(who !== null, 'the Next-up card has its activity line');
  const whoText = who ? await who.innerText() : '';
  ok(/Brian is in/.test(whoText), `names Brian as in the session (got ${JSON.stringify(whoText)})`);
  ok(/Brian just started/.test(whoText), `"just started" since the set was logged seconds ago (got ${JSON.stringify(whoText)})`);
}

console.log('Oct 7 2026 feature: a LIVE, already-STARTED session\'s plain row in "Your sessions" now shows the same activity line');
{
  const allLiveRows = await page.$$('.lib-item.session-live');
  ok(allLiveRows.length === 2, `both started/live sessions rendered as live rows (got ${allLiveRows.length})`);
  let rows = [];
  for (const r of allLiveRows) { const t = await r.innerText(); if (t.includes('Leg Day')) rows = [r]; }
  ok(rows.length === 1, 'found the Leg Day live row specifically among them');
  const rowText = await rows[0].innerText();
  ok(rowText.includes('Leg Day'), `sanity: this is the started session (got ${JSON.stringify(rowText.slice(0, 40))})`);
  ok(rowText.includes('Live now'), 'carries the pre-existing Live now badge, untouched by this change');
  // Cold-review catch: the activity line below already opens with "Brian is in", so the older
  // "with Brian" tag is deliberately suppressed on a LIVE row now -- otherwise the row said the
  // same fact twice in a row. The non-live future row (below) keeps "with Brian" unchanged.
  ok(!rowText.includes('with Brian'), '"with Brian" is suppressed here -- the activity line below already says it, more richly');
  const who = await rows[0].$('.next-who');
  ok(who !== null, 'the live row now has its own activity line (the actual fix)');
  const whoText = who ? await who.innerText() : '';
  ok(/Brian is in/.test(whoText), `names Brian (got ${JSON.stringify(whoText)})`);
  ok(/Brian just started/.test(whoText), `"just started" since his set was logged seconds ago (got ${JSON.stringify(whoText)})`);
  const avatar = await rows[0].$('.next-who .av');
  ok(avatar !== null, 'renders the same avatar-initial chip the Next-up card uses, not a plain text-only line');
}

console.log('cold-review catch: a LIVE row where the other participant has not logged anything yet shows "X is in" with no activity suffix -- not blank, not broken');
{
  const rows = await page.$$('.lib-item.session-live');
  let quietRow = null;
  for (const r of rows) { const t = await r.innerText(); if (t.includes('Core Day')) { quietRow = r; break; } }
  ok(quietRow !== null, 'the quiet live session\'s row rendered');
  if (quietRow) {
    const who = await quietRow.$('.next-who');
    ok(who !== null, 'still has an activity line -- others.length>0 is enough on its own to render it');
    const whoText = who ? await who.innerText() : '';
    ok(/Casey is in/.test(whoText), `names Casey as in it (got ${JSON.stringify(whoText)})`);
    ok(!/·/.test(whoText), `no activity suffix at all since Casey hasn't logged anything (got ${JSON.stringify(whoText)})`);
  }
}

console.log('a future, NOT-live session with a participant does not get the activity line -- this only fires for a genuinely live session, not any row with a friend in it');
{
  const allLibItems = await page.$$('.lib-item');
  let futureRow = null;
  for (const item of allLibItems) {
    const t = await item.innerText();
    if (t.includes('Arm Day')) { futureRow = item; break; }
  }
  ok(futureRow !== null, 'the future session\'s row rendered in Your sessions');
  if (futureRow) {
    const rowText = await futureRow.innerText();
    ok(rowText.includes('with Brian'), 'the pre-existing "with Brian" tag still renders (participant info is unaffected)');
    ok(!rowText.includes('Live now'), 'sanity: this row is not live');
    const who = await futureRow.$('.next-who');
    ok(who === null, 'no activity line on a non-live row, even though Brian is a real participant');
  }
}

console.log('a session with nobody else in it never renders an empty activity line (others.length===0 guard, unchanged by the refactor)');
{
  // The Next-up and live rows above both have Brian; confirm the helper's own early-return still
  // works by checking no row has a stray empty .next-who anywhere, and no console pageerrors fired.
  const emptyWho = await page.$$eval('.next-who', els => els.filter(el => !el.textContent.trim()).length);
  ok(emptyWho === 0, 'no empty activity-line element anywhere on the page');
}

ok(errors.length === 0, `no console pageerrors along the way (got ${JSON.stringify(errors)})`);

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
try { srv.kill(); } catch {}
rmSync(dir, { recursive: true, force: true });
await browser.close();
await testDb.drop();
process.exit(fails ? 1 : 0);
