// Server settings, all from the environment so one build runs anywhere.
export function loadConfig(env = process.env) {
  const num = (k, d) => (env[k] ? Number(env[k]) : d);
  return {
    databaseUrl: env.DATABASE_URL || '',
    port: num('PORT', 8787),
    poolMax: num('DB_POOL_MAX', 10),
    sessionTtlHours: num('SESSION_TTL_HOURS', 168),
    inviteTtlHours: num('INVITE_TTL_HOURS', 72),
    minPasswordLength: num('MIN_PASSWORD_LENGTH', 12),
    loginMaxFailuresPerAccount: num('LOGIN_MAX_FAILURES_ACCOUNT', 5),
    loginMaxFailuresPerIp: num('LOGIN_MAX_FAILURES_IP', 30),
    loginWindowMinutes: num('LOGIN_WINDOW_MINUTES', 15),
    maxBatch: num('MAX_EVENT_BATCH', 500),
    // Only set behind a trusted reverse proxy; otherwise the socket address is the client.
    trustProxy: env.TRUST_PROXY === '1',
  };
}
