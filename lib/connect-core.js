// Braidata Connect — protocol core, independent of the database driver and of the HTTP host.
// api/connect.js binds it to Neon on Vercel; scripts/connect-local.mjs binds it to an in-process Postgres (PGlite)
// for development and automated tests. Same handler, same SQL, same responses.
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
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
  // Quick rooms: opened without an account, owned by a one-room identity, removed after expires_at.
  await q`ALTER TABLE connect_rooms ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now()`;
  await q`ALTER TABLE connect_rooms ADD COLUMN IF NOT EXISTS expires_at timestamptz`;
  await q`ALTER TABLE connect_rooms ADD COLUMN IF NOT EXISTS origin_hash text`;
  // Shared world: the room's physical state as its current authority last saved it (versioned, compare-and-set).
  await q`ALTER TABLE connect_rooms ADD COLUMN IF NOT EXISTS world jsonb`;
  await q`ALTER TABLE connect_rooms ADD COLUMN IF NOT EXISTS world_rev bigint DEFAULT 0`;
  await q`ALTER TABLE connect_rooms ADD COLUMN IF NOT EXISTS world_by text`;
  await q`ALTER TABLE connect_rooms ADD COLUMN IF NOT EXISTS world_at timestamptz`;
  // World authority lease: the ONE participant whose device simulates the room's world, with a growing epoch.
  await q`ALTER TABLE connect_rooms ADD COLUMN IF NOT EXISTS auth_user text`;
  await q`ALTER TABLE connect_rooms ADD COLUMN IF NOT EXISTS auth_epoch bigint DEFAULT 0`;
  await q`ALTER TABLE connect_rooms ADD COLUMN IF NOT EXISTS auth_at timestamptz`;
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
  const quickRooms = env.CONNECT_QUICK_ROOMS !== 'off';
  const quickPerHour = Math.max(1, Number(env.CONNECT_QUICK_PER_HOUR) || 20); // quick rooms per client address and hour
  const worldMax = Math.min(512000, Math.max(16000, Number(env.CONNECT_WORLD_MAX) || 60000)); // bytes of one world state
  // Long enough that the holder renews it inside its slow events poll (every leaseSec / 3); a clean exit releases it
  // at once, so this only bounds the handover after a crash or a lost network.
  const leaseSec = Math.max(3, Number(env.CONNECT_AUTHORITY_LEASE_SEC) || 60);
  // Old events are only read by a client catching up: signaling (WebRTC offers, hellos, poses) is useless after
  // minutes, the rest after days. Purged opportunistically when rooms are entered (no scheduler needed).
  const eventsKeepDays = Math.max(1, Number(env.CONNECT_EVENTS_KEEP_DAYS) || 14);
  const quickTtlHours = Math.min(24 * 30, Math.max(1, Number(env.CONNECT_QUICK_TTL_HOURS) || 48));
  // Client address, hashed with the server secret: enough to rate-limit room creation, never stored in clear.
  const originHash = (req) => {
    const ip = String(req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || 'local').split(',')[0].trim();
    return createHash('sha256').update(`${env.CONNECT_AUTH_SECRET}|${ip}`).digest('hex').slice(0, 32);
  };
  const expired = (room) => !!room.expires_at && new Date(room.expires_at).getTime() <= Date.now();

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

  /** Housekeeping when someone enters a room: signaling older than 10 minutes and anything older than the keep window. */
  const purgeEvents = async (code) => {
    await q`DELETE FROM connect_events WHERE code=${code} AND created_at < now() - interval '10 minutes'
      AND kind='player.input' AND (body->>'type' LIKE 'rtc.%' OR body->>'type'='ec.pose')`;
    await q`DELETE FROM connect_events WHERE code=${code} AND created_at < now() - make_interval(days => ${eventsKeepDays})`;
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

      if (action === 'quick-create') {
        // A room without an account: its owner is a one-room identity (token scoped to that room, never a login).
        if (req.method !== 'POST') return error(405, 'METHOD_NOT_ALLOWED');
        if (!quickRooms) return error(403, 'QUICK_ROOMS_DISABLED');
        const name = String(b.name || '').trim().slice(0, 32);
        if (name.length < 2) return error(400, 'INVALID_NAME');
        const capacity = b.capacity === undefined || b.capacity === null ? null : Math.round(Number(b.capacity));
        if (capacity !== null && !(capacity >= 2 && capacity <= 64)) return error(400, 'INVALID_CAPACITY');
        const oh = originHash(req);
        if ((await q`SELECT COUNT(*)::int AS n FROM connect_rooms WHERE origin_hash=${oh} AND created_at > now() - interval '1 hour'`)[0].n >= quickPerHour) return error(429, 'RATE_LIMITED');
        // Housekeeping: quick rooms past their expiry go away with their members and events.
        const gone = await q`SELECT code FROM connect_rooms WHERE expires_at IS NOT NULL AND expires_at < now() LIMIT 50`;
        for (const g of gone) {
          await q`DELETE FROM connect_events WHERE code=${g.code}`;
          await q`DELETE FROM connect_members WHERE code=${g.code}`;
          await q`DELETE FROM connect_rooms WHERE code=${g.code}`;
        }
        const code = randomBytes(4).toString('hex').toUpperCase();
        const title = String(b.title || 'Room').slice(0, 80);
        const owner = id();
        await q`INSERT INTO connect_users(id,email,hash,role) VALUES(${owner},${'quick-' + owner + '@connect.internal'},${'!login-disabled'},'quickhost')`;
        const r = await q`INSERT INTO connect_rooms(code,owner,title,capacity,expires_at,origin_hash) VALUES(${code},${owner},${title},${capacity},now() + (${quickTtlHours}::int * interval '1 hour'),${oh}) RETURNING expires_at`;
        await q`INSERT INTO connect_members(code,user_id,name) VALUES(${code},${owner},${name})`;
        return res.status(201).json({ code, title, name, capacity, userId: owner, role: 'host', expiresAt: r[0].expires_at, token: await sign(owner, { room: code, role: 'guest' }) });
      }

      if (action === 'admin-reset') {
        // Lost admin password: whoever controls CONNECT_BOOTSTRAP_KEY (the deployment's env) sets a new one.
        if (req.method !== 'POST' || !env.CONNECT_BOOTSTRAP_KEY || typeof b.bootstrapKey !== 'string' || !safeEqualSecret(b.bootstrapKey.trim(), env.CONNECT_BOOTSTRAP_KEY.trim())) return error(403, 'BOOTSTRAP_DENIED');
        if (typeof b.email !== 'string' || typeof b.password !== 'string' || b.password.length < 12) return error(400, 'INVALID_CREDENTIALS');
        const r = await q`UPDATE connect_users SET hash=${mkhash(b.password)} WHERE email=${b.email.toLowerCase().trim()} AND role='admin' RETURNING id`;
        if (!r.length) return error(404, 'UNKNOWN_ADMIN');
        return res.json({ ok: true, email: b.email.toLowerCase().trim() });
      }

      if (action === 'guest-join') {
        if (req.method !== 'POST') return error(405, 'METHOD_NOT_ALLOWED');
        const code = String(b.code || '').trim().toUpperCase();
        const name = String(b.name || '').trim().slice(0, 32);
        if (!/^[A-F0-9]{8}$/.test(code) || name.length < 2) return error(400, 'INVALID_CODE_OR_NAME');
        const target = await q`SELECT capacity,expires_at FROM connect_rooms WHERE code=${code}`;
        if (!target.length) return error(404, 'ROOM_NOT_FOUND');
        if (expired(target[0])) return error(410, 'ROOM_EXPIRED');
        if (target[0].capacity && (await q`SELECT COUNT(*)::int AS n FROM connect_members WHERE code=${code}`)[0].n >= target[0].capacity) return error(409, 'ROOM_FULL');
        await purgeEvents(code);
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
        if (!u.length || u[0].role === 'guest' || u[0].role === 'quickhost' || typeof b.password !== 'string' || !check(b.password, u[0].hash)) return error(401, 'INVALID_LOGIN');
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
        if (role !== 'admin' && role !== 'host') return error(403, 'GUEST_CANNOT_CREATE');
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
      // The hot path (every poll) never reads the heavy columns (world, snapshot): only what checks and answers need,
      // plus this user's membership in the same round trip.
      const rooms = await q`SELECT r.code,r.owner,r.title,r.epoch,r.capacity,r.expires_at,r.auth_user,r.auth_epoch,r.auth_at,r.world_rev,m.name AS member_name
        FROM connect_rooms r LEFT JOIN connect_members m ON m.code=r.code AND m.user_id=${uid} WHERE r.code=${code}`;
      if (!rooms.length) return error(404, 'UNKNOWN_ROOM');
      if (expired(rooms[0])) return error(410, 'ROOM_EXPIRED');
      const host = rooms[0].owner === uid;
      // Room-scoped tokens (guests, quick-room owners) work in their room only.
      if (j.payload.room && j.payload.room !== code) return error(403, 'GUEST_ROOM_SCOPE');

      if (action === 'join') {
        if (req.method !== 'POST') return error(405, 'METHOD_NOT_ALLOWED');
        if (j.payload.room || (role !== 'admin' && role !== 'host')) return error(403, 'GUEST_CANNOT_JOIN_ANOTHER_ROOM');
        const name = String(b.name || 'Guest').slice(0, 32);
        const was = rooms[0].member_name != null;
        if (!was && rooms[0].capacity && (await q`SELECT COUNT(*)::int AS n FROM connect_members WHERE code=${code}`)[0].n >= rooms[0].capacity) return error(409, 'ROOM_FULL');
        await q`INSERT INTO connect_members VALUES(${code},${uid},${name}) ON CONFLICT(code,user_id) DO UPDATE SET name=EXCLUDED.name`;
        await purgeEvents(code);
        if (!was) await q`INSERT INTO connect_events(code,user_id,kind,body) VALUES(${code},${uid},'game.event',${JSON.stringify({ type: 'connect.member', action: 'join', userId: uid, name, role })}::jsonb)`;
        return res.json({ code, host });
      }

      const member = rooms[0].member_name != null ? [{ name: rooms[0].member_name }] : [];
      if (!member.length) return error(403, 'JOIN_REQUIRED');
      const { member_name: _m, ...room } = rooms[0];

      if (action === 'room') {
        // Joining reads the room's shared-state snapshot (small, at most 16 KB); polls never do.
        room.snapshot = (await q`SELECT snapshot FROM connect_rooms WHERE code=${code}`)[0]?.snapshot ?? {};
        return res.json({ room, host, role, currentUser: user[0], players: await q`SELECT m.user_id,m.name,u.role,EXTRACT(EPOCH FROM (now()-m.seen_at))::float AS idle FROM connect_members m JOIN connect_users u ON u.id=m.user_id WHERE m.code=${code} ORDER BY m.name` });
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
      // The room's world state. Read by any member. Written by the owner, or by another member while the owner is away
      // (no sign of life for CONNECT_HOST_AWAY_SEC): the participant that keeps the world running in its absence.
      // `rev` must grow: a stale copy never overwrites a newer one (409 returns the current rev).
      // Claim or renew the world authority. One holder at a time (atomic in the database): the holder renews it; anyone
      // else gets it only when it is free or lapsed (no renewal for CONNECT_AUTHORITY_LEASE_SEC); the owner may take it
      // over at any time (it is the room's host). Every change of holder increments the epoch.
      if (action === 'authority') {
        if (req.method !== 'POST') return error(405, 'METHOD_NOT_ALLOWED');
        const r = await q`UPDATE connect_rooms SET
            auth_epoch = CASE WHEN auth_user = ${uid} THEN auth_epoch ELSE COALESCE(auth_epoch,0) + 1 END,
            auth_user = ${uid}, auth_at = now()
          WHERE code=${code} AND (auth_user IS NULL OR auth_user = ${uid} OR ${host} OR auth_at < now() - make_interval(secs => ${leaseSec}))
          RETURNING auth_user, auth_epoch`;
        const cur = r.length ? r[0] : (await q`SELECT auth_user, auth_epoch FROM connect_rooms WHERE code=${code}`)[0];
        return res.status(r.length ? 200 : 409).json({ authority: { user: cur.auth_user, epoch: Number(cur.auth_epoch ?? 0) }, granted: r.length > 0 });
      }
      if (action === 'authority-release') {
        if (req.method !== 'POST') return error(405, 'METHOD_NOT_ALLOWED');
        await q`UPDATE connect_rooms SET auth_user = NULL WHERE code=${code} AND auth_user=${uid}`;
        return res.json({ ok: true });
      }
      if (action === 'world') {
        const w = (await q`SELECT world,world_rev,world_by,world_at FROM connect_rooms WHERE code=${code}`)[0];
        return res.json({ world: w.world ?? null, rev: Number(w.world_rev ?? 0), by: w.world_by ?? null, at: w.world_at ?? null });
      }
      if (action === 'world-save') {
        if (req.method !== 'POST') return error(405, 'METHOD_NOT_ALLOWED');
        const rev = Number(b.rev);
        if (!Number.isSafeInteger(rev) || rev < 1) return error(400, 'INVALID_REV');
        if (!isPlainObject(b.state)) return error(400, 'INVALID_STATE');
        const state = JSON.stringify(b.state);
        if (state.length > worldMax) return error(413, 'WORLD_TOO_LARGE');
        // Only the authority of the current epoch writes the world: a former authority can never overwrite it.
        const epoch = Number(b.epoch);
        if (rooms[0].auth_user !== uid || Number(rooms[0].auth_epoch) !== epoch) return error(403, 'NOT_AUTHORITY');
        // release: the holder is leaving (page closing): last save and lease handed back in ONE call.
        const release = b.release === true;
        const r = await q`UPDATE connect_rooms SET world=${state}::jsonb, world_rev=${rev}, world_by=${uid}, world_at=now(),
            auth_user = CASE WHEN ${release} THEN NULL ELSE auth_user END
          WHERE code=${code} AND auth_user=${uid} AND auth_epoch=${epoch} AND COALESCE(world_rev,0) < ${rev} RETURNING world_rev`;
        if (!r.length) {
          const cur = await q`SELECT world_rev FROM connect_rooms WHERE code=${code}`;
          return res.status(409).json({ error: 'STALE_WORLD', rev: Number(cur[0]?.world_rev ?? 0) });
        }
        return res.json({ ok: true, rev });
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
        // The world authority renews its lease with its poll (renew=1): no separate call. Only the current holder, and
        // only while its lease has not lapsed (a lapsed lease is claimed with action=authority, as before).
        if (req.query.renew === '1' && rooms[0].auth_user === uid) {
          const r = await q`UPDATE connect_rooms SET auth_at=now() WHERE code=${code} AND auth_user=${uid} AND auth_at >= now() - make_interval(secs => ${leaseSec}) RETURNING auth_at`;
          if (r.length) rooms[0].auth_at = r[0].auth_at;
        }
        const presence = await q`SELECT m.user_id,m.name,u.role,EXTRACT(EPOCH FROM (now()-m.seen_at))::float AS idle FROM connect_members m JOIN connect_users u ON u.id=m.user_id WHERE m.code=${code} ORDER BY m.name`;
        const events = await q`SELECT e.id::text,e.user_id,e.kind,e.body AS data,e.created_at,COALESCE(m.name,'Former participant') AS sender_name FROM connect_events e LEFT JOIN connect_members m ON m.code=e.code AND m.user_id=e.user_id WHERE e.code=${code} AND e.id>${since}::bigint ORDER BY e.id LIMIT 100`;
        const lapsed = !rooms[0].auth_at || Date.now() - new Date(rooms[0].auth_at).getTime() > leaseSec * 1000;
        const authority = rooms[0].auth_user && !lapsed ? { user: rooms[0].auth_user, epoch: Number(rooms[0].auth_epoch) } : { user: null, epoch: Number(rooms[0].auth_epoch ?? 0) };
        return res.json({ events, next: events.at(-1)?.id || since, epoch: rooms[0].epoch, owner: rooms[0].owner, presence, authority, worldRev: Number(rooms[0].world_rev ?? 0), leaseSec });
      }
      return error(404, 'UNKNOWN_ACTION');
    } catch (e) {
      // Server log only (Vercel function logs); the client gets a generic code.
      console.error('[connect]', req.query?.action, e instanceof Error ? e.message : e);
      return error(500, 'CONNECT_ERROR');
    }
  };
}
