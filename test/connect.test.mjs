// Braidata Connect protocol tests: the real handler (lib/connect-core.js) over HTTP, on an in-process Postgres.
// Run: npm test
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { startLocalConnect } from '../scripts/connect-local.mjs';

let s;
let api;
const ADMIN = { email: 'admin@connect.test', password: 'correct-horse-battery' };

before(async () => {
  s = await startLocalConnect({ port: 0, peer: false, env: { CONNECT_RATE_LIMIT: '8' } });
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

test('invalid codes and cursors are rejected', async () => {
  assert.equal((await api('room', { query: { code: "AB'; DROP" }, token: s.host })).status, 400);
  assert.equal((await api('events', { query: { code, since: '1;2' }, token: s.host })).status, 400);
  assert.equal((await api('room', { query: { code }, token: 'not-a-jwt' })).status, 401);
});

test('admin-only user management stays admin-only', async () => {
  assert.equal((await api('admin-users', { token: s.host })).status, 403);
  assert.equal((await api('admin-users', { token: guest.token })).status, 403);
  assert.equal((await api('admin-users', { token: admin })).status, 200);
});
