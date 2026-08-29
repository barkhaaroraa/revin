/**
 * The anti-corruption layer: Voyager entities -> our stable schema.
 *
 * Every function here is defensive. Voyager fields are frequently null, and a
 * projection can drop a field entirely between releases, so nothing is assumed
 * present. The goal is that a missing field degrades one value to `null`
 * rather than throwing and losing the whole profile.
 */

import type {
  DateRangeSchema,
  Education,
  Experience,
  Profile,
} from '../schema.js';
import { z } from 'zod';
import {
  CertificationSchema,
  EducationSchema,
  ExperienceSchema,
  FeaturedLinkSchema,
  HonorSchema,
  LanguageSchema,
  ProjectSchema,
  PublicationSchema,
  VolunteerSchema,
  type PartialDate,
} from '../schema.js';
import { EntityGraph, type Entity } from './normalized.js';
import type { CollectionKey } from './queries.js';

type Range = z.infer<typeof DateRangeSchema>;

// --------------------------------------------------------------------------
// Small, total helpers. Everything upstream may be null.
// --------------------------------------------------------------------------

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean => v === true;

/** Read `{year, month, day}` from a `com.linkedin.common.Date`. */
function partialDate(v: unknown): PartialDate | null {
  if (typeof v !== 'object' || v === null) return null;
  const d = v as Entity;
  const year = num(d['year']);
  if (year === null) return null; // A date with no year is not usable.
  return { year, month: num(d['month']), day: num(d['day']) };
}

/**
 * A LinkedIn `dateRange`. An entry with a start and no end is ongoing — that is
 * how "Present" is represented, there is no explicit flag.
 */
function dateRange(v: unknown): Range {
  const r = (typeof v === 'object' && v !== null ? v : {}) as Entity;
  const start = partialDate(r['start']);
  const end = partialDate(r['end']);
  return { start, end, current: start !== null && end === null };
}

/** Whole months between two partial dates, treating a missing month as January. */
function monthsBetween(start: PartialDate, end: PartialDate | null): number | null {
  const to = end ?? { year: new Date().getUTCFullYear(), month: new Date().getUTCMonth() + 1, day: null };
  const months = (to.year - start.year) * 12 + ((to.month ?? 1) - (start.month ?? 1));
  return months >= 0 ? months : null;
}

/**
 * Pull every rendition of an image out of a `vectorImage`.
 *
 * LinkedIn splits an image URL in two: a `rootUrl` and, per size, a
 * `fileIdentifyingUrlPathSegment`. Neither half is usable alone — the full URL
 * is simple concatenation. The segments carry signed `?e=` expiry parameters,
 * so these URLs are time-limited and should not be cached long-term.
 */
function extractImages(node: unknown): Array<{ url: string; width: number | null; height: number | null }> {
  const out: Array<{ url: string; width: number | null; height: number | null }> = [];
  const seen = new Set<unknown>();

  const walk = (value: unknown): void => {
    if (typeof value !== 'object' || value === null) return;
    if (seen.has(value)) return;
    seen.add(value);

    const obj = value as Entity;
    const rootUrl = str(obj['rootUrl']);
    const artifacts = obj['artifacts'];
    if (rootUrl && Array.isArray(artifacts)) {
      for (const a of artifacts) {
        if (typeof a !== 'object' || a === null) continue;
        const art = a as Entity;
        const segment = str(art['fileIdentifyingUrlPathSegment']);
        if (!segment) continue;
        out.push({
          url: rootUrl + segment,
          width: num(art['width']),
          height: num(art['height']),
        });
      }
      return;
    }
    for (const child of Object.values(obj)) walk(child);
  };

  walk(node);
  // Largest first — callers usually want the best available rendition.
  return out.sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
}

// --------------------------------------------------------------------------
// Section extractors
// --------------------------------------------------------------------------

function experienceFrom(e: Entity): Experience {
  const range = dateRange(e['dateRange']);
  return ExperienceSchema.parse({
    title: str(e['title']),
    companyName: str(e['companyName']),
    companyUrn: str(e['companyUrn']),
    employmentTypeUrn: str(e['employmentTypeUrn']),
    location: str(e['locationName']) ?? str(e['geoLocationName']),
    description: str(e['description']),
    dateRange: range,
    durationMonths: range.start ? monthsBetween(range.start, range.end) : null,
  });
}

function educationFrom(e: Entity): Education {
  return EducationSchema.parse({
    schoolName: str(e['schoolName']),
    schoolUrn: str(e['schoolUrn']),
    degreeName: str(e['degreeName']),
    fieldOfStudy: str(e['fieldOfStudy']),
    grade: str(e['grade']),
    activities: str(e['activities']),
    description: str(e['description']),
    dateRange: dateRange(e['dateRange']),
  });
}

const certificationFrom = (e: Entity) =>
  CertificationSchema.parse({
    name: str(e['name']),
    authority: str(e['authority']),
    licenseNumber: str(e['licenseNumber']),
    url: str(e['url']),
    displaySource: str(e['displaySource']),
    dateRange: dateRange(e['dateRange']),
  });

const languageFrom = (e: Entity) =>
  LanguageSchema.parse({
    name: str(e['name']),
    proficiency: str(e['proficiency']),
  });

const projectFrom = (e: Entity) =>
  ProjectSchema.parse({
    title: str(e['title']),
    description: str(e['description']),
    url: str(e['url']),
    dateRange: dateRange(e['dateRange']),
  });

const publicationFrom = (e: Entity) =>
  PublicationSchema.parse({
    name: str(e['name']),
    publisher: str(e['publisher']),
    description: str(e['description']),
    url: str(e['url']),
    publishedOn: partialDate(e['publishedOn'] ?? e['date']),
  });

const honorFrom = (e: Entity) =>
  HonorSchema.parse({
    title: str(e['title']),
    issuer: str(e['issuer']),
    description: str(e['description']),
    issuedOn: partialDate(e['issuedOn'] ?? e['issueDate']),
  });

const volunteerFrom = (e: Entity) =>
  VolunteerSchema.parse({
    role: str(e['role']),
    organization: str(e['companyName']),
    cause: str(e['cause']),
    description: str(e['description']),
    dateRange: dateRange(e['dateRange']),
  });

/** "Featured" links, which arrive as TreasuryMedia entities. */
function featuredFrom(e: Entity) {
  const data = (typeof e['data'] === 'object' && e['data'] !== null ? e['data'] : {}) as Entity;
  return FeaturedLinkSchema.parse({
    title: str(e['title']),
    description: str(e['description']),
    url: str(data['Url']) ?? str(data['url']),
  });
}

// --------------------------------------------------------------------------
// Top level
// --------------------------------------------------------------------------

export interface RawProfileResponses {
  /** GraphQL vanityName response — the only one keyed by the URL slug. */
  core?: unknown;
  /** Rest.li FullProfile response — carries `summary` (the About section). */
  fullProfile?: unknown;
  /** Rest.li sub-collections, keyed as in PROFILE_COLLECTIONS. */
  collections: Partial<Record<CollectionKey, unknown>>;
  /** Sections whose request failed outright. */
  failed?: Array<{ section: string; reason: string }>;
}

export interface ExtractionResult {
  profile: Profile;
  coverage: { present: string[]; empty: string[]; failed: Array<{ section: string; reason: string }> };
}

export function extractProfile(raw: RawProfileResponses, slug: string): ExtractionResult {
  // One graph over every response. The same Company or Geo entity shows up in
  // several of them, and merging means it resolves regardless of which call
  // carried it.
  const graph = new EntityGraph([raw.core, raw.fullProfile, ...Object.values(raw.collections)]);

  // --- the profile scalar record ---------------------------------------
  // Two sources with different projections. The Rest.li `data` object is
  // richer (it has `summary`), so it wins; the GraphQL entity fills gaps.
  const fullData = ((raw.fullProfile as { data?: unknown } | undefined)?.data ?? {}) as Entity;
  const coreEntity =
    graph.ofType('profile.Profile').find((p) => p['publicIdentifier'] === slug) ??
    graph.ofType('profile.Profile').find((p) => typeof p['publicIdentifier'] === 'string') ??
    {};

  const pick = (field: string): unknown => fullData[field] ?? coreEntity[field];

  const firstName = str(pick('firstName'));
  const lastName = str(pick('lastName'));

  // --- location ---------------------------------------------------------
  // `geoLocation` holds a reference to a Geo entity, which in turn references
  // its country Geo. Both hops go through the graph.
  const geo = graph.follow((pick('geoLocation') ?? undefined) as Entity | undefined, 'geo');
  const countryGeo = graph.follow(geo, 'country');
  const location = {
    full: str(geo?.['defaultLocalizedName']),
    short: str(geo?.['defaultLocalizedNameWithoutCountryName']),
    country: str(countryGeo?.['defaultLocalizedName']),
    countryCode:
      str(geo?.['countryISOCode']) ??
      str((pick('location') as Entity | undefined)?.['countryCode']),
  };

  const industryEntity = graph.get(str(pick('industryUrn')));

  // --- sections ---------------------------------------------------------
  const present: string[] = [];
  const empty: string[] = [];

  /** Resolve a collection through `*elements` so ordering is preserved. */
  function section<T>(key: CollectionKey, map: (e: Entity) => T): T[] {
    const response = raw.collections[key];
    if (response === undefined) return [];
    const entities = graph.elements(response);
    const items = entities.map(map);
    (items.length > 0 ? present : empty).push(key);
    return items;
  }

  const experience = section('positions', experienceFrom);
  const education = section('educations', educationFrom);
  const skills = section('skills', (e) => ({ name: str(e['name']) ?? '' })).filter((s) => s.name !== '');
  const certifications = section('certifications', certificationFrom);
  const languages = section('languages', languageFrom);
  const projects = section('projects', projectFrom);
  const publications = section('publications', publicationFrom);
  const honors = section('honors', honorFrom);
  const volunteer = section('volunteer', volunteerFrom);

  const featured = graph.ofType('treasury.TreasuryMedia').map(featuredFrom);
  if (featured.length > 0) present.push('featured');

  const about = str(pick('summary'));
  if (about) present.push('about');
  else empty.push('about');

  const profile: Profile = {
    publicIdentifier: str(pick('publicIdentifier')) ?? slug,
    urn: str(pick('entityUrn')) ?? '',
    memberId: str(pick('objectUrn'))?.split(':').pop() ?? null,

    firstName,
    lastName,
    fullName: [firstName, lastName].filter(Boolean).join(' ') || null,
    headline: str(pick('headline')),
    about,

    location,
    industry: str(industryEntity?.['name']),

    premium: bool(pick('premium')),
    influencer: bool(pick('influencer')),

    images: {
      profile: extractImages(pick('profilePicture')),
      background: extractImages(pick('backgroundPicture')),
    },

    experience,
    education,
    skills,
    certifications,
    languages,
    projects,
    publications,
    honors,
    volunteer,
    featured,
  };

  return { profile, coverage: { present, empty, failed: raw.failed ?? [] } };
}
