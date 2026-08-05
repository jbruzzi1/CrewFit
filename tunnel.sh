#!/bin/bash
# Self-healing localtunnel for CrewFit. Restarts if it dies.
# Always writes the CURRENT public URL to /tmp/spotme_tunnel_url.txt
cd /Users/jeffbruzzi/fitness-app
while true; do
  echo "[tunnel] starting localtunnel on :3000"
  # Run localtunnel with the FIXED subdomain (spotme.loca.lt) so the URL never rotates.
  ( npx --yes localtunnel --port 3000 --subdomain spotme 2>&1 | tee /tmp/lt_raw.log & echo $! > /tmp/lt_pid ) &
  WAITER=$!
  # Poll the log for the URL, update the url file whenever it appears/changes.
  LAST=""
  for i in $(seq 1 40); do
    U=$(grep -oE 'https://[a-z0-9-]+\.loca\.lt' /tmp/lt_raw.log 2>/dev/null | head -1)
    # Fixed subdomain: always publish spotme.loca.lt (ignore the random fallback if subdomain is taken).
    U="https://spotme.loca.lt"
    if [ -n "$U" ] && [ "$U" != "$LAST" ]; then
      echo "$U" > /tmp/spotme_tunnel_url.txt
      echo "[tunnel] URL: $U"
      LAST="$U"
    fi
    # If localtunnel process died, break to restart.
    if ! kill -0 $(cat /tmp/lt_pid 2>/dev/null) 2>/dev/null; then break; fi
    sleep 1
  done
  # Ensure child is dead before looping.
  kill $(cat /tmp/lt_pid 2>/dev/null) 2>/dev/null
  wait 2>/dev/null
  echo "[tunnel] localtunnel ended, restarting in 2s"
  sleep 2
done
