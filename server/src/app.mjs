// HTTP routing on node:http. Small on purpose: auth, event ingestion, admin reads, the static
// dashboard. Every /admin route needs the admin role; /events needs any valid session.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as admin from './admin.mjs';
import * as auth from './auth.mjs';
import { ingest } from './events.mjs';
import { createLimiter } from './ratelimit.mjs';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const MAX_BODY = 2 * 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new auth.HttpError(413, 'body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new auth.HttpError(400, 'body must be JSON')); }
    });
    req.on('error', reject);
  });
}

export function createApp({ pool, config }) {
  const limiter = createLimiter({ windowMs: config.loginWindowMinutes * 60 * 1000 });
  const ctx = { pool, config, limiter };

  const send = (res, status, body, headers = {}) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
    res.end(data);
  };

  const clientIp = (req) => (config.trustProxy ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '') || req.socket.remoteAddress || 'unknown';

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const route = `${req.method} ${url.pathname}`;

    if (route === 'GET /healthz') {
      await pool.query('SELECT 1');
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && !url.pathname.startsWith('/admin') && !url.pathname.startsWith('/auth')) {
      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const file = path.join(PUBLIC, name);
      if (file.startsWith(PUBLIC) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; style-src 'self'; script-src 'self'" });
        return res.end(fs.readFileSync(file));
      }
      return send(res, 404, { error: 'not found' });
    }

    if (route === 'POST /auth/login') {
      const body = await readBody(req);
      return send(res, 200, await auth.login(ctx, { email: body.email, password: body.password, ip: clientIp(req) }));
    }
    if (route === 'POST /auth/accept-invite') {
      const body = await readBody(req);
      return send(res, 200, await auth.acceptInvite(ctx, body));
    }

    const header = String(req.headers.authorization || '');
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const user = await auth.authenticate(ctx, token);
    if (!user) return send(res, 401, { error: 'authentication required' });

    if (route === 'POST /auth/logout') {
      await auth.logout(ctx, token);
      return send(res, 200, { ok: true });
    }
    if (route === 'GET /auth/me') return send(res, 200, user);
    if (route === 'POST /events') return send(res, 200, await ingest(ctx, user, await readBody(req)));

    if (url.pathname.startsWith('/admin/')) {
      if (user.role !== 'admin') return send(res, 403, { error: 'admin role required' });
      const p = url.pathname;
      if (req.method === 'GET') {
        if (p === '/admin/summary') return send(res, 200, await admin.summary(pool));
        if (p === '/admin/stages') return send(res, 200, await admin.stageTimes(pool));
        if (p === '/admin/errors') return send(res, 200, await admin.errors(pool));
        if (p === '/admin/gates') return send(res, 200, await admin.gates(pool));
        if (p === '/admin/agent-failures') return send(res, 200, await admin.agentFailures(pool));
        if (p === '/admin/retries') return send(res, 200, await admin.retries(pool));
        if (p === '/admin/runs') return send(res, 200, await admin.runs(pool, url.searchParams.get('limit')));
        if (p.startsWith('/admin/runs/')) {
          const detail = await admin.runDetail(pool, decodeURIComponent(p.slice('/admin/runs/'.length)));
          return detail ? send(res, 200, detail) : send(res, 404, { error: 'run not found' });
        }
        if (p === '/admin/users') return send(res, 200, await admin.users(pool));
        if (p === '/admin/invites') return send(res, 200, await admin.invites(pool));
      }
      if (req.method === 'POST') {
        if (p === '/admin/invites') {
          const body = await readBody(req);
          return send(res, 200, await auth.createInvite(ctx, { email: body.email, invitedBy: user.id }));
        }
        const m = /^\/admin\/users\/([0-9a-f-]{36})\/disable$/.exec(p);
        if (m) return (await admin.disableUser(pool, m[1])) ? send(res, 200, { ok: true }) : send(res, 404, { error: 'no such non-admin user' });
      }
    }
    return send(res, 404, { error: 'not found' });
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (err instanceof auth.HttpError) {
        return send(res, err.status, { error: err.message }, err.extra.retryAfter ? { 'retry-after': String(err.extra.retryAfter) } : {});
      }
      process.stderr.write(`${err.stack || err}\n`);
      return send(res, 500, { error: 'internal error' });
    });
  });
}
