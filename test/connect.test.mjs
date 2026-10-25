// Braidata Connect protocol tests: the real handler (lib/connect-core.js) over HTTP, on an in-process Postgres.
// Run: npm test
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { startLocalConnect } from '../scripts/connect-local.mjs';

let s;
let api;
const ADMIN = { email: 'admin@connect.test', password: 'correct-horse-battery' };

before(async () => {
  s = await startLocalConnect({ port: 0, peer: false, env: { CONNECT_RATE_LIMIT: '8', CONNECT_AUTHORITY_LEASE_SEC: '3' } });
  api = async (action, { body, token, method = body ? 'POST' : 'GET', query = {}, origin } = {}) => {
    const qs = new URLSearchParams({ action, ...query });
    const r = await fetch(`${s.url}/api/connect?${qs}`, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(origin ? { origin } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    return { status: r.status, json: text ? JSON.parse(text) : null, headers: r.headers };
  };
});
after(async () => s?.close());

let admin;
let code;
let guest;

test('health and bootstrap of the first admin', async () => {
  assert.equal((await api('health')).json.ok, true);
  assert.equal((await api('bootstrap', { body: { ...ADMIN, bootstrapKey: 'wrong' } })).status, 403);
  const b = await api('bootstrap', { body: { ...ADMIN, bootstrapKey: s.env.CONNECT_BOOTSTRAP_KEY } });
  assert.equal(b.status, 201);
  assert.equal((await api('bootstrap', { body: { ...ADMIN, bootstrapKey: s.env.CONNECT_BOOTSTRAP_KEY } })).status, 409);
  const l = await api('login', { body: ADMIN });
  assert.equal(l.status, 200);
  admin = l.json.token;
  assert.equal((await api('login', { body: { ...ADMIN, password: 'nope-nope-nope' } })).status, 401);
});

test('CORS: allowed origins get headers and preflight; others do not', async () => {
  const ok = await api('health', { origin: 'https://alterverse.art' });
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://alterverse.art');
  const pre = await api('publish', { method: 'OPTIONS', origin: 'https://alterverse.art' });
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get('access-control-allow-headers'), /authorization/);
  const bad = await api('health', { origin: 'https://evil.example' });
  assert.equal(bad.headers.get('access-control-allow-origin'), null);
});

test('admin provisions a host account; hosts create rooms, guests cannot', async () => {
  const c = await api('admin-create-user', { body: { email: 'host@connect.test', password: 'another-long-secret' }, token: admin });
  assert.equal(c.status, 201);
  assert.equal(c.json.role, 'host');
  const host = (await api('login', { body: { email: 'host@connect.test', password: 'another-long-secret' } })).json.token;
  const r = await api('create', { body: { title: 'Sala', name: 'Host' }, token: host });
  assert.equal(r.status, 201);
  assert.match(r.json.code, /^[A-F0-9]{8}$/);
  code = r.json.code;
  s.host = host;
});

test('guest joins by code with a room-scoped token and cannot leave its scope', async () => {
  const g = await api('guest-join', { body: { code, name: 'Ana' } });
  assert.equal(g.status, 201);
  guest = g.json;
  const room = await api('room', { query: { code }, token: guest.token });
  assert.equal(room.status, 200);
  assert.equal(room.json.host, false);
  assert.ok(room.json.players.some((p) => p.user_id === guest.userId));
  const other = await api('create', { body: { title: 'x' }, token: guest.token });
  assert.equal(other.status, 403);
  const second = (await api('create', { body: { title: 'Otra' }, token: s.host })).json.code;
  assert.equal((await api('room', { query: { code: second }, token: guest.token })).status, 403);
  assert.equal((await api('login', { body: { email: `guest-${guest.userId}@connect.internal`, password: '!guest-disabled' } })).status, 401);
});

test('join of a member is announced as a member event', async () => {
  const ev = await api('events', { query: { code, since: '0' }, token: s.host });
  assert.ok(ev.json.events.some((e) => e.kind === 'game.event' && e.data.type === 'connect.member' && e.data.action === 'join' && e.data.userId === guest.userId));
  assert.equal(typeof ev.json.epoch, 'number');
});

test('publish: chat validated, game.event only from the host, payload checks', async () => {
  assert.equal((await api('publish', { body: { code, kind: 'chat.message', data: { text: 'hola' } }, token: guest.token })).status, 201);
  assert.equal((await api('publish', { body: { code, kind: 'chat.message', data: { text: '   ' } }, token: guest.token })).status, 400);
  assert.equal((await api('publish', { body: { code, kind: 'game.event', data: { type: 'state' } }, token: guest.token })).status, 403);
  assert.equal((await api('publish', { body: { code, kind: 'player.input', data: [1, 2] }, token: guest.token })).status, 400);
  assert.equal((await api('publish', { body: { code, kind: 'admin.drop', data: {} }, token: guest.token })).status, 400);
  const big = 'x'.repeat(3000);
  assert.equal((await api('publish', { body: { code, kind: 'player.input', data: { type: 'note', big } }, token: guest.token })).status, 413);
  assert.equal((await api('publish', { body: { code, kind: 'player.input', data: { type: 'rtc.signal', sdp: big } }, token: guest.token })).status, 201);
  assert.equal((await api('publish', { body: { code, kind: 'player.input', data: { type: 'rtc.signal', sdp: 'x'.repeat(9000) } }, token: guest.token })).status, 413);
  assert.equal((await api('publish', { body: { code, kind: 'game.event', data: { type: 'state', vars: { luz: true } } }, token: s.host })).status, 201);
  const ev = await api('events', { query: { code, since: '0' }, token: guest.token });
  const chat = ev.json.events.find((e) => e.kind === 'chat.message');
  assert.equal(chat.data.text, 'hola');
  assert.equal(chat.sender_name, 'Ana');
  assert.ok(chat.created_at);
});

test('rate limit per member', async () => {
  let last = 0;
  for (let i = 0; i < 12; i += 1) last = (await api('publish', { body: { code, kind: 'player.input', data: { type: 'spam', i } }, token: guest.token })).status;
  assert.equal(last, 429);
});

test('snapshot and resume are host-only; resume bumps the epoch and returns the snapshot', async () => {
  assert.equal((await api('snapshot', { body: { code, state: { vars: { luz: true } } }, token: guest.token })).status, 403);
  assert.equal((await api('snapshot', { body: { code, state: { vars: { luz: true }, v: 1 } }, token: s.host })).status, 200);
  assert.equal((await api('snapshot', { body: { code, state: 'nope' }, token: s.host })).status, 400);
  const r = await api('resume', { body: { code }, token: s.host });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.snapshot.vars, { luz: true });
  const r2 = await api('resume', { body: { code }, token: s.host });
  assert.equal(r2.json.epoch, r.json.epoch + 1);
  assert.equal((await api('resume', { body: { code }, token: guest.token })).status, 403);
});

test('kick revokes the guest in this room and is announced', async () => {
  const g2 = (await api('guest-join', { body: { code, name: 'Beto' } })).json;
  assert.equal((await api('kick', { body: { code, userId: g2.userId }, token: guest.token })).status, 403);
  assert.equal((await api('kick', { body: { code, userId: g2.userId }, token: s.host })).status, 200);
  assert.equal((await api('room', { query: { code }, token: g2.token })).status, 403);
  assert.equal((await api('publish', { body: { code, kind: 'chat.message', data: { text: 'sigo?' } }, token: g2.token })).status, 403);
  const ev = await api('events', { query: { code, since: '0' }, token: s.host });
  assert.ok(ev.json.events.some((e) => e.data?.type === 'connect.member' && e.data.action === 'kick' && e.data.userId === g2.userId));
});

test('a member leaves; the host cannot leave its own room', async () => {
  const g3 = (await api('guest-join', { body: { code, name: 'Cleo' } })).json;
  assert.equal((await api('leave', { body: { code }, token: g3.token })).status, 200);
  assert.equal((await api('room', { query: { code }, token: g3.token })).status, 403);
  assert.equal((await api('leave', { body: { code }, token: s.host })).status, 400);
});

test('presence: polling marks a member as seen; never-polled members have no idle time', async () => {
  const g4 = (await api('guest-join', { body: { code, name: 'Dora' } })).json;
  await api('events', { query: { code, since: '0' }, token: s.host });
  const ev = await api('events', { query: { code, since: '0' }, token: guest.token });
  const me = ev.json.presence.find((p) => p.user_id === guest.userId);
  assert.ok(me && me.idle >= 0 && me.idle < 5);
  const host = ev.json.presence.find((p) => p.user_id === ev.json.owner);
  assert.ok(host && host.idle < 5 && host.role === 'host');
  assert.equal(ev.json.presence.find((p) => p.user_id === g4.userId).idle, null);
  assert.ok(!('email' in host));
});

test('room capacity: members (host included) up to capacity; the rest get ROOM_FULL', async () => {
  const r = await api('create', { body: { title: 'Cupo', name: 'Host', capacity: 2 }, token: s.host });
  assert.equal(r.json.capacity, 2);
  assert.equal((await api('guest-join', { body: { code: r.json.code, name: 'Uno' } })).status, 201);
  assert.equal((await api('guest-join', { body: { code: r.json.code, name: 'Dos' } })).status, 409);
  assert.equal((await api('create', { body: { title: 'x', capacity: 1 }, token: s.host })).status, 400);
});

test('quick room: no account; the owner is host of that room only; guests join as usual', async () => {
  assert.equal((await api('quick-create', { body: { name: 'x' } })).status, 400);
  const r = await api('quick-create', { body: { name: 'Ivan', title: 'Rapida', capacity: 4 } });
  assert.equal(r.status, 201);
  assert.match(r.json.code, /^[A-F0-9]{8}$/);
  assert.ok(r.json.expiresAt && r.json.token);
  const qh = r.json.token;
  const room = await api('room', { query: { code: r.json.code }, token: qh });
  assert.equal(room.json.host, true);
  assert.equal((await api('publish', { body: { code: r.json.code, kind: 'game.event', data: { type: 'state' } }, token: qh })).status, 201);
  assert.equal((await api('snapshot', { body: { code: r.json.code, state: { v: 1 } }, token: qh })).status, 200);
  assert.equal((await api('resume', { body: { code: r.json.code }, token: qh })).status, 200);
  const g = (await api('guest-join', { body: { code: r.json.code, name: 'Ana' } })).json;
  assert.equal((await api('kick', { body: { code: r.json.code, userId: g.userId }, token: qh })).status, 200);
  // Scoped: no other room, no new rooms, no login, no admin.
  assert.equal((await api('room', { query: { code }, token: qh })).status, 403);
  assert.equal((await api('create', { body: { title: 'otra' }, token: qh })).status, 403);
  assert.equal((await api('join', { body: { code }, token: qh })).status, 403);
  assert.equal((await api('admin-users', { token: qh })).status, 403);
  assert.equal((await api('login', { body: { email: `quick-${r.json.userId}@connect.internal`, password: '!login-disabled' } })).status, 401);
});

test('world authority: one holder at a time with growing epochs; only it writes the world; a lapsed lease passes on', async () => {
  const r = (await api('quick-create', { body: { name: 'Duena', title: 'Mundo' } })).json;
  const h = r.token;
  const ga = (await api('guest-join', { body: { code: r.code, name: 'Ana' } })).json.token;
  const gb = (await api('guest-join', { body: { code: r.code, name: 'Beto' } })).json.token;
  const claim = (t) => api('authority', { body: { code: r.code }, token: t });
  assert.equal((await api('world', { query: { code: r.code }, token: ga })).json.world, null);
  const a1 = await claim(ga);
  assert.deepEqual([a1.status, a1.json.authority.epoch], [200, 1]);
  const b1 = await claim(gb); // held and fresh: refused, with the holder
  assert.deepEqual([b1.status, b1.json.granted, b1.json.authority.epoch], [409, false, 1]);
  assert.equal((await claim(ga)).json.authority.epoch, 1); // renewing keeps the epoch
  assert.equal((await api('world-save', { body: { code: r.code, rev: 1, epoch: 1, state: { wv: 1 } }, token: gb })).json.error, 'NOT_AUTHORITY');
  assert.equal((await api('world-save', { body: { code: r.code, rev: 5, epoch: 1, state: { wv: 1, ht: 3 } }, token: ga })).status, 200);
  const w = (await api('world', { query: { code: r.code }, token: gb })).json;
  assert.deepEqual([w.rev, w.world.ht], [5, 3]);
  const stale = await api('world-save', { body: { code: r.code, rev: 3, epoch: 1, state: { wv: 1 } }, token: ga });
  assert.deepEqual([stale.status, stale.json.rev], [409, 5]);
  assert.equal((await api('world-save', { body: { code: r.code, rev: 6, epoch: 1, state: { big: 'x'.repeat(61000) } }, token: ga })).status, 413);
  // The holder stops renewing: after the lease anyone may take it (epoch 2), and the former holder can no longer write.
  await new Promise((ok) => setTimeout(ok, 3500));
  const ev = (await api('events', { query: { code: r.code, since: '0' }, token: gb })).json;
  assert.equal(ev.authority.user, null);
  const b2 = await claim(gb);
  assert.deepEqual([b2.status, b2.json.authority.epoch], [200, 2]);
  assert.equal((await api('world-save', { body: { code: r.code, rev: 9, epoch: 1, state: { wv: 1 } }, token: ga })).json.error, 'NOT_AUTHORITY');
  // The owner (room host) takes it over at once: epoch 3.
  const h3 = await claim(h);
  assert.deepEqual([h3.status, h3.json.authority.user === b2.json.authority.user, h3.json.authority.epoch], [200, false, 3]);
  assert.equal((await api('authority-release', { body: { code: r.code }, token: h })).status, 200);
  assert.equal((await api('world', { query: { code }, token: ga })).status, 403);
});

test('quick rooms are rate-limited per client address', async () => {
  let last = 0;
  for (let i = 0; i < 25; i += 1) last = (await api('quick-create', { body: { name: `Sala ${i}` } })).status;
  assert.equal(last, 429);
});

test('admin password reset with the bootstrap key', async () => {
  assert.equal((await api('admin-reset', { body: { email: ADMIN.email, password: 'brand-new-password-1', bootstrapKey: 'nope' } })).status, 403);
  assert.equal((await api('admin-reset', { body: { email: 'host@connect.test', password: 'brand-new-password-1', bootstrapKey: s.env.CONNECT_BOOTSTRAP_KEY } })).status, 404);
  assert.equal((await api('admin-reset', { body: { email: ADMIN.email, password: 'brand-new-password-1', bootstrapKey: s.env.CONNECT_BOOTSTRAP_KEY } })).status, 200);
  assert.equal((await api('login', { body: ADMIN })).status, 401);
  assert.equal((await api('login', { body: { ...ADMIN, password: 'brand-new-password-1' } })).status, 200);
});

test('invalid codes and cursors are rejected', async () => {
  assert.equal((await api('room', { query: { code: "AB'; DROP" }, token: s.host })).status, 400);
  assert.equal((await api('events', { query: { code, since: '1;2' }, token: s.host })).status, 400);
  assert.equal((await api('room', { query: { code }, token: 'not-a-jwt' })).status, 401);
});

test('admin-only user management stays admin-only', async () => {
  assert.equal((await api('admin-users', { token: s.host })).status, 403);
  assert.equal((await api('admin-users', { token: guest.token })).status, 403);
  assert.equal((await api('admin-users', { token: admin })).status, 200); // admin token still valid after a reset (JWT)
});
