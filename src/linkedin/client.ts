/**
 * The Voyager HTTP client: builds Rest.li-shaped requests, classifies failures
 * honestly, and never lets a redirect escape the SSRF policy.
 */

import { fetch } from 'undici';
import { MAX_RESPONSE_BYTES, readCapped, safeAgent, SsrfBlockedError } from '../security/ssrf-agent.js';
import { checkIp } from '../security/ip-rules.js';
import { redact, type Config } from '../config.js';
import { buildSession, newPageInstance, type Session } from './session.js';
import {
  DECORATION_FULL_PROFILE,
  PROFILE_COLLECTIONS,
  QUERY_PROFILE_BY_VANITY,
  QUERY_PROFILE_CARDS,
  SECTION_TYPES,
  VOYAGER_BASE,
  type CollectionKey,
  type SectionKey,
} from './queries.js';

export type UpstreamFailure =
  | 'blocked_by_linkedin'
  | 'session_expired'
  | 'profile_not_found'
  | 'upstream_rate_limited'
  | 'upstream_timeout'
  | 'upstream_unexpected';

export class UpstreamError extends Error {
  override readonly name = 'UpstreamError';
  constructor(
    readonly kind: UpstreamFailure,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/**
 * Build a Rest.li query string.
 *
 * This CANNOT use URLSearchParams. Rest.li's parameter grammar is
 * `(key:value,list:List(a,b))`, and the STRUCTURAL `(`, `)`, `:` and `,` must
 * survive as literal characters. URLSearchParams percent-encodes all of them,
 * producing `%28vanityName%3Aslug%29`, which LinkedIn rejects.
 */
function restliQuery(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

/**
 * Escape a VALUE for embedding inside the Rest.li parameter grammar.
 *
 * This is the half that is easy to get wrong, and getting it wrong yields a
 * flat HTTP 400. The grammar's own delimiters stay raw, but any reserved
 * character appearing *inside a value* must be percent-encoded — otherwise the
 * parser cannot tell data from structure.
 *
 * It matters here because URNs are full of colons. A profile URN embedded raw:
 *
 *   (profileUrn:urn:li:fsd_profile:ACoAA...,sectionType:EXPERIENCE)   -> 400
 *
 * is ambiguous, because `:` is the key/value separator. Correctly escaped:
 *
 *   (profileUrn:urn%3Ali%3Afsd_profile%3AACoAA...,sectionType:EXPERIENCE)  -> 200
 *
 * Verified against a real browser request rather than reasoned about — the
 * browser encodes exactly these four characters and nothing else.
 */
export function restliValue(value: string): string {
  return value
    .replace(/%/g, '%25')
    .replace(/:/g, '%3A')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/,/g, '%2C');
}

export class VoyagerClient {
  private session: Session;

  constructor(private readonly config: Config) {
    this.session = buildSession(config);
  }

  /**
   * Enter a profile "page view".
   *
   * A browser fetching a profile's sections sends the profile URL as Referer
   * and reuses ONE `x-li-page-instance` for every request belonging to that
   * navigation. Mirroring that makes the burst read as a single coherent page
   * load rather than a set of unrelated scripted calls.
   */
  beginProfileView(slug: string): void {
    this.session = buildSession(this.config, {
      referer: `https://www.linkedin.com/in/${encodeURIComponent(slug)}/`,
      pageInstance: newPageInstance('d_flagship3_profile_view_base'),
    });
  }

  /**
   * Perform one GET against Voyager.
   *
   * Redirects are handled manually. undici is configured with
   * `maxRedirections: 0`, so a 3xx arrives here as a normal response and we
   * decide what it means. For Voyager a redirect is never legitimate data —
   * it is LinkedIn telling us the session is dead or that we have been
   * challenged — so we classify rather than follow. That also means the
   * classic `302 -> http://169.254.169.254/` SSRF pivot has nowhere to go.
   */
  private async get(path: string, params: Record<string, string>): Promise<unknown> {
    const url = `${VOYAGER_BASE}${path}?${restliQuery(params)}`;

    let res;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: this.session.headers,
        redirect: 'manual',
        dispatcher: safeAgent,
      });
    } catch (err) {
      if (err instanceof SsrfBlockedError) throw err;
      const msg = redact(err instanceof Error ? err.message : String(err));
      if (/timeout|timed out/i.test(msg)) {
        throw new UpstreamError('upstream_timeout', `voyager request timed out: ${msg}`);
      }
      throw new UpstreamError('upstream_unexpected', `voyager request failed: ${msg}`);
    }

    // --- Failure classification. Each signal means something specific. ---

    // 999 is LinkedIn's long-standing "we think you are a bot" status. It is
    // not in any RFC; it is theirs.
    if (res.status === 999) {
      throw new UpstreamError('blocked_by_linkedin', 'LinkedIn returned 999 (bot detection)', 999);
    }
    if (res.status === 429) {
      throw new UpstreamError('upstream_rate_limited', 'LinkedIn rate limited this session', 429);
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location') ?? '';
      // A redirect to the login page means li_at is dead or revoked.
      if (/\/uas\/login|\/login|\/authwall/.test(location)) {
        throw new UpstreamError('session_expired', 'redirected to login — li_at is invalid or expired', res.status);
      }
      // A checkpoint means the ACCOUNT has been flagged and now needs a
      // human CAPTCHA. Retrying makes this worse, so we surface it loudly.
      if (/\/checkpoint/.test(location)) {
        throw new UpstreamError('blocked_by_linkedin', 'redirected to a checkpoint challenge — the account is flagged', res.status);
      }
      // Any other redirect target is re-validated against the SSRF policy
      // before we would ever consider following it.
      throw new UpstreamError('upstream_unexpected', `unexpected redirect to ${describeRedirect(location)}`, res.status);
    }
    if (res.status === 404) {
      throw new UpstreamError('profile_not_found', 'voyager returned 404', 404);
    }
    if (res.status === 403) {
      throw new UpstreamError('session_expired', 'voyager returned 403 — csrf-token/cookie mismatch or dead session', 403);
    }
    if (!res.ok) {
      throw new UpstreamError('upstream_unexpected', `voyager returned HTTP ${res.status}`, res.status);
    }

    const text = await readCapped(res.body as ReadableStream<Uint8Array> | null, MAX_RESPONSE_BYTES);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new UpstreamError('upstream_unexpected', 'voyager response was not valid JSON');
    }
  }

  /** Step 1: vanity slug -> core profile (and, critically, the profile URN). */
  async fetchProfileByVanity(slug: string): Promise<unknown> {
    return this.get('/graphql', {
      includeWebMetadata: 'true',
      variables: `(vanityName:${slug})`,
      queryId: QUERY_PROFILE_BY_VANITY,
    });
  }

  /**
   * The full profile scalar record via Rest.li.
   *
   * Worth having alongside the GraphQL core query because this projection
   * includes `summary` — the About section — which the vanityName GraphQL
   * query does not return at all.
   */
  async fetchFullProfile(profileUrn: string): Promise<unknown> {
    return this.get(`/identity/dash/profiles/${restliValue(profileUrn)}`, {
      decorationId: DECORATION_FULL_PROFILE,
    });
  }

  /**
   * One profile sub-collection (positions, educations, skills, ...).
   *
   * `q=viewee` selects the Rest.li finder that scopes the collection to the
   * profile being viewed rather than the viewer.
   */
  async fetchCollection(profileUrn: string, collection: CollectionKey): Promise<unknown> {
    return this.get(`/identity/dash/${PROFILE_COLLECTIONS[collection]}`, {
      q: 'viewee',
      profileUrn: restliValue(profileUrn),
    });
  }

  /** Legacy GraphQL card route. Kept as a fallback; returns a UI component tree. */
  async fetchCard(profileUrn: string, section: SectionKey): Promise<unknown> {
    return this.get('/graphql', {
      includeWebMetadata: 'true',
      variables: `(profileUrn:${restliValue(profileUrn)},sectionType:${SECTION_TYPES[section]})`,
      queryId: QUERY_PROFILE_CARDS,
    });
  }
}

/**
 * Describe a redirect target without following it, and without echoing an
 * attacker-controlled URL verbatim into our logs.
 */
function describeRedirect(location: string): string {
  if (!location) return '<no location header>';
  try {
    const target = new URL(location, 'https://www.linkedin.com');
    const host = target.hostname;
    // If the hop points at a literal IP, say whether policy would allow it.
    if (/^[\d.]+$|^\[/.test(host)) {
      const verdict = checkIp(host.replace(/^\[|\]$/g, ''));
      return `${host} (${verdict.allowed ? 'public' : 'BLOCKED: ' + verdict.reason})`;
    }
    return host;
  } catch {
    return '<unparseable location>';
  }
}
