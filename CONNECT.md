# Braidata Connect (dev-braidata-connect)

A reusable real-time connectivity backend and API playground built on the existing `braidata/fileTransfer` repository.

## Start

Requires Node.js 20+.

```bash
cd server && npm start
# separate terminal, repository root:
npm install && npm run dev
```

Open the Astro development URL in **two browsers or tabs**. Set API endpoint to `http://localhost:8787`. Create a room in tab A, copy its code, and join in tab B. Send chat messages, publish player transforms, and inspect events. Microphone requires browser permission and secure context (localhost works). Enable microphone on both tabs for WebRTC preview.

## API
- `GET /health`
- `POST /api/rooms` — name, title, maxPlayers
- `POST /api/rooms/:code/join` — name
- `GET /api/rooms/:code` — public presence snapshot
- `GET /api/rooms/:code/events?token=TOKEN` — SSE
- `POST /api/rooms/:code/message` — text
- `POST /api/rooms/:code/state` — x, y, z, ry, ready
- `POST /api/rooms/:code/peer` — peerId
- `POST /api/rooms/:code/game-event` — kind, data
- `POST /api/rooms/:code/leave`

POST actions after join require the `x-connect-token` header; except create/join. The schema example is in `examples/connect.coop.json` and is **proposed**, not implemented as an import feature.

## MVP status and limits
Implemented: in-memory rooms (up to 8), presence, lobby, chat, event stream, manual player transforms, generic game events, PeerJS voice preview.

Not implemented: authoritative simulation, automatic high-frequency position transport, spatial attenuation, push-to-talk, dedicated TURN configuration, persistent sessions, authentication, participant moderation, rate limits, and production multi-instance deployment. Existing Experience Creator Participate integration has **not** been changed.

**Security:** This is a development playground, not production-ready. Tokens in SSE query parameters may be logged by infrastructure. API origin is unrestricted by default, with `CONNECT_ORIGIN` configurable. An external authentication layer, origin validation, event authorization, per-participant rate limits, and dedicated TURN servers are required before deployment to untrusted users.

Keep `master` unchanged until tested. The frontend is an Astro/React development console; the standalone backend must run as a persistent Node process, not a stateless serverless function.
