# Deploy Braidata Connect

The Astro playground on Vercel is **only a frontend**. The Connect backend needs a persistent Node.js service, not a Vercel Serverless Function.

## Persistent backend (Railway)

1. Connect the GitHub repository `braidata/fileTransfer` to Railway.
2. Select branch `main` and deploy using `railway.json` (Node 20+).
3. Expose an HTTPS public domain; `/health` must respond with `{ "ok": true }`.
4. Set `CONNECT_ORIGIN=https://file-transfer-one-ashen.vercel.app` for browser API calls. For multiple frontend domains, extend CORS deliberately before production.
5. In Vercel project `file-transfer` set `PUBLIC_CONNECT_API_URL=https://<your-railway-domain>` and redeploy `main`.
6. In the playground open two browsers, create/join a room, test chat and player events.

These settings do not deploy themselves. WebRTC microphone connections additionally need HTTPS, permission, and TURN infrastructure for restrictive networks.

## Postman

Set `baseUrl` to the backend domain and test `GET /health`, `POST /api/rooms`, `POST /api/rooms/:code/join` and authenticated actions. The frontend cannot function against `localhost` unless you run the backend locally.

## Security limitations

The server is a development MVP: in-memory sessions, no durable storage, simplistic game event authorization, token query params for EventSource, no rate limiting, no production TURN, no spatial audio. Do not use with untrusted public users until these are addressed.
