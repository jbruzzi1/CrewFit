// v247, cold-review catch on the local-finish-date fix: creditFinish() started stamping session
// history with the PERSON'S OWN local calendar day instead of the server's UTC day (see
// test/local-finish-date.mjs), but currentStreak()/trainedToday() still defined "today"/
// "yesterday" as the server's UTC day. Before that fix both sides agreed (both UTC); after it,
// for anyone whose local day and UTC day currently differ (evening, west of UTC — exactly this
// app's audience, and exactly the multi-hour window STREAK_REMINDER_HOUR_UTC fires the streak-loss
// push reminder in), currentStreak() could look for "today" in the wrong reference frame and
// report a broken streak that was actually still intact.
//
// The fix: currentStreak()/trainedToday()/streakStatusFor() accept an optional localToday
// (validated YYYY-MM-DD) and use it as "today" when given, falling back to the old UTC
// approximation otherwise. It is only threaded through requests where the caller IS the subject —
// GET /api/me/streak-status and GET /api/profile/me — never through viewing someone ELSE's
// profile, since a viewer's own local day has nothing to do with a friend's timezone.
//
// This test never depends on the real wall clock or the sandbox's own timezone — every date below
// is a fixed, arbitrary YYYY-MM-DD fed straight through creditFinish's own localDate mechanism, so
// the assertions hold regardless of when or where this suite happens to run.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const J = { 'Content-Type': 'application/json' };
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('localstreak');

function boot(port, dir) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; srv.stdout.on('data', d => { out += d; if (String(d).includes('CrewFit on')) res({ srv, out }); });
    srv.on('exit', () => res({ srv: null, out }));
    setTimeout(() => res({ srv, out }), 15000);
  });
}
async function killAndWait(srv) {
  return new Promise(res => { srv.once('exit', res); srv.kill(); setTimeout(res, 2000); });
}

const DIR = mkdtempSync(join(tmpdir(), 'localstreak-'));
const PORT = 4987, B = `http://localhost:${PORT}`;
const { srv } = await boot(PORT, DIR);
ok(!!srv, 'server boots');

const post = (p, b, tok) => fetch(B + p, { method: 'POST', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b) }).then(r => r.json());
const get = (p, tok) => fetch(B + p, { headers: tok ? { Authorization: 'Bearer ' + tok } : {} }).then(r => r.json());
const reg = (username, pin, displayName) => post('/api/register', { username, pin, displayName });

async function creditDay(tok, name, localDate) {
  const s = await post('/api/sessions', {
    name, scheduledAt: new Date().toISOString(), exercises: [{ name: 'Overhead Press' }],
    inviteUsernames: [], visibility: 'private',
  }, tok);
  await post(`/api/sessions/${s.id}/log`, { exerciseId: s.exercises[0].id, weight: 65, reps: 8, set: 1 }, tok);
  await post(`/api/sessions/${s.id}/lock`, { localDate }, tok);
}

console.log("the exact regression: a real 2-day streak, checked from the SAME local reference frame it was built in, reads correctly even though it's nowhere near the server's real UTC-today");
{
  const gina = await reg('ls_gina', 'pass1234', 'Gina');
  // Two arbitrary, fixed, consecutive local days — nothing here depends on when this test runs.
  await creditDay(gina.token, 'Day One', '2025-03-14');
  await creditDay(gina.token, 'Day Two', '2025-03-15');

  const status = await get('/api/me/streak-status?localToday=2025-03-15', gina.token);
  ok(status.streak === 2, `streak is 2 when checked from the same local "today" the days were credited under (got ${status.streak})`);
  ok(status.trainedToday === true, `trainedToday is true for that same local today (got ${status.trainedToday})`);
  ok(status.atRisk === false, 'not at risk — already trained today, from that local perspective');
}

console.log("without localToday (every pre-v247 client), the old UTC approximation applies — proving the parameter is what's doing the work above, not some other change");
{
  const finn = await reg('ls_finn', 'pass1234', 'Finn2');
  await creditDay(finn.token, 'Day One', '2025-03-14');
  await creditDay(finn.token, 'Day Two', '2025-03-15');
  // No localToday sent: the server falls back to ITS OWN real UTC-today, which is nowhere near
  // March 2025 — so from that reference frame this streak reads as broken (0), not 2. This is
  // the ORIGINAL, unavoidable limitation for any caller that can't say what day it is for them
  // (the background reminder job, or an old client) — unchanged by this fix, and exactly why the
  // fix instead adds the localToday path for every caller that CAN say so.
  const status = await get('/api/me/streak-status', finn.token);
  ok(status.streak === 0, `without a local reference, two March-2025 days do not look like a live streak against today's real date (got ${status.streak})`);
}

console.log('\nGET /api/me/streak-status: a malformed localToday is refused, not trusted blindly');
{
  const hank = await reg('ls_hank', 'pass1234', 'Hank');
  await creditDay(hank.token, 'Day One', '2025-06-01');
  await creditDay(hank.token, 'Day Two', '2025-06-02');
  for (const bad of ['not-a-date', '2025-06-2', '2025-13-01', '2025-02-30']) {
    const status = await get('/api/me/streak-status?localToday=' + encodeURIComponent(bad), hank.token);
    ok(status.streak === 0, `malformed localToday ${JSON.stringify(bad)} falls back to real UTC-today, not blindly trusted (streak ${status.streak})`);
  }
}

console.log("\nGET /api/profile/me honors localToday the same way GET /api/me/streak-status does");
{
  const ivy = await reg('ls_ivy', 'pass1234', 'Ivy');
  await creditDay(ivy.token, 'Day One', '2024-11-20');
  await creditDay(ivy.token, 'Day Two', '2024-11-21');
  const profile = await get('/api/profile/me?localToday=2024-11-21', ivy.token);
  ok(profile.streak === 2, `own profile's streak field respects localToday too (got ${profile.streak})`);
  const recap = (profile.recentActivity || []).find(a => a.type === 'streak');
  ok(!!recap && /2 day workout streak/.test(recap.text), `and Recent Activity's own streak line agrees (saw: ${recap && recap.text})`);
}

console.log("\nGET /api/profile/:id (viewing a FRIEND) never honors the VIEWER's localToday — a viewer's own local day is not the friend's timezone");
{
  const jill = await reg('ls_jill', 'pass1234', 'Jill');
  const kate = await reg('ls_kate', 'pass1234', 'Kate');
  // profileOf's isApproved (the gate on the streak field even being non-null) checks followers,
  // not the separate friends list — Jill has to actually follow Kate, and Kate accept, same as
  // test/follow.mjs's own setup.
  await post(`/api/follow/${kate.user.id}`, {}, jill.token);
  await post(`/api/follow-requests/${jill.user.id}/accept`, {}, kate.token);
  await creditDay(kate.token, 'Day One', '2025-03-14');
  await creditDay(kate.token, 'Day Two', '2025-03-15');

  // Without localToday: server's own UTC-today, streak reads 0 (same reasoning as the Finn block).
  const baseline = await get(`/api/profile/${kate.user.id}`, jill.token);
  // With Jill's OWN localToday=2025-03-15 tacked on: if this were (wrongly) honored for a friend's
  // profile, Kate's streak would flip to 2. It must not.
  const withViewerLocalToday = await get(`/api/profile/${kate.user.id}?localToday=2025-03-15`, jill.token);
  ok(baseline.streak === withViewerLocalToday.streak,
    `a friend's profile streak is unaffected by the VIEWER's own localToday (baseline ${baseline.streak}, with param ${withViewerLocalToday.streak})`);
  ok(withViewerLocalToday.streak === 0, `and it still reads via the real UTC fallback either way (got ${withViewerLocalToday.streak})`);
}

await killAndWait(srv);
console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
