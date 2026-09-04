// Guards the shape of exercise-library.json itself. Nothing here exercises server routes -- it's
// a pure data-integrity check on the file every session/progression/target computation ultimately
// reads from (EX_LIB in server.js). Added Sep 2026 alongside a 63-exercise expansion (Jeff: "we
// don't have enough and are missing a good amount of exercises") so a future edit to this file
// can't silently reintroduce a duplicate name, an unknown muscle group (which would render with no
// icon -- see MG_IMG in app.js, a CLOSED vocabulary of 13 keys with one .png each in
// public/muscle-icons/), or a malformed entry.
import { readFileSync, readdirSync } from 'node:fs';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };

const lib = JSON.parse(readFileSync(new URL('../exercise-library.json', import.meta.url), 'utf8'));
const ex = lib.exercises;

console.log(`exercise-library.json: ${ex.length} exercises`);
ok(Array.isArray(ex) && ex.length > 200, `at least 200 exercises present (got ${ex.length})`);

console.log('\nno duplicate names -- names are the only identifier a logged set is stored against');
{
  const names = ex.map(e => e.name);
  const seen = new Set(), dupes = new Set();
  for (const n of names) { if (seen.has(n)) dupes.add(n); seen.add(n); }
  ok(dupes.size === 0, `zero duplicate names (found: ${JSON.stringify([...dupes])})`);
}

console.log('\nevery entry has the required shape');
{
  const VALID_PATTERN = new Set(['push', 'pull', 'legs', 'core', 'cardio']);
  const VALID_LEVEL = new Set(['beginner', 'intermediate', 'advanced']);
  const VALID_LOADTYPE = new Set(['pair', 'single', 'added']);
  let badShape = 0, badPattern = 0, badLevel = 0, badLoadType = 0, badMuscleGroups = 0, badEquipment = 0;
  for (const e of ex) {
    if (typeof e.name !== 'string' || !e.name) badShape++;
    if (!VALID_PATTERN.has(e.pattern)) badPattern++;
    if (typeof e.category !== 'string' || !e.category) badShape++;
    if (!Array.isArray(e.muscle_groups) || !e.muscle_groups.length) badMuscleGroups++;
    if (!Array.isArray(e.equipment) || !e.equipment.length) badEquipment++;
    if (typeof e.is_compound !== 'boolean') badShape++;
    if (!VALID_LEVEL.has(e.level)) badLevel++;
    if (e.loadType !== undefined && !VALID_LOADTYPE.has(e.loadType)) badLoadType++;
  }
  ok(badShape === 0, `every entry has a non-empty name/category, is_compound boolean (${badShape} malformed)`);
  ok(badPattern === 0, `every entry's pattern is one of push/pull/legs/core/cardio (${badPattern} invalid)`);
  ok(badLevel === 0, `every entry's level is beginner/intermediate/advanced (${badLevel} invalid)`);
  ok(badLoadType === 0, `every present loadType is pair/single/added (${badLoadType} invalid)`);
  ok(badMuscleGroups === 0, `every entry has a non-empty muscle_groups array (${badMuscleGroups} missing)`);
  ok(badEquipment === 0, `every entry has a non-empty equipment array (${badEquipment} missing)`);
}

console.log('\nevery muscle_groups entry is a known key -- app.js\'s MG_IMG icon map is a CLOSED');
console.log('vocabulary (public/muscle-icons/*.png); an unknown group renders with no matching icon');
{
  // Keep this list in sync with MG_IMG in public/app.js and the .png files in public/muscle-icons/.
  const KNOWN_ICON_KEYS = new Set(['chest', 'lats', 'traps', 'biceps', 'triceps', 'core', 'quads',
    'hamstrings', 'calves', 'shoulders', 'forearms', 'glutes', 'cardio', 'abdominals']);
  const iconFiles = new Set(readdirSync(new URL('../public/muscle-icons/', import.meta.url))
    .filter(f => f.endsWith('.png')).map(f => f.replace(/\.png$/, '')));
  const unknown = new Set();
  for (const e of ex) for (const m of (e.muscle_groups || []).concat(e.secondary || [])) if (!KNOWN_ICON_KEYS.has(m)) unknown.add(m);
  ok(unknown.size === 0, `every muscle_groups / secondary value has a matching icon key (unmapped: ${JSON.stringify([...unknown])})`);
  // v311: muscle_groups = primary movers (the tiles), secondary = helpers. A group in both would be
  // filed under a tile AND counted twice in volume; an empty/non-array secondary is a typo.
  const badSec = ex.filter(e => e.secondary !== undefined && (!Array.isArray(e.secondary) || !e.secondary.length
    || e.secondary.some(m => typeof m !== 'string' || (e.muscle_groups || []).includes(m))));
  ok(badSec.length === 0, `secondary (when present) is a non-empty string array disjoint from muscle_groups (bad: ${JSON.stringify(badSec.map(e => e.name))})`);
  const presses = ex.filter(e => /Bench Press|Overhead Press|Shoulder Press/.test(e.name) && !/Close-Grip/.test(e.name));
  ok(presses.length > 8 && presses.every(e => !(e.muscle_groups || []).includes('triceps')),
    `no chest/shoulder press is filed under Triceps (Jeff, Sep 4) -- triceps is a helper there (${presses.filter(e => (e.muscle_groups||[]).includes('triceps')).map(e => e.name)})`);
  const sled = ex.find(e => e.name === 'Sled Push');
  ok(sled && ['cardio', 'quads', 'glutes'].every(m => sled.muscle_groups.includes(m)), `a lift that is genuinely several things (Sled Push) stays primary in each (got ${JSON.stringify(sled && sled.muscle_groups)})`);
  // sanity on the map itself: every key it points at (except the 'core' fallback for 'abdominals')
  // must actually have a .png on disk, or a group renders a broken image instead of the neutral icon.
  const missingFiles = [...KNOWN_ICON_KEYS].filter(k => k !== 'abdominals' && !iconFiles.has(k));
  ok(missingFiles.length === 0, `every icon key has a public/muscle-icons/*.png (missing: ${JSON.stringify(missingFiles)})`);
}

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
