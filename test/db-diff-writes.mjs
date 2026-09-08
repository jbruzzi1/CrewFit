// Proves the Sep 8 2026 "diffed writes" rewrite of db.js actually does what it claims: a
// save() that changes nothing issues ZERO writes to unchanged rows, a save() that changes one
// entity writes ONLY that row, and deletions still work correctly — all without mocking or
// spying on anything. Uses Postgres's own `xmin` system column (the row version / transaction
// id that stamps each physical row version) as ground truth: xmin only changes when a row is
// actually rewritten, so comparing xmin before/after a save() is a DB-level proof of "did this
// row get touched," independent of anything db.js *says* it did.
//
// Also proves the bootstrap fallback: a save() with no prior load() in-process (lastPersisted
// still null) falls back to the old full-table behavior and correctly seeds the baseline, so
// the very next save() in the same process diffs correctly against it.
import { freshTestDb } from './_pgtestdb.mjs';

const testDb = await freshTestDb('diffwrites');
process.env.DATABASE_URL = testDb.url;
const db = (await import('../db.js')).default;

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };

// xmin per row, keyed by id, for a given table.
async function xmins(table, keyCol) {
  const r = await db.getConn().query(`SELECT ${keyCol} as k, xmin::text as x FROM ${table}`);
  const map = {};
  for (const row of r.rows) map[row.k] = row.x;
  return map;
}

try {

console.log('bootstrap save() (no load() first) seeds the baseline correctly');
{
  // Mirrors scripts/migrate-to-postgres.mjs's real usage: it calls ensureSchema() itself before
  // its first save() (which happens before any load() in-process), since there's no load() call
  // to have created the tables yet.
  await db.ensureSchema();
  const d = db.EMPTY_DB();
  d.users['u1'] = { id: 'u1', username: 'alice', displayName: 'Alice' };
  d.users['u2'] = { id: 'u2', username: 'bob', displayName: 'Bob' };
  d.sessions['s1'] = { id: 's1', name: 'Leg Day', exercises: [] };
  await db.save(d); // lastPersisted was null going in -> this is the bootstrap path
  const rows = await db.getConn().query('SELECT id FROM users ORDER BY id');
  ok(rows.rows.length === 2, `both users landed via the bootstrap save (got ${rows.rows.length})`);
}

console.log('\na no-op save() (nothing changed) touches ZERO rows');
{
  const d = db.EMPTY_DB();
  d.users['u1'] = { id: 'u1', username: 'alice', displayName: 'Alice' };
  d.users['u2'] = { id: 'u2', username: 'bob', displayName: 'Bob' };
  d.sessions['s1'] = { id: 's1', name: 'Leg Day', exercises: [] };

  const before = await xmins('users', 'id');
  const beforeSessions = await xmins('sessions', 'id');
  await db.save(d); // identical to what's already there
  const after = await xmins('users', 'id');
  const afterSessions = await xmins('sessions', 'id');

  ok(before.u1 === after.u1, `u1's xmin unchanged by a no-op save (before=${before.u1} after=${after.u1})`);
  ok(before.u2 === after.u2, `u2's xmin unchanged by a no-op save (before=${before.u2} after=${after.u2})`);
  ok(beforeSessions.s1 === afterSessions.s1, `s1's xmin unchanged by a no-op save (before=${beforeSessions.s1} after=${afterSessions.s1})`);
}

console.log('\na save() that changes ONE entity rewrites ONLY that row');
{
  const before = await xmins('users', 'id');
  const beforeSessions = await xmins('sessions', 'id');

  const d = db.EMPTY_DB();
  d.users['u1'] = { id: 'u1', username: 'alice', displayName: 'Alice Updated' }; // changed
  d.users['u2'] = { id: 'u2', username: 'bob', displayName: 'Bob' }; // unchanged
  d.sessions['s1'] = { id: 's1', name: 'Leg Day', exercises: [] }; // unchanged
  await db.save(d);

  const after = await xmins('users', 'id');
  const afterSessions = await xmins('sessions', 'id');
  ok(before.u1 !== after.u1, `u1's xmin CHANGED after its own displayName changed (before=${before.u1} after=${after.u1})`);
  ok(before.u2 === after.u2, `u2's xmin unchanged even though u1 changed in the same save() (before=${before.u2} after=${after.u2})`);
  ok(beforeSessions.s1 === afterSessions.s1, `s1's xmin unchanged, untouched collection in this save() (before=${beforeSessions.s1} after=${afterSessions.s1})`);
}

console.log('\ndeleting an entity (diff path) actually deletes the row, no ghost, no round trip needed to find it');
{
  const d = db.EMPTY_DB();
  d.users['u1'] = { id: 'u1', username: 'alice', displayName: 'Alice Updated' };
  // u2 omitted entirely -> should be deleted
  d.sessions['s1'] = { id: 's1', name: 'Leg Day', exercises: [] };
  await db.save(d);
  const rows = await db.getConn().query('SELECT id FROM users ORDER BY id');
  ok(rows.rows.length === 1 && rows.rows[0].id === 'u1', `u2 deleted, only u1 remains (got ${JSON.stringify(rows.rows.map(r => r.id))})`);
}

console.log('\nload() re-establishes the baseline from real Postgres state, and the next save() diffs correctly against it');
{
  const reloaded = await db.load(); // fresh baseline straight from Postgres's own row text
  ok(Object.keys(reloaded.users).length === 1, `load() sees exactly the one remaining user (got ${Object.keys(reloaded.users).length})`);

  const before = await xmins('users', 'id');
  await db.save(reloaded); // identical to what load() just returned -> should be a true no-op
  const after = await xmins('users', 'id');
  ok(before.u1 === after.u1, `save() right after load() with no changes is still a no-op (before=${before.u1} after=${after.u1})`);
}

console.log('\na FAILED save() does not advance the diff baseline (next save() still knows the real state)');
{
  const before = await xmins('users', 'id');
  const origQuery = db.getConn().query.bind(db.getConn());
  db.getConn().query = async (sql, params) => {
    if (sql.includes('INSERT INTO sessions')) throw new Error('simulated failure');
    return origQuery(sql, params);
  };
  const d = db.EMPTY_DB();
  d.users['u1'] = { id: 'u1', username: 'alice', displayName: 'Alice Updated Again' }; // real change
  d.sessions['s1'] = { id: 's1', name: 'Leg Day CHANGED', exercises: [] }; // triggers the simulated failure
  let threw = false;
  try { await db.save(d); } catch (e) { threw = true; }
  db.getConn().query = origQuery;
  ok(threw, 'the simulated mid-save failure propagated');

  const afterFailedSave = await xmins('users', 'id');
  ok(before.u1 === afterFailedSave.u1, `u1's row was rolled back, not left half-written (before=${before.u1} after=${afterFailedSave.u1})`);

  // Now retry with the SAME change, no simulated failure this time -- if the baseline had
  // wrongly advanced despite the rollback, this save would wrongly think u1 was already
  // "Alice Updated Again" and skip writing it, which would be silent data loss.
  const d2 = db.EMPTY_DB();
  d2.users['u1'] = { id: 'u1', username: 'alice', displayName: 'Alice Updated Again' };
  d2.sessions['s1'] = { id: 's1', name: 'Leg Day CHANGED', exercises: [] };
  await db.save(d2);
  const reloadedAfterRetry = await db.load();
  ok(reloadedAfterRetry.users.u1.displayName === 'Alice Updated Again', `retried save() actually landed the change that failed the first time (got "${reloadedAfterRetry.users.u1.displayName}")`);
  ok(reloadedAfterRetry.sessions.s1.name === 'Leg Day CHANGED', `retried save() also landed the session change (got "${reloadedAfterRetry.sessions.s1.name}")`);
}

console.log('\na concurrent load() cannot dirty-read an in-flight save()\'s uncommitted transaction (regression: cold-review, Sep 8 2026)');
{
  // Reproduces the race a cold-review pass found: without load() sharing save()'s
  // serialization queue, a load() firing while a save() is mid-transaction could read that
  // save()'s UNCOMMITTED row straight off the wire, adopt it as the new diff baseline, and then
  // -- once the save() it came from failed and rolled back -- a later, genuinely successful
  // save() of that same value would diff against the poisoned baseline, see "no change," and
  // silently never write it. Fixed by routing load() through the same opQueue as save().
  const before = await db.load();
  ok(before.users.u1.displayName === 'Alice Updated Again', `sanity: starting state is what the previous block left (got "${before.users.u1.displayName}")`);

  const origQuery = db.getConn().query.bind(db.getConn());
  db.getConn().query = async (sql, params) => {
    // Let the users UPSERT land (uncommitted, inside the open transaction), then blow up on the
    // very next collection's write -- mirrors the reviewer's repro of a save() that's dirtied a
    // row but hasn't committed or rolled back yet.
    if (sql.includes('INSERT INTO sessions')) throw new Error('simulated failure after a dirty, uncommitted users write');
    return origQuery(sql, params);
  };

  const dirty = db.EMPTY_DB();
  dirty.users['u1'] = { id: 'u1', username: 'alice', displayName: 'DIRTY-UNCOMMITTED' };
  dirty.sessions['s1'] = { id: 's1', name: 'this write triggers the simulated failure', exercises: [] };

  // Fire both without awaiting the first -- if load() were NOT queued behind save(), this is
  // exactly the interleaving that could let it observe the uncommitted row.
  const savePromise = db.save(dirty).catch(e => ({ threw: true, message: e.message }));
  const loadPromise = db.load();
  const [saveResult, concurrentLoad] = await Promise.all([savePromise, loadPromise]);

  db.getConn().query = origQuery;
  ok(saveResult && saveResult.threw, 'the simulated mid-save failure propagated as expected');
  ok(concurrentLoad.users.u1.displayName !== 'DIRTY-UNCOMMITTED', `the concurrent load() never observed the uncommitted value (got "${concurrentLoad.users.u1.displayName}")`);
  ok(concurrentLoad.users.u1.displayName === 'Alice Updated Again', `the concurrent load() saw the real, committed, pre-save value instead (got "${concurrentLoad.users.u1.displayName}")`);

  // And confirm the baseline wasn't poisoned: a save() that legitimately writes the SAME value
  // the failed save() attempted must still actually reach Postgres, not get diffed away.
  const retry = db.EMPTY_DB();
  retry.users['u1'] = { id: 'u1', username: 'alice', displayName: 'DIRTY-UNCOMMITTED' };
  retry.sessions['s1'] = { id: 's1', name: 'Leg Day CHANGED', exercises: [] };
  await db.save(retry);
  const after = await db.load();
  ok(after.users.u1.displayName === 'DIRTY-UNCOMMITTED', `a legitimate later save() of the same value actually lands, baseline was not poisoned (got "${after.users.u1.displayName}")`);
}

console.log('\nall three boot-migration singleton flags round-trip (not just followApprovalV1)');
{
  const d = db.EMPTY_DB();
  d.users = (await db.load()).users;
  d.followApprovalV1 = true;
  d.friendsRetiredV1 = true;
  d.binaryVisibilityV1 = true;
  await db.save(d);
  const reloaded = await db.load();
  ok(reloaded.followApprovalV1 === true, `followApprovalV1 round-tripped (got ${reloaded.followApprovalV1})`);
  ok(reloaded.friendsRetiredV1 === true, `friendsRetiredV1 round-tripped -- regression: this used to be silently dropped every save() (got ${reloaded.friendsRetiredV1})`);
  ok(reloaded.binaryVisibilityV1 === true, `binaryVisibilityV1 round-tripped -- regression: this used to be silently dropped every save() (got ${reloaded.binaryVisibilityV1})`);
}

} finally {
  db.close();
  await testDb.drop();
}

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
