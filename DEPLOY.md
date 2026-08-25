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

## ONE-TIME: moving the database from data.json to Postgres

*(Do this once, before merging the Postgres-backed code to `main`. Delete this section once it's
done — it won't be needed again. If you're reading this and it's still here, the cutover to
Postgres has not happened yet and the app is still running on the old file-based code.)*

**Why:** the app used to keep everything in one shared file (`data.json`) on the volume. It now
keeps everything in a real Postgres database instead — safer writes, no more "one giant file is
the whole database," and the exact incident described at the top of `test/data-safety.mjs` (a
copy of production silently going from 377 users to 0 on a single boot) becomes structurally
impossible. The app code, tests, and this migration tool are already built and fully verified —
`npm test` passes end-to-end, including a live simulated "restore after data loss" drill. This is
the one remaining step: moving the *real* live data over.

**Everything below is safe to do while the OLD code is still live and serving Jeff/Brian** — it
does not touch `data.json` or interrupt the running app. The new code only starts actually using
Postgres once you merge/push it in the last step.

### 1. Create the Postgres database
```
export PATH="$HOME/.fly/bin:$PATH"
fly postgres create --name spotmeapp-db --region iad --initial-cluster-size 1 --vm-size shared-cpu-1x --volume-size 10
```
If it asks anything interactively, accept the defaults — at this app's size (dozens of users) the
smallest option is more than enough. It'll take a minute or two.

### 2. Attach it to the app
```
fly postgres attach spotmeapp-db --app spotmeapp
```
This sets a `DATABASE_URL` secret on `spotmeapp` and restarts the currently-running machine —
completely safe, the OLD code that's live right now doesn't read that variable at all.

**Copy the `DATABASE_URL=postgres://...` line this prints — you'll need it in step 4.** (If you
lose it, `fly ssh console --app spotmeapp` then `echo $DATABASE_URL` will show it again once the
new code is deployed — but easiest to just save it now.)

### 3. Pull a fresh copy of the live data
```
fly ssh sftp get /data/data.json ./live-backup.json --app spotmeapp
```
Same command as the old "pull a copy before anything risky" step used to be. Do this right before
step 4 so it's as current as possible.

### 4. Run the migration
In one terminal tab, open a tunnel to the new database (leave this running):
```
fly proxy 15432:5432 -a spotmeapp-db
```
In a **second** terminal tab, from this project folder:
```
cd /Users/jeffbruzzi/fitness-app
```
Take the `DATABASE_URL` you copied in step 2 and swap only the host/port to
`localhost:15432` (keep the username, password, and database name exactly as printed — they're
after `postgres://` and before/after the `@`). Then:
```
DATABASE_URL="postgres://<user>:<password>@localhost:15432/<dbname>" node scripts/migrate-to-postgres.mjs ./live-backup.json
```
You should see something like:
```
Migrating ./live-backup.json -> postgres://***@localhost:15432/spotmeapp
  users=... sessions=... templates=... pushSubs=... customExercises=... prs=...
Migration verified: every collection's row counts AND content match on read-back.
```
**If it instead prints `FATAL: ... username collision(s) ...`**, stop — do not proceed to step 5.
Send me that output; it means two accounts differ only by capitalization (this has happened once
before, see `server.js`'s `migrateMergeDuplicateBrian`) and need a real decision about which
account is the one to keep before anything is written to Postgres. Nothing is written when this
happens — it's safe to leave the app exactly as it is while that gets sorted out.

If anything else goes wrong, the tool is safe to just re-run from scratch (it fully re-syncs
every table from the file each time) — nothing gets corrupted by trying again.

### 5. Deploy the new code
Push/merge the Postgres branch to `main` as usual — GitHub Actions runs `npm test`, then deploys
only if it passes.

### 6. Verify
```
curl -s https://spotmeapp.fly.dev/healthz
```
Should show `"ok":true` and a `users` count matching what step 4 printed.

### Rollback
If anything looks wrong after the deploy (wrong counts, app won't boot), the old file-based code
is one command away — `data.json` on the volume hasn't been touched by any of this:
```
git revert --no-edit HEAD && git push origin main
```
That puts the previous version back live, reading `/data/data.json` exactly as it always did.
Postgres just sits there unused; nothing about this rollback loses data either way.

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
failing to start — restore the newest JSON snapshot. A fresh one is written to the volume before
every boot, and the last 10 are kept:
```
fly ssh console --app spotmeapp
  ls -la /data/backups           # newest last
  exit
fly ssh sftp get /data/backups/data-<newest>.json ./restore.json --app spotmeapp
DATABASE_URL="postgres://<user>:<password>@localhost:15432/<dbname>" node scripts/migrate-to-postgres.mjs ./restore.json
```
(Same tunnel-and-swap-host trick as step 4 above — `fly proxy 15432:5432 -a spotmeapp-db` in a
separate tab first.) This is tested — `npm test`'s `data-safety.mjs` asserts the restore actually
brings the data back, including a drill that simulates the live database being wiped first.

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
  cutover (see "ONE-TIME" section above) the live database itself lives in Postgres, not on this
  volume — the volume now holds uploaded photos/videos and the per-boot JSON snapshot backups
  used for recovery (see "If a deploy goes wrong" above).
- To push an update later: `fly deploy` again from this folder.
- Web Push (invite/join notifications) needs VAPID keys — the server auto-generates them on
  first run and stores them in /data (the volume), so they persist.

## If something errors
Paste the error back to me and I'll fix the config. Most common: region mismatch
(use `iad`) or volume name (must be `spotmeapp_data`).
