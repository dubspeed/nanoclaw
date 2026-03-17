---
name: add-matrix
description: Add Matrix as a channel with self-hosted conduwuit homeserver. Each agent gets its own Matrix user identity. No phone number required.
---

# Add Matrix Channel

This skill adds Matrix support to NanoClaw with a self-hosted conduwuit homeserver. Each agent can have its own Matrix user with distinct name and avatar.

## Phase 1: Pre-flight

### Check if already applied

Check if `src/channels/matrix.ts` exists. If it does, skip to Phase 3 (Setup). The code changes are already in place.

### Check dependencies

```bash
npm ls matrix-bot-sdk 2>/dev/null
```

If missing, install:

```bash
npm install matrix-bot-sdk
npm run build
```

### Check existing homeserver

AskUserQuestion: Do you already have a Matrix homeserver running, or should I help you set one up with conduwuit (lightweight Rust server)?

## Phase 2: Homeserver Setup (if needed)

### Create Docker Compose for conduwuit

Create `docker-compose.matrix.yml` in the project root (or wherever the user prefers):

```yaml
services:
  conduwuit:
    image: girlbossceo/conduwuit:latest
    restart: unless-stopped
    ports:
      - "6167:6167"
    volumes:
      - conduwuit-db:/var/lib/conduwuit
    environment:
      CONDUWUIT_SERVER_NAME: localhost
      CONDUWUIT_DATABASE_PATH: /var/lib/conduwuit
      CONDUWUIT_PORT: 6167
      CONDUWUIT_ALLOW_REGISTRATION: "true"
      CONDUWUIT_ALLOW_FEDERATION: "false"
      CONDUWUIT_MAX_REQUEST_SIZE: 20000000
      CONDUWUIT_TRUSTED_SERVERS: '["matrix.org"]'
volumes:
  conduwuit-db:
```

**Note:** `CONDUWUIT_SERVER_NAME` should match the domain users will use. For local-only use, `localhost` works. For remote access, use a real domain.

Start the homeserver:

```bash
docker compose -f docker-compose.matrix.yml up -d
```

Verify it's running:

```bash
curl -s http://localhost:6167/_matrix/client/versions | head -1
```

### Create bot user(s)

Register the main bot user:

```bash
# Register bot user (registration must be enabled)
curl -s -X POST http://localhost:6167/_matrix/client/v3/register \
  -H 'Content-Type: application/json' \
  -d '{
    "username": "andy",
    "password": "GENERATE_A_STRONG_PASSWORD",
    "auth": {"type": "m.login.dummy"}
  }'
```

If the user wants multiple agent identities, register additional users:

```bash
curl -s -X POST http://localhost:6167/_matrix/client/v3/register \
  -H 'Content-Type: application/json' \
  -d '{
    "username": "agent-research",
    "password": "GENERATE_A_STRONG_PASSWORD",
    "auth": {"type": "m.login.dummy"}
  }'
```

### Get access token

Login to get the access token:

```bash
curl -s -X POST http://localhost:6167/_matrix/client/v3/login \
  -H 'Content-Type: application/json' \
  -d '{
    "type": "m.login.password",
    "identifier": {"type": "m.id.user", "user": "andy"},
    "password": "THE_PASSWORD_FROM_ABOVE"
  }'
```

Save the `access_token` from the response.

### Disable open registration

After creating all bot users, disable registration:

In `docker-compose.matrix.yml`, change:
```yaml
CONDUWUIT_ALLOW_REGISTRATION: "false"
```

Then restart:
```bash
docker compose -f docker-compose.matrix.yml restart
```

### Set bot display name (optional)

```bash
curl -s -X PUT "http://localhost:6167/_matrix/client/v3/profile/@andy:localhost/displayname" \
  -H "Authorization: Bearer ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"displayname": "Andy"}'
```

## Phase 3: Configure Environment

### Add credentials to .env

```bash
MATRIX_HOMESERVER_URL=http://localhost:6167
MATRIX_ACCESS_TOKEN=syt_...
```

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 4: Create Room and Register

### Create a room

Using Element (or curl):

```bash
# Create a room
curl -s -X POST "http://localhost:6167/_matrix/client/v3/createRoom" \
  -H "Authorization: Bearer ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Main",
    "topic": "NanoClaw main control room",
    "preset": "private_chat",
    "creation_content": {"m.federate": false}
  }'
```

The response contains `room_id` (e.g., `!abc123:localhost`).

### Invite your human user to the room

If using Element with a different account:

```bash
curl -s -X POST "http://localhost:6167/_matrix/client/v3/rooms/ROOM_ID/invite" \
  -H "Authorization: Bearer ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"user_id": "@your_username:localhost"}'
```

### Register the room with NanoClaw

For a main room (responds to all messages):

```bash
npx tsx setup/index.ts --step register -- --jid "mx:ROOM_ID" --name "Main" --folder "matrix_main" --trigger "@Andy" --channel matrix --no-trigger-required --is-main
```

For additional rooms (trigger-only):

```bash
npx tsx setup/index.ts --step register -- --jid "mx:ROOM_ID" --name "Room Name" --folder "matrix_room-name" --trigger "@Andy" --channel matrix
```

**Note:** The JID format is `mx:` followed by the Matrix room ID (e.g., `mx:!abc123:localhost`).

## Phase 5: Verify

### Connect a client

Tell the user:

> Install Element (app.element.io or desktop app) and connect to your homeserver:
>
> 1. Open Element
> 2. Click "Sign In"
> 3. Change homeserver to `http://localhost:6167`
> 4. Sign in with your human account
> 5. Accept the room invite from the bot
> 6. Send a message — the bot should respond

### Check logs if needed

```bash
tail -f logs/nanoclaw.log | grep -i matrix
```

## Troubleshooting

### Bot not responding

1. Check `MATRIX_HOMESERVER_URL` and `MATRIX_ACCESS_TOKEN` are set in `.env` AND synced to `data/env/env`
2. Verify homeserver is running: `curl -s http://localhost:6167/_matrix/client/versions`
3. Check room is registered: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'mx:%'"`
4. Check token is valid: `curl -s -H "Authorization: Bearer TOKEN" http://localhost:6167/_matrix/client/v3/account/whoami`
5. Service is running: `launchctl list | grep nanoclaw` (macOS) or `systemctl --user status nanoclaw` (Linux)

### Bot can't join rooms

Make sure the bot user is invited to the room. The channel uses `AutojoinRoomsMixin` to auto-accept invites, but the bot must be invited first.

### Element can't connect to localhost

If Element Web (browser) blocks localhost:
- Use Element Desktop instead
- Or set up a reverse proxy with a real domain + HTTPS

### Homeserver uses too much memory

conduwuit typically uses 50-200 MB. If memory is high:
- Check `docker stats`
- The RocksDB database grows over time; compact it

## After Setup

The Matrix channel supports:
- Text messages in registered rooms
- Typing indicators while the agent processes
- Auto-join on room invite
- Room name sync to NanoClaw database
- Message queuing during disconnections
- Long message splitting (>4000 chars)

### Multi-agent Identity

Each agent can be a separate Matrix user. To set up additional agents:

1. Register new users on the homeserver (Phase 2)
2. Get access tokens for each
3. Configure each group with its own bot token (future: per-group MATRIX_ACCESS_TOKEN)
4. Each bot appears as a distinct user in the room with its own name/avatar

## Removal

To remove Matrix integration:

1. Delete `src/channels/matrix.ts` and `src/channels/matrix.test.ts`
2. Remove `import './matrix.js'` from `src/channels/index.ts`
3. Remove `MATRIX_HOMESERVER_URL` and `MATRIX_ACCESS_TOKEN` from `.env`
4. Remove Matrix registrations: `sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE 'mx:%'"`
5. Uninstall: `npm uninstall matrix-bot-sdk`
6. Rebuild: `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `npm run build && systemctl --user restart nanoclaw` (Linux)
7. Optionally stop the homeserver: `docker compose -f docker-compose.matrix.yml down`
