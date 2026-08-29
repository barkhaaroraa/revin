/** Throwaway diagnostic: show exactly what Voyager replies with. */
import { fetch } from 'undici';
import { loadConfig } from '../config.js';
import { buildSession } from '../linkedin/session.js';
import { QUERY_PROFILE_BY_VANITY } from '../linkedin/queries.js';

const slug = process.argv[2];
if (!slug) {
  console.error('usage: tsx --env-file=.env src/tools/probe.ts <vanity-slug>');
  process.exit(2);
}
const cfg = loadConfig();
const s = buildSession(cfg);
const url = `https://www.linkedin.com/voyager/api/graphql?includeWebMetadata=true&variables=(vanityName:${slug})&queryId=${QUERY_PROFILE_BY_VANITY}`;

console.log('URL:', url, '\n');
const res = await fetch(url, { method: 'GET', headers: s.headers, redirect: 'manual' });
console.log('status  :', res.status);
console.log('location:', res.headers.get('location'));
for (const [k, v] of res.headers) {
  if (/^(x-li|content-type|www-authenticate|x-restli|set-cookie)/i.test(k)) {
    console.log(`  ${k}: ${String(v).slice(0, 120)}`);
  }
}
const body = await res.text();
console.log('\nbody len:', body.length);
console.log(body.slice(0, 700));
