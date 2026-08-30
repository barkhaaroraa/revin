/**
 * POST /v1/profile — the one endpoint.
 *
 * The error taxonomy here is deliberate. Every distinct failure gets its own
 * code and status rather than collapsing into a generic 500, because the
 * caller's correct response differs in each case: a bad URL is their bug, a
 * rotated queryId is ours, and a checkpoint means a human has to go log in.
 */

import type { FastifyInstance } from 'fastify';
import { guardProfileUrl } from '../security/url-guard.js';
import { SsrfBlockedError } from '../security/ssrf-agent.js';
import { UpstreamError } from '../linkedin/client.js';
import type { ProfileService } from '../linkedin/profile-service.js';

interface ProfileBody {
  url?: unknown;
}

/** Upstream failure -> HTTP status + caller-facing guidance. */
const UPSTREAM_STATUS: Record<string, { status: number; hint: string }> = {
  profile_not_found: {
    status: 404,
    hint: 'No such public profile, or it is not visible to the configured session.',
  },
  session_expired: {
    status: 503,
    hint: 'The server-side LinkedIn session is invalid or expired. An operator must re-capture a HAR while logged in and run `npx tsx src/tools/sync-cookies.ts <capture.har>` — hand-copying LINKEDIN_LI_AT is what this failure usually is.',
  },
  blocked_by_linkedin: {
    status: 503,
    hint: 'LinkedIn is blocking this session (bot detection or a checkpoint challenge). Retrying will make it worse.',
  },
  upstream_rate_limited: {
    status: 429,
    hint: 'LinkedIn rate limited the upstream session. Back off before retrying.',
  },
  upstream_timeout: { status: 504, hint: 'LinkedIn did not respond in time.' },
  upstream_unexpected: {
    status: 502,
    // This hint used to assert the queryId had rotated. That is one cause among
    // several, and stating it as the likely one sent a real investigation off
    // after the wrong suspect while the actual message (a redirect) was saying
    // something else entirely. Name the causes, and point at the log line that
    // distinguishes them.
    hint: 'LinkedIn returned something this client does not recognise — a rotated queryId, an unhandled redirect, or a changed response shape. The server log carries the specific signal.',
  },
};

export function registerProfileRoutes(app: FastifyInstance, service: ProfileService): void {
  app.post<{ Body: ProfileBody }>('/v1/profile', async (request, reply) => {
    // SSRF Layer 1. The submitted URL is parsed and DISCARDED; only the
    // validated slug survives, and the upstream URL is rebuilt from a
    // hardcoded template. The caller's string never becomes a fetch target.
    const guarded = guardProfileUrl(request.body?.url);
    if (!guarded.ok) {
      return reply.status(400).send({
        error: guarded.code,
        message: guarded.reason,
        hint: 'Expected a URL like https://www.linkedin.com/in/<vanity-name>',
      });
    }

    try {
      const result = await service.getProfile(guarded.slug);
      return reply.status(200).send({ ...result, requested: guarded.canonicalUrl });
    } catch (err) {
      // Should be unreachable given Layer 1, but if it ever fires it means a
      // guard was bypassed — worth its own loud, distinct signal.
      if (err instanceof SsrfBlockedError) {
        request.log.error({ event: 'ssrf_blocked' }, err.message);
        return reply.status(502).send({ error: 'blocked_egress', message: 'Refused to connect to a non-public address.' });
      }

      if (err instanceof UpstreamError) {
        const mapped = UPSTREAM_STATUS[err.kind] ?? { status: 502, hint: 'Unexpected upstream failure.' };
        // Log block/session failures at error level: they need an operator.
        const level = mapped.status >= 503 ? 'error' : 'warn';
        request.log[level]({ event: err.kind, status: err.status }, err.message);
        return reply.status(mapped.status).send({ error: err.kind, message: err.message, hint: mapped.hint });
      }

      request.log.error({ err }, 'unhandled failure in /v1/profile');
      return reply.status(500).send({ error: 'internal_error', message: 'Unexpected server error.' });
    }
  });

  app.get('/v1/health', async () => ({ status: 'ok', time: new Date().toISOString() }));

  // --- Operator controls for the upstream breakpoint. ---
  //
  // When LinkedIn hard-blocks the session (999 / checkpoint / access-denied),
  // the breaker opens and the server stops sending upstream requests entirely.
  // These two routes are how a human inspects that and, deliberately by hand,
  // authorises resuming — "don't send requests without asking me" made into an
  // explicit switch. Both sit behind the same x-api-key gate as everything else.

  /** Inspect the breaker without changing it. */
  app.get('/v1/admin/status', async (_request, reply) => {
    return reply.status(200).send({ upstream: service.upstreamStatus() });
  });

  /**
   * Resume upstream requests after a hard block. This is the ONLY thing that
   * closes the breaker — nothing re-enables itself automatically, on purpose.
   */
  app.post('/v1/admin/resume', async (request, reply) => {
    const result = service.resumeUpstream();
    if (result.resumed) {
      request.log.warn({ event: 'upstream_resumed', cleared: result.cleared }, 'operator resumed upstream after a hard block');
      return reply.status(200).send({
        resumed: true,
        message: 'Upstream breaker cleared. The next request will be sent to LinkedIn.',
        cleared: result.cleared,
      });
    }
    return reply.status(200).send({
      resumed: false,
      message: 'Breaker was already closed; nothing to resume.',
    });
  });
}
