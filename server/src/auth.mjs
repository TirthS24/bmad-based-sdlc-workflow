// Accounts, sessions and invites. Every failure to log in looks the same from outside.
import { DUMMY_HASH, hashPassword, hashToken, newToken, verifyPassword } from './crypto.mjs';

export class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

const hours = (h) => new Date(Date.now() + h * 3600 * 1000);

export async function login({ pool, config, limiter }, { email, password, ip }) {
  const acct = `acct:${String(email).toLowerCase()}`;
  const byIp = `ip:${ip}`;
  if (limiter.blocked(acct, config.loginMaxFailuresPerAccount) || limiter.blocked(byIp, config.loginMaxFailuresPerIp)) {
    const key = limiter.blocked(acct, config.loginMaxFailuresPerAccount) ? acct : byIp;
    throw new HttpError(429, 'too many failed logins; try again later', { retryAfter: limiter.retryAfterSeconds(key) });
  }
  const { rows } = await pool.query('SELECT * FROM users WHERE lower(email) = lower($1)', [String(email)]);
  const user = rows[0];
  const ok = await verifyPassword(String(password), user ? user.password_hash : DUMMY_HASH);
  if (!user || user.disabled_at || !ok) {
    limiter.fail(acct);
    limiter.fail(byIp);
    throw new HttpError(401, 'invalid email or password');
  }
  limiter.reset(acct);
  const token = newToken();
  const expires = hours(config.sessionTtlHours);
  await pool.query('INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)', [user.id, hashToken(token), expires]);
  return { token, expires_at: expires.toISOString(), role: user.role };
}

export async function logout({ pool }, token) {
  await pool.query('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [hashToken(token)]);
}

// Returns { id, email, role } for a live session, else null.
export async function authenticate({ pool }, token) {
  if (!token) return null;
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.role FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.disabled_at IS NULL`,
    [hashToken(token)],
  );
  return rows[0] || null;
}

export async function createInvite({ pool, config }, { email, invitedBy }) {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email))) throw new HttpError(400, 'a valid email is required');
  const token = newToken();
  const expires = hours(config.inviteTtlHours);
  await pool.query('INSERT INTO invites (email, token_hash, invited_by, expires_at) VALUES ($1, $2, $3, $4)', [String(email).toLowerCase(), hashToken(token), invitedBy, expires]);
  return { token, email: String(email).toLowerCase(), expires_at: expires.toISOString() };
}

// A new email creates a user. An existing email gets a new password: that is the reset flow, and
// it revokes every session the account had.
export async function acceptInvite({ pool, config }, { token, password }) {
  if (String(password || '').length < config.minPasswordLength) {
    throw new HttpError(400, `password must be at least ${config.minPasswordLength} characters`);
  }
  const hash = await hashPassword(String(password));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM invites WHERE token_hash = $1 FOR UPDATE', [hashToken(String(token))]);
    const invite = rows[0];
    if (!invite || invite.used_at || new Date(invite.expires_at) < new Date()) throw new HttpError(400, 'invite is invalid, used or expired');
    const existing = (await client.query('SELECT id FROM users WHERE lower(email) = lower($1)', [invite.email])).rows[0];
    if (existing) {
      await client.query('UPDATE users SET password_hash = $1, disabled_at = NULL WHERE id = $2', [hash, existing.id]);
      await client.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [existing.id]);
    } else {
      await client.query("INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'user')", [invite.email, hash]);
    }
    await client.query('UPDATE invites SET used_at = now() WHERE id = $1', [invite.id]);
    await client.query('COMMIT');
    return { email: invite.email, reset: Boolean(existing) };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Used by the bootstrap command, never by the API.
export async function createAdmin(pool, { email, password, minLength = 12 }) {
  if (String(password || '').length < minLength) throw new Error(`password must be at least ${minLength} characters`);
  const hash = await hashPassword(password);
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'admin')
     ON CONFLICT ((lower(email))) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'admin', disabled_at = NULL
     RETURNING id`,
    [String(email).toLowerCase(), hash],
  );
  return rows[0].id;
}
