// Braidata Connect — protocol core, independent of the database driver and of the HTTP host.
// api/connect.js binds it to Neon on Vercel; scripts/connect-local.mjs binds it to an in-process Postgres (PGlite)
// for development and automated tests. Same handler, same SQL, same responses.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';

/** Browser origins allowed when CONNECT_ORIGINS is not set (Experience Creator and local development). */
export const DEFAULT_ORIGINS = [
  'https://alterverse.art',
  'https://www.alterverse.art',
  'https://braidataconnect.vercel.app',
  'http://localhost:4321',
  'http://localhost:5173',
  'http://localhost:4173',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:4173',
];

/** Event kinds a client may publish. game.event is authoritative: only the room host publishes it. */
export const EVENT_KINDS = ['chat.message', 'player.input', 'game.event'];

const id = () => randomBytes(12).toString('hex');
const mkhash = (p) => {
  const salt = id();
  return salt + ':' + scryptSync(p, salt, 64).toString('hex');
};
const check = (p, v) => {
  const [s, h] = String(v).split(':');
  if (!s || !h) return false;
  const a = scryptSync(p, s, 64);
  const b = Buffer.from(h, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
};
const safeEqualSecret = (a, b) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

async function setup(q) {
  await q`CREATE TABLE IF NOT EXISTS connect_users(id text primary key,email text unique not null,hash text not null,role text not null)`;
  await q`CREATE TABLE IF NOT EXISTS connect_rooms(code text primary key,owner text references connect_users(id),title text,epoch int default 0,snapshot jsonb default '{}'::jsonb)`;
  await q`CREATE TABLE IF NOT EXISTS connect_members(code text references connect_rooms(code),user_id text references connect_users(id),name text,primary key(code,user_id))`;
  await q`CREATE TABLE IF NOT EXISTS connect_events(id bigint generated always as identity primary key,code text references connect_rooms(code),user_id text,kind text,body jsonb,created_at timestamptz default now())`;
  await q`ALTER TABLE connect_events ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now()`;
  await q`CREATE INDEX IF NOT EXISTS connect_events_room_id ON connect_events(code,id)`;
  await q`CREATE INDEX IF NOT EXISTS connect_events_user_time ON connect_events(user_id,created_at)`;
  // Presence: every events poll marks the member as seen; rooms report who is online and since when.
  await q`ALTER TABLE connect_members ADD COLUMN IF NOT EXISTS seen_at timestamptz`;
  // Optional room capacity (members, host included); null = unlimited (rooms created before it existed).
  await q`ALTER TABLE connect_rooms ADD COLUMN IF NOT EXISTS capacity int`;
}

/**
 * @param {{ sql: () => Function, env: Record<string, string|undefined> }} deps
 *   sql: returns a tagged-template query function (Neon's `neon(url)` or a compatible adapter) that resolves to rows.
 */
export function createConnectHandler({ sql, env }) {
  let q = null;
  let ready = null;
  const key = () => new TextEncoder().encode(env.CONNECT_AUTH_SECRET);
  const sign = (uid, claims = {}) => new SignJWT(claims).setProtectedHeader({ alg: 'HS256' }).setSubject(uid).setIssuedAt().setExpirationTime('7d').sign(key());
  const origins = (env.CONNECT_ORIGINS ? env.CONNECT_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_ORIGINS);
  const rateLimit = Math.max(5, Number(env.CONNECT_RATE_LIMIT) || 40); // events per user and room in 10 s

  const cors = (req, res) => {
    const origin = req.headers.origin;
    if (!origin) return;
    if (origins.includes('*') || origins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '600');
    }
  };

  return async function handler(req, res) {
    const error = (n, message) => res.status(n).json({ error: message });
    cors(req, res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    try {
      if (!env.DATABASE_URL || !env.CONNECT_AUTH_SECRET || env.CONNECT_AUTH_SECRET.length < 32) return error(503, 'NEON_NOT_CONFIGURED');
      q ??= sql();
      ready ??= setup(q).catch((e) => {
        ready = null;
        throw e;
      });
      await ready;
      const action = String(req.query.action || 'health');
      const b = isPlainObject(req.body) ? req.body : {};
      if (action === 'health') return res.json({ ok: true, storage: 'neon', service: 'Braidata Connect' });

      if (action === 'bootstrap') {
        if (req.method !== 'POST' || !env.CONNECT_BOOTSTRAP_KEY || typeof b.bootstrapKey !== 'string' || !safeEqualSecret(b.bootstrapKey.trim(), env.CONNECT_BOOTSTRAP_KEY.trim())) return error(403, 'BOOTSTRAP_DENIED');
        if ((await q`SELECT id FROM connect_users WHERE role='admin' LIMIT 1`).length) return error(409, 'ADMIN_EXISTS');
        if (typeof b.email !== 'string' || !/^\S+@\S+\.\S+$/.test(b.email) || typeof b.password !== 'string' || b.password.length < 12) return error(400, 'INVALID_CREDENTIALS');
        const uid = id();
        const email = b.email.toLowerCase();
        await q`INSERT INTO connect_users VALUES(${uid},${email},${mkhash(b.password)},'admin')`;
        return res.status(201).json({ email, role: 'admin', token: await sign(uid) });
      }

      if (action === 'guest-join') {
        if (req.method !== 'POST') return error(405, 'METHOD_NOT_ALLOWED');
        const code = String(b.code || '').trim().toUpperCase();
        const name = String(b.name || '').trim().slice(0, 32);
        if (!/^[A-F0-9]{8}$/.test(code) || name.length < 2) return error(400, 'INVALID_CODE_OR_NAME');
        const target = await q`SELECT capacity FROM connect_rooms WHERE code=${code}`;
        if (!target.length) return error(404, 'ROOM_NOT_FOUND');
        if (target[0].capacity && (await q`SELECT COUNT(*)::int AS n FROM connect_members WHERE code=${code}`)[0].n >= target[0].capacity) return error(409, 'ROOM_FULL');
        const guestId = id();
        await q`INSERT INTO connect_users(id,email,hash,role) VALUES(${guestId},${'guest-' + guestId + '@connect.internal'},${'!guest-disabled'},'guest')`;
        await q`INSERT INTO connect_members(code,user_id,name) VALUES(${code},${guestId},${name})`;
        await q`INSERT INTO connect_events(code,user_id,kind,body) VALUES(${code},${guestId},'game.event',${JSON.stringify({ type: 'connect.member', action: 'join', userId: guestId, name, role: 'guest' })}::jsonb)`;
        return res.status(201).json({ code, name, role: 'guest', userId: guestId, token: await sign(guestId, { room: code, role: 'guest' }) });
      }

      if (action === 'login') {
        if (req.method !== 'POST') return error(405, 'METHOD_NOT_ALLOWED');
        const email = String(b.email || '').toLowerCase();
        const u = await q`SELECT * FROM connect_users WHERE email=${email}`;
        if (!u.length || u[0].role === 'guest' || typeof b.password !== 'string' || !check(b.password, u[0].hash)) return error(401, 'INVALID_LOGIN');
        return res.json({ token: await sign(u[0].id), email, role: u[0].role });
      }

      const auth = String(req.headers.authorization || '');
      if (!auth.startsWith('Bearer ')) return error(401, 'AUTH_REQUIRED');
      const j = await jwtVerify(auth.slice(7), key()).catch(() => null);
      if (!j) return error(401, 'BAD_TOKEN');
      const uid = j.payload.sub;
      const user = await q`SELECT id,email,role FROM connect_users WHERE id=${uid}`;
      if (!user.length) return error(401, 'UNKNOWN_USER');
      const role = user[0].role;
      if (action === 'me') return res.json({ user: user[0] });

      if (action === 'admin-users') {
        if (role !== 'admin') return error(403, 'ADMIN_ONLY');
        const users = await q`SELECT u.id,u.email,u.role,(SELECT COUNT(*)::int FROM connect_members m WHERE m.user_id=u.id) AS memberships,(SELECT COUNT(*)::int FROM connect_rooms r WHERE r.owner=u.id) AS owned_rooms FROM connect_users u ORDER BY u.role='admin' DESC,u.email`;
        return res.json({ users });
      }
      if (action === 'admin-create-user') {
        if (req.method !== 'POST') return error(405, 'METHOD_NOT_ALLOWED');
        if (role !== 'admin') return error(403, 'ADMIN_ONLY');
        if (typeof b.email !== 'string' || !/^\S+@\S+\.\S+$/.test(b.email) || typeof b.password !== 'string' || b.password.length < 12) return error(400, 'INVALID_CREDENTIALS');
        const email = b.email.toLowerCase();
        if ((await q`SELECT id FROM connect_users WHERE email=${email}`).length) return error(409, 'EMAIL_EXISTS');
        const hostId = id();
        await q`INSERT INTO connect_users VALUES(${hostId},${email},${mkhash(b.password)},'host')`;
        return res.status(201).json({ id: hostId, email, role: 'host' });
      }
      if (action === 'admin-delete-user') {
        if (req.method !== 'POST') return error(405, 'METHOD_NOT_ALLOWED');
        if (role !== 'admin') return error(403, 'ADMIN_ONLY');
        const target = String(b.userId || '');
        if (!target || target === uid) return error(400, 'INVALID_TARGET');
        const users = await q`SELECT id,role FROM connect_users WHERE id=${target}`;
        if (!users.length) return error(404, 'USER_NOT_FOUND');
        if (users[0].role === 'admin') return error(403, 'ADMIN_PROTECTED');
        if ((await q`SELECT code FROM connect_rooms WHERE owner=${target} LIMIT 1`).length) return error(409, 'USER_OWNS_ROOMS');
        await q`DELETE FROM connect_members WHERE user_id=${target}`;
        await q`DELETE FROM connect_events WHERE user_id=${target}`;
        await q`DELETE FROM connect_users WHERE id=${target}`;
        return res.json({ ok: true, deletedUserId: target });
      }

      if (action === 'create') {
        if (req.method !== 'POST') return error(405, 'METHOD_NOT_ALLOWED');
        if (role === 'guest') return error(403, 'GUEST_CANNOT_CREATE');
        const code = randomBytes(4).toString('hex').toUpperCase();
        const title = String(b.title || 'Room').slice(0, 80);
        const name = String(b.name || 'Host').slice(0, 32);
        const capacity = b.capacity === undefined || b.capacity === null ? null : Math.round(Number(b.capacity));
        if (capacity !== null && !(capacity >= 2 && capacity <= 64)) return error(400, 'INVALID_CAPACITY');
        await q`INSERT INTO connect_rooms(code,owner,title,capacity) VALUES(${code},${uid},${title},${capacity})`;
        await q`INSERT INTO connect_members VALUES(${code},${uid},${name})`;
        return res.status(201).json({ code, title, capacity });
      }

      const code = String(req.query.code || b.code || '').toUpperCase();
      if (!/^[A-F0-9]{8}$/.test(code)) return error(400, 'INVALID_CODE');
      const rooms = await q`SELECT * FROM connect_rooms WHERE code=${code}`;
      if (!rooms.length) return error(404, 'UNKNOWN_ROOM');
      const host = rooms[0].owner === uid;
      if (j.payload.role === 'guest' && j.payload.room !== code) return error(403, 'GUEST_ROOM_SCOPE');

      if (action === 'join') {
        if (req.method !== 'POST') return error(405, 'METHOD_NOT_ALLOWED');
        if (role === 'guest') return error(403, 'GUEST_CANNOT_JOIN_ANOTHER_ROOM');
        const name = String(b.name || 'Guest').slice(0, 32);
        const was = (await q`SELECT user_id FROM connect_members WHERE code=${code} AND user_id=${uid}`).length > 0;
        if (!was && rooms[0].capacity && (await q`SELECT COUNT(*)::int AS n FROM connect_members WHERE code=${code}`)[0].n >= rooms[0].capacity) return error(409, 'ROOM_FULL');
        await q`INSERT INTO connect_members VALUES(${code},${uid},${name}) ON CONFLICT(code,user_id) DO UPDATE SET name=EXCLUDED.name`;
        if (!was) await q`INSERT INTO connect_events(code,user_id,kind,body) VALUES(${code},${uid},'game.event',${JSON.stringify({ type: 'connect.member', action: 'join', userId: uid, name, role })}::jsonb)`;
        return res.json({ code, host });
      }

      const member = await q`SELECT name FROM connect_members WHERE code=${code} AND user_id=${uid}`;
      if (!member.length) return error(403, 'JOIN_REQUIRED');

      if (action === 'room') {
        return res.json({ room: rooms[0], host, role, currentUser: user[0], players: await q`SELECT m.user_id,m.name,u.role,EXTRACT(EPOCH FROM (now()-m.seen_at))::float AS idle FROM connect_members m JOIN connect_users u ON u.id=m.user_id WHERE m.code=${code} ORDER BY m.name` });
      }
      if (action === 'leave') {
        if (req.method !== 'POST') return error(405, 'METHOD_NOT_ALLOWED');
        if (host) return error(400, 'HOST_CANNOT_LEAVE');
        await q`DELETE FROM connect_members WHERE code=${code} AND user_id=${uid}`;
        await q`INSERT INTO connect_events(code,user_id,kind,body) VALUES(${code},${uid},'game.event',${JSON.stringify({ type: 'connect.member', action: 'leave', userId: uid, name: member[0].name })}::jsonb)`;
        return res.json({ ok: true });
      }
      if (action === 'resume') {
        if (req.method !== 'POST') return error(405, 'METHOD_NOT_ALLOWED');
        if (!host) return error(403, 'HOST_ONLY');
        const r = await q`UPDATE connect_rooms SET epoch=epoch+1 WHERE code=${code} RETURNING epoch,snapshot`;
        return res.json({ code, ...r[0] });
      }
      if (action === 'snapshot') {
        if (req.method !== 'POST') return error(405, 'METHOD_NOT_ALLOWED');
        if (!host) return error(403, 'HOST_ONLY');
        if (b.state !== undefined && !isPlainObject(b.state)) return error(400, 'INVALID_STATE');
        const state = JSON.stringify(b.state || {});
        if (state.length > 16000) return error(413, 'SNAPSHOT_TOO_LARGE');
        await q`UPDATE connect_rooms SET snapshot=${state}::jsonb WHERE code=${code}`;
        return res.json({ ok: true });
      }
      if (action === 'kick') {
        if (req.method !== 'POST') return error(405, 'METHOD_NOT_ALLOWED');
        if (!host) return error(403, 'HOST_ONLY');
        const target = String(b.userId || '');
        if (!target || target === uid) return error(400, 'INVALID_TARGET');
        const gone = await q`DELETE FROM connect_members WHERE code=${code} AND user_id=${target} RETURNING name`;
        if (gone.length) await q`INSERT INTO connect_events(code,user_id,kind,body) VALUES(${code},${uid},'game.event',${JSON.stringify({ type: 'connect.member', action: 'kick', userId: target, name: gone[0].name })}::jsonb)`;
        return res.json({ ok: true });
      }
      if (action === 'publish') {
        if (req.method !== 'POST') return error(405, 'METHOD_NOT_ALLOWED');
        if (!EVENT_KINDS.includes(b.kind)) return error(400, 'INVALID_EVENT');
        // Authoritative events come from the room's host only (guests and other members send player.input).
        if (b.kind === 'game.event' && role === 'guest') return error(403, 'GUEST_EVENT_RESTRICTED');
        if (b.kind === 'game.event' && !host) return error(403, 'HOST_EVENT_ONLY');
        if (b.data !== undefined && !isPlainObject(b.data)) return error(400, 'INVALID_DATA');
        if (b.kind === 'chat.message' && (typeof b.data?.text !== 'string' || !b.data.text.trim() || b.data.text.length > 500)) return error(400, 'INVALID_MESSAGE');
        const payload = JSON.stringify(b.data || {});
        // WebRTC offers/answers (complete SDP, signaled through the room) are larger than ordinary events.
        const maxPayload = b.kind === 'player.input' && b.data?.type === 'rtc.signal' ? 8000 : 2000;
        if (payload.length > maxPayload) return error(413, 'TOO_LARGE');
        const recent = await q`SELECT COUNT(*)::int AS n FROM connect_events WHERE code=${code} AND user_id=${uid} AND created_at > now() - interval '10 seconds'`;
        if (recent[0].n >= rateLimit) return error(429, 'RATE_LIMITED');
        const r = await q`INSERT INTO connect_events(code,user_id,kind,body) VALUES(${code},${uid},${b.kind},${payload}::jsonb) RETURNING id::text`;
        return res.status(201).json({ id: r[0].id });
      }
      if (action === 'events') {
        if (req.method !== 'GET') return error(405, 'METHOD_NOT_ALLOWED');
        const since = String(req.query.since || '0');
        if (!/^\d{1,18}$/.test(since)) return error(400, 'INVALID_CURSOR');
        await q`UPDATE connect_members SET seen_at=now() WHERE code=${code} AND user_id=${uid} AND (seen_at IS NULL OR seen_at < now() - interval '2 seconds')`;
        const presence = await q`SELECT m.user_id,m.name,u.role,EXTRACT(EPOCH FROM (now()-m.seen_at))::float AS idle FROM connect_members m JOIN connect_users u ON u.id=m.user_id WHERE m.code=${code} ORDER BY m.name`;
        const events = await q`SELECT e.id::text,e.user_id,e.kind,e.body AS data,e.created_at,COALESCE(m.name,'Former participant') AS sender_name FROM connect_events e LEFT JOIN connect_members m ON m.code=e.code AND m.user_id=e.user_id WHERE e.code=${code} AND e.id>${since}::bigint ORDER BY e.id LIMIT 100`;
        return res.json({ events, next: events.at(-1)?.id || since, epoch: rooms[0].epoch, owner: rooms[0].owner, presence });
      }
      return error(404, 'UNKNOWN_ACTION');
    } catch (e) {
      // Server log only (Vercel function logs); the client gets a generic code.
      console.error('[connect]', req.query?.action, e instanceof Error ? e.message : e);
      return error(500, 'CONNECT_ERROR');
    }
  };
}
