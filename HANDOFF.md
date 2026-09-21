# SpotMe (CrewFit) — Engineer Handoff

Social/collaborative fitness PWA. Founders: Jeff + Brian (non-technical). Claude builds, renders, and verifies; Jeff validates on iPhone 16 Pro, portrait, and is the only one who approves a deploy.

> **This file is a short technical orientation, not the source of truth.** `CLAUDE.md` (short,
> auto-loaded every session) has the rules that must never be missed. `CLAUDE_HANDOFF.md` has the
> full context — stack detail, data model, correction history, and why each rule exists — and is
> kept current; this file is not. When the two disagree, `CLAUDE_HANDOFF.md` is right.
> (Sep 21 2026: this file used to describe an old JSON-file/light-theme-only version of the app,
> stalled around v145 while the real app had moved well past v400 — corrected below, but treat any
> future drift the same way: fix it here, or just delete this file and read `CLAUDE_HANDOFF.md`
> directly, rather than trusting a stale summary.)

## Stack
- Node `server.js` (Express, in-memory `DB` persisted to **Postgres** via `save(DB)` — see
  `CLAUDE_HANDOFF.md` §2.5). No ORM.
- Frontend: `public/app.js` + `public/index.html` (vanilla, **no build step**). `app.js` is loaded
  with a cache-busting `?v=` query — bump it on any frontend change.
- Two themes, **dark by default** (Settings → Appearance toggles it); see CLAUDE.md's design
  constants for the palette rules.
- Media: files go to the persistent `/data` volume → served as `/uploads/...`.
- Deploy: **Fly**, app `spotmeapp`. `export PATH="$HOME/.fly/bin:$PATH"; fly deploy --app spotmeapp`
  — only with Jeff's explicit go (hard rule #1 in CLAUDE.md).
- Repo: `github.com/jbruzzi1/CrewFit`, branch `main`. **Never delete `.hermes/hermes-agent/`.**

## Where to actually look
- **Rules that must never be missed:** `CLAUDE.md`.
- **Full stack detail, data model, correction history, known-correct areas, engine rules
  (progression/PRs/units), render/verify harness, open work:** `CLAUDE_HANDOFF.md`.
- **Deploy runbook:** `DEPLOY.md`.

This file intentionally does not duplicate a changelog, an invite/session data-model writeup, or
an open-questions list — `CLAUDE_HANDOFF.md` already carries those and keeping the same content
in two places is how this file went stale the first time.

## Commands cheat-sheet
- Tests: `npm test` (run before and after anything touching progression, PRs, units, or the log sheet)
- Syntax check: `node --check public/app.js && node --check server.js`
- Local preview: `PORT=4700 node server.js` → http://localhost:4700
- Deploy: `export PATH="$HOME/.fly/bin:$PATH"; fly deploy --app spotmeapp`
