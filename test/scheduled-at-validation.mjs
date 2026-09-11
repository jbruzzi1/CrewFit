// Sep 11 2026 (cold-review finding on the recap-date-mismatch fix -- see the comment above
// normalizedScheduledAt() in server.js, and rcDay() in public/app.js): scheduledAt used to be
// trusted as-sent once capStr trimmed its length, with no check that it actually carried a time
// component. Every screen that renders it (rcDay/fmtDate/fmtWhen, all client-side) hands it
// straight to `new Date()`, which reads a bare date ("2026-09-11", no time) as UTC MIDNIGHT --
// the wrong calendar day for anyone west of UTC. Real server + real Postgres; both write sites
// (POST /api/sessions and PUT /api/sessions/:id) are covered, plus every currently-real client
// shape (a full ISO timestamp, exactly what app.js always sends) is proven untouched by the
// change.
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

const DIR = mkdtempSync(join(tmpdir(), 'schedat-'));
const testDb = await freshTestDb('schedat');
const PORT = 4796, BASE = `http://localhost:${PORT}`;
const srv = await boot(PORT, DIR, testDb.url);
if (!srv) { console.log('FAIL: server did not boot'); process.exit(1); }

const H = t => ({ ...J, Authorization: 'Bearer ' + t });
const api = (method, path, token, body) => fetch(BASE + path, { method, headers: token ? H(token) : J, body: body !== undefined ? JSON.stringify(body) : undefined }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }));
const reg = n => api('POST', '/api/register', null, { username: n, pin: 'pass1234', displayName: n[0].toUpperCase() + n.slice(1) }).then(r => r.json);

try {

const rand = Math.floor(Math.random() * 1e6);
const alice = await reg(`schedat_alice${rand}`);
const A = alice.token;
const nowMs = Date.now();

console.log('POST /api/sessions -- every REAL shape app.js actually sends is untouched');
{
  const full = new Date(Date.now() - 5 * 86400e3).toISOString();
  const r = await api('POST', '/api/sessions', A, { name: 'Real Session', visibility: 'private', scheduledAt: full, exercises: [{ name: 'Bench Press' }] });
  ok(r.json.scheduledAt === full, `a full ISO timestamp (exactly what app.js's new Date(...).toISOString() always sends) is stored verbatim, untouched (got "${r.json.scheduledAt}")`);

  const r2 = await api('POST', '/api/sessions', A, { name: 'No Time Field', visibility: 'private', exercises: [{ name: 'Row' }] });
  ok(typeof r2.json.scheduledAt === 'string' && Math.abs(new Date(r2.json.scheduledAt).getTime() - nowMs) < 60000,
    `omitting scheduledAt entirely still falls back to "now", exactly as before this change (got "${r2.json.scheduledAt}")`);
}

console.log('\nPOST /api/sessions -- the OTHER real, pre-existing shape (epoch seconds/ms, see');
console.log('perfDate()\'s own comment) must keep working -- a first draft of this fix broke it,');
console.log('caught by test/workout-reminders.mjs\'s own "DIFFERENT scheduledAt formats" case');
{
  const epochSeconds = String(Math.floor((Date.now() - 2 * 86400e3) / 1000));
  const r = await api('POST', '/api/sessions', A, { name: 'Epoch Seconds', visibility: 'private', scheduledAt: epochSeconds, exercises: [{ name: 'Pull-Up' }] });
  ok(r.json.scheduledAt === epochSeconds, `a pure-digits epoch-SECONDS scheduledAt is stored verbatim, untouched, got "${r.json.scheduledAt}"`);

  const epochMs = String(Date.now() - 4 * 86400e3);
  const r2 = await api('POST', '/api/sessions', A, { name: 'Epoch Millis', visibility: 'private', scheduledAt: epochMs, exercises: [{ name: 'Dip' }] });
  ok(r2.json.scheduledAt === epochMs, `a pure-digits epoch-MILLISECONDS scheduledAt is stored verbatim too, got "${r2.json.scheduledAt}"`);
}

console.log('\nPOST /api/sessions -- the gap this fix closes: a bare date-only scheduledAt');
{
  // "2026-09-11" has no time component -- new Date() would read it as UTC midnight, a fabricated
  // clock time on the wrong calendar day for anyone west of UTC. This can't come from app.js
  // today (it always sends a full toISOString() value), but nothing used to stop it either.
  const r = await api('POST', '/api/sessions', A, { name: 'Bare Date', visibility: 'private', scheduledAt: '2026-09-11', exercises: [{ name: 'Squat' }] });
  ok(r.status === 200 && !r.json.error, `a bare date-only scheduledAt is NOT rejected outright -- request still succeeds (got status ${r.status}, ${JSON.stringify(r.json && r.json.error)})`);
  ok(r.json.scheduledAt !== '2026-09-11', `...but the bare date is NOT stored as-is (would later render one day off for anyone west of UTC), got "${r.json.scheduledAt}"`);
  ok(Math.abs(new Date(r.json.scheduledAt).getTime() - nowMs) < 60000,
    `...it falls back to "now" instead, same fallback used when nothing is sent at all (got "${r.json.scheduledAt}")`);

  const garbage = await api('POST', '/api/sessions', A, { name: 'Garbage', visibility: 'private', scheduledAt: 'not a date at all', exercises: [{ name: 'Deadlift' }] });
  ok(Math.abs(new Date(garbage.json.scheduledAt).getTime() - nowMs) < 60000, `outright garbage also falls back to "now" rather than being stored unparseable, got "${garbage.json.scheduledAt}"`);

  const empty = await api('POST', '/api/sessions', A, { name: 'Empty String', visibility: 'private', scheduledAt: '', exercises: [{ name: 'Lunge' }] });
  ok(Math.abs(new Date(empty.json.scheduledAt).getTime() - nowMs) < 60000, `an empty string falls back to "now" too, got "${empty.json.scheduledAt}"`);
}

console.log('\nPUT /api/sessions/:id -- editing keeps the same guard, and leaving scheduledAt out changes nothing');
{
  const original = new Date(Date.now() - 3 * 86400e3).toISOString();
  const created = await api('POST', '/api/sessions', A, { name: 'Editable', visibility: 'private', scheduledAt: original, exercises: [{ name: 'Overhead Press' }] });
  const id = created.json.id;

  const noTimeField = await api('PUT', `/api/sessions/${id}`, A, { name: 'Editable', exercises: [{ name: 'Overhead Press' }] });
  ok(noTimeField.json.scheduledAt === original, `PUT with no scheduledAt field at all leaves the existing value alone (unchanged since before this fix), got "${noTimeField.json.scheduledAt}"`);

  const legit = new Date(Date.now() - 1 * 86400e3).toISOString();
  const realEdit = await api('PUT', `/api/sessions/${id}`, A, { name: 'Editable', scheduledAt: legit, exercises: [{ name: 'Overhead Press' }] });
  ok(realEdit.json.scheduledAt === legit, `PUT with a real full-timestamp edit (exactly what editSession's real UI flow sends) is stored verbatim, got "${realEdit.json.scheduledAt}"`);

  const bareEdit = await api('PUT', `/api/sessions/${id}`, A, { name: 'Editable', scheduledAt: '2099-01-01', exercises: [{ name: 'Overhead Press' }] });
  ok(bareEdit.json.scheduledAt !== '2099-01-01', `PUT with a bare date-only scheduledAt does not get stored as-is either, got "${bareEdit.json.scheduledAt}"`);
  ok(Math.abs(new Date(bareEdit.json.scheduledAt).getTime() - Date.now()) < 60000, `...falls back to "now" on the edit path too, got "${bareEdit.json.scheduledAt}"`);
}

} finally {
  srv.kill();
  await testDb.drop();
}

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
