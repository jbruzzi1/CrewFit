// Oct 2 2026 -- permanent coverage for Tier 3 audit item "editing a custom exercise retroactively
// rewrites past Progress stats" (Jeff: "I agree, there should be a disclaimer for this also").
//
// Root cause, confirmed by reading volumeFor/volumeTrendFor/everTrainedMusclesFor and the
// findExLibEntry they all call: every one of those Progress computations resolves a logged set's
// exercise LIVE, by name, against whatever the custom exercise's CURRENT muscle_groups says --
// there is no snapshot of which muscle(s) a set counted toward at the moment it was logged. So
// PUT /api/exercises/custom/:id letting muscle_groups change with no guard meant editing the
// definition silently rewrote every ALREADY-LOGGED set's muscle-group credit, with nothing on the
// Progress page hinting anything had changed.
//
// Fix mirrors the DELETE route's own pre-existing guard (exerciseNameEverLogged, see its comment
// in server.js) exactly: once the exercise's name has ever been logged by anyone, anywhere,
// muscle_groups (and category, which is only ever mg[0]) are frozen -- create a new exercise for a
// different muscle group instead. equipment/level/is_compound/pattern are untouched by this fix
// because they are never read by any Progress computation (confirmed by grep: the only fields
// findExLibEntry's callers read off the resolved lib entry are muscle_groups and secondary) -- only
// display and the add-time default-target suggestion use them, so they stay freely editable even
// once logged.
//
// GET /api/exercises also gets a new `historyLocked` flag (mine-only, so the scan this requires
// never runs for an exercise that isn't the caller's own) so the client can disable the muscle
// picker up front instead of letting someone pick a new one and only get turned away on Save.
//
// Run:  npm test
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';

const PORT = process.env.TEST_PORT_OCT2EXLOCK || 4986;
const B = `http://localhost:${PORT}`;
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('oct2exlock');
let fails = 0, srv = null;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const J = { 'Content-Type': 'application/json' };

function boot(dir) {
  return new Promise((res, rej) => {
    srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(PORT) },
      cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    srv.stderr.on('data', d => { err += d; });
    srv.stdout.on('data', d => { if (String(d).includes('CrewFit on')) res(); });
    srv.on('exit', c => rej(new Error(`server exited (${c}):\n${err}`)));
    setTimeout(() => rej(new Error('server never started:\n' + err)), 15000);
  });
}
const DIR = mkdtempSync(join(tmpdir(), 'oct2exlock-'));
await boot(DIR);

async function api(path, method, token, body) {
  const r = await fetch(B + path, { method, headers: { ...J, ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
}
const post = (p, b, tok) => api(p, 'POST', tok, b).then(r => r.body);
const postFull = (p, b, tok) => api(p, 'POST', tok, b);
const putFull = (p, b, tok) => api(p, 'PUT', tok, b);
const get = (p, tok) => api(p, 'GET', tok).then(r => r.body);
const reg = (u) => post('/api/register', { username: u, pin: 'pass1234', displayName: u });

console.log('setup: a custom exercise with NO logged sets yet -- muscle group must still be freely editable (nothing to protect yet)');
{
  const amy = await reg('oct2exlock_amy');
  const created = await post('/api/exercises/custom',
    { name: 'Oct2Lock Fly', muscle_groups: ['chest'], equipment: ['cable'], level: 'beginner', is_compound: false, pattern: 'push' }, amy.token);
  ok(!created.error, `custom exercise created (${JSON.stringify(created.error || 'ok')})`);

  const beforeLog = await get('/api/exercises', amy.token);
  const mineBefore = beforeLog.find(e => e.mine && e.name === 'Oct2Lock Fly');
  ok(!!mineBefore, 'shows up in GET /api/exercises as mine');
  ok(mineBefore.historyLocked === false, `historyLocked is false before any set is logged against it (got ${mineBefore.historyLocked})`);

  const editBefore = await putFull('/api/exercises/custom/' + mineBefore.id,
    { muscle_groups: ['lats'], equipment: ['cable'], level: 'beginner', is_compound: false, pattern: 'pull' }, amy.token);
  ok(editBefore.status === 200 && !editBefore.body.error, `muscle group change is accepted pre-log (got ${editBefore.status}, ${JSON.stringify(editBefore.body)})`);
  ok(editBefore.body.muscle_groups && editBefore.body.muscle_groups[0] === 'lats', `muscle_groups actually changed to 'lats' (got ${JSON.stringify(editBefore.body.muscle_groups)})`);

  console.log('\nnow log a real working set against it, by name, through a session -- the exact path that feeds volumeFor/everTrainedMusclesFor');
  const session = await post('/api/sessions', { name: 'Oct2Lock Day', scheduledAt: new Date().toISOString(), visibility: 'private', exercises: [{ name: 'Oct2Lock Fly' }] }, amy.token);
  ok(!session.error, `session created (${JSON.stringify(session.error || 'ok')})`);
  const logged = await postFull('/api/sessions/' + session.id + '/log', { exerciseId: session.exercises[0].id, weight: 50, reps: 10 }, amy.token);
  ok(logged.status === 200 && !logged.body.error, `set logged against 'Oct2Lock Fly' (got ${logged.status}, ${JSON.stringify(logged.body)})`);

  console.log('\nGET /api/exercises now reports historyLocked -- the client can disable the picker before Save is even tried');
  const afterLog = await get('/api/exercises', amy.token);
  const mineAfter = afterLog.find(e => e.mine && e.name === 'Oct2Lock Fly');
  ok(mineAfter.historyLocked === true, `historyLocked flips to true once a set is logged (got ${mineAfter.historyLocked})`);

  console.log('\nPUT now refuses a muscle_groups CHANGE (the retroactive-rewrite bug itself)');
  const editAfterChange = await putFull('/api/exercises/custom/' + mineAfter.id,
    { muscle_groups: ['quads'], equipment: ['cable'], level: 'beginner', is_compound: false, pattern: 'pull' }, amy.token);
  ok(editAfterChange.status === 409 && !!editAfterChange.body.error,
     `changing muscle_groups after a set is logged is refused (got ${editAfterChange.status}, ${JSON.stringify(editAfterChange.body)})`);
  const stillUnchanged = await get('/api/exercises', amy.token);
  const stillBack = stillUnchanged.find(e => e.mine && e.name === 'Oct2Lock Fly');
  ok(stillBack.muscle_groups[0] === 'lats', `muscle_groups is genuinely untouched by the refused attempt (got ${JSON.stringify(stillBack.muscle_groups)})`);

  console.log('\nPUT still allows saving with the SAME muscle_groups it already has (not a hard lock on the whole route, just on actually changing it)');
  const editSame = await putFull('/api/exercises/custom/' + mineAfter.id,
    { muscle_groups: ['lats'], equipment: ['dumbbell'], level: 'intermediate', is_compound: true, pattern: 'pull' }, amy.token);
  ok(editSame.status === 200 && !editSame.body.error, `re-saving the SAME muscle group succeeds (got ${editSame.status}, ${JSON.stringify(editSame.body)})`);
  ok(editSame.body.equipment[0] === 'dumbbell' && editSame.body.level === 'intermediate' && editSame.body.is_compound === true,
     `AND the fields Progress never reads (equipment/level/is_compound) saved too -- confirming only muscle_groups is locked, not the whole route (got ${JSON.stringify({ equipment: editSame.body.equipment, level: editSame.body.level, is_compound: editSame.body.is_compound })})`);
}

console.log('\ncold-review catch: a pure REORDER of a multi-value muscle_groups array is not a real change (every Progress computation credits by set membership, never by position) and must NOT be refused');
{
  const dina = await reg('oct2exlock_dina');
  const created = await post('/api/exercises/custom',
    { name: 'Oct2Lock Multi', muscle_groups: ['chest', 'shoulders'], equipment: [], level: 'beginner', is_compound: true, pattern: 'push' }, dina.token);
  ok(!created.error, `multi-muscle custom exercise created (${JSON.stringify(created.error || 'ok')})`);
  const session = await post('/api/sessions', { name: 'Oct2Lock Multi Day', scheduledAt: new Date().toISOString(), visibility: 'private', exercises: [{ name: 'Oct2Lock Multi' }] }, dina.token);
  await postFull('/api/sessions/' + session.id + '/log', { exerciseId: session.exercises[0].id, weight: 60, reps: 8 }, dina.token);

  const lib = await get('/api/exercises', dina.token);
  const mine = lib.find(e => e.mine && e.name === 'Oct2Lock Multi');
  ok(mine.historyLocked === true, 'historyLocked is true once logged (sanity, same as the single-muscle case above)');

  const reordered = await putFull('/api/exercises/custom/' + mine.id,
    { muscle_groups: ['shoulders', 'chest'], equipment: [], level: 'beginner', is_compound: true, pattern: 'push' }, dina.token);
  ok(reordered.status === 200 && !reordered.body.error,
     `the SAME two muscles, reordered, is accepted -- not treated as a real change (got ${reordered.status}, ${JSON.stringify(reordered.body)})`);

  const actuallyDifferent = await putFull('/api/exercises/custom/' + mine.id,
    { muscle_groups: ['shoulders', 'triceps'], equipment: [], level: 'beginner', is_compound: true, pattern: 'push' }, dina.token);
  ok(actuallyDifferent.status === 409,
     `but swapping in a genuinely DIFFERENT set of muscles is still refused (got ${actuallyDifferent.status}, ${JSON.stringify(actuallyDifferent.body)})`);
}

console.log('\nthe lock is by NAME, not by owner -- matches the pre-existing DELETE guard\'s own deliberately-over-broad behavior (two different custom exercises can share a name; nothing links a stored log row back to which owner\'s definition was meant)');
{
  const ben = await reg('oct2exlock_ben');
  const carl = await reg('oct2exlock_carl');
  const sharedName = 'Oct2Lock Shared Move';
  const bensEx = await post('/api/exercises/custom', { name: sharedName, muscle_groups: ['shoulders'], equipment: [], level: 'beginner', is_compound: false, pattern: 'push' }, ben.token);
  const carlsEx = await post('/api/exercises/custom', { name: sharedName, muscle_groups: ['shoulders'], equipment: [], level: 'beginner', is_compound: false, pattern: 'push' }, carl.token);
  ok(!bensEx.error && !carlsEx.error, 'both users independently created a custom exercise with the identical name (allowed, pre-existing rule)');

  // Ben logs a set under the shared name -- Carl never logs anything.
  const session = await post('/api/sessions', { name: 'Ben Day', scheduledAt: new Date().toISOString(), visibility: 'private', exercises: [{ name: sharedName }] }, ben.token);
  await postFull('/api/sessions/' + session.id + '/log', { exerciseId: session.exercises[0].id, weight: 20, reps: 12 }, ben.token);

  const carlsLib = await get('/api/exercises', carl.token);
  const carlsRow = carlsLib.find(e => e.mine && e.name === sharedName);
  ok(carlsRow.historyLocked === true,
     `Carl's own same-named exercise also reads historyLocked -- the name has been logged by SOMEONE, and the route can't tell which owner's definition a bare name string meant (got ${carlsRow.historyLocked})`);
  const carlsEdit = await putFull('/api/exercises/custom/' + carlsRow.id, { muscle_groups: ['biceps'], equipment: [], level: 'beginner', is_compound: false, pattern: 'push' }, carl.token);
  ok(carlsEdit.status === 409, `and Carl is refused too, even though he personally never logged anything under this name (got ${carlsEdit.status})`);
}

srv.kill();
await testDb.drop();
console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
