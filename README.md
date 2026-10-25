# Toastcord 2.0

**A clean rewrite of Toastcord**, built as a self-hostable Node.js app with a custom dark UI, persistent message history, private direct messages, member presence, and browser-based WebRTC voice/screen-sharing.

This version removes the old AppDeploy-specific SDK dependencies. It runs with Node.js alone and has no npm runtime dependencies.

## Included

- Registration and sign-in with salted `scrypt` password hashes, opaque session cookies, and a login-attempt limit.
- Persistent JSON storage with atomic file replacement for accounts, sessions, servers, memberships, channels, messages and DMs.
- Server creation, invite-code joining, channel creation, member list and online/voice presence.
- Text messages that survive refresh and process restarts, plus edit/delete for your own messages.
- Private one-to-one DMs restricted to people who share a server.
- Authenticated WebSocket realtime events for messages, presence and voice-state changes.
- WebRTC mesh voice, microphone mute, and screen-share renegotiation. STUN is configured by default.
- ToastLab with private local notes, bookmarks, slash commands, polls, export, quick replies, focus mode and diagnostics.
- Responsive desktop/mobile UI, Docker/Compose, health check, and GitHub Actions tests.

## Run locally

Requires Node.js 20 or newer. No `npm install` is necessary.

```bash
cp .env.example .env
npm start
```

Open `http://localhost:3000`. For production TLS, set `COOKIE_SECURE=true` when HTTPS terminates at the service or reverse proxy.

## Run with Docker

```bash
docker compose up -d --build
```

Compose mounts a persistent volume at `/data`; this matters because accounts and messages are stored there. Back up that volume. Do not use a disposable/ephemeral filesystem for production data.

## Environment variables

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port (default `3000`) |
| `HOST` | Bind address (default `0.0.0.0`) |
| `TOASTCORD_DATA_DIR` | Directory holding `toastcord.json` (default `./data`) |
| `COOKIE_SECURE` | Set `true` when browsers access the app over HTTPS |
| `TURN_URLS` | Optional comma-separated TURN URLs |
| `TURN_USERNAME` | TURN username |
| `TURN_CREDENTIAL` | TURN credential |

### Voice networking

Browser voice uses WebRTC and STUN by default. STUN alone cannot connect every pair of networks. For reliable cross-network voice and screen sharing, configure a trusted TURN provider using the three `TURN_*` variables. Treat TURN credentials as secrets, and prefer short-lived credentials where supported. Signalling being online does not guarantee media connectivity.

## Storage model and limitations

The built-in JSON store is practical for a small community and a single Node.js process. It writes updates atomically, but is not a distributed database and must not be shared between multiple app replicas. For a large public service, replace it with a real database and session store and add backups, moderation, abuse reporting, upload scanning and monitoring. File uploads/attachments are not implemented in this rewrite.

## Tests

```bash
npm run check
npm test
```

Integration tests cover auth, server/channel permissions, durable chat, editing, DMs and their privacy boundary, WebSocket voice join/leave, authenticated ICE configuration, and restart persistence.

## Security notes

- Passwords are stored as salted `scrypt` hashes, never plaintext.
- Session tokens are random, stored hashed, and sent in `HttpOnly; SameSite=Lax` cookies.
- API routes require a session except registration, login, health and `/api/me`.
- The WebSocket endpoint verifies the session cookie and same-origin browser requests.
- The built-in data file contains private data. Keep it out of public web roots and source control.
- Use HTTPS, secure cookies and backups before exposing the app publicly.
