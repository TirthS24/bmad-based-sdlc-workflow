import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PASSWORD, startPostgres, startStack } from './helpers.mjs';

const BOOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'bootstrap-admin.mjs');
const pg = await startPostgres();
test.after(() => pg.stop());

test('login: success returns a token, failures look identical', async (t) => {
  const s = await startStack(pg.url);
  t.after(() => s.close());
  await s.admin('boss@example.com');
  const ok = await s.api('POST', '/auth/login', { body: { email: 'BOSS@example.com', password: PASSWORD } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.role, 'admin');
  assert.ok(ok.body.token.length > 30);
  assert.ok(Date.parse(ok.body.expires_at) > Date.now());
  const wrongPw = await s.api('POST', '/auth/login', { body: { email: 'boss@example.com', password: 'nope-nope-nope-1' } });
  const noUser = await s.api('POST', '/auth/login', { body: { email: 'ghost@example.com', password: 'nope-nope-nope-1' } });
  assert.equal(wrongPw.status, 401);
  assert.deepEqual(wrongPw.body, noUser.body, 'no hint about which emails exist');
});

test('login: only a hash of the password and of the session token is stored', async (t) => {
  const s = await startStack(pg.url);
  t.after(() => s.close());
  const { token } = await s.login(await (async () => { await s.admin('a@example.com'); return 'a@example.com'; })());
  const row = (await s.pool.query('SELECT password_hash FROM users')).rows[0];
  assert.match(row.password_hash, /^scrypt\$/);
  assert.ok(!row.password_hash.includes(PASSWORD));
  const stored = (await s.pool.query('SELECT token_hash FROM sessions')).rows.map((r) => r.token_hash);
  assert.ok(!stored.includes(token));
});

test('rate limit: repeated failures lock the account, even for the right password', async (t) => {
  const s = await startStack(pg.url, { loginMaxFailuresPerAccount: 3, loginMaxFailuresPerIp: 100 });
  t.after(() => s.close());
  await s.admin('limit@example.com');
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await s.api('POST', '/auth/login', { body: { email: 'limit@example.com', password: 'wrong-wrong-1234' } })).status, 401);
  }
  const locked = await s.api('POST', '/auth/login', { body: { email: 'limit@example.com', password: PASSWORD } });
  assert.equal(locked.status, 429);
  assert.ok(Number(locked.headers.get('retry-after')) >= 1);
});

test('rate limit: one address trying many accounts is limited', async (t) => {
  const s = await startStack(pg.url, { loginMaxFailuresPerAccount: 100, loginMaxFailuresPerIp: 4 });
  t.after(() => s.close());
  for (let i = 0; i < 4; i += 1) await s.api('POST', '/auth/login', { body: { email: `u${i}@example.com`, password: 'wrong-wrong-1234' } });
  assert.equal((await s.api('POST', '/auth/login', { body: { email: 'u9@example.com', password: 'wrong-wrong-1234' } })).status, 429);
});

test('invites: single use, expiring, and hashed at rest', async (t) => {
  const s = await startStack(pg.url);
  t.after(() => s.close());
  const adminToken = await s.admin();
  const inv = await s.api('POST', '/admin/invites', { token: adminToken, body: { email: 'new@example.com' } });
  assert.equal(inv.status, 200);
  const stored = (await s.pool.query('SELECT token_hash FROM invites')).rows[0].token_hash;
  assert.notEqual(stored, inv.body.token);

  assert.equal((await s.api('POST', '/auth/accept-invite', { body: { token: inv.body.token, password: 'short' } })).status, 400);
  assert.equal((await s.api('POST', '/auth/accept-invite', { body: { token: inv.body.token, password: PASSWORD } })).status, 200);
  const again = await s.api('POST', '/auth/accept-invite', { body: { token: inv.body.token, password: PASSWORD } });
  assert.equal(again.status, 400, 'reuse is refused');

  const old = await s.api('POST', '/admin/invites', { token: adminToken, body: { email: 'late@example.com' } });
  await s.pool.query("UPDATE invites SET expires_at = now() - interval '1 minute' WHERE email = 'late@example.com'");
  assert.equal((await s.api('POST', '/auth/accept-invite', { body: { token: old.body.token, password: PASSWORD } })).status, 400, 'expired');
  assert.equal((await s.api('POST', '/auth/accept-invite', { body: { token: 'garbage', password: PASSWORD } })).status, 400);
  assert.equal((await s.api('POST', '/admin/invites', { token: adminToken, body: { email: 'not-an-email' } })).status, 400);
});

test('invites: accepted users are workflow users, never admins', async (t) => {
  const s = await startStack(pg.url);
  t.after(() => s.close());
  const userToken = await s.user(await s.admin(), 'dev@example.com');
  assert.equal((await s.api('GET', '/auth/me', { token: userToken })).body.role, 'user');
});

test('password reset: re-inviting an existing email sets a new password and ends old sessions', async (t) => {
  const s = await startStack(pg.url);
  t.after(() => s.close());
  const adminToken = await s.admin();
  const oldToken = await s.user(adminToken, 'dev@example.com');
  const inv = await s.api('POST', '/admin/invites', { token: adminToken, body: { email: 'dev@example.com' } });
  const res = await s.api('POST', '/auth/accept-invite', { body: { token: inv.body.token, password: 'a brand new passphrase' } });
  assert.deepEqual(res.body, { email: 'dev@example.com', reset: true });
  assert.equal((await s.api('GET', '/auth/me', { token: oldToken })).status, 401);
  assert.equal((await s.api('POST', '/auth/login', { body: { email: 'dev@example.com', password: PASSWORD } })).status, 401);
  assert.equal((await s.api('POST', '/auth/login', { body: { email: 'dev@example.com', password: 'a brand new passphrase' } })).status, 200);
});

test('roles: anonymous gets 401, a workflow user gets 403, an admin gets through', async (t) => {
  const s = await startStack(pg.url);
  t.after(() => s.close());
  const adminToken = await s.admin();
  const userToken = await s.user(adminToken, 'dev@example.com');
  const routes = [
    ['GET', '/admin/summary'], ['GET', '/admin/stages'], ['GET', '/admin/errors'], ['GET', '/admin/gates'],
    ['GET', '/admin/agent-failures'], ['GET', '/admin/retries'], ['GET', '/admin/runs'], ['GET', '/admin/runs/x'],
    ['GET', '/admin/users'], ['GET', '/admin/invites'], ['POST', '/admin/invites'],
    ['POST', '/admin/users/00000000-0000-4000-8000-000000000001/disable'],
  ];
  for (const [method, route] of routes) {
    assert.equal((await s.api(method, route, { body: {} })).status, 401, `anon ${route}`);
    assert.equal((await s.api(method, route, { token: userToken, body: {} })).status, 403, `user ${route}`);
  }
  assert.equal((await s.api('GET', '/admin/summary', { token: adminToken })).status, 200);
  assert.equal((await s.api('GET', '/auth/me', { token: 'bogus' })).status, 401);
});

test('sessions: logout revokes, expiry ends, disabling a user ends their sessions', async (t) => {
  const s = await startStack(pg.url);
  t.after(() => s.close());
  const adminToken = await s.admin();
  const t1 = await s.user(adminToken, 'dev@example.com');
  assert.equal((await s.api('POST', '/auth/logout', { token: t1 })).status, 200);
  assert.equal((await s.api('GET', '/auth/me', { token: t1 })).status, 401);

  const t2 = (await s.login('dev@example.com')).token;
  await s.pool.query("UPDATE sessions SET expires_at = now() - interval '1 second'");
  assert.equal((await s.api('GET', '/auth/me', { token: t2 })).status, 401);

  const adminToken2 = (await s.login('admin@example.com')).token; // the expiry above ended every session
  const t3 = (await s.login('dev@example.com')).token;
  const id = (await s.pool.query("SELECT id FROM users WHERE email = 'dev@example.com'")).rows[0].id;
  assert.equal((await s.api('POST', `/admin/users/${id}/disable`, { token: adminToken2 })).status, 200);
  assert.equal((await s.api('GET', '/auth/me', { token: t3 })).status, 401);
  assert.equal((await s.api('POST', '/auth/login', { body: { email: 'dev@example.com', password: PASSWORD } })).status, 401);
  const adminId = (await s.pool.query("SELECT id FROM users WHERE role = 'admin'")).rows[0].id;
  assert.equal((await s.api('POST', `/admin/users/${adminId}/disable`, { token: adminToken2 })).status, 404, 'admins cannot be disabled through the API');
});

test('bootstrap: creates the first admin from stdin and rejects a short password', async (t) => {
  const s = await startStack(pg.url);
  t.after(() => s.close());
  const run = (password) => spawnSync(process.execPath, [BOOT, '--email', 'first@example.com'], { input: `${password}\n`, env: { ...process.env, DATABASE_URL: pg.url }, encoding: 'utf8' });
  const bad = run('short');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /at least 12/);
  const ok = run(PASSWORD);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /admin ready: first@example.com/);
  assert.equal((await s.login('first@example.com')).role, 'admin');
  assert.equal(spawnSync(process.execPath, [BOOT], { env: { ...process.env, DATABASE_URL: pg.url } }).status, 1);
});

test('health and unknown routes', async (t) => {
  const s = await startStack(pg.url);
  t.after(() => s.close());
  assert.equal((await s.api('GET', '/healthz')).status, 200);
  assert.equal((await s.api('GET', '/nope')).status, 404);
  assert.equal((await s.api('GET', '/../../etc/passwd')).status, 404);
});
