/**
 * @fileoverview crossref_search_works — searches the Crossref works index by free text and/or
 * filters. The result list pages two ways: by offset up to a ~10K ceiling, and by cursor, which
 * has none. A cursor walk ends on the first empty page — Crossref keeps minting a token past the
 * end of a list, so the token is withheld there rather than relayed, and every empty page carries
 * a notice naming which of its three causes applies.
 * @module mcp-server/tools/definitions/search-works.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  formatDateParts,
  getCrossrefService,
  normalizeMarkupText,
  normalizeText,
  parseDateParts,
  type WorksSearchOptions,
} from '@/services/crossref/crossref-service.js';
import { UPSTREAM_ERROR_CONTRACT } from '@/services/crossref/upstream-errors.js';

/** Offset ceiling enforced by Crossref before cursor paging is required. */
const OFFSET_CAP = 10_000;

const WorkSummarySchema = z
  .object({
    doi: z.string().describe('Canonical DOI'),
    title: z.string().optional().describe('Work title'),
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
      .describe('Author list'),
    published: z
      .object({
        year: z.number().optional().describe('Year'),
        month: z.number().optional().describe('Month'),
        day: z.number().optional().describe('Day'),
      })
      .optional()
      .describe('Publication date'),
    containerTitle: z.string().optional().describe('Journal or container name'),
    publisher: z.string().optional().describe('Publisher name'),
    isReferencedByCount: z.number().optional().describe('Incoming citation count'),
    score: z.number().optional().describe('Relevance score assigned by Crossref'),
    abstract: z.string().optional().describe('Abstract when present in the indexed record'),
  })
  .describe('Work summary');

export const searchWorksTool = tool('crossref_search_works', {
  title: 'Search Works',
  description:
    'Searches the Crossref works index (~155M records) by free text and/or structured filters. The generic query matches loosely across all fields; scope precisely with the field-specific parameters queryTitle, queryAuthor, and queryContainerTitle, or resolve a known citation to its DOI with queryBibliographic — all combine with each other and with query. Use the filter parameter for structured filtering (object with hyphen-separated Crossref keys). Sort options: relevance, score, is-referenced-by-count, published, deposited, indexed. Offset-based paging is capped at ~10K results; use cursor="*" to start cursor-based deep paging, then pass the nextCursor value from each response to continue. The walk ends on the page where nextCursor is absent — that page also carries a notice saying the list is exhausted. Cursor and offset cannot be combined.',
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
        'Structured filter object using Crossref hyphen-separated keys. All values must be strings. Boolean flag keys (has-abstract, has-references, has-full-text) require string values "true" or "false". Example: {"type":"journal-article","has-abstract":"true","from-pub-date":"2023-01-01","directory":"DOAJ"}',
      ),
    fields: z
      .array(z.string())
      .optional()
      .describe(
        'Fields to return (reduces payload). Names are case-sensitive. Useful set: DOI, title, author, published, type, is-referenced-by-count, abstract, container-title, publisher, score. DOI is always returned whether or not it is listed here, so every result stays resolvable by crossref_get_work.',
      ),
    rows: z
      .number()
      .min(1)
      .max(100)
      .default(20)
      .describe('Number of results to return per page (1–100, default 20)'),
    offset: z
      .number()
      .min(0)
      .optional()
      .describe(
        'Zero-based result offset for offset-based paging. Cannot be used with cursor. Capped at ~10K; use cursor for deeper paging.',
      ),
    cursor: z
      .string()
      .optional()
      .describe(
        'Cursor token for deep paging. Pass "*" to start cursor-based paging (required past ~10K results), then pass the nextCursor value from each response until a response omits it, which means the list is exhausted. Cannot be combined with offset.',
      ),
    sort: z
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
      .optional()
      .describe('Sort field'),
    order: z.enum(['asc', 'desc']).optional().describe('Sort direction (asc or desc)'),
  }),

  output: z.object({
    works: z
      .array(WorkSummarySchema)
      .describe(
        'Matching works. Empty when nothing matched the query, when an offset runs past the end of the results, or on the page that ends a cursor walk — the notice enrichment says which.',
      ),
    nextCursor: z
      .string()
      .optional()
      .describe(
        'Cursor token to pass as cursor on the next call to continue a cursor walk. Present only on a page requested with cursor, and absent once the walk reaches the end of the list.',
      ),
  }),

  enrichment: {
    totalResults: z.number().describe('Total matching records in Crossref'),
    returned: z.number().describe('Number of records returned in this response'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance on an empty page, naming which of its three causes applies: a query nothing matched, an offset past the end of a list that did match, or a cursor walk that has reached the end of the list. Absent on a page carrying records.',
      ),
  },

  errors: [
    ...UPSTREAM_ERROR_CONTRACT,
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
      when: 'The requested offset exceeds the ~10K Crossref limit for offset-based paging.',
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

    // Validate: cursor and offset cannot coexist
    if (cursor !== undefined && input.offset !== undefined) {
      throw ctx.fail('cursor_offset_conflict', 'Provide cursor or offset, not both.', {
        ...ctx.recoveryFor('cursor_offset_conflict'),
      });
    }

    // Validate: offset cap
    const rows = input.rows;
    if (input.offset !== undefined && cursor === undefined && input.offset + rows > OFFSET_CAP) {
      throw ctx.fail(
        'offset_too_large',
        `Offset ${input.offset} + rows ${rows} = ${input.offset + rows} exceeds the ~${OFFSET_CAP} Crossref offset limit.`,
        { offset: input.offset, rows, ...ctx.recoveryFor('offset_too_large') },
      );
    }

    ctx.log.info('Searching works', {
      query: input.query,
      filter: input.filter,
      rows,
      cursor,
      offset: input.offset,
    });

    const svc = getCrossrefService();
    const searchOpts: WorksSearchOptions = {
      rows,
      ...(input.query !== undefined && { query: input.query }),
      ...(input.queryBibliographic !== undefined && {
        queryBibliographic: input.queryBibliographic,
      }),
      ...(input.queryTitle !== undefined && { queryTitle: input.queryTitle }),
      ...(input.queryAuthor !== undefined && { queryAuthor: input.queryAuthor }),
      ...(input.queryContainerTitle !== undefined && {
        queryContainerTitle: input.queryContainerTitle,
      }),
      ...(input.filter !== undefined && { filter: input.filter }),
      ...(input.fields !== undefined && { fields: input.fields }),
      ...(input.offset !== undefined && { offset: input.offset }),
      ...(cursor !== undefined && { cursor }),
      ...(input.sort !== undefined && { sort: input.sort }),
      ...(input.order !== undefined && { order: input.order }),
    };
    const result = await svc.searchWorks(searchOpts, ctx);

    const works = result.items.map((raw) => {
      const published =
        parseDateParts(raw.published) ??
        parseDateParts(raw['published-print']) ??
        parseDateParts(raw['published-online']);
      return {
        doi: raw.DOI,
        ...(raw.title?.[0] !== undefined && { title: normalizeMarkupText(raw.title[0]) }),
        ...(raw.type != null && { type: raw.type }),
        ...(raw.author && {
          authors: raw.author.map((a) => ({
            ...(a.given && { given: normalizeText(a.given) }),
            ...(a.family && { family: normalizeText(a.family) }),
            ...(a.name && { name: normalizeText(a.name) }),
          })),
        }),
        ...(published !== undefined && { published }),
        ...(raw['container-title']?.[0] !== undefined && {
          containerTitle: normalizeMarkupText(raw['container-title'][0]),
        }),
        ...(raw.publisher !== undefined && { publisher: normalizeText(raw.publisher) }),
        ...(raw['is-referenced-by-count'] !== undefined && {
          isReferencedByCount: raw['is-referenced-by-count'],
        }),
        ...(raw.score !== undefined && { score: raw.score }),
        ...(raw.abstract !== undefined && {
          abstract: normalizeMarkupText(raw.abstract),
        }),
      };
    });

    const returned = works.length;
    /** Whether this page came back through the cursor, on the normalized value the request carried. */
    const isCursorPage = cursor !== undefined;
    /**
     * Crossref keeps returning a `next-cursor` past the end of a list, so a caller chaining
     * it walks in a circle forever. The token cannot be the guard either: the same value
     * comes back on every page of a walk, item-bearing and empty alike, so it never signals
     * progress. `totalResults` cannot serve either — it describes the query and stays at its
     * full value on an exhausted page. That leaves this page's item count, the one quantity
     * that says the walk is over. Withholding here keeps "no continuation field means the
     * list is exhausted" true on every cursor surface this server exposes.
     */
    const nextCursor = returned > 0 ? result.nextCursor : undefined;

    ctx.enrich({ totalResults: result.totalResults, returned });
    /**
     * Every empty page says why. `returned === 0` is what makes a page empty; `totalResults`
     * only separates the causes, and keying the notice on it alone left the two commonest
     * empty pages — a walk past the end of a list, an offset past the end of one — carrying
     * no explanation on either result surface. This tool's whole payload is `works`, so an
     * unannotated empty page renders as nothing at all for a client reading content[], where
     * the journal and funder works lists at least still render their own record.
     */
    if (returned === 0) {
      if (result.totalResults === 0) {
        ctx.enrich.notice(
          'No results matched the query. Try broadening the search terms or removing filters.',
        );
      } else if (isCursorPage) {
        ctx.enrich.notice(
          `This cursor walk is complete — all ${result.totalResults} matching records have been returned. nextCursor is withheld on this page; stop chaining it.`,
        );
      } else {
        ctx.enrich.notice(
          `Offset ${input.offset ?? 0} is past the end of this result list — ${result.totalResults} records matched. Request an offset below ${result.totalResults}.`,
        );
      }
    }

    return {
      works,
      ...(nextCursor && { nextCursor }),
    };
  },

  format: (result) => {
    const lines: string[] = [];
    if (result.nextCursor) lines.push(`**Next cursor:** \`${result.nextCursor}\``);
    if (lines.length > 0) lines.push('');

    for (const w of result.works) {
      lines.push(`### ${w.title ?? w.doi}`);
      lines.push(`**DOI:** ${w.doi}${w.type ? ` | **Type:** ${w.type}` : ''}`);
      if (w.published?.year) lines.push(`**Published:** ${formatDateParts(w.published)}`);
      if (w.containerTitle) lines.push(`**Journal:** ${w.containerTitle}`);
      if (w.publisher) lines.push(`**Publisher:** ${w.publisher}`);
      if (w.authors?.length) {
        const authorStr = w.authors
          .map((a) => [a.given, a.family, a.name].filter(Boolean).join(' '))
          .filter(Boolean)
          .join(', ');
        lines.push(`**Authors:** ${authorStr}`);
      }
      if (w.isReferencedByCount !== undefined) lines.push(`**Cited by:** ${w.isReferencedByCount}`);
      if (w.score !== undefined) lines.push(`**Score:** ${w.score}`);
      if (w.abstract) lines.push(`**Abstract:** ${w.abstract}`);
      lines.push('');
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
