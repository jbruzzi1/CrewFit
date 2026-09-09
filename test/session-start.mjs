// POST /api/sessions/:id/start (Sep 9 2026, Jeff: "I want to create a workout and it show up in
// what's up next until I click 'Start now' then it moves to your sessions"). Home's own use of
// startedAt (which session is eligible for the Next up slot) is covered client-side in
// test/home-live-window-and-workouts-view.mjs; this is the server-side route itself -- the actual
// write, its gate, and its idempotency. Real server + real Postgres.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const J = { 'Content-Type': 'application/json' };
const CWD = new URL('..', import.meta.url).pathname;

function boot(port, dir, databaseUrl) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: databaseUrl, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; srv.stdout.on('data', d => { out += d; if (String(d).includes('CrewFit on')) res(srv); });
    srv.on('exit', () => res(null));
    setTimeout(() => res(srv), 8000);
  });
}

const DIR = mkdtempSync(join(tmpdir(), 'session-start-'));
const testDb = await freshTestDb('sessionstart');
const PORT = 4795, BASE = `http://localhost:${PORT}`;
const srv = await boot(PORT, DIR, testDb.url);
if (!srv) { console.log('FAIL: server did not boot'); process.exit(1); }

const H = t => ({ ...J, Authorization: 'Bearer ' + t });
const api = (method, path, token, body) => fetch(BASE + path, { method, headers: token ? H(token) : J, body: body !== undefined ? JSON.stringify(body) : undefined }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }));
const reg = n => api('POST', '/api/register', null, { username: n, pin: 'pass1234', displayName: n[0].toUpperCase() + n.slice(1) }).then(r => r.json);

try {

const rand = Math.floor(Math.random() * 1e6);
const alice = await reg(`start_alice${rand}`);
const bob = await reg(`start_bob${rand}`);
const carol = await reg(`start_carol${rand}`);
const A = alice.token, AID = alice.user.id;
const B = bob.token;
const C = carol.token;

console.log('POST /api/sessions/:id/start');
{
  // Scheduled a full 2 hours in the future -- same shape as Jeff's "the timer was for 8:00PM and
  // its 7:30PM" example -- so the scheduledAt-moves-to-now assertions below are actually testing
  // something (a session already scheduled for "now" couldn't prove the clock moved at all).
  const future = new Date(Date.now() + 2 * 3600e3).toISOString();
  const sess = await api('POST', '/api/sessions', A, { name: 'Push Day', visibility: 'public', scheduledAt: future, exercises: [{ name: 'Bench Press' }] });
  const sid = sess.json.id;
  ok(sess.json.startedAt === null, 'a freshly created session starts with startedAt: null -- not "started" just by existing');
  ok(sess.json.scheduledAt === future, 'and keeps the scheduledAt it was actually created with, untouched, until started');

  const missing = await api('POST', '/api/sessions/does_not_exist/start', A, {});
  ok(missing.status === 404, 'starting a session id that does not exist 404s rather than 500ing');

  const strangerStart = await api('POST', `/api/sessions/${sid}/start`, C, {});
  ok(strangerStart.status === 403, 'carol -- not a participant, not invited, no history here -- cannot start alice\'s session');
  const stillNull = await api('GET', `/api/sessions/${sid}`, A);
  ok(stillNull.json.startedAt === null, '...and the refused attempt left startedAt untouched');
  ok(stillNull.json.scheduledAt === future, '...and left scheduledAt untouched too');

  const started = await api('POST', `/api/sessions/${sid}/start`, A, {});
  ok(started.status === 200 && typeof started.json.startedAt === 'string', 'alice (the creator, a participant) can start her own session, gets a real timestamp back');
  // Jeff, Sep 9: "it should show live right away... change the time of the workout to the time at
  // when you selected 'start now'" -- a workout originally set for two hours from now must not
  // still read as two-hours-out just because it's been marked started.
  ok(started.json.scheduledAt === started.json.startedAt, 'starting a workout scheduled for later moves scheduledAt to the same instant as startedAt...');
  ok(started.json.scheduledAt !== future, '...so it no longer carries its original two-hours-from-now time');

  // Idempotency: a second start (by the same person, or a different participant) must not move
  // the timestamp -- same shape as /lock's creditFinish, see the route's own comment for why this
  // matters (Join now, tapped by a second person after the session is already started, must be a
  // no-op, not a second "started" moment). Must not re-time it either.
  await new Promise(r => setTimeout(r, 5));
  const restarted = await api('POST', `/api/sessions/${sid}/start`, A, {});
  ok(restarted.json.startedAt === started.json.startedAt, 'starting an already-started session again does not move the timestamp (idempotent)');
  ok(restarted.json.scheduledAt === started.json.scheduledAt, '...and does not re-time it either -- the FIRST start is what counts, not a repeat tap moments later');

  await api('POST', `/api/follow/${AID}`, B);
  const joinSess = await api('POST', '/api/sessions', A, { name: 'Squad Day', visibility: 'private', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Squat' }], inviteUsernames: [bob.user.username] });
  const jsid = joinSess.json.id;
  await api('POST', `/api/sessions/${jsid}/accept`, B);
  const bobStarts = await api('POST', `/api/sessions/${jsid}/start`, B, {});
  ok(bobStarts.status === 200 && typeof bobStarts.json.startedAt === 'string', 'a fellow participant (bob, not the creator) can start a shared session too -- startedAt is session-level, not creator-only');
  const aliceSeesStarted = await api('GET', `/api/sessions/${jsid}`, A);
  ok(aliceSeesStarted.json.startedAt === bobStarts.json.startedAt, 'and alice (a member of the same session) sees the same startedAt bob\'s start produced');

  // Cold-review catch: the only exposed UI paths to this route already restrict it to a
  // session that's live or scheduled today -- but /start itself has no such check, so a
  // genuinely stale (days-old, already "Missed") session reached some other way (devtools, a
  // future UI surface) must not have starting it ALSO silently erase its Missed flag and
  // relocate it onto today's plan. It should still mark started -- just without moving the clock.
  const stale = new Date(Date.now() - 3 * 86400e3).toISOString();
  const staleSess = await api('POST', '/api/sessions', A, { name: 'Old Leg Day', visibility: 'private', scheduledAt: stale, exercises: [{ name: 'Squat' }] });
  const staleId = staleSess.json.id;
  const staleStarted = await api('POST', `/api/sessions/${staleId}/start`, A, {});
  ok(staleStarted.status === 200 && typeof staleStarted.json.startedAt === 'string', 'a 3-day-stale session can still be marked started (it is still "in this workout" for the participant)');
  ok(staleStarted.json.scheduledAt === stale, '...but its scheduledAt is left alone -- starting it does not silently un-Miss it by relocating it onto today');

  const uninvited = await api('POST', '/api/sessions', A, { name: 'Solo Day', visibility: 'private', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Row' }] });
  const usid = uninvited.json.id;
  const uninvitedStart = await api('POST', `/api/sessions/${usid}/start`, B, {});
  ok(uninvitedStart.status === 403, 'bob -- not a participant and never invited to this one -- cannot start it either');
}

} finally {
  srv.kill();
  await testDb.drop();
}

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
