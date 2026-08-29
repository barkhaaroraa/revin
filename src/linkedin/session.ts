/**
 * Turning two cookies into a request LinkedIn will answer.
 *
 * There are only four things that actually matter, and understanding why each
 * one is there is most of the "reverse engineering" in this project:
 *
 *   1. `li_at`          - the session itself.
 *   2. `JSESSIONID`     - value looks like "ajax:1234567890123456789".
 *   3. `csrf-token`     - the SAME value with any quotes stripped.
 *   4. `x-restli-...`   - selects Rest.li protocol 2.0 encoding.
 *
 * Point 3 is LinkedIn's CSRF protection, and it is the DOUBLE-SUBMIT COOKIE
 * pattern. The server never stores a per-session CSRF token; it just checks
 * that a request header matches a cookie. That works against a cross-site
 * attacker because the browser attaches the cookie automatically to any
 * request, but same-origin policy stops attacker JavaScript from ever READING
 * it to construct the matching header.
 *
 * We are not a cross-site attacker — we legitimately hold both values — so we
 * satisfy the check trivially by copying one into the other. That is precisely
 * why holding `li_at` + `JSESSIONID` is equivalent to being logged in, and why
 * these two strings must be treated as a password.
 */

import { randomBytes } from 'node:crypto';
import type { Config } from '../config.js';

/**
 * Fallback identity, used only when no capture has been synced.
 *
 * Being honest about what a UA string buys: it makes a request look ordinary
 * in a log, but it does NOT defeat serious bot detection. LinkedIn can
 * fingerprint the TLS ClientHello (JA3), and Node's handshake does not look
 * like any browser's no matter what this header claims. Defeating that needs
 * curl-impersonate or similar and is out of scope. Low request volume and
 * internally consistent headers are our actual mitigations.
 */
const FALLBACK_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64; rv:154.0) Gecko/20100101 Firefox/154.0';

/**
 * Mint a fresh page-instance tracking id.
 *
 * The captured value must NOT be replayed verbatim: `x-li-page-instance`
 * identifies a single page view, so reusing one id across every request for
 * days is itself an anomaly. A real client generates a new one each navigation,
 * so we do too — same shape, 16 random bytes base64-encoded.
 */
export function newPageInstance(pageKey = 'd_flagship3_profile_view_base'): string {
  return `urn:li:page:${pageKey};${randomBytes(16).toString('base64')}`;
}

export interface SessionOptions {
  /** The page a browser would have been on when firing this request. */
  referer?: string;
  /** Reuse one page-instance across a single logical page view. */
  pageInstance?: string;
}

export interface Session {
  headers: Record<string, string>;
}

export function buildSession(config: Config, options: SessionOptions = {}): Session {
  const jsessionid = config.LINKEDIN_JSESSIONID.trim();

  // The Cookie header must reproduce the cookie byte-for-byte. The csrf-token
  // header wants the same value WITHOUT quotes — DevTools displays JSESSIONID
  // with surrounding quotes, and whether they belong in the header depends on
  // how it was copied. Stripping here works either way.
  const csrfToken = jsessionid.replace(/"/g, '');

  // Prefer an exact replay of a known-good browser cookie header when we have
  // one. Reconstructing a two-cookie header works most of the time, but when
  // it does not the failure is opaque (a 302 that deletes the session), so
  // fidelity beats minimalism here.
  const cookieHeader = config.LINKEDIN_COOKIE?.trim()
    ? config.LINKEDIN_COOKIE.trim()
    : `li_at=${config.LINKEDIN_LI_AT}; JSESSIONID=${jsessionid}`;

  const headers: Record<string, string> = {
    // Asks for the NORMALIZED representation: a flat `included[]` array of
    // entities plus a tree that references them by URN, instead of one deeply
    // nested document. Without this header the response shape is different
    // and every parser in this project would need rewriting.
    accept: 'application/vnd.linkedin.normalized+json+2.1',

    cookie: cookieHeader,
    'csrf-token': csrfToken,

    // Rest.li protocol version. Omit it and complex query parameters — the
    // `(key:value,list:List(a,b))` grammar — are parsed under v1 rules and
    // silently misinterpreted rather than erroring.
    'x-restli-protocol-version': '2.0.0',

    'x-li-lang': 'en_US',
    'x-li-page-instance': options.pageInstance ?? newPageInstance(),
    'user-agent': config.LINKEDIN_USER_AGENT?.trim() || FALLBACK_USER_AGENT,
    'accept-language': 'en-US,en;q=0.9',

    // Fetch metadata. A same-origin XHR from a page sets exactly these; a bare
    // scripted request that omits them stands out against every real client.
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'sec-gpc': '1',
    pragma: 'no-cache',
    'cache-control': 'no-cache',

    referer: options.referer ?? 'https://www.linkedin.com/feed/',
  };

  // Device descriptor. Only sent when we have the real one from a capture —
  // an invented blob would contradict the fingerprint LinkedIn already
  // associates with this session, which is worse than sending nothing.
  const track = config.LINKEDIN_X_LI_TRACK?.trim();
  if (track) headers['x-li-track'] = track;

  return { headers };
}
