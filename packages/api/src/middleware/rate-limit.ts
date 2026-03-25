/**
 * Simple in-memory sliding window rate limiter for Hono.
 * Tracks request counts per IP within a configurable time window.
 */
import type { Context, Next } from "hono";

interface RateLimitOpts {
  windowMs?: number;
  max?: number;
}

interface WindowEntry {
  timestamps: number[];
}

const store = new Map<string, WindowEntry>();

// Periodic cleanup every 60s to prevent memory leaks
setInterval(() => {
  const now = Date.now();
  [...store.entries()].forEach(([key, entry]) => {
    entry.timestamps = entry.timestamps.filter((t) => now - t < 120_000);
    if (entry.timestamps.length === 0) store.delete(key);
  });
}, 60_000).unref();

function getClientIp(c: Context): string {
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip") || "unknown";
}

/**
 * Create a rate limiting middleware.
 * @param windowMs — Time window in ms (default 60_000 = 1 minute)
 * @param max — Max requests per window per IP (default 60)
 */
export function rateLimit(opts: RateLimitOpts = {}) {
  const { windowMs = 60_000, max = 60 } = opts;

  return async (c: Context, next: Next) => {
    const ip = getClientIp(c);
    const now = Date.now();
    const key = ip;

    const entry =
      store.get(key) ??
      (() => {
        const newEntry = { timestamps: [] as number[] };
        store.set(key, newEntry);
        return newEntry;
      })();

    // Remove timestamps outside the window
    entry.timestamps = entry.timestamps.filter((t) => now - t < windowMs);

    if (entry.timestamps.length >= max) {
      c.header("Retry-After", String(Math.ceil(windowMs / 1000)));
      return c.json({ error: "Too many requests" }, 429);
    }

    entry.timestamps.push(now);
    await next();
  };
}
