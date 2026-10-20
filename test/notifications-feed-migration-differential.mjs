// Oct 13 2026 (rearchitecture, notifications+feed-events slice, see CLAUDE.md "Rearchitecture
// status" / "Rearchitecture safeguards"). Originally written during the dual-write + shadow-
// compare phase (task #245), when GET /api/notifications/GET /api/feed still served from the old
// in-memory DB.notifications/DB.feedEvents maps and this test's job was proving the new, parallel
// Postgres write path (db.js's pgInsertNotification/pgMergedNotificationWrite/etc) agreed with
// them. The READ CUTOVER (task #247/#251/#252) has since removed those in-memory maps entirely --
// GET /api/notifications and GET /api/feed now read directly from Postgres via the exact same
// pgNotificationHistoryForUser/pgFeedEventsSince functions this test calls independently. So the
// "old path" (hitting the real HTTP route) and "new path" (calling the db.js function directly,
// from this test's own separate process/connection) are no longer "in-memory vs Postgres" --
// they're now two independent reads of the SAME Postgres tables, one through the live server's
// connection, one through a second connection this test opens itself. That's still a real,
// meaningful ground-truth check: it proves (a) the live HTTP routes under real concurrent traffic
// produce correct merged/toggled/deleted results, not just that the underlying SQL functions do
// in isolation, and (b) a second, independent connection sees the exact same committed rows the
// server's own connection does -- cross-connection consistency, not a driver- or process-local
// illusion of correctness. The "old path"/"new path" labels below are kept (renaming every single
// assertion string felt like needless churn for a label that still accurately describes WHICH
// read each assertion is checking), but they no longer mean two different storage mechanisms --
// both are Postgres now.
//
// The transient-disagreement note this comment used to have (about dual-write being fire-and-
// forget, so the new table could lag a few ms behind) mostly no longer applies, but not entirely
// -- worth being precise here after a correctness-review finding caught an earlier draft of this
// comment overstating it. emitFeedEvent/notify/groupedHistoryWrite's calls are all still
// `await`ed by their callers for ORDERING on the happy path (so by the time a response comes
// back, a successful write has already committed) -- but all three now treat a Postgres failure
// as best-effort/non-fatal (notify/groupedHistoryWrite always have; emitFeedEvent was changed
// back to this same policy the same day, see its own comment in server.js, after an adversarial
// review reproduced a worse problem with letting it throw). So on the FAILURE path there is no
// write to observe at all, ever -- not a timing race, a permanent absence, logged to the server
// console and nowhere else. pollUntil() below is kept purely as insurance against ordinary cross-
// connection timing jitter on the happy path, not because a real race is expected -- it will
// still correctly time out and report a mismatch if a write genuinely never lands.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';

const PORT = 4979, B = `http://localhost:${PORT}`;
const DIR = mkdtempSync(join(tmpdir(), 'notif-feed-diff-'));
const J = { 'Content-Type': 'application/json' };
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('notiffeeddiff');
let srv, fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const H = t => ({ ...J, Authorization: 'Bearer ' + t });
const post = (p, b, t) => fetch(B + p, { method: 'POST', headers: t ? H(t) : J, body: JSON.stringify(b) });
const put  = (p, b, t) => fetch(B + p, { method: 'PUT', headers: t ? H(t) : J, body: JSON.stringify(b) });
const del  = (p, t) => fetch(B + p, { method: 'DELETE', headers: H(t) });
const get  = (p, t) => fetch(B + p, { headers: H(t) });
process.on('exit', () => { try { srv && srv.kill(); } catch {} try { rmSync(DIR, { recursive: true, force: true }); } catch {} });

await new Promise(res => {
  srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: DIR, DATABASE_URL: testDb.url, PORT: String(PORT) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stdout.on('data', d => { if (String(d).includes('CrewFit on')) res(); });
  setTimeout(res, 8000);
});
ok(!!srv, 'server boots');

// A second, independent connection to the SAME Postgres database the spawned server is using --
// same DATABASE_URL, a different OS process than the server's own single connection (see this
// file's header comment for why this is no longer "old vs new storage," just two readers of one
// table now).
process.env.DATABASE_URL = testDb.url;
const db = await import('../db.js');

// The existing process.on('exit', ...) above already kills srv and removes DIR on any exit path
// (including an uncaught exception/rejection), closing the hardcoded-PORT orphan risk -- but it
// has no async cleanup for this second db.js connection or the throwaway test database, so add
// just that here, scoped to the two resources the exit handler can't touch.
let cleanedUp = false;
async function cleanupAsync() {
  if (cleanedUp) return; cleanedUp = true;
  try { db.close(); } catch {}
  try { await testDb.drop(); } catch {}
}
process.on('uncaughtException', async (e) => { console.error('UNCAUGHT', e); await cleanupAsync(); process.exit(1); });
process.on('unhandledRejection', async (e) => { console.error('UNHANDLED', e); await cleanupAsync(); process.exit(1); });

// Polls this second connection's own read until it agrees with what the HTTP route already
// returned, or gives up after ~2s -- see this file's header comment: no real race is expected
// post-cutover, this is just insurance against ordinary cross-connection timing jitter.
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

const alice = await post('/api/register', { ageConfirmed: true, username: 'alice', pin: 'pass1234', displayName: 'Alice' }).then(r => r.json());
const bob   = await post('/api/register', { ageConfirmed: true, username: 'bob',   pin: 'pass1234', displayName: 'Bob' }).then(r => r.json());

console.log('\na simple notify() (follow) -- the new table gets the exact same row, same id, as the old one');
{
  await post('/api/follow/' + bob.user.id, {}, alice.token);
  const notifs = await get('/api/notifications', bob.token).then(r => r.json());
  const oldRow = notifs.history.find(h => /started following/i.test(h.body));
  ok(!!oldRow, `old path shows the new-follower notification (saw: ${JSON.stringify(notifs.history)})`);

  const cutoff = Date.now() - 7 * 86400000;
  const pgRows = await pollUntil(
    () => db.pgNotificationHistoryForUser(bob.user.id, new Date(cutoff).toISOString()),
    rows => rows.some(r => r.id === oldRow.id)
  );
  const pgRow = pgRows.find(r => r.id === oldRow.id);
  ok(!!pgRow, `new path's table has a row with the SAME id the old path returned (saw ids: ${pgRows.map(r=>r.id).join(',')})`);
  ok(pgRow && pgRow.title === oldRow.title && pgRow.body === oldRow.body && JSON.stringify(pgRow.link || null) === JSON.stringify(oldRow.link || null),
    `and its content matches exactly (title/body/link) -- old: ${JSON.stringify(oldRow)}, new: ${JSON.stringify(pgRow)}`);
}

console.log('\nthe raw feed_events row behind a real emitFeedEvent() call (started_following) matches between old and new');
{
  // bob follows alice back (she's public by default -- see /api/follow's own branch), which both
  // notify()s alice AND emits a real feed event attributed to bob.
  await post('/api/follow/' + alice.user.id, {}, bob.token);
  const feed = await get('/api/feed', alice.token).then(r => r.json());
  const oldEv = feed.find(f => f.type === 'started_following' && f.by === bob.user.id);
  ok(!!oldEv, `old path's feed shows bob's started_following event (saw types: ${feed.map(f=>f.type).join(',')})`);

  const weekAgo = Date.now() - 8 * 86400000;
  const pgRows = await pollUntil(
    () => db.pgFeedEventsSince(new Date(weekAgo).toISOString()),
    rows => rows.some(r => r.id === oldEv.id)
  );
  const pgEv = pgRows.find(r => r.id === oldEv.id);
  ok(!!pgEv, `new table has the same feed_events row by id (saw ids: ${pgRows.map(r=>r.id).join(',')})`);
  ok(pgEv && pgEv.type === oldEv.type && pgEv.by === oldEv.by && pgEv.targetId === oldEv.targetId,
    `and its fields match (type/by/targetId) -- old: ${JSON.stringify(oldEv)}, new: ${JSON.stringify(pgEv)}`);
}

console.log('\nreal concurrent HTTP requests -- the grouped-notification merge race, driven through POST /api/crews/:id/messages, not a raw SQL script');
{
  // A 5-member crew: carol is the one who'll receive every other member's crew-chat message as a
  // SINGLE grouped notification (groupKey `crew:<id>:chat`) -- the exact race the pre-mortem
  // flagged (see db.js's long comment on pgMergedNotificationWrite), now exercised through the
  // real route instead of an isolated script calling the SQL directly.
  const carol = await post('/api/register', { ageConfirmed: true, username: 'carol', pin: 'pass1234', displayName: 'Carol' }).then(r => r.json());
  const dave  = await post('/api/register', { ageConfirmed: true, username: 'dave',  pin: 'pass1234', displayName: 'Dave' }).then(r => r.json());
  const erin  = await post('/api/register', { ageConfirmed: true, username: 'erin',  pin: 'pass1234', displayName: 'Erin' }).then(r => r.json());
  const frank = await post('/api/register', { ageConfirmed: true, username: 'frank', pin: 'pass1234', displayName: 'Frank' }).then(r => r.json());
  // Crew membership requires being one of the owner's connections (validCrewMemberIds) -- all
  // profiles are public by default, so a one-directional follow from alice is enough.
  for (const u of [carol, dave, erin, frank]) await post('/api/follow/' + u.user.id, {}, alice.token);

  const crew = await post('/api/crews', { name: 'Race Crew', memberIds: [carol.user.id, dave.user.id, erin.user.id, frank.user.id] }, alice.token).then(r => r.json());

  // 4 genuinely concurrent senders (dave/erin/frank, and alice herself -- carol is the lone
  // recipient we're checking) each posting one message at the same moment.
  await Promise.all([
    post(`/api/crews/${crew.id}/messages`, { text: 'hey from alice' }, alice.token),
    post(`/api/crews/${crew.id}/messages`, { text: 'hey from dave' }, dave.token),
    post(`/api/crews/${crew.id}/messages`, { text: 'hey from erin' }, erin.token),
    post(`/api/crews/${crew.id}/messages`, { text: 'hey from frank' }, frank.token),
  ]);

  const carolNotifs = await get('/api/notifications', carol.token).then(r => r.json());
  const groupRows = carolNotifs.history.filter(h => /comment(s|ed)? (in|on) Race Crew/i.test(h.body));
  ok(groupRows.length === 1, `old path: exactly ONE grouped row for carol after 4 concurrent crew messages, not 4 separate/duplicated rows (saw ${groupRows.length}: ${JSON.stringify(groupRows)})`);
  ok(groupRows[0] && /^4 new comments/.test(groupRows[0].body), `old path's row correctly reads "4 new comments..." (saw: ${groupRows[0] && groupRows[0].body})`);

  const cutoff2 = Date.now() - 7 * 86400000;
  const pgRows2 = await pollUntil(
    () => db.pgNotificationHistoryForUser(carol.user.id, new Date(cutoff2).toISOString()),
    rows => rows.some(r => r.count === 4)
  );
  const pgGroupRows = pgRows2.filter(r => r.groupKey === `crew:${crew.id}:chat`);
  ok(pgGroupRows.length === 1, `new path (real Postgres table): exactly ONE row for this (carol, groupKey) after the same 4 concurrent requests -- the race this slice exists to fix (saw ${pgGroupRows.length} rows: ${JSON.stringify(pgGroupRows)})`);
  ok(pgGroupRows[0] && pgGroupRows[0].count === 4, `and its count is exactly 4, matching every concurrent sender, not lost to the race (saw count: ${pgGroupRows[0] && pgGroupRows[0].count})`);
  ok(pgGroupRows[0] && pgGroupRows[0].id === groupRows[0].id, `same id as the old path's row, not a second disconnected row (old: ${groupRows[0] && groupRows[0].id}, new: ${pgGroupRows[0] && pgGroupRows[0].id})`);
}

console.log('\nreal concurrent HTTP requests -- the feed-event reaction toggle race, driven through POST /api/feed-events/:id/react');
{
  // A fresh challenge_started feed event (public-crew-ish: everyone below is a member, so
  // everyone can react) reacted to by 10 different users at once.
  const reactors = [];
  for (let i = 0; i < 10; i++) reactors.push(await post('/api/register', { ageConfirmed: true, username: 'react' + i, pin: 'pass1234', displayName: 'React' + i }).then(r => r.json()));
  // Crew membership requires being a connection of the owner's (validCrewMemberIds) -- and
  // reacting to an event attributed to alice requires the REACTOR to be connected to alice too
  // (see POST /api/feed-events/:id/react's own `allowed` check) -- a one-directional follow from
  // alice covers both, since the target ends up in alice's `following` AND alice ends up in the
  // target's `followers` (connectionsOf checks both directions on either side).
  for (const r of reactors) await post('/api/follow/' + r.user.id, {}, alice.token);
  const crew2 = await post('/api/crews', { name: 'React Crew', memberIds: reactors.map(r => r.user.id) }, alice.token).then(r => r.json());
  await post(`/api/crews/${crew2.id}/challenge`, { type: 'workouts', target: 5 }, alice.token);
  const feed = await get('/api/feed', alice.token).then(r => r.json());
  const ev = feed.find(f => f.type === 'challenge_started' && f.crewId === crew2.id);
  ok(!!ev, `the challenge_started event exists in the old path's feed (saw: ${feed.filter(f=>f.crewId===crew2.id).map(f=>f.type).join(',')})`);

  await Promise.all(reactors.map(r => post(`/api/feed-events/${ev.id}/react`, {}, r.token)));

  const feedAfter = await get('/api/feed', alice.token).then(r => r.json());
  const evAfter = feedAfter.find(f => f.id === ev.id);
  ok(evAfter && evAfter.reactCount === 10, `old path: all 10 concurrent reactions landed, zero lost (saw reactCount: ${evAfter && evAfter.reactCount})`);

  const weekAgo2 = Date.now() - 8 * 86400000;
  const pgRows3 = await pollUntil(
    () => db.pgFeedEventsSince(new Date(weekAgo2).toISOString()),
    rows => { const r = rows.find(r => r.id === ev.id); return r && Array.isArray(r.reactions) && r.reactions.length === 10; }
  );
  const pgEv2 = pgRows3.find(r => r.id === ev.id);
  ok(pgEv2 && pgEv2.reactions.length === 10, `new path (real Postgres row): all 10 concurrent reactions landed there too (saw: ${pgEv2 && pgEv2.reactions.length})`);
  const oldReactorIds = reactors.map(r => r.user.id).sort();
  const newReactorIds = (pgEv2 ? [...pgEv2.reactions] : []).sort();
  ok(JSON.stringify(oldReactorIds) === JSON.stringify(newReactorIds), `and it's the SAME 10 userIds, not just the same count by coincidence (old: ${oldReactorIds.join(',')}, new: ${newReactorIds.join(',')})`);
}

console.log('\ndelete paths: DELETE /api/notifications/:id and the challenge-cancel feedEventId cleanup actually remove the new-table row too, not just the in-memory one');
{
  const notifs = await get('/api/notifications', bob.token).then(r => r.json());
  const toDelete = notifs.history[0];
  ok(!!toDelete, 'bob has at least one history row to delete');
  await del('/api/notifications/' + toDelete.id, bob.token);
  const notifsAfter = await get('/api/notifications', bob.token).then(r => r.json());
  ok(!notifsAfter.history.some(h => h.id === toDelete.id), 'old path: the row is gone from the in-memory read');

  const gone = await pollUntil(
    () => db.pgNotificationHistoryForUser(bob.user.id, new Date(Date.now() - 8 * 86400000).toISOString()),
    rows => !rows.some(r => r.id === toDelete.id)
  );
  ok(!gone.some(r => r.id === toDelete.id), `new path: the row is actually gone from the real Postgres table too, not just hidden (saw remaining ids: ${gone.map(r=>r.id).join(',')})`);

  // Challenge cancel -- exercises the feedEventId cross-reference delete (server.js's
  // DELETE /api/crews/:id/challenge/:challengeId).
  const crew3 = await post('/api/crews', { name: 'Cancel Crew', memberIds: [] }, alice.token).then(r => r.json());
  const ch = await post(`/api/crews/${crew3.id}/challenge`, { type: 'workouts', target: 3 }, alice.token).then(r => r.json());
  const running = ch.challenge;   // publicCrew's `challenge` field -- the just-started one (see publicChallenge's own shape, `{ id, ... }`)
  ok(!!running && !!running.id, `challenge creation returned a running challenge with an id (saw: ${JSON.stringify(ch.challenge)})`);
  const feedBefore = await get('/api/feed', alice.token).then(r => r.json());
  const startedEv = feedBefore.find(f => f.type === 'challenge_started' && f.crewId === crew3.id);
  ok(!!startedEv, 'the challenge_started feed event exists before cancel');

  await del(`/api/crews/${crew3.id}/challenge/${running.id}`, alice.token);
  const feedAfterCancel = await get('/api/feed', alice.token).then(r => r.json());
  ok(!feedAfterCancel.some(f => f.id === startedEv.id), 'old path: the feed event is gone after cancel');

  const goneFeed = await pollUntil(
    () => db.pgFeedEventsSince(new Date(Date.now() - 8 * 86400000).toISOString()),
    rows => !rows.some(r => r.id === startedEv.id)
  );
  ok(!goneFeed.some(r => r.id === startedEv.id), `new path: the feed_events row is actually gone from the real table too (saw remaining ids near it: ${goneFeed.filter(r=>r.crewId===crew3.id).map(r=>r.id).join(',') || 'none'})`);
}

db.close();
try { srv && srv.kill(); } catch {}
rmSync(DIR, { recursive: true, force: true });
await testDb.drop();

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
