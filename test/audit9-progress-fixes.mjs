// Sep 28 2026 -- Jeff's second-pass audit after the Sep 28 Progress/Trends deploy: a much deeper
// stress test (a full 2-exercise workout, warm-up set, RIR, kg switch), 18 findings. This file
// locks in the fixes that were safe to build without a product decision (see the accompanying
// chat summary for the ones that genuinely needed Jeff's pick first -- PR record model, Strength
// Trend baseline, RIR-set coaching behavior, rest timer on warm-ups, set-type picker reset, feed
// card design).
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const J = { 'Content-Type': 'application/json' };
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('audit9fixes');

function boot(port, dir) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    srv.stdout.on('data', d => { if (String(d).includes('CrewFit on')) res(srv); });
    srv.on('exit', () => res(null));
    setTimeout(() => res(srv), 15000);
  });
}
const DIR = mkdtempSync(join(tmpdir(), 'audit9fixes-'));
const PORT = 4996, B = `http://localhost:${PORT}`;
const srv = await boot(PORT, DIR);
ok(!!srv, 'server boots');
async function cleanup() { try { if (srv) srv.kill(); } catch {} try { await testDb.drop(); } catch {} }
process.on('uncaughtException', async (e) => { console.error('UNCAUGHT', e); await cleanup(); process.exit(1); });
process.on('unhandledRejection', async (e) => { console.error('UNHANDLED', e); await cleanup(); process.exit(1); });

const post = (p, b, tok) => fetch(B + p, { method: 'POST', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b) }).then(r => r.json());
const get = (p, tok) => fetch(B + p, { headers: tok ? { Authorization: 'Bearer ' + tok } : {} }).then(r => r.json());
const reg = (username, pin, displayName) => post('/api/register', { username, pin, displayName });

console.log('/api/exercises: a custom exercise is tagged "mine" only for its own creator, never for anyone else viewing the same shared library');
{
  const u1 = await reg('a9_owner', 'pass1234', 'Owner');
  const u2 = await reg('a9_other', 'pass1234', 'Other');
  const created = await post('/api/exercises/custom', { name: 'A9 Test Lift', muscle_groups: ['chest'], equipment: ['barbell'] }, u1.token);
  ok(!created.error, `custom exercise creates (got ${created.error})`);

  const asOwner = await get('/api/exercises', u1.token);
  const mineRow = asOwner.find(e => e.name === 'A9 Test Lift');
  ok(!!mineRow, 'the owner sees their own custom exercise in the library');
  ok(mineRow.mine === true, `and it is tagged mine:true for its own creator (got ${mineRow.mine})`);
  ok(mineRow.ownerId === undefined, 'the real ownerId is never sent to the client (still stripped)');

  const asOther = await get('/api/exercises', u2.token);
  const otherRow = asOther.find(e => e.name === 'A9 Test Lift');
  ok(!!otherRow, `another user still sees it too -- custom exercises are shared library-wide by design (got ${JSON.stringify(otherRow)})`);
  ok(otherRow.mine === false, `but it is NOT tagged mine for anyone else -- this is Jeff's "Assisted Pull-up tagged 'your exercise' on an account that never made it" bug (got ${otherRow.mine})`);

  const loggedOut = await get('/api/exercises');
  const guestRow = loggedOut.find(e => e.name === 'A9 Test Lift');
  ok(guestRow && guestRow.mine === false, `a logged-out request still works (no auth required) and reads mine:false (got ${JSON.stringify(guestRow)})`);
}

console.log('\na first-ever log of a lift is stamped firstLog so celebratory surfaces can exclude it, same rule groupPrsForFeed already applied to the Activity feed');
{
  const u = await reg('a9_firstlog', 'pass1234', 'First Log');
  const s1 = await post('/api/sessions', { name: 'Push', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Barbell Row' }], visibility: 'private' }, u.token);
  const ex1 = s1.exercises[0].id;
  const r1 = await post(`/api/sessions/${s1.id}/log`, { exerciseId: ex1, weight: 95, reps: 8, setType: 'normal' }, u.token);
  const entry1 = (r1.logs && r1.logs[Object.keys(r1.logs)[0]] || []).find(l => l.exerciseId === ex1);
  ok(!!entry1, 'first log recorded');
  ok(entry1.isPr === true, `the very first log is still the current record-holder, isPr true (got ${entry1.isPr}) -- this stays true, it's still shown as the best on Records/profile`);
  ok(entry1.firstLog === true, `but it is now stamped firstLog:true so a celebratory surface can skip it, matching Jeff's "a first-ever log of a lift shouldn't be a PR anywhere" (got ${entry1.firstLog})`);

  // A second, later session beats it -- the ORIGINAL first log is no longer the record-holder,
  // so isPr flips to false on it; the NEW winner is not the account's first-ever log at all, so
  // its own firstLog is correctly false.
  const s2 = await post('/api/sessions', { name: 'Push', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Barbell Row' }], visibility: 'private' }, u.token);
  const ex2 = s2.exercises[0].id;
  const r2 = await post(`/api/sessions/${s2.id}/log`, { exerciseId: ex2, weight: 105, reps: 6, setType: 'normal' }, u.token);
  const uid = Object.keys(r2.logs)[0];
  const entry2 = r2.logs[uid].find(l => l.exerciseId === ex2);
  ok(entry2.isPr === true && entry2.firstLog === false, `the real, genuine PR is isPr true / firstLog false (got isPr=${entry2.isPr}, firstLog=${entry2.firstLog})`);
}

console.log('\nworkout timestamps: PR/records use the real finish moment (or the recap post time, if posted), not the session\'s scheduledAt (start)');
{
  const u = await reg('a9_ts', 'pass1234', 'Timestamps');
  // Scheduled well in the past (a different minute entirely) so a leftover scheduledAt-based
  // timestamp is unmistakably wrong if it leaks through.
  const scheduledAt = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
  const s = await post('/api/sessions', { name: 'Pull', scheduledAt, exercises: [{ name: 'Lat Pulldown' }], visibility: 'private' }, u.token);
  const exId = s.exercises[0].id;
  await post(`/api/sessions/${s.id}/log`, { exerciseId: exId, weight: 120, reps: 10, setType: 'normal' }, u.token);
  const today = new Date().toISOString().slice(0, 10);
  const beforeLock = Date.now();
  const lockRes = await post(`/api/sessions/${s.id}/lock`, { localDate: today }, u.token);
  ok(!lockRes.error, `session locks (got ${lockRes.error})`);
  const afterLock = Date.now();

  const rec1 = await get('/api/progress/exercise/' + encodeURIComponent('Lat Pulldown'), u.token);
  ok(!!rec1.pr, 'a PR record exists after finishing (not posting)');
  const prAtMs = new Date(rec1.pr.at).getTime();
  ok(prAtMs >= beforeLock - 2000 && prAtMs <= afterLock + 2000,
    `finished-but-not-posted: the PR's own .at is the real /lock finish moment, not the 3-day-old scheduledAt (got ${rec1.pr.at}, expected within a couple seconds of ${new Date(beforeLock).toISOString()})`);

  // Now post a recap -- the PR's .at should move to match the recap's own timestamp, same field
  // Profile's "Your Workouts" list already reads (post.at), so every surface agrees again.
  const postRes = await post(`/api/sessions/${s.id}/post`, { notes: 'test', visibility: 'private' }, u.token);
  ok(!postRes.error, `recap posts (got ${postRes.error})`);
  const postAt = postRes.posts && postRes.posts[Object.keys(postRes.posts)[0]] && postRes.posts[Object.keys(postRes.posts)[0]].at;
  ok(!!postAt, 'the post has its own .at timestamp');
  const rec2 = await get('/api/progress/exercise/' + encodeURIComponent('Lat Pulldown'), u.token);
  ok(rec2.pr.at === postAt, `once posted, the PR's .at matches the recap post's own timestamp exactly, the same field Profile's "Your Workouts" list reads (got ${rec2.pr.at}, expected ${postAt})`);
}

console.log('\nfirstLog is stable once earned -- a real PR does not retroactively become "first-ever" (and lose its badge) just because an OLDER, still-open session gets locked/finished late');
{
  // Cold-review catch: rebuildAllPrs() sorts `chronological` by `_performedAt`, which prefers a
  // session's finish/post time -- so before this fix, locking an old session long after it was
  // actually logged could jump that session's _performedAt past a genuinely later PR's, flipping
  // `chronological[0]` and silently marking the later, real PR as firstLog:true. firstLog/setFirstLog
  // now key off `l.at` (stamped once, at the moment that specific set was logged, never rewritten by
  // a later /lock or /unlock) instead, which this locks in.
  const u = await reg('a9_stable', 'pass1234', 'Stable');
  // Session A: the true first-ever log of this exercise for this user. Left open -- not locked.
  const sA = await post('/api/sessions', { name: 'Legs A', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Deadlift' }], visibility: 'private' }, u.token);
  const exA = sA.exercises[0].id;
  await post(`/api/sessions/${sA.id}/log`, { exerciseId: exA, weight: 100, reps: 5, setType: 'normal' }, u.token);

  // Session B: logged and finished AFTER A's log -- a real, non-first PR (heavier than A's 100).
  const sB = await post('/api/sessions', { name: 'Legs B', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Deadlift' }], visibility: 'private' }, u.token);
  const exB = sB.exercises[0].id;
  const rB = await post(`/api/sessions/${sB.id}/log`, { exerciseId: exB, weight: 110, reps: 5, setType: 'normal' }, u.token);
  const uid = Object.keys(rB.logs)[0];
  const entryB = rB.logs[uid].find(l => l.exerciseId === exB);
  ok(entryB.isPr === true && entryB.firstLog === false, `B's 110 correctly beats A's still-open 100 and is NOT flagged first-ever (got isPr=${entryB.isPr}, firstLog=${entryB.firstLog})`);
  const today = new Date().toISOString().slice(0, 10);
  await post(`/api/sessions/${sB.id}/lock`, { localDate: today }, u.token);
  await post(`/api/sessions/${sB.id}/post`, { notes: '', visibility: 'private' }, u.token);
  // Read firstLog the same way the client actually does -- straight off the log entry in the
  // session object (exSetRowsHtml/setRows/the finish recap all read l.firstLog directly), not off
  // GET /api/progress/exercise/:name's `pr` object, which never forwards this field at all.
  const readEntryB = async () => {
    const sess = await get(`/api/sessions/${sB.id}`, u.token);
    return sess.logs[uid].find(l => l.exerciseId === exB);
  };
  const before = await readEntryB();
  ok(before.firstLog === false, `still correctly not first-ever right after B posts (got ${before.firstLog})`);

  // Now lock the OLD session (A), long after it was actually logged -- simulating someone finally
  // finishing a workout they left open for days. This reruns rebuildAllPrs().
  await post(`/api/sessions/${sA.id}/lock`, { localDate: today }, u.token);
  const after = await readEntryB();
  ok(after.firstLog === false, `locking the older, unrelated session late does NOT retroactively flip B's already-earned PR to firstLog:true (got ${after.firstLog}) -- this is the exact false-negative badge-suppression bug the cold-review caught`);
}

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
await cleanup();
process.exit(fails ? 1 : 0);
