// Sep 18 2026 -- see swipeRowWrap's own comment in app.js for the full feature (Home's swipe-to-
// delete). This is the 'hide-joinable' branch's server side: a friend's joinable workout on
// "Friends' Workouts" isn't yours to delete (you were never in it), so swiping it there can only
// mean "stop showing ME this" -- POST /api/sessions/:id/hide-joinable, same shape as the existing
// POST /api/templates/:id/hide for a friend's shared routine (see server.js's own comment on the
// route for why). Verifies: it hides the workout from the hider's own joinable list only, leaves
// it untouched for every other friend and for the creator; the session's own data (participants,
// name, etc.) is never modified; it's idempotent; a garbage session id 404s; and auth is required.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const J = { 'Content-Type': 'application/json' };
const ROOT = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('hidejoinable');

function boot(port, dir) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port) }, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; srv.stdout.on('data', d => { out += d; if (String(d).includes('CrewFit on')) res({ srv, out }); });
    srv.on('exit', () => res({ srv: null, out }));
    setTimeout(() => res({ srv, out }), 15000);
  });
}

const DIR = mkdtempSync(join(tmpdir(), 'hidejoinable-'));
const PORT = 4996, B = `http://localhost:${PORT}`;
const { srv } = await boot(PORT, DIR);
ok(!!srv, 'server boots');

const post = (p, b, tok) => fetch(B + p, { method: 'POST', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b) }).then(r => r.json());
const get = (p, tok) => fetch(B + p, { headers: tok ? { Authorization: 'Bearer ' + tok } : {} }).then(r => r.json());
const reg = (username, pin, displayName) => post('/api/register', { username, pin, displayName });

// No follow/friend setup needed: canSeeProfile() (server.js) admits ANY viewer to a Public
// profile (the registration default), so a 'public'-visibility session already reaches 'friend'
// tier in sessionTier() for any other registered user -- the same "whoever can see the creator's
// profile" rule Home's real joinable list runs on (v190, see sessionTier's own comment).

console.log('hiding a friend\'s joinable workout removes it from just the hider\'s own list');
{
  const creator = await reg('hidej_creator', 'pass1234', 'Creator');
  const viewer1 = await reg('hidej_viewer1', 'pass1234', 'Viewer One');
  const viewer2 = await reg('hidej_viewer2', 'pass1234', 'Viewer Two');

  const s = await post('/api/sessions', { name: 'Leg Day', scheduledAt: new Date(Date.now() - 86400000).toISOString(), exercises: [{ name: 'Barbell Back Squat' }], visibility: 'public' }, creator.token);

  const before1 = await get('/api/sessions', viewer1.token);
  const beforeRow1 = before1.find(x => x.id === s.id);
  ok(!!beforeRow1 && beforeRow1.hiddenForMe === false, `before hiding, viewer1 sees hiddenForMe:false (got ${JSON.stringify(beforeRow1 && beforeRow1.hiddenForMe)})`);

  const r = await post(`/api/sessions/${s.id}/hide-joinable`, {}, viewer1.token);
  ok(r && r.ok === true, `hide-joinable succeeds (got ${JSON.stringify(r)})`);

  const after1 = await get('/api/sessions', viewer1.token);
  const afterRow1 = after1.find(x => x.id === s.id);
  ok(afterRow1 && afterRow1.hiddenForMe === true, `viewer1 now sees hiddenForMe:true on a fresh re-fetch (got ${JSON.stringify(afterRow1 && afterRow1.hiddenForMe)})`);

  const after2 = await get('/api/sessions', viewer2.token);
  const afterRow2 = after2.find(x => x.id === s.id);
  ok(afterRow2 && afterRow2.hiddenForMe === false, `viewer2 -- who never hid it -- still sees hiddenForMe:false, completely unaffected (got ${JSON.stringify(afterRow2 && afterRow2.hiddenForMe)})`);

  const creatorView = await get('/api/sessions', creator.token);
  const creatorRow = creatorView.find(x => x.id === s.id);
  ok(creatorRow && creatorRow.name === 'Leg Day' && Array.isArray(creatorRow.participants), `the creator's own view of the session is completely untouched -- still their real data (got ${JSON.stringify(creatorRow && creatorRow.name)})`);
}

console.log('idempotent: hiding twice is not an error and does not duplicate');
{
  const creator = await reg('hidej_creator2', 'pass1234', 'Creator Two');
  const viewer = await reg('hidej_viewer3', 'pass1234', 'Viewer Three');
  const s = await post('/api/sessions', { name: 'Push Day', scheduledAt: new Date(Date.now() - 86400000).toISOString(), exercises: [{ name: 'Bench Press' }], visibility: 'public' }, creator.token);

  const r1 = await post(`/api/sessions/${s.id}/hide-joinable`, {}, viewer.token);
  const r2 = await post(`/api/sessions/${s.id}/hide-joinable`, {}, viewer.token);
  ok(r1 && r1.ok === true && r2 && r2.ok === true, `hiding the same workout twice is {ok:true} both times, no error (got ${JSON.stringify([r1, r2])})`);

  const after = await get('/api/sessions', viewer.token);
  const afterRow = after.find(x => x.id === s.id);
  ok(afterRow && afterRow.hiddenForMe === true, `still just hidden, not double-hidden or broken (got ${JSON.stringify(afterRow && afterRow.hiddenForMe)})`);
}

console.log('a garbage session id 404s; auth is required');
{
  const viewer = await reg('hidej_viewer4', 'pass1234', 'Viewer Four');
  const bad = await post('/api/sessions/not-a-real-id/hide-joinable', {}, viewer.token);
  ok(!!bad.error, `unknown session id is rejected (got ${JSON.stringify(bad)})`);

  const noAuth = await post('/api/sessions/also-fake/hide-joinable', {}, null);
  ok(!!noAuth.error, `unauthenticated POST is refused (got ${JSON.stringify(noAuth)})`);
}

// Cold-review catch (Sep 18 2026, round 3): the auth guard is `sessionTier(s, req.userId) ===
// 'friend'` -- the only tier this route is meant for is "can see it as joinable but isn't in it".
// A creator/participant resolves to 'member' first (sessionTier checks that before 'friend'), so
// the guard should refuse them even though they CAN see the session -- this route only makes sense
// for someone dismissing it from a list they're not actually in. Neither of these two cases were
// covered by the tests above.
console.log('a creator (or any current participant) cannot hide-joinable their own session -- they were never on the joinable list to begin with');
{
  const creator = await reg('hidej_creator3', 'pass1234', 'Creator Three');
  const s = await post('/api/sessions', { name: 'Own Session', scheduledAt: new Date(Date.now() - 86400000).toISOString(), exercises: [{ name: 'Deadlift' }], visibility: 'public' }, creator.token);
  const r = await post(`/api/sessions/${s.id}/hide-joinable`, {}, creator.token);
  ok(r && r.error, `the creator's own call is refused, not silently accepted (got ${JSON.stringify(r)})`);
  // hiddenForMe isn't even a field the creator's own (member-tier) view exposes -- see sessionView's
  // member branch, a plain Object.assign spread of the raw session with no computed hiddenForMe --
  // so "did it actually get hidden" is checked the way a real friend/viewer would see it: log in as
  // someone else who genuinely CAN see it as joinable and confirm it's still there, untouched.
  const otherViewer = await reg('hidej_viewer6', 'pass1234', 'Viewer Six');
  const otherView = await get('/api/sessions', otherViewer.token);
  const otherRow = otherView.find(x => x.id === s.id);
  ok(otherRow && otherRow.hiddenForMe === false, `a real joinable-tier viewer still sees it, unhidden -- the guard actually blocked the write (got ${JSON.stringify(otherRow && otherRow.hiddenForMe)})`);
}

console.log('a PRIVATE session never reaches \'friend\' tier at all -- hide-joinable refuses it even for someone who could otherwise see the creator\'s profile');
{
  const creator = await reg('hidej_creator4', 'pass1234', 'Creator Four');
  const viewer = await reg('hidej_viewer5', 'pass1234', 'Viewer Five');
  const s = await post('/api/sessions', { name: 'Private Session', scheduledAt: new Date(Date.now() - 86400000).toISOString(), exercises: [{ name: 'Row' }], visibility: 'private' }, creator.token);
  const r = await post(`/api/sessions/${s.id}/hide-joinable`, {}, viewer.token);
  ok(r && r.error, `a private session's hide-joinable call is refused (got ${JSON.stringify(r)})`);
}

srv.kill();
await testDb.drop();
console.log(fails === 0 ? '\nall assertions passed' : `\n${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
