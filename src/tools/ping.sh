#!/usr/bin/env bash
# Smoke test: can this box reach Voyager, and is the session still alive?
# One request. Prints name + location, or the status code that says why not.
#
#   ./src/tools/ping.sh williamhgates
#
# Reads LINKEDIN_COOKIE / LINKEDIN_LI_AT / LINKEDIN_JSESSIONID from .env or the
# environment.
set -u

SLUG="${1:-williamhgates}"

# Read one KEY=value out of .env WITHOUT executing the file.
#
# `set -a; . ./.env` looks equivalent and is not. .env holds a 28-cookie header
# and a User-Agent — values containing spaces, semicolons and parentheses — so
# sourcing it makes bash try to RUN them ("command not found", then a syntax
# error on the unquoted `(X11; Linux ...)`). Sourcing aborts at that point, so
# every variable defined below the cookie header silently ends up empty and
# this smoke test quietly stops sending the headers it is supposed to test.
env_get() {
  [ -f .env ] || return 0
  sed -n "s/^$1=//p" .env | head -1 | sed -e 's/^"//' -e 's/"$//'
}

LI_AT="${LINKEDIN_LI_AT:-$(env_get LINKEDIN_LI_AT)}"
JSESSIONID="${LINKEDIN_JSESSIONID:-$(env_get LINKEDIN_JSESSIONID)}"
COOKIE="${LINKEDIN_COOKIE:-$(env_get LINKEDIN_COOKIE)}"
UA="${LINKEDIN_USER_AGENT:-$(env_get LINKEDIN_USER_AGENT)}"
: "${UA:=Mozilla/5.0 (X11; Linux x86_64; rv:154.0) Gecko/20100101 Firefox/154.0}"

# csrf-token is JSESSIONID with the quotes stripped (double-submit cookie).
CSRF="${JSESSIONID//\"/}"

# Prefer the full captured cookie header, exactly as the server does. A
# reconstructed two-cookie header usually works, but when it does not the
# failure is opaque, and a smoke test that exercises a different request from
# the real client is worse than no smoke test.
if [ -z "$COOKIE" ]; then
  COOKIE="li_at=${LI_AT}; JSESSIONID=${JSESSIONID}"
fi

# NOTE: the Rest.li grammar's ( ) : must stay literal in the URL — do not put
# curl -G / --data-urlencode anywhere near this.
URL="https://www.linkedin.com/voyager/api/graphql?includeWebMetadata=true&variables=(vanityName:${SLUG})&queryId=voyagerIdentityDashProfiles.34ead06db82a2cc9a778fac97f69ad6a"

HDRS=$(mktemp)
trap 'rm -f "$HDRS"' EXIT

OUT=$(curl -sS -w '\n__STATUS__%{http_code}' --max-time 20 -D "$HDRS" \
  "$URL" \
  -H "cookie: ${COOKIE}" \
  -H "csrf-token: ${CSRF}" \
  -H 'accept: application/vnd.linkedin.normalized+json+2.1' \
  -H 'x-restli-protocol-version: 2.0.0' \
  -H 'x-li-lang: en_US' \
  -H "user-agent: ${UA}")

STATUS="${OUT##*__STATUS__}"
JSON="${OUT%__STATUS__*}"
LOCATION=$(grep -i '^location:' "$HDRS" | sed -E 's/^[Ll]ocation: *//' | tr -d '\r')

echo "HTTP $STATUS"
case "$STATUS" in
  200) ;;
  999) echo "-> bot detection (LinkedIn's own status code). This IP or session is flagged."; exit 1 ;;
  403) echo "-> csrf-token/cookie mismatch, or dead session."; exit 1 ;;
  30*)
    # Distinguish the three redirects, because the remedy differs and they are
    # NOT interchangeable. The third one is the trap: LinkedIn bounces you to
    # the same URL you asked for and expires li_at in the Set-Cookie, so the
    # Location alone looks like nothing is wrong.
    case "$LOCATION" in
      */checkpoint*)
        echo "-> /checkpoint: the ACCOUNT is flagged and needs a human. Do not retry — retrying makes it worse." ;;
      */uas/login*|*/login*|*/authwall*)
        echo "-> login/authwall: li_at is invalid or expired." ;;
      *)
        if grep -iqE '^set-cookie: *li_at=.*(max-age=0|expires=[^;]*19[78][0-9])' "$HDRS"; then
          echo "-> LinkedIn expired li_at on the response: the session is dead."
          echo "   Re-capture a HAR while logged in, then:"
          echo "     npx tsx src/tools/sync-cookies.ts capture/<new>.har"
        else
          echo "-> redirect to: ${LOCATION:-<none>} (unrecognised)"
        fi ;;
    esac
    exit 1 ;;
  429) echo "-> rate limited."; exit 1 ;;
  *)   printf '%s' "$JSON" | head -c 400; echo; exit 1 ;;
esac

# `geoLocation` is a REFERENCE — it holds a `urn:li:fsd_geo:...` that must be
# resolved against `included[]`. Grabbing the first geo you see gets you the
# country entity, not the city.
printf '%s' "$JSON" | jq -r '
  .included as $inc
  | ([$inc[]? | select(.firstName)][0]) as $p
  | ($p.geoLocation["*geo"]) as $geoUrn
  | ([$inc[]? | select(.entityUrn == $geoUrn)][0]) as $geo
  | "name    : \($p.firstName // "?") \($p.lastName // "")",
    "location: \($geo.defaultLocalizedName // "?")"
'
