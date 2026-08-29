/**
 * Compare the cookies in .env against the ones the browser actually sent in a
 * HAR capture — WITHOUT printing either value.
 *
 * When a hand-copied session cookie fails, the cause is almost always a
 * truncated paste or a rotated session. Both are invisible by inspection and
 * both are trivially detectable by comparison, so we compare rather than
 * eyeball, and report only lengths and a match/mismatch verdict.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const fingerprint = (v: string) => createHash('sha256').update(v).digest('hex').slice(0, 12);

function parseCookieHeader(header: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return out;
}

const harPath = process.argv[2] ?? 'capture/profile.har';
const har = JSON.parse(readFileSync(harPath, 'utf8')) as {
  log: { entries: Array<{ request: { url: string; headers: Array<{ name: string; value: string }> } }> };
};

// Take the cookies from a request we know succeeded against the Voyager API.
let harCookies: Map<string, string> | undefined;
for (const e of har.log.entries) {
  if (!e.request.url.includes('/voyager/api/')) continue;
  const h = e.request.headers.find((x) => x.name.toLowerCase() === 'cookie');
  if (h) {
    harCookies = parseCookieHeader(h.value);
    break;
  }
}
if (!harCookies) {
  console.error('no Cookie header found on any voyager request in the HAR');
  process.exit(1);
}

console.log(`\ncookie NAMES the browser sent (${harCookies.size} total):`);
console.log('  ' + [...harCookies.keys()].sort().join(', ') + '\n');

const env = new Map<string, string>();
for (const line of readFileSync('.env', 'utf8').split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i === -1) continue;
  env.set(t.slice(0, i).trim(), t.slice(i + 1).trim());
}

const pairs: Array<[string, string]> = [
  ['li_at', 'LINKEDIN_LI_AT'],
  ['JSESSIONID', 'LINKEDIN_JSESSIONID'],
];

for (const [cookieName, envName] of pairs) {
  const fromHar = harCookies.get(cookieName);
  const fromEnv = env.get(envName);
  console.log(`${cookieName}:`);
  console.log(`  in HAR : ${fromHar ? `len ${fromHar.length}, fp ${fingerprint(fromHar)}` : 'ABSENT'}`);
  console.log(`  in .env: ${fromEnv ? `len ${fromEnv.length}, fp ${fingerprint(fromEnv)}` : 'ABSENT'}`);
  if (fromHar && fromEnv) {
    console.log(`  MATCH  : ${fromHar === fromEnv ? 'yes' : 'NO - these are different values'}`);
  }
  console.log();
}
