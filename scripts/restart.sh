#!/usr/bin/env bash
# Restart NanoClaw, optionally waiting for the Matrix homeserver first.
# Usage: ./scripts/restart.sh

set -euo pipefail
cd "$(dirname "$0")/.."

# Load env for MATRIX_HOMESERVER
set -a
source .env 2>/dev/null || true
set +a

NANOCLAW_LABEL="com.nanoclaw"
HOMESERVER="${MATRIX_HOMESERVER_URL:-http://localhost:6167}"
HEALTH_URL="${HOMESERVER}/_matrix/client/versions"
MAX_WAIT=30

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }

# --- 1. Stop NanoClaw ---
log "Stopping NanoClaw..."
launchctl unload ~/Library/LaunchAgents/${NANOCLAW_LABEL}.plist 2>/dev/null || true
sleep 1

# --- 2. Wait for Matrix homeserver to be reachable ---
log "Waiting for Matrix homeserver ($HOMESERVER)..."
elapsed=0
while ! curl -sf --connect-timeout 2 "$HEALTH_URL" >/dev/null 2>&1; do
  sleep 1
  elapsed=$((elapsed + 1))
  if [ "$elapsed" -ge "$MAX_WAIT" ]; then
    log "WARN: Matrix homeserver not reachable after ${MAX_WAIT}s — starting NanoClaw anyway"
    break
  fi
done
if [ "$elapsed" -lt "$MAX_WAIT" ]; then
  log "Matrix homeserver reachable (${elapsed}s)"
fi

# --- 3. Start NanoClaw ---
log "Starting NanoClaw..."
launchctl load ~/Library/LaunchAgents/${NANOCLAW_LABEL}.plist

# --- 4. Verify NanoClaw is running ---
sleep 3
if launchctl list | grep -q "$NANOCLAW_LABEL"; then
  log "NanoClaw running (PID $(launchctl list | awk "/$NANOCLAW_LABEL/"'{print $1}'))"
else
  log "ERROR: NanoClaw failed to start"
  exit 1
fi

log "Done."
