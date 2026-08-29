/**
 * Copy the session cookies out of a HAR capture and into .env, without ever
 * printing them.
 *
 * Hand-copying a session cookie out of DevTools is startlingly error-prone:
 * the value is ~150 opaque characters, a double-click selection can clip it,
 * LinkedIn rotates `li_at` whenever you re-authenticate, and DevTools renders
 * JSESSIONID with quotes that may or may not belong in the header. Every one
 * of those failures looks identical from the outside (a 302 that deletes your
 * session), so we take the cookies from a request that is KNOWN to have
 * returned 200 instead of trusting a copy-paste.
 */
import { readFileSync, writeFileSync } from 'node:fs';

interface HarEntry {
  request: { url: string; headers: Array<{ name: string; value: string }> };
  response: { status: number };
}

const harPath = process.argv[2] ?? 'capture/profile.har';
const har = JSON.parse(readFileSync(harPath, 'utf8')) as { log: { entries: HarEntry[] } };

// Only trust a request that actually succeeded against Voyager.
let cookieHeader: string | undefined;
for (const e of har.log.entries) {
  if (!e.request.url.includes('/voyager/api/')) continue;
  if (e.response.status !== 200) continue;
  cookieHeader = e.request.headers.find((h) => h.name.toLowerCase() === 'cookie')?.value;
  if (cookieHeader) break;
}
if (!cookieHeader) {
  console.error('no Cookie header on any HTTP 200 voyager request in the HAR');
  process.exit(1);
}

// Grab the client fingerprint headers from the same request. `x-li-track`
// carries clientVersion, timezone and display metrics; the User-Agent names
// the browser that minted these cookies. Sending a session established by
// Firefox alongside a Chrome UA and no x-li-track is an obvious inconsistency,
// so we replay whatever the capture actually used.
let userAgent: string | undefined;
let liTrack: string | undefined;
for (const e of har.log.entries) {
  if (!e.request.url.includes('/voyager/api/')) continue;
  if (e.response.status !== 200) continue;
  for (const h of e.request.headers) {
    const n = h.name.toLowerCase();
    if (n === 'user-agent') userAgent ??= h.value;
    if (n === 'x-li-track') liTrack ??= h.value;
  }
  if (userAgent && liTrack) break;
}

const jar = new Map<string, string>();
for (const part of cookieHeader.split(';')) {
  const i = part.indexOf('=');
  if (i === -1) continue;
  jar.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
}

const liAt = jar.get('li_at');
const jsessionid = jar.get('JSESSIONID');
if (!liAt || !jsessionid) {
  console.error('HAR cookie header is missing li_at or JSESSIONID');
  process.exit(1);
}

// Reproduce the browser's cookie header verbatim. Guessing which of the 28
// cookies Voyager actually requires is a losing game; sending exactly what
// worked is both simpler and strictly more faithful.
const updates: Record<string, string> = {
  LINKEDIN_LI_AT: liAt,
  LINKEDIN_JSESSIONID: jsessionid,
  LINKEDIN_COOKIE: cookieHeader,
};
if (userAgent) updates['LINKEDIN_USER_AGENT'] = userAgent;
if (liTrack) updates['LINKEDIN_X_LI_TRACK'] = liTrack;

const lines = readFileSync('.env', 'utf8').split('\n');
const seen = new Set<string>();
const out = lines.map((line) => {
  const t = line.trim();
  if (!t || t.startsWith('#')) return line;
  const i = t.indexOf('=');
  if (i === -1) return line;
  const key = t.slice(0, i).trim();
  if (key in updates) {
    seen.add(key);
    return `${key}=${updates[key]}`;
  }
  return line;
});
for (const [k, v] of Object.entries(updates)) {
  if (!seen.has(k)) out.push(`${k}=${v}`);
}
writeFileSync('.env', out.join('\n'));

console.log('.env updated from HAR (values not shown):');
for (const [k, v] of Object.entries(updates)) {
  console.log(`  ${k.padEnd(22)} len ${v.length}`);
}
console.log(`\n  cookie jar contained ${jar.size} cookies; full header stored as LINKEDIN_COOKIE`);
