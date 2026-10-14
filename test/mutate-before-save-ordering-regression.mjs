// Oct 14 2026 (Jeff: "I think we should also resolve the issue you flagged but are not fixing on
// the pre existing issue" -- following up on the push subs/custom exercises/reports slice, see
// CLAUDE.md "Rearchitecture status"). The issue: POST/PUT/DELETE /api/exercises/custom and POST
// /api/report's optional blockUser() all used to mutate DB (an in-memory object) BEFORE calling
// `await save(DB)`, which can fail. Same bug class as the emitFeedEvent finding from the slice
// before this one -- disclosed then as a known, pre-existing, out-of-scope issue; now fixed.
//
// What a save(DB) failure actually did, confirmed live BEFORE this fix (not assumed): this app
// already wraps every route handler in an async-error forwarder (see the comment on `app[method]
// = ...` near the top of server.js), so a thrown error here was ALREADY turned into a real 500 --
// it never crashed the whole server and never left the request hanging. The actual bug was
// narrower but still real: the in-memory mutation survived anyway, because nothing reverted it on
// the failure path. DB.customExercises and DB.users are shared, process-wide state read by every
// other request, so:
//   - a "failed" custom-exercise CREATE became a real exercise, served to every other user via
//     GET /api/exercises, permanently burning one of this user's 500 slots, until next restart;
//   - a "failed" custom-exercise EDIT silently kept the new (unsaved) field values live in memory;
//   - a "failed" custom-exercise DELETE silently stayed deleted in memory (findMyCustomExercise
//     could no longer find it, even though Postgres never actually dropped the row);
//   - a "failed" report-with-block kept the block/unfollow effect live (visible to every other
//     request reading DB.users) even though the report's own `alsoBlock` effect was supposed to
//     have failed along with the save.
// This test proves each of the four fixes: rig a real Postgres failure for the ONE write each
// route depends on, confirm the route still answers with an error, then confirm (via a second,
// independent read -- GET /api/exercises for the library-wide ones, a direct DB.users read via a
// companion route for the block one) that the in-memory state was reverted, not left stale.
//
// What this test does NOT attempt: reproducing the sharper concurrency hazard an independent
// reviewer caught in the first draft of this fix (restoring a whole stale pre-mutation snapshot
// could clobber a DIFFERENT, concurrent, already-SUCCEEDED request on the same user/pair --
// e.g. a concurrent create landing between this delete's mutation and its revert). The PUT/
// DELETE/report fixes below were rewritten to only undo exactly what THIS request itself changed
// (matching the create route's own always-correct id-filtered revert), verified by tracing
// db.js's enqueue()/doSave() (each queued save() reads DB's live content only at its own turn,
// not a snapshot from when save() was called) rather than by forcing the actual cross-request
// race over real HTTP/network timing here -- doing that reliably would need an artificial delay
// hook inside server.js itself, which isn't worth adding just for this. The simpler, single-
// request cases below ARE reproduced live, same as every other claim in this file.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';

const PORT = 5003, B = `http://localhost:${PORT}`;
const DIR = mkdtempSync(join(tmpdir(), 'mutate-before-save-'));
const J = { 'Content-Type': 'application/json' };
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('mutatebeforesave');
let srv, fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const H = t => ({ ...J, Authorization: 'Bearer ' + t });
const post = (p, b, t) => fetch(B + p, { method: 'POST', headers: t ? H(t) : J, body: JSON.stringify(b) });
const put = (p, b, t) => fetch(B + p, { method: 'PUT', headers: t ? H(t) : J, body: JSON.stringify(b) });
const del = (p, t) => fetch(B + p, { method: 'DELETE', headers: H(t) });
const get = (p, t) => fetch(B + p, { headers: t ? H(t) : J });
process.on('exit', () => { try { srv && srv.kill(); } catch {} try { rmSync(DIR, { recursive: true, force: true }); } catch {} });

function boot(port, dir, databaseUrl) {
  return new Promise(res => {
    const s = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: databaseUrl, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    s.stdout.on('data', d => { if (String(d).includes('CrewFit on')) res({ srv: s }); });
    s.stderr.on('data', d => process.stderr.write('[server] ' + d));
    s.on('exit', () => res({ srv: null }));
    setTimeout(() => res({ srv: s }), 8000);
  });
}

({ srv } = await boot(PORT, DIR, testDb.url));
ok(!!srv, 'server boots');

process.env.DATABASE_URL = testDb.url;
const { PgConnection, parseConnString } = await import('../pgmini.js');
// A second, independent raw connection to the SAME database the spawned server uses -- used to
// rig real failures (rename the table save(DB) needs mid-sync) without touching the server's own
// connection or any other table.
const raw = new PgConnection(parseConnString(testDb.url));
async function breakTable(name) { await raw.query(`ALTER TABLE ${name} RENAME TO ${name}_broken_for_test`); }
async function fixTable(name) { await raw.query(`ALTER TABLE ${name}_broken_for_test RENAME TO ${name}`); }

const alice = await post('/api/register', { username: 'mbs_alice', pin: 'pass1234', displayName: 'Alice' }).then(r => r.json());
const bob = await post('/api/register', { username: 'mbs_bob', pin: 'pass1234', displayName: 'Bob' }).then(r => r.json());

console.log('\nPOST /api/exercises/custom: a failed save(DB) does not leave a ghost exercise in memory');
{
  await breakTable('custom_exercises');
  const r = await post('/api/exercises/custom', { name: 'MBS Ghost Curl', muscle_groups: ['biceps'] }, alice.token);
  ok(r.status === 500, `create returns a real error while the table is broken, got ${r.status}`);
  await fixTable('custom_exercises');
  const health = await get('/healthz');
  ok(health.status === 200, 'server is still up after the rigged failure (the async-error wrapper, not a crash, handled it)');
  const lib = await get('/api/exercises').then(r => r.json());
  ok(!lib.some(e => e.name === 'MBS Ghost Curl'), 'the "failed" create is NOT present in the exercise library (in-memory push was reverted)');
}

console.log('\nPUT /api/exercises/custom/:id: a failed save(DB) reverts the edit, not just fails the response');
{
  const created = await post('/api/exercises/custom', { name: 'MBS Edit Target', muscle_groups: ['biceps'] }, alice.token).then(r => r.json());
  await breakTable('custom_exercises');
  const r = await put(`/api/exercises/custom/${created.id}`, { muscle_groups: ['triceps'], level: 'advanced' }, alice.token);
  ok(r.status === 500, `edit returns a real error while the table is broken, got ${r.status}`);
  await fixTable('custom_exercises');
  const lib = await get('/api/exercises').then(r => r.json());
  const row = lib.find(e => e.name === 'MBS Edit Target');
  ok(!!row, 'the exercise still exists after the failed edit');
  ok(row && row.muscle_groups.includes('biceps') && !row.muscle_groups.includes('triceps'), `the edit was reverted -- still shows the ORIGINAL muscle group, not the failed one, got ${JSON.stringify(row && row.muscle_groups)}`);
  ok(row && row.level === 'beginner', `level was also reverted to its original value, got ${row && row.level}`);
}

console.log('\nDELETE /api/exercises/custom/:id: a failed save(DB) un-deletes it, not just fails the response');
{
  const created = await post('/api/exercises/custom', { name: 'MBS Delete Target', muscle_groups: ['biceps'] }, alice.token).then(r => r.json());
  await breakTable('custom_exercises');
  const r = await del(`/api/exercises/custom/${created.id}`, alice.token);
  ok(r.status === 500, `delete returns a real error while the table is broken, got ${r.status}`);
  await fixTable('custom_exercises');
  const lib = await get('/api/exercises').then(r => r.json());
  ok(lib.some(e => e.name === 'MBS Delete Target'), 'the exercise is still present after the failed delete (in-memory filter was reverted)');
}

console.log('\nPOST /api/report (alsoBlock): a failed save(DB) reverts the block/unfollow, not just fails the response');
{
  // Alice follows Bob first (mutual follow needs Bob to accept, but a one-directional follow is
  // enough here -- blockUser() has something real to unwind either way), so blockUser() below has
  // a real entry in alice.following to remove, then (on revert) put back.
  await post(`/api/follow/${bob.user.id}`, {}, alice.token);
  const before = await get(`/api/profile/${alice.user.id}/following`, alice.token).then(r => r.json());
  ok(Array.isArray(before) && before.some(u => u.id === bob.user.id), `sanity: alice follows bob before the report, got ${JSON.stringify(before)}`);

  // syncTableDiff only issues a query against a table whose content actually changed since the
  // last save() baseline -- custom_exercises wouldn't be touched by THIS save (nothing about
  // alice's/bob's custom exercises changed here), so breaking that table wouldn't actually fail
  // this one. blockUser() mutates DB.users (alice's `following`, bob's `followers`), which DOES
  // change between baseline and this save -- breaking `users` is what actually forces this
  // specific save(DB) call to fail.
  await breakTable('users');
  const r = await post('/api/report', { targetType: 'user', targetUserId: bob.user.id, reason: 'harassment', alsoBlock: true }, alice.token);
  ok(r.status === 500, `report-with-block returns a real error while save(DB) is broken, got ${r.status}`);
  await fixTable('users');

  const health = await get('/healthz');
  ok(health.status === 200, 'server still up after the rigged report-with-block failure');

  // Alice's own view of whether she still follows Bob is the simplest observable signal that
  // blockUser()'s mutation was reverted -- a successful (non-reverted) block would have cleared
  // this, since blockUser() reassigns me.following to a filtered copy with targetId removed.
  const after = await get(`/api/profile/${alice.user.id}/following`, alice.token).then(r => r.json());
  const aliceStillFollowsBob = Array.isArray(after) && after.some(u => u.id === bob.user.id);
  ok(aliceStillFollowsBob === true, `alice still follows bob after the reverted block (the failed save(DB) did not leave the unfollow/block in memory), got ${JSON.stringify(after)}`);

  const admin = await get(`/api/admin/reports`); // no x-admin-token on purpose -- just confirming the route exists / server is sane, not asserting on auth here
  ok(admin.status === 401 || admin.status === 403, `sanity: admin reports route is still gated normally (not asserting on report content here), got ${admin.status}`);
}

raw.close();
if (srv) srv.kill();
await testDb.drop();
rmSync(DIR, { recursive: true, force: true });

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
