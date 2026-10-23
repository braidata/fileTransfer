# Braidata Connect · Vercel + Neon

Vercel Function: `/api/connect?action=...`. Neon database persists accounts, rooms, messages and snapshots. Serverless endpoints use HTTP polling, not persistent sockets.

Required Vercel env: `DATABASE_URL` (Neon connection string), `CONNECT_AUTH_SECRET` (random 32+ chars), `CONNECT_BOOTSTRAP_KEY` (temporary high-entropy bootstrap secret). The Neon integration is installed at team level but not attached to file-transfer as of initial implementation. No user is created until configured.

Bootstrap once: POST `?action=bootstrap` with `{email,password,bootstrapKey}` (password >=12 chars). Login: POST `?action=login` with `{email,password}`. Use `Authorization: Bearer TOKEN` for create, join, room, resume, snapshot, publish and events. Create `?action=create` `{title,name}`; join `?action=join` `{code,name}`; room GET `?action=room&code=...`; resume POST `?action=resume` `{code}` by original host; snapshot POST `?action=snapshot` `{code,state:{...}}`; publish POST `?action=publish` `{code,kind:'chat.message',data:{text:'Hello'}}`; poll GET `?action=events&code=...&since=0`.

The existing P2P playground is still separate and not yet wired to this persistent API. Account provisioning, rate limits, event retention, and production hardening are still required.
