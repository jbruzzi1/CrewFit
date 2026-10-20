// Oct 16 2026 (crews deep-dive, decision #1 -- messages/challenges moved to their own tables, Jeff:
// "good to go ahead"). Ground-truth differential check for migrateCrewMessagesAndChallengesIntoPostgres,
// the boot migration that flattens a crew's OLD embedded `messages`/`challenges` arrays (the shape
// every crew had before this migration) into the NEW crew_messages/crew_challenges tables (one row
// per item) -- same technique as test/pushsubs-customex-reports-migration-differential.mjs and
// test/notifications-feed-migration-differential.mjs: drive the real server through its real HTTP
// routes, patch real rows directly in Postgres to simulate the OLD pre-migration shape (there is no
// way to get a brand-new crew into that shape through the live API any more -- every route that
// could have written c.messages/c.challenges was cut over in the same change that added this
// migration), then reboot and check the HTTP-visible result and the new tables' own raw rows.
//
// Updated Oct 16 2026 for decision #2 (crew-row normalization, same slice, same day): patchCrewRow
// below now rebuilds a crew's CURRENT real-column state into a full legacy-shaped object, applies
// the mutator, then nulls the real columns and deletes its crew_members rows -- so the row looks
// exactly like a genuine row that predates BOTH migrations, which is the only way to get one any
// more (a crew created through today's real API never has a `data` blob to patch into directly).
// It also means the raw `data` column stops being a meaningful "is this cleaned up" check once a
// row is column-migrated: decision #2's save path (syncCrewsFull/syncCrewsDiff) never writes `data`
// again, so it permanently keeps whatever stale content was last written there, old embedded
// messages/challenges fields included. Checks that used to read the raw blob for "the old fields
// are gone" now check the HTTP-visible result instead, which is what actually matters and is what
// decision #1's own migration comment in server.js actually promises.
//
// Three things this migration's own comment in server.js promises, each proven here rather than
// just trusted:
//   - lossless: every embedded message/challenge actually lands in the new table, with its content
//     intact, and the API no longer serves the old embedded fields afterward.
//   - idempotent: running it again (a second boot against the same, already-migrated database) is a
//     true no-op -- no duplicate rows, no content change.
//   - crash-safe: a crew migrated on an earlier boot and a crew NOT yet migrated can coexist in the
//     same database (simulating an interrupted boot that got through some crews but not others) --
//     the next boot only touches the unmigrated one, and doesn't duplicate or corrupt the
//     already-migrated one.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';
import { PgConnection, parseConnString } from '../pgmini.js';

const PORT = 5901, B = `http://localhost:${PORT}`;
const DIR = mkdtempSync(join(tmpdir(), 'crew-migrate-diff-'));
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('crewmigratediff');
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
    body: JSON.stringify({ ageConfirmed: true, username: n, pin: 'pass1234', displayName: n }) }).then(x => x.json());
  if (!r.token) throw new Error('register failed: ' + JSON.stringify(r));
  return { id: r.user.id, token: r.token, H: { ...J, Authorization: 'Bearer ' + r.token } };
}
const get = (who, p) => fetch(B + p, { headers: who.H }).then(r => r.json());
const post = (who, p, body) => fetch(B + p, { method: 'POST', headers: who.H, body: JSON.stringify(body || {}) });
const connect = (owner, friend) => post(owner, `/api/follow/${friend.id}`);

// Directly patches a crew's row in Postgres while the server is down, the same stop/patch/reboot
// shape test/crews.mjs's withCrewChallengesDb (and test/streak-reminders.mjs's own history-
// backdating helper) uses -- the server only ever reads from Postgres at boot, so faking the OLD
// pre-migration shape has to happen out from under it.
//
// Updated Oct 16 2026 for decision #2 (crew-row normalization): a crew created through today's
// real API is column-only from birth -- it has no `data` blob at all to read and patch the way
// this used to. So this now rebuilds the crew's CURRENT real-column state (name/owner_id/
// created_at + crew_members) into a full legacy-shaped object first, lets the mutator add its
// messages/challenges on top of that, writes the result into `data`, and then explicitly nulls
// the real columns and deletes the crew_members rows -- producing a row that looks exactly like
// one that predates BOTH decision #1 and decision #2, which is the only shape that still lets
// doLoad()'s pre-migration fallback path feed a full legacy object (with .messages/.challenges
// populated) into migrateCrewMessagesAndChallengesIntoPostgres, same as before either migration
// existed.
async function patchCrewRow(crewId, mutator) {
  const pg = new PgConnection(parseConnString(testDb.url));
  const rowR = await pg.query('SELECT name, owner_id, created_at FROM crews WHERE id = $1', [crewId]);
  const row = rowR.rows[0];
  const membersR = await pg.query('SELECT user_id FROM crew_members WHERE crew_id = $1 ORDER BY seq', [crewId]);
  const data = {
    id: crewId,
    name: row.name,
    ownerId: row.owner_id,
    memberIds: membersR.rows.map(m => m.user_id),
    createdAt: row.created_at,
  };
  mutator(data);
  await pg.query(
    'UPDATE crews SET data = $1::jsonb, name = NULL, owner_id = NULL, created_at = NULL WHERE id = $2',
    [JSON.stringify(data), crewId]
  );
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

console.log('setup: two crews, each with an old-style embedded messages/challenges shape patched in directly');
const owner = await reg('migowner1'), pal = await reg('migpal1');
await connect(owner, pal);
const crewA = await post(owner, '/api/crews', { name: 'Legacy Crew A', memberIds: [pal.id] }).then(x => x.json());
const crewB = await post(owner, '/api/crews', { name: 'Legacy Crew B', memberIds: [pal.id] }).then(x => x.json());
ok(!!crewA.id && !!crewB.id, 'both crews created through the real API');

await stop();
// crewA: the full old shape -- two messages (one real, one a pre-existing system/celebration
// message with userId:null, exactly like checkChallengeCompletion used to leave behind) and two
// challenges (one completed, one -- deliberately -- the one that would be "running" under the old
// runningChallenge() definition, so the migration's correctness doesn't depend on which slot in
// the array is "last").
const now = new Date().toISOString();
const todayStr = now.slice(0, 10);
await patchCrewRow(crewA.id, data => {
  data.messages = [
    { id: 'cm_legacy_a1', userId: owner.id, text: 'legacy message one', at: now },
    { id: 'cm_legacy_a2', userId: null, system: true, text: '🎉 legacy celebration', at: now },
  ];
  data.challenges = [
    { id: 'chal_legacy_a1', type: 'workouts', target: 3, startDate: todayStr, endDate: todayStr, createdBy: owner.id, createdAt: new Date(Date.now() - 1000).toISOString(), completedAt: now },
    { id: 'chal_legacy_a2', type: 'sets', target: 10, startDate: todayStr, endDate: todayStr, createdBy: owner.id, createdAt: now, completedAt: null },
  ];
});
// crewB: just one message, no challenges at all -- the "has one collection but not the other"
// shape, and also acts as the SECOND crew for the idempotency/partial-migration checks below.
await patchCrewRow(crewB.id, data => {
  data.messages = [{ id: 'cm_legacy_b1', userId: pal.id, text: 'legacy message in crew B', at: now }];
});

console.log('\nfirst boot after patching: the migration flattens both crews losslessly');
await boot();
{
  const msgsA = await rawQuery('SELECT id, crew_id, data FROM crew_messages WHERE crew_id = $1 ORDER BY id', [crewA.id]);
  ok(msgsA.length === 2, `crewA: both legacy messages landed in crew_messages, got ${msgsA.length}`);
  const a1 = msgsA.find(r => r.id === 'cm_legacy_a1');
  ok(!!a1 && JSON.parse(a1.data).text === 'legacy message one', 'crewA message 1 content intact');
  const a2 = msgsA.find(r => r.id === 'cm_legacy_a2');
  ok(!!a2 && JSON.parse(a2.data).system === true && JSON.parse(a2.data).userId === null, 'crewA system/celebration message migrated with its userId:null and system:true intact');

  const chalA = await rawQuery('SELECT id, crew_id, data FROM crew_challenges WHERE crew_id = $1 ORDER BY id', [crewA.id]);
  ok(chalA.length === 2, `crewA: both legacy challenges landed in crew_challenges, got ${chalA.length}`);
  const c1 = JSON.parse(chalA.find(r => r.id === 'chal_legacy_a1').data);
  ok(c1.completedAt === now && c1.target === 3, 'crewA completed challenge content intact');
  const c2 = JSON.parse(chalA.find(r => r.id === 'chal_legacy_a2').data);
  ok(c2.completedAt === null && c2.type === 'sets', 'crewA still-running challenge content intact');

  const msgsB = await rawQuery('SELECT id, crew_id, data FROM crew_messages WHERE crew_id = $1', [crewB.id]);
  ok(msgsB.length === 1 && JSON.parse(msgsB[0].data).text === 'legacy message in crew B', `crewB: its one legacy message landed too, got ${msgsB.length}`);
  const chalB = await rawQuery('SELECT id FROM crew_challenges WHERE crew_id = $1', [crewB.id]);
  ok(chalB.length === 0, 'crewB had no legacy challenges to migrate, and none were invented');

  // Decision #2 (crew-row normalization, same day) means the raw `data` column is never written
  // again once a row is column-migrated -- save() only touches name/owner_id/created_at/
  // crew_members from here on -- so checking the raw blob for "messages/challenges are gone" is
  // no longer a meaningful signal (see the top-of-file comment). What actually matters is that
  // the API no longer serves the old embedded shape, checked right here instead.
  const viewA = await get(owner, `/api/crews/${crewA.id}`);
  ok(viewA.challenge && viewA.challenge.id === 'chal_legacy_a2', `GET /api/crews/:id shows the still-running legacy challenge as the current one, got ${JSON.stringify(viewA.challenge && viewA.challenge.id)}`);
  ok(viewA.challengesCompleted === 1, `the completed legacy challenge counts toward challengesCompleted, got ${viewA.challengesCompleted}`);
  const apiMsgsA = await get(owner, `/api/crews/${crewA.id}/messages`);
  ok(apiMsgsA.length === 2 && apiMsgsA.some(m => m.id === 'cm_legacy_a1') && apiMsgsA.some(m => m.id === 'cm_legacy_a2'), `GET .../messages shows both migrated legacy messages, got ${JSON.stringify(apiMsgsA.map(m => m.id))}`);
  const apiMsgsB = await get(owner, `/api/crews/${crewB.id}/messages`);
  ok(apiMsgsB.length === 1 && apiMsgsB[0].id === 'cm_legacy_b1', `crewB: GET .../messages shows its one migrated legacy message too, got ${JSON.stringify(apiMsgsB.map(m => m.id))}`);
}

console.log('\nsecond boot (nothing left to migrate): running it again is a true no-op, not a duplication');
await reboot();
{
  const msgsA = await rawQuery('SELECT id FROM crew_messages WHERE crew_id = $1', [crewA.id]);
  ok(msgsA.length === 2, `crewA still has exactly 2 messages after a second boot, not 4, got ${msgsA.length}`);
  const chalA = await rawQuery('SELECT id FROM crew_challenges WHERE crew_id = $1', [crewA.id]);
  ok(chalA.length === 2, `crewA still has exactly 2 challenges after a second boot, not 4, got ${chalA.length}`);
  const msgsB = await rawQuery('SELECT id FROM crew_messages WHERE crew_id = $1', [crewB.id]);
  ok(msgsB.length === 1, `crewB still has exactly 1 message after a second boot, not 2, got ${msgsB.length}`);
}

console.log('\ncrash-safety: a crew migrated on an earlier boot coexists with one that never got the old fields removed');
{
  // Simulates an interrupted boot that got through crewA (already flattened, fields already
  // deleted -- the state from the first boot above) but never got to crewB: patch crewB BACK to
  // having embedded fields (as if that earlier boot's loop had reached it with fresh, not-yet-seen
  // data -- a brand new message posted into the OLD shape, hypothetically, right before a crash)
  // while crewA is left exactly as the self-healing migration already settled it.
  await stop();
  await patchCrewRow(crewB.id, data => {
    data.messages = [{ id: 'cm_legacy_b1', userId: pal.id, text: 'legacy message in crew B', at: now },
      { id: 'cm_legacy_b2', userId: owner.id, text: 'a second legacy message, added after the first boot', at: now }];
  });
  await boot();

  const msgsA = await rawQuery('SELECT id FROM crew_messages WHERE crew_id = $1', [crewA.id]);
  ok(msgsA.length === 2, `crewA (already migrated, untouched this time) is still exactly 2 messages, not re-duplicated, got ${msgsA.length}`);
  const msgsB = await rawQuery('SELECT id FROM crew_messages WHERE crew_id = $1 ORDER BY id', [crewB.id]);
  ok(msgsB.length === 2, `crewB (freshly re-patched with embedded fields) picks up BOTH messages on this boot, got ${msgsB.length}`);
  ok(msgsB.some(r => r.id === 'cm_legacy_b1') && msgsB.some(r => r.id === 'cm_legacy_b2'), 'including the one that was already there before, upserted idempotently rather than skipped or duplicated');

  const apiMsgsB2 = await get(owner, `/api/crews/${crewB.id}/messages`);
  ok(apiMsgsB2.length === 2, `crewB shows both messages over the API after this boot too (not the raw, now-permanently-stale data column), got ${apiMsgsB2.length}`);

  const health = await get(owner, '/healthz');
  ok(health.ok === true, 'server is healthy after all of this');
}

console.log('\na brand-new crew created AFTER this migration shipped never has embedded fields to begin with');
{
  const freshCrew = await post(owner, '/api/crews', { name: 'Brand New', memberIds: [] }).then(x => x.json());
  // Decision #2 (crew-row normalization, same day) makes this an even stronger claim than before:
  // a crew created through today's real API is column-only from birth (see CREWS_ROW_UPSERT_SQL
  // in db.js) -- it never gets a `data` blob at all, not just one that happens to lack these two
  // keys. Confirm that directly, rather than JSON.parse-ing a column that's genuinely SQL NULL.
  const raw = await rawQuery('SELECT data FROM crews WHERE id = $1', [freshCrew.id]);
  ok(raw[0].data === null, `a freshly-created crew's row has no data blob at all (column-only from birth), got ${JSON.stringify(raw[0].data)}`);
  const apiMsgs = await get(owner, `/api/crews/${freshCrew.id}/messages`);
  ok(Array.isArray(apiMsgs) && apiMsgs.length === 0, 'and the API correctly shows zero messages/challenges for it');
}

console.log('\na malformed legacy entry (null, or missing an id) is skipped, not a boot-crashing exception');
{
  // Oct 16 2026 (adversarial review finding, CRITICAL, reproduced live). The first version of
  // migrateCrewMessagesAndChallengesIntoPostgres handed every legacy array entry straight to
  // pgInsertCrewMessage/pgUpsertCrewChallenge with no shape check. crew_messages.id/
  // crew_challenges.id are NOT NULL primary keys -- a `null` entry, or one missing `id`, threw a
  // raw Postgres constraint error that propagated straight through this boot IIFE's own top-level
  // `.catch(e => ... process.exit(1))`, taking the WHOLE server down on every restart (the exact
  // "one bad row stops the server booting, permanently" failure mode CLAUDE.md hard rule #7 was
  // written after). This proves the fix: a crew with a mix of well-formed AND malformed entries
  // still boots, still migrates every well-formed one, and just skips the bad ones.
  const crewC = await post(owner, '/api/crews', { name: 'Malformed Legacy Crew', memberIds: [pal.id] }).then(x => x.json());
  await stop();
  await patchCrewRow(crewC.id, data => {
    data.messages = [
      { id: 'cm_malformed_ok1', userId: owner.id, text: 'a perfectly fine legacy message', at: now },
      null,
      { userId: pal.id, text: 'missing an id entirely', at: now },
    ];
    data.challenges = [
      { id: 'chal_malformed_ok1', type: 'workouts', target: 5, startDate: todayStr, endDate: todayStr, createdBy: owner.id, createdAt: now, completedAt: null },
      'not even an object',
    ];
  });
  await boot();
  ok(!!srv, 'the server boots successfully despite the malformed legacy entries, not crashing on them');

  const msgsC = await rawQuery('SELECT id FROM crew_messages WHERE crew_id = $1', [crewC.id]);
  ok(msgsC.length === 1 && msgsC[0].id === 'cm_malformed_ok1', `only the one well-formed legacy message was migrated, the malformed ones were skipped (not crashed on), got ${JSON.stringify(msgsC.map(r => r.id))}`);
  const chalC = await rawQuery('SELECT id FROM crew_challenges WHERE crew_id = $1', [crewC.id]);
  ok(chalC.length === 1 && chalC[0].id === 'chal_malformed_ok1', `only the one well-formed legacy challenge was migrated, got ${JSON.stringify(chalC.map(r => r.id))}`);

  const apiMsgsC = await get(owner, `/api/crews/${crewC.id}/messages`);
  ok(apiMsgsC.length === 1 && apiMsgsC[0].id === 'cm_malformed_ok1', `the API shows only the one well-formed migrated message for crewC too, got ${JSON.stringify(apiMsgsC.map(m => m.id))}`);

  const health = await get(owner, '/healthz');
  ok(health.ok === true, 'server is healthy after booting through the malformed legacy data');
}

} finally {
  await stop();
  await testDb.drop();
}
console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
