# SpotMe (CrewFit) — Engineer Handoff

Social/collaborative fitness PWA. Founders: Jeff + Brian (non-technical). The agent builds; they validate on iPhone 16 Pro, portrait.

## Stack
- Node `server.js` (Express, in-memory `DB` persisted to disk via `save(DB)`), no ORM.
- Frontend: `public/app.js` + `public/index.html` (vanilla, **no build step**). `app.js` is loaded with a cache-busting `?v=` query — bump it on any frontend change (e.g. `app.js?v=144`).
- Data persistence: JSON file (default `./data/db.json` or Fly volume `/data`). `MEDIA` uploads go to `/data/uploads` → served as `/uploads/...`.
- Deploy: **Fly**, app `spotmeapp`. `export PATH="$HOME/.fly/bin:$PATH"; fly deploy --app spotmeapp`
- Repo: `github.com/jbruzzi1/CrewFit`, branch `main`. **Never delete `.hermes/hermes-agent/`.**

## Deployed versions (main, all live at https://spotmeapp.fly.dev)
- v138 — fix `server.js` `s.scheduledAt.slice` crash on numeric date (now `String(s.scheduledAt).slice(0,10)`)
- v139 — home cleanup: dropped wordmark, compact "+ New workout", invites top banner, Friend's Activity de-emphasized
- v140 — visual refresh: elevated rounded cards w/ soft shadows, warmer off-white bg, more breathing room, middot separators unified
- v141 — greeting back to solid near-black (`color:var(--fg)`); blue stays on CTA + active nav only
- v142 — pending invites excluded from "Your Sessions" (filter: `participants.includes(ME.id) && !(invited.includes(ME.id))`)
- v143 — after Accept, session view hides the Respond menu (`!isCreator && !s.post && !isParticipant`); transitions to joined state

## Invite / session data model (server.js)
- Create: `participants:[creatorId]`, `invited:[...inviteeIds]`.
- Accept (`POST /api/sessions/:id/accept`): removes ME from `invited`, pushes ME to `participants`.
- Decline (`POST /api/sessions/:id/decline`): removes ME from `invited` only (does NOT add to participants).
- List endpoint returns a session if `participants.includes(me)` OR `invited.includes(me)` OR (`visibility==='friends'` && creator is my friend).
- Profile `myWorkouts` filters by `s.post.by===me` OR `history.some(h=>h.userId===me)` — pending invites are correctly excluded (no fix needed).

## ⚠️ VISUAL/UI PROCESS RULE (hard requirement)
**Render + SHOW the user (Jeff) BEFORE deploying any UI/visual change. Wait for his explicit "go"/"deploy" before `fly deploy`.** Never deploy-then-show. Jeff validates by eye on iPhone portrait (max-width 480px). He explicitly dislikes being shown deploy-first.
- Show the FULL page in ONE image, not isolated snippets, unless he asks for one piece.
- Match the app's existing style: white-bg/blue buttons, light theme, bottom nav, responsive.
- Three-dots ⋯ menu renders ONLY when `isCreator`.

## Render / verify harness (for catching visual + logic bugs)
Playwright against a local server. Seed realistically, screenshot at 390×844 @2x, eyeball with vision, check console `pageerror`.
```
# terminal 1
PORT=4700 node server.js
# terminal 2 (seed + screenshot script)
node diag_x.cjs   # uses http requests to /api/register, /api/friends/*, /api/sessions, then playwright login + screenshot
```
Seeding pattern: register Jeff + friends, `/api/friends/request` + `/api/friends/accept`, create sessions, then UI-login (`#lx` username, `#lp` pin, `button.blue`) and screenshot. The app reads token from `localStorage` key `crewfit_token`. Prefer UI-login + click path over boot-token (boot fetch is flaky in Playwright).

## Known-correct areas (do not "fix" — already verified)
- Decline flow: declining from the home banner removes the invite, no error/zombie.
- Profile "Your Workouts": correctly excludes pending invites.
- Auth token key is `crewfit_token` (not `token`).
- Server `scheduledAt` must be coerced with `String()` before `.slice`.

## Open questions / likely next work
- The `confirm()` / `prompt()` native dialogs on Accept/Decline/Save-Routine — fine on iPhone but worth a custom modal if polish is needed.
- "Request Changes" / "Save This Routine" from the pending Respond menu re-render but keep Accept/Decline (correct, but `prompt()` UX is native).
- Other pages (Workouts tab, New workout creation, Profile) have NOT been given the v140 "open it up" visual treatment — candidate for consistency pass.

## Commands cheat-sheet
- Syntax check: `node --check public/app.js && node --check server.js`
- Local preview: `PORT=4700 node server.js` → http://localhost:4700
- Deploy: `export PATH="$HOME/.fly/bin:$PATH"; fly deploy --app spotmeapp`
- Verify live: `curl -s https://spotmeapp.fly.dev/app.js?v=<n> | grep <marker>`
