// Jeff, Sep 1: "what is this app missing" -> "lets build the worth doing next" (approved via
// AskUserQuestion, built first of the four). The server side of this -- GET/PUT/DELETE
// /api/me/seeds, storing a user's self-reported starting weights SEPARATE from earned PRs so a
// typo or an unbeaten self-report can never poison the real record list -- has existed since
// before this feature with zero client UI. This ships the client half: a "Starting weights" screen
// (seedSetupScreen in app.js), reached once automatically right after registering (doReg, NEW
// accounts only) and permanently from Settings ("Starting weights" row), with a curated 6-lift
// default set and a "+ Add another lift" picker (SEED_MODE, restricted to base-library exercises
// only -- PUT /api/me/seeds 400s on anything else).
//
// Server-side integration tests here exercise the EXACT request shapes the new client code sends
// (string weight/reps/goal from form inputs, PUT-with-blanks-deletes) -- the endpoints themselves
// are pre-existing and unmodified, but nothing previously proved a real client would actually talk
// to them correctly. Client-side checks are source regex against the real app.js/index.html, same
// style test/favorite-exercises.mjs and test/sharing.mjs already use.
//
// Run:  npm test
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';

const PORT = process.env.TEST_PORT_SEED || 4961;
const B = `http://localhost:${PORT}`;
const DIR = mkdtempSync(join(tmpdir(), 'crewfit-test-seed-'));
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('seed_your_lifts');
let fails = 0, srv = null;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };

function boot() {
  return new Promise((res, rej) => {
    srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: DIR, DATABASE_URL: testDb.url, PORT: String(PORT) },
      cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
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
  return { H: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + r.token }, username: u, id: r.user.id };
}
const getSeeds = ({ H }) => fetch(B + '/api/me/seeds', { headers: H }).then(x => x.json());
// Deliberately sending STRINGS for weight/reps/goal, same as the real client (form input .value is
// always a string) -- not numbers, which is what a hand-rolled test might reach for instead.
const putSeed = ({ H }, body) => fetch(B + '/api/me/seeds', { method: 'PUT', headers: H, body: JSON.stringify(body) }).then(x => x.json());
const deleteSeed = ({ H }, exercise) => fetch(B + '/api/me/seeds/' + encodeURIComponent(exercise), { method: 'DELETE', headers: H }).then(x => x.json());

await boot();
try {

console.log('a fresh user has no seeds -- seedSetupScreen renders all 6 defaults blank, nothing pre-filled wrong');
{
  const u = await newUser();
  const r = await getSeeds(u);
  ok(r.seeds && Object.keys(r.seeds).length === 0, `starts empty (got ${JSON.stringify(r)})`);
}

console.log('\nPUT with string weight/reps/goal (the exact shape seedSaveAll sends) is stored and read back correctly');
{
  const u = await newUser();
  const r = await putSeed(u, { exercise: 'Barbell Back Squat', weight: '225', reps: '5', goal: '245' });
  ok(!r.error, `no error (got ${JSON.stringify(r)})`);
  const got = r.seeds['Barbell Back Squat'];
  ok(got && got.weight === 225 && got.reps === 5 && got.goal === 245, `coerced to numbers correctly (got ${JSON.stringify(got)})`);
}

console.log('\na blank row (weight and goal both empty strings, from an untouched default) is a silent no-op, not an error or a phantom 0 seed');
{
  const u = await newUser();
  const r = await putSeed(u, { exercise: 'Pull-Up', weight: '', reps: '', goal: '' });
  ok(!r.error, `no error (got ${JSON.stringify(r)})`);
  ok(!('Pull-Up' in r.seeds), `nothing stored for the untouched default (got ${JSON.stringify(r.seeds)})`);
}

console.log('\nPUT rejects an exercise outside the base library -- the constraint seedAddAnother\'s picker exists to enforce client-side too');
{
  const u = await newUser();
  const r = await putSeed(u, { exercise: 'Definitely Not A Real Exercise', weight: '100', reps: '5' });
  ok(r.error === 'Pick an exercise from the library', `400 with the expected message (got ${JSON.stringify(r)})`);
}

console.log('\nseedRemoveRow\'s unconditional DELETE is a harmless no-op on a never-seeded exercise');
{
  const u = await newUser();
  const r = await deleteSeed(u, 'Conventional Deadlift'); // never PUT for this user
  ok(!r.error, `no error deleting something that was never there (got ${JSON.stringify(r)})`);
  const after = await getSeeds(u);
  ok(!('Conventional Deadlift' in after.seeds), 'still absent, not accidentally created');
}

console.log('\nseedRemoveRow\'s DELETE actually clears a real seed');
{
  const u = await newUser();
  await putSeed(u, { exercise: 'Flat Barbell Bench Press', weight: '135', reps: '8' });
  let r = await getSeeds(u);
  ok('Flat Barbell Bench Press' in r.seeds, 'seed is there after PUT');
  await deleteSeed(u, 'Flat Barbell Bench Press');
  r = await getSeeds(u);
  ok(!('Flat Barbell Bench Press' in r.seeds), 'gone after DELETE');
}

console.log('\nre-opening the screen later (Settings -> "Starting weights") sees a lift added on a prior visit outside the curated 6, appended per seedSetupScreen\'s rowFor/Object.keys merge');
{
  const u = await newUser();
  await putSeed(u, { exercise: 'Barbell Row', weight: '155', reps: '6' }); // in SEED_DEFAULTS
  await putSeed(u, { exercise: 'Incline Dumbbell Press', weight: '65', reps: '8' }); // not a default
  const r = await getSeeds(u);
  ok(Object.keys(r.seeds).length === 2, `both present (got ${JSON.stringify(Object.keys(r.seeds))})`);
}

console.log('\nseeds are per-user, not shared or global (same isolation shape as favorites)');
{
  const a = await newUser(), b = await newUser();
  await putSeed(a, { exercise: 'Overhead Barbell Press', weight: '95', reps: '5' });
  const ra = await getSeeds(a), rb = await getSeeds(b);
  ok('Overhead Barbell Press' in ra.seeds, "shows up in A's own list");
  ok(!('Overhead Barbell Press' in rb.seeds), "does not leak into B's list");
}

console.log('\n/api/me/seeds requires login, same as every other per-user route');
{
  const r = await fetch(B + '/api/me/seeds');
  ok(r.status === 401, `no token -> 401 (got ${r.status})`);
}

} finally {
  await stop();
  rmSync(DIR, { recursive: true, force: true });
  await testDb.drop();
}

console.log('\n--- client markup (source regex, same style as test/favorite-exercises.mjs) ---\n');
{
  const src = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const flat = src.replace(/\s+/g, ' ');
  const css = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const lib = JSON.parse(readFileSync(new URL('../exercise-library.json', import.meta.url), 'utf8'));
  const libNames = new Set((Array.isArray(lib) ? lib : (lib.exercises || lib)).map(e => e.name));

  // The curated default set -- every name must exist verbatim in the real library, or seedSetupScreen
  // would ship with a default row that PUT /api/me/seeds silently 400s on the moment someone tries
  // to save it unmodified.
  const defMatch = src.match(/const SEED_DEFAULTS = \[([^\]]*)\]/);
  ok(!!defMatch, 'SEED_DEFAULTS is defined');
  const defaults = defMatch ? [...defMatch[1].matchAll(/'([^']+)'/g)].map(m => m[1]) : [];
  ok(defaults.length === 6, `six curated default lifts (got ${defaults.length}: ${JSON.stringify(defaults)})`);
  const missing = defaults.filter(n => !libNames.has(n));
  ok(missing.length === 0, `every default name exists verbatim in exercise-library.json (missing: ${JSON.stringify(missing)})`);

  // Picker mode plumbing -- same mutual-exclusion pattern SWAP_MODE/SUGGEST_ADD_MODE already use.
  ok(/let SEED_MODE = false;/.test(src), 'SEED_MODE state exists');
  const resetFn = (src.match(/function resetTransientModes\(\)\{[\s\S]*?\n\}/) || [''])[0];
  ok(/SEED_MODE = false;/.test(resetFn), 'resetTransientModes (the bottom-nav escape hatch) clears SEED_MODE too');

  const openFn = (src.match(/function openSeedPicker\(\)\{[\s\S]*?\n\}/) || [''])[0];
  ok(/SEED_MODE = true;/.test(openFn), 'openSeedPicker enters seed mode');
  ok(/SWAP_MODE = false/.test(openFn) && /SUGGEST_ADD_MODE = false/.test(openFn) && /LIB_ADDMODE = false/.test(openFn),
     'openSeedPicker clears every other picker mode -- never more than one at once');

  ok(/function seedPickerCancel\(\)\{ SEED_MODE = false; backToSessionAfterSwapPicker\(\); \}/.test(flat),
     'seedPickerCancel clears the mode and returns via the shared history-delta helper');
  ok(/function seedPickerPick\(name\)\{/.test(src), 'seedPickerPick exists');
  const pickFn = (src.match(/function seedPickerPick\(name\)\{[\s\S]*?\n\}/) || [''])[0];
  ok(/SEED_DRAFT\.push/.test(pickFn), 'picking a lift pushes it onto SEED_DRAFT');
  ok(/SEED_DRAFT\.some\(r=>r\.exercise===name\)/.test(pickFn), 'and skips it if already present -- no duplicate rows from picking twice');

  // library()'s header branches correctly, exactly like the Swap/Suggest-add headers beside it.
  ok(/: SEED_MODE\s*\?\s*`<div class="pick-head lib-head">\s*<button class="sec sm" onclick="seedPickerCancel\(\)">‹ Cancel<\/button>\s*<h1 style="flex:1;font-size:18px">Add a lift<\/h1>/.test(src),
     'library() header reads "Add a lift" and wires Cancel to seedPickerCancel in seed mode');

  // exRowHtml wires a row's tap to seedPickerPick, not some other picker's handler.
  const exRowFn = (src.match(/function exRowHtml\(e\)\{[\s\S]*?\n\}/) || [''])[0];
  ok(/if\(SEED_MODE\)\{[\s\S]*?onclick="seedPickerPick\('\$\{jsq\(e\.name\)\}'\)"/.test(exRowFn),
     'exRowHtml wires a row\'s tap to seedPickerPick in seed mode');

  // Custom exercises are excluded from the picker's own lists (PUT rejects them server-side --
  // verified above -- so the UI must never offer one to begin with).
  const groupsFn = (src.match(/function renderLibGroups\(\)\{[\s\S]*?\n\}/) || [''])[0];
  ok(/\(!SEED_MODE \|\| !e\.custom\)/.test(groupsFn), 'renderLibGroups filters out custom exercises in seed mode (search results)');
  ok(/if\(SEED_MODE && e\.custom\) return;/.test(groupsFn), '...and from the per-muscle group counts too');
  const exercisesFn = (src.match(/function renderLibExercises\(\)\{[\s\S]*?\n\}/) || [''])[0];
  ok(/\(!SEED_MODE \|\| !e\.custom\)/.test(exercisesFn), 'renderLibExercises filters out custom exercises in seed mode (per-muscle browsing)');

  // Entry points: doReg (new registrations only) and the Settings row (everyone, any time).
  const doRegFn = (src.match(/async function doReg\(\)\{[\s\S]*?\n\}/) || [''])[0];
  ok(/seedSetupScreen\(\{firstRun:true\}\)/.test(doRegFn), 'doReg() routes a successful new registration into the seed-setup screen');
  ok(!/doRegFn.*home\(\)/.test(doRegFn.replace(/\n/g, '')) , 'sanity: doReg no longer calls home() directly on success');
  ok(/<button class="sheet-row" onclick="closeSheet\(\); seedSetupScreen\(\{firstRun:false\}\)">Starting weights<\/button>/.test(src),
     'Settings has a permanent "Starting weights" row wired to seedSetupScreen({firstRun:false}) -- explicit,' +
     ' not relying on SEED_FIRST_RUN\'s default (see the cold-review fix below)');

  // Cold-review catch: SEED_FIRST_RUN is a module-level global (same shape as EDITING_ID/TPL_MODE
  // elsewhere in this file), only ever cleared by seedSkip/seedSaveAll -- walking away from a
  // first-run seed screen via the bottom nav (any tab, not Skip/Save) used to leave it stuck true,
  // so the NEXT time "Starting weights" opened from Settings it wrongly still acted like a
  // first-run prompt (wrong Skip button, wrong Save routing to Home instead of back). Fixed two
  // ways: resetTransientModes (the bottom-nav escape hatch, see its own comment) now clears it too,
  // and the Settings row above no longer relies on the default at all.
  ok(/SEED_FIRST_RUN = false;/.test(resetFn), 'resetTransientModes (the bottom-nav escape hatch) clears SEED_FIRST_RUN too');

  // Cold-review catch: the picker's per-muscle drill-down (libOpenMuscle) only branched on
  // LIB_ADDMODE, so in SEED_MODE it fell into the plain default header -- "Routines" (silently
  // abandons SEED_MODE/SEED_DRAFT, templatesPage() doesn't call resetTransientModes) and "Create
  // exercise" (makes something the custom-exercise filter immediately hides again) reachable inside
  // a screen whose whole point is "base-library exercises only."
  const muscleFn = (src.match(/function libOpenMuscle\(m, ?opts\)\{[\s\S]*?\n\}/) || [''])[0];
  ok(/: SEED_MODE\s*\?\s*`<div class="pick-head lib-head">\s*<button class="sec sm" onclick="library\(\)">‹ All muscles<\/button>\s*<h1[^`]*<\/h1>\s*<\/div>`/.test(muscleFn),
     'libOpenMuscle gives SEED_MODE its own header too -- no Routines/Create exercise button drilled into a muscle group');

  // Nav-state plumbing so Back / the picker's own return trip land back on this screen correctly.
  ok(/else if\(st\.t==='seeds'\) seedSetupScreen\(\{fromHistory:true, firstRun:!!st\.firstRun\}\);/.test(flat),
     'renderNavState knows how to re-render a {t:"seeds"} history entry, firstRun preserved');

  // seedSaveAll: double-tap guarded via the button's own disabled state (doReg's regBtn pattern),
  // saves every row, then routes home for first-run or stays for a Settings-triggered save.
  const saveFn = (src.match(/async function seedSaveAll\(\)\{[\s\S]*?\n\}/) || [''])[0];
  ok(/if\(btn && btn\.disabled\) return;/.test(saveFn), 'seedSaveAll guards against a double-tap via the Save button\'s own disabled state');
  ok(/H\.put\('\/api\/me\/seeds', \{ exercise:r\.exercise, weight:r\.weight, reps:r\.reps, goal:r\.goal \}\)/.test(saveFn),
     'seedSaveAll PUTs every row in SEED_DRAFT with the raw (string) form values');
  // First-run (no prior screen to return to) lands on Home; reached from Settings instead, Save
  // must return to wherever the user actually came from (history.back()), not force an existing
  // user over to the Home tab just for editing a preference -- a real bug caught in Playwright
  // verification (Settings -> Starting weights -> Save landed on Home instead of back on Profile).
  ok(/if\(wasFirstRun\) showTab\('home'\); else history\.back\(\);/.test(saveFn),
     'seedSaveAll returns to Home only for first-run; otherwise goes back to where it was opened from');

  // seedRemoveRow fires the DELETE unconditionally (idempotent no-op if never actually saved --
  // verified server-side above) rather than trying to track which rows were "really" seeded.
  const removeFn = (src.match(/function seedRemoveRow\(i\)\{[\s\S]*?\n\}/) || [''])[0];
  ok(/H\.delete\('\/api\/me\/seeds\/'\+encodeURIComponent\(removed\.exercise\)\)/.test(removeFn), 'seedRemoveRow deletes the row server-side too');

  // CSS actually exists for the new screen -- not an invisible/unstyled form.
  ok(/\.seed-row-fields\s*\{/.test(css), '.seed-row-fields is styled');
  ok(/\.seed-row-head\s*\{/.test(css), '.seed-row-head is styled');

  const vMatch = css.match(/\?v=(\d+)/);
  ok(!!vMatch && Number(vMatch[1]) >= 279, 'cache-bust bumped to v=279 or later (got ' + (vMatch && vMatch[1]) + ')');
}

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
