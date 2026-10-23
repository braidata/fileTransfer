# Braidata Connect

Rooms, identities, chat, shared events and snapshots for multiplayer experiences. There are two backends in this repo:

| Backend | Where | Status |
|---|---|---|
| **Connect Cloud**: `api/connect.js` → `lib/connect-core.js` | Vercel Function + Neon (Postgres) | The one in production (`braidataconnect.vercel.app`). Persistent, authenticated. Consumed by Experience Creator. |
| Legacy playground server: `server/connect.mjs` | Long-running Node process, in memory | Development preview only (SSE, no auth, no persistence). Not used by Experience Creator. |

## Connect Cloud API

One endpoint: `/api/connect?action=<action>`. JSON in and out. Errors are `{ "error": "CODE" }` with an HTTP status.

Auth: `Authorization: Bearer <JWT>` (HS256, 7 days). Hosts/admins get a user token from `login`; guests get a **room-scoped** token from `guest-join` (`{ room, role: 'guest' }`) that only works in that room.

| Action | Method | Who | Notes |
|---|---|---|---|
| `health` | GET | anyone | `{ ok, storage, service }` |
| `bootstrap` | POST | holder of `CONNECT_BOOTSTRAP_KEY` | creates the first admin once (409 afterwards) |
| `login` | POST | admin / host | `{ email, password }` → `{ token, email, role }`; guests cannot log in |
| `guest-join` | POST | anyone | `{ code, name }` → `{ code, name, role:'guest', userId, token }`; announces a member event |
| `me` | GET | token | `{ user: { id, email, role } }` |
| `admin-users`, `admin-create-user`, `admin-delete-user` | GET/POST | admin | user management. Hosts are provisioned by an admin (`admin-create-user {email,password}` → role `host`). Not for gameplay UIs. |
| `create` | POST | admin / host | `{ title, name }` → `{ code, title }` (code `^[A-F0-9]{8}$`) |
| `join` | POST | admin / host | joins a room as a member (guests use `guest-join`) |
| `room` | GET | member | `{ room, host, role, currentUser, players[{user_id,name,role,idle}] }` |
| `leave` | POST | member except owner | removes the membership; announces a member event |
| `resume` | POST | owner | bumps `epoch`, returns `{ code, epoch, snapshot }` (host recovery) |
| `snapshot` | POST | owner | `{ state: object }` ≤ 16000 chars |
| `kick` | POST | owner | `{ userId }`; the member is removed (its token stops working in the room); announces a member event |
| `publish` | POST | member | `{ kind, data: object }` ≤ 2000 chars. `kind` ∈ `chat.message` (`data.text` 1..500), `player.input` (any member), `game.event` (**owner only**). Rate limit: `CONNECT_RATE_LIMIT` (default 40) per member and room in 10 s → 429 |
| `events` | GET | member | `?code&since=<cursor>` → `{ events[{id,user_id,kind,data,created_at,sender_name}], next, epoch, owner, presence[{user_id,name,role,idle}] }`, at most 100 per call. Polling it marks the caller as seen; `idle` = seconds since a member last polled (`null` = never) |

Member events are `game.event` with `data = { type: 'connect.member', action: 'join'|'leave'|'kick', userId, name }`.

Events are stored as `body` (jsonb) and returned as `data`; clients should read `data` and fall back to `body` for old rows.

### Environment

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Neon connection string. Server-side only, never in a browser or an exported file. |
| `CONNECT_AUTH_SECRET` | yes | ≥ 32 chars, signs the JWTs. Rotating it signs everybody out. |
| `CONNECT_BOOTSTRAP_KEY` | for the first admin | Remove it after bootstrapping. |
| `CONNECT_ORIGINS` | no | Comma-separated CORS allowlist (`*` allows all). Default: `alterverse.art`, `www.alterverse.art`, `braidataconnect.vercel.app` and localhost dev ports. |
| `CONNECT_RATE_LIMIT` | no | Events per member and room per 10 s (min 5, default 40). |

### Local stack and tests

```bash
npm install
npm test                 # protocol tests: the real handler over HTTP on an in-process Postgres (PGlite)
npm run connect:local    # API on http://127.0.0.1:8788/api/connect + PeerJS server on ws://127.0.0.1:9000/peerjs
```

`scripts/connect-local.mjs` runs the same `lib/connect-core.js` as the Vercel Function, replacing Neon with PGlite and adding a PeerJS signaling server for WebRTC tests. `CONNECT_SEED_ADMIN=email:password` creates the admin at start.

### Realtime (voice / movement)

Connect Cloud is HTTP: chat, events and snapshots are persisted and **polled**. It is not a transport for high-frequency movement. Clients use WebRTC (PeerJS) peer links for movement and voice, announcing their peer id through `player.input` (`{ type: 'voice.presence', peerId }` in this playground). Without a TURN server, peers behind restrictive NATs or firewalls may not connect; there is no TURN in this repo.

### Known limits

- No self-registration: an admin provisions host accounts.
- A kicked guest loses its membership and token scope, but can join again as a new guest with the room code.
- Polling latency (the playground uses 3 s) applies to chat and events.

## Legacy playground server

`cd server && npm start` runs `server/connect.mjs` on `:8787` (in-memory rooms, SSE events, `x-connect-token`). It is a development preview without auth, persistence or rate limits; keep it off untrusted networks.
