// v247 audit finding: creditFinish() (server.js) used to stamp every history row with
// new Date().toISOString().slice(0,10) — the SERVER's UTC calendar day. For anyone west of UTC,
// an evening workout is already "tomorrow" in UTC (e.g. 8pm US Eastern is past midnight UTC), so
// tapping Log & Finish credited the workout to the WRONG calendar day — corrupting streaks and
// weekly volume, not just a display label. The fix: the client sends its own local today
// (YYYY-MM-DD, computed from the phone's own timezone — see localDateStr() in app.js) and the
// server trusts it when it looks like a real date, falling back to the old UTC-today behavior for
// anything missing or malformed (exactly what a pre-v247 client still sends, so nothing already
// deployed breaks). This test proves the server-side half of that contract directly: the value
// actually lands in history[].date, with the fallback intact.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const J = { 'Content-Type': 'application/json' };
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('localdate');

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

const DIR = mkdtempSync(join(tmpdir(), 'localdate-'));
const PORT = 4988, B = `http://localhost:${PORT}`;
const { srv } = await boot(PORT, DIR);
ok(!!srv, 'server boots');

const post = (p, b, tok) => fetch(B + p, { method: 'POST', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b) }).then(r => r.json());
const get = (p, tok) => fetch(B + p, { headers: tok ? { Authorization: 'Bearer ' + tok } : {} }).then(r => r.json());
const reg = (username, pin, displayName) => post('/api/register', { username, pin, displayName });
const utcToday = () => new Date().toISOString().slice(0, 10);

async function newSession(tok, name) {
  return post('/api/sessions', {
    name, scheduledAt: new Date().toISOString(), exercises: [{ name: 'Bench Press' }],
    inviteUsernames: [], visibility: 'private',
  }, tok);
}

console.log("the exact bug: a client's local date differs from the server's UTC date (a US evening workout, already 'tomorrow' in UTC)");
{
  const alice = await reg('ld_alice', 'pass1234', 'Alice');
  const s = await newSession(alice.token, 'Evening Push Day');
  // Whatever the server's own UTC-today happens to be right now, pick a DIFFERENT valid date to
  // stand in for "the phone's real local day" — proves the server actually uses what's sent
  // rather than coincidentally matching its own clock.
  const localToday = utcToday() === '2000-01-01' ? '2000-01-02' : '2000-01-01';
  const r = await post(`/api/sessions/${s.id}/lock`, { localDate: localToday }, alice.token);
  const row = (r.history || []).find(h => h.userId === alice.user.id);
  ok(!!row, 'a history row was written');
  ok(row && row.date === localToday, `history.date is the CLIENT's local date, not the server's UTC date (got ${row && row.date}, wanted ${localToday})`);
}

console.log('\nno localDate sent (every pre-v247 client) — falls back to the old UTC-today behavior unchanged');
{
  const bob = await reg('ld_bob', 'pass1234', 'Bob');
  const s = await newSession(bob.token, 'Old Client Session');
  const r = await post(`/api/sessions/${s.id}/lock`, {}, bob.token);
  const row = (r.history || []).find(h => h.userId === bob.user.id);
  ok(row && row.date === utcToday(), `history.date falls back to server UTC-today when no localDate is sent (got ${row && row.date})`);
}

console.log('\nmalformed localDate is refused, not trusted blindly — falls back the same way');
{
  const carol = await reg('ld_carol', 'pass1234', 'Carol');
  // cold-review catch: regex-SHAPED but calendar-IMPOSSIBLE (or absurd-year) values must be
  // refused too, not just structurally-wrong ones — a value like "9999-12-31" would otherwise
  // sort above every real row forever, and "2026-02-30" doesn't correspond to a real day at all.
  for (const bad of ['not-a-date', '2026/08/29', 12345, null, '2026-8-9', '', {}, '2026-13-01', '2026-02-30', '2026-00-15', '2026-01-00', '9999-12-31', '0000-01-01', '1500-01-01']) {
    const s = await newSession(carol.token, 'Bad Date Session ' + JSON.stringify(bad));
    const r = await post(`/api/sessions/${s.id}/lock`, { localDate: bad }, carol.token);
    const row = (r.history || []).find(h => h.userId === carol.user.id);
    ok(row && row.date === utcToday(), `malformed localDate ${JSON.stringify(bad)} falls back to UTC-today, not blindly trusted (got ${row && row.date})`);
  }
}

console.log('\nkeep-leave (POST /leave with keep:true) credits through the same fixed path');
{
  const dan = await reg('ld_dan', 'pass1234', 'Dan');
  const erin = await reg('ld_erin', 'pass1234', 'Erin');
  await post('/api/follow/' + dan.user.id, {}, erin.token);
  await post('/api/follow-requests/' + erin.user.id + '/accept', {}, dan.token);
  await post('/api/follow/' + erin.user.id, {}, dan.token);
  await post('/api/follow-requests/' + dan.user.id + '/accept', {}, erin.token);
  const s = await post('/api/sessions', {
    name: 'Shared Session', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Squat' }],
    inviteUsernames: [], visibility: 'private',
  }, dan.token);
  await fetch(B + '/api/sessions/' + s.id, {
    method: 'PUT', headers: { ...J, Authorization: 'Bearer ' + dan.token },
    body: JSON.stringify({ inviteUsernames: ['ld_erin'] }),
  }).then(r => r.json());
  await post('/api/sessions/' + s.id + '/accept', {}, erin.token);
  await post(`/api/sessions/${s.id}/log`, { exerciseId: s.exercises[0].id, weight: 95, reps: 8 }, erin.token);
  const localToday = utcToday() === '2001-06-30' ? '2001-07-01' : '2001-06-30';
  await post(`/api/sessions/${s.id}/leave`, { keep: true, localDate: localToday }, erin.token);
  // /leave's own response is just {ok:true, left:true} — history lives on the session, so read it
  // back as the creator (still a current participant, still a 'member'-tier viewer of the row).
  const after = await get(`/api/sessions/${s.id}`, dan.token);
  const row = (after.history || []).find(h => h.userId === erin.user.id);
  ok(row && row.date === localToday, `a keep-leave also credits to the client's local date (got ${row && row.date}, wanted ${localToday})`);
}

console.log('\nidempotence still holds: a second /lock never overwrites the first date, local or not');
{
  const finn = await reg('ld_finn', 'pass1234', 'Finn');
  const s = await newSession(finn.token, 'Double Finish Session');
  const first = await post(`/api/sessions/${s.id}/lock`, { localDate: '2010-05-05' }, finn.token);
  const second = await post(`/api/sessions/${s.id}/lock`, { localDate: '2010-05-06' }, finn.token);
  const row1 = (first.history || []).filter(h => h.userId === finn.user.id);
  const row2 = (second.history || []).filter(h => h.userId === finn.user.id);
  ok(row1.length === 1 && row2.length === 1, `still exactly one history row after two /lock calls (got ${row2.length})`);
  ok(row2[0] && row2[0].date === '2010-05-05', `the SECOND call's localDate never overwrites the first (got ${row2[0] && row2[0].date})`);
}

await killAndWait(srv);
console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
