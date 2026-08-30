# Progress Log — Reverse Engineering the LinkedIn Profile API

A running record of how this was actually figured out: what we tried, what
failed, what the failures told us, and how each dead end pointed at the next
move. Written so the reasoning is reconstructable, not just the result.

Nothing here contains credentials. Where cookies had to be compared, they were
compared by length and SHA-256 fingerprint, never printed.

---

## 0. The core method

Everything below is one technique applied repeatedly:

1. Make the real client (a browser) do the thing you want.
2. Record the traffic.
3. Replay one request outside the browser until it works.
4. Delete headers/params one at a time until it breaks. What remains is the
   minimum viable request.
5. When something fails, **compare your request byte-for-byte against the
   captured one that worked.** Do not reason about what *should* work.

Step 5 is the one that actually solved this project. Twice.

---

## 1. Why reverse engineering is required at all

LinkedIn's official API only returns the profile of the member who granted you
OAuth consent. It structurally cannot fetch a third party's profile. So the
brief is unsatisfiable through sanctioned channels — which is the point of the
exercise.

The target is **Voyager**: `linkedin.com` is an Ember single-page app that
renders nothing itself and gets all its data from a private JSON API at
`/voyager/api/...`.

---

## 2. Authentication — solved early, four moving parts

| What | Where | Why it exists |
|---|---|---|
| `li_at` | Cookie | **This is the session.** Holding it = being logged in. |
| `JSESSIONID` | Cookie | Value looks like `"ajax:1234567890123456789"`. |
| `csrf-token` | Header | The same value, **quotes stripped**. |
| `x-restli-protocol-version: 2.0.0` | Header | Selects Rest.li protocol v2 parsing. |

The `csrf-token` mechanism is a **double-submit cookie**. The server stores no
per-session CSRF token; it just checks that a header matches a cookie. That
defeats a cross-site attacker because the browser attaches the cookie
automatically but same-origin policy stops attacker JS from ever *reading* it
to build the matching header. We hold both values legitimately, so we satisfy
it by copying one into the other — which is precisely why those two strings
must be treated as a password.

One more header matters enormously:

```
accept: application/vnd.linkedin.normalized+json+2.1
```

This requests the **normalized** representation — a flat `included[]` array of
entities plus a tree that references them by URN — instead of one deeply nested
document. Every parser in this project assumes it.

---

## 3. Timeline of attempts

### Capture #1 (`linkedin.har`) — dead end

27 entries, 26 Voyager calls. Looked promising. Wasn't.

```
distinct Referers:
  https://www.linkedin.com/
  https://www.linkedin.com/preload/?_bprMode=vanilla

ProfileCards:      0
ProfileComponents: 0
```

Every call came from the homepage. The largest response was
`voyagerFeedDashGlobalNavs` (9KB — the top navigation bar). The only
profile-shaped call was 491 bytes with `memberIdentity` set to the burner's own
ID: that's the nav avatar, not profile content.

**Lesson:** filtering DevTools to XHR is not enough. You have to actually
navigate to the page whose data you want, while recording.

### Tooling built here: a redacting HAR reader

A HAR file **is a credential** — it contains live session cookies. So the
analysis tooling was built allowlist-first: header values are hidden unless the
header name is explicitly known to be non-sensitive. This let the whole capture
be analysed without secrets entering a terminal, a log, or a model context.

Two self-inflicted bugs here, both worth recording:

- **Firefox stores response bodies base64-encoded, but inconsistently.** The
  first decoder assumed the `encoding` field was reliable and crashed on a
  non-ASCII body. Fixed by checking per entry and falling back to raw text.
- **Searching the raw HAR text for section names found only one value.** The
  others were *inside base64 bodies*. Grepping a HAR as text silently misses
  most of its content. Always search decoded bodies.

### Capture #2 (`profile.har`) — the breakthrough capture

49 Voyager calls from an actual profile view. Three finds:

**The entry point** — the only query that accepts a human-readable slug:
```
voyagerIdentityDashProfiles.34ead06db82a2cc9a778fac97f69ad6a
variables=(vanityName:jenhsunhuang)
```
44 fields: names, headline, `publicIdentifier`, profile/background pictures,
premium & influencer flags, a `geoLocation` reference, and critically
`entityUrn: urn:li:fsd_profile:ACoAAB...` — the URN every later call needs.

**A size trap:** the HAR reported `size: 8199`, but the decoded body was 45KB.
The `size` field is the compressed on-wire length. Don't triage by it.

**The hint that unlocked the section grammar.** The response embedded card
references shaped like:

```
urn:li:fsd_profileCard:(ACoAABMznFkB...,EXPERIENCE,en_US)
urn:li:fsd_profileCard:(<profileId>,<SECTION_TYPE>,<locale>)
```

Two things fell out of one string. First, `sectionType` is a plain enum, and
`EXPERIENCE`/`EDUCATION` are real values — read directly, not guessed. Second,
that `(a,b,c)` compound key **is** Rest.li protocol-2.0 encoding, which becomes
decisive in §4.

### Observation: profile sections are a UI component tree

Inspecting a card showed `topComponents`/`subComponents`, where each Component
is a tagged union — exactly one of nine keys is non-null:

```
entityComponent · textComponent · fixedListComponent · headerComponent
carouselComponent · insightComponent · completionMeterComponent
profileContentCollectionsComponent · wwuAdsComponent
```

There is no `position.companyName`. A job arrives as an `entityComponent` whose
slots are `TextViewModel`s, and slot→meaning is **positional convention**:

```
title    -> "Founder and CEO"
subtitle -> "NVIDIA · Full-time"      <- company and type glued together
caption  -> "Jan 1993 - Present · 32 yrs"   <- locale-dependent display text
metadata -> "Santa Clara, California"
```

This was flagged at the time as the most brittle part of the project. §5
eliminates it entirely.

### Live attempt #1 — dead end: the session was being deleted

```
status  : 302
location: <same url>
set-cookie: li_at=delete me; Max-Age=0
```

LinkedIn wasn't rejecting the request — it was **logging us out**.

Diagnosis was done by comparing `.env` against the HAR *by fingerprint*, so no
value was ever printed:

```
li_at        HAR: len 152, fp 7d3c4ee8563a | .env: len 155, fp cf7b97e84e2f  -> DIFFERENT
JSESSIONID   HAR: len 24,  fp f71524953260 | .env: len 26,  fp c766756506cf  -> DIFFERENT
```

Two independent faults, both invisible to the eye:

1. The `.env` `li_at` was from an **earlier session that had since rotated**.
2. The `.env` `JSESSIONID` included the surrounding quotes DevTools displays;
   the browser sends it without them (26 vs 24 chars).

**Fix and lesson:** stop hand-copying credentials. A tool now extracts them
programmatically from a request known to have returned HTTP 200, and stores the
complete 28-cookie header verbatim rather than guessing which cookies matter.
After this, the same request returned **200 with a 45KB body.**

### Observation: session fidelity

The cookies were minted by **Firefox 154 on Linux**, but our client was sending
a **Chrome** User-Agent and no `x-li-track`. A session whose client identity
changes mid-life is an obvious anomaly. The capture supplied the real values:

```
User-Agent: Mozilla/5.0 (X11; Linux x86_64; rv:154.0) Gecko/20100101 Firefox/154.0
x-li-track: {"clientVersion":"1.13.46267","osName":"web","timezoneOffset":5.5,
             "timezone":"Asia/Kolkata","deviceFormFactor":"DESKTOP",
             "displayWidth":2240,"displayHeight":1400,...}
```

Both are now replayed from the capture. `x-li-page-instance` is deliberately
*not* replayed — it identifies a single page view, so reusing one id forever is
itself anomalous; a fresh one is minted per profile view.

**Timing.** Measured from the capture: 49 calls over 164s, in tight bursts
(0.00–0.50s apart) separated by long human pauses (4s, 8s, 31s, 43s, 48s).

That reversed an assumption. A flat 40-second gap between every request is
*less* human than bursting, because no person produces evenly spaced requests.
The correct model is **burst within a profile, pause between profiles.**

### Live attempt #2 — dead end: HTTP 400 on every section

Comparing our URL against the captured working one:

```
ours     variables=(profileUrn:urn:li:fsd_profile:ACoAA...,sectionType:EXPERIENCE)
browser  variables=(profileUrn:urn%3Ali%3Afsd_profile%3AACoAA...,sectionType:CONTENT_...)
```

**The Rest.li rule:** structural delimiters (`(`, `)`, `:`, `,`) stay literal,
but the same characters *inside a value* must be percent-encoded. URNs are full
of colons, so an unescaped URN is ambiguous — the parser can't tell data from
structure.

A prior code comment had asserted the opposite ("values are validated, nothing
to encode"). It was wrong and is now corrected. The encoding is locked behind a
regression test that asserts against the captured URL verbatim — ground truth,
not reasoning.

### Live attempt #3 — the nastiest failure: silent success

Every request returned **HTTP 200**. It looked like it worked. It hadn't:

```
about.json           -> urn:li:fsd_profileCard:(...,PYMK_RECOMMENDATION,en_US)
experience.json      -> urn:li:fsd_profileCard:(...,PYMK_RECOMMENDATION,en_US)
education.json       -> urn:li:fsd_profileCard:(...,PYMK_RECOMMENDATION,en_US)
```

**Voyager does not error on an unknown `sectionType`. It quietly serves a
fallback card** ("People You May Know"). Six identical-looking successes were
six failures.

**Lesson:** a 200 proves nothing. Verify the *identity* of what came back — here,
the card's `entityUrn` — not just the status code.

This also explained the §3 mystery: the profile page **server-renders**
experience and education, which is exactly why they never appeared as XHR calls
in any capture. The `queryId` we had was captured for `CONTENT_COLLECTIONS_DETAILS`
and a persisted query has fixed semantics — it was never the right one.

### Capture #3 (`another_profile.har`) — dead end

26 calls, all `Referer: /preload/`, zero `sectionType` anywhere. Another
homepage capture. "Persist Logs" clears the log on navigation, so the profile
view was never recorded.

It didn't matter — the answer was already sitting in capture #2.

---

## 4. The breakthrough: mining the old capture again

Re-reading capture #2 for **non-GraphQL** calls surfaced one that had been
overlooked:

```
[200] /voyager/api/identity/dash/profiles/urn:li:fsd_profile:ACoAAG1MUJ8B...
      decorationId = com.linkedin.voyager.dash.deco.identity.profile.FullProfile-76
```

A Rest.li endpoint, not GraphQL. Three inferences chained from it:

1. `identity/dash/<collection>` is a live surface.
2. Its projection carries the profile's **scalar** fields (`headline`,
   `summary`, `location`, `industryUrn`, pictures) but **no** positions or
   educations — so those must be *separate collections*.
3. Rest.li exposes collections through named **finders** selected by `q=`. The
   collection names were already visible as reference keys on the Profile
   entity itself: `*profilePositionGroups`, `*profileEducations`, …

Predicted shape:

```
/voyager/api/identity/dash/<collection>?q=viewee&profileUrn=<encoded urn>
```

All six confirmed on the first attempt:

```
profilePositionGroups?q=viewee   200   10x PositionGroup
profilePositions?q=viewee        200   10x Position
profileEducations?q=viewee       200    1x Education
profileSkills?q=viewee           200   14x Skill
profileCertifications?q=viewee   200    3x Certification
profiles/<urn> FullProfile-76    200   Geo, Industry, TreasuryMedia
```

`decorationId` was deliberately omitted on the sub-collections: it selects a
projection, and the server returns a sensible default without it — one less
versioned string to re-capture on every LinkedIn release.

---

## 5. Why this changed the design

The Rest.li route returns **typed entities**, not a UI component tree:

```
Position       title, companyName, companyUrn, employmentTypeUrn, description,
               locationName, dateRange{start:{month,year}, end:{month,year}}
Education      schoolName, schoolUrn, degreeName, fieldOfStudy, grade,
               activities, dateRange
Skill          name
Certification  name, authority, licenseNumber, url, displaySource, dateRange
```

Compare against §3: instead of splitting `"NVIDIA · Full-time"` on a separator
and regex-parsing `"Jan 1993 - Present · 32 yrs"` in a locale-dependent way, we
read `companyName` and a structured `dateRange`. **The most fragile component of
the entire project ceased to exist.**

It is also *more* purely reverse-engineered, not less: raw Rest.li collections
rather than a persisted GraphQL query whose hash rotates every release.

Bonus: `FullProfile-76` includes `summary` — the About section — which the
GraphQL `vanityName` query does not return at all.

---

## 6. Dead ends, condensed

| # | Symptom | Real cause | Lesson |
|---|---|---|---|
| 1 | Capture had no profile data | Recorded the homepage | Navigate to the target page *while* recording |
| 2 | Body decoder crashed | Firefox base64 flag is unreliable | Check encoding per entry, fall back to raw |
| 3 | Text search found 1 of 3 enums | Values were inside base64 bodies | Search decoded bodies, never raw HAR text |
| 4 | Source file went "binary" | Literal control bytes written into a regex | Use code-point comparison, not escape-heavy regex |
| 5 | `302` + `li_at=delete me` | Stale cookie **and** quote mismatch | Extract credentials from a known-200 request; never hand-copy |
| 6 | `400` on every card | Colons inside a value weren't `%3A`-encoded | Diff against the captured URL; don't reason about encoding |
| 7 | Six `200`s, all wrong data | The `queryId` was the PYMK widget, not profile cards (§13) | Verify response *identity*, not status code |
| 8 | Third capture also useless | "Persist Logs" clears on navigation | The answer was already in an earlier capture — re-read before re-capturing |
| 9 | `languages` always empty | A failed experiment's output was still on disk (see §9) | Delete a dead experiment's artifacts, or a later run consumes them |
| 10 | `502 upstream_unexpected`, "unexpected redirect to www.linkedin.com" | Dead session — a 302 to the *same* URL whose `Set-Cookie` expires `li_at` | Classify the `Set-Cookie`, not the `Location`. And never let an error hint *assert* a cause |
| 11 | Smoke test sent the wrong request | `. ./.env` on values containing spaces | `.env` is data, not a script — parse it |

### Dead end #10: the error message that investigated the wrong suspect

This is dead end #5 returning in a costume. Same underlying event — LinkedIn
deleting the session — but this time the classifier had rules for the two
redirects it had *seen* (`/uas/login`, `/checkpoint`) and nothing for the one it
had only ever read about. The live response was:

```
302
location:   <the exact url we requested>
set-cookie: li_at="delete me"; ... Expires=Thu, 01-Jan-1970; Max-Age=0
set-cookie: li_a="delete me";  ... Max-Age=0
set-cookie: liap="delete me";  ... Max-Age=0
```

The `Location` matched no known pattern, so it fell through to
`upstream_unexpected`. Two separate design choices then conspired to hide the
answer:

1. `describeRedirect()` returned only the **hostname**, discarding the path. So
   the message read "unexpected redirect to www.linkedin.com" — three words
   that are true of a login redirect, a checkpoint, and a logout alike. The one
   field that distinguishes them was thrown away before it reached the log.
2. The `upstream_unexpected` hint **asserted a cause**: "The persisted queryId
   may have rotated." That was a plausible guess written at a calm moment, and
   it reads as a finding. It points at the single most feared failure (§8 item
   4) while the actual signal — a `Set-Cookie` in plain sight — went unread.

The `queryId` was never involved. It is not even evaluated on this path; the
request dies at authentication.

**Lesson, and it is the sharper form of "a 200 is not success" (§11.2): an
error message is a claim, and a *hint* that names a cause is a claim the reader
will act on. Report the signal you actually observed and let the reader draw the
inference.** A hint should widen the search, not narrow it to the wrong branch.

Fixed in three places, and the signature is now locked behind a regression test
(`test/logout-signature.test.ts`) that asserts against the three `Set-Cookie`
lines verbatim — ground truth, per §11.3. The test matches on the **expiry**,
not on the string `delete me`, since the placeholder is LinkedIn's to change and
the `Max-Age=0` is what carries the meaning. It also pins that `li_a` (cleared
in the same response) must not be mistaken for `li_at` by a prefix match.

### Dead end #11: the smoke test had quietly stopped testing the real request

`ping.sh` loaded credentials with `set -a; . ./.env`. That works right up until
`.env` contains a value with a space in it — and `LINKEDIN_COOKIE` (a 28-cookie
header) and `LINKEDIN_USER_AGENT` (`...(X11; Linux x86_64; rv:154.0)...`) both
do. Bash tried to *execute* those values:

```
./.env: line 40: AMCV_...%40AdobeOrg=-637568504%7C...: command not found
./.env: line 41: syntax error near unexpected token `('
```

Sourcing aborts at the syntax error, so **every variable defined below line 40
was silently empty.** The smoke test was sending a hand-built two-cookie header
and a hardcoded UA — a materially different request from the one the server
sends. A diagnostic that doesn't reproduce the client's request can only
coincidentally be right.

**Lesson: `.env` is a data file, not a shell script. Parse it, don't source
it** — and a smoke test must send the *same* request as the thing it is
vouching for, or it is testing a fiction.

---

## 7. Anti-detection notes

- **Volume is the real mitigation.** 10 requests per profile, once (down from 14
  after trimming collections that never returned rows). All parser work runs
  offline from saved fixtures, so iterating costs zero requests.
- **Fixture recording** is therefore a security control, not just convenience.
- **Header coherence** matters more than which browser you claim to be: UA,
  `x-li-track`, `Referer` and `sec-fetch-*` all replayed from the real session.
- **Failure signals are classified explicitly**, never swallowed: HTTP `999`
  (LinkedIn's bot block), `429`, `302 → /uas/login` (dead session),
  `302 → /checkpoint` (account flagged — retrying makes it strictly worse).
- **The breakpoint stops the bleeding.** The first hard block trips a circuit
  breaker that refuses every later request until a human resumes. See §12.
- **Egress is the operator's job, not the app's.** No proxies, no IP rotation —
  run it behind a VPN. §12 has the reasoning and what was deleted.
- **Out of scope:** TLS/JA3 and HTTP/2 fingerprinting. Node's ClientHello does
  not look like a browser's regardless of headers, and defeating that needs
  `curl-impersonate` or similar. Low volume is the compensating control.
- **Known-wrong but unfixed:** we speak HTTP/1.1 where the browser speaks
  HTTP/2, in a different header order, without `accept-encoding` or `te`, and
  with `pragma`/`cache-control` on requests the browser leaves them off.
  Measured, tabulated and left alone — see §13.

To date: no `999`, no checkpoint, no rate limiting.

---

## 8. Open questions

1. ~~**Seven collections returned `200` with zero entities.**~~ **Largely
   resolved.** Testing against a third profile (profile C in the table below) returned real
   data for `languages` (1) and `projects` (6), proving those collection names
   are correct and the earlier empties were genuine absence, not silent
   failure. **Six collections now confirmed against live data:** `positions`,
   `educations`, `skills`, `certifications`, `languages`, `projects`.
   Still unverified because no test profile has had them: `publications`,
   `honors`, `volunteer`, `courses`, `organizations`.
2. **`employmentTypeUrn: urn:li:fsd_employmentType:18`** needs mapping to a
   label ("Internship", "Full-time"). The mapping table isn't captured yet.
3. **`companyUrn` / `schoolUrn` → logos** requires resolving Company/School
   entities out of `included[]`.
4. **`queryId` rotation** still applies to the one GraphQL call we depend on
   (slug → URN). It is the single most likely thing to break. The hashes are
   embedded in LinkedIn's frontend JS bundle, so recovering them at runtime
   rather than hardcoding a captured constant is the obvious next move — not
   attempted.
5. **Positions vs PositionGroups** — both returned 10 entities; the grouping
   semantics (multiple roles at one company) need working out.
6. **Request fidelity** — five measured divergences from the captured browser
   request, none of them fixed. Tabulated in §13.

---

## 9. Building the extractors (offline, zero requests)

Three layers, all developed against saved fixtures with no network access:

- `normalized.ts` — the URN graph. Indexes `included[]` by `entityUrn` and
  resolves references. Two decisions worth noting: responses from **all ~14
  endpoints are merged into one graph** (the same Company/Geo entity appears in
  several, so merging makes it resolvable regardless of which call carried it),
  and collections are always read through `data['*elements']` rather than
  `included[]` directly — **`included[]` has no meaningful order**, so reading
  it would scramble a reverse-chronological work history.
- `schema.ts` — the public contract, deliberately independent of LinkedIn's shape.
- `extract.ts` — the anti-corruption layer. Every helper is total; a missing
  field degrades one value to `null` rather than throwing away the profile.

### Dead end #9: stale fixtures silently contaminating results

The fixture directory still held `about.json`, `education.json`,
`experience.json` and `languages.json` from the failed GraphQL-card era. Every
one contained a `PYMK_RECOMMENDATION` card. `languages.json` collides with a
real collection key, so the loader was reading **garbage as the languages
collection**. It happened to yield zero entries, so nothing looked wrong.

**Lesson:** a failed experiment's output is still on disk. Delete it, or a later
run will quietly consume it. This is dead end #7 recurring one layer down —
same failure mode, different disguise.

### Two honest calls made here

- **`employmentTypeUrn` is returned un-decoded.** LinkedIn gives only
  `urn:li:fsd_employmentType:18`; the integer→label table was in no capture.
  One observed example strongly suggests `18 = Internship`, but inferring a
  public API's label from a single sample is fabrication, so the raw identifier
  is returned and the gap is documented.
- **Partial dates stay partial.** `{year: 2014, month: null}` is not widened
  into `2014-01-01`. Inventing a day would manufacture precision LinkedIn never
  had, and callers could no longer distinguish a real January date from padding.

### Verified output (real capture)

10 positions in correct reverse-chronological order with durations, 1 education,
14 skills, 3 certifications, 2 featured links, location resolved across two URN
hops (`geoLocation → Geo → country → Geo`), industry resolved by URN, 4 profile
image renditions. `about` came back null for this member — the field is right,
but whether that member simply has no About section or LinkedIn withholds
`summary` from non-connections is **unverified**, and is logged in §8.

Test suite: 16 passing, no network. A committed **synthetic** fixture exercises
every extractor path so the tests run anywhere; the real capture stays
gitignored rather than republishing a person's data, and drives an extra guard
test that runs only when present locally.

---

## 10. Server, and verification across profiles

`POST /v1/profile` on Fastify, with an API key (constant-time compared — a
plain `===` on a secret leaks its prefix through timing), a per-key rate limit,
a 16KB body cap, log redaction of `cookie`/`csrf-token`/`x-api-key`, and a
distinct HTTP status per upstream failure kind. A minimal vanilla-JS frontend
is served from the same origin, so the browser call is same-origin and needs no
CORS. `/` and `/v1/health` are the only unauthenticated paths — the UI has to
load before it can send a key.

Verified against four unrelated profiles, deliberately varied in shape.
They are identified by letter only — no real member is named anywhere in this
repository:

| profile | exp | edu | skills | certs | lang | proj | about | bg image |
|---|---|---|---|---|---|---|---|---|
| A | 10 | 1 | 14 | 3 | 0 | 0 | – | yes |
| B | 6 | 2 | 12 | 0 | 0 | 0 | – | yes |
| C | 13 | 2 | 20 | 0 | 1 | 6 | yes | yes |
| D | 19 | 2 | 11 | 2 | 0 | 0 | yes | **none** |

The variation is the point: profile C proved `languages` and `projects`
resolve correctly, profile D exercised a profile with **no background
image** and 19 positions with year-only dates, and two profiles with a genuine
About confirmed the `summary` mapping against live data rather than only the
synthetic fixture.

Latency: **~9–15s cold**, **~3ms cached** (roughly a 3,000–5,000x difference).
Most of the cold time is our own deliberate inter-request pacing, not LinkedIn —
upstream responses come back in ~250ms each.

Cumulative upstream volume across the whole build: well under 100 requests, no
`999`, no checkpoint, no rate limiting.

---

## 11. Principles this project keeps proving

1. **Parse and rebuild, never validate and forward.** True of the SSRF guard,
   and true of the API client.
2. **A 200 is not success.** Verify what came back is what you asked for.
3. **Diff against ground truth.** Both hard blockers were solved by comparing
   against a captured request, not by reasoning about the protocol.
4. **Fail closed.** Unknown DNS answer, unparseable IP, ambiguous URL — refuse.
5. **Re-read what you already have before collecting more.** Two of the three
   hardest blockers were solved by returning to `profile.har` rather than
   capturing a new one — the second time for the Rest.li route (§4), the third
   for the PEM header that named the endpoints (§13).
6. **A control belongs at the layer that can enforce it.** The proxy pool was
   competent code solving a problem the network layer solves better. §12.

---

## 12. The breakpoint — and why the proxy layer was deleted

### The breakpoint (`src/security/circuit-breaker.ts`)

The first hard block — a `999`, a checkpoint, or an access-denied authwall —
trips a circuit breaker. While it is open, every subsequent upstream call is
refused *before a socket is opened*, and the block persists across requests
until a human explicitly resumes (`POST /v1/admin/resume`). This encodes the one
rule that matters most once flagged: **do not send another request.** Retrying a
block does not recover the session, it burns it — pushing an account from
"challenged" to "restricted". Nothing re-enables itself automatically, on
purpose. The admin routes require the real `x-api-key`; a public UI session
cookie is explicitly insufficient to clear a safety breaker.

Note the split this forced in the redirect classifier: an `/authwall` is an
access-denied *block* (trips the breaker), while `/login` and `/uas/login`
remain a *dead session* (`li_at` expired). They look similar but call for
opposite responses — one means stop and ask a human, the other means re-capture
cookies.

### The proxy pool: built, then removed

An earlier version routed every Voyager request through an operator-configured
proxy pool (`LINKEDIN_PROXIES`), rotating exits per profile view, with a
`LINKEDIN_REQUIRE_PROXY` boot check and credential redaction for the `user:pass@`
in each URL. All of it has been deleted.

The reasoning for removing it is worth more than the code was. Hiding the origin
address is a **network** concern, and the operator solves it more completely than
the application can: running the process behind a VPN covers every socket the
process opens — DNS, upstream, anything added later — with no proxy credentials
to store, redact, or leak, and no boot flag that can be misconfigured into a
silent direct connection. The in-app version could only cover the requests it
remembered to route.

What it cost to carry was real: a `ProxyAgent` per exit, a rotation invariant
(hold one exit within a profile view, rotate between views), a redaction rule in
`redact()` for URL userinfo, a `route` field threaded through the circuit
breaker's trip reason, and a block of tests for machinery no longer reachable.
Roughly 170 lines of source and 70 of tests to re-implement, less well, something
`wg-quick up` already does.

**Lesson: a control belongs at the layer that can actually enforce it.** Anti-ban
work the application *is* placed to do — request volume, pacing, header
coherence, the breakpoint — all stayed. The one thing it was badly placed to do
was the thing that got deleted.

---

## 13. Re-reading the capture a third time: what the PEM header confessed

Dead end #7 (six `200`s, every one a `PYMK_RECOMMENDATION` card) was diagnosed
at the time as "a persisted query has fixed semantics — it was never the right
one", with a guess that the `queryId` had been captured for
`CONTENT_COLLECTIONS_DETAILS`. The guess was unnecessary. LinkedIn had already
labelled it, in a request header nobody had read:

```
x-li-pem-metadata
```

PEM is LinkedIn's Product Endpoint Monitoring tag, and the browser sends it on
9 of the 49 captured Voyager calls, naming the product surface each `queryId`
serves:

```
voyagerIdentityDashProfiles.34ead06d…      Voyager - Profile=profile-top-card-core
voyagerIdentityDashProfileComponents.8682… Voyager - Profile=view-content-collections-details
voyagerIdentityDashProfileCards.aec4c260…  Voyager - Profile=profile-cards-widget-recommendations
voyagerFeedDashGlobalNavs.5e79c576…        Voyager - Navigation=voyager-navigation
```

Line three is the whole answer. `QUERY_PROFILE_CARDS` is the **People-You-May-Know
recommendations widget**. It was never a profile-cards query, so no `sectionType`
could have made it return profile sections — it returned exactly what it is for,
every time, with a `200`. The endpoint was behaving correctly; our name for it
was wrong.

Two consequences:

- `fetchCard()`, `QUERY_PROFILE_CARDS`, `SECTION_TYPES` and `COMPONENT_UNION_KEYS`
  are **deleted**. Keeping a "fallback" that structurally cannot return profile
  data is a trap for whoever reads this next — the comment said "kept as a
  fallback", which is a claim, and the claim was false.
- The first line is a small bonus: our entry-point query is officially
  `profile-top-card-core`, which is a good explanation of why it returns exactly
  the top-card fields and nothing about positions.

**Lesson, and it is principle #5 for the third time: re-read what you already
have.** The capture had been read for URLs, for headers we needed to replay, and
for cookies. It had never been read for what LinkedIn was saying *about its own
endpoints*. Two of this project's three hardest blockers were solved by returning
to the same file rather than collecting a new one.

### The same re-read produced a header-fidelity audit

Diffing our outgoing request against all 49 captured calls turned up five
divergences that were never checked, because the request worked and a working
request stops getting inspected:

| | Browser (Firefox 154) | This client |
|---|---|---|
| Protocol | **HTTP/2**, 49/49 | HTTP/1.1 — undici defaults `allowH2: false` |
| Header order | `Host, User-Agent, Accept, Accept-Language, Accept-Encoding, x-li-lang, x-li-track, x-li-page-instance, csrf-token, x-restli-protocol-version, …, Sec-Fetch-*, TE` | a different order entirely |
| `accept-encoding` | `gzip, deflate, br, zstd` | never set; undici substitutes its own |
| `te: trailers` | 49/49 | never sent |
| `pragma` / `cache-control` | 7/49 — and **not** on the `identity/dash` call | sent on every single request |

The protocol row is the loudest, and it is upstream of every other row: the ALPN
list inside the TLS ClientHello advertises HTTP/1.1-only before a byte of HTTP is
written. That is a stronger signal than any header we could get right.

The last row is the one worth pausing on. We are *more* cache-hostile than the
browser — a divergence produced by adding a header that felt safe, rather than by
copying one. Anti-detection work has a natural bias toward addition, and every
added header is another field that can fail to match.

None of this is fixed. It is recorded because "we replay the browser's headers"
was, on inspection, a claim rather than a measured fact — and the difference
between those two is most of what this log is about.

---
