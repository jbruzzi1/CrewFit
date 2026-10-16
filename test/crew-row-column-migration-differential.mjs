// Oct 16 2026 (crews deep-dive, decision #2 -- crew-row normalization, after decision #1 above
// moved messages/challenges off the crew blob). Ground-truth differential check for
// migrateCrewRowColumnsIntoPostgres (server.js), the boot migration that backfills the NEW
// crews.name/owner_id/created_at columns and the crew_members join table (db.js) from the OLD
// crews.data jsonb blob -- same technique as
// test/crew-messages-challenges-migration-differential.mjs: drive the real server through its
// real HTTP routes, patch real rows directly in Postgres to simulate the OLD pre-migration shape
// (a brand-new crew already lands in the new-columns shape -- every write path was cut over in
// the same change that added this migration, so there's no way to get a fresh crew into the old
// shape through the live API any more), then reboot and check both the HTTP-visible result AND
// the raw Postgres rows.
//
// Four things this migration's own comment in server.js promises, each proven here rather than
// just trusted:
//   - lossless: name/ownerId/createdAt/memberIds all land intact on the new columns/join table.
//   - order-preserving: memberIds' array order (the crew-list avatar stack and the crew page's
//     roster both render straight off it, see db.js's own comment on crew_members.seq) survives
//     the move from "array embedded in jsonb" to "rows in a join table" -- a real regression risk
//     found while designing this migration, not a hypothetical.
//   - idempotent: running it again (a second boot against the same, already-migrated database) is
//     a true no-op -- no duplicate/reordered crew_members rows, no column changes.
//   - crash-safe: a crew migrated on an earlier boot and a crew NOT yet migrated can coexist in
//     the same database (simulating an interrupted boot), and a malformed legacy row (missing
//     name, non-array memberIds, null data) is backfilled with safe defaults instead of crashing
//     boot -- same CLAUDE.md hard rule #7 concern decision #1's own migration already had to
//     fix for a different field.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';
import { PgConnection, parseConnString } from '../pgmini.js';

const PORT = 5902, B = `http://localhost:${PORT}`;
const DIR = mkdtempSync(join(tmpdir(), 'crew-row-migrate-diff-'));
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('crewrowmigratediff');
const J = { 'Content-Type': 'application/json' };
let fails = 0, srv = null;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
process.on('exit', () => { try { srv && srv.kill(); } catch {} try { rmSync(DIR, { recursive: true, force: true }); } catch {} });

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
    body: JSON.stringify({ username: n, pin: 'pass1234', displayName: n }) }).then(x => x.json());
  if (!r.token) throw new Error('register failed: ' + JSON.stringify(r));
  return { id: r.user.id, token: r.token, H: { ...J, Authorization: 'Bearer ' + r.token } };
}
const get = (who, p) => fetch(B + p, { headers: who.H }).then(r => r.json());
const post = (who, p, body) => fetch(B + p, { method: 'POST', headers: who.H, body: JSON.stringify(body || {}) });
const connect = (owner, friend) => post(owner, `/api/follow/${friend.id}`);

// Resets a crew row to the OLD pre-migration shape: null out the new columns, delete any
// crew_members rows, and write the given old-style object into `data` -- the exact state a
// production row would be in if it had never gone through this migration at all. The server must
// be stopped first, same stop/patch/reboot shape the decision-#1 differential test and
// test/crews.mjs's own DB-breaking helpers already use.
async function resetCrewToLegacyShape(crewId, legacyData) {
  const pg = new PgConnection(parseConnString(testDb.url));
  await pg.query('UPDATE crews SET name = NULL, owner_id = NULL, created_at = NULL, data = $2::jsonb WHERE id = $1', [crewId, JSON.stringify(legacyData)]);
  await pg.query('DELETE FROM crew_members WHERE crew_id = $1', [crewId]);
  pg.close();
}
async function rawQuery(sql, params) {
  const pg = new PgConnection(parseConnString(testDb.url));
  const r = await pg.query(sql, params);
  pg.close();
  return r.rows;
}

await boot();
try {

console.log('setup: two crews, created through the real API, then reset to the OLD pre-migration shape directly in Postgres');
const owner = await reg('rowmigowner1'), pal = await reg('rowmigpal1'), third = await reg('rowmigthird1');
await connect(owner, pal);
await connect(owner, third);
const crewA = await post(owner, '/api/crews', { name: 'placeholder A', memberIds: [] }).then(x => x.json());
const crewB = await post(owner, '/api/crews', { name: 'placeholder B', memberIds: [] }).then(x => x.json());
ok(!!crewA.id && !!crewB.id, 'both crews created through the real API');

await stop();
const now = new Date().toISOString();
// crewA: owner, then third, then pal -- deliberately NOT alphabetical and NOT the order the
// owner/third/pal ids themselves sort in, so a reload that silently resorted membership (e.g. a
// naive `ORDER BY user_id`) would be caught, not accidentally pass.
await resetCrewToLegacyShape(crewA.id, { id: crewA.id, name: 'Legacy Crew A', ownerId: owner.id, memberIds: [owner.id, third.id, pal.id], createdAt: now });
// crewB: just the owner, no name set at all (simulates very old/malformed data missing a field
// that's always been required at creation time through the real API, but could exist from before
// some earlier validation was added).
await resetCrewToLegacyShape(crewB.id, { id: crewB.id, ownerId: owner.id, memberIds: [owner.id], createdAt: now });

console.log('\nfirst boot after resetting: the migration backfills both crews losslessly, in the right order');
await boot();
{
  const rowsA = await rawQuery('SELECT name, owner_id, created_at FROM crews WHERE id = $1', [crewA.id]);
  ok(rowsA.length === 1 && rowsA[0].name === 'Legacy Crew A' && rowsA[0].owner_id === owner.id && rowsA[0].created_at === now,
    `crewA's row columns backfilled intact, got ${JSON.stringify(rowsA[0])}`);
  const membersA = await rawQuery('SELECT user_id FROM crew_members WHERE crew_id = $1 ORDER BY seq', [crewA.id]);
  ok(JSON.stringify(membersA.map(r => r.user_id)) === JSON.stringify([owner.id, third.id, pal.id]),
    `crewA's member ORDER survived the move to crew_members (owner, third, pal), got ${JSON.stringify(membersA.map(r => r.user_id))}`);

  const rowsB = await rawQuery('SELECT name, owner_id FROM crews WHERE id = $1', [crewB.id]);
  ok(rowsB.length === 1 && rowsB[0].name === 'Crew' && rowsB[0].owner_id === owner.id,
    `crewB's missing name backfilled to a safe default ("Crew") rather than null/crashing, got ${JSON.stringify(rowsB[0])}`);

  // And the API agrees -- GET /api/crews/:id is what actually serves this, not just the raw table.
  const viewA = await get(owner, `/api/crews/${crewA.id}`);
  ok(viewA.name === 'Legacy Crew A' && viewA.ownerId === owner.id, 'GET /api/crews/:id reflects the backfilled name/ownerId');
  ok(JSON.stringify(viewA.members.map(m => m.id)) === JSON.stringify([owner.id, third.id, pal.id]),
    `GET /api/crews/:id's own member list (what the avatar stack/roster render from) preserves the same order, got ${JSON.stringify(viewA.members.map(m => m.id))}`);
}

console.log('\nsecond boot (nothing left to migrate): running it again is a true no-op, not a duplication or reorder');
await reboot();
{
  const membersA = await rawQuery('SELECT user_id FROM crew_members WHERE crew_id = $1 ORDER BY seq', [crewA.id]);
  ok(JSON.stringify(membersA.map(r => r.user_id)) === JSON.stringify([owner.id, third.id, pal.id]),
    `crewA still has exactly its 3 members in the same order after a second boot, got ${JSON.stringify(membersA.map(r => r.user_id))}`);
}

console.log('\na real edit after migration writes straight to the new columns/join table, through the normal save() path');
{
  await post(owner, `/api/crews/${crewA.id}`, {});
  const put = await fetch(B + `/api/crews/${crewA.id}`, { method: 'PUT', headers: owner.H, body: JSON.stringify({ memberIds: [third.id, pal.id] }) }).then(x => x.json());
  ok(JSON.stringify(put.members.map(m => m.id)) === JSON.stringify([owner.id, third.id, pal.id]),
    `owner always stays first even after a membership edit, got ${JSON.stringify(put.members.map(m => m.id))}`);
  const membersA = await rawQuery('SELECT user_id FROM crew_members WHERE crew_id = $1 ORDER BY seq', [crewA.id]);
  ok(JSON.stringify(membersA.map(r => r.user_id)) === JSON.stringify([owner.id, third.id, pal.id]),
    `the edit landed on the real crew_members table (not the dead data blob), got ${JSON.stringify(membersA.map(r => r.user_id))}`);
}

console.log('\ncrash-safety: a crew migrated on an earlier boot coexists with one that still needs it');
{
  await stop();
  const crewC = await (async () => {
    await boot();
    const c = await post(owner, '/api/crews', { name: 'placeholder C', memberIds: [] }).then(x => x.json());
    await stop();
    return c;
  })();
  await resetCrewToLegacyShape(crewC.id, { id: crewC.id, name: 'Legacy Crew C', ownerId: owner.id, memberIds: [owner.id, pal.id], createdAt: now });
  await boot();

  const membersA = await rawQuery('SELECT user_id FROM crew_members WHERE crew_id = $1 ORDER BY seq', [crewA.id]);
  ok(membersA.length === 3, `crewA (already migrated, untouched this time) is still exactly 3 members, not re-touched, got ${membersA.length}`);
  const membersC = await rawQuery('SELECT user_id FROM crew_members WHERE crew_id = $1 ORDER BY seq', [crewC.id]);
  ok(JSON.stringify(membersC.map(r => r.user_id)) === JSON.stringify([owner.id, pal.id]), `crewC (freshly reset) gets migrated on this boot too, got ${JSON.stringify(membersC.map(r => r.user_id))}`);

  const health = await get(owner, '/healthz');
  ok(health.ok === true, 'server is healthy after all of this');
}

console.log('\nOct 16 2026 (CRITICAL + SEVERE, found independently by both review passes, both reproduced live): a crew backfilled this boot is immediately correct over the API too, not just in Postgres -- and a later edit does not silently revert it');
{
  // The first version of migrateCrewRowColumnsIntoPostgres wrote the sanitized values straight
  // to Postgres but never updated the in-memory DB.crews[id] object, which load() had already
  // populated with the OLD, un-sanitized legacy data earlier in the same boot. Two concrete bad
  // outcomes from that gap, both proven here:
  //   1) a crew whose legacy data was missing `name` rendered NAMELESS over the real API for the
  //      rest of that boot's life, even though Postgres already said "Crew".
  //   2) a crew with duplicate/malformed memberIds in its legacy data kept showing the dirty,
  //      un-deduped list over the real API, AND a later real edit (save(DB) diffing the still-
  //      dirty in-memory object) wrote that dirty name/membership back over the clean columns --
  //      including writing a missing name as literal NULL, which is doLoad()'s own signal for
  //      "not yet migrated," silently un-migrating the row and losing the edit itself on restart.
  const crewF = await post(owner, '/api/crews', { name: 'placeholder F', memberIds: [] }).then(x => x.json());
  await stop();
  // Legacy data missing `name` entirely, AND memberIds with real duplicates (owner appears
  // twice, pal appears twice) -- exactly the two shapes both reviews reproduced.
  await resetCrewToLegacyShape(crewF.id, { id: crewF.id, ownerId: owner.id, memberIds: [owner.id, pal.id, pal.id, owner.id, third.id], createdAt: now });
  await boot();

  const viewRightAfterBoot = await get(owner, `/api/crews/${crewF.id}`);
  ok(viewRightAfterBoot.name === 'Crew', `the backfilled name shows up over the API in THIS SAME boot, not just in Postgres, got ${JSON.stringify(viewRightAfterBoot.name)}`);
  ok(viewRightAfterBoot.members.length === 3 && JSON.stringify(viewRightAfterBoot.members.map(m => m.id)) === JSON.stringify([owner.id, pal.id, third.id]),
    `the member list is already deduped over the API in this same boot (owner, pal, third -- no repeats), got ${JSON.stringify(viewRightAfterBoot.members.map(m => m.id))}`);

  // Now make a real, unrelated edit (rename only) -- the exact trigger that used to silently
  // revert the row to NULL and lose this edit on the next restart.
  const renamed = await fetch(B + `/api/crews/${crewF.id}`, { method: 'PUT', headers: owner.H, body: JSON.stringify({ name: 'Renamed After Backfill' }) }).then(x => x.json());
  ok(renamed.name === 'Renamed After Backfill', `the rename itself succeeds, got ${JSON.stringify(renamed.name)}`);

  await reboot();
  const viewAfterRestart = await get(owner, `/api/crews/${crewF.id}`);
  ok(viewAfterRestart.name === 'Renamed After Backfill', `the rename SURVIVES a restart -- it is not silently reverted to the stale pre-backfill blob, got ${JSON.stringify(viewAfterRestart.name)}`);
  const rowF = await rawQuery('SELECT name FROM crews WHERE id = $1', [crewF.id]);
  ok(rowF[0].name === 'Renamed After Backfill', `and Postgres itself still shows the rename, not NULL (which would mean the row silently un-migrated), got ${JSON.stringify(rowF[0].name)}`);
  const membersAfterRestart = await rawQuery('SELECT user_id FROM crew_members WHERE crew_id = $1 ORDER BY seq', [crewF.id]);
  ok(JSON.stringify(membersAfterRestart.map(r => r.user_id)) === JSON.stringify([owner.id, pal.id, third.id]), `membership stays deduped after the restart too, got ${JSON.stringify(membersAfterRestart.map(r => r.user_id))}`);
}

console.log('\na brand-new crew created AFTER this migration shipped goes straight to the new columns, no backfill needed');
{
  const freshCrew = await post(owner, '/api/crews', { name: 'Brand New Row-Shape Crew', memberIds: [pal.id] }).then(x => x.json());
  const rows = await rawQuery('SELECT name, owner_id FROM crews WHERE id = $1', [freshCrew.id]);
  ok(rows.length === 1 && rows[0].name === 'Brand New Row-Shape Crew' && rows[0].owner_id === owner.id, 'a freshly-created crew already has real columns populated, nothing to backfill');
  const members = await rawQuery('SELECT user_id FROM crew_members WHERE crew_id = $1 ORDER BY seq', [freshCrew.id]);
  ok(JSON.stringify(members.map(r => r.user_id)) === JSON.stringify([owner.id, pal.id]), 'and its crew_members rows are there from creation, in the right order');
}

console.log('\nmalformed/missing legacy data (null data, non-array memberIds, missing createdAt) is backfilled with safe defaults, not a boot-crashing exception');
{
  const crewD = await post(owner, '/api/crews', { name: 'placeholder D', memberIds: [] }).then(x => x.json());
  await stop();
  const pg = new PgConnection(parseConnString(testDb.url));
  await pg.query('UPDATE crews SET name = NULL, owner_id = NULL, created_at = NULL, data = NULL WHERE id = $1', [crewD.id]);
  await pg.query('DELETE FROM crew_members WHERE crew_id = $1', [crewD.id]);
  pg.close();
  await boot();
  ok(!!srv, 'the server boots successfully despite a fully NULL legacy data blob, not crashing on it');
  const rowsD = await rawQuery('SELECT name, owner_id, created_at FROM crews WHERE id = $1', [crewD.id]);
  ok(rowsD.length === 1 && rowsD[0].name === 'Crew' && rowsD[0].owner_id === null && !!rowsD[0].created_at,
    `a crew with no legacy data at all still gets safe defaults (name "Crew", null owner, a real createdAt), got ${JSON.stringify(rowsD[0])}`);
  const membersD = await rawQuery('SELECT user_id FROM crew_members WHERE crew_id = $1', [crewD.id]);
  ok(membersD.length === 0, 'and an empty member list rather than a crash, got ' + membersD.length);

  const crewE = await post(owner, '/api/crews', { name: 'placeholder E', memberIds: [] }).then(x => x.json());
  await stop();
  await resetCrewToLegacyShape(crewE.id, { id: crewE.id, name: 'Legacy Crew E', ownerId: owner.id, memberIds: 'not an array at all', createdAt: now });
  await boot();
  ok(!!srv, 'a non-array memberIds value also does not crash boot');
  const membersE = await rawQuery('SELECT user_id FROM crew_members WHERE crew_id = $1', [crewE.id]);
  ok(membersE.length === 0, 'a malformed memberIds value backfills to an empty member list rather than throwing, got ' + membersE.length);

  const health = await get(owner, '/healthz');
  ok(health.ok === true, 'server is healthy after booting through all of this malformed legacy data');
}

} finally {
  await stop();
  await testDb.drop();
}
console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
