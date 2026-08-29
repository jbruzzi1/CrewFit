// v250 audit finding: groupPrsForFeed() (server.js) builds the "hit a new PR on X (weight×reps)"
// text for Recent Activity / Friends' Activity by interpolating the raw p.weight number with no
// unit at all -- the exact ambiguity v248 fixed for the profile PR list (prLabel/unitOf in
// app.js), just never ported to this feed text. A kg PR reads as an unlabeled number here: if
// misread as lb it understates the real weight by more than 2x, and vice versa for an lb PR
// misread as kg.
//
// This proves the server text itself carries the right unit (single-PR case, the only one that
// shows a weight at all -- the multi-PR grouped case only ever lists exercise names), including
// the bodyweight edge case (weight 0, e.g. a pull-up-style PR) which prLabel already special-cases
// as plain reps with no unit.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const J = { 'Content-Type': 'application/json' };
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('prfeedunits');

function boot(port, dir) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; srv.stdout.on('data', d => { out += d; if (String(d).includes('CrewFit on')) res({ srv, out }); });
    srv.on('exit', () => res({ srv: null, out }));
    setTimeout(() => res({ srv, out }), 15000);
  });
}

const DIR = mkdtempSync(join(tmpdir(), 'prfeedunits-'));
const PORT = 4987, B = `http://localhost:${PORT}`;
const { srv } = await boot(PORT, DIR);
ok(!!srv, 'server boots');

const post = (p, b, tok) => fetch(B + p, { method: 'POST', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b) }).then(r => r.json());
const get = (p, tok) => fetch(B + p, { headers: tok ? { Authorization: 'Bearer ' + tok } : {} }).then(r => r.json());
const reg = (username, pin, displayName) => post('/api/register', { username, pin, displayName });

console.log('a kg PR shows its real unit in Recent Activity, not a bare ambiguous number');
{
  const kilo = await reg('pfu_kilo', 'pass1234', 'Kilo');
  await post('/api/me/units', { units: 'kg' }, kilo.token);
  const s = await post('/api/sessions', {
    name: 'Leg Day', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Squat' }],
    inviteUsernames: [], visibility: 'private',
  }, kilo.token);
  // groupPrsForFeed excludes a `firstLog` baseline (the chronologically first-ever log for this
  // exercise, when nothing since has beaten it) from the celebratory feed on purpose (see the
  // comment above it) -- so a genuine earned PR needs a lighter set logged first, then a heavier
  // one that actually beats it, same as pr-units.mjs's server-side block.
  await post('/api/sessions/' + s.id + '/log', { exerciseId: s.exercises[0].id, weight: 80, reps: 5 }, kilo.token);
  await post('/api/sessions/' + s.id + '/log', { exerciseId: s.exercises[0].id, weight: 100, reps: 5, set: 2 }, kilo.token);
  await post('/api/sessions/' + s.id + '/lock', {}, kilo.token);

  const profile = await get('/api/profile/me', kilo.token);
  const prItem = (profile.recentActivity || []).find(i => i.type === 'pr');
  ok(!!prItem, `a PR item shows up in Recent Activity (got ${JSON.stringify(profile.recentActivity)})`);
  ok(prItem && prItem.text.includes('100 kg'), `and it's labelled "100 kg", not a bare "100" (got "${prItem && prItem.text}")`);
}

console.log('\nand an lb PR is still labelled lb (the common case must not have regressed)');
{
  const lber = await reg('pfu_lber', 'pass1234', 'Lber');
  const s = await post('/api/sessions', {
    name: 'Push Day', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Bench Press' }],
    inviteUsernames: [], visibility: 'private',
  }, lber.token);
  await post('/api/sessions/' + s.id + '/log', { exerciseId: s.exercises[0].id, weight: 135, reps: 5 }, lber.token);
  await post('/api/sessions/' + s.id + '/log', { exerciseId: s.exercises[0].id, weight: 185, reps: 5, set: 2 }, lber.token);
  await post('/api/sessions/' + s.id + '/lock', {}, lber.token);

  const profile = await get('/api/profile/me', lber.token);
  const prItem = (profile.recentActivity || []).find(i => i.type === 'pr');
  ok(prItem && prItem.text.includes('185 lb'), `labelled "185 lb" (got "${prItem && prItem.text}")`);
}

console.log('\na bodyweight PR (weight 0, e.g. a pull-up) reads as plain reps -- no meaningless "0 lb"');
{
  const bw = await reg('pfu_bw', 'pass1234', 'Bw');
  const s = await post('/api/sessions', {
    name: 'Pull Day', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Pull-Up' }],
    inviteUsernames: [], visibility: 'private',
  }, bw.token);
  await post('/api/sessions/' + s.id + '/log', { exerciseId: s.exercises[0].id, weight: 0, reps: 8 }, bw.token);
  await post('/api/sessions/' + s.id + '/log', { exerciseId: s.exercises[0].id, weight: 0, reps: 12, set: 2 }, bw.token);
  await post('/api/sessions/' + s.id + '/lock', {}, bw.token);

  const profile = await get('/api/profile/me', bw.token);
  const prItem = (profile.recentActivity || []).find(i => i.type === 'pr');
  ok(!!prItem, 'a bodyweight PR still shows up');
  ok(prItem && prItem.text.includes('12 reps') && !prItem.text.includes('0 lb') && !prItem.text.includes('0 kg'),
    `reads as plain reps, not "0 lb"/"0 kg" (got "${prItem && prItem.text}")`);
}

try { srv && srv.kill(); } catch {}
rmSync(DIR, { recursive: true, force: true });
await testDb.drop();

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
