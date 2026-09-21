// Sep 20 2026 (Jeff, real bug report): "Currently there is no way to go back a page after
// clicking on persons profile. For example; my issue, I click one someone's page then go to
// followers to check on them and click on another- I have no way to go back to the original
// person or a few pages even. I'm stuck at the end and have to clear out by going back to my
// page from the profile nav button."
//
// Root cause: profileView() is a real, tracked navigation (see navigated()/CURRENT_NAV_STATE in
// app.js -- it pushes its own history entry same as every other drill-down screen), so
// history.back() already walked it correctly one hop at a time. The bug is that profileView was
// the one drill-down screen in the whole app that never rendered anything on screen to actually
// TAP for that -- followList (right below it), viewPost, crewView, challengeView, and the library
// muscle screens all render their own "<- Back" bar; profileView didn't. Invisible in a desktop
// browser (edge-swipe / Alt+Left still gets you there) and easy to miss testing this sandbox's
// Chromium for the same reason -- but on an iPhone, once this is added to the Home Screen as a
// standalone PWA, there is no browser chrome and no equivalent gesture at all. A screen with
// nothing on it to tap is a dead end, which is exactly what Jeff hit.
//
// This test drives the REAL repro with real registered accounts and real UI clicks (not scripted
// history.back() calls): open someone's profile, open their followers list, tap into one of
// those followers' own profile -- three real hops deep -- then taps the actual on-screen Back
// button at each level and confirms it lands one hop back each time, ending where the chain
// started. Also confirms the button does NOT show on your own profile (the Me tab already gets
// you there) and DOES survive a silent re-render (toggleFollow) rather than vanishing.
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
const testDb = await freshTestDb('profilebackbtn');

function boot(port, dir) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    srv.stdout.on('data', d => { if (String(d).includes('CrewFit on')) res(srv); });
    setTimeout(() => res(null), 15000);
  });
}

const PORT = 4998;
const dir = mkdtempSync(join(tmpdir(), 'crewfit-profilebackbtn-'));
const srv = await boot(PORT, dir);
if (!srv) { console.log('FAIL server did not boot'); process.exit(1); }
const BASE = `http://localhost:${PORT}`;

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
  return r; // {token, user: {...}} shape assumed same as other tests -- normalized below
}

const me = await register('Jeff');
const meId = me.user ? me.user.id : me.id;
const alice = await register('Alice');
const aliceId = alice.user ? alice.user.id : alice.id;
const bob = await register('Bob');
const bobId = bob.user ? bob.user.id : bob.id;

// Real follow relationships via the real API, not fixture injection: bob follows alice, so
// alice's Followers list genuinely contains bob (public accounts, so the request auto-approves).
await page.evaluate(async ({ BASE, tok, targetId }) => {
  await fetch(BASE + '/api/follow/' + targetId, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: '{}' });
}, { BASE, tok: bob.token, targetId: aliceId });

await page.evaluate((tok) => localStorage.setItem('crewfit_token', tok), me.token);
await page.reload();
await page.waitForTimeout(300);

console.log('the exact repro: alice\'s profile -> her Followers list -> bob\'s profile -- three real hops, three real Back taps');
{
  await page.evaluate((id) => window.profileView(id), aliceId);
  await page.waitForTimeout(300);
  const onAlice1 = await page.evaluate(() => document.querySelector('.pname')?.textContent);
  ok(onAlice1 === 'Alice', `landed on Alice's profile first (got ${JSON.stringify(onAlice1)})`);
  const aliceHasBack = await page.evaluate(() => !!Array.from(document.querySelectorAll("button[aria-label=\"Back\"]")).find(b => b.textContent.includes('Back')));
  ok(aliceHasBack, "Alice's profile (not mine) renders a real on-screen Back button -- the actual fix");

  // Tap the real Followers stat, same as a real finger tap would.
  await page.click('.pstat:has-text("Followers")');
  await page.waitForTimeout(300);
  const onFollowersList = await page.evaluate(() => document.querySelector('h1')?.textContent);
  ok(onFollowersList === 'Followers', `landed on the real Followers list (got ${JSON.stringify(onFollowersList)})`);
  const bobRowVisible = await page.evaluate(() => !!Array.from(document.querySelectorAll('.friend-row .name')).find(el => el.textContent === 'Bob'));
  ok(bobRowVisible, "Bob really shows up in Alice's followers list");

  // Tap into Bob's own profile from there -- the exact "click on another" step from Jeff's report.
  await page.click('.friend-row:has-text("Bob")');
  await page.waitForTimeout(300);
  const onBob = await page.evaluate(() => document.querySelector('.pname')?.textContent);
  ok(onBob === 'Bob', `landed on Bob's profile, three hops deep (got ${JSON.stringify(onBob)})`);
  const bobHasBack = await page.evaluate(() => !!Array.from(document.querySelectorAll("button[aria-label=\"Back\"]")).find(b => b.textContent.includes('Back')));
  ok(bobHasBack, "Bob's profile also renders the real Back button -- this is the screen Jeff got stuck on");

  // Hop 1 back: tap the REAL on-screen button (not a scripted history.back()/page.goBack()) --
  // this is literally what Jeff has to be able to tap on his phone.
  await page.click('button[aria-label="Back"]');
  await page.waitForTimeout(300);
  const backOnFollowers = await page.evaluate(() => document.querySelector('h1')?.textContent);
  ok(backOnFollowers === 'Followers', `one Back tap from Bob's profile lands back on the Followers list (got ${JSON.stringify(backOnFollowers)})`);

  // Hop 2 back.
  await page.click('button[aria-label="Back"]');
  await page.waitForTimeout(300);
  const backOnAlice = await page.evaluate(() => document.querySelector('.pname')?.textContent);
  ok(backOnAlice === 'Alice', `a second Back tap lands back on Alice's profile, not stuck anywhere (got ${JSON.stringify(backOnAlice)})`);

  // Hop 3 back: all the way out to wherever this chain started (Home, in this test).
  await page.click('button[aria-label="Back"]');
  await page.waitForTimeout(300);
  const backOnHome = await page.evaluate(() => !!document.querySelector('.btn-new'));
  ok(backOnHome, 'a third Back tap clears the whole chain, landing back on Home -- not stuck at the end');

  ok(errors.length === 0, `no console pageerrors along the way (got ${JSON.stringify(errors)})`);
}

console.log('\ncold-review catch: reaching your OWN profile via a drill-down (not the Me tab) still gets a real, working Back button -- id===ME.id alone does not mean "this is the Me tab root"');
{
  // Jeff follows Alice for real, so Jeff's own row genuinely appears in Alice's Followers list --
  // exactly the "you show up in a mutual's followers list" case cold review caught.
  await page.evaluate(async ({ BASE, tok, targetId }) => {
    await fetch(BASE + '/api/follow/' + targetId, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: '{}' });
  }, { BASE, tok: me.token, targetId: aliceId });

  await page.evaluate((id) => window.followList(id, 'followers'), aliceId);
  await page.waitForTimeout(300);
  const meRowVisible = await page.evaluate(() => !!Array.from(document.querySelectorAll('.friend-row .name')).find(el => el.textContent === 'Jeff'));
  ok(meRowVisible, "Jeff's own row genuinely shows up in Alice's followers list (a real mutual follow, not a fixture)");

  await page.click('.friend-row:has-text("Jeff")');
  await page.waitForTimeout(300);
  const onOwnProfileViaDrill = await page.evaluate(() => document.querySelector('.pname')?.textContent);
  ok(onOwnProfileViaDrill === 'Jeff', 'tapping it lands on my own profile, reached via drill-down rather than the Me tab');
  const hasBackHere = await page.evaluate(() => !!Array.from(document.querySelectorAll("button[aria-label=\"Back\"]")).find(b => b.textContent.includes('Back')));
  ok(hasBackHere, 'and it DOES render a Back button here -- gating on plain isMe would wrongly hide it');

  await page.click('button[aria-label="Back"]');
  await page.waitForTimeout(300);
  const backOnAliceFollowers = await page.evaluate(() => document.querySelector('h1')?.textContent);
  ok(backOnAliceFollowers === 'Followers', 'and the button actually works, landing back on the followers list it came from');
}

console.log('\nyour own profile (reached via the real Me tab) does NOT get a Back button -- the bottom nav already gets you there, and it would be a dead button anyway (nothing was pushed to pop back to). Checked right after the drill-down case above, to confirm the Me tab correctly clears that state rather than inheriting it.');
{
  await page.evaluate(() => window.showTab('me'));
  await page.waitForTimeout(300);
  const onMe = await page.evaluate(() => document.querySelector('.pname')?.textContent);
  ok(onMe === 'Jeff', `landed on my own profile via the Me tab (got ${JSON.stringify(onMe)})`);
  const meHasBack = await page.evaluate(() => !!Array.from(document.querySelectorAll("button[aria-label=\"Back\"]")).find(b => b.textContent.includes('Back')));
  ok(!meHasBack, 'my own profile via the Me tab renders no Back button');
}

console.log('\nBack button survives a silent re-render (toggleFollow), not just the initial paint');
{
  await page.evaluate((id) => window.profileView(id), aliceId);
  await page.waitForTimeout(300);
  await page.click('#followBtn'); // Jeff already follows nobody yet here -- this is Follow, a real POST + silent re-render
  await page.waitForTimeout(400);
  const stillHasBack = await page.evaluate(() => !!Array.from(document.querySelectorAll("button[aria-label=\"Back\"]")).find(b => b.textContent.includes('Back')));
  ok(stillHasBack, 'the Back button is still there after toggleFollow silently redraws the same profile');
  const onAliceStill = await page.evaluate(() => document.querySelector('.pname')?.textContent);
  ok(onAliceStill === 'Alice', 'and it is still genuinely Alice\'s profile on screen, not blown away by the re-render');
}

try { srv.kill(); } catch {}
rmSync(dir, { recursive: true, force: true });
await browser.close();
await testDb.drop();

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
