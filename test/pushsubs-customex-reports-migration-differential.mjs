// Oct 14 2026 (rearchitecture, push subs/custom exercises/reports slice -- task #258+, see
// CLAUDE.md "Rearchitecture status" / "Rearchitecture safeguards"). Ground-truth differential
// check for this slice, same technique as test/notifications-feed-migration-differential.mjs:
// drive the REAL, running server through its REAL HTTP routes, then check what actually landed
// in Postgres, directly, from a second independent connection.
//
// Three pieces, two different verification shapes:
//   - Push subs and reports were cut over directly (no dual-write window -- see the comment on
//     POST /api/push/subscribe and POST /api/report in server.js for why: same table, same
//     shape, nothing to reconcile two implementations against). What matters here is durability
//     through a real restart -- these routes no longer put anything on DB at all, so the ONLY
//     thing keeping a subscription/report alive across a deploy is this table. Verified by
//     actually killing the server and booting a fresh one against the same database.
//   - Custom exercises is mid dual-write: DB.customExercises (array-per-owner) is still what
//     every real read in the app serves from; this test proves the NEW custom_exercise_rows
//     table (one row per exercise) ends up holding the same data, via real create/edit/delete
//     HTTP calls, not a hand-rolled script. Also proves the boot-time flatten migration
//     (migrateCustomExerciseRowsIntoPostgres) actually catches a pre-existing row, and that the
//     shadow-compare added to GET /api/exercises genuinely detects a real divergence rather than
//     being a no-op safety net nobody ever verified fires.
//
// Every dual-write/shadow-compare call is deliberately fire-and-forget (must never add latency
// to the real response) -- pollUntil() below polls with a short timeout instead of asserting on
// the very next tick, same reasoning the notifications-slice differential test uses.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';

const PORT = 5000, B = `http://localhost:${PORT}`;
const DIR = mkdtempSync(join(tmpdir(), 'pushex-rep-diff-'));
const J = { 'Content-Type': 'application/json' };
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('pushexrepdiff');
let srv, adminToken, fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const H = t => ({ ...J, Authorization: 'Bearer ' + t });
const post = (p, b, t) => fetch(B + p, { method: 'POST', headers: t ? H(t) : J, body: JSON.stringify(b) });
const put  = (p, b, t) => fetch(B + p, { method: 'PUT', headers: t ? H(t) : J, body: JSON.stringify(b) });
const del  = (p, t) => fetch(B + p, { method: 'DELETE', headers: H(t) });
const get  = (p, t) => fetch(B + p, { headers: t ? H(t) : J });
// adminAuth (server.js) checks the `x-admin-token` header, NOT `Authorization: Bearer` -- a
// completely separate credential from a user's login token (see adminAuth's own comment: it's
// token-gated, not tied to any user account). postAdmin/getAdmin are deliberately distinct from
// post/get above rather than overloading the same helpers with a third header shape.
const AH = t => ({ ...J, 'x-admin-token': t });
const postAdmin = (p, b, t) => fetch(B + p, { method: 'POST', headers: AH(t), body: JSON.stringify(b || {}) });
const getAdmin = (p, t) => fetch(B + p, { headers: AH(t) });
process.on('exit', () => { try { srv && srv.kill(); } catch {} try { rmSync(DIR, { recursive: true, force: true }); } catch {} });

function boot(port, dir, databaseUrl) {
  return new Promise(res => {
    let token = null;
    const s = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: databaseUrl, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    s.stdout.on('data', d => { buf += d; const m = buf.match(/Generated ADMIN_TOKEN.*?:\s*(\S+)/); if (m) token = m[1]; if (String(d).includes('CrewFit on')) res({ srv: s, adminToken: token }); });
    s.stderr.on('data', d => process.stderr.write('[server] ' + d));
    s.on('exit', () => res({ srv: null, adminToken: token }));
    setTimeout(() => res({ srv: s, adminToken: token }), 8000);
  });
}

async function pollUntil(fn, checkFn, timeoutMs = 2000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    last = await fn();
    if (checkFn(last)) return last;
    await new Promise(r => setTimeout(r, 40));
  }
  return last;
}

({ srv, adminToken } = await boot(PORT, DIR, testDb.url));
ok(!!srv, 'server boots');
ok(!!adminToken, 'ADMIN_TOKEN captured from boot log');

// Direct access to the new direct-Postgres functions, from this test process -- same
// DATABASE_URL the spawned server uses, a second, independent connection to it.
process.env.DATABASE_URL = testDb.url;
const db = await import('../db.js');

const alice = await post('/api/register', { username: 'pxalice', pin: 'pass1234', displayName: 'Alice' }).then(r => r.json());
const bob   = await post('/api/register', { username: 'pxbob',   pin: 'pass1234', displayName: 'Bob' }).then(r => r.json());

console.log('\npush subs: POST /api/push/subscribe lands directly in Postgres (no dual-write window -- see the route\'s own comment)');
{
  const subBody = { subscription: { endpoint: 'https://push.example/alice-device-1', expirationTime: null, keys: { p256dh: 'p1', auth: 'a1' } } };
  const r = await post('/api/push/subscribe', subBody, alice.token);
  ok(r.status === 200, `subscribe returns 200, got ${r.status}`);
  const stored = await db.pgGetPushSub(alice.user.id);
  ok(!!stored && stored.endpoint === subBody.subscription.endpoint, `the real row has the exact endpoint just posted, got ${JSON.stringify(stored)}`);
  ok(stored && stored.keys && stored.keys.p256dh === 'p1' && stored.keys.auth === 'a1', 'and the real keys, not placeholders');
}

console.log('\npush subs: a resubscribe (new endpoint) is not undone by a stale dead-subscription cleanup racing behind it');
{
  // Simulates exactly the race POST /api/push/subscribe's own comment and notify()'s comment
  // describe: a subscription was about to be marked dead (404/410 from the push service) right as
  // the user's device resubscribed with a NEW endpoint. The cleanup must only ever remove the
  // SPECIFIC stale endpoint it was trying to clean up, never whatever is currently stored.
  const oldEndpoint = (await db.pgGetPushSub(alice.user.id)).endpoint;
  const subBody2 = { subscription: { endpoint: 'https://push.example/alice-device-2-NEW', expirationTime: null, keys: { p256dh: 'p2', auth: 'a2' } } };
  await post('/api/push/subscribe', subBody2, alice.token);   // the "resubscribe" that races ahead
  const deleted = await db.pgDeletePushSubIfEndpointMatches(alice.user.id, oldEndpoint);   // the stale cleanup, arriving "late"
  ok(deleted === false, 'the stale-endpoint delete correctly refuses (0 rows matched), not a blind delete');
  const stillThere = await db.pgGetPushSub(alice.user.id);
  ok(!!stillThere && stillThere.endpoint === subBody2.subscription.endpoint, 'the NEW subscription survived the race, untouched');
}

console.log('\npush subs: survives a real server restart (the only thing keeping it alive now -- DB.pushSubs is gone)');
{
  srv.kill();
  await new Promise(r => setTimeout(r, 600));
  ({ srv } = await boot(PORT, DIR, testDb.url));
  ok(!!srv, 'server re-boots against the same database');
  const afterRestart = await db.pgGetPushSub(alice.user.id);
  ok(!!afterRestart && afterRestart.endpoint === 'https://push.example/alice-device-2-NEW', `subscription survived the restart, got ${JSON.stringify(afterRestart)}`);
}

console.log('\nreports: POST /api/report -> GET /api/admin/reports -> resolve, end to end through the real routes');
{
  const r = await post('/api/report', { targetType: 'user', targetUserId: bob.user.id, reason: 'spam', details: 'test report from the differential check' }, alice.token);
  ok(r.status === 200, `POST /api/report returns 200, got ${r.status}`);

  const list = await getAdmin('/api/admin/reports', adminToken).then(r2 => r2.json());
  const mine = list.find(x => x.reporterId === alice.user.id && x.targetUserId === bob.user.id);
  ok(!!mine, `the new report shows up in the admin list, got ${list.length} total reports`);
  ok(mine && mine.status === 'open' && mine.reason === 'spam', 'with the right status/reason');
  ok(mine && mine.reporterName === 'Alice' && mine.targetName === 'Bob', `display names resolved server-side, got reporterName=${mine && mine.reporterName} targetName=${mine && mine.targetName}`);

  const resolveRes = await postAdmin(`/api/admin/reports/${mine.id}/resolve`, {}, adminToken);
  ok(resolveRes.status === 200, `resolve returns 200, got ${resolveRes.status}`);
  const afterResolve = await getAdmin('/api/admin/reports', adminToken).then(r2 => r2.json());
  const resolved = afterResolve.find(x => x.id === mine.id);
  ok(resolved && resolved.status === 'resolved' && typeof resolved.resolvedAt === 'string', `report shows resolved with a resolvedAt timestamp, got ${JSON.stringify(resolved)}`);

  const missing = await postAdmin('/api/admin/reports/rep_does_not_exist/resolve', {}, adminToken);
  ok(missing.status === 404, `resolving a nonexistent report 404s, got ${missing.status}`);
}

console.log('\nreports: a resolved report survives a real server restart (reports is no longer on DB either)');
{
  srv.kill();
  await new Promise(r => setTimeout(r, 600));
  ({ srv } = await boot(PORT, DIR, testDb.url));
  ok(!!srv, 'server re-boots again against the same database');
  const afterRestart = await getAdmin('/api/admin/reports', adminToken).then(r2 => r2.json());
  ok(afterRestart.length >= 1 && afterRestart.every(r => r.status === 'resolved'), `the report is still there and still resolved after restart, got ${JSON.stringify(afterRestart)}`);
}

console.log('\ncustom exercises (dual-write phase): POST /api/exercises/custom lands in BOTH the old array AND the new row table');
let createdId;
{
  const body = { name: 'Diff Test Curl', muscle_groups: ['biceps'], equipment: ['dumbbell'], level: 'intermediate', is_compound: false, pattern: 'pull' };
  const r = await post('/api/exercises/custom', body, alice.token).then(r2 => r2.json());
  createdId = r.id;
  ok(!!createdId, `create returns a real exercise with an id, got ${JSON.stringify(r)}`);

  const oldList = await get('/api/exercises', alice.token).then(r2 => r2.json());
  const oldEntry = oldList.find(e => e.name === 'Diff Test Curl');
  ok(!!oldEntry && oldEntry.mine === true, 'old path (GET /api/exercises, still the real driver) shows it, tagged mine:true');

  const newRow = await pollUntil(() => db.pgGetCustomExerciseRow(createdId), row => !!row);
  ok(!!newRow, `new table has a row with the SAME id the create returned, got ${JSON.stringify(newRow)}`);
  ok(newRow && newRow.name === 'Diff Test Curl' && newRow.ownerId === alice.user.id && JSON.stringify(newRow.muscle_groups) === JSON.stringify(['biceps']),
    `and its content matches (name/ownerId/muscle_groups) -- new: ${JSON.stringify(newRow)}`);
}

console.log('\ncustom exercises (dual-write phase): PUT edit updates the new row the same way it updates the old array entry');
{
  const r = await put(`/api/exercises/custom/${createdId}`, { muscle_groups: ['biceps'], equipment: ['dumbbell', 'cable'], level: 'advanced', is_compound: true, pattern: 'pull' }, alice.token);
  ok(r.status === 200, `edit returns 200, got ${r.status}`);
  const newRow = await pollUntil(() => db.pgGetCustomExerciseRow(createdId), row => row && row.level === 'advanced');
  ok(newRow && newRow.level === 'advanced' && newRow.is_compound === true && JSON.stringify(newRow.equipment) === JSON.stringify(['dumbbell', 'cable']),
    `new row reflects the edit, got ${JSON.stringify(newRow)}`);
}

console.log('\ncustom exercises (dual-write phase): DELETE removes the new row the same way it removes the old array entry, and ownership is enforced independently on the new table too');
{
  const stolen = await db.pgDeleteCustomExerciseRow(createdId, bob.user.id);
  ok(stolen === false, 'a non-owner cannot delete the new row directly either (defense in depth, mirrors the route\'s own ownership check)');

  const r = await del(`/api/exercises/custom/${createdId}`, alice.token);
  ok(r.status === 200, `delete returns 200, got ${r.status}`);
  const gone = await pollUntil(() => db.pgGetCustomExerciseRow(createdId), row => row === null);
  ok(gone === null, 'new row is gone after the real delete');

  const oldList = await get('/api/exercises', alice.token).then(r2 => r2.json());
  ok(!oldList.some(e => e.name === 'Diff Test Curl'), 'old path (still the real driver) no longer shows it either');
}

console.log('\ncustom exercises: the boot-time flatten migration catches a pre-existing row the dual-write writes never touched');
{
  // Simulates exactly the real-world case this migration exists for: a custom exercise that was
  // already sitting in the OLD custom_exercises table (array-per-owner) from before this slice's
  // code ever ran, so no dual-write call site ever wrote it into the new table. A fresh row
  // written straight into the OLD table, bypassing every route in this app, then a restart
  // (which re-runs migrateCustomExerciseRowsIntoPostgres at boot) is what should surface it in
  // the new table -- not any request-time code.
  const preExisting = { id: 'ce_preexisting_1', name: 'Legacy Pre-Slice Row', pattern: 'push', category: 'chest', muscle_groups: ['chest'], equipment: [], is_compound: false, level: 'beginner', defaultSets: 3, defaultReps: 10, custom: true, ownerId: bob.user.id };
  const c = db.getConn ? db.getConn() : null;
  await c.query(
    `INSERT INTO custom_exercises (owner_id, data) VALUES ($1, $2::jsonb) ON CONFLICT (owner_id) DO UPDATE SET data = (CASE WHEN custom_exercises.data @> $2::jsonb THEN custom_exercises.data ELSE custom_exercises.data || $2::jsonb END)`,
    [bob.user.id, JSON.stringify([preExisting])]
  );
  // bob may already have had an array from earlier in this file (none so far, but be safe): read
  // what's there and append rather than assume this INSERT's ON CONFLICT path appended correctly
  // for every Postgres version's jsonb `||` semantics on arrays -- just verify the END STATE below
  // has the row, which is what actually matters.
  srv.kill();
  await new Promise(r => setTimeout(r, 600));
  ({ srv } = await boot(PORT, DIR, testDb.url));
  ok(!!srv, 'server re-boots a third time (runs migrateCustomExerciseRowsIntoPostgres again)');
  const flattened = await db.pgGetCustomExerciseRow('ce_preexisting_1');
  ok(!!flattened && flattened.name === 'Legacy Pre-Slice Row' && flattened.ownerId === bob.user.id,
    `the pre-existing row the dual-write writes never touched was picked up by the boot flatten, got ${JSON.stringify(flattened)}`);
}

console.log('\ncustom exercises: the shadow-compare added to GET /api/exercises genuinely detects a real divergence (not a no-op safety net)');
{
  // Deliberately desyncs the two tables behind the app's back -- deletes the row this test just
  // proved the flatten created, from the NEW table only, leaving the OLD array (DB.customExercises,
  // still what GET /api/exercises actually serves) untouched. The very next GET /api/exercises
  // call should trigger shadowCompareCustomExerciseRows() and log a mismatch -- this proves the
  // safety net this phase depends on to catch a real missed-dual-write bug actually fires, rather
  // than silently passing because nothing ever triggers it in practice.
  const c = db.getConn();
  await c.query('DELETE FROM custom_exercise_rows WHERE id = $1', ['ce_preexisting_1']);

  let sawMismatchLog = false;
  const onData = d => { if (String(d).includes('[migration shadow-compare] custom_exercise_rows id-set mismatch')) sawMismatchLog = true; };
  srv.stderr.on('data', onData);
  await get('/api/exercises', bob.token);   // throttled to once/minute -- this is the first call since boot, so it fires
  await new Promise(r => setTimeout(r, 300));   // the compare itself is async (fire-and-forget)
  srv.stderr.off('data', onData);
  ok(sawMismatchLog, 'a deliberately-introduced divergence between the old array and the new table was logged by the shadow-compare');
}

console.log(fails === 0 ? '\nall assertions passed' : `\n${fails} assertion(s) FAILED`);
process.exit(fails === 0 ? 0 : 1);
