/**
 * One-shot capture tool: fetch a profile live and write the raw responses to
 * disk so every later parser iteration can run OFFLINE.
 *
 * This is the main anti-ban measure in the project. Building the extractors
 * takes dozens of iterations; doing that against the live site would mean
 * dozens of requests per section. Recording once and replaying from disk makes
 * the whole remaining build cost effectively zero requests.
 *
 *   npx tsx --env-file=.env src/tools/fetch-profile.ts <profile-url>
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../config.js';
import { guardProfileUrl } from '../security/url-guard.js';
import { VoyagerClient, UpstreamError } from '../linkedin/client.js';
import { PROFILE_COLLECTIONS, type CollectionKey } from '../linkedin/queries.js';

const OUT_ROOT = 'capture/fixtures';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = (min: number, max: number) => min + Math.random() * (max - min);

/** Pull the target profile's URN out of a normalized response. */
function findProfileUrn(body: unknown, slug: string): string | undefined {
  const included = (body as { included?: unknown[] } | null)?.included;
  if (!Array.isArray(included)) return undefined;

  const profiles = included.filter(
    (x): x is Record<string, unknown> =>
      typeof x === 'object' && x !== null && String((x as Record<string, unknown>)['$type'] ?? '').endsWith('profile.Profile'),
  );

  // The response contains OUR OWN profile too (the viewer), so match on the
  // requested slug rather than just taking the first Profile entity.
  const match = profiles.find((p) => p['publicIdentifier'] === slug) ?? profiles.find((p) => p['publicIdentifier'] !== undefined);
  const urn = match?.['entityUrn'];
  return typeof urn === 'string' ? urn : undefined;
}

function summarize(body: unknown): string {
  const included = (body as { included?: unknown[] } | null)?.included;
  if (!Array.isArray(included)) return 'no included[]';
  if (included.length === 0) return 'empty';
  const counts = new Map<string, number>();
  for (const x of included) {
    const t = String((x as Record<string, unknown>)?.['$type'] ?? '?').split('.').pop() ?? '?';
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `${n}x ${t}`)
    .join(', ');
}

async function main(): Promise<void> {
  const input = process.argv[2];
  if (!input) {
    console.error('usage: tsx --env-file=.env src/tools/fetch-profile.ts <linkedin profile url>');
    process.exit(2);
  }

  // Layer 1 runs even here, in a local dev tool. If the guard is only applied
  // on the HTTP route, it is one refactor away from being bypassed.
  const guarded = guardProfileUrl(input);
  if (!guarded.ok) {
    console.error(`rejected by url-guard [${guarded.code}]: ${guarded.reason}`);
    process.exit(1);
  }
  const { slug } = guarded;

  const config = loadConfig();
  const client = new VoyagerClient(config);
  client.beginProfileView(slug);

  const outDir = join(OUT_ROOT, slug);
  await mkdir(outDir, { recursive: true });
  console.log(`\n=== fetching profile: ${slug} ===\n`);

  // --- Step 1: slug -> profile URN --------------------------------------
  // Only the GraphQL vanityName query accepts a human-readable slug, so it is
  // the unavoidable entry point even though everything after it is Rest.li.
  console.log('[1] graphql  vanityName');
  const core = await client.fetchProfileByVanity(slug);
  await writeFile(join(outDir, 'core.json'), JSON.stringify(core, null, 2));
  console.log(`    ${summarize(core)}`);

  const profileUrn = findProfileUrn(core, slug);
  if (!profileUrn) {
    console.error('\n    could not locate the profile URN — profile may be private, or the queryId rotated.');
    process.exit(1);
  }
  console.log(`    profileUrn = ${profileUrn}\n`);

  await sleep(jitter(1200, 2500));

  // --- Step 2: the scalar record (About / location / industry) ----------
  console.log('[2] restli   profiles/<urn> FullProfile');
  try {
    const full = await client.fetchFullProfile(profileUrn);
    await writeFile(join(outDir, 'full-profile.json'), JSON.stringify(full, null, 2));
    console.log(`    ${summarize(full)}\n`);
  } catch (err) {
    console.log(`    FAILED ${err instanceof Error ? err.message : String(err)}\n`);
  }

  // --- Step 3: the typed sub-collections --------------------------------
  // Paced to resemble a person reading and scrolling rather than a uniform
  // machine cadence. The reference capture showed a real browser issuing 49
  // calls over 164s in bursts, so this volume is unremarkable.
  const collections = Object.keys(PROFILE_COLLECTIONS) as CollectionKey[];
  const found: string[] = [];
  const empty: string[] = [];

  for (const [i, collection] of collections.entries()) {
    if (i > 0) await sleep(jitter(800, 2200));
    if (i === 6) {
      const pause = jitter(5000, 9000);
      console.log(`\n    ...pausing ${(pause / 1000).toFixed(1)}s (scrolling)\n`);
      await sleep(pause);
    }
    process.stdout.write(`[3] restli   ${PROFILE_COLLECTIONS[collection].padEnd(28)} `);
    try {
      const data = await client.fetchCollection(profileUrn, collection);
      const s = summarize(data);
      if (s === 'empty' || s === 'no included[]') {
        empty.push(collection);
        console.log(`-    ${s}`);
      } else {
        found.push(collection);
        await writeFile(join(outDir, `${collection}.json`), JSON.stringify(data, null, 2));
        console.log(`ok   ${s}`);
      }
    } catch (err) {
      const msg = err instanceof UpstreamError ? `${err.kind}: ${err.message}` : String(err);
      console.log(`FAIL ${msg}`);
      if (err instanceof UpstreamError && (err.kind === 'blocked_by_linkedin' || err.kind === 'session_expired')) {
        console.error('\n    ABORTING: blocked or session dead. Do not retry in a loop.');
        break;
      }
    }
  }

  console.log(`\n=== ${outDir}/ (gitignored) ===`);
  console.log(`    with data : ${found.join(', ') || 'none'}`);
  console.log(`    empty     : ${empty.join(', ') || 'none'}\n`);
}

main().catch((err) => {
  console.error('\nfatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
