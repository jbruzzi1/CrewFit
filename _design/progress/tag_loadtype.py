"""
Add an explicit `loadType` to exercises where the number a user types is ambiguous.

Why: the app is about to assume "a pair of dumbbells, weight is per hand" silently
rather than prompting. That's right on the odds, but nobody corrects a silent default,
so the cases where it's WRONG have to be tagged up front or they corrupt estimated max,
PRs, and the "add weight next time" recommendation invisibly.

The existing `dumbbell` / `dumbbells` equipment tags CANNOT drive this — they are
inconsistent in the source data (Goblet Squat is tagged plural but uses one; Farmer's
Carry is tagged singular but uses two). Hence an explicit field.

Values:
  pair    -> two implements, number is PER HAND (70 x 10 = 70 in each hand, 140 total)
  single  -> one implement, number is the whole load
  added   -> bodyweight movement; number is weight ADDED, not total system weight

Untagged = unambiguous (barbell, cable, machine, plain bodyweight).
"""
import json, sys, shutil

PATH = 'exercise-library.json'

# One implement, held with one or both hands. A "pair" default would DOUBLE these.
SINGLE = {
    'Goblet Squat',                  # one bell at the chest
    'Concentration Curl',            # one arm at a time
    'Dumbbell Pullover',             # one bell, both hands
    'Single-Arm Dumbbell Press',
    'Single-Arm Dumbbell Row',
    'Single-Leg Calf Raise',         # one bell, free hand on support
    'Single-Leg Romanian Deadlift',
    'Turkish Get-Up',                # one bell overhead, by definition
    'Kettlebell Swing',              # one bell, both hands
    'Plate Pinch',
    'Svend Press',                   # one plate pressed between the palms
    'Plate Press',
    'Plate Raise',
    'Russian Twist',
}

# Bodyweight movements where the entered number is ADDED load, not bodyweight + load.
ADDED = {
    'Weighted Push-Up', 'Weighted Vest Push-Up',
    'Pull-Up', 'Chin-Up', 'Wide-Grip Pull-Up', 'Neutral-Grip Pull-Up',
    'Dip (Triceps)', 'Chest Dip', 'Bench Dip', 'Muscle-Up',
}


def load_type_for(e):
    name = e['name']
    eq = [x.lower() for x in (e.get('equipment') or [])]
    if name in SINGLE:
        return 'single'
    if name in ADDED:
        return 'added'
    # everything else held in both hands as a pair
    if any('dumbbell' in x for x in eq) or any('kettlebell' in x for x in eq):
        return 'pair'
    return None


def main():
    with open(PATH) as f:
        raw = f.read()
    doc = json.loads(raw)
    ex = doc['exercises']
    before = len(ex)

    counts, tagged = {}, []
    for e in ex:
        lt = load_type_for(e)
        if lt:
            e['loadType'] = lt
            counts[lt] = counts.get(lt, 0) + 1
            tagged.append((e['name'], lt))

    assert len(ex) == before, 'exercise count changed!'
    assert all('name' in e for e in ex), 'an exercise lost its name!'

    doc['_note'] += (
        ' loadType marks exercises where the entered weight is ambiguous: '
        'pair = two implements, number is per hand; single = one implement, number is '
        'the whole load; added = bodyweight movement, number is added weight only. '
        'Absent = unambiguous. Do NOT infer this from the equipment tags — they are '
        'inconsistent (Goblet Squat is tagged "dumbbells" but uses one).'
    )

    shutil.copy(PATH, PATH + '.bak')
    with open(PATH, 'w') as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)
        f.write('\n')

    print(f'exercises: {before} -> {len(ex)} (unchanged)')
    print('tagged:', counts)
    for lt in ('single', 'added'):
        print(f'\n  {lt}:')
        for n, t in tagged:
            if t == lt:
                print('   ', n)


if __name__ == '__main__':
    main()
