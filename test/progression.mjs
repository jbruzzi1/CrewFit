// "Add weight next time" — the progression rule and everything the log sheet says about it.
//
// Run:  npm test          (starts a server against a fresh throwaway Postgres database)
//
// Every assertion here exists because something was actually wrong. The two that matter most:
//   - a deload used to satisfy "topped out twice" and told a 225 lb squatter to try 140
//   - the advice box could render completely empty, which is the one thing it must never do
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';
import { PgConnection, parseConnString } from '../pgmini.js';

const PORT = process.env.TEST_PORT || 4931;
const B = `http://localhost:${PORT}`;
const DIR = mkdtempSync(join(tmpdir(), 'crewfit-test-'));
const testDb = await freshTestDb('progression');
let fails = 0, srv = null;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };

// Reads every session row, applies `mutator` to every logged set across every session, writes
// each changed row back. Replaces the old direct hand-edit of data.json for the same purpose.
async function mutateAllSessionLogs(mutator) {
  const pg = new PgConnection(parseConnString(testDb.url));
  const r = await pg.query('SELECT id, data FROM sessions');
  let touched = 0;
  for (const row of r.rows) {
    const s = JSON.parse(row.data);
    for (const logs of Object.values(s.logs || {})) for (const l of logs) { mutator(l); touched++; }
    await pg.query('UPDATE sessions SET data = $1::jsonb WHERE id = $2', [JSON.stringify(s), row.id]);
  }
  pg.close();
  return touched;
}

function boot() {
  return new Promise((res, rej) => {
    srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: DIR, DATABASE_URL: testDb.url, PORT: String(PORT) },
      cwd: new URL('..', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    srv.stderr.on('data', d => { err += d; });
    srv.stdout.on('data', d => { if (String(d).includes('CrewFit on')) res(); });
    srv.on('exit', c => rej(new Error(`server exited (${c}):\n${err}`)));
    setTimeout(() => rej(new Error('server never started:\n' + err)), 15000);
  });
}
const stop = () => new Promise(r => { if (!srv) return r(); srv.on('exit', r); srv.kill(); });

async function newUser() {
  const u = 'u' + Math.floor(Math.random() * 1e9);
  const r = await fetch(B + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u, pin: 'pass12', displayName: 'T' }) }).then(x => x.json());
  if (!r.token) throw new Error('register failed: ' + JSON.stringify(r));
  return { H: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + r.token }, username: u };
}
// one session, one working set. lo/hi are the prescribed rep range.
async function log({ H }, name, date, weight, reps, lo = 8, hi = 10, setType) {
  const s = await fetch(B + '/api/sessions', { method: 'POST', headers: H,
    body: JSON.stringify({ name, visibility: 'private', scheduledAt: date,
      exercises: [{ name, defaultSets: 3, defaultReps: lo, defaultRepsMax: hi }] }) }).then(x => x.json());
  await fetch(B + `/api/sessions/${s.id}/log`, { method: 'POST', headers: H,
    body: JSON.stringify({ exerciseId: s.exercises[0].id, weight, reps, setType }) });
  return s;
}
const ask = ({ H }, n) => fetch(B + '/api/progress/exercise/' + encodeURIComponent(n), { headers: H }).then(x => x.json());
const progress = ({ H }) => fetch(B + '/api/progress?weeks=13', { headers: H }).then(x => x.json());

// Mirrors the branch order in openLogSheet() in public/app.js. If that order changes, change
// this — the point is to assert what the USER SEES, not what the endpoint happens to return.
function shown(r) {
  if (r.ready) return 'READY';
  if (r.hold)  return 'HOLD';
  if (r.soon)  return 'ALMOST';
  // One message for every no-advice case, deliberately. It used to report a session count and
  // the count included the workout you were standing in, announcing a session you had not
  // finished. The only variation left is naming the working weight you entered at setup.
  return r.seed ? 'NOT_YET_SEEDED' : 'NOT_YET';
}

await boot();
try {

console.log('the box always says something — it is never empty');
{
  const u = await newUser();
  ok(shown(await ask(u, 'Leg Press')) === 'NOT_YET', 'never logged  -> "When to add weight"');
  await log(u, 'Leg Press', '2026-08-05T18:00:00Z', 270, 10);
  ok(shown(await ask(u, 'Leg Press')) === 'NOT_YET', 'one session   -> the SAME words, no session count');
  ok(shown(await ask(u, 'Nonexistent Lift')) === 'NOT_YET', 'unknown lift  -> no crash, still speaks');
}

console.log('\ndouble progression: top of the range twice AT THE SAME WEIGHT');
{
  const u = await newUser();
  await log(u, 'Leg Press', '2026-08-05T18:00:00Z', 270, 10);
  await log(u, 'Leg Press', '2026-08-12T18:00:00Z', 270, 10);
  const a = await ask(u, 'Leg Press');
  ok(shown(a) === 'READY' && a.ready.suggested === 290, `two clean sessions -> try 290 (+20 machine), got ${a.ready && a.ready.suggested}`);
}
{
  const u = await newUser();
  await log(u, 'Barbell Back Squat', '2026-08-05T18:00:00Z', 245, 10);
  await log(u, 'Barbell Back Squat', '2026-08-12T18:00:00Z', 245, 7);
  const a = await ask(u, 'Barbell Back Squat');
  ok(shown(a) === 'HOLD' && a.hold.targetRepsMax === 10, `fell short last time -> a hold naming a real target, got ${shown(a)}`);
}
{
  const u = await newUser();
  await log(u, 'Flat Barbell Bench Press', '2026-08-05T18:00:00Z', 185, 7);
  await log(u, 'Flat Barbell Bench Press', '2026-08-12T18:00:00Z', 185, 10);
  const a = await ask(u, 'Flat Barbell Bench Press');
  ok(shown(a) === 'ALMOST' && a.soon.weight === 185 && a.soon.targetRepsMax === 10,
     `topped it once -> "one more like that" at 185x10, got ${shown(a)}`);
}
{
  // THE DELOAD. Miss at 225, drop to 135 and hit the top. This used to read as two clean
  // sessions the moment 135 was repeated, and suggested 140 to someone squatting 225.
  const u = await newUser();
  await log(u, 'Barbell Back Squat', '2026-08-01T18:00:00Z', 225, 7);
  await log(u, 'Barbell Back Squat', '2026-08-08T18:00:00Z', 135, 10);
  let a = await ask(u, 'Barbell Back Squat');
  ok(shown(a) === 'ALMOST' && a.soon.weight === 135, `after a deload -> "one more" at 135, not a suggestion (${shown(a)})`);
  await log(u, 'Barbell Back Squat', '2026-08-15T18:00:00Z', 135, 10);
  a = await ask(u, 'Barbell Back Squat');
  ok(shown(a) === 'READY' && a.ready.suggested === 145, `then two clean at 135 -> try 145, got ${a.ready && a.ready.suggested}`);
}
{
  // Topped the range at a HEAVIER weight than last time: they already progressed themselves.
  const u = await newUser();
  await log(u, 'Flat Barbell Bench Press', '2026-08-05T18:00:00Z', 185, 10);
  await log(u, 'Flat Barbell Bench Press', '2026-08-12T18:00:00Z', 200, 10);
  const a = await ask(u, 'Flat Barbell Bench Press');
  ok(shown(a) === 'ALMOST' && a.soon.weight === 200, `jumped the weight -> "one more" at the NEW weight, got ${a.soon && a.soon.weight}`);
}

console.log('\nthe date the set was PERFORMED decides order, not the day it was typed');
{
  const u = await newUser();
  await log(u, 'Barbell Overhead Press', '2026-08-12T18:00:00Z', 95, 10);   // logged first, happened second
  await log(u, 'Barbell Overhead Press', '2026-08-05T18:00:00Z', 95, 7);
  ok(shown(await ask(u, 'Barbell Overhead Press')) === 'ALMOST', 'backfilled an older session -> still "one more", not a hold');
}

console.log('\nwarm-ups and drop sets are not working sets');
{
  const u = await newUser();
  await log(u, 'Leg Press', '2026-08-05T18:00:00Z', 90, 10, 8, 10, 'warmup');
  await log(u, 'Leg Press', '2026-08-12T18:00:00Z', 90, 10, 8, 10, 'warmup');
  const a = await ask(u, 'Leg Press');
  ok(a.sessions === 0 && !a.ready && !a.soon, `two warm-up-only sessions -> no advice built on them (sessions=${a.sessions})`);
}

console.log('\nkilograms');
{
  const u = await newUser();
  await fetch(B + '/api/me/units', { method: 'POST', headers: u.H, body: JSON.stringify({ units: 'kg' }) });
  await log(u, 'Barbell Row', '2026-08-05T18:00:00Z', 60, 10);
  await log(u, 'Barbell Row', '2026-08-12T18:00:00Z', 60, 10);
  const a = await ask(u, 'Barbell Row');
  ok(a.unit === 'kg' && a.ready && a.ready.suggested === 62.5, `60 kg twice -> try 62.5 kg, got ${a.unit} ${a.ready && a.ready.suggested}`);
}

console.log('\nbodyweight lifts rank and advise at all');
{
  const u = await newUser();
  await log(u, 'Pull-Up', '2026-08-05T18:00:00Z', 0, 7);
  await log(u, 'Pull-Up', '2026-08-12T18:00:00Z', 0, 10);
  const a = await ask(u, 'Pull-Up');
  ok(shown(a) === 'ALMOST' && a.soon.weight === 0,
     'a pull-up at bodyweight gets advice (the sheet renders weight 0 as "bodyweight", not "0 lb")');
}

console.log('\na seeded working weight is the first half of the pair');
{
  const u = await newUser();
  const sr = await fetch(B + '/api/me/seeds', { method: 'PUT', headers: u.H,
    body: JSON.stringify({ exercise: 'Flat Barbell Bench Press', weight: 185, reps: 10 }) }).then(x => x.json());
  ok(sr.seeds && sr.seeds['Flat Barbell Bench Press'], 'the seed saved');
  let a = await ask(u, 'Flat Barbell Bench Press');
  ok(shown(a) === 'NOT_YET_SEEDED' && a.seed && a.seed.weight === 185,
     `seeded -> the sheet names their own working weight back to them (${shown(a)})`);
  await log(u, 'Flat Barbell Bench Press', '2026-08-12T18:00:00Z', 185, 10);
  a = await ask(u, 'Flat Barbell Bench Press');
  ok(shown(a) === 'READY', `then one clean session -> a real suggestion, as promised (${shown(a)})`);
}
{
  // The sheet prints the seeded weight back at the user, so it has to follow their unit too.
  const u = await newUser();
  await fetch(B + '/api/me/seeds', { method: 'PUT', headers: u.H,
    body: JSON.stringify({ exercise: 'Leg Press', weight: 270, reps: 10 }) });
  await fetch(B + '/api/me/units', { method: 'POST', headers: u.H, body: JSON.stringify({ units: 'kg' }) });
  const a = await ask(u, 'Leg Press');
  ok(a.seed && a.seed.unit === 'kg' && a.seed.weight === 122.5,
     `a 270 lb seed reads as 122.5 kg after switching units, got ${a.seed && a.seed.weight} ${a.seed && a.seed.unit}`);
}

console.log('\nsets logged before rep targets were recorded (pre-v154 data)');
{
  const u = await newUser();
  await log(u, 'Leg Press', '2026-08-05T18:00:00Z', 270, 8);
  await log(u, 'Leg Press', '2026-08-12T18:00:00Z', 270, 9);
  await stop();
  await mutateAllSessionLogs(l => { delete l.targetReps; delete l.targetRepsMax; });
  await boot();
  const r = await fetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u.username, pin: 'pass12' }) }).then(x => x.json());
  const u2 = { H: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + r.token } };
  const a = await ask(u2, 'Leg Press');
  ok(!a.hold, 'no "8 of null reps" hold invented from a set with no target');
  ok(shown(a) === 'NOT_YET', `the box still says something rather than rendering empty (${shown(a)})`);
  const p = await progress(u2);
  ok(!JSON.stringify(p).includes('"targetRepsMax":null'), 'no null rep targets anywhere in /api/progress');
}

console.log('\nthe server boots with kilogram sets in the file');
{
  // toLb() reads LB_PER_KG only when a set was typed in kg. With the boot block at the top of
  // server.js that reference was in the temporal dead zone: one kg set and the process died
  // before it could listen, permanently, until data.json was hand-edited.
  await stop();
  const stamped = await mutateAllSessionLogs(l => { l.unit = 'kg'; });
  let booted = true;
  try { await boot(); } catch (e) { booted = false; console.log('    ' + String(e).split('\n')[1]); }
  ok(booted, `boots with ${stamped} kg-typed sets in the database`);
}

console.log('\nswitching units re-prints old sets in the NEW unit, converted');
{
  const u = await newUser();
  await log(u, 'Flat Barbell Bench Press', '2026-08-05T18:00:00Z', 185, 10);
  await log(u, 'Flat Barbell Bench Press', '2026-08-12T18:00:00Z', 185, 10);
  let a = await ask(u, 'Flat Barbell Bench Press');
  ok(a.ready.suggested === 190, `in lb: try 190, got ${a.ready.suggested}`);
  await fetch(B + '/api/me/units', { method: 'POST', headers: u.H, body: JSON.stringify({ units: 'kg' }) });
  a = await ask(u, 'Flat Barbell Bench Press');
  // 185 lb is 83.9 kg. Reprinting the digits "185" next to "kg" would be a 408 lb bench,
  // and one tap would write it into their history.
  ok(a.unit === 'kg' && a.ready.weight === 84 && a.ready.suggested === 86.5,
     `switched to kg: 185 lb reads as 84 kg -> try 86.5, got ${a.ready.weight} -> ${a.ready.suggested}`);
}

console.log('\nthe same bar weight typed in different units is still the same weight');
{
  const u = await newUser();
  await log(u, 'Barbell Row', '2026-08-05T18:00:00Z', 220.5, 10);      // lb
  await fetch(B + '/api/me/units', { method: 'POST', headers: u.H, body: JSON.stringify({ units: 'kg' }) });
  await log(u, 'Barbell Row', '2026-08-12T18:00:00Z', 100, 10);        // 100 kg = 220.46 lb
  const a = await ask(u, 'Barbell Row');
  ok(shown(a) === 'READY', `220.5 lb then 100 kg is not a weight change (${shown(a)})`);
}

console.log('\na bodyweight lift is told to ADD weight, never to "try 5 lb"');
{
  const u = await newUser();
  await log(u, 'Pull-Up', '2026-08-05T18:00:00Z', 0, 10);
  await log(u, 'Pull-Up', '2026-08-12T18:00:00Z', 0, 10);
  const a = await ask(u, 'Pull-Up');
  ok(shown(a) === 'READY' && a.ready.bodyweight === true && a.ready.step > 0,
     `topped twice at bodyweight -> flagged so the sheet says "Add ${a.ready && a.ready.step} lb", not "Try ${a.ready && a.ready.suggested} lb"`);
}

console.log('\na seed only pairs with a session at the SAME weight');
{
  const u = await newUser();
  await fetch(B + '/api/me/seeds', { method: 'PUT', headers: u.H,
    body: JSON.stringify({ exercise: 'Barbell Back Squat', weight: 185, reps: 10 }) });
  await log(u, 'Barbell Back Squat', '2026-08-12T18:00:00Z', 200, 10);   // heavier than the seed
  const a = await ask(u, 'Barbell Back Squat');
  ok(shown(a) === 'ALMOST', `seeded 185 but logged 200 -> "one more", not a suggestion (${shown(a)})`);
}

console.log('\nswapping an exercise keeps its history');
{
  const u = await newUser();
  const s = await log(u, 'Flat Barbell Bench Press', '2026-08-12T18:00:00Z', 185, 10);
  // swap, then log against the SAME exercise id — which is what the client does
  const sug = await fetch(B + `/api/sessions/${s.id}/suggest`, { method: 'POST', headers: u.H,
    body: JSON.stringify({ exerciseId: s.exercises[0].id, swapTo: 'Incline Barbell Bench Press' }) }).then(x => x.json());
  const editId = sug.suggestedEdits[sug.suggestedEdits.length - 1].id;
  await fetch(B + `/api/sessions/${s.id}/suggest/${editId}/approve`, { method: 'POST', headers: u.H });
  const after = await fetch(B + '/api/sessions/' + s.id, { headers: u.H }).then(x => x.json());
  const v = after.variations && after.variations[s.exercises[0].id];
  const swapTo = v && Object.values(v)[0] && Object.values(v)[0].swapTo;
  ok(swapTo === 'Incline Barbell Bench Press', `the swap is recorded on the session (got ${swapTo})`);
  const underSwap = await ask(u, 'Incline Barbell Bench Press');
  ok(underSwap.sessions === 1,
     `logged BEFORE approving the swap -> approving corrects the name (got ${underSwap.sessions})`);
  const underOld = await ask(u, 'Flat Barbell Bench Press');
  ok(underOld.sessions === 0, `and it is no longer filed under the lift not performed (got ${underOld.sessions})`);
}
{
  // the ordinary order: swap approved first, then the sets are logged
  const u = await newUser();
  const s = await fetch(B + '/api/sessions', { method: 'POST', headers: u.H,
    body: JSON.stringify({ name: 'Pull', visibility: 'private', scheduledAt: '2026-08-12T18:00:00Z',
      exercises: [{ name: 'Barbell Row', defaultSets: 3, defaultReps: 8, defaultRepsMax: 10 }] }) }).then(x => x.json());
  const sug = await fetch(B + `/api/sessions/${s.id}/suggest`, { method: 'POST', headers: u.H,
    body: JSON.stringify({ exerciseId: s.exercises[0].id, swapTo: 'Seated Cable Row' }) }).then(x => x.json());
  await fetch(B + `/api/sessions/${s.id}/suggest/${sug.suggestedEdits.slice(-1)[0].id}/approve`,
    { method: 'POST', headers: u.H });
  await fetch(B + `/api/sessions/${s.id}/log`, { method: 'POST', headers: u.H,
    body: JSON.stringify({ exerciseId: s.exercises[0].id, weight: 90, reps: 10 }) });
  const a = await ask(u, 'Seated Cable Row'), b = await ask(u, 'Barbell Row');
  ok(a.sessions === 1 && b.sessions === 0,
     `swap first, then log -> files under the lift performed (cable ${a.sessions}, row ${b.sessions})`);
}

console.log('\nexactly ONE set per lift wears the PR badge');
{
  const u = await newUser();
  // an ordinary ascending session: work up, then the top set
  const s1 = await log(u, 'Towel Pull-Up', '2026-08-15T18:00:00Z', 45, 8);
  await fetch(B + `/api/sessions/${s1.id}/log`, { method: 'POST', headers: u.H,
    body: JSON.stringify({ exerciseId: s1.exercises[0].id, weight: 79, reps: 8 }) });
  let s = await fetch(B + '/api/sessions/' + s1.id, { headers: u.H }).then(x => x.json());
  let logs = s.logs[Object.keys(s.logs)[0]];
  let flagged = logs.filter(l => l.isPr);
  ok(flagged.length === 1, `two sets, one record — got ${flagged.length} PR badge(s)`);
  ok(flagged[0] && Number(flagged[0].weight) === 79, `the heavier set holds it (got ${flagged[0] && flagged[0].weight})`);

  // and across sessions: beating it moves the badge, it does not add one
  const s2 = await log(u, 'Towel Pull-Up', '2026-08-22T18:00:00Z', 90, 8);
  const a = await fetch(B + '/api/sessions/' + s1.id, { headers: u.H }).then(x => x.json());
  const b = await fetch(B + '/api/sessions/' + s2.id, { headers: u.H }).then(x => x.json());
  const all = [...a.logs[Object.keys(a.logs)[0]], ...b.logs[Object.keys(b.logs)[0]]];
  flagged = all.filter(l => l.isPr);
  ok(flagged.length === 1 && Number(flagged[0].weight) === 90,
     `after beating it, still one badge and it moved to 90 (got ${flagged.length} on ${flagged[0] && flagged[0].weight})`);
}

console.log('\nnobody can reset a password they cannot prove they own');
{
  // /api/reset took a username and a new password and set it, with NO login of any kind, and
  // /api/forgot confirmed a username existed and handed back the real name. Two anonymous
  // requests took over any account. Both are off until there is a way to verify who is asking.
  const u = await newUser();
  const forgot = await fetch(B + '/api/forgot', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u.username }) });
  ok(forgot.status === 503, `/api/forgot is off (got ${forgot.status})`);
  const body = await forgot.json();
  ok(!JSON.stringify(body).includes(u.username) && !body.displayName,
     'and it leaks neither the username nor the real name');

  const reset = await fetch(B + '/api/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u.username, newPin: 'pass99' }) });
  ok(reset.status === 503, `/api/reset is off (got ${reset.status})`);

  // the decisive one: the password must be UNCHANGED after that attempt
  const stolen = await fetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u.username, pin: 'pass99' }) }).then(x => x.json());
  ok(!stolen.token, 'the attacker cannot log in with the password they tried to set');
  const real = await fetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u.username, pin: 'pass12' }) }).then(x => x.json());
  ok(!!real.token, 'and the real owner is not locked out');
}

console.log('\nremoving an exercise from a workout cannot strand the sets you logged');
{
  const u = await newUser();
  const s1 = await log(u, 'Flat Barbell Bench Press', '2026-08-10T18:00:00Z', 185, 10);
  const s2 = await log(u, 'Barbell Back Squat',       '2026-08-11T18:00:00Z', 315, 5);

  const before = await fetch(B + '/api/progress?weeks=4', { headers: u.H }).then(x => x.json());
  const names = () => before.prs.map(p => p.exercise);
  ok(names().includes('Flat Barbell Bench Press'), `the bench record exists first (${names().join(', ')})`);

  // the creator edits the workout and drops the exercise the sets belong to
  const full = await fetch(B + '/api/sessions/' + s1.id, { headers: u.H }).then(x => x.json());
  const r = await fetch(B + '/api/sessions/' + s1.id, { method: 'PUT', headers: u.H,
    body: JSON.stringify({ name: full.name, scheduledAt: full.scheduledAt, exercises: [] }) });
  ok(r.status < 400, `the edit went through (${r.status})`);

  const after = await fetch(B + '/api/progress?weeks=4', { headers: u.H }).then(x => x.json());
  const got = after.prs.map(p => p.exercise);
  ok(got.includes('Flat Barbell Bench Press'),
     `the record keeps its NAME after the exercise is removed (got ${got.join(', ') || 'nothing'})`);
  ok(!got.some(n => /^e_/.test(n)),
     `and no raw id leaks out as an exercise name (got ${got.join(', ') || 'nothing'})`);
  ok(got.includes('Barbell Back Squat'), 'the untouched workout is unaffected');
}

console.log('\n/api/progress agrees with the log sheet');
{
  const u = await newUser();
  await log(u, 'Flat Barbell Bench Press', '2026-08-05T18:00:00Z', 185, 7);
  await log(u, 'Flat Barbell Bench Press', '2026-08-12T18:00:00Z', 185, 10);
  const p = await progress(u);
  ok(Array.isArray(p.soon) && p.soon.some(x => x.exercise === 'Flat Barbell Bench Press'),
     'a lift the sheet calls "one more like that" is not missing from the Progress tab');
  // The Progress card prints "Nothing to add yet" only when ready AND soon AND holds are all
  // empty — otherwise it contradicted itself directly above a populated list.
  ok(!p.ready.length && p.soon.length,
     'the exact state that used to print "Nothing to add yet" above real rows');
}

} finally { await stop(); rmSync(DIR, { recursive: true, force: true }); await testDb.drop(); }

console.log(fails ? `\n${fails} FAILURE(S)\n` : '\nall assertions passed\n');
process.exit(fails ? 1 : 0);
