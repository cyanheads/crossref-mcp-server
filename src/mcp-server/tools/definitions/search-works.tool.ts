/**
 * @fileoverview crossref_search_works — searches the Crossref works index by free text and/or
 * filters. The result list pages two ways: by offset up to a ~10K ceiling, and by cursor, which
 * has none. A cursor walk with a query term and no sort is sent as `sort=score`, since Crossref
 * otherwise walks in registration order. A cursor walk ends on the first empty page — any token that page carries is withheld
 * rather than relayed, and every empty page carries a notice naming which of its three causes
 * applies; `format()` renders nothing for such a page unless it carries facets, so that notice
 * leads `content[]`. Each work's author list is capped per work by authorLimit, with authorCount
 * carrying the full deposited total and crossref_get_work as the route to the authors a cap left
 * out. Update links (`updatedBy`, `updateTo`) share their shape and line with crossref_get_work,
 * and so do funders, licenses, and full-text links, which a page carries only when `fields` names
 * them; each work's funders are cut at 25 the way its authors are cut at authorLimit, with
 * funderCount the deposited total. `fields` accepts only the select names the summary projects,
 * and decides how far `rows` is capped: 200 under a selection naming funder, license, or link;
 * otherwise 500 under one naming abstract or author; otherwise Crossref's full page. `facets`
 * returns value counts over the whole match set, and `rows: 0` returns those counts and the total
 * alone, on a page that is empty by request. A blank optional input is read as omitted.
 * @module mcp-server/tools/definitions/search-works.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { isBlank, nonBlank } from '@/mcp-server/tools/blank-input.js';
import { cursorNotice } from '@/mcp-server/tools/cursor-notice.js';
import { GRANT_TITLE_NOTICE, hasUntitledGrant } from '@/mcp-server/tools/grant-rows.js';
import { mdText, mdTextInHeading, mdTextInListItem } from '@/mcp-server/tools/markdown-text.js';
import {
  type ClampedPageSize,
  clampPageSize,
  ENTRY_LIMIT_CEILING,
  fitWindow,
  ROWS_CEILING,
  SEARCH_WORKS_AUTHOR_LIMIT_CAP,
  SEARCH_WORKS_OPT_IN_ROWS_CAP,
  SEARCH_WORKS_ROWS_CAP,
} from '@/mcp-server/tools/page-size.js';
import {
  approvedFields,
  approvedLine,
  eventFields,
  eventLine,
  projectApproved,
  projectEvent,
} from '@/mcp-server/tools/work-dates.js';
import {
  FunderSchema,
  funderSection,
  LicenseSchema,
  LinkSchema,
  licenseSection,
  linkSection,
  normalizeFunder,
  projectLicenses,
  projectLinks,
} from '@/mcp-server/tools/work-funders-licenses-links.js';
import { locatorFields, locatorLine, projectLocators } from '@/mcp-server/tools/work-locators.js';
import { projectUpdates, updateFields, updateSections } from '@/mcp-server/tools/work-updates.js';
import {
  getCrossrefService,
  type WorksSearchOptions,
} from '@/services/crossref/crossref-service.js';
import { formatDateParts, resolveWorkSummaryDate } from '@/services/crossref/date-parts.js';
import {
  normalizeAbstract,
  normalizeMarkupText,
  normalizeText,
} from '@/services/crossref/markup-text.js';
import {
  INVALID_CURSOR,
  INVALID_PARAMETER,
  PAGE_TOO_LARGE,
  SORT_CURSOR_CONFLICT,
  UNKNOWN_FILTER,
  UPSTREAM_ERROR_CONTRACT,
} from '@/services/crossref/upstream-errors.js';

/** Offset ceiling enforced by Crossref before cursor paging is required. */
const OFFSET_CAP = 10_000;

/**
 * The selection a page carries when `fields` names none: every name the summary projects but the
 * opt-in ones below. A raw key the projection starts reading joins this list or that one in the
 * same change — absent from both, the key reads as absent on every record.
 */
const DEFAULT_FIELDS = [
  'DOI',
  'title',
  'type',
  'author',
  'published',
  'published-print',
  'published-online',
  'approved',
  'container-title',
  'event',
  'publisher',
  'member',
  'is-referenced-by-count',
  'score',
  'abstract',
  'volume',
  'issue',
  'page',
  'article-number',
  'ISSN',
  'updated-by',
  'update-to',
] as const;

/**
 * Names a page carries only when `fields` names them. Each is a list a record can deposit by the
 * hundred — a collaboration paper's funders, a publisher's license and link entries — so a page
 * that never asked for them keeps the size and the `rows` cap it has always had.
 */
const OPT_IN_FIELDS = ['funder', 'license', 'link'] as const;

/**
 * The `select=` names the work summary projects, and so the only names `fields` accepts. Crossref
 * lists 59 select names on `/works`; a name outside this set would be fetched and then dropped by
 * the projection, which no response surface could report.
 */
const SELECTABLE_FIELDS = [...DEFAULT_FIELDS, ...OPT_IN_FIELDS] as const;

type SelectName = (typeof SELECTABLE_FIELDS)[number];

/**
 * The most funders a work summary carries. A collaboration paper deposits hundreds
 * (`10.1103/physrevd.107.l091102`: 381, 34 KB of `structuredContent` on their own), so the summary
 * carries the first 25 and funderCount the deposited total, as it carries authors and authorCount.
 */
const FUNDER_LIMIT = 25;

/** The facet names Crossref lists for `/works`, in its order; an unlisted name is a 400. */
const FACET_NAMES = [
  'affiliation',
  'license',
  'container-title',
  'publisher-name',
  'link-application',
  'orcid',
  'update-type',
  'published',
  'funder-name',
  'archive',
  'type-name',
  'relation-type',
  'ror-id',
  'issn',
  'source',
  'journal-issue',
  'category-name',
  'assertion',
  'assertion-group',
  'journal-volume',
  'funder-doi',
] as const;

/**
 * The most values Crossref returns for one facet: `"*"` asks for this many, and a larger count is
 * answered with this many as if it had been asked for.
 */
const FACET_VALUE_CEILING = 1000;

/** `name`, `name and other`, `a, b, and c`. */
function listOf(names: readonly string[]): string {
  if (names.length < 3) return names.join(' and ');
  return `${names.slice(0, -1).join(', ')}, and ${names.at(-1)}`;
}

const WorkSummarySchema = z
  .object({
    doi: z.string().describe('Canonical DOI'),
    title: z
      .string()
      .optional()
      .describe(
        'Work title. A grant deposits none: its project titles sit in a field a works list cannot select, and crossref_get_work returns them.',
      ),
    type: z.string().optional().describe('Work type'),
    authors: z
      .array(
        z
          .object({
            given: z.string().optional().describe('Given name'),
            family: z.string().optional().describe('Family name'),
            name: z.string().optional().describe('Name when no given/family split is available'),
          })
          .describe('Author'),
      )
      .optional()
      .describe(
        'Author list for this work, capped at authorLimit. Omitted when the record deposits no author field.',
      ),
    authorCount: z
      .number()
      .optional()
      .describe(
        'Total number of authors deposited for this work, before the authorLimit cap. Greater than the length of authors when the cap cut the list; pass the doi of this work to crossref_get_work to page the whole list.',
      ),
    published: z
      .object({
        year: z.number().optional().describe('Year'),
        month: z.number().optional().describe('Month'),
        day: z.number().optional().describe('Day'),
      })
      .optional()
      .describe(
        'Publication date — the first of published, published-print, and published-online that names one. A component Crossref records as unknown is omitted, and so is every component below it.',
      ),
    ...approvedFields,
    containerTitle: z
      .string()
      .optional()
      .describe('Journal or container name — the first entry of containerTitles'),
    containerTitles: z
      .array(z.string())
      .optional()
      .describe(
        'Every container title the record deposits, in deposited order. A book chapter or proceedings paper often deposits two: the series, then the book or volume. Omitted when the record deposits none.',
      ),
    ...locatorFields,
    ...eventFields,
    issn: z.array(z.string()).optional().describe('ISSN(s) of the containing journal'),
    publisher: z.string().optional().describe('Publisher name'),
    memberId: z
      .number()
      .optional()
      .describe(
        "Crossref member ID of the publisher that holds this DOI now — pass to crossref_get_member for its record. The DOI's prefix names the member that registered the prefix, which for a transferred title is a former publisher. Omitted when the record deposits no member.",
      ),
    ...updateFields,
    isReferencedByCount: z.number().optional().describe('Incoming citation count'),
    score: z.number().optional().describe('Relevance score assigned by Crossref'),
    abstract: z
      .string()
      .optional()
      .describe(
        'Abstract when present in the indexed record — the text of the publisher’s JATS deposit, with markup removed and character references decoded; each section heading of a structured abstract is followed by a colon ("Objectives: …") unless it already ends in a period, colon, question mark, or exclamation mark, a heading whose section holds no text (a figure-only "Graphical Abstract") is dropped, the "Abstract" heading a deposit opens with is dropped, and the items of one list are joined by "; " unless an item already ends in a period, comma, semicolon, colon, question mark, or exclamation mark; numeric JATS superscripts retain caret notation (10^{16}, GeV^2), a link keeps its tag only where its href holds an address the text it wraps does not already carry, and each formula appears once — MathML as the TeX annotation it carries, otherwise written out linearly (x_i, A^{−1}, √(m), (a+b)/c), and TeX deposited beside MathML in whichever notation comes first. Omitted when the deposit holds no text.',
      ),
    funders: z
      .array(FunderSchema)
      .optional()
      .describe(
        `Funding acknowledgements, in deposited order, capped at the first ${FUNDER_LIMIT}. Present only when fields names funder, and omitted when the record deposits none.`,
      ),
    funderCount: z
      .number()
      .optional()
      .describe(
        `Total number of funding acknowledgements deposited for this work, before the ${FUNDER_LIMIT}-funder cap. Greater than the length of funders when the cap cut the list; pass the doi of this work to crossref_get_work for the whole list.`,
      ),
    licenses: z
      .array(LicenseSchema)
      .optional()
      .describe(
        'License terms, in deposited order. Present only when fields names license, and omitted when the record deposits none.',
      ),
    links: z
      .array(LinkSchema)
      .optional()
      .describe(
        'Registered full-text links, in deposited order. Present only when fields names link, and omitted when the record deposits none.',
      ),
  })
  .describe('Work summary');

export const searchWorksTool = tool('crossref_search_works', {
  title: 'Search Works',
  description:
    'Searches the Crossref works index (~188M records) by free text and/or structured filters. The generic query matches loosely across all fields; scope precisely with the field-specific parameters queryTitle, queryAuthor, and queryContainerTitle, or resolve a known citation to its DOI with queryBibliographic — all combine with each other and with query. Use the filter parameter for structured filtering (object with hyphen-separated Crossref keys). Sort options: relevance, score, is-referenced-by-count, published, deposited, indexed, created. Each work returns at most authorLimit authors (25 by default) with authorCount reporting the full deposited total, since a single page of large-collaboration papers can carry tens of thousands of author entries; crossref_get_work pages the whole author list for any DOI whose list was cut. Funding acknowledgements with their award numbers, license terms, and registered full-text links come back only when fields names funder, license, or link, in the entry shapes crossref_get_work uses; each work then carries at most 25 funders, with funderCount the full deposited total. Post-publication updates ride each work as Crossref records them: updatedBy names each correction, retraction, expression of concern, or new version issued against it, and updateTo the works it is itself a notice for — an absent updatedBy does not mean the work was never updated. Set facets to count the matching works per value of a field — per publication year, publisher, type, funder, affiliation, ORCID, and more — over the whole match set in the same call; rows: 0 returns the counts alone. Offset-based paging is capped at ~10K results; use cursor="*" to start cursor-based deep paging, then pass the nextCursor value from each response to continue. A walk with a query term and no sort runs by relevance, one with filters only in Crossref registration order. The walk ends on the page where nextCursor is absent — that page also carries a notice saying the list is exhausted. Cursor and offset cannot be combined.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  input: z.object({
    query: z
      .string()
      .optional()
      .describe(
        'Free-text search query, e.g. "CRISPR gene editing" or "climate change adaptation"',
      ),
    queryBibliographic: z
      .string()
      .optional()
      .describe(
        'Whole-citation match to resolve a known reference to its DOI. Combine title, author, year, and container into one string, e.g. "Watson Crick molecular structure of nucleic acids Nature 1953".',
      ),
    queryTitle: z
      .string()
      .optional()
      .describe('Match against work titles only, e.g. "Array programming with NumPy".'),
    queryAuthor: z
      .string()
      .optional()
      .describe('Match against author names only, e.g. "Charles R. Harris".'),
    queryContainerTitle: z
      .string()
      .optional()
      .describe('Match against the container title (journal or book name) only, e.g. "Nature".'),
    filter: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'Structured filter object using Crossref hyphen-separated keys. All values must be strings. Boolean flag keys (has-abstract, has-references, has-full-text) require string values "true" or "false". Dissertations, and most standards, deposit their date as an approval date rather than a publication date, which the pub-date filters (from-pub-date, until-pub-date) do not read — bound them by date with from-approved-date and until-approved-date. Example: {"type":"journal-article","has-abstract":"true","from-pub-date":"2023-01-01"}',
      ),
    fields: z
      .array(z.enum(SELECTABLE_FIELDS).describe('Crossref select name'))
      .optional()
      .describe(
        `Fields to return (reduces payload). Names are case-sensitive, and each fills one output field: DOI → doi, title → title, type → type, author → authors and authorCount, published / published-print / published-online → published, approved → approved, container-title → containerTitle and containerTitles, event → event, publisher → publisher, member → memberId, is-referenced-by-count → isReferencedByCount, score → score, abstract → abstract, volume → volume, issue → issue, page → page, article-number → articleNumber, ISSN → issn, updated-by → updatedBy, update-to → updateTo, funder → funders and funderCount, license → licenses, link → links. Omitted or empty, every name but funder, license, and link is selected; those three are returned only when named here. A work's funders are capped at the first ${FUNDER_LIMIT}, with funderCount the deposited total. A grant record carries no funders: its funder sits under its project, a field a works list cannot select. A selected field absent from a work means the record does not deposit it. DOI is always returned whether or not it is listed here, so every result stays resolvable by crossref_get_work, which also returns a work's whole funder list and the fields this list does not cover (references, relations, and the rest of the record).`,
      ),
    rows: z
      .number()
      .int()
      .min(0)
      .max(ROWS_CEILING)
      .default(20)
      .describe(
        `Number of results to return per page (default 20): 0–${SEARCH_WORKS_ROWS_CAP} per call when fields names abstract or author, or is omitted or empty, which selects every field but funder, license, and link; 0–${SEARCH_WORKS_OPT_IN_ROWS_CAP} when fields names funder, license, or link, whatever else it names; 0–${ROWS_CEILING} when fields names none of those five. A value above ${SEARCH_WORKS_ROWS_CAP} under the first kind of selection returns ${SEARCH_WORKS_ROWS_CAP} and says so in notice, and one above ${SEARCH_WORKS_OPT_IN_ROWS_CAP} under the second returns ${SEARCH_WORKS_OPT_IN_ROWS_CAP} the same way — on an offset page the notice also names the offset that continues after the records returned. 0 returns no works, only totalResults and any facets, and does not advance a cursor walk.`,
      ),
    facets: z
      .partialRecord(
        z.enum(FACET_NAMES).describe('Crossref facet name'),
        z
          .union([
            z.literal(''),
            z.literal('*'),
            z.number().int().min(1),
            z
              .string()
              .regex(/^[1-9]\d*$/)
              .describe('A number of values written as a decimal string, e.g. "10"'),
          ])
          .describe(
            `"*" for up to ${FACET_VALUE_CEILING} values, or a number of values; a number above ${FACET_VALUE_CEILING} is applied as ${FACET_VALUE_CEILING}`,
          ),
      )
      .optional()
      .describe(
        `Value counts over the whole match set — the records totalResults counts, not just this page — keyed by facet name, each set to "*" or a number of values. Crossref returns the values with the highest counts, at most ${FACET_VALUE_CEILING} per facet; a facet whose values reach its limit may have more, and notice names it. Example: {"published":"*","publisher-name":10} counts works per publication year and for the 10 publishers with the most. Pair with rows: 0 for the counts alone.`,
      ),
    authorLimit: z
      .number()
      .int()
      .min(1)
      .max(ENTRY_LIMIT_CEILING)
      .default(25)
      .describe(
        `Maximum number of authors to return per work (1–${SEARCH_WORKS_AUTHOR_LIMIT_CAP} per call, default 25; a larger value, up to ${ENTRY_LIMIT_CEILING}, applies ${SEARCH_WORKS_AUTHOR_LIMIT_CAP} and says so in notice). Ordinary records fit under the default; large-collaboration papers deposit thousands, and a page of them is large enough to exhaust a client context. Each work reports its full deposited total as authorCount — call crossref_get_work with that work doi to page the authors this cap left out.`,
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Zero-based result offset for offset-based paging. Cannot be used with cursor. Capped at ~10K: offset + rows cannot pass it, so a page that would returns the rows that fit and says so in notice, and an offset at or past it is refused. Use cursor for deeper paging. A search with filters only and no sort has no fixed order: identical requests can order its records differently, so successive offsets can repeat or skip one — sort:"created" with order:"asc" holds the order.',
      ),
    cursor: z
      .string()
      .optional()
      .describe(
        'Cursor token for deep paging. Pass "*" to start cursor-based paging (required past ~10K results), then pass the nextCursor value from each response until a response omits it, which means the list is exhausted. A walk with a query term runs by relevance unless sort is set; a walk with filters only runs in Crossref registration order. Relevance scores shift slightly between identical requests, so a relevance walk can repeat or skip a record at a page boundary — sort:"created" walks every match without repeats. Cannot be combined with offset, or with a publication-date sort (published, published-print, published-online), which Crossref does not walk by cursor.',
      ),
    sort: z
      .union([
        z.literal(''),
        z
          .enum([
            'relevance',
            'score',
            'is-referenced-by-count',
            'published',
            'published-print',
            'published-online',
            'deposited',
            'indexed',
            'created',
            'updated',
            'references-count',
          ])
          .describe('Crossref sort field'),
      ])
      .optional()
      .describe(
        'Sort field. Omitted, an offset page with a query term is ranked by relevance, and so is a cursor walk with one (sent as score). The publication-date sorts (published, published-print, published-online) work with offset paging only — Crossref refuses them alongside cursor; every other sort works with either.',
      ),
    order: z
      .union([z.literal(''), z.enum(['asc', 'desc']).describe('Sort direction')])
      .optional()
      .describe(
        'Sort direction (asc or desc). Applies only alongside sort; without one it has no effect.',
      ),
  }),

  /** Crossref's own names for these parameters — the ones the service sends upstream. */
  inputAliases: {
    select: 'fields',
    'query.bibliographic': 'queryBibliographic',
    'query.title': 'queryTitle',
    'query.author': 'queryAuthor',
    'query.container-title': 'queryContainerTitle',
  },

  output: z.object({
    works: z
      .array(WorkSummarySchema)
      .describe(
        'Matching works. Empty when nothing matched the query, when an offset runs past the end of the results, or on the page that ends a cursor walk — the notice enrichment says which — and on every page requested with rows: 0.',
      ),
    nextCursor: z
      .string()
      .optional()
      .describe(
        'Cursor token to pass as cursor on the next call to continue a cursor walk. Present only on a page requested with cursor that returned works: absent once the walk reaches the end of the list, and on a rows: 0 page, which does not advance it.',
      ),
    facets: z
      .array(
        z
          .object({
            name: z.enum(FACET_NAMES).describe('Facet name, as requested'),
            values: z
              .array(
                z
                  .object({
                    value: z
                      .string()
                      .describe(
                        'The value as Crossref indexes it — a year for published, a name for publisher-name or affiliation, an ORCID or ROR URL for orcid or ror-id',
                      ),
                    count: z.number().describe('Matching works that carry this value'),
                  })
                  .describe('One facet value'),
              )
              .describe(
                'The values with the highest counts, highest first; a tie is ordered by value, descending, as Crossref sends it. Empty when no matching work carries the facet.',
              ),
          })
          .describe('One facet'),
      )
      .optional()
      .describe(
        'One entry per facet requested, in the order requested. Counts cover every record totalResults counts, not just this page, so every page of a cursor walk carries the same ones. A work that deposits no value for the facet is in no count, and one that carries several (several affiliations, a retraction that is also an erratum) is in each. Absent when facets was not set or was empty.',
      ),
  }),

  enrichment: {
    totalResults: z.number().describe('Total matching records in Crossref'),
    returned: z.number().describe('Number of records returned in this response'),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when at least one work on this page had its author list cut by authorLimit. Absent when every work on the page carries its full deposited author list.',
      ),
    cap: z
      .number()
      .optional()
      .describe('The per-work author cap applied to this page. Absent when no list was cut.'),
    notice: z
      .string()
      .optional()
      .describe(
        `Guidance on an empty page, naming which of its three causes applies: a query nothing matched, an offset past the end of a list that did match, or a cursor walk that has reached the end of the list. A rows: 0 page names only the first, and beside a cursor says that the page does not advance the walk. On a page carrying records, present when authorLimit cut at least one work's author list or the ${FUNDER_LIMIT}-funder cap one work's funder list, naming how many and the route to the rest; when a grant row lacks the title a selection of both type and title asked for, naming crossref_get_work as the route to it; or when every query term and filter value was supplied blank, so the page lists the whole index unfiltered. On any page, present when rows or authorLimit was above its per-call cap, naming the value requested and the cap applied — for rows under a fields selection naming funder, license, or link, also the caps a selection without them takes; under one naming abstract or author, also that one naming neither takes rows up to ${ROWS_CEILING}; on an offset page with records remaining, also the offset that continues after the records returned. On an offset page where offset + rows would pass the ~10K offset ceiling, present naming the rows requested and the rows that fit and were applied, and, when records remain past the ceiling, cursor as the route to them. Present when a facets count was above ${FACET_VALUE_CEILING}, naming the count requested and the ${FACET_VALUE_CEILING} applied, and when a facet returned as many values as its limit, naming the facet and the route to the values it may have left out. A page needing more than one caveat carries them all in this one string.`,
      ),
  },

  errors: [
    ...UPSTREAM_ERROR_CONTRACT,
    UNKNOWN_FILTER,
    SORT_CURSOR_CONFLICT,
    INVALID_CURSOR,
    INVALID_PARAMETER,
    PAGE_TOO_LARGE,
    {
      reason: 'cursor_offset_conflict',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Both cursor and offset were supplied in the same request.',
      recovery:
        'Use cursor or offset, not both. Pass cursor="*" to start cursor-based paging; use offset only for the first ~10K results.',
    },
    {
      reason: 'offset_too_large',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The requested offset is at or past the ~10K limit Crossref puts on offset + rows, so no page of any size starts there.',
      recovery:
        'Switch to cursor-based paging by passing cursor="*" on the first request, then chaining the nextCursor token from each response.',
    },
  ],

  async handler(input, ctx) {
    /**
     * A blank string is not a cursor. Form-based clients send `""` for an optional field
     * nobody filled in, and the service picks its selector by truthiness — so a blank never
     * reaches Crossref and the page comes back through the offset path. Normalizing here is
     * what keeps every guard below reading the value the request will actually carry: the
     * conflict guard stops refusing an offset that has no cursor to conflict with, and the
     * empty-page notice stops calling an offset page a cursor walk.
     */
    const cursor = input.cursor?.trim() || undefined;
    /**
     * The same reading for every other optional string: a blank query term, filter value,
     * `sort`, or `order` is omitted rather than sent. Sent, a blank `query` is ignored upstream
     * but a blank field query matches nothing, and a blank filter value is rejected on a
     * type-checked key and applied as a match on a free-text one — three different answers to
     * a field nobody filled in. A non-blank value goes through exactly as supplied.
     */
    const terms = {
      query: nonBlank(input.query),
      queryBibliographic: nonBlank(input.queryBibliographic),
      queryTitle: nonBlank(input.queryTitle),
      queryAuthor: nonBlank(input.queryAuthor),
      queryContainerTitle: nonBlank(input.queryContainerTitle),
    };
    const filterEntries = Object.entries(input.filter ?? {}).filter(([, value]) => !isBlank(value));
    const filter = filterEntries.length > 0 ? Object.fromEntries(filterEntries) : undefined;
    /**
     * A cursor walk with no sort runs in Crossref registration order, ranking nothing, so a walk
     * with a query term asks for `sort=score` — the ranking an offset page applies by default.
     * `order` is dropped on that walk: Crossref ignores it without a caller sort today, and
     * beside `sort=score` an `asc` would put the least relevant records first. A filter-only
     * walk has no ranking to keep, and an offset page is already ranked.
     */
    const relevanceWalk =
      cursor !== undefined &&
      nonBlank(input.sort) === undefined &&
      Object.values(terms).some((term) => term !== undefined);
    const sort = relevanceWalk ? 'score' : nonBlank(input.sort);
    const order = relevanceWalk ? undefined : nonBlank(input.order);
    /**
     * Dropping blanks can leave a request that searches nothing — `{"queryTitle": ""}` becomes
     * a listing of the whole index. That is only worth saying when a blank was dropped: a call
     * that names no term at all asked for the listing.
     */
    const onlyBlankTerms =
      filter === undefined &&
      Object.values(terms).every((term) => term === undefined) &&
      [
        input.query,
        input.queryBibliographic,
        input.queryTitle,
        input.queryAuthor,
        input.queryContainerTitle,
        ...Object.values(input.filter ?? {}),
      ].some(isBlank);

    // Validate: cursor and offset cannot coexist
    if (cursor !== undefined && input.offset !== undefined) {
      throw ctx.fail('cursor_offset_conflict', 'Provide cursor or offset, not both.');
    }

    // No selection is the default one, never Crossref's whole record.
    const fields: readonly SelectName[] = input.fields?.length ? input.fields : DEFAULT_FIELDS;
    const selects = (name: SelectName) => fields.includes(name);
    /**
     * Clamped once, here, so the offset window, the upstream request, the per-work author
     * slice, and the `cap` enrichment all read the page size actually used. Only a selection
     * carrying what makes a work heavy is capped: a funder, license, or link list the lowest,
     * whatever else it names, then an abstract or an author list. One naming none of the five
     * is bounded by the schema's own ceiling.
     */
    const optIn = OPT_IN_FIELDS.some(selects);
    const heavy = selects('abstract') || selects('author');
    const rowsCap = optIn
      ? SEARCH_WORKS_OPT_IN_ROWS_CAP
      : heavy
        ? SEARCH_WORKS_ROWS_CAP
        : undefined;
    const rowsClamp: ClampedPageSize =
      rowsCap === undefined ? { value: input.rows } : clampPageSize('rows', input.rows, rowsCap);
    const authorLimitClamp = clampPageSize(
      'authorLimit',
      input.authorLimit,
      SEARCH_WORKS_AUTHOR_LIMIT_CAP,
    );
    const authorLimit = authorLimitClamp.value;
    /**
     * Facets in the order the caller listed them, each with the limit sent. A blank limit is a
     * facet a form left unfilled, read as omitted like a blank filter value, and a count written
     * as a decimal string ("10") is the number it spells. Crossref answers a count above its
     * per-facet ceiling with the ceiling and says nothing, so the clamp is made here, where the
     * page can name the count requested and the one applied.
     */
    type FacetEntry = [(typeof FACET_NAMES)[number], string | number];
    const facetRequests = (Object.entries(input.facets ?? {}) as FacetEntry[])
      .filter(([, value]) => value !== '')
      .map(([name, value]) => {
        const requested: '*' | number = value === '*' ? '*' : Number(value);
        return {
          name,
          requested,
          limit: requested === '*' ? requested : Math.min(requested, FACET_VALUE_CEILING),
        };
      });

    /**
     * Crossref's ceiling is on offset + rows, so an offset below it still reaches the records up
     * to it with a smaller page — the one reading such a request has, applied the way the
     * per-call cap is rather than refused. Only an offset at or past the ceiling, where no row
     * fits, is refused. A cursor page carries no offset, so it has no window.
     */
    const offset = input.offset;
    if (offset !== undefined && offset >= OFFSET_CAP) {
      throw ctx.fail(
        'offset_too_large',
        `Offset ${offset} is at or past the ~${OFFSET_CAP} limit Crossref puts on offset + rows, so no page starts there.`,
        { offset },
      );
    }
    const { rows, cut: windowCut } =
      offset === undefined
        ? { rows: rowsClamp.value, cut: undefined }
        : fitWindow(
            'offset',
            offset,
            OFFSET_CAP,
            `~${OFFSET_CAP} limit Crossref puts on offset + rows`,
            input.rows,
            rowsClamp,
          );

    ctx.log.info('Searching works', {
      query: terms.query,
      filter,
      rows,
      cursor,
      offset: input.offset,
    });

    const svc = getCrossrefService();
    const searchOpts: WorksSearchOptions = {
      rows,
      ...(terms.query !== undefined && { query: terms.query }),
      ...(terms.queryBibliographic !== undefined && {
        queryBibliographic: terms.queryBibliographic,
      }),
      ...(terms.queryTitle !== undefined && { queryTitle: terms.queryTitle }),
      ...(terms.queryAuthor !== undefined && { queryAuthor: terms.queryAuthor }),
      ...(terms.queryContainerTitle !== undefined && {
        queryContainerTitle: terms.queryContainerTitle,
      }),
      ...(filter !== undefined && { filter }),
      fields,
      ...(input.offset !== undefined && { offset: input.offset }),
      ...(cursor !== undefined && { cursor }),
      ...(sort !== undefined && { sort }),
      ...(order !== undefined && { order }),
      ...(facetRequests.length > 0 && {
        facets: facetRequests.map(({ name, limit }) => ({ name, limit })),
      }),
    };
    const result = await svc.searchWorks(searchOpts, ctx);

    const works = result.items.map((raw) => {
      const published = resolveWorkSummaryDate(raw);
      const containerTitles = raw['container-title']?.map(normalizeMarkupText);
      const containerTitle = containerTitles?.[0];
      const abstract = raw.abstract === undefined ? undefined : normalizeAbstract(raw.abstract);
      return {
        doi: raw.DOI,
        ...(raw.title?.[0] !== undefined && { title: normalizeMarkupText(raw.title[0]) }),
        ...(raw.type != null && { type: raw.type }),
        /**
         * The cap is applied here, once, so structuredContent and format() are handed the
         * identical list — the same split get-references uses for its page. authorCount rides
         * alongside so a cut list is visibly cut rather than passing for the whole deposit.
         */
        ...(raw.author && {
          authorCount: raw.author.length,
          authors: raw.author.slice(0, authorLimit).map((a) => ({
            ...(a.given && { given: normalizeText(a.given) }),
            ...(a.family && { family: normalizeText(a.family) }),
            ...(a.name && { name: normalizeText(a.name) }),
          })),
        }),
        ...(published !== undefined && { published }),
        ...projectApproved(raw),
        ...(containerTitle !== undefined && { containerTitle, containerTitles }),
        ...projectLocators(raw),
        ...projectEvent(raw),
        ...(raw.ISSN?.length && { issn: raw.ISSN }),
        ...(raw.publisher !== undefined && { publisher: normalizeText(raw.publisher) }),
        // A digit string (`"311"`) as Crossref deposits it; anything else is no ID to pass on.
        ...(raw.member !== undefined &&
          /^\d+$/.test(raw.member) && { memberId: Number(raw.member) }),
        ...projectUpdates(raw),
        ...(raw['is-referenced-by-count'] !== undefined && {
          isReferencedByCount: raw['is-referenced-by-count'],
        }),
        ...(raw.score !== undefined && { score: raw.score }),
        ...(abstract !== undefined && { abstract }),
        /**
         * The opt-in lists are read only where named, so a page that never asked for them carries
         * none whatever a record holds. Funders are cut here, once, as authors are, so both
         * surfaces are handed the same list and funderCount keeps a cut one visibly cut.
         */
        ...(selects('funder') &&
          raw.funder && {
            funderCount: raw.funder.length,
            funders: raw.funder.slice(0, FUNDER_LIMIT).map(normalizeFunder),
          }),
        ...(selects('license') && projectLicenses(raw)),
        ...(selects('link') && projectLinks(raw)),
      };
    });

    const returned = works.length;
    /** Whether this page came back through the cursor, on the normalized value the request carried. */
    const isCursorPage = cursor !== undefined;
    /**
     * The walk is over when a page comes back empty, and this page's item count is the one
     * quantity that says so. Crossref's `next-cursor` is a search-after key — it decodes to
     * `<sort-value>,<DOI>` and changes on every page — and the last partial page of a list
     * still carries one, so a token's presence does not mean more records remain. Crossref
     * has at times also handed a token back on the empty page past the end, which a caller
     * chaining it would re-send forever; today that page carries none, and withholding any it
     * does carry keeps "no continuation field means the list is exhausted" true on every
     * cursor surface this server exposes whichever way upstream answers. `totalResults`
     * cannot serve as the guard: it describes the query and stays at its full value on an
     * exhausted page.
     */
    const nextCursor = returned > 0 ? result.nextCursor : undefined;
    /**
     * Each requested facet as Crossref counted it, in the caller's order, beside the limit it was
     * sent with. Crossref's own facet order is not the request's, and its `value-count` counts
     * the values it returned rather than the distinct values that exist.
     */
    const facets = facetRequests.flatMap(({ name, limit }) => {
      const counted = result.facets?.find((facet) => facet.name === name);
      return counted ? [{ name, limit, values: counted.values }] : [];
    });

    ctx.enrich({ totalResults: result.totalResults, returned });
    /**
     * `notice` is last-wins, and a page can need more than one caveat — an unfiltered listing
     * whose author lists were also capped. Collected and emitted as one string so none
     * silently overwrites another.
     */
    const notices: string[] = [];
    /**
     * The restart advisory asks the caller to compare this page's records with the last and
     * chain the token it returns; a rows: 0 page has neither, and the cursor it was given is
     * still the one to send next, where the advisory then applies.
     */
    const restart = rows === 0 ? undefined : cursorNotice(cursor);
    if (restart) notices.push(restart);
    const next = (offset ?? 0) + returned;
    if (windowCut) {
      // A window-cut page ends at the ceiling unless the list ends first; only then is there a
      // record past it to route to the cursor.
      notices.push(
        next >= OFFSET_CAP && next < result.totalResults
          ? `${windowCut} — the last records offset paging reaches. To read past them, walk the list with cursor="*" and chain nextCursor; the walk starts at the first record, not after these.`
          : `${windowCut}.`,
      );
    } else if (rowsClamp.notice) {
      /**
       * This tool has no nextOffset field, so a caller continuing an offset walk adds what it
       * asked for — and offset + the requested rows would skip every record between the cap
       * and the request. The page names the offset that actually follows it; a page there that
       * would pass the ceiling is cut to the rows that fit when it is requested.
       */
      const continuation =
        isCursorPage || returned === 0 || next >= result.totalResults
          ? ''
          : next < OFFSET_CAP
            ? ` Pass offset=${next} for the next page — the offset after the ${returned} records returned, not after the ${input.rows} requested.`
            : ` Records past offset ${next} are beyond the ~${OFFSET_CAP} offset limit. To read them, walk the list with cursor="*" and chain nextCursor; the walk starts at the first record, not at offset ${next}.`;
      /**
       * A selection the caller wrote is told how a larger page is reached. An omitted or empty
       * `fields` selects every default field and keeps the notice such a page has always carried.
       */
      const tier = !input.fields?.length
        ? ''
        : optIn
          ? ` That cap holds for a fields selection including funder, license, or link; without them, one including abstract or author takes rows up to ${SEARCH_WORKS_ROWS_CAP}, and one naming neither up to ${ROWS_CEILING}.`
          : ` That cap holds for a fields selection including abstract or author; one naming neither takes rows up to ${ROWS_CEILING}.`;
      notices.push(`${rowsClamp.notice}${tier}${continuation}`);
    }
    if (authorLimitClamp.notice) notices.push(authorLimitClamp.notice);
    for (const { name, requested, limit } of facetRequests) {
      if (requested !== limit) {
        notices.push(
          `facets.${name} ${requested} is above the ${FACET_VALUE_CEILING} values Crossref returns per facet, so ${limit} was applied.`,
        );
      }
    }
    if (onlyBlankTerms) {
      notices.push(
        `Every search term supplied was blank, so none was sent — this page is an unfiltered listing of the whole Crossref works index (${result.totalResults} records), not a match. Supply a non-blank query term or filter value to search.`,
      );
    }
    /**
     * Every empty page says why. `returned === 0` is what makes a page empty; `totalResults`
     * only separates the causes, and keying the notice on it alone left the two commonest
     * empty pages — a walk past the end of a list, an offset past the end of one — carrying
     * no explanation on either result surface. Without facets this tool's whole payload is
     * `works`, so an unannotated empty page renders as nothing at all for a client reading
     * content[], where the journal and funder works lists at least still render their own record.
     *
     * A rows: 0 page is empty by request, so neither past-the-end cause is true of it: its offset
     * is past nothing, and a cursor page it ends is not the end of the walk. Only a match set
     * with nothing in it is still worth naming; with records matched and a cursor, the notice
     * says the walk has not moved.
     */
    if (returned === 0) {
      const total = result.totalResults;
      if (total === 0) {
        notices.push(
          'No results matched the query. Try broadening the search terms or removing filters.',
        );
      } else if (rows === 0) {
        if (isCursorPage) {
          notices.push(
            'rows 0 returns no works, so this page does not advance the cursor walk: nextCursor is absent because no record was read, not because the walk is complete. Pass the same cursor with rows of 1 or more to continue it.',
          );
        }
      } else if (isCursorPage) {
        notices.push(
          `This cursor walk is complete — ${total === 1 ? 'the 1 matching record has' : `all ${total} matching records have`} been returned. nextCursor is withheld on this page; stop chaining it.`,
        );
      } else {
        notices.push(
          `Offset ${input.offset ?? 0} is past the end of this result list — ${total} ${total === 1 ? 'record' : 'records'} matched. Request an offset below ${total}.`,
        );
      }
    }

    /**
     * Disclosure of the cap is page-level because the cut is per-work: `authorCount` on each
     * work says which lists were shortened and by how much, and this pair says a cut happened
     * at all, on both result surfaces, without enumerating DOIs a caller can already read off
     * the works array.
     */
    const cutWorks = works.filter(
      (w) => w.authorCount !== undefined && w.authorCount > (w.authors?.length ?? 0),
    ).length;
    if (cutWorks > 0) {
      ctx.enrich({ truncated: true, cap: authorLimit });
      // Raising authorLimit is advice only below the per-call cap; at it, a larger value clamps back.
      const widen =
        authorLimit < SEARCH_WORKS_AUTHOR_LIMIT_CAP
          ? ', or raise authorLimit to widen the cap here'
          : ` — ${SEARCH_WORKS_AUTHOR_LIMIT_CAP} is the most authorLimit applies, so a larger value widens nothing here`;
      notices.push(
        `Author lists were capped at ${authorLimit} per work — ${cutWorks} of the ${returned} ${returned === 1 ? 'work' : 'works'} on this page ${cutWorks === 1 ? 'carries' : 'carry'} more authors than are shown. Each work reports its full deposited total as authorCount; call crossref_get_work with that work doi to page its whole author list${widen}.`,
      );
    }
    // The funder cut is disclosed the same way; its cap is fixed, so the one route is get_work.
    const cutFunders = works.filter(
      (w) => w.funderCount !== undefined && w.funderCount > (w.funders?.length ?? 0),
    ).length;
    if (cutFunders > 0) {
      notices.push(
        `Funder lists were capped at ${FUNDER_LIMIT} per work — ${cutFunders} of the ${returned} ${returned === 1 ? 'work' : 'works'} on this page ${cutFunders === 1 ? 'carries' : 'carry'} more funders than are shown. Each work reports its full deposited total as funderCount; call crossref_get_work with that work doi for its whole funder list.`,
      );
    }
    // Only a page that asked for both can tell an untitled grant from a row whose title was not selected.
    if (selects('type') && selects('title') && hasUntitledGrant(works)) {
      notices.push(GRANT_TITLE_NOTICE);
    }
    /**
     * Crossref says how many values it returned, never how many exist, so a facet that returned
     * as many as its limit may have stopped short — and one that returned fewer has none left.
     * The route to the rest depends on the limit: below the ceiling a larger count reaches them,
     * and at it only a narrower match set does.
     */
    const filled = facets
      .map(({ name, limit, values }) => ({
        name,
        limit: limit === '*' ? FACET_VALUE_CEILING : limit,
        returnedValues: values.length,
      }))
      .filter(({ limit, returnedValues }) => returnedValues >= limit);
    const belowCeiling = filled.filter(({ limit }) => limit < FACET_VALUE_CEILING);
    const atCeiling = filled.filter(({ limit }) => limit === FACET_VALUE_CEILING);
    if (belowCeiling.length > 0) {
      const one = belowCeiling.length === 1;
      notices.push(
        `${one ? 'Facet' : 'Facets'} ${listOf(belowCeiling.map(({ name, limit }) => `${name} (${limit})`))} returned as many values as ${one ? 'its limit' : 'their limits'} and may have more: a larger count, up to ${FACET_VALUE_CEILING}, or "*" returns more.`,
      );
    }
    if (atCeiling.length > 0) {
      const one = atCeiling.length === 1;
      notices.push(
        `${one ? 'Facet' : 'Facets'} ${listOf(atCeiling.map(({ name }) => name))} returned ${FACET_VALUE_CEILING} values, the most Crossref returns per facet, and may have more: only a narrower query or filter reaches the rest.`,
      );
    }
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    return {
      works,
      ...(nextCursor && { nextCursor }),
      ...(facetRequests.length > 0 && {
        facets: facets.map(({ name, values }) => ({ name, values })),
      }),
    };
  },

  format: (result) => {
    const lines: string[] = [];
    if (result.nextCursor) lines.push(`**Next cursor:** \`${result.nextCursor}\``, '');

    /**
     * Facets lead, since they describe the whole match set rather than this page. A value opens
     * its list item's content, where a leading `#`, `-`, or `19.` would open a block inside the
     * item and lose its marker, and it is unnormalized, so it can carry line breaks that begin
     * more lines: it takes the list-item escape.
     */
    for (const facet of result.facets ?? []) {
      const n = facet.values.length;
      lines.push(
        `**Facet:** ${facet.name} — ${n === 0 ? 'no values' : `${n} ${n === 1 ? 'value' : 'values'}`}`,
        ...facet.values.map(({ value, count }) => `- ${mdTextInListItem(value)}: ${count}`),
        '',
      );
    }

    for (const w of result.works) {
      lines.push(`### ${w.title ? mdTextInHeading(w.title) : w.doi}`);
      lines.push(`**DOI:** ${w.doi}${w.type ? ` | **Type:** ${w.type}` : ''}`);
      if (w.published?.year) lines.push(`**Published:** ${formatDateParts(w.published)}`);
      const approved = approvedLine(w);
      if (approved) lines.push(approved);
      if (w.containerTitles?.length)
        lines.push(`**Journal:** ${w.containerTitles.map(mdText).join(' | ')}`);
      const locators = locatorLine(w);
      if (locators) lines.push(locators);
      const event = eventLine(w);
      if (event) lines.push(event);
      if (w.issn?.length) lines.push(`**ISSN:** ${w.issn.join(', ')}`);
      if (w.publisher) lines.push(`**Publisher:** ${mdText(w.publisher)}`);
      if (w.memberId !== undefined) lines.push(`**Member ID:** ${w.memberId}`);
      /**
       * Update links render ahead of the author line and abstract, so a retraction is seen
       * before either. Each is a list of its own, opened and closed by a blank line so a
       * CommonMark reader never folds the next field into the last bullet.
       */
      const sections = updateSections(w);
      if (sections.length > 0) {
        for (const section of sections) lines.push('', ...section);
        lines.push('');
      }
      if (w.authors?.length) {
        const authorStr = w.authors
          .map((a) => [a.given, a.family, a.name].filter(Boolean).join(' '))
          .filter(Boolean)
          .map(mdText)
          .join(', ');
        const total = w.authorCount ?? w.authors.length;
        const cut =
          total > w.authors.length
            ? ` — showing ${w.authors.length} of ${total}; call crossref_get_work with doi ${w.doi} to page the rest`
            : '';
        lines.push(`**Authors:** ${authorStr}${cut}`);
      }
      if (w.isReferencedByCount !== undefined) lines.push(`**Cited by:** ${w.isReferencedByCount}`);
      if (w.score !== undefined) lines.push(`**Score:** ${w.score}`);
      if (w.abstract) lines.push(`**Abstract:** ${mdText(w.abstract)}`);
      /**
       * Funders, licenses, and links close the block in the order crossref_get_work renders
       * them, each list opened by a blank line; the blank line that ends the block closes the
       * last, so the next work's heading is never read into its final bullet.
       */
      for (const section of [funderSection(w), licenseSection(w), linkSection(w)]) {
        if (section) lines.push('', ...section);
      }
      lines.push('');
    }

    /**
     * A page with neither a work nor a facet renders nothing of its own. Its counts and the
     * notice naming its cause ride the enrichment trailer, which the framework appends after
     * this — so emitting a block here would put an empty `content[0]` ahead of the only text the
     * page has, and a client that shows the first block would show nothing. nextCursor is never
     * set on an empty page, so nothing else is lost.
     */
    return lines.length === 0 ? [] : [{ type: 'text', text: lines.join('\n') }];
  },
});
