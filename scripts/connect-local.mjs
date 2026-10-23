// Local Braidata Connect: the same protocol core as the Vercel Function, over node:http, with an in-process
// Postgres (PGlite) instead of Neon, plus an optional PeerJS signaling server for WebRTC. For development and tests.
//
//   node scripts/connect-local.mjs                 API on :8788, PeerServer on :9000, in-memory database
//   CONNECT_PORT=8788 PEER_PORT=0 CONNECT_DATA=./.connect-data node scripts/connect-local.mjs
//
// Env: CONNECT_AUTH_SECRET (default: random per run), CONNECT_BOOTSTRAP_KEY (default: "local-bootstrap-key"),
//      CONNECT_ORIGINS (default: the core's allowlist), CONNECT_SEED_ADMIN="email:password" to create the admin.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createConnectHandler } from '../lib/connect-core.js';

export async function startLocalConnect(opts = {}) {
  const port = opts.port ?? Number(process.env.CONNECT_PORT ?? 8788);
  const peerPort = opts.peerPort ?? Number(process.env.PEER_PORT ?? 9000);
  const env = {
    DATABASE_URL: 'pglite://local',
    CONNECT_AUTH_SECRET: process.env.CONNECT_AUTH_SECRET ?? randomBytes(32).toString('hex'),
    CONNECT_BOOTSTRAP_KEY: process.env.CONNECT_BOOTSTRAP_KEY ?? 'local-bootstrap-key',
    CONNECT_ORIGINS: process.env.CONNECT_ORIGINS,
    CONNECT_RATE_LIMIT: process.env.CONNECT_RATE_LIMIT,
    ...opts.env,
  };
  const db = new PGlite(opts.dataDir ?? process.env.CONNECT_DATA);
  await db.query('SELECT 1'); // initialise now (it inspects the environment on first use)
  // Neon-compatible tagged template: q`SELECT ... ${value}` → rows.
  const q = async (strings, ...values) => {
    let text = '';
    strings.forEach((s, i) => {
      text += s;
      if (i < values.length) text += '$' + (i + 1);
    });
    return (await db.query(text, values)).rows;
  };
  const handler = createConnectHandler({ sql: () => q, env });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    if (url.pathname !== '/api/connect') {
      res.statusCode = url.pathname === '/health' ? 200 : 404;
      res.end(url.pathname === '/health' ? 'ok' : 'not found');
      return;
    }
    let raw = '';
    for await (const c of req) {
      raw += c;
      if (raw.length > 64 * 1024) break;
    }
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      body = {};
    }
    const vreq = { method: req.method, query: Object.fromEntries(url.searchParams), headers: req.headers, body };
    const vres = {
      status(n) {
        res.statusCode = n;
        return vres;
      },
      json(o) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(o));
        return vres;
      },
      setHeader(k, v) {
        res.setHeader(k, v);
        return vres;
      },
      end() {
        res.end();
        return vres;
      },
    };
    await handler(vreq, vres);
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const apiPort = server.address().port;

  let peer = null;
  if (peerPort !== 0 && opts.peer !== false) {
    const { PeerServer } = await import('peer');
    peer = PeerServer({ port: peerPort, path: '/peerjs', allow_discovery: false });
  }

  const seed = opts.seedAdmin ?? process.env.CONNECT_SEED_ADMIN;
  if (seed) {
    const [email, password] = seed.split(':');
    const r = await fetch(`http://127.0.0.1:${apiPort}/api/connect?action=bootstrap`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, bootstrapKey: env.CONNECT_BOOTSTRAP_KEY }) });
    if (!r.ok && r.status !== 409) throw new Error(`seed admin failed: ${r.status} ${await r.text()}`);
  }

  return {
    url: `http://127.0.0.1:${apiPort}`,
    peerPort: peer ? peerPort : null,
    env,
    async close() {
      await new Promise((r) => server.close(r));
      peer?.close?.();
      await db.close();
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const s = await startLocalConnect();
  console.log(`Braidata Connect (local) ${s.url}/api/connect · PeerServer ${s.peerPort ? `ws://127.0.0.1:${s.peerPort}/peerjs` : 'off'} · bootstrap key "${s.env.CONNECT_BOOTSTRAP_KEY}"`);
}
