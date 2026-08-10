/**
 * @fileoverview Crossref domain types derived from the Crossref REST API response shapes.
 * All fields are optional unless Crossref guarantees their presence on every record type.
 * @module services/crossref/types
 */

/**
 * An identifier Crossref carries for an organization, beside a name or instead of one.
 * `id-type` is `ROR` on an organization the publisher asserted by identifier, `DOI` on a funder
 * matched to a Funder Registry entry, and `ISNI` on the registry's other identifier scheme.
 */
export type CrossrefOrganizationId = {
  id: string;
  'id-type'?: string;
  'asserted-by'?: string;
};

/**
 * An institutional affiliation on an author. Crossref guarantees no field on one: an
 * organization the publisher asserted by ROR carries `id` and no `name`.
 */
export type CrossrefAffiliation = {
  name?: string;
  id?: CrossrefOrganizationId[];
};

/** A single author or contributor on a Crossref work. */
export type CrossrefAuthor = {
  given?: string;
  family?: string;
  name?: string;
  ORCID?: string;
  affiliation?: CrossrefAffiliation[];
  sequence?: string;
};

/**
 * A funding assertion on a Crossref work. `name` is absent on an assertion the publisher made by
 * identifier rather than by name, where the `id` array carries the organization's ROR and is the
 * only identity the assertion has.
 */
export type CrossrefFunder = {
  name?: string;
  DOI?: string;
  id?: CrossrefOrganizationId[];
  award?: string[];
  'doi-asserted-by'?: string;
};

/** A license entry on a Crossref work. */
export type CrossrefLicense = {
  URL: string;
  'content-version'?: string;
  'delay-in-days'?: number;
  start?: { 'date-time'?: string };
};

/** A full-text link registered on a Crossref work. */
export type CrossrefLink = {
  URL: string;
  'content-type'?: string;
  'content-version'?: string;
  'intended-application'?: string;
};

/**
 * A date part array from Crossref (year, optional month, optional day). A component Crossref does
 * not know is deposited as `null` in place of the number, so the tuple is `Array<number | null>`
 * rather than `Array<number>` — a record with no registered year arrives as `[[null]]`.
 */
export type CrossrefDateParts = {
  'date-parts'?: Array<Array<number | null>>;
  'date-time'?: string;
  timestamp?: number;
};

/** A single reference entry from a Crossref work's reference list. */
export type CrossrefReference = {
  key?: string;
  unstructured?: string;
  DOI?: string;
  'doi-asserted-by'?: string;
  author?: string;
  year?: string;
  'journal-title'?: string;
  'article-title'?: string;
  volume?: string;
  'first-page'?: string;
  issn?: string;
  issue?: string;
};

/** Raw upstream work shape from the Crossref REST API. All optional except DOI; type can be null. */
export type RawCrossrefWork = {
  DOI: string;
  type: string | null;
  title?: string[];
  'short-title'?: string[];
  subtitle?: string[];
  author?: CrossrefAuthor[];
  editor?: CrossrefAuthor[];
  abstract?: string;
  'is-referenced-by-count'?: number;
  'references-count'?: number;
  'container-title'?: string[];
  'short-container-title'?: string[];
  ISSN?: string[];
  ISBN?: string[];
  publisher?: string;
  'publisher-location'?: string;
  member?: string;
  prefix?: string;
  published?: CrossrefDateParts;
  'published-print'?: CrossrefDateParts;
  'published-online'?: CrossrefDateParts;
  deposited?: CrossrefDateParts;
  indexed?: CrossrefDateParts;
  created?: CrossrefDateParts;
  updated?: CrossrefDateParts;
  issued?: CrossrefDateParts;
  subject?: string[];
  funder?: CrossrefFunder[];
  license?: CrossrefLicense[];
  link?: CrossrefLink[];
  reference?: CrossrefReference[];
  URL?: string;
  score?: number;
  language?: string;
  'content-domain'?: { domain?: string[]; 'crossmark-restriction'?: boolean };
  institution?: CrossrefAffiliation[];
};

/** Raw journal record from Crossref /journals endpoint. */
export type RawCrossrefJournal = {
  ISSN?: string[];
  /** Explicitly `null` — not absent — on a journal with no registered linking ISSN. */
  'ISSN-L'?: string | null;
  title?: string;
  publisher?: string;
  subjects?: Array<{ name: string; ASJC?: number }>;
  'last-status-check-time'?: number;
  counts?: {
    'total-dois'?: number;
    'current-dois'?: number;
    'backfile-dois'?: number;
  };
  breakdowns?: { 'dois-by-issued-year'?: Array<[number, number]> };
  coverage?: Record<string, number>;
  flags?: Record<string, boolean>;
  links?: Array<{ URL: string; 'content-type': string }>;
};

/** Raw funder record from Crossref /funders endpoint. */
export type RawCrossrefFunder = {
  id?: string;
  name?: string;
  'alt-names'?: string[];
  uri?: string;
  tokens?: string[];
  /** Free-text place, not always a country ("European Union"). Projected as the `country` output. */
  location?: string;
  /** Registry IDs this funder supersedes. Always present; empty when it supersedes none. */
  replaces?: string[];
  /** Registry IDs superseding this funder. Always present; empty unless the entry is deprecated. */
  'replaced-by'?: string[];
  'work-count'?: number;
};

/**
 * Raw member (publisher/organization) record from Crossref /members/{id}.
 * `coverage` is a flat map of `<category>-current` / `<category>-backfile` → 0–1 fraction;
 * `flags` is a flat map of `deposits`, `deposits-articles`, and `deposits-<category>-<window>` → boolean.
 */
export type RawCrossrefMember = {
  id: number;
  'primary-name'?: string;
  names?: string[];
  prefixes?: string[];
  prefix?: Array<{ name?: string; value?: string }>;
  counts?: {
    'current-dois'?: number;
    'backfile-dois'?: number;
    'total-dois'?: number;
  };
  'counts-type'?: {
    all?: Record<string, number>;
    current?: Record<string, number>;
    backfile?: Record<string, number>;
  };
  coverage?: Record<string, number>;
  flags?: Record<string, boolean>;
  location?: string;
  tokens?: string[];
  'last-status-check-time'?: number;
  breakdowns?: { 'dois-by-issued-year'?: Array<[number, number]> };
};

/** Raw prefix record from Crossref /prefixes/{prefix}. `member` and `prefix` are URIs, not bare values. */
export type RawCrossrefPrefix = {
  member?: string;
  name?: string;
  prefix?: string;
};

/** Crossref REST API message envelope for a single item. */
export type CrossrefSingleMessage<T> = {
  status: string;
  'message-type': string;
  'message-version': string;
  message: T;
};

/** Crossref REST API message envelope for a list. */
export type CrossrefListMessage<T> = {
  status: string;
  'message-type': string;
  'message-version': string;
  message: {
    facets?: Record<string, unknown>;
    'total-results': number;
    items: T[];
    'items-per-page': number;
    query?: {
      'start-index': number;
      'search-terms': string | null;
    };
    'next-cursor'?: string;
  };
};
