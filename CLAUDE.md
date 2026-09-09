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
8. **Before calling any change validated, ask: will this behave the same inside a native/wrapped app, not just the website version?** (Jeff, Sep 9, 2026, after the select-all-on-focus fix turned up a real iOS-Safari-only quirk with `.select()` on `<input type="number">`: "will this translate over when we are inside an app and not on a website version. I want us to ALWAYS remember and ask that question before we validate the change.") CrewFit is tested today as a website in mobile Safari (Playwright + Jeff's own iPhone). Anything that leans on browser-specific behavior — input selection/focus quirks, `history.pushState` (the sheet-dismiss-on-Back pattern), service workers/push, `localStorage`, viewport/keyboard handling, deep links — can behave differently once this ships inside an actual app wrapper.
   **Addition (Jeff, same day): "If browser specific - we avoid and FLAG TO JEFF. We want everything to translate over to an app."** This is not just a disclosure rule — prefer a non-browser-specific way to build the thing FIRST. Reach for a browser-specific API/behavior only when there's no reasonable alternative, and when you do, say so explicitly to Jeff before he approves it (what's browser-specific about it, and what happens to it in an app wrapper), rather than silently shipping it and only mentioning it if asked. Don't silently assume a website-only test covers the app case either way.
9. **Never lock in a subjective/creative call — wording, a label, a name, a color, copy, anything with more than one reasonable answer — by building it and showing Jeff the result.** Ask FIRST, before it's built. (Jeff, Sep 9 2026, after the PR/set-record feature shipped with a "WORK" badge label picked and built without asking him first, only explained after the fact alongside finished screenshots: "NEVER make changes like that without running them by me first. you never checked to confirm I like work.") Explaining the reasoning afterward, or inviting him to change it once it's already built, does not satisfy this — by then it is real code, a real screenshot, and a real thing he has to actively reject rather than an open question. The fix is the same shape as the copy-wordsmithing rounds earlier in this project (see CLAUDE_HANDOFF.md): surface 2-3 real options with the reasoning for each, or ask outright, and wait for Jeff's pick BEFORE writing it into the feature. This does not block objective, single-answer engineering work (a bug fix, a data-model change, wiring a test into `npm test`) — it's specifically for anything where a reasonable person could disagree with the choice made.
10. **Whenever making changes or additions, always run the proper math to make sure the visuals are centered/proper/the way they should be.** (Jeff, Sep 9 2026, standing rule — issued right after he spotted the PR/VOLUME pill text sitting visibly high in its pill from a zoomed screenshot, a real bug from `line-height:normal` reserving descender space that all-caps text never used.) This generalizes hard rule #4 and the "Double-check the visuals" bullet below from "do this for pills/segments/chips/buttons" to *every* visual change, without exception: before calling anything done, measure it — `Range.getBoundingClientRect()` of the actual text/glyph box against its container's `getBoundingClientRect()`, checking both vertical AND horizontal space on each side, not just one axis. Do not conclude something is centered from a screenshot by eye; screenshots are for catching what math alone would miss (actual color, real device rendering, layout in context), not a substitute for the measurement. If the math says it's off, it's off, even if it looks fine in a small preview.

## Verifying your own work (you own this end to end)

There is no second agent reviewing you. You build it AND you catch the bugs in it, so
build the skepticism in deliberately — the failure mode is trusting your own change
because you wrote it.

- **Always render before showing Jeff.** Playwright, 390×844 @2x, full page, check the
  console for `pageerror`. Never describe a visual change you have not looked at.
- **Pin fixed bars before any full-page screenshot** (Jeff, Aug 28: the nav kept landing mid-
  image). Playwright's fullPage stitching paints `position:fixed` AND `position:sticky` elements
  at the viewport position, so on tall pages `#updateBar` / `.sticky-bar` float mid-screenshot.
  Before capturing, convert fixed bars to `position:absolute` with `top: documentHeight - barHeight`
  (updateBar its usual offset above the nav), and restore afterwards if the script keeps
  interacting. **The bottom nav is `position:sticky` since Sep 7, 2026 (v361), not fixed** — it is
  the last in-flow child of `body`, so for a capture set it to `position:static` and it lands at
  the true end of the page by itself. (History: v160 propped up a fixed nav with translateZ/
  will-change to stop iOS repainting it lazily mid-scroll; on Sep 7 Jeff's screen recording showed
  it riding up the page again, so the fixed positioning was dropped altogether. Don't bring the
  fixed version back without a reason Jeff has seen on his phone.) Because the nav is
  in flow, `body` no longer reserves 72px for it; screens with their own fixed bar
  (`.wrap.edit-mode` → `.sticky-bar`) carry their own small padding instead. Overlays that cover the viewport (`.sheet-back`, `.crop-overlay`)
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
- **Ask the app-vs-website question (hard rule #8) before calling anything validated.** A
  Playwright/mobile-Safari pass proves the website works — it does not by itself prove the same
  for a future app wrapper. If the change touches browser-specific behavior, say so explicitly
  when showing Jeff the result.
- **Double-check the visuals every time — actually look at the screenshot as a designer would,
  not just as a "did it render" check.** (Jeff, Sep 6, 2026, with a phone screenshot of the
  Start-a-challenge page: "I don't like the visual of this. The pill boxes and size of texts just
  looks poor. Text hits all the inner edges of the boxes etc. Double check your work on visuals
  every-time.") The Playwright render showed the same problem and it shipped anyway because
  "the tests passed." Before showing Jeff any screen, go control by control and ask: does the text
  have room inside its box, is every font size a deliberate choice, do paired controls match?
  Measure it — for every pill/segment/chip/button on the screen, `Range.getBoundingClientRect()`
  of the label vs. the button's rect, and require ≥8px of room on each side (see
  `test/_measure_chal_page.mjs` for the pattern). Known trap: the bare `.seg button` rule has
  `padding:9px 0` (zero horizontal) and `font:inherit` AFTER `font-size:12px`, so its labels
  render at body size and touch the edges — use the `.seg.wk-seg` segmented track instead, which
  is the polished control (it is what Progress and the save page use).

## How Jeff works

- Jeff and Brian are **non-technical** and do not read code. They validate visually.
- **Lead, don't just execute.** Make the aesthetic calls yourself and say what you picked — Jeff delegates those and trusts the recommendation.
- **Concise bullet summaries.** He forwards them to Brian. No long prose. Be token-conscious.
- **Narrate progress** on long builds so he knows you haven't stalled.
- **Push it yourself — don't hand Jeff a `git push` command.** (Sep 6, 2026: Jeff asked for "a live link I can click on to do the push WITHIN claude every time" — a link can't run a local command, but the device bridge can, so when his Mac is linked, run `git push` there directly instead of making him open Terminal.) What Jeff actually gets is the PR-compare link (a real clickable URL) plus title/body text, sent inline in the chat in a bare fenced code block, every single time — never described in prose only, never pointing back to an earlier message. He still creates the PR and merges it himself. Same "paste it fresh, inline, every time" rule for the `fly deploy` command, which stays his to run (hard rule #1). If the Mac isn't linked, fall back to handing him the `git push` command the same way.

## Design constants

(Rewritten Aug 28, 2026 after the whole-app visual pass, v221–v240. The old text here described the light-only v140 language.)

- **Two themes, dark by default.** The app defaults to dark; Settings → Appearance toggles it (localStorage `crewfit_theme`, stamped on `<html>` as `theme-dark` by an inline head script BEFORE first paint — never let a page flash light). Phone-native `prefers-color-scheme` switching was deliberately removed at Jeff's request; the toggle is the only control. Every visual change must be rendered and checked in BOTH themes.
- **The dark palette lives in ONE block at the end of the stylesheet**, every selector prefixed `:where(html.theme-dark)` — the zero-specificity wrapper is load-bearing. A plain `html.theme-dark button` outranked `.nav button` and turned the whole nav green (v230). Add dark overrides only inside that block, only with `:where()`.
- **Color is a language: blue = actions, green = achievements, gold = live status.** Blue (`--blue`, #2563eb light) is CTAs and the active nav tab. Green is earned things — the streak dot, the recap celebration, and the PR/VOLUME pills everywhere EXCEPT the one carve-out below. Muted gold #d7a04a marks "Live now". No amber/orange anywhere else (Jeff: "Halloween feel"), no gradients. In dark theme, white-text fills use the deeper steps (#1f8a4c green, #3b6de8 blue); the bright dark accents (#3ecf72 / #5a8bff) are for text and borders only — they fail contrast as backgrounds.
  **Carve-out (Jeff, Sep 9 2026):** the PR pill specifically (not VOLUME) is gold `#eab308` fill / `#3a2a05` text, but ONLY in the two live-logging contexts (`.pp-pr.pp-pr-gold` in `exSetRowsHtml`'s live log sheet and the posted-workout `setRows`) — "I like keeping the green color for the recap page/etc. The gold would be just for the logging set tab and next to the logged set in a posted workout." Every other PR surface (the recap page's PR list via `prLabel()`, the feed/notification `.act-chip.act-pr` chip) stays green, untouched. This is a genuine exception to "gold = live status only" above, not a replacement of it — don't generalize it to other PR displays without asking Jeff first, same as the original rule. `#eab308` was picked from real rendered options (two rounds — the first round's white-text-legible golds all read as amber/brown; a true bright yellow only works with dark text, since it fails contrast against white) after Jeff said the first round wasn't yellow enough.
- **"No windows" airiness.** Near-white/near-black page background with borderless floating cards (soft shadow, no border) — except inside sheets, where cards keep a hairline (`.sheet .card`). No boxed-in header bars. Empty states render OPEN — icon, line, optional CTA (`homeEmpty`) — never inside a card box.
- **A card renders only when it has content** (v222, app-wide since v225). An empty section shows its open empty state, not an empty box.
- **The stat row never renders a zero.** Stats are drawn from a priority pool and simply not shown when they'd be 0 ("0 PRs this week" is demoralizing and useless). Jeff explicitly likes the "Last workout: Tuesday · Pull Day" line — keep it.
- **Discoverability beats minimalism.** Never hide an empty state; a new user must be able to find the feature. **Home briefly tried hiding empty sections entirely (v364, Sep 7) and it was reverted the same day** — Jeff, after living with it: "I understand there was a lot of nos but I think it looked better and left no guessing or questions by the user on where things would show or the ability within the app." "Your sessions" and "Friends' workouts" are always-visible headers again, each with its own empty state (the original `homeEmpty` box, or a quieter one-line variant when the Next up card already answered "what's next" — see the comments in `home()`). What DID survive from v364: the week strip and the single Next up card, genuinely additive rather than something they replaced. The "Training solo for now — invite a friend" line survived too, but narrower than at first: Jeff cut it (Sep 7) for any state where a Next up card is showing, since the card's own "Invite a friend" button already does that job — it now renders only when there's no card at all (nothing planned yet), the one state where nothing else on the page offers an invite. Friends' Activity moved off Home entirely to the Friends tab (Sep 7, Jeff) — it's not a "hide it" move, it lives at `friends()` now with its own always-visible "Activity" section, just relocated to the page that's already about friends.
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
  - Editing your own notes on the recap — the tap-in `#wkNotes` box in `viewPost` (Sep 6; it was an `editPostNotes` sheet before), gated on `isAuthor`.
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
