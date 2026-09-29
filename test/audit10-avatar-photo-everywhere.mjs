// Sep 28 2026 (Jeff: "wherever there is an avatar it should show the person's profile picture
// also (if they have one)"). Auditing every avatar-rendering call site in app.js turned up two
// real gaps that were still on the pre-Sep-1 letter-only pattern, never brought along when
// avatarHtml()/personOf() shipped for comments and the Activity feed:
//
// 1. favChip (the "Who's in"/"Invited" chips on a live session's own page) only ever rendered a
//    colored initial, with no code path to a real photo at all -- nameCache only ever cached a
//    plain display-name string, never the {avatar} field.
// 2. loadChat (the LIVE in-session workout Chat box) was still using nameOf() + a hand-rolled
//    initial, unlike its sibling loadPostComments (a posted recap's Comments box), which got the
//    real-photo fix back on Sep 1.
//
// Both fixed in app.js by switching to the same personOf()+avatarHtml() pattern every other
// avatar site in the app already uses. This test uploads a real avatar for one user and confirms
// it renders as an <img>, not a letter circle, in both of these spots -- and that a user with NO
// avatar set still correctly falls back to their initial (the fallback path must keep working).
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

const testDb = await freshTestDb('audit10avatar');
function boot(port, dir) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    srv.stdout.on('data', d => { if (String(d).includes('CrewFit on')) res(srv); });
    setTimeout(() => res(null), 15000);
  });
}
const PORT = 4994, BASE = `http://localhost:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), 'audit10avatar-'));
const srv = await boot(PORT, dir);
if (!srv) { console.log('FAIL server did not boot'); process.exit(1); }
async function cleanup() { try { srv.kill(); } catch {} try { await testDb.drop(); } catch {} }
process.on('uncaughtException', async (e) => { console.error('UNCAUGHT', e); await cleanup(); process.exit(1); });
process.on('unhandledRejection', async (e) => { console.error('UNHANDLED', e); await cleanup(); process.exit(1); });

async function api(path, method, token, body) {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
}
async function reg(username, displayName) {
  const r = await api('/api/register', 'POST', null, { username, pin: '12345678', displayName });
  return { token: r.token, id: r.user.id, username };
}
// 1x1 transparent PNG, smallest valid image the /api/me/avatar upload route accepts.
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const browser = await chromium.launch(LAUNCH_OPTS);
const errors = [];
async function loginAs(page, token) {
  await page.goto(BASE + '/');
  await page.evaluate((tok) => localStorage.setItem('crewfit_token', tok), token);
  await page.reload();
  await page.waitForSelector('.nav', { timeout: 10000 });
}

// Bailey uploads a real avatar photo; Casey never sets one -- the fallback initial path must
// still work for them, side by side with Bailey's real photo in the exact same UI. Avery (no
// avatar either) is the session creator/viewer -- favChip deliberately excludes the viewer's own
// row from "Who's in" (it's a list of who ELSE is in the workout), so Casey is the one who proves
// the no-photo fallback still renders correctly, not Avery.
const bailey = await reg('a10bailey', 'Bailey');
const casey = await reg('a10casey', 'Casey');
const avery = await reg('a10avery', 'Avery');
const upload = await api('/api/me/avatar', 'POST', bailey.token, { data: TINY_PNG, type: 'image/png' });
ok(!!(upload && upload.avatar), `Bailey's avatar upload succeeded (got: ${JSON.stringify(upload)})`);

// Inviting by username only works for someone already "connected" (an approved follow either
// direction) -- see POST /api/sessions in server.js. Both directions, same as feed-freshness.mjs.
for (const other of [bailey, casey]) {
  await api('/api/follow/' + avery.id, 'POST', other.token);
  await api('/api/follow/' + other.id, 'POST', avery.token);
}

const sess = await api('/api/sessions', 'POST', avery.token, { name: 'Push Day', scheduledAt: new Date().toISOString(), visibility: 'public', exercises: [{ name: 'Bench Press' }], inviteUsernames: ['a10bailey', 'a10casey'] });
await api(`/api/sessions/${sess.id}/accept`, 'POST', bailey.token);
await api(`/api/sessions/${sess.id}/accept`, 'POST', casey.token);
await api(`/api/sessions/${sess.id}/comments`, 'POST', bailey.token, { text: 'On my way!' });

const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
page.on('pageerror', e => errors.push(String(e)));
await loginAs(page, avery.token);   // Avery (no avatar) views the session -- sees Bailey's real photo, their own initial
await page.evaluate((id) => window.openSession(id), sess.id);
await page.waitForSelector('.fav', { timeout: 8000 });
await page.waitForTimeout(300);   // loadChat's own personOf() round-trip

console.log('"Who\'s in" chip: a participant WITH a real avatar renders it as a photo, not a letter circle');
{
  const chip = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.fav'));
    const row = rows.find(r => r.textContent.includes('Bailey'));
    if (!row) return null;
    const img = row.querySelector('img.fav-av');
    const div = row.querySelector('div.fav-av');
    return { hasImg: !!img, imgSrc: img ? img.getAttribute('src') : null, hasLetterDiv: !!div };
  });
  ok(!!chip, 'found Bailey\'s "Who\'s in" chip');
  ok(chip && chip.hasImg, `Bailey's chip renders as a real <img>, not a letter circle (got: ${JSON.stringify(chip)})`);
  ok(chip && /\/uploads\//.test(chip.imgSrc || ''), `and it points at the real uploaded photo (got: ${chip && chip.imgSrc})`);
}

console.log('\nLive workout Chat: the same participant\'s message shows their real avatar photo too');
{
  const row = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('#chatbox .cmt'));
    const r = rows.find(x => x.textContent.includes('On my way!'));
    if (!r) return null;
    const img = r.querySelector('img.fav-av');
    return { found: true, hasImg: !!img, imgSrc: img ? img.getAttribute('src') : null };
  });
  ok(!!row, 'found Bailey\'s chat message row');
  ok(row && row.hasImg, `the chat row renders Bailey's real photo as an <img>, not a letter circle (got: ${JSON.stringify(row)})`);
}

console.log('\nA participant with NO avatar set still correctly falls back to their initial (both spots)');
{
  // Casey never uploaded a photo -- their chip must stay a letter circle, not a broken/missing
  // image, sitting right next to Bailey's real photo in the same "Who's in" list.
  const chip = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.fav'));
    const row = rows.find(r => r.textContent.includes('Casey'));
    if (!row) return null;
    const div = row.querySelector('div.fav-av');
    const img = row.querySelector('img.fav-av');
    return { hasLetterDiv: !!div, hasImg: !!img, text: div ? div.textContent.trim() : null };
  });
  ok(!!chip, "found Casey's \"Who's in\" chip");
  ok(chip && chip.hasLetterDiv && !chip.hasImg, `Casey (no photo) still renders a letter circle, not a broken image (got: ${JSON.stringify(chip)})`);
}

console.log(errors.length ? '\nPAGE ERRORS:\n' + errors.join('\n') : '\nno page errors');
await page.close();
await browser.close();
await cleanup();
console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails || errors.length ? 1 : 0);
