// Sep 5 2026 (Jeff: "I got a push notification that someone followed me - but no in app
// notification showing or the '1' showing over the notification bell. It was empty when i
// clicked in ... It should also show past notifications for a specific amount of time.")
//
// Root cause: GET /api/notifications was built entirely from still-PENDING state (an
// unaccepted invite, an unapproved follow/join request). A PUBLIC profile's follow completes
// INSTANTLY -- there is no pending state left to read back for it -- so the "New follower" push
// notify() sent had nothing to show up as in the aggregated inbox, no matter how long you
// waited. Fixed by having notify() (the one place every push in this app is sent from) also
// append a durable, read-only history record, independent of push-subscription state, filtered
// to the last NOTIFICATION_HISTORY_DAYS on read. See the long comment above notify() and GET
// /api/notifications in server.js for the full reasoning, including why three call sites
// (pending follow request, workout invite, pending join request) pass `{ history: false }` --
// those are already shown live in their own pending arrays, and logging them too would show the
// same ask twice.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';
import { PgConnection, parseConnString } from '../pgmini.js';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const J = { 'Content-Type': 'application/json' };
const CWD = new URL('..', import.meta.url).pathname;

function boot(port, dir, databaseUrl) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: databaseUrl, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    srv.stderr.on('data', d => process.stderr.write(d));
    srv.stdout.on('data', d => { if (String(d).includes('CrewFit on')) res(srv); });
    setTimeout(() => res(null), 15000);
  });
}

const DIR = mkdtempSync(join(tmpdir(), 'notif-'));
const testDb = await freshTestDb('notifications1');
const PORT = 4991, B = `http://localhost:${PORT}`;
let srv = await boot(PORT, DIR, testDb.url);
if (!srv) { console.log('FAIL boot'); process.exit(1); }

const H = t => ({ ...J, Authorization: 'Bearer ' + t });
const reg = n => fetch(B + '/api/register', { method: 'POST', headers: J, body: JSON.stringify({ username: n, pin: 'pass1234', displayName: n }) }).then(r => r.json());
const P = (who, p, body) => fetch(B + p, { method: 'POST', headers: H(who.token), body: JSON.stringify(body || {}) }).then(r => r.json());
const G = (who, p) => fetch(B + p, { headers: H(who.token) }).then(r => r.json());

const me = await reg('nme'), alice = await reg('nalice'), bob = await reg('nbob'), carol = await reg('ncarol');

console.log("the actual bug: a PUBLIC follow completes instantly, but it's still a real notification");
{
  // both public by default -- this follow needs no approval, so there is no pending state at
  // all for it to show up as. Before the fix, this was invisible everywhere except the push
  // itself; the whole point of this test is that it now shows up in-app too.
  const r = await P(alice, `/api/follow/${me.user.id}`);
  ok(r.status === 'following', `alice's follow to a public profile completes instantly (got ${JSON.stringify(r)})`);
  const data = await G(me, '/api/notifications');
  ok(Array.isArray(data.history) && data.history.length === 1, `me's notifications history has exactly the one entry (got ${JSON.stringify(data.history)})`);
  ok(data.history[0].body.includes('nalice') && data.history[0].body.toLowerCase().includes('following you'),
    `and it reads as alice following me (got "${data.history[0] && data.history[0].body}")`);
  ok(typeof data.history[0].at === 'string' && !isNaN(new Date(data.history[0].at)), 'it carries a real timestamp');
  ok(data.count === 1, `the bell badge counts this unseen history entry (got ${data.count})`);
}

console.log('\nmarking the page seen clears the badge without deleting the history it counted');
{
  const seen = await P(me, '/api/notifications/seen');
  ok(seen.ok === true, `POST /api/notifications/seen succeeds (got ${JSON.stringify(seen)})`);
  const data = await G(me, '/api/notifications');
  ok(data.count === 0, `badge count drops to 0 once seen (got ${data.count})`);
  ok(data.history.length === 1, `but the history row itself is still there to look back at (got ${data.history.length})`);
}

console.log('\na NEW event after being seen bumps the badge again -- seen is a point in time, not "read forever"');
{
  await P(bob, `/api/follow/${me.user.id}`);
  const data = await G(me, '/api/notifications');
  ok(data.history.length === 2, `history now has both follows (got ${data.history.length})`);
  ok(data.count === 1, `only the NEW one counts toward the badge (got ${data.count})`);
  ok(data.history[0].body.includes('nbob'), 'and history is sorted newest-first (bob, the most recent, is first)');
}

console.log('\nthe three still-pending types are not double-logged into history while pending');
{
  // --- follow request: me goes private, carol's follow needs approval and stays pending ---
  await P(me, '/api/me/profile-visibility', { visibility: 'private' });
  const fr = await P(carol, `/api/follow/${me.user.id}`);
  ok(fr.status === 'requested', `carol's follow to me is now a pending request (got ${JSON.stringify(fr)})`);
  let data = await G(me, '/api/notifications');
  ok((data.followRequests || []).some(f => f.from.username === 'ncarol'), "carol's request shows live in followRequests");
  ok(!data.history.some(h => h.body && h.body.includes('wants to follow')),
    'but it does NOT also show as a history row -- that would be the exact same ask twice');
  // ...resolved right away, before anything below can change me's visibility out from under it --
  // switching to public later auto-accepts every still-pending follow request (see the profile-
  // visibility route), which would otherwise resolve this one as a side effect instead of via
  // the explicit accept call this is actually testing.
  const carolReqAccept = await P(me, `/api/follow-requests/${carol.user.id}/accept`);
  ok(carolReqAccept.ok === true, `me accepts carol's follow request (got ${JSON.stringify(carolReqAccept)})`);
  data = await G(carol, '/api/notifications');
  ok(data.history.some(h => h.body && h.body.includes('accepted your follow request')),
    `carol (the requester) gets the "accepted" history entry, not me (got ${JSON.stringify(data.history)})`);
  data = await G(me, '/api/notifications');
  ok(!data.history.some(h => h.body && h.body.includes('accepted your follow request')),
    "me (who just clicked Approve) does not get a redundant history entry for my own action");

  // --- workout invite: dee needs to be connected to me first (invite eligibility). dee's
  // profile is public (the default), so me following dee lands instantly and connects them
  // either way (connectionsOf treats an approved follow in EITHER direction as connected) ---
  const dee = await reg('ndee');
  await P(me, `/api/follow/${dee.user.id}`);
  const sess = await P(me, '/api/sessions', { name: 'Push Day', visibility: 'private', exercises: [{ name: 'Bench Press' }], inviteUsernames: ['ndee'] });
  ok(Array.isArray(sess.invited) && sess.invited.includes(dee.user.id), `dee is invited to me's workout (got ${JSON.stringify(sess.invited)})`);
  data = await G(dee, '/api/notifications');
  ok(data.invites.some(iv => iv.sessionId === sess.id), "dee sees the invite live in the invites array");
  ok(!data.history.some(h => h.body && h.body.includes('invited you')),
    'but not ALSO as a history row while it is still just sitting there unanswered');
  // decline's response is dee's OWN view of a now-private session they're no longer part of --
  // sessionView correctly returns null for that (no more access), so the real assertion is the
  // side effect below, not this response shape.
  await P(dee, `/api/sessions/${sess.id}/decline`);
  data = await G(me, '/api/notifications');
  ok(data.history.some(h => h.body && h.body.includes('declined your workout')),
    `me (the creator) gets the "declined" history entry (got ${JSON.stringify(data.history)})`);

  // --- join request: eve requests to join a PUBLIC session of me's, stays pending. me switches
  // to public here, now that carol's request is already resolved above (nothing left to
  // auto-accept as a side effect). ---
  const eve = await reg('neve');
  await P(me, '/api/me/profile-visibility', { visibility: 'public' });   // so eve can find/join it
  const openSess = await P(me, '/api/sessions', { name: 'Leg Day', visibility: 'public', exercises: [{ name: 'Back Squat' }] });
  const jr = await P(eve, `/api/sessions/${openSess.id}/join`, { note: 'mind if I join' });
  ok(jr.ok && jr.requested, `eve's join request is filed (got ${JSON.stringify(jr)})`);
  data = await G(me, '/api/notifications');
  ok(data.joinRequests.some(j => j.sessionId === openSess.id), "me sees eve's join request live in joinRequests");
  ok(!data.history.some(h => h.body && h.body.includes('wants to join')),
    'but not ALSO as a history row while it is still pending');
  // the /join response never carries reqId (the client discovers it the same way, via
  // GET /api/notifications' joinRequests[].reqId) -- look it up rather than guessing it.
  const pendingJoin = data.joinRequests.find(j => j.sessionId === openSess.id);
  const approveRes = await P(me, `/api/sessions/${openSess.id}/join/${pendingJoin.reqId}/approve`);
  ok(!approveRes.error, `me approves eve's join request (got ${JSON.stringify(approveRes.error || approveRes)})`);
  data = await G(eve, '/api/notifications');
  ok(data.history.some(h => h.body && h.body.includes('approved your join request')),
    `eve (the joiner) gets the "approved" history entry (got ${JSON.stringify(data.history)})`);

  console.log('\n...and live chat (crew messages, in-workout chat) does not flood Past notifications -- cold-review catch');
  // A group chat is exactly the kind of high-frequency notify() call this feature should NOT
  // absorb: it already has its own durable thread to catch up on, and a chatty crew could push
  // real one-shot events (a follow, a reaction) out of the history list's cap within days.
  const crew = await P(me, '/api/crews', { name: 'Iron Crew', memberIds: [alice.user.id] });
  ok(!crew.error && crew.id, `crew created with alice as a member (got ${JSON.stringify(crew)})`);
  await P(alice, `/api/crews/${crew.id}/messages`, { text: 'who is hitting legs tomorrow' });
  data = await G(me, '/api/notifications');
  ok(!data.history.some(h => h.body && h.body.includes('hitting legs tomorrow')),
    `me's crew-chat message from alice does NOT land in Past notifications (got ${JSON.stringify(data.history.map(h=>h.body))})`);

  // eve is now an approved participant on openSess (just above) -- she posts into that workout's
  // live chat, which every OTHER participant (me) is notified of.
  await P(eve, `/api/sessions/${openSess.id}/comments`, { text: 'running 10 min late, saving you a squat rack' });
  data = await G(me, '/api/notifications');
  ok(!data.history.some(h => h.body && h.body.includes('running 10 min late')),
    `me's in-workout chat message from eve does NOT land in Past notifications either (got ${JSON.stringify(data.history.map(h=>h.body))})`);
}

console.log('\na reaction on a posted workout also lands in the recap author\'s notification history');
{
  const s = await P(me, '/api/sessions', { name: 'Pull Day', visibility: 'public', exercises: [{ name: 'Deadlift' }] });
  await P(me, `/api/sessions/${s.id}/log`, { exerciseId: s.exercises[0].id, weight: 315, reps: 3 });
  await P(me, `/api/sessions/${s.id}/lock`);
  // Finishing (above) only credits the workout -- the actual recap post (with its own visibility,
  // which is what canSeePostAuthor/react actually gate on) is a separate save.
  await P(me, `/api/sessions/${s.id}/post`, { visibility: 'public' });
  const react = await P(alice, `/api/sessions/${s.id}/posts/${me.user.id}/react`);
  ok(react.reacted === true, `alice reacts to me's posted workout (got ${JSON.stringify(react)})`);
  const data = await G(me, '/api/notifications');
  ok(data.history.some(h => h.body && h.body.includes('reacted to your workout')),
    `me sees "reacted to your workout" in Past notifications (got ${JSON.stringify(data.history.map(h=>h.body))})`);
}

console.log('\nretention: an 8-day-old notification does not resurface, and is actually deleted, not just hidden');
{
  // The running server keeps its ENTIRE DB in memory (see db.js's design comment) and only ever
  // reads Postgres at boot -- a row inserted straight into Postgres while the server is already
  // running is invisible to it until the next load(), so there is no way to observe "old row
  // still in Postgres, filtered out at read time" as its own separate moment via the HTTP API;
  // pruneOldNotifications() runs at that same boot, before anything can read it back. This test
  // covers the thing a user can actually experience: insert an old row directly (simulating one
  // that was written weeks ago), restart the server the way a deploy would, and confirm it
  // never resurfaces AND is gone from storage -- not two separate claims, but two separate checks
  // of the one real guarantee.
  const conn = new PgConnection(parseConnString(testDb.url));
  const oldId = 'ntf_test_old_one', freshId = 'ntf_test_fresh_one';
  const old8Days = new Date(Date.now() - 8 * 86400000).toISOString();
  const fresh = new Date().toISOString();
  await conn.query('INSERT INTO notifications (id, data) VALUES ($1, $2::jsonb)',
    [oldId, JSON.stringify({ id: oldId, userId: me.user.id, title: 'Old', body: 'This is 8 days old', createdAt: old8Days })]);
  await conn.query('INSERT INTO notifications (id, data) VALUES ($1, $2::jsonb)',
    [freshId, JSON.stringify({ id: freshId, userId: me.user.id, title: 'Fresh', body: 'This just happened', createdAt: fresh })]);

  // Restart the server -- pruneOldNotifications() runs once at boot, before the reminder timers
  // even get a chance to (see the boot migrations block in server.js), and its deletions are
  // saved to Postgres in that same boot's save(DB) call.
  try { srv && srv.kill(); } catch {}
  srv = await boot(PORT, DIR, testDb.url);
  ok(!!srv, 're-boot succeeded');

  const data = await G(me, '/api/notifications');
  ok(!data.history.some(h => h.id === oldId), 'the 8-day-old notification does not resurface in history after reboot');
  ok(data.history.some(h => h.id === freshId), 'while a genuinely fresh one (inserted at the same time) does');

  const gone = await conn.query('SELECT id FROM notifications WHERE id = $1', [oldId]);
  ok(gone.rows.length === 0, 'the 8-day-old row is actually deleted from storage by the boot-time prune, not just hidden on read');
  const stillFresh = await conn.query('SELECT id FROM notifications WHERE id = $1', [freshId]);
  ok(stillFresh.rows.length === 1, 'and the fresh row was left alone');
  conn.close();
}

try { srv && srv.kill(); } catch {}
rmSync(DIR, { recursive: true, force: true });
await testDb.drop();
console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
