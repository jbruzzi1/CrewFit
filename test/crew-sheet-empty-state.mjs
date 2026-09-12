// Sep 11 2026, real bug report (Jeff, relaying another agent's find): a brand-new user with zero
// connections taps "+ New crew" and hits a near-invisible dead end -- one small muted caption
// with no icon, no tap target, and no way to tell how to fix it -- while "Create crew" stayed
// fully enabled, so tapping through created a silent, empty, functionally inert solo crew with no
// explanation. Discussed with Jeff before building (see the chat): solo-crew creation STAYS
// allowed (someone may genuinely want to name a crew now and add people later), but the empty
// member list now gets a real homeEmpty()-shaped prompt -- icon, title, sub, and an actual button
// that closes the sheet and focuses the connections search box on the Friends page underneath.
// Real server + real Postgres + real browser, real UI clicks (not API shortcuts) for every
// interaction that matters to what's being tested.
import { mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { freshTestDb } from './_pgtestdb.mjs';

const LAUNCH_OPTS = existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {};
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('crewsheetempty');
const PORT = 4993, BASE = `http://localhost:${PORT}`;
const J = { 'Content-Type': 'application/json' };
const post = (p, b, tok) => fetch(BASE + p, { method: 'POST', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b) }).then(r => r.json());
const get = (p, tok) => fetch(BASE + p, { headers: tok ? { Authorization: 'Bearer ' + tok } : {} }).then(r => r.json());

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };

const srv = await new Promise(res => {
  const p = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: mkdtempSync(join(tmpdir(), 'crewsheetempty-')), DATABASE_URL: testDb.url, PORT: String(PORT) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stderr.on('data', d => process.stderr.write(String(d)));
  p.stdout.on('data', d => { if (String(d).includes('CrewFit on')) res(p); });
  setTimeout(() => res(null), 15000);
});
if (!srv) { console.log('FAIL boot'); process.exit(1); }
let cleanedUp = false;
async function cleanup() {
  if (cleanedUp) return; cleanedUp = true;
  try { srv.kill(); } catch {}
  try { await testDb.drop(); } catch {}
}
process.on('uncaughtException', async (e) => { console.error('UNCAUGHT', e); await cleanup(); process.exit(1); });
process.on('unhandledRejection', async (e) => { console.error('UNHANDLED', e); await cleanup(); process.exit(1); });

const rand = Math.floor(Math.random() * 90000) + 10000;
const a = await post('/api/register', { username: `csa_${rand}`, pin: 'pass1234', displayName: 'Alice NoCrew' });
const b = await post('/api/register', { username: `csb_${rand}`, pin: 'pass1234', displayName: 'Bob Buddy' });
if (a.error || b.error) throw new Error('register: ' + (a.error || b.error));

const browser = await chromium.launch(LAUNCH_OPTS);
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('dialog', d => { console.log('  DIALOG', d.message()); d.accept(); });

await page.goto(BASE + '/');
await page.evaluate((tok) => localStorage.setItem('crewfit_token', tok), a.token);
await page.evaluate(() => localStorage.setItem('crewfit_theme', 'dark'));
await page.reload();
await page.waitForSelector('.nav', { timeout: 10000 });

console.log('sanity check (Jeff asked, since the new empty state now leans on this same CTA): the');
console.log('PRE-EXISTING "Find people to follow" link on the Friends tab\'s own empty Activity');
console.log('state actually focuses the search box -- not part of this fix, but worth confirming');
console.log('since it is not inside a sheet and was never covered by an automated test before');
{
  await page.click('[data-tab="friends"]');
  await page.waitForSelector('#fu', { timeout: 8000 });
  await page.click('.home-empty:has-text("Nothing from your friends yet") .he-cta');
  await page.waitForTimeout(150);
  const focused = await page.evaluate(() => document.activeElement && document.activeElement.id);
  ok(focused === 'fu', `the feed's own "Find people to follow →" really does focus #fu, got "${focused}"`);
}

console.log('\na brand-new user (zero connections) taps + New crew -- real UI clicks throughout');
{
  // FRIENDS_TAB defaults to 'activity' (app.js) -- the Crews sub-view (and its "Create a crew"
  // CTA) only renders after switching to it. This test predates that Activity/Crews toggle and
  // never clicked into the Crews tab, so this click always timed out -- silently, since it sits
  // last in npm test's `&&` chain and a stray vapid.json (fixed separately) was already short-
  // circuiting the chain before reaching this file at all.
  await page.click('button:has-text("Crews")');
  await page.waitForSelector('span.he-cta:has-text("Create a crew")', { timeout: 8000 });
  await page.click('span.he-cta:has-text("Create a crew")');
  await page.waitForSelector('.sheet-head:has-text("New crew")', { timeout: 8000 });
  await page.waitForTimeout(200);

  const state = await page.evaluate(() => {
    const list = document.getElementById('crewMemberList');
    const empty = document.querySelector('.sheet .home-empty');
    return {
      cardExists: !!list,
      emptyExists: !!empty,
      emptyIsInsideACard: !!(empty && empty.closest('.card')),
      title: empty && empty.querySelector('.he-title') && empty.querySelector('.he-title').textContent,
      sub: empty && empty.querySelector('.he-sub') && empty.querySelector('.he-sub').textContent,
      cta: empty && empty.querySelector('.he-cta') && empty.querySelector('.he-cta').textContent,
      hasSvgIcon: !!(empty && empty.querySelector('svg')),
    };
  });
  ok(!state.cardExists, 'the old boxed #crewMemberList card is not rendered at all when the friend list is empty');
  ok(state.emptyExists, 'a real homeEmpty()-shaped block renders in its place');
  ok(!state.emptyIsInsideACard, 'the empty state renders OPEN, not nested inside a .card box (house style: a card only ever wraps content)');
  ok(state.hasSvgIcon, 'the empty state has an actual icon, not just bare text');
  ok(state.title === 'Find a training partner first', `title reads exactly "Find a training partner first", got "${state.title}"`);
  // "Search above" (Jeff's originally-approved wording) got dropped mid-build -- it assumed the
  // Friends search box was always visible underneath this sheet, which isn't true from crewView's
  // Edit button (see the crash-repro block further down). "Search for people" holds up regardless
  // of which of the three entry points opened this sheet.
  ok(state.sub === 'Search for people to train with — or create the crew now and invite them once you have some people.', `sub reads the corrected copy (see comment), got "${state.sub}"`);
  ok(state.cta === 'Find people to follow →', `CTA reads "Find people to follow →", got "${state.cta}"`);

  console.log('\ntapping the CTA closes the sheet and focuses the real connections search box underneath');
  await page.click('.sheet .home-empty .he-cta');
  await page.waitForTimeout(400);
  const afterTap = await page.evaluate(() => ({
    sheetGone: !document.querySelector('.sheet-back.show'),
    focusedId: document.activeElement && document.activeElement.id,
  }));
  ok(afterTap.sheetGone, 'the "New crew" sheet actually closes on tap');
  ok(afterTap.focusedId === 'fu', `focus lands on the real Friends-page search box (#fu), got "${afterTap.focusedId}"`);

  console.log('\nJeff\'s call: "Create crew" stays enabled and solo-crew creation still works -- this is a deliberate, discussed choice, not a regression');
  // The focus fix above (correctly) lands back on the Activity sub-tab -- switch back to Crews to
  // reopen "+ New crew".
  await page.click('button:has-text("Crews")');
  await page.waitForSelector('span.he-cta:has-text("Create a crew")', { timeout: 8000 });
  await page.click('span.he-cta:has-text("Create a crew")');
  await page.waitForSelector('.sheet-head:has-text("New crew")', { timeout: 8000 });
  const createBtn = page.locator('.sheet button.blue:has-text("Create crew")');
  ok(!(await createBtn.isDisabled()), '"Create crew" is not disabled just because the member list is empty');
  await page.fill('#crewNameInput', 'Solo Squad');
  const [createResp] = await Promise.all([
    page.waitForResponse(r => r.url().endsWith('/api/crews') && r.request().method() === 'POST'),
    createBtn.click(),
  ]);
  const created = await createResp.json();
  ok(!created.error && created.members && created.members.length === 1, `a solo crew (owner only) is genuinely created with no error, got ${JSON.stringify(created)}`);
  await page.waitForSelector('.crew-row:has-text("Solo Squad")', { timeout: 8000 });
  ok(true, '"Solo Squad" shows up in Your Crews right after creating it');
}

console.log('\ncold-review catch: opening the SAME empty state from crewView\'s "Edit" button (a');
console.log('third, different entry point -- e.g. reached from a notification deep link, with no');
console.log('Friends-tab render underneath at all) must not crash when the CTA is tapped');
{
  await page.click('.crew-row:has-text("Solo Squad")');
  await page.waitForSelector('.pp-head h1:has-text("Solo Squad")', { timeout: 8000 });
  await page.click('.pp-head button:has-text("Edit")');
  await page.waitForSelector('.sheet-head:has-text("Edit crew")', { timeout: 8000 });
  await page.waitForTimeout(200);
  const emptyOnEdit = await page.evaluate(() => !!document.querySelector('.sheet .home-empty .he-cta'));
  ok(emptyOnEdit, 'the same empty-state CTA renders here too (alice still has zero connections)');

  // The real bug: document.getElementById('fu') was null on this page (crewView, not friends()),
  // so .focus() threw -- an uncaught pageerror, sheet closed, nothing else happened. Confirm it's
  // silent/clean now AND that it actually lands somewhere useful (Friends tab, #fu focused).
  await page.click('.sheet .home-empty .he-cta');
  await page.waitForTimeout(500);
  const afterEditCta = await page.evaluate(() => ({
    onFriendsTab: !!document.getElementById('fu'),
    focusedId: document.activeElement && document.activeElement.id,
  }));
  ok(afterEditCta.onFriendsTab, 'tapping the CTA from crewView navigates to the real Friends tab instead of throwing');
  ok(afterEditCta.focusedId === 'fu', `...and focus still lands on the search box, got "${afterEditCta.focusedId}"`);
}

console.log('\nround-2 cold-review catch: navigating away WHILE focusConnectionsSearch\'s poll is');
console.log('still resolving must not steal focus back onto a screen the user already left');
{
  // The focus fix above (correctly) lands back on the Activity sub-tab -- switch back to Crews to
  // see the crew row.
  await page.click('button:has-text("Crews")');
  await page.waitForSelector('.crew-row:has-text("Solo Squad")', { timeout: 8000 });
  await page.click('.crew-row:has-text("Solo Squad")');
  await page.waitForSelector('.pp-head h1:has-text("Solo Squad")', { timeout: 8000 });
  await page.click('.pp-head button:has-text("Edit")');
  await page.waitForSelector('.sheet-head:has-text("Edit crew")', { timeout: 8000 });
  await page.waitForTimeout(200);
  // #fu is NOT on screen here (this is crewView, not friends()) -- tapping this CTA is the one
  // path that actually starts the showTab('friends') + poll, unlike the friends()-opened sheets
  // where #fu already exists and the poll never runs at all.
  await page.click('.sheet .home-empty .he-cta');
  // Immediately, before friends()'s own fetch can plausibly resolve, jump to a different tab --
  // this is exactly the race the fix's UI_EPOCH guard exists for.
  await page.click('[data-tab="home"]');
  await page.waitForTimeout(900); // longer than the poll's full ~666ms (40 rAF frames) window
  const afterRace = await page.evaluate(() => ({
    focusedId: document.activeElement && document.activeElement.id,
    activeNavTab: document.querySelector('.nav button.active') && document.querySelector('.nav button.active').dataset.tab,
  }));
  ok(afterRace.focusedId !== 'fu', `focus was NOT stolen back onto the Friends search box after navigating away, got focused="${afterRace.focusedId}"`);
  ok(afterRace.activeNavTab === 'home', `the nav still correctly shows Home as active, not reverted to Friends, got "${afterRace.activeNavTab}"`);
}

console.log('\nregression check: once there IS a connection, the real boxed member-picker list still renders exactly as before');
{
  // Both test accounts are freshly registered, so profileVisibility is unset -- which counts as
  // Public (see /api/follow/:id's own comment) -- meaning this lands as an approved follower
  // immediately, no accept step needed. connectionsOf() (what /api/friends and the crew sheet's
  // member list both read from) is the followers/following union either direction, so this alone
  // is enough to make bob a real, pickable connection for alice.
  const followReq = await post(`/api/follow/${b.user.id}`, {}, a.token);
  if (followReq.error || followReq.status !== 'following') throw new Error('follow: ' + JSON.stringify(followReq));

  await page.click('[data-tab="friends"]');   // the race-condition check above left us on Home
  await page.waitForSelector('#fu', { timeout: 8000 });   // lands on Activity (FRIENDS_TAB unchanged since the last fix)
  await page.click('button:has-text("Crews")');
  await page.waitForSelector('.h1-row span.he-cta:has-text("New crew")', { timeout: 8000 });
  await page.click('.h1-row span.he-cta:has-text("New crew")');
  await page.waitForSelector('.sheet-head:has-text("New crew")', { timeout: 8000 });
  await page.waitForTimeout(300);
  const withFriend = await page.evaluate(() => {
    const list = document.getElementById('crewMemberList');
    return {
      cardExists: !!list,
      cardHasClass: !!(list && list.classList.contains('card')),
      rowCount: list ? list.querySelectorAll('input[type=checkbox]').length : 0,
      noEmptyState: !document.querySelector('.sheet .home-empty'),
    };
  });
  ok(withFriend.cardExists && withFriend.cardHasClass, 'once a connection exists, the boxed #crewMemberList card is back, unchanged');
  ok(withFriend.rowCount === 1, `exactly one real, tappable member row renders (Bob), got ${withFriend.rowCount}`);
  ok(withFriend.noEmptyState, 'the empty-state prompt is gone now that there is someone to add');
}

console.log('\npage errors across the whole flow:', errors.length ? errors : 'none');
ok(errors.length === 0, 'no console pageerrors anywhere in this flow');

await page.close();
await browser.close();
await cleanup();
console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
