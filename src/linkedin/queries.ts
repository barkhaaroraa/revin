/**
 * Voyager query identifiers, recovered from a real browser session.
 *
 * THIS IS THE VOLATILE FILE. Every constant here was read out of a HAR capture
 * of linkedin.com, and LinkedIn rotates these hashes whenever it ships a new
 * frontend build. When the API suddenly returns empty results, this file is
 * almost always the thing that needs re-capturing — not the parsers.
 *
 * Re-capture procedure: log in, DevTools -> Network -> filter XHR, load a
 * profile, scroll to the bottom, "Save All As HAR", then re-read the queryId
 * query parameters.
 *
 * Captured: 2026-08-28, against the en_US web client.
 */

export const VOYAGER_BASE = 'https://www.linkedin.com/voyager/api';

// ---------------------------------------------------------------------------
// THE PRIMARY PATH: Rest.li collections.
//
// This is the route the extractors are built on, and it is strictly better
// than the GraphQL card route below.
//
// How it was found: the capture contained one non-GraphQL call shaped
//   /voyager/api/identity/dash/profiles/<urn>?decorationId=...FullProfile-76
// which proves `identity/dash/<collection>` is live. That projection returns
// the profile's SCALAR fields but no positions or educations — so those had to
// be separate collections, reachable through Rest.li's "finder" convention
// (`q=<finderName>`). The collection names mirror the reference keys that
// appear on the Profile entity itself (`*profilePositionGroups`, ...).
//
// Confirmed working against a live profile, every one returning TYPED
// entities — Position, Education, Skill, Certification — rather than the
// serialized UI component tree the GraphQL profile cards hand back. That
// difference is the whole reason this path is preferred: there is a real
// `title` field to read instead of a display string like "NVIDIA - Full-time"
// that would have to be split on a separator.
// ---------------------------------------------------------------------------

/** Rest.li projection selecting the full profile scalar record. */
export const DECORATION_FULL_PROFILE = 'com.linkedin.voyager.dash.deco.identity.profile.FullProfile-76';

/**
 * Profile sub-collections, all reached as:
 *   /voyager/api/identity/dash/<collection>?q=viewee&profileUrn=<encoded urn>
 *
 * `decorationId` is deliberately omitted. It selects a projection, and the
 * server returns a sensible default when it is absent — which means one less
 * versioned string to re-capture every time LinkedIn ships a release.
 */
export const PROFILE_COLLECTIONS = {
  positionGroups: 'profilePositionGroups',
  positions: 'profilePositions',
  educations: 'profileEducations',
  skills: 'profileSkills',
  certifications: 'profileCertifications',
  languages: 'profileLanguages',
  projects: 'profileProjects',
  publications: 'profilePublications',
  honors: 'profileHonors',
  volunteer: 'profileVolunteerExperiences',
  courses: 'profileCourses',
  organizations: 'profileOrganizations',
} as const;

export type CollectionKey = keyof typeof PROFILE_COLLECTIONS;

/** Verified returning typed entities against a live profile. */
export const CONFIRMED_COLLECTIONS: readonly CollectionKey[] = [
  'positionGroups',
  'positions',
  'educations',
  'skills',
  'certifications',
  'languages',
] as const;

/**
 * Step 1 of a profile fetch: vanity slug -> core profile.
 *
 * `variables=(vanityName:<slug>)`
 *
 * This is the only query that accepts the human-readable slug from a profile
 * URL, which makes it our entry point. It returns the `urn:li:fsd_profile:...`
 * URN that every subsequent call needs, plus the core scalar fields:
 * firstName, lastName, headline, publicIdentifier, profilePicture,
 * backgroundPicture, premium/influencer flags, and a `geoLocation` reference.
 *
 * It also returns `*experienceCard` / `*educationCard` pointers, which is how
 * we learned the card URN grammar documented in SECTION_TYPES below.
 */
export const QUERY_PROFILE_BY_VANITY = 'voyagerIdentityDashProfiles.34ead06db82a2cc9a778fac97f69ad6a';

/**
 * Alternative step 1: `variables=(memberIdentity:<slug>)`.
 *
 * Returns a smaller projection (22 fields vs 44) but uniquely includes
 * `profileTopPosition`, the current role, resolved as a real
 * `urn:li:fsd_profilePosition:(<profileId>,<positionId>)` entity. Useful as a
 * cross-check when the EXPERIENCE card fails to parse.
 */
export const QUERY_PROFILE_BY_MEMBER_IDENTITY = 'voyagerIdentityDashProfiles.9bdce5f8ad48e09bdef1f420fbaae9cc';

/**
 * Step 2: profile URN + section -> that section's rendered card.
 *
 * `variables=(profileUrn:<urn>,sectionType:<SECTION_TYPE>)`
 */
export const QUERY_PROFILE_CARDS = 'voyagerIdentityDashProfileCards.aec4c2601fac8c5f615c7630b8db1ab3';

/** Same idea, finer granularity. Uses lowercase-hyphenated section names. */
export const QUERY_PROFILE_COMPONENTS = 'voyagerIdentityDashProfileComponents.86824295e1093fb0f5acdd8d57213aaa';

/**
 * Section identifiers for QUERY_PROFILE_CARDS.
 *
 * We did not have to guess these. The core profile response embeds card
 * references shaped like:
 *
 *   urn:li:fsd_profileCard:(ACoAABMznFkB...,EXPERIENCE,en_US)
 *   urn:li:fsd_profileCard:(<profileId>,<SECTION_TYPE>,<locale>)
 *
 * That compound `(a,b,c)` key is Rest.li protocol 2.0 encoding, and reading
 * EXPERIENCE and EDUCATION straight out of it confirmed sectionType is a plain
 * enum. The remaining values follow the same naming convention; each is
 * verified at runtime and simply yields an empty section if wrong.
 */
export const SECTION_TYPES = {
  about: 'ABOUT',
  experience: 'EXPERIENCE',
  education: 'EDUCATION',
  skills: 'SKILLS',
  certifications: 'LICENSES_AND_CERTIFICATIONS',
  languages: 'LANGUAGES',
  projects: 'PROJECTS',
  publications: 'PUBLICATIONS',
  honors: 'HONORS',
  volunteer: 'VOLUNTEERING_EXPERIENCE',
} as const;

export type SectionKey = keyof typeof SECTION_TYPES;

/**
 * The sections we fetch for a normal profile request, in the order a browser
 * would request them. Ordering matters only for looking like a real client.
 */
export const DEFAULT_SECTIONS: readonly SectionKey[] = [
  'about',
  'experience',
  'education',
  'skills',
  'certifications',
  'languages',
] as const;

/**
 * A profile section is NOT returned as typed data. It is returned as a
 * serialized UI component tree ("tetris"), and this is the single most
 * important thing to understand about parsing LinkedIn.
 *
 * A Component is a tagged union where exactly one of these keys is non-null.
 * An experience row arrives as an `entityComponent` whose title/subtitle/
 * caption are TextViewModels — meaning the mapping from slot to meaning is
 * POSITIONAL CONVENTION, not a named field:
 *
 *   entityComponent.title    -> "Founder and CEO"
 *   entityComponent.subtitle -> "NVIDIA - Full-time"
 *   entityComponent.caption  -> "Jan 1993 - Present - 32 yrs"
 *   entityComponent.metadata -> "Santa Clara, California"
 *
 * There is no `position.companyName` to read. That is why the extractors must
 * be defensive and why the API response carries a `coverage` field: a section
 * that renders fine in a browser can still fail to yield structured data.
 */
export const COMPONENT_UNION_KEYS = [
  'entityComponent',
  'textComponent',
  'fixedListComponent',
  'headerComponent',
  'carouselComponent',
  'insightComponent',
  'completionMeterComponent',
  'profileContentCollectionsComponent',
  'wwuAdsComponent',
] as const;
