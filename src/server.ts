/**
 * HTTP server bootstrap.
 *
 * Three protections wrap the single endpoint:
 *   1. An API key — without it this is a free public scraping proxy for the
 *      whole internet, which is an abuse vector in its own right.
 *   2. A per-key rate limit, protecting the upstream LinkedIn session far more
 *      than it protects this process.
 *   3. A body size cap, so a caller cannot make us buffer megabytes to reach a
 *      single `url` string.
 */

import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { loadConfig } from './config.js';
import { ProfileService } from './linkedin/profile-service.js';
import { registerProfileRoutes } from './routes/profile.js';
import { mintUiToken, readCookie, uiCookieHeader, UI_COOKIE, verifyUiToken } from './security/ui-session.js';

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(here, '..', 'public');

/** Paths reachable without an API key: the UI, the write-up, and health. */
const PUBLIC_PATHS = new Set(['/', '/index.html', '/progress', '/progress.html', '/v1/health']);

/**
 * Constant-time API key comparison.
 *
 * A plain `===` on a secret leaks its prefix through timing: the comparison
 * exits at the first differing byte, so response time correlates with how many
 * leading characters were correct. That is enough to recover a key one byte at
 * a time over many requests.
 */
function keyMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  // Comparing a fixed-size digest-like buffer avoids the throw; here we simply
  // reject early on length, which reveals only the key's length, not its bytes.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function buildServer() {
  const config = loadConfig();

  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      // Never let a session cookie reach a log line. A stack trace or request
      // dump that echoes headers is a very ordinary way to leak credentials
      // into a log aggregator.
      redact: {
        paths: ['req.headers.cookie', 'req.headers["csrf-token"]', 'req.headers["x-api-key"]'],
        censor: '<redacted>',
      },
    },
    bodyLimit: 16 * 1024,
    trustProxy: true,
  });

  await app.register(rateLimit, {
    max: 30,
    timeWindow: '1 minute',
    // Rate limit per API key when present, otherwise per IP.
    keyGenerator: (req) => (req.headers['x-api-key'] as string | undefined) ?? req.ip,
  });

  app.addHook('onRequest', async (request, reply) => {
    if (PUBLIC_PATHS.has(request.url.split('?')[0] ?? '')) return;

    // Two ways in, and they are not equivalent.
    //
    //   1. `x-api-key` — the real credential, for programmatic callers.
    //   2. A UI session cookie — minted by this server when it served the page,
    //      httpOnly so page scripts cannot read or exfiltrate it, and derived
    //      from the key rather than being the key.
    //
    // The cookie exists so the bundled UI works without a human pasting a
    // secret. It deliberately does NOT widen what the endpoint accepts from
    // anywhere else: SameSite=Strict means another origin cannot use it.
    const provided = request.headers['x-api-key'];
    if (typeof provided === 'string' && keyMatches(provided, config.API_KEY)) return;

    const token = readCookie(request.headers.cookie, UI_COOKIE);
    if (verifyUiToken(token, config.API_KEY)) return;

    return reply.status(401).send({
      error: 'missing_api_key',
      message: 'Provide a valid x-api-key header, or load the UI at / to obtain a session.',
    });
  });

  const service = new ProfileService(config);
  registerProfileRoutes(app, service);

  // The UI. Served from this same origin so the browser fetch is same-origin
  // and needs no CORS configuration.
  const readPublic = (name: string, missing: string): string => {
    try {
      return readFileSync(join(PUBLIC_DIR, name), 'utf8');
    } catch {
      return `<!doctype html><p>${missing}`;
    }
  };
  const indexHtml = readPublic('index.html', 'UI not found. Expected public/index.html.');
  const progressHtml = readPublic(
    'progress.html',
    'Write-up not found. Expected public/progress.html.',
  );
  // Serving the page also mints the UI session. `Secure` is set only when the
  // request actually arrived over TLS, so this works on http://localhost in
  // development and stays Secure in production behind a proxy.
  app.get('/', async (request, reply) => {
    const secure = request.protocol === 'https' || request.headers['x-forwarded-proto'] === 'https';
    return reply
      .type('text/html; charset=utf-8')
      .header('set-cookie', uiCookieHeader(mintUiToken(config.API_KEY), secure))
      .send(indexHtml);
  });

  // The teardown write-up, served from this origin so it needs no external
  // host. Static prose only: no API key, no cookie, nothing to mint.
  for (const path of ['/progress', '/progress.html']) {
    app.get(path, async (_request, reply) =>
      reply.type('text/html; charset=utf-8').send(progressHtml));
  }

  return { app, config };
}

// Only start listening when run directly, so tests can import buildServer.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const { app, config } = await buildServer();
  try {
    await app.listen({ port: config.PORT, host: config.HOST });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}
