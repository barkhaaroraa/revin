/**
 * Orchestration: slug in, validated ProfileResponse out.
 *
 * Everything upstream-facing funnels through here, which is what makes the
 * caching and pacing guarantees actually hold — there is exactly one path to
 * LinkedIn in the whole application.
 */

import type { Config } from '../config.js';
import { TtlCache, UpstreamGate } from '../cache.js';
import { ProfileResponseSchema, type ProfileResponse } from '../schema.js';
import { extractProfile, type RawProfileResponses } from './extract.js';
import { UpstreamError, VoyagerClient } from './client.js';
import type { TripReason } from '../security/circuit-breaker.js';
import { FETCHED_COLLECTIONS, type CollectionKey } from './queries.js';

/** Sections fetched for every profile request. See FETCHED_COLLECTIONS. */
const SECTIONS: readonly CollectionKey[] = FETCHED_COLLECTIONS;

export class ProfileService {
  private readonly cache: TtlCache<ProfileResponse>;
  private readonly gate: UpstreamGate;

  constructor(
    private readonly config: Config,
    private readonly client: VoyagerClient = new VoyagerClient(config),
  ) {
    this.cache = new TtlCache<ProfileResponse>(config.CACHE_TTL_SECONDS * 1000);
    this.gate = new UpstreamGate(config.UPSTREAM_MIN_INTERVAL_MS, config.UPSTREAM_JITTER_MS);
  }

  /**
   * Human-initiated "resume" after a hard block. Closes the breaker so the next
   * request is allowed through again, and reports exactly what is being
   * cleared. This is the counterpart to the breakpoint: the system stops on a
   * 999 / access-denied and will not touch LinkedIn again until this is called.
   */
  resumeUpstream(): { resumed: boolean; cleared: TripReason | null } {
    const cleared = this.client.circuitBreaker.reset();
    return { resumed: cleared !== null, cleared };
  }

  /** Current breaker state, for an operator status check. */
  upstreamStatus() {
    return this.client.circuitBreaker.state();
  }

  async getProfile(slug: string): Promise<ProfileResponse> {
    const cached = this.cache.get(slug);
    if (cached) return { ...cached, cached: true };

    // The gate both serializes and paces. Concurrent callers queue here rather
    // than multiplying our upstream request rate.
    const response = await this.gate.run(() => this.fetchAndExtract(slug));

    this.cache.set(slug, response);
    return response;
  }

  private async fetchAndExtract(slug: string): Promise<ProfileResponse> {
    this.client.beginProfileView(slug);

    // Step 1. The GraphQL vanityName query is the only one that accepts a
    // human-readable slug, so it is the unavoidable entry point — everything
    // after it is keyed by the URN this returns. A failure here is fatal.
    const core = await this.client.fetchProfileByVanity(slug);
    const profileUrn = findProfileUrn(core, slug);
    if (!profileUrn) {
      throw new UpstreamError(
        'profile_not_found',
        'no profile URN in the response — the profile may not exist, may be private, or the queryId has rotated',
      );
    }

    const failed: Array<{ section: string; reason: string }> = [];

    // Step 2. The Rest.li scalar record. Non-fatal: it only adds `summary`,
    // `industry` and richer location on top of what step 1 already gave us.
    let fullProfile: unknown;
    try {
      fullProfile = await this.client.fetchFullProfile(profileUrn);
    } catch (err) {
      failed.push({ section: 'fullProfile', reason: describe(err) });
    }

    // Step 3. Sections, sequentially and in the order a browser would request
    // them. Sequential rather than parallel on purpose: a burst of a dozen
    // simultaneous connections is a far stronger bot signal than a browser's
    // naturally staggered fetches.
    const collections: Partial<Record<CollectionKey, unknown>> = {};
    for (const key of SECTIONS) {
      try {
        collections[key] = await this.client.fetchCollection(profileUrn, key);
      } catch (err) {
        failed.push({ section: key, reason: describe(err) });
        // A hard block means stop. Continuing to hammer a flagged session is
        // how an account goes from challenged to banned.
        if (err instanceof UpstreamError && (err.kind === 'blocked_by_linkedin' || err.kind === 'session_expired')) {
          throw err;
        }
      }
      await sleep(150 + Math.random() * 500);
    }

    const raw: RawProfileResponses = { core, fullProfile, collections, failed };
    const { profile, coverage } = extractProfile(raw, slug);

    // Validate our own output at the boundary. An extractor bug should surface
    // here as a 500 we can diagnose, not as a malformed body a caller has to
    // reverse engineer.
    return ProfileResponseSchema.parse({
      source: 'mixed',
      fetchedAt: new Date().toISOString(),
      cached: false,
      profile,
      coverage,
    });
  }
}

function describe(err: unknown): string {
  if (err instanceof UpstreamError) return `${err.kind}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Locate the requested profile's URN in a normalized response. */
export function findProfileUrn(body: unknown, slug: string): string | undefined {
  const included = (body as { included?: unknown[] } | null)?.included;
  if (!Array.isArray(included)) return undefined;

  const profiles = included.filter(
    (x): x is Record<string, unknown> =>
      typeof x === 'object' && x !== null && String((x as Record<string, unknown>)['$type'] ?? '').endsWith('profile.Profile'),
  );

  // The response also contains OUR OWN profile (the viewer), so match on the
  // requested slug rather than taking the first Profile entity we find.
  const match = profiles.find((p) => p['publicIdentifier'] === slug);
  const urn = match?.['entityUrn'];
  return typeof urn === 'string' ? urn : undefined;
}
