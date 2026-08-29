/**
 * Probe the Rest.li sub-collection endpoints for profile sections.
 *
 * Reasoning behind these candidates — inference from OBSERVED structure, not
 * blind guessing:
 *
 *   1. The capture contained a real Rest.li call shaped
 *        /voyager/api/identity/dash/profiles/<urn>?decorationId=...FullProfile-76
 *      proving the `identity/dash/<collection>/<urn>` pattern is live.
 *   2. That projection carries the profile's SCALAR fields (headline, summary,
 *      location, pictures) but no positions/educations/skills, so those must be
 *      separate collections.
 *   3. Rest.li exposes collections through named "finders" selected by `q=`.
 *      For profile sub-entities the conventional finder is `q=viewee` keyed by
 *      `profileUrn`, and the collection names mirror the reference keys seen on
 *      the Profile entity itself (`*profilePositionGroups`, etc.).
 *   4. decorationId is omitted deliberately on the first pass: it selects a
 *      projection, and without one the server returns its default rather than
 *      erroring. If the default is too thin we then hunt for the right one.
 *
 * Safety: paced several seconds apart, aborts immediately on any block signal.
 * A wrong collection name yields a 400/404, which is a normal client error and
 * not a bot signal.
 */
import { fetch } from 'undici';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../config.js';
import { buildSession, newPageInstance } from '../linkedin/session.js';
import { restliValue } from '../linkedin/client.js';

const slug = process.argv[2];
if (!slug) {
  console.error('usage: tsx --env-file=.env src/tools/probe-restli.ts <vanity-slug>');
  process.exit(2);
}

const core = JSON.parse(readFileSync(`capture/fixtures/${slug}/core.json`, 'utf8')) as {
  included?: Array<Record<string, unknown>>;
};
const profile = (core.included ?? []).find(
  (x) => String(x['$type'] ?? '').endsWith('profile.Profile') && x['publicIdentifier'] === slug,
);
const profileUrn = profile?.['entityUrn'] as string | undefined;
if (!profileUrn) {
  console.error(`no profile URN for ${slug} on disk — run fetch-profile first`);
  process.exit(1);
}
console.log(`profileUrn = ${profileUrn}\n`);

const cfg = loadConfig();
const session = buildSession(cfg, {
  referer: `https://www.linkedin.com/in/${slug}/`,
  pageInstance: newPageInstance(),
});

const candidates: Array<{ label: string; url: string }> = [
  // The scalar record, for a profile that actually has content.
  {
    label: 'profiles/<urn> FullProfile-76',
    url: `https://www.linkedin.com/voyager/api/identity/dash/profiles/${restliValue(profileUrn)}?decorationId=com.linkedin.voyager.dash.deco.identity.profile.FullProfile-76`,
  },
  // Sub-collections via the `viewee` finder.
  ...[
    'profilePositionGroups',
    'profilePositions',
    'profileEducations',
    'profileSkills',
    'profileCertifications',
    'profileLanguages',
  ].map((collection) => ({
    label: `${collection}?q=viewee`,
    url: `https://www.linkedin.com/voyager/api/identity/dash/${collection}?q=viewee&profileUrn=${restliValue(profileUrn)}`,
  })),
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

for (const [i, c] of candidates.entries()) {
  if (i > 0) await sleep(2500 + Math.random() * 2500);
  let res;
  try {
    res = await fetch(c.url, { method: 'GET', headers: session.headers, redirect: 'manual' });
  } catch (err) {
    console.log(`${c.label.padEnd(36)} NETWORK ${String(err)}`);
    continue;
  }

  if (res.status === 999 || /checkpoint/.test(res.headers.get('location') ?? '')) {
    console.error(`\nABORT: block signal (HTTP ${res.status}). Stopping immediately.`);
    process.exit(1);
  }

  let detail = '';
  if (res.status === 200) {
    const body = (await res.json()) as { elements?: unknown[]; included?: Array<Record<string, unknown>>; data?: unknown };
    const included = body.included ?? [];
    const counts = new Map<string, number>();
    for (const x of included) {
      const t = String(x['$type'] ?? '?').split('.').pop() ?? '?';
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    const els = Array.isArray(body.elements) ? body.elements.length : undefined;
    detail =
      `included=${included.length}` +
      (els !== undefined ? ` elements=${els}` : '') +
      (counts.size ? `  [${[...counts].map(([t, n]) => `${n}x ${t}`).join(', ')}]` : '');
  } else {
    await res.text();
  }
  console.log(`${c.label.padEnd(36)} HTTP ${res.status}  ${detail}`);
}
