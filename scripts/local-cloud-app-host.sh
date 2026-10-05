#!/usr/bin/env bash
# Run the Cloud App Host (apps.papr.ai) locally against production memory.papr.ai,
# so host changes can be tested without a Cloud Run deploy.
#
#   scripts/local-cloud-app-host.sh start    # start on :8787 (logs: .local-host/host.log)
#   scripts/local-cloud-app-host.sh stop
#   scripts/local-cloud-app-host.sh status
#   scripts/local-cloud-app-host.sh use      # point Paprwork at it (edits .env.local; restart Paprwork)
#   scripts/local-cloud-app-host.sh unuse    # point Paprwork back at apps.papr.ai (restart Paprwork)
#
# Notes:
# - Uses PAPR_CLOUD_APP_HOST_KEY from .env.local (same key as production).
# - The shared GCS cache is OFF locally (no CLOUD_APP_HOST_GCS_BUCKET), so the local host
#   never writes into production's cache. Set LOCAL_HOST_GCS_BUCKET to test with a scratch bucket.
# - Code changes need a restart (stop + start); no build step, it runs the TS source via tsx.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${LOCAL_HOST_PORT:-8787}"
DIR=.local-host
PIDFILE="$DIR/host.pid"
mkdir -p "$DIR"

running() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }

case "${1:-status}" in
  start)
    if running; then echo "already running (pid $(cat "$PIDFILE")) on :$PORT"; exit 0; fi
    env -u CLOUD_APP_HOST_GCS_BUCKET \
      ${LOCAL_HOST_GCS_BUCKET:+CLOUD_APP_HOST_GCS_BUCKET=$LOCAL_HOST_GCS_BUCKET} \
      PORT="$PORT" \
      PAPR_MEMORY_SERVER_URL="${PAPR_MEMORY_SERVER_URL:-https://memory.papr.ai}" \
      PAPR_CLOUD_APP_PUBLIC_URL="http://localhost:$PORT" \
      AUTH0_DOMAIN=papr.auth0.com \
      AUTH0_CLIENT_ID=asVGkVRkRAxYvtQadqivntIRjB4D1Iur \
      PAPR_TURSO_REPLICA_SYNC=replica-records \
      CLOUD_APP_HOST_MEMORY_TIMEOUT_MS=90000 \
      nohup node --import tsx src/gateway/cloud-app-host.ts >"$DIR/host.log" 2>&1 &
    echo $! >"$PIDFILE"
    for _ in $(seq 1 30); do
      curl -sf "localhost:$PORT/health" >/dev/null 2>&1 && { echo "up on http://localhost:$PORT (pid $(cat "$PIDFILE"))"; exit 0; }
      sleep 0.5
    done
    echo "did not come up — see $DIR/host.log"; tail -20 "$DIR/host.log"; exit 1 ;;
  stop)
    if running; then kill "$(cat "$PIDFILE")"; rm -f "$PIDFILE"; echo stopped; else echo "not running"; fi ;;
  status)
    if running; then echo "running (pid $(cat "$PIDFILE")) on :$PORT"; curl -s "localhost:$PORT/health"; echo; else echo "not running"; fi
    grep -E "^PAPR_CLOUD_APPS_HOST=" .env.local 2>/dev/null || echo "Paprwork uses https://apps.papr.ai" ;;
  use)
    grep -v -E "^PAPR_CLOUD_APPS_HOST=" .env.local >"$DIR/env.tmp" || true
    echo "PAPR_CLOUD_APPS_HOST=http://localhost:$PORT" >>"$DIR/env.tmp"
    mv "$DIR/env.tmp" .env.local
    echo "Paprwork will use http://localhost:$PORT after a restart" ;;
  unuse)
    grep -v -E "^PAPR_CLOUD_APPS_HOST=" .env.local >"$DIR/env.tmp" || true
    mv "$DIR/env.tmp" .env.local
    echo "Paprwork will use https://apps.papr.ai after a restart" ;;
  *) echo "usage: $0 start|stop|status|use|unuse"; exit 2 ;;
esac
