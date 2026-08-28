# CrewFit / SpotMe — agent instructions

**Read `CLAUDE_HANDOFF.md` before doing any work.** It has the full context: stack, data model, correction history, and why each rule exists. `HANDOFF.md` is the engineer-facing technical summary.

This file is the short version — the rules that must never be missed.

## The hard rules

1. **NEVER deploy without Jeff's explicit "go."** Render the change, show him the image, wait. Never deploy-then-show. This is the one rule an agent already broke once (Aug 15, 2026) and it cost trust.
2. **You BUILD and you VERIFY. Jeff APPROVES. Then deploy.** Write the code, run the checks, render it, eyeball it, commit. Do not `fly deploy` on your own initiative.
3. **Show the FULL page in ONE image** — never isolated single-feature snippets. Jeff validates by eye on an iPhone 16 Pro, portrait (max-width 480px).
4. **Measure geometry** with `getBoundingClientRect` (x/y/w/h + baseline), not eyeballed widths. Paired buttons = equal size, same baseline.
5. **Bump the `?v=` cache-bust in `public/index.html`** on ANY frontend change. No build step exists — this is the only cache control.
6. **`npm test` before and after** anything touching progression, PRs, units or the log sheet — and add to it. Every assertion in `test/progression.mjs` exists because something was actually broken.
7. **Never add startup work to the top of `server.js`.** Use the *Boot migrations* block above `app.listen`. Three separate crashes have come from this; see §9 of `CLAUDE_HANDOFF.md`. The failures are conditional, so they do not show up in testing — one kilogram set in `data.json` was enough to stop the server booting for good.

## Verifying your own work (you own this end to end)

There is no second agent reviewing you. You build it AND you catch the bugs in it, so
build the skepticism in deliberately — the failure mode is trusting your own change
because you wrote it.

- **Always render before showing Jeff.** Playwright, 390×844 @2x, full page, check the
  console for `pageerror`. Never describe a visual change you have not looked at.
- **Pin fixed bars before any full-page screenshot** (Jeff, Aug 28: the nav kept landing mid-
  image). Playwright's fullPage stitching paints `position:fixed` elements at the viewport
  position, so on tall pages the bottom nav / `#updateBar` / `.sticky-bar` float mid-screenshot.
  Before capturing, convert them to `position:absolute` with `top: documentHeight - barHeight`
  (nav flush at the bottom; updateBar its usual offset above), and restore afterwards if the
  script keeps interacting. Overlays that cover the viewport (`.sheet-back`, `.crop-overlay`)
  get pinned to `window.scrollY` instead. Write this as a shared helper once per session and
  use it for every full-page shot.
- **Review with fresh eyes.** Before showing him, spawn a subagent to review the diff and
  the screenshot cold — without your reasoning for why it should work. It catches what
  you are blind to precisely because you decided it.
- **Verify the real thing**, not a mock. Run `PORT=4700 node server.js` and seed real
  data. A static mock only proves CSS; it cannot prove invites, accept/decline, logging,
  or session state.
- **Say what you did NOT verify.** If something could not be tested, name it plainly
  rather than letting silence imply it passed.

## How Jeff works

- Jeff and Brian are **non-technical** and do not read code. They validate visually.
- **Lead, don't just execute.** Make the aesthetic calls yourself and say what you picked — Jeff delegates those and trusts the recommendation.
- **Concise bullet summaries.** He forwards them to Brian. No long prose. Be token-conscious.
- **Narrate progress** on long builds so he knows you haven't stalled.

## Design constants

(Rewritten Aug 28, 2026 after the whole-app visual pass, v221–v240. The old text here described the light-only v140 language.)

- **Two themes, dark by default.** The app defaults to dark; Settings → Appearance toggles it (localStorage `crewfit_theme`, stamped on `<html>` as `theme-dark` by an inline head script BEFORE first paint — never let a page flash light). Phone-native `prefers-color-scheme` switching was deliberately removed at Jeff's request; the toggle is the only control. Every visual change must be rendered and checked in BOTH themes.
- **The dark palette lives in ONE block at the end of the stylesheet**, every selector prefixed `:where(html.theme-dark)` — the zero-specificity wrapper is load-bearing. A plain `html.theme-dark button` outranked `.nav button` and turned the whole nav green (v230). Add dark overrides only inside that block, only with `:where()`.
- **Color is a language: blue = actions, green = achievements, gold = live status.** Blue (`--blue`, #2563eb light) is CTAs and the active nav tab. Green is exclusively earned things — PR pills (solid green fill), the streak dot, the recap celebration. Muted gold #d7a04a marks "Live now" ONLY. No amber/orange anywhere else (Jeff: "Halloween feel"), no gradients. In dark theme, white-text fills use the deeper steps (#1f8a4c green, #3b6de8 blue); the bright dark accents (#3ecf72 / #5a8bff) are for text and borders only — they fail contrast as backgrounds.
- **"No windows" airiness.** Near-white/near-black page background with borderless floating cards (soft shadow, no border) — except inside sheets, where cards keep a hairline (`.sheet .card`). No boxed-in header bars. Empty states render OPEN — icon, line, optional CTA (`homeEmpty`) — never inside a card box.
- **A card renders only when it has content** (v222, app-wide since v225). An empty section shows its open empty state, not an empty box.
- **The stat row never renders a zero.** Stats are drawn from a priority pool and simply not shown when they'd be 0 ("0 PRs this week" is demoralizing and useless). Jeff explicitly likes the "Last workout: Tuesday · Pull Day" line — keep it.
- **Discoverability beats minimalism.** Never hide an empty state; a new user must be able to find the feature.
- **But never state something about the user you can't stand behind.** v163 told Jeff "One session logged" on a lift he had not logged. Discoverable and wrong is worse than quiet. If a sentence claims something about their history, it has to be right every time.
- **Confirmations are in-app sheets (`confirmSheet`), never browser `confirm()`** — browser dialogs speak no design language and ignore the theme.
- Feed rows: every row's leading mark (photo thumb, check, PR pill) sits in a fixed 36px `.feed-lead` column so names always start at the same x (Jeff, Aug 28).

## Do NOT "fix" these — already verified correct

- Decline-from-banner flow (no zombie invite).
- Profile "Your Workouts" excludes pending invites.
- Auth token key is `crewfit_token`, not `token`.
- `String(s.scheduledAt)` before `.slice` in `server.js`.
- The three-dots ⋯ menu's **Edit session** (the shared exercise list, via `renderWorkoutEdit`/`saveWorkoutEdit`) and **Delete session** both render only when `isCreator` (Delete removes the session for every participant, not just your own copy — Leave Workout is the non-creator's door out).
  **Aug 28, 2026:** Jeff first asked to edit a posted workout even when he wasn't the creator, "just as if i was." A widened, creator-or-author version of `PUT /api/sessions/:id` was built and verified end to end, but his very next message narrowed the ask: *"I don't want to change the exercises — just my logged sets"* (plus deleting it off his own page, editing his own notes, and photos). So the exercise-list edit stayed exactly what it always was — creator-only, unchanged, reverted back to its original form in both server.js and app.js. What non-creator participants actually got instead, all scoped to "my own," documented in the comment above `viewPost` in app.js:
  - **Remove from my profile** (non-creator author, in place of Delete) — `POST /api/sessions/:id/remove-mine`, a deliberately new/separate endpoint, not a variant of Leave Workout (see the comment above `/leave` in server.js for why: Leave exists specifically to *keep* your history, this exists to erase it).
  - Editing your own logged sets, right on the posted-workout view — `editPostedSet`/`savePostedSet`/`deletePostedSet` in app.js, gated per set-row on `pid===ME.id`, using the already-self-scoped `PUT`/`DELETE /api/sessions/:id/log/:logId`.
  - Editing your own notes on the recap — `editPostNotes` in app.js, gated on `isAuthor`.
  - Adding/changing photos on the recap — `addPostPhoto`/`deletePhoto` in app.js, gated on `isAuthor` (shipped earlier, PR #29).
  Do not widen `PUT /api/sessions/:id` (the exercise list) to non-creators again without asking Jeff first — he's now said no to it once already.
- The boot block at the bottom of `server.js`, and `sameLoad()` / `inUnit()` / `perfDate()`.
- Warm-ups and drop sets not counting as working sets — Jeff's call, deliberate.

## Commands

```bash
npm test                                               # 34 assertions on the progression rule
node --check public/app.js && node --check server.js   # syntax check
PORT=4700 node server.js                               # local preview
export PATH="$HOME/.fly/bin:$PATH"; fly deploy --app spotmeapp   # ONLY with Jeff's go
```

Repo: `github.com/jbruzzi1/CrewFit`, branch `main`. Live: https://spotmeapp.fly.dev
**Never delete `.hermes/hermes-agent/`.**
