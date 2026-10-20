// Oct 14 2026 (rearchitecture, push subs/custom exercises/reports slice -- task #258+, see
// CLAUDE.md "Rearchitecture status" / "Rearchitecture safeguards"). Ground-truth differential
// check for this slice, same technique as test/notifications-feed-migration-differential.mjs:
// drive the REAL, running server through its REAL HTTP routes, then check what actually landed
// in Postgres, directly, from a second independent connection.
//
// All three pieces now have the SAME shape, even though they landed on different days:
//   - Push subs and reports were cut over directly on Oct 14 2026 (no dual-write window -- see
//     the comment on POST /api/push/subscribe and POST /api/report in server.js for why: same
//     table, same shape, nothing to reconcile two implementations against).
//   - Custom exercises took two steps -- a dual-write phase (Oct 14 2026, DB.customExercises
//     array-per-owner still the real driver, custom_exercise_rows mirrored alongside it,
//     fire-and-forget) followed by the read cutover (Oct 16 2026, see CLAUDE.md "Rearchitecture
//     status") that made custom_exercise_rows the one and only source, the same as push subs/
//     reports already were. The dual-write-era assertions this file used to carry -- proving the
//     old array and the fire-and-forget mirror agreed, that the boot-time flatten migration
//     caught a pre-existing legacy row, that the shadow-compare on GET /api/exercises actually
//     fired on a deliberate divergence -- are gone along with the mechanisms they tested
//     (migrateCustomExerciseRowsIntoPostgres and shadowCompareCustomExerciseRows were both
//     removed as part of the cutover; see their removal's own comment in server.js). What's left
//     below for custom exercises is the same shape as push subs/reports: real HTTP calls, in,
//     then a real, independent read of custom_exercise_rows to prove it's really there -- plus
//     the SAME durability-through-a-real-restart proof push subs/reports already get, since
//     nothing else keeps a custom exercise alive across a deploy now either.
//
// All three write paths are now directly awaited by their route before responding (no more
// fire-and-forget dual-write for custom exercises either -- see POST/PUT/DELETE
// /api/exercises/custom's own comments), so a plain read immediately after the HTTP response
// returns is enough. pollUntil() (used by the dual-write-era custom-exercises assertions this
// file no longer has) is removed along with its last caller, for the same reason.
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
// Oct 20 2026 (found during the broader crash-safety audit, flagged and deferred rather than
// folded into that mechanical pass, then fixed here on Jeff's "we will want to fix those after"):
// this file already had the 'exit' handler above, which correctly frees PORT 5000 and removes
// DIR even on a crash -- the real gap was that `testDb` (a real throwaway Postgres database
// created via freshTestDb()) was NEVER dropped anywhere in this file, not on a crash AND NOT on
// its own happy path. Every run -- pass or fail -- permanently leaked one more
// crewfit_t_pushexrepdiff_* database. `drop()` is async and 'exit' handlers must be synchronous
// (Node will not wait on a Promise returned from one), so this can't just be added to the
// handler above -- same reasoning CLAUDE.md's crash-safety idiom write-up already documents for
// every other file in this suite.
let cleanedUp = false;
async function cleanup() {
  if (cleanedUp) return; cleanedUp = true;
  try { await testDb.drop(); } catch {}
}
process.on('uncaughtException', async (e) => { console.error('UNCAUGHT', e); await cleanup(); process.exit(1); });
process.on('unhandledRejection', async (e) => { console.error('UNHANDLED', e); await cleanup(); process.exit(1); });

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

console.log('\ncustom exercises: POST /api/exercises/custom writes straight to custom_exercise_rows (no dual-write mirror any more)');
let createdId;
{
  const body = { name: 'Diff Test Curl', muscle_groups: ['biceps'], equipment: ['dumbbell'], level: 'intermediate', is_compound: false, pattern: 'pull' };
  const r = await post('/api/exercises/custom', body, alice.token).then(r2 => r2.json());
  createdId = r.id;
  ok(!!createdId, `create returns a real exercise with an id, got ${JSON.stringify(r)}`);

  const list = await get('/api/exercises', alice.token).then(r2 => r2.json());
  const entry = list.find(e => e.name === 'Diff Test Curl');
  ok(!!entry && entry.mine === true, 'GET /api/exercises shows it, tagged mine:true');

  // No pollUntil needed here any more: the route awaits pgUpsertCustomExerciseRow before it ever
  // responds (see that route's own comment), so the row is already committed by the time the HTTP
  // response above came back -- a plain read is enough.
  const row = await db.pgGetCustomExerciseRow(createdId);
  ok(!!row, `custom_exercise_rows has a row with the SAME id the create returned, got ${JSON.stringify(row)}`);
  ok(row && row.name === 'Diff Test Curl' && row.ownerId === alice.user.id && JSON.stringify(row.muscle_groups) === JSON.stringify(['biceps']),
    `and its content matches (name/ownerId/muscle_groups) -- row: ${JSON.stringify(row)}`);
}

console.log('\ncustom exercises: PUT edit updates custom_exercise_rows directly');
{
  const r = await put(`/api/exercises/custom/${createdId}`, { muscle_groups: ['biceps'], equipment: ['dumbbell', 'cable'], level: 'advanced', is_compound: true, pattern: 'pull' }, alice.token);
  ok(r.status === 200, `edit returns 200, got ${r.status}`);
  const row = await db.pgGetCustomExerciseRow(createdId);
  ok(row && row.level === 'advanced' && row.is_compound === true && JSON.stringify(row.equipment) === JSON.stringify(['dumbbell', 'cable']),
    `row reflects the edit, got ${JSON.stringify(row)}`);
}

console.log('\ncustom exercises: DELETE removes the row directly, and ownership is enforced independently on the table too');
{
  const stolen = await db.pgDeleteCustomExerciseRow(createdId, bob.user.id);
  ok(stolen === false, 'a non-owner cannot delete the row directly either (defense in depth, mirrors the route\'s own ownership check)');

  const r = await del(`/api/exercises/custom/${createdId}`, alice.token);
  ok(r.status === 200, `delete returns 200, got ${r.status}`);
  const gone = await db.pgGetCustomExerciseRow(createdId);
  ok(gone === null, 'row is gone after the real delete');

  const list = await get('/api/exercises', alice.token).then(r2 => r2.json());
  ok(!list.some(e => e.name === 'Diff Test Curl'), 'GET /api/exercises no longer shows it either');
}

console.log('\ncustom exercises: survives a real server restart (the read cutover, Oct 16 2026, means custom_exercise_rows is the ONLY thing keeping it alive now -- DB.customExercises is gone)');
{
  const body = { name: 'Diff Durability Row', muscle_groups: ['chest'], equipment: [], level: 'beginner', is_compound: false, pattern: 'push' };
  const created = await post('/api/exercises/custom', body, bob.token).then(r2 => r2.json());
  ok(!!created.id, `setup: created a row to survive the restart, got ${JSON.stringify(created)}`);

  srv.kill();
  await new Promise(r => setTimeout(r, 600));
  ({ srv } = await boot(PORT, DIR, testDb.url));
  ok(!!srv, 'server re-boots against the same database');

  const list = await get('/api/exercises', bob.token).then(r2 => r2.json());
  const stillThere = list.find(e => e.name === 'Diff Durability Row');
  ok(!!stillThere && stillThere.mine === true, `the custom exercise survived the restart, got ${JSON.stringify(stillThere)}`);
}

console.log('\ncustom exercises: the 500-per-owner cap holds exactly under real CONCURRENT creates (regression -- two independent reviews caught and reproduced this race the same day the cutover landed)');
{
  // The read cutover's first version checked the cap with `const mine = await
  // pgListCustomExerciseRowsByOwner(...); if (mine.length >= 500) ...` -- a separate awaited call
  // BEFORE the eventual awaited insert, each its own turn in db.js's enqueue() queue. That reopened
  // a race the OLD synchronous check-then-push code never had (no await between the two at all,
  // so Node's single-threaded execution made the pair atomic for free): concurrent creates from
  // the SAME user could each read the same stale under-cap count in the gap and all succeed,
  // landing over 500. Fixed by pgInsertCustomExerciseRowIfUnderCap, which does the count check and
  // the insert inside ONE enqueue()'d call (see its own comment in db.js). Proven here against the
  // real route over real HTTP, not just against db.js directly: seed alice to exactly one below
  // the cap, then fire several real concurrent POST requests and confirm AT MOST ONE succeeds and
  // the final count never exceeds 500.
  const seedOwner = alice.user.id;
  for (let i = 0; i < 499; i++) {
    await db.pgUpsertCustomExerciseRow({ id: `cap_seed_${i}`, ownerId: seedOwner, name: `Cap Seed ${i}`, muscle_groups: ['chest'], equipment: [], is_compound: false, level: 'beginner', pattern: 'push', custom: true, defaultSets: 3, defaultReps: 10 });
  }
  const before = (await db.pgListCustomExerciseRowsByOwner(seedOwner)).length;
  ok(before === 499, `setup: alice sits at exactly one below the cap, got ${before}`);

  const concurrent = await Promise.all([0, 1, 2, 3, 4].map(i =>
    post('/api/exercises/custom', { name: `Cap Race ${i}`, muscle_groups: ['chest'] }, alice.token)
  ));
  const succeeded = concurrent.filter(r => r.status === 200).length;
  const rejected = concurrent.filter(r => r.status === 400).length;
  ok(succeeded === 1, `exactly one of 5 concurrent creates at the cap boundary succeeds, got ${succeeded}`);
  ok(rejected === 4, `and the other 4 are cleanly rejected with the cap error, got ${rejected}`);

  const after = (await db.pgListCustomExerciseRowsByOwner(seedOwner)).length;
  ok(after === 500, `the real row count never exceeds the documented cap of 500, got ${after}`);
}

await cleanup();
console.log(fails === 0 ? '\nall assertions passed' : `\n${fails} assertion(s) FAILED`);
process.exit(fails === 0 ? 0 : 1);
