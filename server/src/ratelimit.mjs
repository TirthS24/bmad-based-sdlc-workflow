// Failed-login limiter, kept in memory. One server process is the supported shape; with several
// instances, move this to the database.
export function createLimiter({ windowMs, now = () => Date.now() }) {
  const fails = new Map();
  const live = (key) => {
    const list = (fails.get(key) || []).filter((t) => now() - t < windowMs);
    fails.set(key, list);
    return list;
  };
  return {
    blocked: (key, max) => live(key).length >= max,
    retryAfterSeconds: (key) => Math.max(1, Math.ceil((live(key)[0] + windowMs - now()) / 1000)),
    fail: (key) => { live(key).push(now()); },
    reset: (key) => fails.delete(key),
  };
}
