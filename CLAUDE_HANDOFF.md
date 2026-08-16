# CrewFit / SpotMe — COMPLETE HANDOFF PACK (for Claude Code + any agent)

> This is the master handoff. It combines the technical build context (below + `HANDOFF.md`) with Jeff's rules, correction history, and memory. Read it before any work.

---

## 0. WHO THIS IS FOR / HOW JEFF WORKS
- **Product:** SpotMe (a.k.a. CrewFit) — a social/collaborative fitness PWA. Training partners create/invite/swap/approve workouts, log individually, discover friends-only.
- **Founders:** Jeff + Brian. **Both NON-TECHNICAL.** Jeff (and Brian) validate everything **by eye on an iPhone 16 Pro, PORTRAIT**. They do not read code.
- **Your role:** You (the coding agent) BUILD. Jeff validates. Ship UI decisions; don't ask him to make aesthetic calls — he delegates those and trusts your recommendations ("go with your pick"). **LEAD, don't just execute.**
- **Communication style Jeff wants from agents:**
  - **Concise BULLET summaries** (he shows these to Brian). No long prose.
  - **Token/context-budget conscious** — he once said "slow down?" meaning *tokens*, not disk. Keep commits/summaries tight. Push work to the repo, end the turn, next agent starts fresh.
  - **Narrate progress** during long/multi-step builds ("I'm actively working…"). He's said he's unsure if the agent stopped. Don't go silent for many tool calls.
- **Both agents (you + Hermes) use `HANDOFF.md`** as the shared context file.

## 1. THE HARD VISUAL/UI PROCESS RULE (do not violate)
Jeff was burned before (Aug 15, 2026: an agent deployed a profile thumbnail redesign **before showing him and without his go**). So:
1. **RENDER the change and SHOW the image FIRST** (full page, see rule 3).
2. **WAIT for his explicit "go"/"deploy" before deploying.** NEVER deploy-then-show.
3. **MEASURE geometry** (box x/y/w/h + baseline via `getBoundingClientRect`), not just widths. Paired buttons = equal width/height/same baseline/centered; don't oversize one CTA.
4. **Show the FULL page with ALL features in ONE image by default.** Do NOT send isolated single-feature snippets (he dislikes seeing one thing at a time — stated Aug 15, 2026 after several isolated photo/logged-set demos). Exception only if Jeff explicitly says "this will be a different change" or "only do one or the other".
5. **Internal vision-check ≠ his approval.** Showing the agent's own render is not the same as Jeff approving on his iPhone.

## 2. DEPLOY COMMAND (Fly)
```
export PATH="$HOME/.fly/bin:$PATH"; fly deploy --app spotmeapp
```
- Live app: **https://spotmeapp.fly.dev**
- GitHub: **github.com/jbruzzi1/CrewFit**, branch `main`. **Never delete `.hermes/hermes-agent/`.**
- Auth token in app is stored as `localStorage` key `crewfit_token` (NOT `token`).
- VAPID/web-push keys are Fly secrets (do not put in repo).

## 3. STACK (quick)
- Node `server.js` (Express, in-memory `DB` persisted to disk via `save(DB)`). No ORM.
- Frontend: `public/app.js` (vanilla, no build step) + `public/index.html`. Bump the `?v=` cache-bust on any frontend change (e.g. `app.js?v=144`).
- Media: files written to persistent `/data/uploads` volume → served as `/uploads/...` URLs.
- No test/lint/build suite. `package.json` scripts = `{ "start": "node server.js" }` + `playwright` devDep.

## 4. SHIPPED VERSIONS (all live on main)
- **v138** — fix `server.js` `s.scheduledAt.slice` crash on numeric date (now `String(s.scheduledAt).slice(0,10)`)
- **v139** — home cleanup: dropped wordmark, compact "+ New workout", invites top banner, Friend's Activity de-emphasized
- **v140** — visual refresh: elevated rounded cards w/ soft shadows, warmer off-white bg, more breathing room, middot separators unified
- **v141** — greeting back to solid near-black (`color:var(--fg)`); blue stays on CTA + active nav only
- **v142** — pending invites excluded from "Your Sessions" (filter `participants.includes(ME.id) && !(invited.includes(ME.id))`)
- **v143** — after Accept, session view hides the Respond menu (`!isCreator && !s.post && !isParticipant`); transitions to joined state. Decline-from-banner verified clean. Profile invites already correctly excluded.

## 5. INVITE / SESSION DATA MODEL (server.js)
- Create: `participants:[creatorId]`, `invited:[...inviteeIds]`.
- Accept (`POST /api/sessions/:id/accept`): removes ME from `invited`, pushes ME to `participants`.
- Decline (`POST /api/sessions/:id/decline`): removes ME from `invited` only.
- List endpoint returns a session if `participants.includes(me)` OR `invited.includes(me)` OR (`visibility==='friends'` && creator is my friend).
- Profile `myWorkouts` filters by `s.post.by===me` OR `history.some(h=>h.userId===me)` — pending invites correctly excluded.

## 6. CORRECTION HISTORY (what Jeff pushed back on, and WHY) — learn from these
1. **"Don't deploy before showing me."** (Aug 15, 2026) An agent deployed a profile thumbnail redesign without showing Jeff or getting his go. → Now: render + show + wait for explicit go (rule 1).
2. **"Show the WHOLE page, not isolated snippets."** (Aug 15, 2026) After several isolated photo/logged-set demos, Jeff said he dislikes seeing one feature at a time and not the full view. → Now: full-page single image by default (rule 4).
3. **"Don't hide empty states / features from new users."** Jeff flagged that hiding the empty invite slot (to keep UI minimal/clean) leaves new users lost — they'd never know where to look for an invite. → Now: the invites slot is ALWAYS rendered (blue banner when pending, subtle grey hint when empty). Preserve feature DISCOVERABILITY over minimalism.
4. **"The home felt like a room with no windows."** Jeff said the flat grey lists felt enclosed/dead. → Led to the v140 elevated-cards + airy + (briefly) gradient, then solid-black greeting (v141).
5. **"The gradient blue is too gay for the header."** Jeff felt the soft blue gradient on the greeting read wrong for a training-tool app. → Moved to solid blue, then to solid black (v141) so blue stays only on the CTA/nav.
6. **"Match the app's blue theme."** When the greeting was green→blue, Jeff wanted blue to be the theme color (it is `--blue:#2563eb`; green is only the avatar accent). → Keep blue as the brand color; don't split attention with green.
7. **Greeting copy is a bit gym-bro.** "Time to crush it" / "Show up. Lift heavy" is generic. Friend's Activity feed ("Sarah hit a PR on Squat (225×5)") is the best copy — social, specific, alive. Keep that energy.
8. **"Pending invites shouldn't show in Your Sessions."** Jeff wanted invites to appear ONLY in the top banner until accepted. → v142 fix.
9. **"What happens if there are no invites?"** Jeff worried the button would sit low / the slot would be empty and confusing. Verified: banner collapses, button moves up under header — no layout break. But he also wanted new users to LEARN the invite feature exists → kept the grey empty-state hint.
10. **ENV TRAP (agent infra, not product):** terminal can flip to broken Singularity/Apptainer mode → all tools fail 'apptainer not found'. Recovery: fully QUIT Hermes app + NEW session. Shell bug prepends 'cd /root' → pass terminal `workdir` param. (This is Hermes-specific; Claude Code may not hit it, but good to know.)

## 7. KNOWN-CORRECT AREAS (do NOT "fix" — already verified)
- Decline flow (banner): removes invite, no error/zombie.
- Profile "Your Workouts": correctly excludes pending invites.
- Auth token key is `crewfit_token`.
- `scheduledAt` must be coerced with `String()` before `.slice`.
- Three-dots ⋯ menu renders ONLY when `isCreator`.

## 8. RENDER / VERIFY HARNESS (for catching visual + logic bugs before deploy)
Playwright against a local server. Seed realistically, screenshot at 390×844 @2x, eyeball, check console `pageerror`.
```
# terminal 1
PORT=4700 node server.js
# terminal 2 (seed + screenshot script)
node diag_x.cjs   # http reqs to /api/register, /api/friends/*, /api/sessions, then playwright login + screenshot
```
Seeding: register Jeff + friends, `/api/friends/request` + `/api/friends/accept`, create sessions, then UI-login (`#lx` username, `#lp` pin, `button.blue`) and screenshot. Prefer UI-login + click path over boot-token (boot fetch is flaky in Playwright). Hermes (the other agent) owns the render/verify step — route visual confirmation through him.

## 9. THE AGENT DIVISION OF LABOR (how Jeff runs this)
- **You (Claude Code)** = build agent. Write code, run checks, commit locally. Do NOT deploy.
- **Hermes** = verify/render agent + Jeff's translator. Renders UI, eyeballs, catches bugs, confirms real behavior before anything goes live.
- **Loop:** Jeff → you build → Hermes renders + verifies + reports → Jeff approves → deploy.
- **Hard:** never `fly deploy` without Jeff's explicit go.

## 10. OPEN / LIKELY NEXT WORK
- Workouts tab / New workout creation haven't had the v140 "open it up" visual pass — candidate for consistency.
- `confirm()` / `prompt()` native dialogs on Accept/Decline/Save-Routine work on iPhone but a custom modal is a polish option.
- "Request Changes" / "Save This Routine" from the pending Respond menu re-render but keep Accept/Decline (correct, but native `prompt()` UX).

## 11. COMMANDS CHEAT-SHEET
- Syntax check: `node --check public/app.js && node --check server.js`
- Local preview: `PORT=4700 node server.js` → http://localhost:4700
- Pull latest: `git pull origin main`
- Deploy (only with Jeff's go): `export PATH="$HOME/.fly/bin:$PATH"; fly deploy --app spotmeapp`
- Verify live: `curl -s https://spotmeapp.fly.dev/app.js?v=<n> | grep <marker>`

---
*Generated from the working session. The app code lives in this repo (`public/app.js`, `public/index.html`, `server.js`); full history on github.com/jbruzzi1/CrewFit. Jeff's durable preferences are in `.hermes/memories/MEMORY.md` (do not delete).*
