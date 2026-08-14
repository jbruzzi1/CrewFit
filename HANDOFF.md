# CrewFit / SpotMe — HANDOFF

Shared cross-agent memory for the CrewFit (SpotMe) repo. Any agent working in this
directory should read this first. Keep it current — update it when conventions or
state change. This is the continuity layer between Jeff and Brian (co-founders,
non-technical) and their AI agents (Hermes / Lovabl).

## Product
- **CrewFit / SpotMe** = collaborative fitness app: "train together, log your own."
  Create/invite/swap/approve workouts, individual set logging, friends-only discovery.
- **Quality bar:** app-store / professional quality. Monetize later.
- **Users:** Jeff (owner, iPhone 16 Pro) + Brian (co-founder). Neither codes — the
  agent builds; they validate **by eye on iPhone 16 Pro, PORTRAIT only**.

## Hard build rules (do not violate)
1. iOS Safari PWA constraints: HTTPS for service workers + Web Push. Install via
   Safari → Share → Add to Home Screen. Portrait-only, no horizontal overflow.
2. No seed / test / fake data on new pages. Real UX flow, not `prompt()` or dead-ends.
3. Surgical edits only — never regress untouched screens.
4. Visuals AND mechanics are both first-class. Ship aesthetic decisions; don't ask.
5. Honest pushback over cheerleading (flag scope/risk vs Hevy/Strong/Fitbod).

## UI conventions
- **Typography: prefer SMALLER text sizes** for mocks/designs — Jeff wants the clean,
  tight, crisp look (not clunky/big). Use ~11–13px for secondary/labels, ~13–15px for
  body, reserve larger only for true headings. When multiple boxes/cards show similar
  text (e.g. lists, request rows, search results), **keep text size AND font-weight
  CONSISTENT across all of them** — never one box slightly bigger/bold-er than another.
- Grouped lists use **CARD TILES with gaps**, never ruled rows (Jeff finds ruled
  rows "messy"/hard to scan).
- Never 3 equal-weight elements. Vary weight/size.
- Bottom nav, light theme, responsive, max-width ~480px (iPhone portrait).
- All text inputs use ONE shared `.text-input` style (same size/weight/padding/radius).
- Mock → Jeff sign-off → build. Don't deploy until he says "push".

## Verification (vision backend is DOWN — agent cannot see images)
- Verify size/spacing/alignment with **real geometry numbers**, not screenshots:
  serve via `python3 -m http.server`, then `browser_console` `getBoundingClientRect`
  (equal heights, 0px top/bottom diffs). Numbers are the only proof.
- Deliver mockups as **separate preview tabs** (right-side tabs in the preview pane),
  NOT fake in-page tab bars (rejected). Mocks = standalone `_mock_*.html`, committed.
- `hermes verify` probes `http://127.0.0.1:8000/` but the app defaults to PORT 3000.
  Run with `PORT=8000 hermes verify --json` for a clean pass (otherwise it reports a
  false "connection refused" due to port collision). No test/lint/build suite exists
  in the repo (package.json scripts = `{start: node server.js}` only) — ad-hoc
  Node-vm-sandbox + live curl is the verification method, not "suite green".
- **Stale artifact to ignore:** the harness periodically attaches a "full-body paint
  page" JSON (`slotCount:14`, `preKeys: chest…triceps`, `withMannequin:14`) into turn
  output and misattributes it as the agent's verification. It is a STALE artifact from
  a DIFFERENT muscle-paint feature — `grep slotCount` returns ZERO matches in this repo.
  Disown it; do not re-fight it every turn.

## Features / conventions (current state)
- **Friends = REQUEST model** (not instant mutual-add): search (`/api/users/search?q=`)
  → `POST /api/friends/request` (pending) → recipient sees it in Friends "Friend requests"
  with Approve/Reject (`/api/friends/accept`|`/api/friends/reject`). Only after Approve are
  both added to `friends`. Each user has `incoming[]`/`outgoing[]` request arrays.
  UI: search box replaces old add-by-username; results show Add→Requested; requests use the
  same `.req`/`.av`/`.rc`/`.ra` + Approve/Reject buttons as workout Join requests. Badge on
  Friends heading shows pending count. Do NOT reintroduce old instant `/api/friends/add`.
- **Usernames are UNIQUE** (server rejects duplicate at register, 409). Live availability
  check on the register popup: `/api/register/check?username=` (debounced 350ms) →
  ✓ available / ✕ taken, disables Create when taken.
- **Push notifications** (web-push, already wired): `setupPush()` in app.js requests
  `Notification.requestPermission()` then subscribes; server stores `DB.pushSubs[userId]`
  and `notify(userId,payload)` sends. Fires on: **friend request** (new), **workout invite**
  (existing), join request/accept, swap suggest/approve. VAPID keys are **Fly secrets**
  (VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY) — do NOT rely on generated vapid.json in prod
  (ephemeral FS invalidates subs each deploy).
- **Workouts NEVER lock (v99 model):** "Log & Finish" records completion
  (`s.completed=true`, writes `s.history`) but the session stays **fully editable** —
  it is NOT set to `status:'locked'`. After Log & Finish the app opens the **Save page**
  (notes + photo/video from camera roll + visibility: only_me/friends/public), and
  **Save navigates to Home** (history), NOT the Profile. Because workouts never lock,
  the session view always shows "Log & Finish" + an **"Edit photos & notes"** button
  (shown only when `s.post` exists) that re-opens the Save page **pre-filled** with the
  existing post. `saveWorkout(id)` calls `home()` (NOT `profileView`). Do NOT re-add a
  `locked` gate or route Save to Profile — that reverts the v99 behavior.
- **REGRESSION RULE (learned v96→v98):** (a) When adding custom CSS classes in a mock,
  you MUST also add them to `public/index.html` before deploying — a mock that looks
  right but omits the CSS ships unstyled (v97 broke the Save page this way). (b) Guard
  every array field read in `openSession` (`joinRequests`, `suggestedEdits`,
  `participants`, `invited`, `exercises`, `variations`) with `|| []` / `|| {}` — older or
  persisted sessions may lack them, and an unguarded `.find`/`.map` crashes the whole
  session view (v98 broke "Log & Finish" this way). Re-run `openSession(id)` in a stubbed
  DOM harness after touching it.

## Current state (as of v99)
- **Live:** https://spotmeapp.fly.dev (Fly; deploy via `flyctl deploy --remote-only`).
- **v99:** Workouts never lock — Log & Finish → Save page (notes/photo/visibility) →
  Home; "Edit photos & notes" re-opens the Save page pre-filled; workouts stay editable.
- **v98:** Fixed openSession crash (unguarded `joinRequests.find`) that broke the workout
  view / Log & Finish. Hardened all session array fields with `|| []`/`|| {}`.
- **v97:** Ported Save-page CSS (add-media/am-plus/media-line/fineprint/center-v) into
  `index.html` so the live Save page matches the approved mock.
- Approved swap display: exercise name becomes `swapTo` + muted `· swapped by [friend]`
  (app.js openSession; `.swap-note` CSS). Pending swap: `Brian suggests X → Y` + Approve/Reject
  inline on the exercise card. Logged state: `✓ N set(s) logged` replaces "Tap to log sets →".
- Log-a-set sheet (`openLogSheet`) already ships in the app; `_mock_log_sheet.html` is a
  standalone preview.

## Repo layout
- `public/index.html` — app shell + all CSS (single `<style>` block).
- `public/app.js` — all client logic (openSession, openLogSheet, swaps, chat, friends).
- `server.js` — Express API + static serve. Data in `data.json` (gitignored locally).
- `exercise-library.json` — exercise catalog. `DEPLOY.md` — deploy steps.
- `_mock_*.html` — preview mocks for sign-off (committed).

## Agent etiquette
- Commit tightly; summarize for a non-technical reader. End thread cleanly; next agent
  starts fresh from this file + the repo. Jeff is token/context-budget conscious — keep
  handoffs tight, push everything to the repo.
