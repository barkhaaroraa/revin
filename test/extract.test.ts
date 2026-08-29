import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractProfile, type RawProfileResponses } from '../src/linkedin/extract.js';
import { PROFILE_COLLECTIONS, type CollectionKey } from '../src/linkedin/queries.js';
import { ProfileSchema } from '../src/schema.js';

/**
 * Load a fixture directory into the shape the extractor expects.
 *
 * The synthetic fixtures under test/fixtures/synthetic are committed so these
 * tests run anywhere. Real captures live under capture/ and are gitignored,
 * because committing a real person's profile to a public repository would
 * republish their personal data.
 */
function loadFixture(dir: string): RawProfileResponses {
  const read = (name: string): unknown =>
    existsSync(join(dir, name)) ? JSON.parse(readFileSync(join(dir, name), 'utf8')) : undefined;

  const collections: Partial<Record<CollectionKey, unknown>> = {};
  for (const key of Object.keys(PROFILE_COLLECTIONS) as CollectionKey[]) {
    const body = read(`${key}.json`);
    if (body !== undefined) collections[key] = body;
  }
  return { core: read('core.json'), fullProfile: read('full-profile.json'), collections };
}

describe('extractProfile (synthetic fixture)', () => {
  const { profile, coverage } = extractProfile(loadFixture('test/fixtures/synthetic'), 'test-person');

  it('produces output valid against the published schema', () => {
    expect(() => ProfileSchema.parse(profile)).not.toThrow();
  });

  it('extracts identity fields', () => {
    expect(profile.fullName).toBe('Test Person');
    expect(profile.publicIdentifier).toBe('test-person');
    expect(profile.urn).toBe('urn:li:fsd_profile:ACoAAATESTPROFILE0001');
    expect(profile.memberId).toBe('999000111');
    expect(profile.headline).toContain('Synthetic Profile');
    expect(profile.premium).toBe(true);
  });

  it('reads About from the Rest.li summary field', () => {
    // `summary` exists only on the Rest.li FullProfile projection — the GraphQL
    // vanityName query omits it entirely. This asserts we merge both sources.
    expect(profile.about).toContain('This is the About section');
  });

  it('resolves location across two URN hops', () => {
    // geoLocation -> *geo -> Geo -> *country -> Geo
    expect(profile.location.full).toBe('Berlin, Berlin, Germany');
    expect(profile.location.short).toBe('Berlin, Berlin');
    expect(profile.location.country).toBe('Germany');
    expect(profile.location.countryCode).toBe('DE');
  });

  it('resolves industry through its URN', () => {
    expect(profile.industry).toBe('Computer Software');
  });

  it('preserves collection ordering from *elements, not included[]', () => {
    // included[] deliberately lists the OLDER position first while *elements
    // lists the current one first. Reading included[] directly would scramble
    // a work history that is supposed to be reverse chronological.
    expect(profile.experience.map((e) => e.title)).toEqual(['Staff Engineer', 'Junior Developer']);
  });

  it('marks an open-ended role as current and computes duration', () => {
    const current = profile.experience[0]!;
    expect(current.dateRange.current).toBe(true);
    expect(current.dateRange.end).toBeNull();
    expect(current.durationMonths).toBeGreaterThan(60);

    const past = profile.experience[1]!;
    expect(past.dateRange.current).toBe(false);
    expect(past.durationMonths).toBe(18); // 2018-03 -> 2019-09
  });

  it('keeps partial dates partial instead of fabricating precision', () => {
    const edu = profile.education[0]!;
    expect(edu.dateRange.start).toEqual({ year: 2014, month: null, day: null });
    expect(edu.dateRange.end).toEqual({ year: 2018, month: null, day: null });
  });

  it('exposes the employment type URN rather than an invented label', () => {
    expect(profile.experience[0]!.employmentTypeUrn).toBe('urn:li:fsd_employmentType:1');
  });

  it('extracts every section', () => {
    expect(profile.education[0]!.schoolName).toBe('Test University');
    expect(profile.skills.map((s) => s.name)).toEqual(['TypeScript', 'Rust']);
    expect(profile.certifications[0]!.licenseNumber).toBe('ABC-123');
    expect(profile.languages[0]!.name).toBe('German');
    expect(profile.featured[0]!.url).toBe('https://example.invalid/');
  });

  it('builds image urls by concatenating rootUrl with the path segment, largest first', () => {
    expect(profile.images.profile).toHaveLength(3);
    expect(profile.images.profile[0]!.width).toBe(800);
    expect(profile.images.profile[0]!.url).toBe('https://media.example.invalid/dms/image/TESTROOT/scale_800_800/x/1');
    expect(profile.images.background[0]!.width).toBe(1400);
  });

  it('reports coverage honestly', () => {
    expect(coverage.present).toContain('positions');
    expect(coverage.present).toContain('about');
    expect(coverage.failed).toEqual([]);
  });
});
