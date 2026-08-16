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

## 3. STACK (quick)
- Node `server.js` (Express, in-memory `DB` persisted via `save(DB)`). No ORM.
- Frontend: `public/app.js` (vanilla, no build step) + `public/index.html`. Bump the `?v=` cache-bust on any frontend change (`app.js?v=144`).
- Media: files → persistent `/data/uploads` volume → served as `/uploads/...`.
- No test/lint/build suite. `package.json` scripts = `{ "start": "node server.js" }` + `playwright` devDep.

## 4. SHIPPED VERSIONS (all live on main)
- v138 — fix `server.js` `s.scheduledAt.slice` crash on numeric date (now `String(s.scheduledAt).slice(0,10)`)
- v139 — home cleanup: dropped wordmark, compact "+ New workout", invites top banner, Friend's Activity de-emphasized
- v140 — visual refresh: elevated rounded cards w/ soft shadows, warmer off-white bg, more breathing room, middot separators unified
- v141 — greeting back to solid near-black (`color:var(--fg)`); blue stays on CTA + active nav only
- v142 — pending invites excluded from "Your Sessions" (filter `participants.includes(ME.id) && !(invited.includes(ME.id))`)
- v143 — after Accept, session view hides Respond menu (`!isCreator && !s.post && !isParticipant`); transitions to joined state. Decline-from-banner verified clean; profile invites already correctly excluded.
- v144 — Workouts tab gets the v140 treatment: muscle-group / exercise / search lists wrapped in elevated `.card`, h2-style category labels, more breathing room. Pure CSS + wrapper pass, no behavior change.
- v145 — Workouts tab polish: stronger card elevation on `.pick-list > .card` (matches home), and fixed the exercise list scrolling under the bottom nav (`.pick-list` padding-bottom `84px + safe-area`, was 20px).

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

## 7. KNOWN-CORRECT AREAS (do NOT "fix" — already verified)
- Decline flow (banner): removes invite, no error/zombie.
- Profile "Your Workouts": correctly excludes pending invites.
- Auth token key is `crewfit_token`.
- `scheduledAt` must be `String()`-coerced before `.slice`.
- Three-dots ⋯ menu renders ONLY when `isCreator`.

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

## 9. AGENT ROLE (how Jeff runs this)
- **You (Claude Code)** = the build agent. Write code, run checks, render + verify the UI (use the harness in §8), commit locally.
- **Loop:** Jeff gives a task → you build + render + verify → show Jeff the change (full-page screenshot) → wait for his explicit "go" → deploy.
- **Hard:** never `fly deploy` without Jeff's explicit go. Owning the verify step is NOT owning the deploy decision — that stayed with Jeff. Render + show him the change FIRST (see §1).
- **History:** a separate verify/render agent (Hermes) used to own §8. Jeff consolidated to Claude-only on Aug 16, 2026. Leave `.hermes/hermes-agent/` and `.hermes/memories/MEMORY.md` on disk regardless — retiring the workflow is not a reason to delete his files.

## 10. OPEN / LIKELY NEXT WORK
- **Profile tab + New workout creation** still haven't had the v140 "open it up" visual pass — the main remaining consistency gap. (Workouts tab is done as of v144/v145.)
- `confirm()` / `prompt()` native dialogs on Accept/Decline/Save-Routine work on iPhone but a custom modal is polish.
- "Request Changes" / "Save This Routine" from pending Respond menu re-render but keep Accept/Decline (correct, but native `prompt()` UX).

## 11. COMMANDS
- Syntax: `node --check public/app.js && node --check server.js`
- Local: `PORT=4700 node server.js` → http://localhost:4700
- Pull: `git pull origin main`
- Deploy (only with Jeff's go): `export PATH="$HOME/.fly/bin:$PATH"; fly deploy --app spotmeapp`
- Verify live: `curl -s https://spotmeapp.fly.dev/app.js?v=<n> | grep <marker>`

---
*App code in this repo (`public/app.js`, `public/index.html`, `server.js`); full history on github.com/jbruzzi1/CrewFit. Jeff's durable prefs in `.hermes/memories/MEMORY.md` (do not delete).*
