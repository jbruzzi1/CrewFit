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

- Blue `--blue:#2563eb` is the brand color — CTAs and the active nav tab only. Green is the avatar accent, nothing more. No gradients on the header.
- **Discoverability beats minimalism.** Never hide an empty state; a new user must be able to find the feature.
- **But never state something about the user you can't stand behind.** v163 told Jeff "One session logged" on a lift he had not logged. Discoverable and wrong is worse than quiet. If a sentence claims something about their history, it has to be right every time.
- Light theme, white cards on warm off-white, elevated rounded cards with soft shadows (the v140 language), bottom nav.

## Do NOT "fix" these — already verified correct

- Decline-from-banner flow (no zombie invite).
- Profile "Your Workouts" excludes pending invites.
- Auth token key is `crewfit_token`, not `token`.
- `String(s.scheduledAt)` before `.slice` in `server.js`.
- The three-dots ⋯ menu renders only when `isCreator`.
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
