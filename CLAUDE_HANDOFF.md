# CrewFit / SpotMe — COMPLETE HANDOFF PACK (for Claude Code + any agent)

> Read this + `HANDOFF.md` before any work. This file = the human/process layer (rules, corrections, memory). `HANDOFF.md` = the technical build layer. Together they are the full context.

---

## 0. WHO / HOW JEFF WORKS
- **Product:** SpotMe (a.k.a. CrewFit) — social/collaborative fitness PWA. Training partners create/invite/swap/approve workouts, log individually, discover friends-only.
- **Founders:** Jeff + Brian. **Both NON-TECHNICAL.** Jeff (and Brian) validate everything **by eye on an iPhone 16 Pro, PORTRAIT**. They do not read code.
- **Your role:** You (coding agent) BUILD. Jeff validates. **Ship UI/aesthetic decisions; don't ask him to make them** — he delegates and trusts your recommendations ("go with your pick"). LEAD, don't just execute.
- **Comm style Jeff wants from agents:**
  - **Concise BULLET summaries** (he shows these to Brian). No long prose.
  - **Token/context-budget conscious** — he once said "slow down?" meaning *tokens*, not disk. Keep commits/summaries tight. Push work to repo, end turn, next agent starts fresh.
  - **Narrate progress** during long/multi-step builds ("I'm actively working…"). He's said he's unsure if the agent stopped. Don't go silent for many tool calls.
- **You (the coding agent) use `HANDOFF.md`** as shared context.

## 1. THE HARD VISUAL/UI PROCESS RULE (do not violate)
Jeff was burned (Aug 15, 2026: an agent deployed a profile thumbnail redesign **before showing him + without his go**). Rules:
1. **RENDER the change and SHOW the image FIRST** (full page — see rule 4).
2. **WAIT for his explicit "go"/"deploy" before deploying.** NEVER deploy-then-show.
3. **MEASURE geometry** (box x/y/w/h + baseline via `getBoundingClientRect`), not just widths. Paired buttons = equal width/height/same baseline/centered; don't oversize one CTA.
4. **Show the FULL page with ALL features in ONE image by default.** Do NOT send isolated single-feature snippets (he dislikes one-thing-at-a-time — stated Aug 15, 2026). Exception only if Jeff explicitly says "this will be a different change" or "only do one or the other".
5. **Internal vision-check ≠ his approval.** Showing the agent's own render is not the same as Jeff approving on his iPhone.

## 2. DEPLOY + REPO
- Deploy: `export PATH="$HOME/.fly/bin:$PATH"; fly deploy --app spotmeapp`
- Live: **https://spotmeapp.fly.dev**
- GitHub: **github.com/jbruzzi1/CrewFit**, branch `main`. **Never delete `.hermes/hermes-agent/`.**
- Auth token stored as `localStorage` key `crewfit_token` (NOT `token`).
- VAPID / web-push keys are Fly secrets (not in repo).

## 2.5. FLY POSTGRES SETUP
- Persistence is Postgres, not a file — `db.js` (hand-rolled client in `pgmini.js`, no
  dependency) is a thin load()/save() wrapper around it; `server.js`'s in-memory `DB` object
  shape and all business logic are completely unchanged (see the design-call comment at the top
  of `db.js`). `DATABASE_URL` is a required Fly secret (set via `fly postgres attach`) — the app
  refuses to boot without it, or if it's unreachable (loud `FATAL during boot:` in `fly logs`,
  never a silent empty database).
- **One-time cutover runbook (create the Postgres cluster, attach it, migrate the live
  `data.json`, deploy, verify, rollback plan): see `DEPLOY.md`'s "ONE-TIME: moving the database
  from data.json to Postgres" section.** That section is deleted once the cutover is done — if
  it's gone, the cutover already happened and this whole paragraph is historical.
- The migration tool is `scripts/migrate-to-postgres.mjs` — reuses `db.js`'s own
  save()/load()/ensureSchema() (one source of truth for "how a DB object becomes Postgres rows"),
  refuses to write anything if the source file has a case-insensitive username collision
  (mirrors `reportUsernameCollisions()` in `server.js`), and verifies via a full deep read-back
  compare (not just row counts) before declaring success. Also doubles as the documented
  incident-recovery tool post-cutover — see DEPLOY.md's "If a deploy goes wrong" — and is
  exercised end-to-end by `test/data-safety.mjs`'s "documented recovery path" test.
- The `/data` volume didn't go away — post-cutover it holds uploaded photos/videos and a JSON
  snapshot backup written before every boot (last 10 kept), not the live database itself.
- **Scaling this before real growth** — see §11's "Before pushing for real user growth" note.

## 3. STACK (quick)
- Node `server.js` (Express, in-memory `DB` persisted to Postgres via `save(DB)` — see §2.5). No ORM.
- Frontend: `public/app.js` (vanilla, no build step) + `public/index.html`. Bump the `?v=` cache-bust on any frontend change (`app.js?v=144`).
- Media: files → persistent `/data/uploads` volume → served as `/uploads/...`.
- `npm test` runs the full suite (progression, accounts, sharing, targets, exposure, boot-shape,
  limits, ratelimit, follow, data-safety, plus `pgmini.mjs`/`db-layer.mjs` for the Postgres layer
  itself) against a real local Postgres — each file gets its own throwaway database via
  `test/_pgtestdb.mjs`, so tests don't interfere with each other and never touch real data.
  **Run it before and after anything that touches progression, PRs, units or the log sheet, and
  add to it.** Every assertion exists because something was actually broken. No lint/build step;
  `playwright` is a devDep used only by the render harness (§8).

## 4. SHIPPED VERSIONS (all live on main)
- v138 — fix `server.js` `s.scheduledAt.slice` crash on numeric date (now `String(s.scheduledAt).slice(0,10)`)
- v139 — home cleanup: dropped wordmark, compact "+ New workout", invites top banner, Friend's Activity de-emphasized
- v140 — visual refresh: elevated rounded cards w/ soft shadows, warmer off-white bg, more breathing room, middot separators unified
- v141 — greeting back to solid near-black (`color:var(--fg)`); blue stays on CTA + active nav only
- v142 — pending invites excluded from "Your Sessions" (filter `participants.includes(ME.id) && !(invited.includes(ME.id))`)
- v143 — after Accept, session view hides Respond menu (`!isCreator && !s.post && !isParticipant`); transitions to joined state. Decline-from-banner verified clean; profile invites already correctly excluded.
- v144 — Workouts tab gets the v140 treatment: muscle-group / exercise / search lists wrapped in elevated `.card`, h2-style category labels, more breathing room. Pure CSS + wrapper pass, no behavior change.
- v145 — Workouts tab polish: stronger card elevation on `.pick-list > .card` (matches home), and fixed the exercise list scrolling under the bottom nav (`.pick-list` padding-bottom `84px + safe-area`, was 20px).
- v146 — profile view-toggle active state (`.on` wasn't applying), equalised toggle button size/baseline, profile-head padding to the 14px edge
- v149 — cross-session PR tracking (`rebuildAllPrs`), Recent Activity + Personal Records on Profile
- v150 — the logger states what the weight NUMBER means per exercise (see `loadType`, §9)
- v151 — a PR is the HEAVIEST set, not the most volume. Was `weight × reps`, so 225×8 outranked 315×3, and bodyweight lifts (weight 0) could never rank at all
- v152 — kilograms as a per-user unit; every set stores the unit it was typed in
- v153 — swapped lifts file under the swap; sessions order by training date, not the day they were typed; `scheduledAt` normalised (it is sometimes an epoch number)
- v154 — rep targets became ranges (`defaultReps`–`defaultRepsMax`), snapshotted onto each set at log time so editing a finished workout cannot retroactively change whether a set hit its target
- v155 — the Progress tab
- v156 / v157 / v157.1 / v157.2 / v158 — Progress polish: compact range switch, readable axis dates, a useful empty state, months rather than raw week counts, no per-bar counts at 6 months, an example instead of explaining the rule twice
- v159 — strength trend, per lift and overall
- v160 — stop the bottom nav drifting while scrolling on iOS (compositor layer promotion; **not reproducible in headless Chromium — needs a real device**)
- v161 — seed the lifts you already do (server + record states). The setup SCREEN is still not built
- v162 — "add weight next time" moved onto the exercise row inside the workout, not just the Progress tab
- v163 — the advice box gets a state for every point in the progression, so the feature explains itself from the screen the user is on. Shipped with the fixes in §9
- v164 — the advice box stopped reporting a session count (correction #12)

## 5. INVITE / SESSION DATA MODEL (server.js)
- Create: `participants:[creatorId]`, `invited:[...inviteeIds]`.
- Accept (`POST /api/sessions/:id/accept`): removes ME from `invited`, pushes ME to `participants`.
- Decline (`POST /api/sessions/:id/decline`): removes ME from `invited` only.
- List endpoint returns a session if `participants.includes(me)` OR `invited.includes(me)` OR (`visibility==='friends'` && creator is my friend).
- Profile `myWorkouts` filters by `s.post.by===me` OR `history.some(h=>h.userId===me)` — pending invites correctly excluded.

## 6. CORRECTION HISTORY (what Jeff pushed back on + WHY) — learn from these
1. **"Don't deploy before showing me."** (Aug 15, 2026) An agent deployed a profile thumbnail redesign without showing Jeff or getting his go. → render + show + wait for explicit go (rule 1).
2. **"Show the WHOLE page, not isolated snippets."** (Aug 15, 2026) After several isolated photo/logged-set demos he disliked seeing one feature at a time. → full-page single image by default (rule 4).
3. **"Don't hide empty states / features from new users."** He flagged hiding the empty invite slot (to keep UI minimal/clean) leaves new users lost — they'd never know where to look for an invite. → invites slot ALWAYS rendered (blue banner when pending, subtle grey hint when empty). Preserve feature DISCOVERABILITY over minimalism.
4. **"The home felt like a room with no windows."** Flat grey lists felt enclosed/dead. → led to v140 elevated-cards + airy + (briefly) gradient, then solid-black greeting (v141).
5. **"The gradient blue is too gay for the header."** Soft blue gradient on greeting read wrong for a training-tool app. → moved to solid blue, then solid black (v141) so blue stays only on CTA/nav.
6. **"Match the app's blue theme."** When greeting was green→blue he wanted blue as the theme color (it is `--blue:#2563eb`; green is only avatar accent). → keep blue as brand color; don't split attention with green.
7. **Greeting copy is gym-bro.** "Time to crush it" / "Show up. Lift heavy" is generic. Friend's Activity feed ("Sarah hit a PR on Squat (225×5)") is the best copy — social, specific, alive. Keep that energy.
8. **"Pending invites shouldn't show in Your Sessions."** Wanted invites ONLY in top banner until accepted. → v142 fix.
9. **"What if there are no invites?"** Worried button would sit low / slot empty+confusing. Verified: banner collapses, button moves up under header — no break. But he wanted new users to LEARN the invite feature exists → kept grey empty-state hint.
10. **ENV TRAP (agent infra, not product):** terminal can flip to broken Singularity/Apptainer mode → all tools fail 'apptainer not found'. Recovery: fully QUIT the agent app + NEW session. Shell bug prepends 'cd /root' → pass terminal `workdir` param. (Agent-specific; may not hit every environment, but good to know.)
11. **Rendering a screenshot is not the same as SEEING it.** (Aug 16, 2026) An agent shipped a v144 Workouts pass with `.pick-list` bottom padding of 20px, so the exercise list scrolled under the bottom nav. It had rendered the page, screenshotted it, and sent Jeff the image with the nav sitting on top of the content — and still did not notice. Caught only because a second pass (v145) looked again. → A builder is the worst reviewer of its own change: it sees what it intended, not what is there. Use §8's cold-review step, and check the bottom ~90px of every full-page render specifically.

12. **Don't report a status you can't stand behind.** (Aug 17, 2026) The v163 advice box told Jeff "One session logged" on a lift he had not logged — the count included the workout he was standing in. It was also unfixable in principle: a session count cannot know whether those sessions hit the top of the rep range, or at what weight, so no status built on it is reliably true. → v164 replaced four status messages with one that describes what the box is FOR and says nothing about the user. **General rule: if a sentence makes a claim about the user's own history, it has to be right every time, or it should not be a sentence.** Jeff caught this within a minute of it going live; a reviewer had flagged it and the agent judged it minor.

## 7. KNOWN-CORRECT AREAS (do NOT "fix" — already verified)
- Decline flow (banner): removes invite, no error/zombie.
- Profile "Your Workouts": correctly excludes pending invites.
- Auth token key is `crewfit_token`.
- `scheduledAt` must be `String()`-coerced before `.slice`.
- Three-dots ⋯ menu renders ONLY when `isCreator`.
- The boot block at the bottom of `server.js` (§9). It is down there on purpose. Moving it up re-breaks the app.
- `sameLoad()` / `inUnit()` in `server.js` — the tolerance and the conversion are both deliberate, each with a test.
- `perfDate()` — `scheduledAt` is sometimes an ISO string, sometimes epoch seconds, sometimes epoch ms.
- Working sets are `normal` + `failure` only. Warm-ups and drop sets deliberately do not count (Jeff's call: a drop set is a finisher, outside the working range).

## 8. RENDER / VERIFY HARNESS (catch visual + logic bugs before deploy)
Playwright vs local server. Seed realistically, screenshot 390×844 @2x, eyeball, check console `pageerror`.
```
PORT=4700 node server.js              # terminal 1
node diag_x.cjs                       # terminal 2: http reqs to /api/register,/api/friends/*,/api/sessions then playwright login+screenshot
```
Seeding: register Jeff + friends, `/api/friends/request` + `/api/friends/accept`, create sessions, then UI-login (`#lx` username, `#lp` pin, `button.blue`) + screenshot. Prefer UI-login+click over boot-token (boot fetch flaky in Playwright). **You own the render/verify step** — render + eyeball before showing Jeff.

### Reviewing your own work (nobody else is checking it)
Rendering is not reviewing. You will look straight at a bug and not see it, because you see
the change you intended rather than the pixels in front of you — this has already happened
(§6.11). Build the skepticism in deliberately:
- **Cold review.** Before showing Jeff, hand the diff + screenshot to a subagent with no
  knowledge of why you built it that way, and ask what is wrong with it. It is not blind
  where you are blind.
- **Check the edges.** Bottom ~90px (nav overlap), top safe-area, and both horizontal
  gutters. That is where layout bugs hide and where the eye skips.
- **Real server, not a mock.** A static mock proves CSS only — it cannot prove invites,
  accept/decline, logging, or session state. Run the harness above.
- **Say what you did NOT verify.** Name it plainly; never let silence imply it passed.
- **Sandbox caveat:** a cloud session with a blocked npm registry cannot install
  `express`/`web-push`, so `server.js` will not run and only static/CSS rendering is
  possible. Disclose that explicitly. Claude Code on Jeff's machine has working npm
  (`node_modules/` is already present) and runs the full harness.

## 9. ENGINE RULES + TRAPS (server.js) — read before touching progression

**Never put startup work at the top of `server.js`.** There is a marked *Boot migrations* block
immediately above `app.listen` — everything that runs at startup goes there, nowhere else.

This has now bitten three times, and it is invisible in testing every time. `migrateMedia()`,
`rebuildAllPrs()` and `migrateLoadTypes()` each read a `const` declared further down the file
(`UPLOAD_DIR`, `LB_PER_KG`, `EX_LIB`). Called from the top, those references sit in JavaScript's
temporal dead zone and throw — killing the process before it can listen. What makes it lethal is
that each failure is *conditional*, so normal data boots fine:

- `toLb()` only evaluates `LB_PER_KG` when a set was typed in **kilograms**. One kg set in
  `data.json` and the server never boots again — permanently, until the file is hand-edited.
  Found Aug 17, 2026, dormant since v152 only because nobody had switched units.
- `migrateMedia()` only touches **legacy base64 photos**, which is why that migration had
  silently never run at all.

If you add boot work, add it to that block and add a test that boots against data which
exercises the conditional path.

**Double progression means the same WEIGHT, not just the same reps.** `recommendationsFor()`
requires `toppedOut(latest) && toppedOut(prev) && sameLoad(...)`. Without the weight check a
deload satisfied it: miss 225×7, drop to 135×10, and the next 135×10 read as two clean sessions
and told a 225 lb squatter to try 140. `sameLoad()` compares in lb with a 0.6 lb tolerance so a
unit switch (100 kg = 220.46 lb) is not read as a weight change.

**A set stores the unit it was typed in; anything shown back has to be converted.** Use
`inUnit(weight, from, to)`. Printing the raw number next to the user's *current* unit turned a
185 lb bench into "185 kg" — 408 lb — and one tap would have written it to their history.

**Bodyweight lifts store weight 0.** They must never render "0 lb" or "Try 5 lb today". The
`bodyweight` flag on a recommendation drives "at bodyweight" and "Add 5 lb today".

**Ask about the lift the user is ACTUALLY doing.** A swapped exercise logs under
`variations[exId][userId].swapTo`, not the template's name. `openLogSheet` resolves this before
calling `/api/progress/exercise/:name`; `exerciseNameFor()` does it server-side.

**`loadType` on the exercise library** (`pair` / `single` / `added`) marks the 65 exercises where
the entered number is ambiguous. **It cannot be inferred from the `dumbbell`/`dumbbells` equipment
tags — they are inconsistent** (Goblet Squat is tagged plural but uses one; Farmer's Carry is
tagged singular but uses two). Generator + the 14 judgment calls: `_design/progress/tag_loadtype.py`.
A wrong tag silently doubles someone's numbers.

**Test against a COPY of real data, never the live store itself.** Two bugs were found only that
way and would have shipped silently otherwise. Pre-Postgres this meant `DATA_DIR=/tmp/... node
server.js` against a copied `data.json`, checksummed before/after to prove it was untouched.
Post-cutover the same principle is now built into the test suite itself — `test/_pgtestdb.mjs`'s
`freshTestDb()` gives every Postgres-backed test file its own throwaway database, so a test can
never touch real data even by accident.

## 10. AGENT ROLE (how Jeff runs this)
- **You (Claude Code)** = the build agent. Write code, run checks, render + verify the UI (use the harness in §8), commit locally.
- **Loop:** Jeff gives a task → you build + render + verify → show Jeff the change (full-page screenshot) → wait for his explicit "go" → deploy.
- **Hard:** never `fly deploy` without Jeff's explicit go. Owning the verify step is NOT owning the deploy decision — that stayed with Jeff. Render + show him the change FIRST (see §1).
- **History:** a separate verify/render agent (Hermes) used to own §8. Jeff consolidated to Claude-only on Aug 16, 2026. Leave `.hermes/hermes-agent/` and `.hermes/memories/MEMORY.md` on disk regardless — retiring the workflow is not a reason to delete his files.

## 11. OPEN / LIKELY NEXT WORK
- **Before pushing for real user growth / an app-store launch, revisit the Postgres write
  pattern.** Flagged during the Aug 2026 data.json→Postgres migration (§2.5); Jeff asked to keep
  this on record for when he asks about getting real users on the app:
  - Every one of the ~50 `save(DB)` call sites in `server.js` (inherited unchanged from the old
    file-based design, on purpose, to keep this migration's risk low) re-syncs the ENTIRE database
    on every single write — every user row, every session row, every table, upserted, on every
    save. One person logging one set today does a full write pass over the whole DB. Invisible at
    a few dozen users; an O(total data) cost per write that slows down for EVERYONE as the user
    base grows. This is the real scaling ceiling — not the choice of Postgres itself. Fix: convert
    the highest-traffic call sites to targeted single-row/entity writes instead of whole-DB resyncs.
  - `db.js` holds one single Postgres connection for the whole app (no pooling) — every request
    from every user serializes through one TCP socket. Fine at today's traffic, a bottleneck at
    real scale. Fix: real connection pooling.
  - `pgmini.js` is a hand-rolled Postgres wire-protocol client (no dependency), not the standard
    `pg` npm package. Several real bugs were found and fixed in it during the initial build (a
    hang on connection drop, a race that could silently drop a concurrent write, a latency bug) —
    that's a signal about the risk of a bespoke client carrying more, not-yet-found edge cases the
    battle-tested `pg` library already handles. Worth swapping before leaning on it under real
    production load.
  - **Supabase considered (Aug 2026), not adopted — worth revisiting for the pooling/client fix
    specifically.** Supabase is managed Postgres hosting plus optional bundled services (Auth,
    Storage, Realtime, auto-generated REST/GraphQL APIs, a dashboard) — you can use it as "just
    Postgres with a real connection pooler (Supavisor) and a web UI" and ignore the rest, pointed
    at with the standard `pg` npm library instead of self-hosting on Fly. That would close the
    two bullets above (pooling + hand-rolled client) in one move, since you'd swap `pgmini.js` for
    `pg` either way. It does NOT fix the whole-DB-resync-per-save bullet — that's our own app
    code, unrelated to who hosts the database. Not adopting Supabase's Auth/Storage/Realtime/
    auto-APIs: our own login system already exists, is security-audited, and this app's data
    (deeply nested JSON per session/user) doesn't map cleanly onto Supabase's auto-REST-API
    strength anyway, which is built for normalized relational schemas. Cost note: Supabase's free
    tier auto-pauses after a week of inactivity, so an always-on app needs the Pro tier (from
    $25/mo) — compare against actual Fly Postgres cost at the time before deciding.
  - None of this blocks shipping the Postgres migration itself — it fixes a real incident (Aug 17,
    2026, see `test/data-safety.mjs`'s header comment) and is strictly safer than the old
    file-based system even unchanged. This is follow-up work, sequenced as its own dedicated
    build-and-verify pass (like the migration itself got), timed to before real app-store growth —
    not before shipping this.
- **The first-run setup screen is not built.** The server side landed in v161 (`GET/PUT/DELETE /api/me/seeds`, seeds as the older half of the progression pair, self-reported vs earned record states). The screen itself does not exist. Reference mockup: `_design/progress/03-setup-first-run.html`. **Jeff's decisions:** collect the WORKING weight only, not an all-time best (a working weight self-corrects within a week; a self-reported best is permanent and could block the first real PR forever); show it on first visit to Progress.
- ~~PINs are stored in plaintext.~~ Fixed in v168 (`migratePasswords()` in `server.js`) — every
  password is a per-user-salted scrypt hash (`pinHash`/`pinSalt`), never stored in the clear.
  This note was stale (predated v168) and is left here struck through rather than silently
  deleted, since it was flagged as a real risk to fix "before there are real users" and this
  confirms it actually was.
- **Two things can only be confirmed on a real iPhone**, never in headless Chromium: the v160 bottom-nav fix, and that the green "Try X lb today" box actually responds to a thumb.
- **A paused bug hunt** left `_bughunt_api.mjs`, `_bughunt_api2.mjs`, `_bughunt_front.cjs` untracked in the repo. Jeff paused it; pick it up or delete them.
- **Profile tab + New workout creation** still haven't had the v140 "open it up" visual pass — the main remaining consistency gap. (Workouts tab is done as of v144/v145.)
- `confirm()` / `prompt()` native dialogs on Accept/Decline/Save-Routine work on iPhone but a custom modal is polish.
- "Request Changes" / "Save This Routine" from pending Respond menu re-render but keep Accept/Decline (correct, but native `prompt()` UX).

## 12. COMMANDS
- Tests: `npm test` (run it before AND after touching progression / PRs / units / the log sheet)
- Syntax: `node --check public/app.js && node --check server.js`
- Local: `PORT=4700 node server.js` → http://localhost:4700
- Pull: `git pull origin main`
- Deploy (only with Jeff's go): `export PATH="$HOME/.fly/bin:$PATH"; fly deploy --app spotmeapp`
- Verify live: `curl -s https://spotmeapp.fly.dev/app.js?v=<n> | grep <marker>`

---
*App code in this repo (`public/app.js`, `public/index.html`, `server.js`); full history on github.com/jbruzzi1/CrewFit. Jeff's durable prefs in `.hermes/memories/MEMORY.md` (do not delete).*
