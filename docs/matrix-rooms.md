# Matrix Rooms Quick Reference

## Create a new room

```bash
# 1. Create the room (bot creates it, invites you)
BOT_TOKEN="zFt0EhTd19569ph4jG8kWQq3AZ5Gmfbb"

curl -s -X POST "http://localhost:6167/_matrix/client/v3/createRoom" \
  -H "Authorization: Bearer $BOT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "ROOM_NAME",
    "preset": "private_chat",
    "invite": ["@michael:localhost"],
    "creation_content": {"m.federate": false}
  }'
```

Copy the `room_id` from the response (e.g., `!abc123:localhost`).

```bash
# 2. Register with NanoClaw
npx tsx setup/index.ts --step register -- \
  --jid "mx:ROOM_ID" \
  --name "ROOM_NAME" \
  --folder "matrix_FOLDER_NAME" \
  --trigger "@Dub" \
  --channel matrix

# 3. Restart
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Options

| Flag | Effect |
|------|--------|
| `--no-trigger-required` | Respond to all messages (default for Matrix) |
| `--trigger-required` | Only respond to `@Dub` mentions |
| `--is-main` | Make this the main control room |

## Create a new bot user

```bash
# Send admin command (as michael)
ADMIN_TOKEN="RI2khYlkDIo0VMNqbdZ527cewHcSSifk"
ADMIN_ROOM="!kKsGYGghl0HE8L0Xzc:localhost"

curl -s -X PUT "http://localhost:6167/_matrix/client/v3/rooms/$ADMIN_ROOM/send/m.room.message/$(date +%s)" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"msgtype": "m.text", "body": "!admin users create-user USERNAME PASSWORD"}'

# Get access token for the new user
curl -s -X POST http://localhost:6167/_matrix/client/v3/login \
  -H 'Content-Type: application/json' \
  -d '{"type":"m.login.password","identifier":{"type":"m.id.user","user":"USERNAME"},"password":"PASSWORD"}'
```

## Homeserver management

```bash
# Start
docker compose -f docker-compose.matrix.yml up -d

# Stop
docker compose -f docker-compose.matrix.yml down

# Logs
docker compose -f docker-compose.matrix.yml logs -f

# Status
curl -s http://localhost:6167/_matrix/client/versions | head -1
```

## Credentials

| What | Value |
|------|-------|
| Homeserver | `http://localhost:6167` |
| Bot user | `@dub:localhost` |
| Admin user | `@michael:localhost` |
| Client | Element Desktop → homeserver `http://localhost:6167` |
