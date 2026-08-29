# LinkedIn Profile API

A hosted HTTPS API that takes a LinkedIn profile URL and returns the profile as
structured JSON, by reverse engineering LinkedIn's private **Voyager** API.

**No browser.** No Playwright, no Puppeteer, no headless Chrome. The server
speaks directly to LinkedIn's internal JSON endpoints over HTTP, replaying the
session cookies and CSRF scheme their own web client uses.

```bash
curl -X POST https://<your-host>/v1/profile \
  -H 'content-type: application/json' \
  -H 'x-api-key: <key>' \
  -d '{"url":"https://www.linkedin.com/in/example-member/"}'
```

A minimal web UI is served at `/`.

> **How this was actually figured out** — including every dead end, the silent
> failures, and the two bugs that cost the most time — is written up in
> [`progress.md`](./progress.md), and rendered as a page the running server
> serves at `/progress` (e.g. <http://localhost:3007/progress>). That document
> is the interesting one.

---

## Contents

- [Quick start](#quick-start)
- [Getting LinkedIn credentials](#getting-linkedin-credentials)
- [API documentation](#api-documentation)
- [Approach](#approach)
- [Security: SSRF](#security-ssrf)
- [Avoiding detection](#avoiding-detection)
- [Known limitations](#known-limitations)
- [Development](#development)
- [Legal](#legal)

---

## Quick start

Requires **Node 22+** (uses the built-in `--env-file` flag and `undici`).

```bash
git clone <repo> && cd reverse-linkedin
npm install
cp .env.example .env      # then fill it in — see below
npm run dev               # http://localhost:3000
```

Production:

```bash
npm run build
node --env-file=.env dist/server.js
```

### Configuration

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `LINKEDIN_LI_AT` | ✅ | — | LinkedIn session cookie. **This is the session.** |
| `LINKEDIN_JSESSIONID` | ✅ | — | Value like `ajax:1234567890123456789`. |
| `API_KEY` | ✅ | — | Callers must send this as `x-api-key`. |
| `LINKEDIN_COOKIE` | | — | Full cookie header, replayed verbatim. More reliable than reconstructing it. |
| `LINKEDIN_USER_AGENT` | | Firefox UA | Should match the browser that minted the session. |
| `LINKEDIN_X_LI_TRACK` | | — | Device descriptor from the same session. |
| `PORT` / `HOST` | | `3000` / `0.0.0.0` | |
| `LOG_LEVEL` | | `info` | |
| `CACHE_TTL_SECONDS` | | `3600` | Cached profiles cost zero upstream requests. |
| `UPSTREAM_MIN_INTERVAL_MS` | | `40000` | Minimum gap **between profile fetches**. |
| `UPSTREAM_JITTER_MS` | | `15000` | Randomness added to that gap. |

Config is validated with Zod at boot and **fails fast** — a missing `li_at`
crashes on startup with a clear message rather than surfacing later as a
mysterious redirect-to-login.

---

## Getting LinkedIn credentials

> Use a **burner account**. Scraping violates LinkedIn's User Agreement and the
> account doing it can be restricted. See [Legal](#legal).

1. Log into LinkedIn in a browser as the burner.
2. `F12` → **Application** (Chrome) / **Storage** (Firefox) → Cookies →
   `https://www.linkedin.com`.
3. Copy `li_at` and `JSESSIONID` into `.env`.

`JSESSIONID` is displayed by DevTools **with surrounding quotes**. Whether they
belong in the header depends on how you copy it, so the code strips them when
deriving `csrf-token` and it works either way.

### The reliable way (recommended)

Hand-copying a 150-character opaque token is startlingly error-prone, and every
failure mode looks identical from outside: a `302` that deletes your session.
So don't hand-copy. Save a HAR of a logged-in session and extract from a request
that provably returned `200`:

```bash
# DevTools → Network → XHR → load a profile → "Save All As HAR"
#   → save to capture/linkedin.har   (capture/ is gitignored)
npx tsx src/tools/sync-cookies.ts capture/linkedin.har
```

This writes `li_at`, `JSESSIONID`, the full cookie header, the User-Agent and
`x-li-track` into `.env` **without printing any of them**. To diagnose a
credential mismatch without exposing values:

```bash
npx tsx src/tools/diff-cookies.ts capture/linkedin.har   # compares by length + SHA-256 prefix
```

---

## API documentation

### `POST /v1/profile`

**Headers:** `content-type: application/json`, `x-api-key: <key>`

**Body:**
```json
{ "url": "https://www.linkedin.com/in/example-member/" }
```

Accepted host forms: `linkedin.com`, `www.linkedin.com`, and two-letter locale
subdomains (`in.linkedin.com`). Path must be `/in/<vanity-name>`.

**`200 OK`** (abridged — see [`src/schema.ts`](./src/schema.ts) for the full contract):

```jsonc
{
  "source": "mixed",
  "fetchedAt": "2026-08-28T19:18:33.840Z",
  "cached": false,
  "requested": "https://www.linkedin.com/in/example-member",
  "profile": {
    "publicIdentifier": "example-member",
    "urn": "urn:li:fsd_profile:ACoAAATESTPROFILE0001",
    "memberId": "000000000",
    "firstName": "Sam", "lastName": "Example", "fullName": "Sam Example",
    "headline": "UX Engineer @ Example Corp. Co-Founder, CTO @ Placeholder Labs",
    "about": "Co-founder and full stack developer working on ...",
    "location": {
      "full": "Example City Area", "short": "Example City Area",
      "country": "United States", "countryCode": "US"
    },
    "industry": "Computer Software",
    "premium": false, "influencer": false,
    "images": {
      "profile":    [{ "url": "https://media.licdn.com/...", "width": 800, "height": 800 }],
      "background": [{ "url": "https://media.licdn.com/...", "width": 1400, "height": 349 }]
    },
    "experience": [{
      "title": "UX Engineer",
      "companyName": "Example Corp",
      "companyUrn": "urn:li:fsd_company:000000000",
      "employmentTypeUrn": null,
      "location": null,
      "description": "UI/UX for the web client, API portal, and agent tooling.",
      "dateRange": { "start": { "year": 2026, "month": 2, "day": null }, "end": null, "current": true },
      "durationMonths": 6
    }],
    "education":      [{ "schoolName": "...", "degreeName": "...", "fieldOfStudy": "...", "dateRange": {} }],
    "skills":         [{ "name": "JavaScript" }],
    "certifications": [{ "name": "...", "authority": "...", "licenseNumber": null, "url": null }],
    "languages":      [{ "name": "English", "proficiency": "NATIVE_OR_BILINGUAL" }],
    "projects": [], "publications": [], "honors": [], "volunteer": [], "featured": []
  },
  "coverage": {
    "present": ["positions", "educations", "skills", "languages", "projects", "about"],
    "empty":   ["certifications", "publications", "honors", "volunteer"],
    "failed":  []
  }
}
```

#### `coverage` — how "when available" is answered honestly

Rather than silently returning `[]` for everything, each section is reported as:

- **`present`** — returned data.
- **`empty`** — upstream answered successfully with nothing. Either the member
  has none, **or** the collection name is wrong and fails silently. We cannot
  distinguish those, and say so rather than implying we can.
- **`failed`** — the request itself errored, with the reason.

#### Dates are deliberately partial

`{ "year": 2014, "month": null, "day": null }` is **not** widened to
`2014-01-01`. LinkedIn genuinely does not have the day, and inventing one would
manufacture precision — callers could no longer tell a real January date from
padding.

### Errors

Every failure gets a distinct code and status, because the caller's correct
response differs in each case.

| Status | `error` | Meaning |
|---|---|---|
| 400 | `invalid_url` | Not a parseable/permitted URL (bad scheme, port, credentials, control chars). |
| 400 | `not_a_profile_url` | Parsed fine but isn't a LinkedIn `/in/<slug>` profile URL. |
| 401 | `missing_api_key` | Absent or wrong `x-api-key`. |
| 404 | `profile_not_found` | No such public profile, or not visible to the configured session. |
| 429 | *(rate limit)* | Our own per-key limit (30/min). |
| 429 | `upstream_rate_limited` | **LinkedIn** rate limited the session. Back off. |
| 502 | `upstream_unexpected` | Unrecognised upstream response — the persisted `queryId` may have rotated. |
| 502 | `blocked_egress` | The SSRF guard refused a non-public address. Should be unreachable. |
| 503 | `session_expired` | Server-side `li_at` is dead. An operator must refresh it. |
| 503 | `blocked_by_linkedin` | Bot detection (`HTTP 999`) or a checkpoint challenge. **Retrying makes it worse.** |
| 504 | `upstream_timeout` | LinkedIn didn't respond in time. |

### `GET /v1/health`

No auth. Returns `{ "status": "ok", "time": "..." }`.

### `GET /`

The web UI. Unauthenticated (it has to load before it can send a key); the key
is entered in the page and kept in `localStorage` only.

---

## Approach

### Why reverse engineering is necessary

LinkedIn's official API only returns the profile of the member who granted you
OAuth consent. It structurally cannot fetch a third party's profile — so the
brief is unsatisfiable through sanctioned channels.

`linkedin.com` is an Ember SPA that renders nothing itself; it gets all its data
from a private JSON API at `/voyager/api/`. That's the target.

### Authentication — four moving parts

| What | Where | Why |
|---|---|---|
| `li_at` | Cookie | The session. Holding it *is* being logged in. |
| `JSESSIONID` | Cookie | Value like `"ajax:1234567890123456789"`. |
| `csrf-token` | Header | The same value, **quotes stripped**. |
| `x-restli-protocol-version: 2.0.0` | Header | Selects Rest.li protocol v2 parsing. |

The `csrf-token` scheme is a **double-submit cookie**. The server stores no
per-session token; it just checks a header matches a cookie. That defeats a
cross-site attacker because the browser sends the cookie automatically but
same-origin policy stops attacker JS from *reading* it to build the header. We
hold both values legitimately, so we satisfy it by copying one into the other.

One more header matters: `accept: application/vnd.linkedin.normalized+json+2.1`
requests the **normalized** representation — a flat `included[]` array of
entities plus a tree referencing them by URN, rather than one nested document.

### The request flow

```
POST /v1/profile
   │
   ├─ url-guard        parse → extract slug → DISCARD the caller's URL
   ├─ cache            hit → return (≈3ms)
   ├─ upstream gate    serialize + pace between profiles
   │
   ├─ 1. GraphQL   voyagerIdentityDashProfiles(vanityName:<slug>)  → profile URN
   ├─ 2. Rest.li   identity/dash/profiles/<urn>?decorationId=FullProfile-76
   │                                                  → headline, summary, location, industry
   └─ 3. Rest.li   identity/dash/<collection>?q=viewee&profileUrn=<urn>
                   × positions, educations, skills, certifications, languages,
                     projects, publications, honors, volunteer, courses, organizations
   │
   ├─ normalize        included[] → URN map → resolve references (cycle-safe)
   ├─ extract          anti-corruption layer → our schema
   └─ validate         Zod, at the boundary
```

Step 1 is unavoidable because **the GraphQL `vanityName` query is the only one
that accepts a human-readable slug**; everything after it is keyed by the URN it
returns.

### Why Rest.li collections rather than GraphQL profile cards

The obvious route — GraphQL `ProfileCards` with `sectionType:EXPERIENCE` —
returns a **serialized UI component tree**, not data. A job arrives as an
`entityComponent` whose slots are display strings:

```
subtitle -> "NVIDIA · Full-time"            ← company and type glued together
caption  -> "Jan 1993 - Present · 32 yrs"   ← locale-dependent text
```

You'd split on `·` and regex-parse dates. The Rest.li collections instead return
**typed entities** with real fields — `title`, `companyName`, and a structured
`dateRange: {start:{month,year}}`. The most brittle part of the project simply
disappears. It is also *more* purely reverse-engineered: raw Rest.li rather than
a persisted GraphQL query whose hash rotates every release.

How that route was found is [`progress.md` §4](./progress.md).

### Layout

```
src/
  security/   url-guard.ts · ip-rules.ts · ssrf-agent.ts     ← SSRF layers 1 & 2
  linkedin/   client.ts · session.ts · queries.ts            ← the wire
              normalized.ts · extract.ts                      ← the graph, the mapping
              profile-service.ts                              ← orchestration + cache
  routes/     profile.ts                                      ← error taxonomy
  schema.ts   the public contract
  tools/      fetch-profile · sync-cookies · diff-cookies · probe-restli
public/       index.html (the UI)
```

`src/linkedin/queries.ts` is **the volatile file** — every `queryId` and
`decorationId` lives there, so a LinkedIn release breaks one file, not the app.

---

## Security: SSRF

This API's entire job is *"take a URL from a stranger and fetch it"*, which is
the textbook SSRF setup. It's worse than average because the fetched content is
returned to the caller — a full read channel, not blind SSRF. The classic attack:

```
{"url": "http://169.254.169.254/latest/meta-data/iam/security-credentials/"}
```

→ the server fetches cloud metadata from inside its trust boundary and hands
back IAM credentials.

### Layer 1 — never fetch the caller's URL (`url-guard.ts`)

The strongest mitigation isn't a smarter blocklist. It's **parse-and-rebuild,
not validate-and-forward**: the input is parsed, the vanity slug is extracted,
and *everything else is discarded*. The upstream URL is rebuilt from a hardcoded
template, so the attacker's string never becomes a fetch target.

Specifics, each defeating a known bypass class:

- Parsed with the **WHATWG `URL` parser**, never a regex — essentially every
  published URL-validation bypass targets hand-rolled string splitting. It also
  lowercases the host and converts IDNs to punycode, which is what kills
  homograph attacks (`linkedin.com` with a Cyrillic `е` normalises to `xn--…`).
- **Host allowlist**, not a pattern. `endsWith('linkedin.com')` accepts
  `evil-linkedin.com`; `includes()` accepts `linkedin.com.evil.com`. Both are
  real, shipped bugs. `*.linkedin.com` is also *not* blanket-allowed — a dangling
  subdomain would become an SSRF hole.
- **Scheme allowlist** — blocks `file:`, `dict:`, `data:` and `gopher:` (which
  can forge arbitrary TCP bytes, the reason gopher-SSRF is rated worse).
- **Rejects userinfo** (`https://www.linkedin.com@evil.com/`), **explicit ports**
  (a host allowlist plus an arbitrary port is an internal port scanner),
  **backslashes**, and **control characters** (the URL parser *strips* tabs and
  newlines rather than erroring, so `linkedin.com\t@evil.com` parses
  unpredictably — we refuse the ambiguity instead of out-guessing the parser).
- Slug decoded **once**, then rejected if a `%` survives — the signature of
  double-encoding (`%252F` → `%2F` → `/`).

### Layer 2 — socket-level egress guard (`ssrf-agent.ts`, `ip-rules.ts`)

Layer 1 makes this redundant *today*. It exists because one refactor could undo
Layer 1, and because redirect targets are attacker-influenced even when the
initial URL isn't.

- Judges the **resolved IP, never the hostname** — `evil.com` can simply have an
  A record pointing at `127.0.0.1`.
- Denies `127/8`, `10/8`, `172.16/12`, `192.168/16`, **`169.254/16` (cloud
  metadata)**, `0/8`, `100.64/10` (CGNAT), `198.18/15`, multicast, `::1`,
  `fc00::/7`, `fe80::/10`, and NAT64 `64:ff9b::/96`.
- **Unwraps IPv4-mapped IPv6.** `::ffff:127.0.0.1` is loopback in a costume;
  without unwrapping, *every* IPv4 rule is bypassable by rewriting the target in
  v6 syntax.
- **Defeats DNS rebinding (a TOCTOU race).** The naive control resolves a
  hostname, validates the IP, then hands the *hostname* to the HTTP client —
  which resolves **again** and gets `127.0.0.1` from a 0-TTL record. The check
  and the connection used different answers. The fix is structural: we supply
  undici's `lookup`, so validation happens *inside the resolution the connection
  actually uses*. There is no second lookup to poison.
- **Fails closed** on a resolution error, an empty answer, or a multi-record
  answer where *any* record is private (a rebinding attacker can return both a
  public and a private address and let client selection pick wrong).
- **Redirects are never followed.** `redirect: 'manual'` everywhere; a `3xx` is
  classified, not chased. So `302 → http://169.254.169.254/` has nowhere to go.
- **Response byte cap** (5MB, counted while streaming, not trusting
  `Content-Length` — that's a claim by the server, not a fact).

### Verified

All rejected before any network call:

```
http://169.254.169.254/latest/meta-data/    → not_a_profile_url
http://127.0.0.1:3000/v1/health             → invalid_url (port)
file:///etc/passwd                          → invalid_url (scheme)
gopher://127.0.0.1:6379/_INFO               → invalid_url (scheme)
https://www.linkedin.com@evil.com/in/x      → invalid_url (credentials)
https://evil.com#@www.linkedin.com/in/x     → not_a_profile_url (host evil.com)
https://evil-linkedin.com/in/x              → not_a_profile_url
https://linkedin.com.evil.com/in/x          → not_a_profile_url
https://xn--linkedn-hxa.com/in/x            → not_a_profile_url  (IDN homograph)
https://2130706433/in/x                     → not_a_profile_url  (normalised to 127.0.0.1)
https://www.linkedin.com/in/foo%2f..%2fbar  → not_a_profile_url  (encoded traversal)
https://www.linkedin.com/feed/              → not_a_profile_url  (not a profile path)
```

### Layer 3 — deployment (operator responsibility)

Restrict container egress to LinkedIn, and **require IMDSv2** on AWS — the token
`PUT` means a plain-GET SSRF cannot reach metadata at all. GCP and Azure metadata
similarly require a custom header.

### Other hardening

- **API key required** — an unauthenticated public scraper is itself an abuse
  vector. Compared in **constant time**: a plain `===` on a secret leaks its
  prefix through timing, recoverable a byte at a time.
- Per-key rate limit (30/min), 16KB body cap.
- Logs redact `cookie`, `csrf-token`, `x-api-key`; error paths pass through a
  `redact()` helper. A stack trace echoing request headers is an ordinary way to
  leak a session into a log aggregator.
- Cache is in-memory and bounded, with a TTL — this is third-party personal data,
  so it is deliberately not durable.

---

## Avoiding detection

- **Volume is the real mitigation.** ~14 upstream requests per profile, once,
  then cached. The entire build consumed under 100 requests.
- **Fixture recording is a security control**, not a convenience. Parser work
  runs offline against saved JSON, so iterating costs zero requests.
- **Header coherence** matters more than which browser you claim to be. UA,
  `x-li-track`, `Referer` and `sec-fetch-*` are replayed from the real session.
  `x-li-page-instance` is *not* replayed — it identifies a single page view, so
  reusing one forever is itself anomalous; a fresh one is minted per profile.
- **Pacing mirrors a browser**: sections burst within one profile view (a real
  client fires ~14 calls in seconds), with a long jittered gap *between*
  profiles. Uniform spacing is less human, not more.
- **Block signals abort immediately.** `HTTP 999`, `429`, `302 → /uas/login`,
  `302 → /checkpoint` each map to a distinct error, and a block stops the run.
  Hammering a checkpoint is how an account goes from challenged to banned.

---

## Known limitations

1. **`queryId` rotation.** One GraphQL call (slug → URN) depends on a persisted
   query hash baked into LinkedIn's JS bundle. It rotates on frontend releases
   and is the single most likely thing to break. Symptom: `502
   upstream_unexpected`. Fix: re-capture a HAR and update
   `src/linkedin/queries.ts`.
2. **`employmentTypeUrn` is not decoded.** LinkedIn returns only
   `urn:li:fsd_employmentType:18`; the integer→label table was in no capture.
   Inferring labels from single examples would fabricate data, so the raw
   identifier is returned.
3. **Five collections unverified.** `positions`, `educations`, `skills`,
   `certifications`, `languages` and `projects` are confirmed against live data.
   `publications`, `honors`, `volunteer`, `courses` and `organizations` return
   `200` with no entities on every profile tested — no test profile has had them,
   so "correct but empty" and "wrong name, silently empty" are indistinguishable.
   Reported as `empty` in `coverage`, never as confirmed-absent.
4. **TLS fingerprinting is not addressed.** LinkedIn can fingerprint the TLS
   ClientHello (JA3), and Node's handshake does not look like a browser's
   regardless of headers. Defeating it needs `curl-impersonate` or similar. Low
   volume is the compensating control.
5. **Session lifetime.** `li_at` expires or is revoked; there is no automated
   re-login. Symptom: `503 session_expired`. Fix: refresh the cookie.
6. **Login-walled data only.** Contact info, connection counts and full
   endorsement counts are not returned. Visibility also depends on the session
   account's relationship to the target.
7. **Image URLs are signed and expire** (`?e=` parameter). Don't cache them
   long-term.
8. **In-memory cache** — does not survive a restart and is not shared across
   instances. Swapping in Redis would persist personal data to disk, which
   deserves an explicit decision.

---

## Development

```bash
npm run dev          # watch mode
npm test             # 16 tests, no network, no credentials needed
npm run typecheck
```

Tests run anywhere: a committed **synthetic** fixture
(`test/fixtures/synthetic/`) exercises every extractor path. Real captures stay
gitignored — committing a real person's profile to a public repo would republish
their personal data — and drive an extra guard test that runs only when present
locally.

### Tools

```bash
# Fetch one profile live and save raw responses as offline fixtures
npx tsx --env-file=.env src/tools/fetch-profile.ts <profile-url>

# Re-run extractors against saved fixtures — no network
npx tsx src/tools/extract-fixture.ts <slug>

# Credential handling (never print values)
npx tsx src/tools/sync-cookies.ts capture/x.har
npx tsx src/tools/diff-cookies.ts capture/x.har

# Probe Rest.li collection endpoints
npx tsx --env-file=.env src/tools/probe-restli.ts <slug>
```

### Secret hygiene

`.gitignore` covers `.env`, `capture/` and `*.har`. **A HAR file is a
credential** — it contains live session cookies. All analysis tooling redacts by
allowlist: header values are hidden unless the name is explicitly known to be
non-sensitive.

---

## Legal

Scraping LinkedIn **violates their User Agreement**, and an account used for it
can be restricted or banned. Use a burner account, keep volume low.

`hiQ Labs v. LinkedIn` established that scraping *public* data is not a CFAA
violation in the US — that concerns criminal liability, and says nothing about
breach of contract. This project is a technical exercise; running it against
real profiles is at the operator's own risk.

This returns third-party personal data. Under GDPR/CCPA that carries obligations
(lawful basis, retention limits, subject access). Nothing here is persisted
beyond a short in-memory cache TTL, and nothing is written to disk by the server.
