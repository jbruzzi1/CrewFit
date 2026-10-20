# Deploying CrewFit

**Deploying is merging.** Push to `main` — or merge a pull request into it — and GitHub Actions
runs `npm test`, then deploys to Fly only if the tests pass, then checks the live app is really
serving before calling it done. No terminal, no `fly deploy` by hand.

Watch a run: **github.com/jbruzzi1/CrewFit → Actions**. Green tick = live.

## One-time setup

1. On the Mac, create a deploy token:
   ```
   export PATH="$HOME/.fly/bin:$PATH"
   fly tokens create deploy -x 8760h --app spotmeapp
   ```
2. Copy the whole output, including the `FlyV1 ` prefix.
3. On GitHub: **Settings → Secrets and variables → Actions → New repository secret**
   - Name: `FLY_API_TOKEN`
   - Value: the token
4. Push anything to `main` and watch the Actions tab.

Until that secret exists the deploy step skips itself with a warning rather than failing, so
adding the workflow first is safe.

## If a deploy goes wrong

**Bad code shipped.** Revert it and let the pipeline redeploy the previous version:
```
git revert --no-edit HEAD && git push origin main
```

**The app will not start.** Postgres being unreachable (wrong/missing `DATABASE_URL`, the
database paused or deleted) is now loud and fatal by design — the server refuses to boot rather
than silently serving an empty app (see the comment above `connFromEnv()` in `db.js`). Check the
logs first:
```
export PATH="$HOME/.fly/bin:$PATH"
fly logs --app spotmeapp
```
A line starting `FATAL during boot:` tells you what's actually wrong (connection refused, auth
failed, etc.) — that's almost always a Postgres/networking problem to fix (e.g. `fly postgres
attach` again if the secret got cleared), not a data problem.

**The live data itself looks wrong** (missing users, a workout disappeared) rather than the app
failing to start — restore the newest JSON snapshot. A fresh one is written before every boot, and
the last 10 are kept. **If `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`/`SUPABASE_STORAGE_BUCKET`
are NOT set (true until Phase 3 Slice 1c's env vars are set — check `fly secrets list`), it's
still on the volume, same as always:**
```
fly ssh console --app spotmeapp
  ls -la /data/backups           # newest last
  exit
fly ssh sftp get /data/backups/data-<newest>.json ./restore.json --app spotmeapp
DATABASE_URL="postgres://<user>:<password>@localhost:15432/<dbname>" node scripts/migrate-to-postgres.mjs ./restore.json
```
**Once those three env vars ARE set**, new backups land in the Supabase Storage bucket instead
(same bucket photos/avatars use, see Slice 1b/1c in `CLAUDE.md`) — pull the newest one from the
Supabase dashboard (Storage → that bucket → sort by name, newest `data-<timestamp>.json` last) or
the `supabase` CLI, save it locally as `restore.json`, then run the same
`migrate-to-postgres.mjs` command above against it. A backup written BEFORE those secrets were
set is still only on the volume — check there too if the newest Storage-side backup looks too
recent for what you're trying to recover from.

(Same tunnel-and-swap-host trick as step 4 above — `fly proxy 15432:5432 -a spotmeapp-db` in a
separate tab first.) This is tested — `npm test`'s `data-safety.mjs` asserts the restore actually
brings the data back, including a drill that simulates the live database being wiped first (that
test covers the unconfigured/volume path; see `test/phase3-backup-storage-slice1c.mjs` for what's
proven about the Storage-configured path against a stand-in server).

**Oct 20 2026: the Storage-configured path above was also drilled for real**, not just
stand-in-tested — a real backup was pulled from the live `FitnessApp-media` bucket, restored via
`migrate-to-postgres.mjs` into a scratch database, and verified against live data (full story in
CLAUDE.md). Worth knowing plainly: this JSON snapshot only ever covers `users`/`sessions`/
`templates`/`prs`/`crews` — it does not include crew messages/challenges, follows, notifications,
feed events, reports, push subs, or custom exercises, since those all live in their own
direct-Postgres tables this snapshot never touches. That's not a gap in this restore path, it's
what this specific backup was always built to cover — the full-coverage backup is the nightly
`pg_dump`→R2 pipeline above, which includes every table and was drilled first.

**Reset a password by hand** while self-service reset is off (see the comment above
`migratePasswords()` in `server.js`):
```
fly proxy 15432:5432 -a spotmeapp-db
```
In a second tab:
```
psql "postgres://<user>:<password>@localhost:15432/<dbname>" -c \
  "UPDATE users SET data = jsonb_set(data, '{pin}', to_jsonb('theNewPassword'::text)) WHERE username_lower = 'theirusername';"
fly apps restart spotmeapp
```
The next boot hashes that plaintext pin and erases it — it never survives past the restart.

**Pull a copy of the live data to the Mac** (do this before anything risky). Post-cutover this
means a Postgres dump, not `data.json` (which no longer updates) — same tunnel trick as above:
```
fly proxy 15432:5432 -a spotmeapp-db
```
In a second tab:
```
pg_dump "postgres://<user>:<password>@localhost:15432/<dbname>" > live-backup.sql
```
That file holds every user's PIN-derived hash and salt and this repo is public. Keep it out of
git the same way `data.json`/`*backup*.json` always were — do not commit it.

(Oct 12 2026: `pg_dump` refuses to run at all if it's OLDER than the server it's dumping from —
"aborting because of server version mismatch," no file written, not just a warning. spotmeapp-db
runs Postgres 18. If this command errors with that message, the Mac's own `pg_dump` needs
upgrading — `brew upgrade postgresql@18` or similar, then make sure that version is the one on
`$PATH`.)

## Off-platform backup (nightly, automatic)

(Oct 11 2026, deep-dive audit: "no real backup story" — the boot-time JSON snapshot and Fly's
own default volume snapshots are real and tested, but both live entirely on Fly's own
infrastructure. `.github/workflows/backup.yml` closes that gap: every night it dumps the real
database, encrypts it, and uploads it to Cloudflare R2 — a different company entirely, so a
Fly-level problem can't take out every copy at once.)

**One-time setup** (nothing in the workflow runs until every one of these exists as a GitHub
repo secret — **Settings → Secrets and variables → Actions**):

1. A Fly deploy token scoped to the *database* app only, not the main app (on purpose — this
   workflow has no reason to be able to touch `spotmeapp` itself):
   ```
   export PATH="$HOME/.fly/bin:$PATH"
   fly tokens create deploy -x 8760h --app spotmeapp-db
   ```
   Save the whole output (with the `FlyV1 ` prefix) as secret `FLY_BACKUP_TOKEN`.
2. The real database URL, with the host swapped for the local tunnel port the workflow opens —
   same connection string shape as step 4 of "Pull a copy of the live data" above:
   ```
   postgres://<user>:<password>@localhost:15432/<dbname>
   ```
   Save it as secret `BACKUP_DB_URL`.
3. A long random passphrase for encrypting the backups:
   ```
   openssl rand -base64 32
   ```
   Save it as secret `BACKUP_ENCRYPTION_KEY` — **and also write it down somewhere outside
   GitHub** (a password manager). Losing this makes every backup unreadable; it is not
   recoverable from anywhere else.
4. A Cloudflare R2 bucket (any name) and an API token scoped to only that bucket (Cloudflare
   dashboard → R2 → create bucket, then Manage API tokens → create one scoped to it). Save four
   secrets: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`.
5. On the bucket, set a lifecycle rule to auto-delete objects after ~30 days (R2 dashboard →
   that bucket → Settings → Object lifecycle rules) — this is the backup's retention policy;
   nothing in the workflow deletes old backups itself.

Until all seven secrets exist, every run of this workflow fails loudly (not a silent skip) — check
**Actions** after adding them to confirm a real run goes green. It can also be run on demand any
time from the **Actions** tab (`workflow_dispatch`), without waiting for its 9:21am UTC schedule.

**To restore from one of these** (the matching half — a backup nobody has restored from is a
theory, not a backup; the same `scripts/backup-db.sh` the nightly job uses does this too):
```
export PATH="$HOME/.fly/bin:$PATH"
fly proxy 15432:5432 -a spotmeapp-db   # separate terminal tab, leave running
```
```
aws s3 cp s3://<bucket>/crewfit-<timestamp>.dump.gpg ./backup.dump.gpg \
  --endpoint-url https://<account-id>.r2.cloudflarestorage.com
bash scripts/backup-db.sh restore ./backup.dump.gpg "<BACKUP_ENCRYPTION_KEY value>" \
  "postgres://<user>:<password>@localhost:15432/<dbname>"
```
This replaces whatever is currently in the database with the backup's contents — confirm you
actually want that before running it.

**Oct 19 2026 (Phase 3 Slice 3) — this restore path is now actually proven, not just documented.**
A real backup was downloaded, decrypted, and restored into a scratch Postgres 18 cluster (never
`spotmeapp-db` itself), and the row counts matched live production. Full story in CLAUDE.md's
Slice 3 section, but the one thing worth repeating here: the backups existing at the time (Oct
11–19) turned out to be **permanently undecryptable** because the saved copy of
`BACKUP_ENCRYPTION_KEY` had been lost — exactly the failure mode the "write it down somewhere
outside GitHub" warning above exists to prevent. A new key was generated and this time actually
saved before being set anywhere. If you're ever doing a real restore and the passphrase you have
doesn't decrypt the backup, that's the first thing to suspect — not a corrupted file.

## Deploying by hand (should not be needed)
```
export PATH="$HOME/.fly/bin:$PATH"; fly deploy --app spotmeapp
```

---

# First-time Fly setup (already done — kept for reference)

> Brand working-name is **CrewFit** (final name TBD). The deploy handle below is
> currently `spotmeapp` (claimed earlier) — keep it as-is unless you want a new name,
> in which case change both `fly.toml` and the `fly launch --name` below.

Everything is already configured (Dockerfile, fly.toml, package-lock.json, .dockerignore).
You just need to authenticate and run the deploy. This is a ONE-TIME setup.

## 1. Authenticate (opens a browser — click "Authorize")
```
fly auth login
```

## 2. Go into the project
```
cd /Users/jeffbruzzi/fitness-app
```

## 3. Create the app (uses the fly.toml already in the folder)
```
fly launch --no-deploy --copy-config --name spotmeapp --region iad
```
- If it asks to tweak settings, say no / accept defaults.
- It will detect the Dockerfile and use it.

## 4. Create the persistent volume (1 GB at /data — your data survives restarts)
```
fly volumes create spotmeapp_data --region iad --size 1 --app spotmeapp
```

## 5. Deploy
```
fly deploy
```
- When it finishes, it prints the URL, e.g. `spotmeapp.fly.dev`.

## 6. Open on your iPhone
- Safari → go to `https://spotmeapp.fly.dev`
- Share button → "Add to Home Screen" → name it CrewFit
- Do the same on Brian's phone.

## Notes
- The volume `spotmeapp_data` is referenced in `fly.toml` (`[mounts]`). Since the Postgres
  cutover, the live database itself lives in Postgres, not on this volume — the volume now holds
  uploaded photos/videos and the per-boot JSON snapshot backups used for recovery (see "If a
  deploy goes wrong" above).
- To push an update later: `fly deploy` again from this folder.
- Web Push (invite/join notifications) needs VAPID keys — the server auto-generates them on
  first run and stores them in /data (the volume), so they persist.

## If something errors
Paste the error back to me and I'll fix the config. Most common: region mismatch
(use `iad`) or volume name (must be `spotmeapp_data`).
