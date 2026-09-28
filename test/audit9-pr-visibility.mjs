// Sep 28 2026 -- Jeff's second-pass audit, "PR definition inconsistent" cluster: (1) a genuine
// best-VOLUME set (e.g. 40 lb x 15) looked like it "vanished from Records" once a heavier-but-
// lower-volume set (45 lb x 12) took the weight-record slot, and (2) Home's "N PRs this week"
// undercounted because it only ever counted the current weight-record pool, excluding both
// volume-records and first-ever lifts entirely. Rather than build a whole new PR-history data
// model, the fix surfaces what was already tracked server-side (see setPrLabel's own comment in
// app.js): the Records list now shows a "Best set: ..." caption whenever the volume record is a
// genuinely different set than the weight record, and the weekly count now includes both event
// types plus first-ever lifts. Real server + real Postgres + real Chromium (Playwright), the same
// technique test/_audit9_shots.mjs used, promoted to the permanent suite since this touches PRs.
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

const testDb = await freshTestDb('audit9prvis');
function boot(port, dir) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    srv.stdout.on('data', d => { if (String(d).includes('CrewFit on')) res(srv); });
    setTimeout(() => res(null), 15000);
  });
}
const PORT = 4997, BASE = `http://localhost:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), 'audit9prvis-'));
const srv = await boot(PORT, dir);
if (!srv) { console.log('FAIL server did not boot'); process.exit(1); }
async function cleanup() { try { srv.kill(); } catch {} try { await testDb.drop(); } catch {} }
process.on('uncaughtException', async (e) => { console.error('UNCAUGHT', e); await cleanup(); process.exit(1); });
process.on('unhandledRejection', async (e) => { console.error('UNHANDLED', e); await cleanup(); process.exit(1); });

async function api(path, method, token, body) {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
}
const reg = (u) => api('/api/register', 'POST', null, { username: u + Math.random().toString(36).slice(2, 8), pin: '123456', displayName: u });

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

const u = await reg('A9PrVis');
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
page.on('pageerror', e => errors.push(String(e)));

// Session 1: Cable Fly 40x15 -- higher VOLUME (600) than the later 45x12 (540), even though it's
// a lighter weight. Locked+posted so it counts as a finished, dated workout.
await loginAs(page, u.token);
const s1 = await api('/api/sessions', 'POST', u.token, { name: 'Push A', scheduledAt: new Date().toISOString(), visibility: 'private', exercises: [{ name: 'Cable Fly' }] });
await page.evaluate((id) => window.openSession(id), s1.id);
await page.waitForSelector('.ex-log', { timeout: 8000 });
await logNormal(page, s1.exercises[0].id, 40, 15);
const today = new Date().toISOString().slice(0, 10);
await api(`/api/sessions/${s1.id}/lock`, 'POST', u.token, { localDate: today });
await api(`/api/sessions/${s1.id}/post`, 'POST', u.token, { notes: '', visibility: 'private' });

// Session 2: Cable Fly 45x12 -- heavier, becomes the new WEIGHT record, but does NOT beat 40x15
// on volume (540 < 600), so 40x15 should still be the standing volume record.
const s2 = await api('/api/sessions', 'POST', u.token, { name: 'Push B', scheduledAt: new Date().toISOString(), visibility: 'private', exercises: [{ name: 'Cable Fly' }] });
await page.evaluate((id) => window.openSession(id), s2.id);
await page.waitForSelector('.ex-log', { timeout: 8000 });
await logNormal(page, s2.exercises[0].id, 45, 12);
await api(`/api/sessions/${s2.id}/lock`, 'POST', u.token, { localDate: today });
await api(`/api/sessions/${s2.id}/post`, 'POST', u.token, { notes: '', visibility: 'private' });

// Session 3: Barbell Row 95x8 -- a first-ever log (no live PR badge, per the earlier audit9 fix),
// but still a real thing that happened this week.
const s3 = await api('/api/sessions', 'POST', u.token, { name: 'Push C', scheduledAt: new Date().toISOString(), visibility: 'private', exercises: [{ name: 'Barbell Row' }] });
await page.evaluate((id) => window.openSession(id), s3.id);
await page.waitForSelector('.ex-log', { timeout: 8000 });
await logNormal(page, s3.exercises[0].id, 95, 8);
await api(`/api/sessions/${s3.id}/lock`, 'POST', u.token, { localDate: today });
await api(`/api/sessions/${s3.id}/post`, 'POST', u.token, { notes: '', visibility: 'private' });

console.log('Records list: a genuine volume record survives being shown even after a heavier set takes the weight-record slot');
{
  await page.evaluate(() => window.showTab('progress'));
  await page.waitForTimeout(300);
  await page.evaluate(() => window.progressScreen && window.progressScreen());
  await page.waitForTimeout(300);
  // Personal records lives under Progress's own "Records" sub-tab (PROG_TAB), not the default "Now".
  await page.evaluate(() => window.setProgTab && window.setProgTab('records'));
  await page.waitForTimeout(300);
  const text = await page.evaluate(() => document.getElementById('app').innerText);
  ok(text.includes('45 lb × 12'), `the weight record (45 lb x 12) is the headline number (got innerText snippet: ${text.includes('45 lb') ? 'found' : 'NOT found'})`);
  ok(text.includes('Best set: 40 lb × 15'), `Sep 23-equivalent 40 lb x 15 still shows, as the "Best set" caption, instead of having vanished (got: ${text.match(/Best set:[^\n]*/)?.[0] || 'no "Best set" caption found'})`);
}

console.log('\nHome: "N PRs this week" counts the volume record and the first-ever lift too, not just the current weight-record pool');
{
  await page.evaluate(() => window.showTab('home'));
  await page.waitForTimeout(300);
  await page.evaluate(() => window.home && window.home());
  await page.waitForTimeout(400);
  const text = await page.evaluate(() => document.getElementById('app').innerText);
  const m = text.match(/(\d+)\s*PRs? this week/);
  ok(!!m, `Home shows a "PRs this week" stat at all (got: ${JSON.stringify(text.match(/.{0,20}PRs? this week/)?.[0])})`);
  // 3 distinct events this week: Cable Fly's weight record (45x12), Cable Fly's volume record
  // (40x15, a different set), and Barbell Row's first-ever weight record (95x8).
  ok(m && Number(m[1]) === 3, `counts all 3 real events this week -- the weight PR, the separate volume PR, and the first-ever lift (got ${m && m[1]})`);
}

console.log(errors.length ? '\nPAGE ERRORS:\n' + errors.join('\n') : '\nno page errors');
await page.close();
await browser.close();
await cleanup();
console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails || errors.length ? 1 : 0);
