// What the app tells you to aim for on an exercise nobody has configured.
//
// Run:  npm test
//
// Every one of the 203 library exercises used to get the same target: 3 sets of 8-10 added from
// the library, 3 x 10 everywhere else. So the app prescribed ten-rep deadlifts — the rep count at
// which a heavy hinge stops being a hinge — and it prescribed a REP COUNT for planks, treadmill
// runs and farmer's carries, where reps are not the unit at all.
//
// The numbers follow ACSM's 2026 position stand (Med Sci Sports Exerc, April 2026; 137 studies):
// strength is load-specific at >=80% 1RM for ~3-6 reps, while hypertrophy happens anywhere from
// roughly 8 to 30 reps given the effort, and volume is a WEEKLY target rather than a per-exercise
// one — hence three sets everywhere and reps that vary only where being wrong costs something.
//
// They are a starting point. The user edits them, and Progress is built from what was actually
// lifted, never from these.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = process.env.TEST_PORT5 || 4959;
const B = `http://localhost:${PORT}`;
const DIR = mkdtempSync(join(tmpdir(), 'crewfit-targets-'));
let fails = 0, srv = null, srvDead = true;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const J = { 'Content-Type': 'application/json' };

function boot() {
  return new Promise(res => {
    srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: DIR, PORT: String(PORT) },
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

const lib = await fetch(B + '/api/exercises').then(r => r.json());
const BY = Object.fromEntries(lib.map(e => [e.name, e]));
const shape = n => { const e = BY[n]; if (!e) return '(absent)';
  if (e.timed) return `${e.defaultSets} × timed`;
  return `${e.defaultSets} × ${e.defaultReps}${e.defaultRepsMax && e.defaultRepsMax !== e.defaultReps ? '–' + e.defaultRepsMax : ''}`; };

console.log('the library no longer prescribes one shape for everything');
ok(lib.length > 190, `the library came back (${lib.length} exercises)`);
ok(new Set(lib.map(shape2 => shape(shape2.name))).size >= 5,
   `and they do not all share one target (${new Set(lib.map(e => shape(e.name))).size} distinct)`);

console.log('\nheavy barbell work is not prescribed at ten reps');
for (const n of ['Conventional Deadlift', 'Sumo Deadlift', 'Romanian Deadlift', 'Barbell Back Squat', 'Front Squat'])
  ok(BY[n] && BY[n].defaultReps <= 6 && !BY[n].defaultRepsMax,
     `${n}: ${shape(n)} — ACSM's strength band is 3-6 reps at >=80% 1RM`);
for (const n of ['Flat Barbell Bench Press', 'Overhead Barbell Press', 'Barbell Row'])
  ok(BY[n] && BY[n].defaultReps === 6 && BY[n].defaultRepsMax === 8, `${n}: ${shape(n)}`);

console.log('\nreps are not invented for exercises measured in time');
for (const n of ['Plank', 'Side Plank', 'Wall Sit', 'Dead Hang', "Farmer's Carry", 'Treadmill Run', 'Assault Bike', 'Sled Push'])
  ok(BY[n] && BY[n].timed === true && !BY[n].defaultReps,
     `${n}: ${shape(n)} — a rep count here is the wrong KIND of number, not a bad one`);

console.log('\n...but a counted movement filed under cardio still gets reps');
for (const n of ['Burpee', 'Kettlebell Swing'])
  ok(BY[n] && !BY[n].timed && BY[n].defaultReps > 0, `${n}: ${shape(n)}`);

console.log('\nsmall muscles get the higher reps they need');
for (const n of ['Lateral Raise', 'Face Pull', 'Standing Calf Raise', 'Cable Crunch'])
  ok(BY[n] && BY[n].defaultReps >= 12, `${n}: ${shape(n)}`);

console.log('\nthree sets everywhere — ACSM frames volume as a weekly target, not a per-exercise one');
ok(lib.every(e => e.defaultSets === 3), 'every exercise defaults to 3 sets');

console.log('\nthe target survives into a real workout');
{
  const u = await fetch(B + '/api/register', { method: 'POST', headers: J,
    body: JSON.stringify({ username: 'tgt' + Math.floor(Math.random()*1e6), pin: 'pass1234', displayName: 'T' }) }).then(r => r.json());
  const H = { ...J, Authorization: 'Bearer ' + u.token };
  const s = await fetch(B + '/api/sessions', { method: 'POST', headers: H,
    body: JSON.stringify({ name: 'Mixed', visibility: 'private', scheduledAt: '2026-08-20T18:00:00Z',
      exercises: [{ name: 'Conventional Deadlift' }, { name: 'Plank' }, { name: 'Lateral Raise' },
                  { name: 'Flat Barbell Bench Press', defaultSets: 5, defaultReps: 5 }] }) }).then(r => r.json());
  const ex = Object.fromEntries((s.exercises || []).map(e => [e.name, e]));
  ok(ex['Conventional Deadlift'] && ex['Conventional Deadlift'].defaultReps === 5,
     `a deadlift added with no target gets 3 × 5 (got ${ex['Conventional Deadlift'] && ex['Conventional Deadlift'].defaultReps})`);
  ok(ex['Plank'] && !ex['Plank'].defaultReps,
     `a plank gets NO rep target rather than a made-up one (got ${JSON.stringify(ex['Plank'] && ex['Plank'].defaultReps)})`);
  ok(ex['Lateral Raise'] && ex['Lateral Raise'].defaultReps === 12 && ex['Lateral Raise'].defaultRepsMax === 20,
     `a lateral raise gets 3 × 12–20 (got ${shapeOf(ex['Lateral Raise'])})`);
  ok(ex['Flat Barbell Bench Press'] && ex['Flat Barbell Bench Press'].defaultSets === 5 && ex['Flat Barbell Bench Press'].defaultReps === 5,
     'and anything the user set themselves is left exactly alone');
}
function shapeOf(e) { return e ? `${e.defaultSets} × ${e.defaultReps}${e.defaultRepsMax ? '–' + e.defaultRepsMax : ''}` : '-'; }

console.log('\na custom exercise the library has never heard of still gets something sane');
{
  const u = await fetch(B + '/api/register', { method: 'POST', headers: J,
    body: JSON.stringify({ username: 'cus' + Math.floor(Math.random()*1e6), pin: 'pass1234', displayName: 'C' }) }).then(r => r.json());
  const H = { ...J, Authorization: 'Bearer ' + u.token };
  const s = await fetch(B + '/api/sessions', { method: 'POST', headers: H,
    body: JSON.stringify({ name: 'Custom', visibility: 'private', scheduledAt: '2026-08-20T18:00:00Z',
      exercises: [{ name: 'Jefferson Curl Machine Thing' }] }) }).then(r => r.json());
  const e = (s.exercises || [])[0];
  ok(e && e.defaultSets === 3 && e.defaultReps > 0, `it falls back rather than breaking (${shapeOf(e)})`);
}

} finally { await stop(); rmSync(DIR, { recursive: true, force: true }); }

console.log(fails ? `\n${fails} FAILURE(S)\n` : '\nall assertions passed\n');
process.exit(fails ? 1 : 0);
