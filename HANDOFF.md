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
- Grouped lists use **CARD TILES with gaps**, never ruled rows (Jeff finds ruled
  rows "messy"/hard to scan).
- Never 3 equal-weight elements. Vary weight/size.
- Bottom nav, light theme, responsive, max-width ~480px (iPhone portrait).
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

## Current state (as of v88)
- **Live:** https://spotmeapp.fly.dev (Fly; deploy via `flyctl deploy --remote-only`).
- **v88 changes:** "Friends joined" rendered as **avatar chips** (initials circles via
  `avatarColor()`, reusing the Friends/Profile/Join idiom), **self ("You") filtered out**,
  and **moved to the very bottom** (after Chat) so the page leads with the Workout.
  Session order: Workout → Join requests → Suggest a swap → Chat → Friends joined.
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
