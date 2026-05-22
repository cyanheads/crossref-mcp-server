/**
 * @fileoverview Crossref domain types derived from the Crossref REST API response shapes.
 * All fields are optional unless Crossref guarantees their presence on every record type.
 * @module services/crossref/types
 */

/** A single author or contributor on a Crossref work. */
export type CrossrefAuthor = {
  given?: string;
  family?: string;
  name?: string;
  ORCID?: string;
  affiliation?: Array<{ name: string }>;
  sequence?: string;
};

/** A funding assertion on a Crossref work. */
export type CrossrefFunder = {
  name: string;
  DOI?: string;
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

/** A date part array from Crossref (year, optional month, optional day). */
export type CrossrefDateParts = {
  'date-parts'?: Array<Array<number>>;
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

/** Raw upstream work shape from the Crossref REST API. All optional except DOI and type. */
export type RawCrossrefWork = {
  DOI: string;
  type: string;
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
  institution?: Array<{ name: string }>;
};

/** Raw journal record from Crossref /journals endpoint. */
export type RawCrossrefJournal = {
  ISSN?: string[];
  'ISSN-L'?: string;
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
  country?: string;
  'country-code'?: string;
  tokens?: string[];
  location?: string;
  replaces?: string[];
  'replaced-by'?: string[];
  works?: number;
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
