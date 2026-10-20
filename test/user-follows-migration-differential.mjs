// Oct 16 2026 (users slice, decision #1 -- follow-graph redesign). Ground-truth differential
// check for migrateUserFollowsIntoPostgres (server.js) / the user_follows table (db.js), mirroring
// test/crew-row-column-migration-differential.mjs's structure for the crews slice.
//
// This exists specifically because of a CRITICAL bug both independent review passes on this
// slice found (and this test reproduces live, then proves fixed): test/follow.mjs's own
// migration test seeds users straight off the OLD "friends"-only legacy shape, which happens to
// have EMPTY following/followReqs in the raw blob at load time -- so it never exercised the
// actual failure. On any real deploy, migrateFollowApproval already ran months ago and real
// users carry genuine, non-empty following/followReqs content in their blob. The migration
// itself flattens that correctly into user_follows (via pgUpsertFollowEdge, bypassing the normal
// save()/diff path) -- but the very next `await save(DB)` in the SAME boot (server.js's own boot
// sequence runs it immediately after the migration, before app.listen) used to diff the now-
// empty in-memory arrays against the stale PRE-migration baseline doLoad() captured at the start
// of that same boot, see every user as "changed," and silently DELETE every edge the migration
// had just written and reinsert nothing. Total, silent loss of the whole follow graph, in the
// same boot that migrated it, on every real deploy. Fixed in db.js via syncUserFollowsBaseline(),
// called right after the migration mutates DB.users -- this test seeds REALISTIC (post-
// migrateFollowApproval) legacy data, the exact shape that exposes it, and would fail without
// that fix.
//
// Four things proven here, each live rather than just trusted:
//   - lossless + survives the boot's own trailing save(): every embedded follower/following/
//     followReq relationship lands in user_follows AND is still there after the full boot
//     sequence completes (not just immediately inside the migration function itself).
//   - idempotent: a second boot against the same, already-migrated database is a true no-op.
//   - crash-safe: if the migration's edges land in Postgres but the boot crashes before
//     userFollowsTableV1 is itself persisted (a real possibility -- it's set in-memory, then
//     relies on the SAME trailing save() to actually write it), re-running the migration from
//     scratch on the next boot does not duplicate or corrupt anything (idempotent upserts, and
//     the never-downgrade-accepted-to-pending guard holds under a second pass).
//   - a brand-new user created AFTER the migration, and a real post-migration follow/unfollow
//     action, both go straight through the new table with no backfill needed.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';
import { PgConnection, parseConnString } from '../pgmini.js';

const PORT = 5905, B = `http://localhost:${PORT}`;
const DIR = mkdtempSync(join(tmpdir(), 'user-follows-migrate-diff-'));
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('userfollowsmigratediff');
const J = { 'Content-Type': 'application/json' };
let fails = 0, srv = null;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
process.on('exit', () => { try { srv && srv.kill(); } catch {} try { rmSync(DIR, { recursive: true, force: true }); } catch {} });
// Oct 20 2026 (found during the broader crash-safety audit, flagged and deferred rather than
// folded into that mechanical pass, then fixed here on Jeff's "we will want to fix those after"):
// this file already had the 'exit' handler above, which correctly frees PORT 5905 and removes
// DIR even on a crash -- the real gap was that `testDb` (a real throwaway Postgres database
// created via freshTestDb()) was NEVER dropped anywhere in this file, not on a crash AND NOT on
// its own happy path (including across this file's own reboot()/stop() calls, which only ever
// touch `srv`, never `testDb`). Every run -- pass or fail -- permanently leaked one more
// crewfit_t_userfollowsmigratediff_* database. `drop()` is async and 'exit' handlers must be
// synchronous (Node will not wait on a Promise returned from one), so this can't just be added to
// the handler above -- same reasoning CLAUDE.md's crash-safety idiom write-up already documents
// for every other file in this suite.
let cleanedUp = false;
async function cleanup() {
  if (cleanedUp) return; cleanedUp = true;
  try { await testDb.drop(); } catch {}
}
process.on('uncaughtException', async (e) => { console.error('UNCAUGHT', e); await cleanup(); process.exit(1); });
process.on('unhandledRejection', async (e) => { console.error('UNHANDLED', e); await cleanup(); process.exit(1); });

function boot() {
  return new Promise((res, rej) => {
    srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: DIR, DATABASE_URL: testDb.url, PORT: String(PORT) },
      cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    srv.stdout.on('data', d => { buf += d; if (String(d).includes('CrewFit on')) res(buf); });
    srv.stderr.on('data', d => process.stderr.write('[server] ' + d));
    srv.on('exit', c => rej(new Error(`server exited (${c}):\n${buf}`)));
    setTimeout(() => rej(new Error('server never started:\n' + buf)), 15000);
  });
}
const stop = () => new Promise(r => { if (!srv) return r(); srv.on('exit', r); srv.kill(); });
async function reboot() { await stop(); return boot(); }

async function reg(n) {
  const r = await fetch(B + '/api/register', { method: 'POST', headers: J,
    body: JSON.stringify({ ageConfirmed: true, username: n, pin: 'pass1234', displayName: n }) }).then(x => x.json());
  if (!r.token) throw new Error('register failed: ' + JSON.stringify(r));
  return { id: r.user.id, token: r.token, H: { ...J, Authorization: 'Bearer ' + r.token } };
}
const post = (who, p, body) => fetch(B + p, { method: 'POST', headers: who.H, body: JSON.stringify(body || {}) }).then(r => r.json());

async function rawQuery(sql, params) {
  const pg = new PgConnection(parseConnString(testDb.url));
  const r = await pg.query(sql, params);
  pg.close();
  return r.rows;
}
async function edges() {
  return rawQuery('SELECT follower_id, followee_id, status FROM user_follows ORDER BY follower_id, followee_id');
}
const hasEdge = (rows, follower, followee, status) => rows.some(e => e.follower_id === follower && e.followee_id === followee && e.status === status);

// ---------- setup: seed REALISTIC legacy data, directly in Postgres, bypassing the app ----------
// This is the shape a real production database is actually in before this migration ships:
// followApprovalV1/friendsRetiredV1/binaryVisibilityV1 already true (those migrations ran months
// ago), and real users carrying genuine, non-empty following/followers/followReqs content.
console.log('setup: seed realistic post-followApprovalV1 legacy data directly in Postgres (the exact shape that exposes the save-wipes-the-migration bug)');
const u = (id, extra) => Object.assign({ id, username: id, displayName: id, units: 'lb', createdAt: '2026-01-01T00:00:00.000Z', pinHash: 'x', pinSalt: 'y' }, extra);
const seedUsers = {
  alice: u('ufmd_alice', { following: ['ufmd_bob'], followers: [], followReqs: [] }),
  bob: u('ufmd_bob', { following: [], followers: ['ufmd_alice'], followReqs: ['ufmd_carol'] }),
  carol: u('ufmd_carol', { following: [], followers: [], followReqs: [] }),
  dave: u('ufmd_dave', { following: ['ufmd_alice', 'ufmd_bob'], followers: [], followReqs: [] }),
};
{
  const dbmod = (await import('../db.js')).default;
  process.env.DATABASE_URL = testDb.url;
  await dbmod.ensureSchema();
  dbmod.close();
  const pg = new PgConnection(parseConnString(testDb.url));
  const normUser = v => String(v == null ? '' : v).trim().toLowerCase();
  for (const uu of Object.values(seedUsers)) {
    await pg.query('INSERT INTO users (id, username_lower, data) VALUES ($1, $2, $3::jsonb)', [uu.id, normUser(uu.username), JSON.stringify(uu)]);
  }
  await pg.query("INSERT INTO app_state (key, value) VALUES ('followApprovalV1', 'true'), ('friendsRetiredV1', 'true'), ('binaryVisibilityV1', 'true')");
  pg.close();
}

console.log('\nfirst boot: the migration flattens the real legacy data into user_follows, AND it survives the boot\'s own trailing save() -- the critical bug this test exists to catch');
await boot();
{
  const e = await edges();
  ok(hasEdge(e, 'ufmd_alice', 'ufmd_bob', 'accepted'), `alice's real follow of bob survived (edges: ${JSON.stringify(e)})`);
  ok(hasEdge(e, 'ufmd_carol', 'ufmd_bob', 'pending'), "carol's real pending request to bob survived");
  ok(hasEdge(e, 'ufmd_dave', 'ufmd_alice', 'accepted') && hasEdge(e, 'ufmd_dave', 'ufmd_bob', 'accepted'), "dave's two real follows survived");
  ok(e.length === 4, `exactly the 4 real edges, nothing extra and nothing missing (got ${e.length})`);
}

console.log('\nsecond boot (nothing left to migrate): a true no-op, not a duplication or corruption');
await reboot();
{
  const e = await edges();
  ok(e.length === 4, `still exactly 4 edges after a second boot, no duplicates (got ${e.length})`);
  ok(hasEdge(e, 'ufmd_alice', 'ufmd_bob', 'accepted') && hasEdge(e, 'ufmd_carol', 'ufmd_bob', 'pending') &&
     hasEdge(e, 'ufmd_dave', 'ufmd_alice', 'accepted') && hasEdge(e, 'ufmd_dave', 'ufmd_bob', 'accepted'),
     'all four original edges are still exactly as they were');
  const flag = await rawQuery("SELECT value FROM app_state WHERE key = 'userFollowsTableV1'");
  ok(flag.length === 1 && JSON.parse(flag[0].value) === true, 'the migration flag itself persisted across the restart');
}

console.log('\ncrash-safety: edges already landed but the flag never got persisted (simulating a crash between the two) -- re-running the migration on the next boot does not duplicate or corrupt anything');
await stop();
await rawQuery("DELETE FROM app_state WHERE key = 'userFollowsTableV1'");
await boot();
{
  const e = await edges();
  ok(e.length === 4, `still exactly 4 edges after the migration re-ran from scratch, no duplicates from the re-run (got ${e.length})`);
  ok(hasEdge(e, 'ufmd_alice', 'ufmd_bob', 'accepted') && hasEdge(e, 'ufmd_carol', 'ufmd_bob', 'pending') &&
     hasEdge(e, 'ufmd_dave', 'ufmd_alice', 'accepted') && hasEdge(e, 'ufmd_dave', 'ufmd_bob', 'accepted'),
     'and every edge still has its correct, original status -- no accidental downgrade or duplication from the second pass');
  const flag = await rawQuery("SELECT value FROM app_state WHERE key = 'userFollowsTableV1'");
  ok(flag.length === 1 && JSON.parse(flag[0].value) === true, 'the flag is persisted for real this time');
}

console.log('\na real post-migration follow action, and a brand-new user, both go straight through user_follows with no backfill needed');
{
  const eve = await reg('ufmd_eve');
  const alice = { id: 'ufmd_alice', token: null, H: null };
  // log in as the seeded alice (she has no real pinHash this script can authenticate with -- the
  // seeded accounts are synthetic), so instead prove the live-traffic path with two freshly
  // registered users instead, which is the actually-meaningful check (does a brand-new account,
  // created entirely after the migration, work correctly with zero backfill involved).
  const frank = await reg('ufmd_frank');
  const r = await post(eve, `/api/follow/${frank.id}`);
  ok(r.status === 'following', `eve (brand-new, post-migration) follows frank (brand-new, post-migration) -- got ${JSON.stringify(r)}`);
  const e = await edges();
  ok(hasEdge(e, eve.id, frank.id, 'accepted'), 'the new edge landed in user_follows directly, no backfill involved');
  const unf = await post(eve, `/api/unfollow/${frank.id}`);
  ok(unf.status === 'none', `eve unfollows frank -- got ${JSON.stringify(unf)}`);
  const e2 = await edges();
  ok(!hasEdge(e2, eve.id, frank.id, 'accepted') && !e2.some(x => x.follower_id === eve.id && x.followee_id === frank.id),
    'and the edge is actually gone from the table, not just hidden');
}

await cleanup();
console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
