/**
 * Environment configuration, validated once at startup.
 *
 * Fail-fast on purpose: a missing `li_at` should crash the process on boot with
 * a clear message, not surface later as a mysterious 302-to-login on the first
 * request. Config errors are cheapest to diagnose at the moment of failure.
 *
 * Load with Node's built-in flag — no dotenv dependency needed:
 *   node --env-file=.env ...
 *   tsx --env-file=.env ...
 */

import { z } from 'zod';

const EnvSchema = z.object({
  /**
   * The LinkedIn session cookie. This IS the session — anyone holding it is
   * logged in as that account, so it must never be logged, echoed in an error,
   * or committed.
   */
  LINKEDIN_LI_AT: z.string().min(20, 'LINKEDIN_LI_AT looks too short to be a real session cookie'),

  /**
   * Raw JSESSIONID cookie value, quotes included: "ajax:1234567890123456789".
   * We keep the quotes because the Cookie header must reproduce the value
   * byte-for-byte; the csrf-token header uses the unquoted form instead.
   */
  LINKEDIN_JSESSIONID: z
    .string()
    .refine((v) => v.includes('ajax:'), 'LINKEDIN_JSESSIONID must contain "ajax:" — copy the value exactly as DevTools shows it'),

  /**
   * Optional: the complete Cookie header the browser sent, verbatim.
   *
   * `li_at` + `JSESSIONID` is usually sufficient, but LinkedIn sends ~28
   * cookies and some (notably `lidc`, which pins you to a datacenter) affect
   * routing and session validation. When we have a known-good header from a
   * capture, replaying it exactly removes a whole class of guesswork.
   */
  LINKEDIN_COOKIE: z.string().optional(),

  /**
   * The User-Agent and `x-li-track` blob of the browser that minted the
   * session, replayed verbatim.
   *
   * `x-li-track` is a JSON device descriptor (clientVersion, timezone, display
   * metrics). It is part of how LinkedIn recognises a client as coherent: a
   * session created by Firefox on Linux that suddenly presents a Chrome UA and
   * no device blob is trivially anomalous. Consistency matters more than which
   * particular browser we claim to be.
   */
  LINKEDIN_USER_AGENT: z.string().optional(),
  LINKEDIN_X_LI_TRACK: z.string().optional(),

  /** Callers of OUR api must present this as `x-api-key`. */
  API_KEY: z.string().min(16, 'API_KEY must be at least 16 characters'),

  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  CACHE_TTL_SECONDS: z.coerce.number().int().nonnegative().default(3600),

  /**
   * Minimum gap between two *profile* fetches, jittered upward.
   *
   * Deliberately NOT applied between the individual section requests of a
   * single profile. A real browser fires a profile's ~8 queries within about
   * two seconds and then goes quiet; spacing every request uniformly is a
   * signature no human produces. So: burst within a profile, pause between
   * profiles.
   */
  UPSTREAM_MIN_INTERVAL_MS: z.coerce.number().int().nonnegative().default(40_000),
  UPSTREAM_JITTER_MS: z.coerce.number().int().nonnegative().default(15_000),

  /**
   * Optional path where an open circuit breaker is recorded, so a hard block
   * survives a restart.
   *
   * Unset (the default) means the breaker is in-memory only — fine for local
   * development, wrong for anything hosted: a crash-loop or a redeploy would
   * silently clear a trip and resume sending requests with a flagged account.
   * Point this at a durable volume in production.
   */
  BREAKER_STATE_FILE: z.string().min(1).optional(),
});

export type Config = z.infer<typeof EnvSchema>;

let cached: Config | undefined;

export function loadConfig(): Config {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}\n\nDid you copy .env.example to .env?`);
  }
  cached = parsed.data;
  return cached;
}

/**
 * Redact anything that looks like a credential before it reaches a log line.
 * A stack trace that echoes request headers is a very common way to leak a
 * session cookie into a log aggregator.
 */
export function redact(text: string): string {
  return text
    .replace(/li_at=[^;\s"]+/g, 'li_at=<redacted>')
    .replace(/ajax:\d+/g, 'ajax:<redacted>')
    .replace(/JSESSIONID="?[^;\s"]+"?/g, 'JSESSIONID=<redacted>');
}
