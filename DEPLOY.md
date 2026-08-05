# Deploy CrewFit to Fly.io (run on your Mac, in Terminal)

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
