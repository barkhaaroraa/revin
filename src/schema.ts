/**
 * The public response contract.
 *
 * Design principle: **LinkedIn's shape is unstable; ours is not.** Everything
 * in this file is ours to keep stable, and the extractors act as an
 * anti-corruption layer between Voyager's entities and these types. When
 * LinkedIn renames a field or bumps a projection, the change is absorbed in
 * the extractors and this contract does not move.
 *
 * Versioned under /v1/ so it can move later without breaking callers.
 */

import { z } from 'zod';

/**
 * A LinkedIn date is genuinely partial. Positions carry `{year, month}` and
 * educations frequently carry only `{year}`.
 *
 * We deliberately do NOT normalise these into a full ISO timestamp. Inventing
 * a day (`2021-11-01`) would fabricate precision LinkedIn never had, and
 * downstream consumers cannot then tell a real 1st-of-the-month from padding.
 */
export const PartialDateSchema = z.object({
  year: z.number().int(),
  month: z.number().int().min(1).max(12).nullable(),
  day: z.number().int().min(1).max(31).nullable(),
});
export type PartialDate = z.infer<typeof PartialDateSchema>;

export const DateRangeSchema = z.object({
  start: PartialDateSchema.nullable(),
  end: PartialDateSchema.nullable(),
  /** True when the entry has a start but no end — an ongoing role or study. */
  current: z.boolean(),
});

export const ImageSchema = z.object({
  url: z.string(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
});

export const LocationSchema = z.object({
  /** "San Francisco, California, United States" */
  full: z.string().nullable(),
  /** "San Francisco, California" — LinkedIn's own country-less rendering. */
  short: z.string().nullable(),
  country: z.string().nullable(),
  countryCode: z.string().nullable(),
});

export const ExperienceSchema = z.object({
  title: z.string().nullable(),
  companyName: z.string().nullable(),
  companyUrn: z.string().nullable(),
  /**
   * Raw URN, e.g. `urn:li:fsd_employmentType:18`.
   *
   * Exposed un-decoded on purpose. LinkedIn returns only the URN, and the
   * integer -> label table ("Internship", "Full-time") was not present in any
   * capture. Guessing a label from a single observed example would fabricate
   * data, so we return the identifier we actually have and document the gap.
   */
  employmentTypeUrn: z.string().nullable(),
  location: z.string().nullable(),
  description: z.string().nullable(),
  dateRange: DateRangeSchema,
  /** Months between start and end (or now). Null when the start is unknown. */
  durationMonths: z.number().int().nullable(),
});

export type Experience = z.infer<typeof ExperienceSchema>;

export const EducationSchema = z.object({
  schoolName: z.string().nullable(),
  schoolUrn: z.string().nullable(),
  degreeName: z.string().nullable(),
  fieldOfStudy: z.string().nullable(),
  grade: z.string().nullable(),
  activities: z.string().nullable(),
  description: z.string().nullable(),
  dateRange: DateRangeSchema,
});

export type Education = z.infer<typeof EducationSchema>;

export const SkillSchema = z.object({
  name: z.string(),
});

export const CertificationSchema = z.object({
  name: z.string().nullable(),
  authority: z.string().nullable(),
  licenseNumber: z.string().nullable(),
  url: z.string().nullable(),
  displaySource: z.string().nullable(),
  dateRange: DateRangeSchema,
});

export const LanguageSchema = z.object({
  name: z.string().nullable(),
  proficiency: z.string().nullable(),
});

export const ProjectSchema = z.object({
  title: z.string().nullable(),
  description: z.string().nullable(),
  url: z.string().nullable(),
  dateRange: DateRangeSchema,
});

export const HonorSchema = z.object({
  title: z.string().nullable(),
  issuer: z.string().nullable(),
  description: z.string().nullable(),
  issuedOn: PartialDateSchema.nullable(),
});

export const PublicationSchema = z.object({
  name: z.string().nullable(),
  publisher: z.string().nullable(),
  description: z.string().nullable(),
  url: z.string().nullable(),
  publishedOn: PartialDateSchema.nullable(),
});

export const VolunteerSchema = z.object({
  role: z.string().nullable(),
  organization: z.string().nullable(),
  cause: z.string().nullable(),
  description: z.string().nullable(),
  dateRange: DateRangeSchema,
});

/** Links a member pins to their profile ("Featured"). */
export const FeaturedLinkSchema = z.object({
  title: z.string().nullable(),
  description: z.string().nullable(),
  url: z.string().nullable(),
});

export const ProfileSchema = z.object({
  publicIdentifier: z.string(),
  urn: z.string(),
  /** Numeric member id from `objectUrn`, when the projection carries it. */
  memberId: z.string().nullable(),

  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  fullName: z.string().nullable(),
  headline: z.string().nullable(),
  /** The "About" section. LinkedIn calls this `summary` internally. */
  about: z.string().nullable(),

  location: LocationSchema,
  industry: z.string().nullable(),

  premium: z.boolean(),
  influencer: z.boolean(),

  images: z.object({
    profile: z.array(ImageSchema),
    background: z.array(ImageSchema),
  }),

  experience: z.array(ExperienceSchema),
  education: z.array(EducationSchema),
  skills: z.array(SkillSchema),
  certifications: z.array(CertificationSchema),
  languages: z.array(LanguageSchema),
  projects: z.array(ProjectSchema),
  publications: z.array(PublicationSchema),
  honors: z.array(HonorSchema),
  volunteer: z.array(VolunteerSchema),
  featured: z.array(FeaturedLinkSchema),
});
export type Profile = z.infer<typeof ProfileSchema>;

/**
 * Honest reporting of what we could and could not get.
 *
 * The brief says "when available", and this is how we answer that precisely
 * instead of silently returning `[]`. The distinction matters:
 *
 *   present — the section returned entities
 *   empty   — upstream answered successfully with nothing (the member has none,
 *             OR the collection name is wrong and fails silently; we cannot
 *             tell those apart, and say so rather than implying we can)
 *   failed  — the request itself errored
 */
export const CoverageSchema = z.object({
  present: z.array(z.string()),
  empty: z.array(z.string()),
  failed: z.array(z.object({ section: z.string(), reason: z.string() })),
});

export const ProfileResponseSchema = z.object({
  /** Which upstream path produced this. */
  source: z.enum(['voyager-restli', 'voyager-graphql', 'mixed']),
  fetchedAt: z.string(),
  cached: z.boolean(),
  profile: ProfileSchema,
  coverage: CoverageSchema,
});
export type ProfileResponse = z.infer<typeof ProfileResponseSchema>;
