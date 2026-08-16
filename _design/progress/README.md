# Progress page — design notes (Aug 16, 2026)

Mockups for a proposed **Progress** page: a 5th bottom-nav tab, its own page.
Jeff reviewed these and liked the direction. **Nothing here is built or deployed** —
these are standalone HTML files, not app code. Open them in a browser at 390×844.

| File | Screen |
|---|---|
| `01-progress-established.html` | The page with ~21 weeks of history |
| `02-progress-new-user.html` | Same page, 2 workouts in — the empty states |
| `03-setup-first-run.html` | Optional first-run: enter lifts you already do |
| `04-progress-seeded.html` | After setup — earned vs self-reported records |
| `05-entry-sheet-units.html` | Entry sheet + the dumbbell "how is this counted" fix |
| `06-entry-sheet-early.html` | Earlier version of the entry sheet (superseded by 05) |

---

## What the page does

Four modules, all following one time range (4 weeks / 3 months / 6 months / Custom):

1. **Add weight next time** — exercises where you cleared every target rep twice in a
   row, with the weight to try next. A separate "Hold for now" section names lifts
   where reps were missed.
2. **Consistency** — days trained per week, one bar per week.
3. **Strength trend** — one lift at a time, estimated max over time, PR stars, goal line.
4. **Personal records** — current best per exercise, with change over the period.

## Decisions made, and why

- **The page leads with the actionable module, not the charts.** "Should I add weight?"
  is the question worth answering; everything else is browsing. You open Progress on
  the way to the gym, read one line, and close it.

- **Estimated max (Epley: `weight × [1 + reps ÷ 30]`), not raw weight.** 185×10 and
  225×5 are near-identical efforts; a raw-weight chart shows that as a jump. Estimated
  max puts every set on one honest line. The tradeoff is that it's an abstraction —
  worth revisiting if it confuses people.

- **One lift at a time, not multiple series.** Bench and deadlift on shared axes only
  teaches you that deadlifts are heavier.

- **Weekly bars, not a day-level heatmap.** The day grid was tried first (git history
  of this file) and consumed the entire first viewport, pushing the actionable module
  below the fold.

- **No "weekly" time-range preset.** At 7 days the consistency chart is one bar, the
  trend line has 2–3 points, and most weeks have no PRs — three of four modules go
  blank. The current week is a permanent line in the consistency card instead, and
  tapping a week bar drills into it.

- **Three record states, visually distinct.** This is the part to protect:
  - *self-reported* — grey left rule, "YOU ENTERED" tag, "beat it to set a record"
  - *earned* — normal row, green "▲ new record"
  - *beaten* — green left rule, filled "RECORD BEATEN" chip, names what it overcame
  Without the separation, importing history silently kills the first-PR moment.

- **Setup is skippable three ways** and the button counts what you filled in
  ("Save 3 lifts") so partial completion feels finished. Working weight is the only
  field that matters — it's what drives the recommendations. Best-ever and goal are
  behind a disclosure.

## Open / not decided

- **The combined "am I getting stronger overall" line** — a single trend across the
  main lifts, which the page currently can't answer. Discussed, not designed.
- Nothing on the page links through to the workout that produced it (every PR is a
  dead end).
- No bodyweight tracking — +20 lb on bench at the same bodyweight is a different story
  than +20 while gaining 15.

## ⚠️ Do this before building the dumbbell default

Jeff chose to **default silently to "a pair, weight is per hand"** rather than ask.
Agreed — but it raises the stakes on the library data, because nobody corrects a
silent default.

Of the 53 dumbbell-tagged exercises in `exercise-library.json`:
- **33** are clearly a pair — default is right
- **13** are genuinely either-way — pair default is defensible
- **7 are outright wrong** under a pair default and should be tagged first:
  Goblet Squat · Single-Arm Dumbbell Press · Single-Arm Dumbbell Row ·
  Concentration Curl · Single-Leg Calf Raise · Dumbbell Pullover ·
  Single-Leg Romanian Deadlift

The existing `dumbbell` / `dumbbells` tags **cannot** be used for this — they're
inconsistent (Goblet Squat is tagged plural but uses one; Farmer's Carry is tagged
singular but uses two). Add an explicit `loadType` field instead.

Left uncorrected, a goblet squat records at double weight — inflating estimated max,
corrupting the PR, and feeding a wrong recommendation, invisibly.

The `= 140 lb total` readout beside the weight field stays regardless. It removes the
ambiguity without asking anything.

**Same ambiguity, not yet handled:** weighted pull-ups and dips (is 25 the added plate
or bodyweight + plate?).

## Build notes

- Entry reuses what exists: the bottom-sheet pattern (`.sheet-back` / `.sheet`), the
  exercise library picker, and `inputmode="tel"` for the numeric keypad. The new parts
  are storage and the sheet's three fields.
- The server-side PR data these screens need already landed in **v149**
  (`rebuildAllPrs()`, cross-session PR tracking, `prs` array on the profile payload).
- Aggregation should be a `/api/progress` endpoint, not client-side.
- All headline numbers in the mockups are computed from their own data arrays rather
  than hardcoded — an earlier version had figures that contradicted their own charts.

## Process note

Every screen here went through a cold review by a subagent that hadn't seen the
reasoning. It caught, among other things: card shadows bleeding across a 12px gutter
so a 2×2 grid read as one slab; an explainer paragraph describing the wrong formula;
and headline numbers contradicting the data beneath them. Worth repeating on the real
build — see `CLAUDE.md`.
