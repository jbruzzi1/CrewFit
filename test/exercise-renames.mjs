// Sep 2026 exercise-library audit: entries were renamed ("Flat Dumbbell Press" -> "Flat Dumbbell
// Bench Press") and duplicates merged ("Fan Bike" -> "Assault Bike"). Every stored reference in
// this app is the exercise NAME string, so a rename without a data migration splits a user's
// history in two and loses the PR in between. This boots a real server on a database that still
// holds the OLD names everywhere a name can live, and proves:
//   - every one of those references comes out under the current name (users, sessions, templates)
//   - PRs regroup under the new name in the same boot (the migration runs before rebuildAllPrs)
//   - two old names collapsing into one do not leave a duplicate in a favorites/trend-picks list
//   - the migration is a no-op on a second boot (idempotent, never rewrites healthy data)
//   - a stale client posting an old name after deploy is filed under the current one
//   - EXERCISE_RENAMES in server.js and exercise-library.json agree: every target exists in the
//     library and no source still does (the two files are edited by hand, separately)
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';
import { PgConnection, parseConnString } from '../pgmini.js';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const CWD = new URL('..', import.meta.url).pathname;
const J = { 'Content-Type': 'application/json' };
const PORT = 4791, B = `http://localhost:${PORT}`;

console.log('EXERCISE_RENAMES (server.js) and exercise-library.json agree');
const lib = JSON.parse(readFileSync(new URL('../exercise-library.json', import.meta.url), 'utf8')).exercises;
const libNames = new Set(lib.map(e => e.name));
const src = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const block = src.slice(src.indexOf('const EXERCISE_RENAMES = {'), src.indexOf('};', src.indexOf('const EXERCISE_RENAMES = {')));
const RENAMES = {};
for (const m of block.matchAll(/^\s*"([^"]+)":\s*"([^"]+)",?\s*$/gm)) RENAMES[m[1]] = m[2];
const entryLines = block.split('\n').filter(l => /^\s*"/.test(l)).length;
ok(Object.keys(RENAMES).length >= 50 && Object.keys(RENAMES).length === entryLines,
  `parsed the rename map out of server.js -- every "old": "new" line, none silently skipped (${Object.keys(RENAMES).length} of ${entryLines})`);
{
  const missingTargets = Object.values(RENAMES).filter(v => !libNames.has(v));
  const liveSources = Object.keys(RENAMES).filter(k => libNames.has(k));
  ok(missingTargets.length === 0, `every rename target is a current library entry (missing: ${JSON.stringify(missingTargets)})`);
  ok(liveSources.length === 0, `no rename source is still in the library (still present: ${JSON.stringify(liveSources)})`);
  const chained = Object.values(RENAMES).filter(v => RENAMES[v]);
  ok(chained.length === 0, `no target is itself a source -- the migration is one hop (chained: ${JSON.stringify(chained)})`);
}
for (const [a, b] of [['Flat Dumbbell Press', 'Flat Dumbbell Bench Press'], ['Fan Bike', 'Assault Bike'],
  ['Bulgarian Split Squat (Dumbbell)', 'Bulgarian Split Squat'], ['Machine Fly', 'Pec Deck']])
  ok(RENAMES[a] === b, `${a} -> ${b}`);
{
  const bss = lib.find(e => e.name === 'Bulgarian Split Squat');
  ok(bss && bss.loadType === 'single' && bss.equipment.includes('dumbbell') && !bss.equipment.includes('dumbbells'),
    `Bulgarian Split Squat is one dumbbell, total weight (Jeff: "should be just one dumbbell") (got ${JSON.stringify(bss && { loadType: bss.loadType, equipment: bss.equipment })})`);
  const bad = lib.filter(e => (e.loadType === 'pair' && e.equipment.includes('dumbbell')) || (e.loadType === 'single' && e.equipment.includes('dumbbells')));
  ok(bad.length === 0, `dumbbell tags follow the load: 'dumbbells' for a pair, 'dumbbell' for one (off: ${JSON.stringify(bad.map(e => e.name))})`);
  const cableSingle = lib.filter(e => e.loadType === 'single' && !e.equipment.some(x => /dumbbell|kettlebell|plate|medicine ball/.test(x)));
  ok(cableSingle.length === 0, `'single' (= "one dumbbell, total weight" in the log sheet) is never on a cable/landmine entry (${JSON.stringify(cableSingle.map(e => e.name))})`);
  const parens = lib.filter(e => /\(/.test(e.name));
  ok(parens.length === 0, `no parenthetical qualifiers left in names (${JSON.stringify(parens.map(e => e.name))})`);
}

// ---- a database that still holds the old names everywhere a name can live ----
const DIR = mkdtempSync(join(tmpdir(), 'exren-'));
const testDb = await freshTestDb('exren');
const users = {
  u1: { id: 'u1', username: 'alice', displayName: 'Alice', units: 'lb', createdAt: '2026-01-01T00:00:00.000Z', pinHash: 'x', pinSalt: 'y',
    favoriteExercises: ['Flat Dumbbell Press', 'Fan Bike', 'Assault Bike', 'Barbell Row'],
    trendPicks: ['Lateral Raise', 'Shrugs'],
    seeded: { 'Shrugs': { weight: 135, reps: 10, unit: 'lb' }, 'Hip Thrust': { weight: 185, reps: 8, unit: 'lb' }, 'Barbell Hip Thrust': { weight: 225, reps: 8, unit: 'lb' } } },
};
const sessions = {
  s1: { id: 's1', creatorId: 'u1', scheduledAt: '2026-08-01T18:00:00.000Z', status: 'done', visibility: 'private', name: 'Push',
    participants: ['u1'], invited: [], comments: [], attendance: {}, joinRequests: [],
    exercises: [{ id: 'e1', name: 'Flat Dumbbell Press', defaultSets: 3, defaultReps: 8 }, { id: 'e2', name: 'Skull Crusher', defaultSets: 3, defaultReps: 10 }],
    logs: { u1: [
      { id: 'l1', exerciseId: 'e1', exerciseName: 'Flat Dumbbell Press', set: 1, weight: 60, reps: 8, unit: 'lb', at: '2026-08-01T18:10:00.000Z', loadType: 'pair' },
      { id: 'l2', exerciseId: 'e1', exerciseName: 'Flat Dumbbell Press', set: 2, weight: 70, reps: 6, unit: 'lb', at: '2026-08-01T18:15:00.000Z', loadType: 'pair' },
      { id: 'l3', exerciseId: 'e2', exerciseName: 'Lying Triceps Extension (EZ)', set: 1, weight: 50, reps: 12, unit: 'lb', at: '2026-08-01T18:20:00.000Z' },
    ] },
    variations: { e2: { u1: { swapTo: 'Lying Triceps Extension (EZ)', reason: 'swap' } } },
    suggestedEdits: [{ id: 'se1', type: 'add', exerciseId: null, proposedBy: 'u1', swapTo: 'Crunches', status: 'pending' }],
    history: [{ userId: 'u1', date: '2026-08-01', muscleGroups: ['chest'], exercises: ['Flat Dumbbell Press', 'Lying Triceps Extension (EZ)'] }] },
  s2: { id: 's2', creatorId: 'u1', scheduledAt: '2026-08-08T18:00:00.000Z', status: 'done', visibility: 'private', name: 'Push 2',
    participants: ['u1'], invited: [], comments: [], attendance: {}, joinRequests: [],
    exercises: [{ id: 'e1', name: 'Flat Dumbbell Bench Press', defaultSets: 3, defaultReps: 8 }],
    logs: { u1: [{ id: 'l4', exerciseId: 'e1', exerciseName: 'Flat Dumbbell Bench Press', set: 1, weight: 65, reps: 8, unit: 'lb', at: '2026-08-08T18:10:00.000Z', loadType: 'pair' }] },
    variations: {}, suggestedEdits: [], history: [] },
};
const templates = { t1: { id: 't1', ownerId: 'u1', name: 'Legs', exercises: [{ name: 'Hip Thrust', defaultSets: 3, defaultReps: 10 }, { name: 'Romanian Deadlift', defaultSets: 3, defaultReps: 8 }] } };

{
  const dbmod = (await import('../db.js')).default;
  process.env.DATABASE_URL = testDb.url;
  await dbmod.ensureSchema();
  dbmod.close();
  const pg = new PgConnection(parseConnString(testDb.url));
  for (const u of Object.values(users))
    await pg.query('INSERT INTO users (id, username_lower, data) VALUES ($1, $2, $3::jsonb)', [u.id, u.username, JSON.stringify(u)]);
  for (const [id, s] of Object.entries(sessions))
    await pg.query('INSERT INTO sessions (id, data) VALUES ($1, $2::jsonb)', [id, JSON.stringify(s)]);
  for (const [id, t] of Object.entries(templates))
    await pg.query('INSERT INTO templates (id, data) VALUES ($1, $2::jsonb)', [id, JSON.stringify(t)]);
  pg.close();
}

function boot() {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: DIR, DATABASE_URL: testDb.url, PORT: String(PORT) },
      cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', booted = false;
    srv.stdout.on('data', d => { out += d; if (String(d).includes('CrewFit on')) { booted = true; res({ srv, out, err }); } });
    srv.stderr.on('data', d => { err += d; });
    srv.on('exit', () => { if (!booted) res({ srv: null, out, err }); });
    setTimeout(() => { if (!booted) res({ srv, out, err }); }, 10000);
  });
}
async function readAll() {
  const pg = new PgConnection(parseConnString(testDb.url));
  const out = {};
  for (const t of ['users', 'sessions', 'templates']) {
    const r = await pg.query(`SELECT id, data FROM ${t}`);
    out[t] = Object.fromEntries(r.rows.map(row => [row.id, JSON.parse(row.data)]));
  }
  const p = await pg.query('SELECT user_id, data FROM prs');
  out.prs = Object.fromEntries(p.rows.map(row => [row.user_id, JSON.parse(row.data)]));
  pg.close();
  return out;
}

console.log('\nfirst boot on a database full of old names');
let h = await boot();
ok(!!h.srv && /CrewFit on/.test(h.out), `server booted (stderr: ${h.err.trim().slice(0, 300) || 'none'})`);
ok(/migrateExerciseRenames: moved \d+ stored reference/.test(h.out), 'the migration reported what it moved');
{
  const d = await readAll();
  const u = d.users.u1;
  ok(JSON.stringify(u.favoriteExercises) === JSON.stringify(['Flat Dumbbell Bench Press', 'Assault Bike', 'Barbell Row']),
    `favorites renamed, and Fan Bike + Assault Bike collapsed to ONE entry (got ${JSON.stringify(u.favoriteExercises)})`);
  ok(JSON.stringify(u.trendPicks) === JSON.stringify(['Dumbbell Lateral Raise', 'Barbell Shrug']), `trend picks renamed (got ${JSON.stringify(u.trendPicks)})`);
  ok(u.seeded['Barbell Shrug'] && u.seeded['Barbell Shrug'].weight === 135 && !u.seeded['Shrugs'], `seeded lift moved to its new name (got ${JSON.stringify(Object.keys(u.seeded))})`);
  ok(u.seeded['Barbell Hip Thrust'] && u.seeded['Barbell Hip Thrust'].weight === 225 && !u.seeded['Hip Thrust'],
    `a seed already under the new name wins over the old-name one (got ${JSON.stringify(u.seeded['Barbell Hip Thrust'])})`);
  const s1 = d.sessions.s1;
  ok(s1.exercises[0].name === 'Flat Dumbbell Bench Press' && s1.exercises[1].name === 'EZ-Bar Skull Crusher',
    `session exercise list renamed (got ${JSON.stringify(s1.exercises.map(e => e.name))})`);
  ok(s1.logs.u1.every(l => l.exerciseName === 'Flat Dumbbell Bench Press' || l.exerciseName === 'EZ-Bar Skull Crusher'),
    `every logged set's frozen exerciseName renamed (got ${JSON.stringify(s1.logs.u1.map(l => l.exerciseName))})`);
  ok(s1.logs.u1[0].loadType === 'pair' && s1.logs.u1[0].weight === 60, 'a set keeps the loadType and weight it was logged with -- only the name moves');
  ok(s1.variations.e2.u1.swapTo === 'EZ-Bar Skull Crusher', `swap variation renamed (got ${s1.variations.e2.u1.swapTo})`);
  ok(s1.suggestedEdits[0].swapTo === 'Crunch', `pending suggestion renamed (got ${s1.suggestedEdits[0].swapTo})`);
  ok(JSON.stringify(s1.history[0].exercises) === JSON.stringify(['Flat Dumbbell Bench Press', 'EZ-Bar Skull Crusher']),
    `finish history renamed (got ${JSON.stringify(s1.history[0].exercises)})`);
  const t1 = d.templates.t1;
  ok(JSON.stringify(t1.exercises.map(e => e.name)) === JSON.stringify(['Barbell Hip Thrust', 'Barbell Romanian Deadlift']),
    `routine exercises renamed (got ${JSON.stringify(t1.exercises.map(e => e.name))})`);
  const prs = d.prs.u1 || {};
  ok(!prs['Flat Dumbbell Press'] && prs['Flat Dumbbell Bench Press'] && prs['Flat Dumbbell Bench Press'].weight === 70,
    `PRs regrouped under the new name in the same boot: the 70x6 logged as "Flat Dumbbell Press" is the record, not the later 65x8 (got ${JSON.stringify(prs['Flat Dumbbell Bench Press'])})`);
  ok(prs['EZ-Bar Skull Crusher'] && prs['EZ-Bar Skull Crusher'].weight === 50, `a merged duplicate's sets count toward the survivor's PR (got ${JSON.stringify(prs['EZ-Bar Skull Crusher'])})`);
}

console.log('\na stale client posting an old name after deploy');
{
  const reg = await fetch(B + '/api/register', { method: 'POST', headers: J,
    body: JSON.stringify({ username: 'stale' + Math.floor(Math.random() * 1e6), pin: 'pass1234', displayName: 'Stale' }) }).then(r => r.json());
  const H = { ...J, Authorization: 'Bearer ' + reg.token };
  const s = await fetch(B + '/api/sessions', { method: 'POST', headers: H,
    body: JSON.stringify({ name: 'Old names', visibility: 'private', scheduledAt: '2026-09-10T18:00:00Z',
      exercises: [{ name: 'Flat Dumbbell Press' }, { name: 'Barbell Row' }] }) }).then(r => r.json());
  ok(s.exercises && s.exercises[0].name === 'Flat Dumbbell Bench Press' && s.exercises[1].name === 'Barbell Row',
    `POST /api/sessions files an old name under the current one (got ${JSON.stringify((s.exercises || []).map(e => e.name))})`);
  await fetch(B + '/api/favorites/toggle', { method: 'POST', headers: H, body: JSON.stringify({ name: 'Fan Bike' }) });
  const fav = await fetch(B + '/api/favorites', { headers: H }).then(r => r.json());
  ok(JSON.stringify(fav.exercises) === JSON.stringify(['Assault Bike']), `favoriting an old name stores the current one (got ${JSON.stringify(fav.exercises)})`);
  const picks = await fetch(B + '/api/me/trend-picks', { method: 'POST', headers: H, body: JSON.stringify({ picks: ['Shrugs', 'Barbell Shrug', 'Hip Thrust'] }) }).then(r => r.json());
  ok(JSON.stringify(picks.picks) === JSON.stringify(['Barbell Shrug', 'Barbell Hip Thrust']),
    `trend picks sent under old names are stored current and deduped (got ${JSON.stringify(picks.picks)})`);
  const seedR = await fetch(B + '/api/me/seeds', { method: 'PUT', headers: H, body: JSON.stringify({ exercise: 'Overhead Barbell Press', weight: 95, reps: 5 }) }).then(r => r.json());
  ok(seedR.seeds && seedR.seeds['Barbell Overhead Press'] && !seedR.seeds['Overhead Barbell Press'],
    `a starting-weight seed sent under an old name is accepted and stored under the current one (got ${JSON.stringify(Object.keys(seedR.seeds || {}))})`);
  const sug = await fetch(B + '/api/sessions/' + s.id + '/suggest', { method: 'POST', headers: H,
    body: JSON.stringify({ exerciseId: s.exercises[1].id, swapTo: 'Hammer Curl' }) }).then(r => r.json());
  const edit = (sug.suggestedEdits || []).find(e => e.type === 'swap');
  ok(edit && edit.swapTo === 'Dumbbell Hammer Curl', `a swap suggestion under an old name is stored under the current one (got ${edit && edit.swapTo})`);
  const lib2 = await fetch(B + '/api/exercises').then(r => r.json());
  ok(!lib2.some(e => e.name === 'Flat Dumbbell Press') && lib2.some(e => e.name === 'Flat Dumbbell Bench Press'), 'the library the client sees carries only current names');
}
try { h.srv.kill(); } catch {}
await new Promise(r => setTimeout(r, 400));

console.log('\nsecond boot: nothing left to migrate');
h = await boot();
ok(!!h.srv, 'server booted again');
ok(!/migrateExerciseRenames:/.test(h.out), 'the migration is silent on already-current data (idempotent)');
try { h.srv.kill(); } catch {}
try { rmSync(DIR, { recursive: true, force: true }); } catch {}
await testDb.drop();

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
