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

**The app will not start.** Almost always a damaged `data.json` — the server refuses to boot on
one rather than overwriting it (see the comment above `load()` in `server.js`). It keeps the last
10 copies on the volume, one taken before every start:
```
export PATH="$HOME/.fly/bin:$PATH"
fly ssh console --app spotmeapp
  ls -la /data/backups           # newest last
  cp /data/backups/data-<newest>.json /data/data.json
  exit
fly apps restart spotmeapp
```
This is tested — `npm test` asserts the restore actually brings the data back.

**Pull a copy of the live data to the Mac** (do this before anything risky):
```
fly ssh sftp get /data/data.json ./live-backup.json --app spotmeapp
```
That file holds every user's PIN in plaintext and this repo is public. It is in `.gitignore`
along with `*backup*.json`; do not move it or rename it out of those patterns.

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
- The volume `spotmeapp_data` is referenced in `fly.toml` (`[mounts]`). If you ever redeploy,
  the volume persists your data.json automatically.
- To push an update later: `fly deploy` again from this folder.
- Web Push (invite/join notifications) needs VAPID keys — the server auto-generates them on
  first run and stores them in /data (the volume), so they persist.

## If something errors
Paste the error back to me and I'll fix the config. Most common: region mismatch
(use `iad`) or volume name (must be `spotmeapp_data`).
