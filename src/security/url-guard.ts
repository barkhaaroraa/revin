/**
 * SSRF defense Layer 1 — and the single most important file in this project.
 *
 * The whole app is "a stranger hands us a URL and we fetch it", which is the
 * textbook SSRF setup. The strongest possible mitigation is not a smarter
 * blocklist. It is to NEVER FETCH THE USER'S URL AT ALL.
 *
 * So this module does not sanitise a URL and pass it along. It *parses* the
 * input, extracts one thing (the vanity slug), throws the rest away, and lets
 * the caller rebuild a request from a hardcoded template. The attacker-supplied
 * string never becomes a fetch target — at most it becomes one path segment
 * inside a URL we constructed ourselves.
 *
 * That distinction — validate-and-forward vs. parse-and-rebuild — is the
 * difference between a control that mostly works and one that structurally
 * cannot fail.
 */

/** Hard cap on input length. Cheap guard against parser-blowup inputs. */
const MAX_INPUT_LENGTH = 2048;

/**
 * Hostnames we accept. Deliberately a tight allowlist, not a pattern.
 *
 * The classic bug here is `hostname.endsWith('linkedin.com')`, which happily
 * accepts `evil-linkedin.com`. The other classic is `hostname.includes(...)`,
 * which accepts `linkedin.com.evil.com`. Both are real, both have shipped.
 *
 * We also do NOT blanket-allow `*.linkedin.com`. LinkedIn has many subdomains
 * and a dangling one (subdomain takeover) would become an SSRF hole. We allow
 * the apex, `www`, and two-letter locale subdomains like `in.` / `de.`, which
 * is every form a real profile URL is served on.
 */
const HOST_PATTERN = /^(?:(?:[a-z]{2}|www)\.)?linkedin\.com$/;

/**
 * True if the string contains any C0 control character, space, or DEL.
 *
 * Written as a code-point scan rather than a regex on purpose: expressing this
 * range needs backslash escapes that are easy to mangle into literal control
 * bytes in source, which silently turns the file binary. Numeric comparison has
 * no such failure mode.
 */
function hasControlOrSpace(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * A LinkedIn vanity slug: unicode letters, digits and hyphens. Real slugs
 * include non-ASCII (e.g. Chinese or Cyrillic names), so we cannot restrict to
 * [a-z0-9-]. What matters is what is EXCLUDED: no slash, backslash, dot, colon,
 * at-sign, question mark, hash, percent, whitespace or control characters.
 */
const SLUG_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}-]{1,98}[\p{L}\p{N}]$/u;

/** Profile paths. LinkedIn serves vanity profiles under /in/. */
const PROFILE_PATH_PATTERN = /^\/in\/([^/]+)\/?$/;

export type GuardFailureCode = 'invalid_url' | 'not_a_profile_url';

export type GuardResult =
  | { ok: true; slug: string; canonicalUrl: string }
  | { ok: false; code: GuardFailureCode; reason: string };

const fail = (code: GuardFailureCode, reason: string): GuardResult => ({ ok: false, code, reason });

/**
 * Turn untrusted input into a validated LinkedIn vanity slug, or a rejection.
 *
 * On success the caller should use `slug` and ignore the original input entirely.
 * `canonicalUrl` is returned for echoing back to the client, NOT for fetching.
 */
export function guardProfileUrl(input: unknown): GuardResult {
  if (typeof input !== 'string') return fail('invalid_url', 'url must be a string');

  const trimmed = input.trim();
  if (trimmed.length === 0) return fail('invalid_url', 'url is empty');
  if (trimmed.length > MAX_INPUT_LENGTH) return fail('invalid_url', `url exceeds ${MAX_INPUT_LENGTH} characters`);

  // Reject control characters and interior whitespace before parsing. The WHATWG
  // URL parser *strips* tabs and newlines rather than erroring, which means
  // "http://linkedin.com<TAB>@evil.com" can parse into something other than what
  // a human reviewing the string would predict. We refuse the ambiguity instead
  // of trying to out-guess the parser.
  if (hasControlOrSpace(trimmed)) {
    return fail('invalid_url', 'url contains whitespace or control characters');
  }

  // A backslash is treated as a path separator by the URL parser in some
  // positions, which powers bypasses like "http://linkedin.com\@evil.com".
  // No legitimate profile URL contains one.
  if (trimmed.includes('\\')) return fail('invalid_url', 'url contains a backslash');

  // Be forgiving about a missing scheme ("linkedin.com/in/foo"), but only when
  // the input genuinely has no scheme. Everything downstream is still enforced,
  // so this is convenience, not a hole. Note "//evil.com" becomes
  // "https://evil.com" and is then killed by the host check.
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed);
  const candidate = hasScheme ? trimmed : `https://${trimmed}`;

  // Always parse with the WHATWG parser. Never pick a URL apart with a regex:
  // essentially every published URL-validation bypass targets hand-rolled
  // string splitting. `new URL()` also lowercases the host and converts
  // internationalised domains to punycode, which is what kills IDN homographs —
  // "linkedin.com" typed with a Cyrillic "e" normalises to an xn-- form and
  // simply fails the host comparison below.
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return fail('invalid_url', 'url is not parseable');
  }

  // Scheme allowlist. This blocks `file:` (local disk), `gopher:` (can forge
  // arbitrary TCP bytes — the reason gopher-SSRF is rated worse than HTTP-SSRF),
  // `dict:`, `data:` and every other exotic handler.
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return fail('invalid_url', `unsupported scheme "${url.protocol}"`);
  }

  // Userinfo. "https://www.linkedin.com@evil.com/" has hostname evil.com, but
  // reads to a human as LinkedIn. Our host check already catches it; we reject
  // explicitly so the failure reason is honest.
  if (url.username !== '' || url.password !== '') {
    return fail('invalid_url', 'url must not contain credentials');
  }

  // Explicit ports are never present on a real profile link, and an arbitrary
  // port is how a host allowlist gets turned into an internal port scanner.
  if (url.port !== '') {
    return fail('invalid_url', `url must not specify a port (got ${url.port})`);
  }

  // `url.hostname` is already lowercased and punycode-encoded by the parser.
  if (!HOST_PATTERN.test(url.hostname)) {
    return fail('not_a_profile_url', `host "${url.hostname}" is not a LinkedIn profile host`);
  }

  const pathMatch = PROFILE_PATH_PATTERN.exec(url.pathname);
  if (!pathMatch?.[1]) {
    return fail('not_a_profile_url', `path "${url.pathname}" is not a /in/<slug> profile path`);
  }
  const rawSlug = pathMatch[1];

  // The parser does NOT decode %2F, so an encoded slash survives as a literal
  // "%2F" inside one path segment rather than splitting it. Decoding it here
  // would re-introduce a traversal character, so we decode once and then insist
  // nothing suspicious survived — including a leftover "%", which is the
  // signature of double-encoding (%252F -> %2F -> /).
  let slug: string;
  try {
    slug = decodeURIComponent(rawSlug);
  } catch {
    return fail('not_a_profile_url', 'slug has invalid percent-encoding');
  }
  if (slug.includes('%')) {
    return fail('not_a_profile_url', 'slug contains double percent-encoding');
  }

  if (!SLUG_PATTERN.test(slug)) {
    return fail('not_a_profile_url', `"${slug}" is not a valid LinkedIn vanity slug`);
  }

  // Everything the caller supplied is now discarded. Only `slug` — matched
  // against a strict pattern containing no URL-significant characters —
  // survives into the request we will build.
  return {
    ok: true,
    slug,
    canonicalUrl: `https://www.linkedin.com/in/${encodeURIComponent(slug)}`,
  };
}
