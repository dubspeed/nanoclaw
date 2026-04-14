#!/usr/bin/env bash
# Create a Matrix room and register it with NanoClaw — all in one step.
#
# Creates the room WITHOUT encryption, invites the bot, registers in DB,
# creates the group folder, and restarts NanoClaw.
#
# Usage:
#   ./scripts/register-matrix-room.sh <room_name>
#   ./scripts/register-matrix-room.sh <room_name> --register-only  # skip room creation, just register existing room
#
# Examples:
#   ./scripts/register-matrix-room.sh trp
#   ./scripts/register-matrix-room.sh finances --register-only

set -euo pipefail
cd "$(dirname "$0")/.."

ROOM_NAME="${1:-}"
REGISTER_ONLY=false

if [ "${2:-}" = "--register-only" ]; then
  REGISTER_ONLY=true
fi

if [ -z "$ROOM_NAME" ]; then
  echo "Usage: $0 <room_name> [--register-only]"
  echo ""
  echo "Creates a Matrix room (no encryption), invites the bot, registers it,"
  echo "and restarts NanoClaw."
  echo ""
  echo "  --register-only   Skip room creation, register an existing room by name"
  exit 1
fi

# Load env
set -a
source .env 2>/dev/null || true
set +a

HOMESERVER="${MATRIX_HOMESERVER_URL:-http://localhost:6167}"
BOT_TOKEN="${MATRIX_ACCESS_TOKEN:-}"
ADMIN_TOKEN="${MATRIX_ADMIN_TOKEN:-}"
FOLDER="matrix_$(echo "$ROOM_NAME" | tr '[:upper:]' '[:lower:]')"
TRIGGER="${TRIGGER_PATTERN:-@Dub}"

if [ -z "$BOT_TOKEN" ]; then
  echo "ERROR: MATRIX_ACCESS_TOKEN not set in .env"
  exit 1
fi

if [ "$REGISTER_ONLY" = false ] && [ -z "$ADMIN_TOKEN" ]; then
  echo "ERROR: MATRIX_ADMIN_TOKEN not set in .env (needed to create rooms)"
  echo "Add it: echo 'MATRIX_ADMIN_TOKEN=your_token' >> .env"
  exit 1
fi

# Get bot user ID
BOT_USER=$(curl -sf -H "Authorization: Bearer $BOT_TOKEN" \
  "$HOMESERVER/_matrix/client/v3/account/whoami" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['user_id'])")

echo "Bot: $BOT_USER"

# Helper: look up room by name from bot's joined rooms
find_room_by_name() {
  local target_name="$1"
  local rooms
  rooms=$(curl -sf -H "Authorization: Bearer $BOT_TOKEN" \
    "$HOMESERVER/_matrix/client/v3/joined_rooms" \
    | python3 -c "import sys,json;[print(r) for r in json.load(sys.stdin)['joined_rooms']]")

  for rid in $rooms; do
    local name
    name=$(curl -sf -H "Authorization: Bearer $BOT_TOKEN" \
      "$HOMESERVER/_matrix/client/v3/rooms/$rid/state/m.room.name" 2>/dev/null \
      | python3 -c "import sys,json;print(json.load(sys.stdin).get('name',''))" 2>/dev/null || true)
    if [ "$name" = "$target_name" ]; then
      echo "$rid"
      return 0
    fi
  done
  return 1
}

if [ "$REGISTER_ONLY" = true ]; then
  # --- Register-only mode: find existing room ---
  echo "Looking up room '$ROOM_NAME' from bot's joined rooms..."
  ROOM_ID=$(find_room_by_name "$ROOM_NAME") || true

  if [ -z "$ROOM_ID" ]; then
    echo "ERROR: No joined room named '$ROOM_NAME' found."
    exit 1
  fi
  echo "Found: $ROOM_ID"
else
  # --- Create new room (no encryption) ---
  echo "Creating room '$ROOM_NAME' (no encryption)..."

  CREATE_TOKEN="${ADMIN_TOKEN:-$BOT_TOKEN}"

  # Create room without invite (avoids 403 on some servers), then invite + join separately
  PAYLOAD=$(python3 -c "
import json
print(json.dumps({
    'name': '$ROOM_NAME',
    'preset': 'trusted_private_chat',
    'creation_content': {'m.federate': False},
    'power_level_content_override': {
        'users': {'$BOT_USER': 50}
    }
}))
")

  RESPONSE=$(curl -sf -X POST \
    -H "Authorization: Bearer $CREATE_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" \
    "$HOMESERVER/_matrix/client/v3/createRoom")

  ROOM_ID=$(echo "$RESPONSE" | python3 -c "import sys,json;print(json.load(sys.stdin)['room_id'])")

  if [ -z "$ROOM_ID" ]; then
    echo "ERROR: Failed to create room"
    echo "$RESPONSE"
    exit 1
  fi

  echo "Created: $ROOM_ID"

  # Invite bot to the room
  echo "Inviting bot..."
  curl -sf -X POST \
    -H "Authorization: Bearer $CREATE_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"user_id\":\"$BOT_USER\"}" \
    "$HOMESERVER/_matrix/client/v3/rooms/$ROOM_ID/invite" > /dev/null

  # Bot accepts invite
  echo "Bot joining room..."
  curl -sf -X POST \
    -H "Authorization: Bearer $BOT_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{}' \
    "$HOMESERVER/_matrix/client/v3/join/$ROOM_ID" > /dev/null
  echo "Bot joined"
fi

JID="mx:$ROOM_ID"

# Check if already registered
EXISTING=$(sqlite3 store/messages.db "SELECT jid FROM registered_groups WHERE jid='$JID';" 2>/dev/null || true)
if [ -n "$EXISTING" ]; then
  echo "Room '$ROOM_NAME' ($JID) is already registered in NanoClaw."
  exit 0
fi

# Register in DB
SAFE_NAME=$(python3 -c "import json;print(json.dumps('$ROOM_NAME'))")
node --input-type=commonjs -e "
const { initDatabase, setRegisteredGroup } = require('./dist/db.js');
initDatabase();
setRegisteredGroup('$JID', {
  name: $SAFE_NAME,
  folder: '$FOLDER',
  trigger: '$TRIGGER',
  added_at: new Date().toISOString(),
  requiresTrigger: false,
  isMain: false,
});
"
echo "Registered in database"

# Create group folder
mkdir -p "groups/$FOLDER/logs"
echo "Created groups/$FOLDER/"

# Restart NanoClaw
echo "Restarting NanoClaw..."
launchctl kickstart -k "gui/$(id -u)/com.nanoclaw" 2>/dev/null && echo "NanoClaw restarted" || echo "WARN: Could not restart NanoClaw — restart manually"

echo ""
echo "Done! Room '$ROOM_NAME' ready."
echo "  Room ID: $ROOM_ID"
echo "  JID:     $JID"
echo "  Folder:  groups/$FOLDER/"
echo "  Trigger: none (responds to all messages)"
