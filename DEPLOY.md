# Braidata Connect — Vercel-only deployment

The Astro playground is a static site built and deployed on Vercel. Its rooms, chat, manual transforms, game events and initial voice preview use client-hosted PeerJS/WebRTC. It requires **no separate Node API hosting**.

## Test

1. Open the Vercel production site in two separate browser profiles.
2. Create a room in the first profile. Copy its six-character code.
3. Join in the second. Test chat and Publish transform and Emit game event.
4. Enable microphones on both to experiment with WebRTC. Browser permission is required.
5. Close the host: the room ends by design.

## Limits

PeerJS default signaling uses an external public PeerJS service. Thus **the only app deployment is Vercel**, but communication signaling is not 100% Vercel-operated. Restrictive NATs may require TURN; the default signaling is not a production SLA. No durable server-side authority, login, moderation, persistence, or guaranteed cross-network voice. Not safe for public production users.

The legacy Node prototype remains in /server for reference; it is not used by this Vercel-only playground. The earlier REST Postman collection applies to that local legacy server, **not** this P2P mode. Real P2P functionality is tested from browsers.
