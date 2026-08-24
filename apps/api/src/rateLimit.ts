import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * A small, dependency-free fixed-window rate limiter -- Part 30's "rate
 * limits" requirement. Deliberately hand-rolled rather than pulling in
 * `express-rate-limit`: the policy is trivial (N requests per window per
 * client key) and a real dependency buys nothing beyond what 20 lines
 * already cover, for a single-process server with in-memory state (the
 * same "no persistence here by design" precedent every other in-memory
 * store in this codebase already follows).
 *
 * Keyed by IP first, not `x-naqsh-user` -- `x-naqsh-user` (see auth.ts) is
 * an unsigned, client-supplied header with no verification behind it, so
 * keying on it FIRST let any caller defeat the limit entirely by sending
 * a fresh random value on every single request (each one landing in a
 * brand-new, never-before-seen bucket). IP is still spoofable at scale by
 * a real distributed attacker, but it is not trivially defeated by
 * changing one request header, which is the actual, cheap bypass this
 * limiter exists to prevent. Falls back to the identity header only when
 * no IP is available at all (e.g. a unix-socket-only deployment), and to
 * a shared `"unknown"` bucket only if neither exists.
 */
export interface RateLimitOptions {
  windowMs: number;
  maxRequests: number;
}

export function createRateLimiter(options: RateLimitOptions): RequestHandler {
  const hits = new Map<string, { count: number; windowStart: number }>();

  // Without this, `hits` grows by one entry for every DISTINCT client key
  // this process has EVER seen and never shrinks -- fine for a handful of
  // test requests, a genuine unbounded-memory-growth bug for a server
  // meant to serve a large, ever-changing population of real clients over
  // a long-running process's lifetime. A key past its own window is stale
  // by definition (the very check below would reset it on its next
  // request anyway) and safe to drop outright. `.unref()` so this timer
  // alone never keeps the process (or a test's `Server.close()`) alive.
  const sweepIntervalMs = Math.max(options.windowMs, 1000);
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (now - entry.windowStart >= options.windowMs) hits.delete(key);
    }
  }, sweepIntervalMs);
  sweep.unref();

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.ip || req.header("x-naqsh-user")?.trim() || "unknown";
    const now = Date.now();
    const entry = hits.get(key);

    if (!entry || now - entry.windowStart >= options.windowMs) {
      hits.set(key, { count: 1, windowStart: now });
      next();
      return;
    }

    entry.count += 1;
    if (entry.count > options.maxRequests) {
      const retryAfterSeconds = Math.ceil((entry.windowStart + options.windowMs - now) / 1000);
      res.setHeader("Retry-After", String(Math.max(retryAfterSeconds, 1)));
      res.status(429).json({ error: { kind: "rate_limited", message: `Too many requests -- try again in ${Math.max(retryAfterSeconds, 1)}s.` } });
      return;
    }
    next();
  };
}
