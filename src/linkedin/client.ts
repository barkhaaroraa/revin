/**
 * The Voyager HTTP client: builds Rest.li-shaped requests, classifies failures
 * honestly, and never lets a redirect escape the SSRF policy.
 */

import { fetch } from 'undici';
import { MAX_RESPONSE_BYTES, readCapped, safeAgent, SsrfBlockedError } from '../security/ssrf-agent.js';
import { checkIp } from '../security/ip-rules.js';
import { UpstreamCircuitBreaker } from '../security/circuit-breaker.js';
import { redact, type Config } from '../config.js';
import { buildSession, newPageInstance, type Session } from './session.js';
import {
  DECORATION_FULL_PROFILE,
  PROFILE_COLLECTIONS,
  QUERY_PROFILE_BY_VANITY,
  VOYAGER_BASE,
  type CollectionKey,
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

/** Injectable safety collaborators, shared with the owning service. */
export interface ClientDeps {
  /** The upstream breaker. Defaults to a fresh one; inject to share with routes. */
  breaker?: UpstreamCircuitBreaker;
}

export class VoyagerClient {
  private session: Session;
  private readonly breaker: UpstreamCircuitBreaker;

  constructor(
    private readonly config: Config,
    deps: ClientDeps = {},
  ) {
    this.session = buildSession(config);
    this.breaker = deps.breaker ?? new UpstreamCircuitBreaker();
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

  /** The shared breaker, so the owning service can expose resume/status. */
  get circuitBreaker(): UpstreamCircuitBreaker {
    return this.breaker;
  }

  /**
   * Record a hard block (999 / checkpoint / access-denied), trip the breaker,
   * and return the error to throw.
   */
  private hardBlock(detail: string, status?: number): UpstreamError {
    this.breaker.trip({ detail, status });
    return new UpstreamError('blocked_by_linkedin', detail, status);
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
    // The breakpoint. If a previous request was hard-blocked (999, checkpoint,
    // or an access-denied authwall), the breaker is open and we refuse to send
    // ANOTHER request until a human resumes. Checked before the socket opens so
    // a flagged account is never touched again on its own — retrying a block
    // only escalates it from "challenged" to "banned".
    const blocked = this.breaker.blockIfOpen();
    if (blocked) {
      throw new UpstreamError(
        'blocked_by_linkedin',
        `upstream halted at ${blocked.at} after a hard block (${blocked.detail}); ${blocked.blockedSince} request(s) refused since. Not sending more without an explicit resume — POST /v1/admin/resume to continue.`,
        blocked.status,
      );
    }

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
    // not in any RFC; it is theirs. This is the canonical hard block: trip the
    // breaker so nothing else goes out until a human resumes.
    if (res.status === 999) {
      throw this.hardBlock('LinkedIn returned 999 (bot detection)', 999);
    }
    if (res.status === 429) {
      throw new UpstreamError('upstream_rate_limited', 'LinkedIn rate limited this session', 429);
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location') ?? '';
      // An access-denied authwall is a BLOCK, not a dead session: LinkedIn is
      // refusing the request rather than telling us the cookie expired. Treat it
      // like a 999 and stop — the same "don't keep knocking" rule applies.
      if (/\/authwall/.test(location)) {
        throw this.hardBlock('redirected to an access-denied authwall', res.status);
      }
      // A redirect to the login page means li_at is dead or revoked.
      if (/\/uas\/login|\/login/.test(location)) {
        throw new UpstreamError('session_expired', 'redirected to login — li_at is invalid or expired', res.status);
      }
      // A checkpoint means the ACCOUNT has been flagged and now needs a
      // human CAPTCHA. Retrying makes this worse, so we surface it loudly and
      // trip the breaker.
      if (/\/checkpoint/.test(location)) {
        throw this.hardBlock('redirected to a checkpoint challenge — the account is flagged', res.status);
      }
      // The third, sneakiest way a dead session presents — and the one this
      // classifier originally missed. LinkedIn does not redirect you to
      // /login; it redirects you to the SAME url and attaches a Set-Cookie
      // that expires `li_at`. Matching only on the Location misreads that as
      // an exotic protocol change, when it is the most ordinary failure there
      // is: the session is gone. Judge the Set-Cookie, not the target.
      if (clearsSessionCookie(res.headers.getSetCookie?.() ?? [])) {
        throw new UpstreamError(
          'session_expired',
          'LinkedIn expired li_at on this response (logout redirect) — the session is dead; re-sync cookies from a fresh capture',
          res.status,
        );
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
    // The PATH is the diagnosis, so keep it. Reporting only the hostname makes
    // every LinkedIn-internal redirect print the same three words
    // ("www.linkedin.com"), which is what turned a dead session into an
    // unexplained mystery. The query string is dropped instead: it is our own
    // request echoed back, and it is the only part likely to carry anything
    // sensitive.
    return `${host}${target.pathname}`;
  } catch {
    return '<unparseable location>';
  }
}

/**
 * Does this response log us out?
 *
 * LinkedIn signals a rejected session by clearing `li_at` — the value is
 * literally `delete me`, with `Max-Age=0` and a 1970 `Expires`. We match on
 * the expiry, not the value, because the placeholder string is theirs to
 * change and the expiry is what actually carries the meaning.
 */
export function clearsSessionCookie(setCookies: readonly string[]): boolean {
  return setCookies.some(
    (c) =>
      /^\s*li_at\s*=/i.test(c) &&
      (/;\s*max-age\s*=\s*0\s*(;|$)/i.test(c) || /;\s*expires\s*=[^;]*\b19[78]\d\b/i.test(c)),
  );
}
