// Jeff, Sep 2: "It says I have a 3 week streak - yet I haven't worked out for 3 weeks straight."
// weeksFor (which drives streakWeeks and the Consistency chart) predated the v247 fix that made
// currentStreak/trainedToday/profileOf trust each session-history row's own stamped local day
// (h.date, set by creditFinish from the client's localDate) instead of the server's bare UTC
// clock. weeksFor kept deriving the trained day from s.scheduledAt/perfDate and measuring "today"
// from the server's own UTC clock -- the exact pre-v247 pattern -- so a workout whose scheduled
// timestamp crossed a UTC day/week boundary differently than the user's own local day landed in
// the wrong weekly bucket, and the "current week" cutoff itself didn't line up with the user's
// own day either. Fixed to prefer h.date over scheduledAt (matching currentStreak) and to accept
// an optional localToday for the week-boundary math (matching /api/me/streak-status).
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';

const PORT = process.env.TEST_PORT_STREAKWEEKS || 4958;
const B = `http://localhost:${PORT}`;
const DIR = mkdtempSync(join(tmpdir(), 'crewfit-streakweeks-'));
const testDb = await freshTestDb('streakweeks');
let fails = 0, srv = null, srvDead = true;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const J = { 'Content-Type': 'application/json' };

function boot() {
  return new Promise(res => {
    srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: DIR, DATABASE_URL: testDb.url, PORT: String(PORT) },
      cwd: new URL('..', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'pipe'] });
    srvDead = false;
    let err = '', done = false;
    const finish = v => { if (!done) { done = true; res(v); } };
    srv.stderr.on('data', d => { err += d; });
    srv.stdout.on('data', d => { if (String(d).includes('CrewFit on')) finish({ started: true }); });
    srv.on('exit', () => { srvDead = true; finish({ started: false, err }); });
    setTimeout(() => finish({ started: false, err: err || 'timeout' }), 12000);
  });
}
const stop = () => new Promise(r => { if (!srv || srvDead) return r(); srv.on('exit', r); srv.kill(); });

await boot();
try {

const reg = (username) => fetch(B + '/api/register', { method: 'POST', headers: J,
  body: JSON.stringify({ username, pin: 'pass1234', displayName: username }) }).then(r => r.json());
const post = (p, b, tok) => fetch(B + p, { method: 'POST', headers: { ...J, Authorization: 'Bearer ' + tok }, body: JSON.stringify(b) }).then(r => r.json());
const get = (p, tok) => fetch(B + p, { headers: { Authorization: 'Bearer ' + tok } }).then(r => r.json());

async function loggedSession(tok, scheduledAt, localDate) {
  const s = await post('/api/sessions', { name: 'Day', scheduledAt, exercises: [{ name: 'Bench Press' }],
    inviteUsernames: [], visibility: 'private' }, tok);
  await post('/api/sessions/' + s.id + '/log', { exerciseId: s.exercises[0].id, weight: 135, reps: 10 }, tok);
  await post('/api/sessions/' + s.id + '/lock', { localDate }, tok);
  return s;
}

console.log('a workout counts toward the week the user actually trained it in, not a week it merely got scheduled in');
{
  const u = await reg('sw_normal' + Math.floor(Math.random() * 1e6));
  // Squarely inside their weeks -- no boundary involved. Aug 27/29 -> Aug24-31 week; Aug 31/Sep 1
  // -> Aug31-Sep7 week. "Today" pinned via localToday so this test doesn't depend on the calendar
  // date it happens to run on.
  await loggedSession(u.token, '2026-08-27T18:00:00Z', '2026-08-27');
  await loggedSession(u.token, '2026-08-29T18:00:00Z', '2026-08-29');
  await loggedSession(u.token, '2026-08-31T18:00:00Z', '2026-08-31');
  await loggedSession(u.token, '2026-09-01T18:00:00Z', '2026-09-01');
  const prog = await get('/api/progress?weeks=26&localToday=2026-09-02', u.token);
  ok(prog.streakWeeks === 2, `two consecutive trained weeks -> streakWeeks 2 (got ${prog.streakWeeks})`);
}

console.log('\na workout finished late at night in a western timezone counts toward the trainer\'s own local week, not the UTC week its instant falls in');
{
  const u = await reg('sw_late' + Math.floor(Math.random() * 1e6));
  // Sun Aug 23, 11pm Pacific = Mon Aug 24, 06:00 UTC. localDate (what the real client already
  // sends on Log & Finish) carries the true local day, Aug 23 -- the Aug17-24 week, not Aug24-31.
  await loggedSession(u.token, '2026-08-24T06:00:00Z', '2026-08-23');
  // A daytime session the following Thursday, unambiguously inside Aug24-31.
  await loggedSession(u.token, '2026-08-27T18:00:00Z', '2026-08-27');
  const prog = await get('/api/progress?weeks=26&localToday=2026-08-28', u.token);
  ok(prog.streakWeeks === 2,
     `Aug17-24 (from the true local day) + Aug24-31 -> streakWeeks 2, not 1 from both misfiling into the same UTC week (got ${prog.streakWeeks})`);
  const w1724 = prog.weeks.find(w => w.weekOf === '2026-08-17');
  ok(w1724 && w1724.days === 1, `the Aug17-24 bucket itself shows the late-night session (got ${w1724 && w1724.days})`);
}

console.log('\nthe "current week" cutoff itself follows localToday, not the server\'s real wall-clock date');
{
  const u = await reg('sw_cutoff' + Math.floor(Math.random() * 1e6));
  // A session trained (and finished) well before whatever date this test actually runs on.
  // Pinning localToday to that same week is the only way "current week" lands on it -- if the
  // route silently ignored localToday and fell back to the server's real clock instead, "this
  // week" would be wherever `new Date()` actually is today, that week would have zero trained
  // days, and the streak-counting loop (which requires the CURRENT week to be non-empty before it
  // counts anything at all) would report 0 regardless of this real trained day.
  await loggedSession(u.token, '2026-08-20T18:00:00Z', '2026-08-20');   // a Thursday
  const prog = await get('/api/progress?weeks=26&localToday=2026-08-20', u.token);
  ok(prog.streakWeeks === 1, `streak measured against localToday's own week, not the server's real today (got ${prog.streakWeeks})`);
}

console.log('\na session still awaiting Finish (no history row yet) falls back to its scheduled day -- there is no better source');
{
  const u = await reg('sw_unfinished' + Math.floor(Math.random() * 1e6));
  const s = await post('/api/sessions', { name: 'Day', scheduledAt: '2026-08-27T18:00:00Z',
    exercises: [{ name: 'Bench Press' }], inviteUsernames: [], visibility: 'private' }, u.token);
  await post('/api/sessions/' + s.id + '/log', { exerciseId: s.exercises[0].id, weight: 135, reps: 10 }, u.token);
  // deliberately no /lock -- no history row, so hist is undefined and perfDate(scheduledAt) is
  // still the only date this session can offer
  const prog = await get('/api/progress?weeks=26&localToday=2026-08-28', u.token);
  const w2431 = prog.weeks.find(w => w.weekOf === '2026-08-24');
  ok(w2431 && w2431.days === 1, `an unfinished-but-logged session still counts via its scheduled day (got ${w2431 && w2431.days})`);
}

} finally { await stop(); await testDb.drop(); }

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
