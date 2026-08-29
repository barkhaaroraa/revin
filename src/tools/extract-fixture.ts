/**
 * Run the extractors against saved fixtures. No network, no credentials.
 *
 *   npx tsx src/tools/extract-fixture.ts <slug>
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { extractProfile, type RawProfileResponses } from '../linkedin/extract.js';
import { PROFILE_COLLECTIONS, type CollectionKey } from '../linkedin/queries.js';
import { ProfileSchema } from '../schema.js';

const slug = process.argv[2];
if (!slug) {
  console.error('usage: tsx src/tools/extract-fixture.ts <vanity-slug>');
  process.exit(2);
}
const dir = join('capture/fixtures', slug);
if (!existsSync(dir)) {
  console.error(`no fixtures at ${dir}`);
  process.exit(1);
}

const read = (name: string): unknown =>
  existsSync(join(dir, name)) ? JSON.parse(readFileSync(join(dir, name), 'utf8')) : undefined;

const collections: Partial<Record<CollectionKey, unknown>> = {};
for (const key of Object.keys(PROFILE_COLLECTIONS) as CollectionKey[]) {
  const body = read(`${key}.json`);
  if (body !== undefined) collections[key] = body;
}

const raw: RawProfileResponses = {
  core: read('core.json'),
  fullProfile: read('full-profile.json'),
  collections,
};

console.log(`fixture files: ${readdirSync(dir).join(', ')}\n`);

const { profile, coverage } = extractProfile(raw, slug);

// Validating our own output catches extractor bugs at the boundary rather than
// letting a malformed shape reach a caller.
const validated = ProfileSchema.parse(profile);

console.log('=== IDENTITY ===');
console.log(`  name       ${validated.fullName}`);
console.log(`  headline   ${validated.headline}`);
console.log(`  location   ${validated.location.full ?? '(none)'}  [${validated.location.countryCode ?? '?'}]`);
console.log(`  industry   ${validated.industry}`);
console.log(`  urn        ${validated.urn}`);
console.log(`  memberId   ${validated.memberId}`);
console.log(`  about      ${validated.about ? validated.about.slice(0, 80) + '...' : '(none)'}`);
console.log(`  premium=${validated.premium} influencer=${validated.influencer}`);
console.log(`  images     profile:${validated.images.profile.length} background:${validated.images.background.length}`);
if (validated.images.profile[0]) {
  console.log(`             largest ${validated.images.profile[0].width}x${validated.images.profile[0].height}`);
}

const fmt = (d: { year: number; month: number | null } | null) =>
  d ? `${d.year}${d.month ? '-' + String(d.month).padStart(2, '0') : ''}` : '?';

console.log(`\n=== EXPERIENCE (${validated.experience.length}) ===`);
for (const e of validated.experience) {
  const r = e.dateRange;
  console.log(`  ${e.title} @ ${e.companyName}`);
  console.log(`      ${fmt(r.start)} -> ${r.current ? 'present' : fmt(r.end)}  (${e.durationMonths} mo)${e.location ? '  ' + e.location : ''}`);
}

console.log(`\n=== EDUCATION (${validated.education.length}) ===`);
for (const e of validated.education) {
  console.log(`  ${e.schoolName} — ${e.degreeName}, ${e.fieldOfStudy}  ${fmt(e.dateRange.start)}->${fmt(e.dateRange.end)}`);
}

console.log(`\n=== SKILLS (${validated.skills.length}) ===`);
console.log('  ' + validated.skills.map((s) => s.name).join(', '));

console.log(`\n=== CERTIFICATIONS (${validated.certifications.length}) ===`);
for (const c of validated.certifications) {
  console.log(`  ${c.name} — ${c.authority}  ${fmt(c.dateRange.start)}`);
}

console.log(`\n=== LANGUAGES (${validated.languages.length}) ===`);
for (const l of validated.languages) console.log(`  ${l.name} (${l.proficiency})`);

console.log(`\n=== PROJECTS (${validated.projects.length}) ===`);
for (const p of validated.projects) console.log(`  ${p.title}  ${fmt(p.dateRange.start)}  ${p.url ?? ''}`);

console.log(`\n=== PUBLICATIONS (${validated.publications.length}) ===`);
for (const p of validated.publications) console.log(`  ${p.name} — ${p.publisher}`);

console.log(`\n=== HONORS (${validated.honors.length}) ===`);
for (const h of validated.honors) console.log(`  ${h.title} — ${h.issuer}`);

console.log(`\n=== VOLUNTEER (${validated.volunteer.length}) ===`);
for (const v of validated.volunteer) console.log(`  ${v.role} @ ${v.organization}`);

console.log(`\n=== FEATURED (${validated.featured.length}) ===`);
for (const f of validated.featured) console.log(`  ${f.title} -> ${f.url}`);

console.log('\n=== COVERAGE ===');
console.log(`  present : ${coverage.present.join(', ') || '(none)'}`);
console.log(`  empty   : ${coverage.empty.join(', ') || '(none)'}`);
console.log(`  failed  : ${coverage.failed.length ? JSON.stringify(coverage.failed) : '(none)'}`);
