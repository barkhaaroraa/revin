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
// This is the route the extractors are built on, and the only one left. The
// GraphQL profile-card route it replaced is gone: LinkedIn's own
// `x-li-pem-metadata` header labelled that queryId
// `profile-cards-widget-recommendations`, i.e. the People-You-May-Know widget,
// so it could never have returned profile sections. See progress.md 4a.
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

/**
 * The collections actually requested on a profile fetch.
 *
 * Deliberately NOT `Object.keys(PROFILE_COLLECTIONS)`. That map is the record
 * of every endpoint this project identified — worth keeping as reference — but
 * fetching all of it cost one upstream request per entry, and several entries
 * were never confirmed to return anything.
 *
 * Dropped: `publications`, `honors`, `volunteer` (extractors exist, but four
 * live profiles produced zero rows between them) and `courses` (never had an
 * extractor or a schema field at all — the response was fetched and discarded).
 *
 * Each removal is one fewer upstream request per profile, and upstream request
 * volume is the thing that gets a session challenged. 14 requests per profile
 * became 10, so the same risk budget buys ~40% more profile fetches.
 *
 * `publications`/`honors`/`volunteer` remain in the schema and extractor: a
 * profile response still carries them as empty arrays, and re-enabling one is
 * a matter of adding the key back here.
 *
 * Confirmed returning typed entities against live profiles: `positionGroups`,
 * `positions`, `educations`, `skills`, `certifications`, `languages`,
 * `projects`. The rest are named correctly as far as we can tell but no test
 * profile has had one, so "correct but empty" and "wrong name, silently empty"
 * are still indistinguishable.
 */
export const FETCHED_COLLECTIONS: readonly CollectionKey[] = [
  'positionGroups',
  'positions',
  'educations',
  'skills',
  'certifications',
  'languages',
  'projects',
  'organizations',
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
 * It also returns `*experienceCard` / `*educationCard` pointers shaped
 * `urn:li:fsd_profileCard:(<profileId>,<SECTION_TYPE>,<locale>)`, which is how
 * the card grammar was read rather than guessed. That route is no longer used
 * (see above), but the URN is what first revealed Rest.li 2.0 compound keys.
 */
export const QUERY_PROFILE_BY_VANITY = 'voyagerIdentityDashProfiles.34ead06db82a2cc9a778fac97f69ad6a';
