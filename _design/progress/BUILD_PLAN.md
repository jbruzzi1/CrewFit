# "Add weight next time" — build plan

The Progress page's flagship module. **Not buildable as originally specced**; this is what
it needs first. Everything here came out of a pre-implementation review of the mockups in
this folder against the real data model — see `README.md` for the design decisions.

Status as of Aug 17, 2026: **not started.** Items marked ✅ are already shipped.

---

## Already shipped (foundation)

These landed while reviewing this feature. All fix things that were already wrong in the
live app, independent of Progress.

- ✅ **v149** cross-session PR tracking (`rebuildAllPrs`), Recent Activity + Personal Records on Profile
- ✅ **loadType** on 65 exercises where the entered weight is ambiguous (pair / single / added)
- ✅ **v150** logger states what the weight means and stamps `loadType` onto each set
- ✅ **v151** PR = heaviest (was weight×reps volume, so 225×8 outranked 315×3); bodyweight
  lifts can now rank at all; `/lock` made idempotent; reps required on a set
- ✅ **v152** kilograms as a per-user unit; sets stamp the unit they were typed in

The pattern to follow for anything below that adds a field: **stamp the meaning onto the
set at log time, omit the field when it's the default, backfill once on boot, make the
migration idempotent.** See `migrateLoadTypes()` in `server.js`.

---

## 1. Stamp `targetReps` onto each logged set

**Problem.** The rep target lives on the session exercise (`defaultReps`) and
`PUT /api/sessions/:id` rewrites it in place, keeping the same exercise id. Edit a finished
3×8 session to 3×10 and yesterday's "hit all reps" retroactively becomes a miss — the
recommendation flips without the user touching a weight. Templates do the same.

**Fix.** On `POST /api/sessions/:id/log`, copy the exercise's current `defaultReps` onto the
log entry as `targetReps`. Backfill existing entries once on boot from current defaults —
imperfect for anything already edited, but it's the best available guess and it stops the
problem going forward.

**Risk.** Low. Additive field, no behaviour change until the engine reads it.

---

## 2. Count only working sets

**Problem.** `setType` is already stored (`normal` / `warmup` / `drop` / `failure`) but
nothing filters on it. Two warm-ups plus one working set on a 3×5 reads as "3 of 3 done",
and the warm-ups are the ones at the lighter weight. A drop set logged last will fire
"missed the last set" on a session the user completed.

**Fix.** Only `setType === 'normal'` counts toward hitting the target. No new field — this
is a rule the spec was missing.

**Note.** `setNum` is also computed as a running count of *all* logs for the exercise
(`server.js`, log endpoint), so set numbers are wrong in the same way. Worth fixing while
you're here.

---

## 3. Add `increment` to the exercise library

**Problem.** The rule says "+5 upper, +10 lower, +20 machines" but nothing in the library
identifies a machine. Substring-matching `"machine"` on `equipment` gives +20 to *Smith
Machine Bench Press* (a press) and misses *Leg Press* (`equipment: ['leg press']`) and
*Hack Squat*. There is also no step data, so the engine will name weights that don't
exist — +5 on a pair of dumbbells is +10 systemic and lands on 47.5 lb dumbbells.

**Fix.** An explicit `increment` field for exercises where the default is wrong, generated
by a reviewable script like `tag_loadtype.py` in this folder. Must be unit-aware —
`INCREMENTS` in `app.js` already has lb 5/10/20 and kg 2.5/5/10.

**Needs a human eye on the list**, same as the loadType tagging did.

---

## 4. Define a "session" by the session, not the log timestamp

**Problem.** `log.at` is set at log time — when the user *typed* it, not when they lifted.
Log Monday's workout on Tuesday morning and it sorts after Tuesday's. "Your last 2 sessions"
is then wrong, and PR dates show the typing day.

**Fix.** Group logs by their session and order sessions by `scheduledAt`. A session already
*is* a training occasion, so this sidesteps `log.at` entirely for the "last 2 sessions"
question.

**Related latent bug.** The legacy `at` backfill in `rebuildAllPrs` falls back to the
session **id** string; `new Date('s_ab12cd34')` is Invalid Date → NaN comparator → unstable
sort. Fix while in the area.

---

## 5. Resolve swapped exercises to what was actually done

**Problem.** When a user swaps an exercise, `s.variations[exerciseId][userId].swapTo` records
it, but logs still POST the original `exerciseId` and `exerciseNameFor()` returns the
**original** name. Swap Barbell Row → Seated Cable Row, log 90 lb, and it files as a Barbell
Row: the user gets advice for a lift they didn't do, and a 135→90 cliff in the Barbell Row
trend.

**Fix.** `exerciseNameFor()` should check `variations` first. `/api/sessions/:id/lock`
already does exactly this when building history — reuse that logic.

**This also fixes PRs**, which have the same bug today. History and PRs currently disagree
about what was trained.

---

## 6. Handle the same lift twice in one session

**Problem.** Nothing dedupes exercise names within a session; each instance gets its own id.
Group by id and you can't see across sessions (each session mints new ids). Group by name and
a heavy 3×5 merges with a back-off 3×10 — the back-off sets look like missed lighter sets and
**permanently hold the lift**.

**Fix.** Within a session, judge against the heaviest working-set group. Across sessions,
match by name (as `rebuildAllPrs` already does).

---

## 7. Give user-created exercises a valid pattern

**Problem.** `submitCreateEx()` never sends `pattern`, so the server falls back to
`muscle_groups[0]`, drawn from a muscle list (`chest`, `lats`, `traps`…). Every user-created
exercise therefore gets a pattern that is never `legs`/`push`/`pull` — the grouped list would
render a header reading literally "CHEST" next to "PUSH".

**Fix.** Either have the create form set a pattern, or map muscle → pattern server-side.

**Also:** `pattern` has five values but the mockup renders three. `core` (22 exercises) and
`cardio` (18) need a home or an explicit exclusion. And "your training split" is the wrong
framing for anyone running upper/lower or full-body — their one session gets split across
three headers.

---

## 8. The endpoint

`GET /api/progress/recommendations` — computed on read, nothing stored, nothing to keep in
sync:

```
for each exercise the user has logged:
  find the last 2 sessions containing it, ordered by scheduledAt      (item 4)
  resolve the exercise name through variations                        (item 5)
  take the heaviest working-set group in each                         (items 2, 6)
  did every working set hit targetReps, both sessions, same weight?   (item 1)
    yes  -> suggest weight + increment, in the user's unit            (item 3, v152)
    most recent missed -> return as a hold
group by pattern                                                      (item 7)
```

**Scope it to recent sessions, NOT the page's time range** — Jeff's call, Aug 17. A
recommendation is about what to do next, so it must not change when someone scrubs the range
control. Show it above the range control, or label it as out of scope.

---

## 9. Where it should actually appear

The strongest idea from the design discussion, and not yet mocked:

**Put the suggestion on the exercise row inside the workout**, not only on the Progress page.
On leg day you open your workout, not a stats tab. If it only lives on Progress you have to
remember to check it before leaving — and the once you forget is the day it mattered. On the
row it's the right thing at the right moment, and grouping stops mattering because a leg
workout only contains leg exercises.

Progress then becomes the planning view — "where am I ready to push?" — which is what it's
good at.

---

## Test first

Every item above changes what a user is told about their own training. Several of the bugs
this plan fixes were found only by running the real server against a **copy** of production
`data.json` with the real file checksummed before and after — do that, don't reason about it.

Two bugs in this feature's own foundation were caught that way and would have shipped
silently otherwise: a boot migration that crashed in the temporal dead zone while the server
carried on serving, and a PR rule that ranked by volume.

Write the tests before the code.
