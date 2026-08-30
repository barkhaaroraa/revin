# LinkedIn Profile API

Give it a LinkedIn profile URL, get structured JSON back.

It works by reverse engineering **Voyager**, the private JSON API that
`linkedin.com` uses for itself. **No browser** — no Playwright, no Puppeteer, no
headless Chrome. The server talks straight to LinkedIn's internal endpoints,
replaying the cookies and CSRF scheme their own web client uses.

> [!IMPORTANT]
> **This runs on a burner account, so it may stop working without warning.**
> LinkedIn actively restricts automated access, and when they flag or rate-limit
> the account behind it, requests start failing until the session is replaced —
> that is a property of what this is, not a bug that can be fixed once. I have
> reverse engineered it as faithfully as I could and built in every safeguard I
> could think of (a circuit breaker that stops on the first hard block, request
> pacing, caching, no retries against a flagged session) to make it work as well
> and as safely as it can. Treat uptime as best-effort.

```bash
curl -X POST http://localhost:3000/v1/profile \
  -H 'content-type: application/json' \
  -H 'x-api-key: <key>' \
  -d '{"url":"https://www.linkedin.com/in/example-member/"}'
```

There's a small web UI at `/`.

> 📖 **The interesting document is [`progress.md`](./progress.md)** — how this
> was actually figured out, including the dead ends and the two bugs that cost
> the most time. The running server renders it at `/progress`.

---

## What it does

| | |
|---|---|
| 🔎 **Slug → full profile** | Experience, education, skills, certifications, languages, projects, images, location |
| 🧱 **Typed data, not scraped text** | Rest.li collections return real fields — no splitting display strings on `·` |
| 📊 **Honest `coverage`** | Every section reports `present` / `empty` / `failed` instead of silently returning `[]` |
| 🛡️ **SSRF-hardened** | The caller's URL is *never* fetched — only a slug is extracted and the URL rebuilt |
| 🚦 **Breakpoint** | First hard block from LinkedIn halts all upstream traffic until a human resumes |
| ⏱️ **Human-shaped pacing** | Burst within a profile, long jittered gap between profiles |
| 💾 **Cache + fixtures** | Cached profiles cost zero upstream requests; parser work runs fully offline |
| ✅ **Typed end to end** | Zod-validated config and response contract, 32 tests, no network needed |

---

## Quick start

Requires **Node 22+**.

```bash
npm install
cp .env.example .env      # fill in li_at, JSESSIONID, API_KEY
npm run dev               # http://localhost:3000
```

### Credentials

> Use a **burner account**. Scraping violates LinkedIn's User Agreement.

Log in as the burner, then `F12` → Application/Storage → Cookies →
`https://www.linkedin.com`, and copy `li_at` and `JSESSIONID` into `.env`.

**Better: don't hand-copy.** A 150-character opaque token is error-prone, and
every mistake looks identical from outside — a `302` that kills your session.
Save a HAR of a logged-in session and extract from a request that provably
returned `200`:

```bash
# DevTools → Network → XHR → load a profile → "Save All As HAR" → capture/linkedin.har
npx tsx src/tools/sync-cookies.ts capture/linkedin.har   # writes .env, prints no values
npx tsx src/tools/diff-cookies.ts capture/linkedin.har   # compares by length + hash
```

### Configuration

| Variable | Req | Default | Purpose |
|---|:-:|---|---|
| `LINKEDIN_LI_AT` | ✅ | — | The session cookie. **This *is* the session.** |
| `LINKEDIN_JSESSIONID` | ✅ | — | Like `ajax:1234567890123456789`. Also derives `csrf-token`. |
| `API_KEY` | ✅ | — | Callers send it as `x-api-key`. |
| `LINKEDIN_COOKIE` | | — | Full cookie header, replayed verbatim. More reliable than rebuilding it. |
| `LINKEDIN_USER_AGENT` | | Firefox | Should match the browser that minted the session. |
| `LINKEDIN_X_LI_TRACK` | | — | Device descriptor from that same session. |
| `CACHE_TTL_SECONDS` | | `3600` | Cache hits cost zero upstream requests. |
| `UPSTREAM_MIN_INTERVAL_MS` | | `40000` | Minimum gap **between profile fetches**. |
| `UPSTREAM_JITTER_MS` | | `15000` | Randomness added to that gap. |
| `BREAKER_STATE_FILE` | | — | Durable path so an open breaker survives a restart. |
| `PORT` / `HOST` / `LOG_LEVEL` | | `3000` / `0.0.0.0` / `info` | |

Config is Zod-validated at boot and **fails fast** — a missing `li_at` crashes
on startup with a clear message, rather than surfacing later as a mysterious
redirect to login.

---

## How it works

### The request flow

```
POST /v1/profile
   │
   ├─ url-guard      parse → extract slug → DISCARD the caller's URL
   ├─ cache          hit → return (≈3 ms)
   ├─ upstream gate  serialize + pace between profiles
   │
   ├─ 1. GraphQL   voyagerIdentityDashProfiles(vanityName:<slug>)   → profile URN
   ├─ 2. Rest.li   identity/dash/profiles/<urn>?decorationId=…      → headline, about, location
   └─ 3. Rest.li   identity/dash/<collection>?q=viewee&profileUrn=…  × 8 collections
   │
   ├─ normalize      included[] → URN map → resolve references (cycle-safe)
   ├─ extract        anti-corruption layer → our schema
   └─ validate       Zod, at the boundary
```

Step 1 is unavoidable: the GraphQL `vanityName` query is the **only** one that
accepts a human-readable slug. Everything after it is keyed by the URN it
returns. Ten upstream requests per profile, then cached.

### Authentication — four moving parts

| What | Where | Why |
|---|---|---|
| `li_at` | Cookie | The session. Holding it *is* being logged in. |
| `JSESSIONID` | Cookie | Value like `"ajax:123…"`, quotes included. |
| `csrf-token` | Header | The same value, **quotes stripped**. |
| `x-restli-protocol-version: 2.0.0` | Header | Selects Rest.li v2 parsing. |

The CSRF scheme is a **double-submit cookie**: the server keeps no per-session
token, it just checks that a header matches a cookie. That stops a cross-site
attacker (the browser sends the cookie, but same-origin policy blocks reading it
to build the header). We hold both values legitimately, so we satisfy it by
copying one into the other.

One more header matters — `accept: application/vnd.linkedin.normalized+json+2.1`
asks for a flat `included[]` array of entities plus a tree referencing them by
URN, instead of one deeply nested document.

### Key design decision: Rest.li collections, not GraphQL profile cards

The obvious route — GraphQL `ProfileCards` — returns a **serialized UI component
tree**, not data. A job arrives as display strings:

```
subtitle -> "NVIDIA · Full-time"             ← company and type glued together
caption  -> "Jan 1993 - Present · 32 yrs"    ← locale-dependent text
```

You'd be splitting on `·` and regex-parsing dates. The Rest.li collections
return **typed entities** instead — `title`, `companyName`, a structured
`dateRange: {start:{month,year}}` — and the most brittle part of the project
simply disappears. It's also more purely reverse-engineered: raw Rest.li rather
than a persisted GraphQL hash that rotates every release.

It turned out the card route was never even the right endpoint — the captured
`queryId` was the People-You-May-Know widget, which is why every call returned
`200` with a recommendations card. LinkedIn's own `x-li-pem-metadata` header said
so all along. That route is deleted, not kept as a "fallback".
([`progress.md` §4](./progress.md) has the full hunt.)

### Layout

```
src/
  security/   url-guard · ip-rules · ssrf-agent      ← SSRF layers 1 & 2
              circuit-breaker · ui-session           ← the breakpoint, UI auth
  linkedin/   client · session · queries             ← the wire
              normalized · extract                   ← the graph, the mapping
              profile-service                        ← orchestration + cache
  routes/     profile                                ← error taxonomy
  schema.ts   the public contract
  tools/      fetch-profile · sync-cookies · diff-cookies · extract-fixture · probe-restli
public/       index.html (the UI)
```

`src/linkedin/queries.ts` is **the volatile file** — every `queryId` and
`decorationId` lives there, so a LinkedIn release breaks one file, not the app.

---

## API

| Endpoint | Auth | What |
|---|---|---|
| `POST /v1/profile` | `x-api-key` | URL in, profile JSON out |
| `GET /v1/health` | none | `{ "status": "ok" }` |
| `GET /` | none | Web UI (mints a UI session cookie) |
| `GET /v1/admin/status` | `x-api-key` | Is the breaker open, and what tripped it |
| `POST /v1/admin/resume` | `x-api-key` | Close the breaker — nothing else does |

Admin routes require the *real* API key: a UI session cookie is deliberately
**not** enough, since that cookie is minted for anyone who loads the homepage,
and clearing a safety breaker is an operator action.

### Request

```json
{ "url": "https://www.linkedin.com/in/example-member/" }
```

Accepted hosts: `linkedin.com`, `www.linkedin.com`, and two-letter locale
subdomains (`in.linkedin.com`). Path must be `/in/<vanity-name>`.

### Response (abridged — full contract in [`src/schema.ts`](./src/schema.ts))

```jsonc
{
  "source": "mixed",
  "fetchedAt": "2026-08-28T19:18:33.840Z",
  "cached": false,
  "profile": {
    "publicIdentifier": "example-member",
    "urn": "urn:li:fsd_profile:ACoAAATESTPROFILE0001",
    "fullName": "Sam Example",
    "headline": "UX Engineer @ Example Corp",
    "about": "Co-founder and full stack developer working on ...",
    "location": { "full": "Example City Area", "country": "United States", "countryCode": "US" },
    "industry": "Computer Software",
    "images": { "profile": [{ "url": "https://media.licdn.com/…", "width": 800, "height": 800 }] },
    "experience": [{
      "title": "UX Engineer",
      "companyName": "Example Corp",
      "companyUrn": "urn:li:fsd_company:000000000",
      "dateRange": { "start": { "year": 2026, "month": 2 }, "end": null, "current": true },
      "durationMonths": 6
    }],
    "education": [ … ], "skills": [ … ], "certifications": [ … ], "languages": [ … ],
    "projects": [], "publications": [], "honors": [], "volunteer": [], "featured": []
  },
  "coverage": {
    "present": ["positions", "educations", "skills", "languages", "about"],
    "empty":   ["certifications", "publications", "honors", "volunteer"],
    "failed":  []
  }
}
```

**`coverage` answers "when available" honestly.** `present` returned data;
`empty` means upstream succeeded with nothing — either the member has none *or*
the collection name is wrong and fails silently, and we can't tell those apart,
so we say so; `failed` means the request itself errored, with the reason.

**Dates stay partial.** `{ "year": 2014, "month": null }` is never widened to
`2014-01-01`. LinkedIn genuinely doesn't have the day, and padding it would
manufacture precision callers can't see through.

### Errors

Each failure gets a distinct code, because the caller's correct response differs
in each case.

| Status | `error` | Meaning |
|---|---|---|
| 400 | `invalid_url` | Bad scheme, port, credentials, control chars |
| 400 | `not_a_profile_url` | Parsed, but isn't a LinkedIn `/in/<slug>` URL |
| 401 | `missing_api_key` | Absent or wrong `x-api-key` |
| 404 | `profile_not_found` | No such public profile, or not visible to this session |
| 429 | *(rate limit)* | Our own per-key limit (30/min) |
| 429 | `upstream_rate_limited` | **LinkedIn** rate limited the session — back off |
| 502 | `upstream_unexpected` | Unrecognised response; the persisted `queryId` may have rotated |
| 502 | `blocked_egress` | SSRF guard refused a non-public address. Should be unreachable |
| 503 | `session_expired` | `li_at` is dead — an operator must refresh it |
| 503 | `blocked_by_linkedin` | Bot detection (`999`) or checkpoint. **Retrying makes it worse** |
| 504 | `upstream_timeout` | LinkedIn didn't respond in time |

---

## Security

This API's whole job is *"take a URL from a stranger and fetch it"* — the
textbook SSRF setup, and worse than usual because the response goes back to the
caller. The classic attack: `{"url":"http://169.254.169.254/latest/meta-data/…"}`
→ the server hands back IAM credentials.

**Layer 1 — never fetch the caller's URL** (`url-guard.ts`). The real mitigation
isn't a smarter blocklist, it's **parse-and-rebuild**: extract the slug, discard
everything else, rebuild the upstream URL from a hardcoded template. The
attacker's string never becomes a fetch target. Then, in depth:

| Defense | Bypass it kills |
|---|---|
| WHATWG `URL` parser, never regex | Nearly every published validation bypass targets hand-rolled splitting |
| Host **allowlist**, not a pattern | `evil-linkedin.com` (`endsWith`), `linkedin.com.evil.com` (`includes`) |
| Punycode/IDN normalization | Homographs — `linkedin.com` with a Cyrillic `е` |
| Scheme allowlist | `file:`, `data:`, `dict:`, `gopher:` (which can forge arbitrary TCP bytes) |
| Reject userinfo, explicit ports, backslashes, control chars | `https://www.linkedin.com@evil.com/`, internal port scanning, `linkedin.com\t@evil.com` |
| Decode slug **once**, reject a surviving `%` | Double encoding (`%252F` → `%2F` → `/`) |

**Layer 2 — socket-level egress guard** (`ssrf-agent.ts`, `ip-rules.ts`).
Redundant *today*; it exists because one refactor could undo Layer 1.

- Judges the **resolved IP, never the hostname** — `evil.com` can simply have an
  A record pointing at `127.0.0.1`. Denies loopback, RFC1918, **`169.254/16`
  (cloud metadata)**, CGNAT, multicast, `::1`, `fc00::/7`, `fe80::/10`, NAT64 —
  and **unwraps IPv4-mapped IPv6**, since `::ffff:127.0.0.1` is loopback in a
  costume that bypasses every v4 rule.
- **Defeats DNS rebinding.** The naive check resolves, validates, then hands the
  *hostname* to the HTTP client — which resolves **again** and gets `127.0.0.1`
  from a 0-TTL record. We supply undici's `lookup` instead, so validation happens
  inside the resolution the connection actually uses. No second lookup to poison.
- **Fails closed** on resolution errors, empty answers, or multi-record answers
  where *any* record is private. **Never follows redirects**
  (`redirect: 'manual'`), so `302 → 169.254.169.254` has nowhere to go. **5MB
  cap**, counted while streaming — `Content-Length` is a claim, not a fact.

All of these are rejected before any network call — `169.254.169.254`,
`file:///etc/passwd`, `gopher://127.0.0.1:6379/_INFO`,
`https://www.linkedin.com@evil.com/in/x`, `https://linkedin.com.evil.com/in/x`,
`https://xn--linkedn-hxa.com/in/x`, `https://2130706433/in/x`,
`https://www.linkedin.com/in/foo%2f..%2fbar`.

**Layer 3 — deployment** (operator's job). Restrict container egress to
LinkedIn, and require **IMDSv2** on AWS: the token `PUT` means a plain-GET SSRF
can't reach metadata at all.

**Also:** API key required and compared in **constant time** (a plain `===` on a
secret leaks its prefix through timing, a byte at a time) · per-key rate limit
30/min · 16KB body cap · logs redact `cookie`, `csrf-token`, `x-api-key` · cache
is in-memory, bounded and TTL'd, because this is third-party personal data and
shouldn't be durable.

---

## Avoiding detection

- **Volume is the real mitigation.** 10 upstream requests per profile, once, then
  cached. The entire build consumed under 100 requests.
- **Fixture recording is a security control**, not a convenience — parser work
  runs offline against saved JSON, at zero request cost.
- **Header coherence** beats which browser you claim to be. UA, `x-li-track`,
  `Referer` and `sec-fetch-*` are replayed from the real session.
  `x-li-page-instance` is deliberately *not* replayed — it identifies one page
  view, so reusing it forever is itself anomalous. Fresh one per profile.
- **Pacing mirrors a browser**: burst within a profile view, long jittered gap
  between profiles. Uniform spacing is less human, not more.
- **Block signals abort immediately.** `999`, `429`, `302 → /uas/login`,
  `/checkpoint` and `/authwall` each map to a distinct error. The split matters:
  an authwall is a **block**, `/login` means the cookie merely **expired** — they
  look alike and call for opposite responses.
- **The breakpoint.** The first hard block trips a circuit breaker; every
  upstream call is then refused *before a socket opens*, until a human calls
  `POST /v1/admin/resume`. Nothing re-enables itself, on purpose — retrying a
  block doesn't recover a session, it burns it, pushing an account from
  "challenged" to "restricted".

**Egress is not the application's job.** There is no proxy pool and no IP
rotation here; an earlier version had both and they were removed. Hiding the
origin address is a network concern the operator solves better — run the process
behind a VPN and every request inherits it, with no proxy credentials to store,
redact or leak. The app keeps what it's actually placed to enforce: volume,
pacing, header coherence, the breakpoint.

**What's still measurably wrong.** Diffed against 49 captured Voyager calls, our
client still differs on five points — HTTP/1.1 vs HTTP/2 (the loudest: ALPN
advertises it before a single header goes out), header order, `accept-encoding`,
`te: trailers`, and unconditional `pragma`/`cache-control`. All cheap to close,
none done — see limitation 4.

---

## Deploying

```bash
docker build -t reverse-linkedin .
docker run --rm -p 3000:3000 --env-file .env \
  -v reverse-linkedin-state:/data \
  -e BREAKER_STATE_FILE=/data/breaker.json \
  reverse-linkedin
```

Multi-stage build: compile with dev dependencies, ship without them, run as
`node` not root, secrets from the environment and never a build arg (build args
are visible in image history).

The operator's half of the bargain:

- **Run exactly one instance.** The cache, pacing gate, rate limiter and breaker
  are all in-process. Two replicas means two of each — double the request rate
  against one burner session, and a breaker tripped on A doesn't stop B. No
  autoscaling; stop the old container before starting the new one.
- **Point `BREAKER_STATE_FILE` at a volume**, not the writable layer. Otherwise
  "stopped until a human resumes" quietly becomes "stopped until the next
  deploy". Reads fail closed: empty, malformed or unreadable ⇒ starts **open**.
- **Egress is yours.** Datacenter IP ranges are exactly what bot detection scores
  against. Run the host behind a VPN.
- **Terminate TLS in front.** The server speaks plain HTTP with `trustProxy` and
  expects a proxy that overwrites `X-Forwarded-For`. Exposed directly, a caller
  can spoof that header and sidestep the IP-keyed rate limit.
- **Keep the UI private.** Loading `/` mints a UI session by design (the page has
  to work before anyone pastes a secret), so anyone who reaches the homepage can
  call `/v1/profile`. Fine behind SSO; not fine on a public URL.
- `SIGTERM` drains in-flight requests, 15s cap — set the platform's stop timeout
  above that, since an abrupt exit drops a slow profile fetch.

---

## Known limitations

1. **`queryId` rotation** — the slug→URN GraphQL call depends on a persisted
   query hash from LinkedIn's JS bundle. It rotates on frontend releases and is
   the single most likely thing to break. Symptom: `502 upstream_unexpected`.
   Fix: re-capture a HAR, update `src/linkedin/queries.ts`.
2. **`employmentTypeUrn` is not decoded** — LinkedIn returns only
   `urn:li:fsd_employmentType:18` and the integer→label table was in no capture.
   Guessing from single examples would fabricate data, so the raw URN is returned.
3. **Five collections unverified** — `publications`, `honors`, `volunteer`,
   `courses` and `organizations` return `200` with no entities on every profile
   tested. "Correct but empty" and "wrong name, silently empty" are
   indistinguishable, so they're reported `empty`, never confirmed-absent.
4. **Client fingerprinting is not addressed.** *Transport:* TLS ClientHello
   (JA3/JA4) and HTTP/2 SETTINGS fingerprints don't look like a browser's,
   whatever the headers say — fixing that needs `curl-impersonate` or similar, a
   non-Node dependency deliberately not taken on. *Protocol:* the five
   divergences above are fixable in plain undici and simply haven't been.
5. **Session lifetime** — `li_at` expires with no automated re-login. Symptom:
   `503 session_expired`.
6. **Login-walled data only** — no contact info, connection counts or full
   endorsement counts. Visibility depends on the session account's relationship
   to the target.
7. **Image URLs are signed and expire** (`?e=`). Don't cache them long-term.
8. **In-memory cache** — not shared across instances, gone on restart. Redis
   would persist personal data to disk, which deserves an explicit decision.

---

## Development

```bash
npm run dev          # watch mode
npm test             # 32 tests — no network, no credentials
npm run typecheck
```

Tests run anywhere: a committed **synthetic** fixture
(`test/fixtures/synthetic/`) exercises every extractor path. Real captures stay
gitignored — committing a real person's profile to a public repo would republish
their personal data.

```bash
# Fetch one profile live, save raw responses as offline fixtures
npx tsx --env-file=.env src/tools/fetch-profile.ts <profile-url>
npx tsx src/tools/extract-fixture.ts <slug>          # re-run extractors, no network
npx tsx --env-file=.env src/tools/probe-restli.ts <slug>
./src/tools/ping.sh <slug>                           # one-request "is the session alive?"
```

`ping.sh` sends the *same* request the server does, and *parses* `.env` rather
than sourcing it — not pedantry, see `progress.md` dead end 11, where `. ./.env`
silently blanked every variable after the cookie header.

**Secret hygiene:** `.gitignore` covers `.env`, `capture/` and `*.har`. **A HAR
file is a credential** — it contains live session cookies. All analysis tooling
redacts by allowlist: header values are hidden unless the name is explicitly
known to be safe.

---

## Legal

Scraping LinkedIn **violates their User Agreement** and can get an account
restricted. Use a burner, keep volume low. `hiQ Labs v. LinkedIn` established
that scraping *public* data isn't a CFAA violation in the US — that's criminal
liability, and says nothing about breach of contract.

This returns third-party personal data, which carries GDPR/CCPA obligations
(lawful basis, retention, subject access). Nothing is persisted beyond a short
in-memory cache TTL; the server writes nothing to disk. This is a technical
exercise — running it against real profiles is at the operator's own risk.
