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
  cutover, the live database itself lives in Postgres, not on this volume — the volume now holds
  uploaded photos/videos and the per-boot JSON snapshot backups used for recovery (see "If a
  deploy goes wrong" above).
- To push an update later: `fly deploy` again from this folder.
- Web Push (invite/join notifications) needs VAPID keys — the server auto-generates them on
  first run and stores them in /data (the volume), so they persist.

## If something errors
Paste the error back to me and I'll fix the config. Most common: region mismatch
(use `iad`) or volume name (must be `spotmeapp_data`).
