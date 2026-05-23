/**
 * @fileoverview crossref_search_works — searches the Crossref works index by free text and/or filters.
 * Large result sets spill to a DataCanvas table when CANVAS_PROVIDER_TYPE=duckdb.
 * @module mcp-server/tools/definitions/search-works.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '@/services/canvas-accessor.js';
import {
  getCrossrefService,
  stripJats,
  type WorksSearchOptions,
} from '@/services/crossref/crossref-service.js';

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
    'Searches the Crossref works index (~155M records) by free text and/or structured filters. Filter keys use Crossref hyphen-separated syntax: from-pub-date, until-pub-date, type (e.g. journal-article), funder (funder DOI), issn, member (publisher member ID), has-abstract, has-references, has-full-text, directory (DOAJ for open-access content). Sort options: relevance, score, is-referenced-by-count, published, deposited, indexed. Offset-based paging is capped at ~10K results; use cursor="*" to start cursor-based deep paging, then pass the nextCursor value from each response to continue. Cursor and offset cannot be combined. When CANVAS_PROVIDER_TYPE=duckdb is set, large result sets spill to a DataCanvas table for SQL querying.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  input: z.object({
    query: z
      .string()
      .optional()
      .describe(
        'Free-text search query, e.g. "CRISPR gene editing" or "climate change adaptation"',
      ),
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
        'Fields to return (reduces payload). Useful set: DOI, title, author, published, type, is-referenced-by-count, abstract, container-title, publisher, score.',
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
        'Cursor token for deep paging. Pass "*" to start cursor-based paging (required past ~10K results), then pass the nextCursor value from each response. Cannot be combined with offset.',
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
    canvas_id: z
      .string()
      .optional()
      .describe(
        'Optional 10-char DataCanvas ID from a prior call. Omit on first call to start a fresh canvas. Only relevant when CANVAS_PROVIDER_TYPE=duckdb is set.',
      ),
  }),

  output: z.object({
    totalResults: z.number().describe('Total matching records in Crossref'),
    returned: z.number().describe('Number of records returned in this response'),
    nextCursor: z
      .string()
      .optional()
      .describe('Cursor token to pass in the next call for cursor-based paging'),
    works: z.array(WorkSummarySchema).describe('Matching works'),
    canvas: z
      .object({
        canvasId: z.string().describe('DataCanvas ID for SQL querying over the full result set'),
        tableName: z.string().describe('Canvas table name'),
        rowCount: z.number().describe('Total rows registered on the canvas'),
        isNew: z.boolean().describe('True if a new canvas was created'),
        expiresAt: z.string().describe('Canvas expiry timestamp (ISO 8601)'),
      })
      .optional()
      .describe(
        'DataCanvas reference when the result set was large enough to spill. Query with a separate canvas query tool.',
      ),
  }),

  errors: [
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
    // Validate: cursor and offset cannot coexist
    if (input.cursor !== undefined && input.offset !== undefined) {
      throw ctx.fail('cursor_offset_conflict', 'Provide cursor or offset, not both.', {
        ...ctx.recoveryFor('cursor_offset_conflict'),
      });
    }

    // Validate: offset cap
    const rows = input.rows;
    if (
      input.offset !== undefined &&
      input.cursor === undefined &&
      input.offset + rows > OFFSET_CAP
    ) {
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
      cursor: input.cursor,
      offset: input.offset,
    });

    const svc = getCrossrefService();
    const searchOpts: WorksSearchOptions = {
      rows,
      ...(input.query !== undefined && { query: input.query }),
      ...(input.filter !== undefined && { filter: input.filter }),
      ...(input.fields !== undefined && { fields: input.fields }),
      ...(input.offset !== undefined && { offset: input.offset }),
      ...(input.cursor !== undefined && { cursor: input.cursor }),
      ...(input.sort !== undefined && { sort: input.sort }),
      ...(input.order !== undefined && { order: input.order }),
    };
    const result = await svc.searchWorks(searchOpts, ctx);

    const works = result.items.map((raw) => {
      const parts =
        raw.published?.['date-parts']?.[0] ??
        raw['published-print']?.['date-parts']?.[0] ??
        raw['published-online']?.['date-parts']?.[0];
      return {
        doi: raw.DOI,
        ...(raw.title?.[0] !== undefined && { title: raw.title[0] }),
        ...(raw.type != null && { type: raw.type }),
        ...(raw.author && {
          authors: raw.author.slice(0, 10).map((a) => ({
            ...(a.given && { given: a.given }),
            ...(a.family && { family: a.family }),
            ...(a.name && { name: a.name }),
          })),
        }),
        ...(parts?.length && {
          published: {
            ...(parts[0] !== undefined && { year: parts[0] }),
            ...(parts[1] !== undefined && { month: parts[1] }),
            ...(parts[2] !== undefined && { day: parts[2] }),
          },
        }),
        ...(raw['container-title']?.[0] !== undefined && {
          containerTitle: raw['container-title'][0],
        }),
        ...(raw.publisher !== undefined && { publisher: raw.publisher }),
        ...(raw['is-referenced-by-count'] !== undefined && {
          isReferencedByCount: raw['is-referenced-by-count'],
        }),
        ...(raw.score !== undefined && { score: raw.score }),
        ...(raw.abstract !== undefined && { abstract: stripJats(raw.abstract) }),
      };
    });

    // DataCanvas spillover when canvas is enabled and results are substantial
    const canvas = getCanvas();
    let canvasInfo:
      | {
          canvasId: string;
          tableName: string;
          rowCount: number;
          isNew: boolean;
          expiresAt: string;
        }
      | undefined;

    if (canvas && works.length >= 20) {
      try {
        const { spillover } = await import('@cyanheads/mcp-ts-core/canvas');
        const instance = await canvas.acquire(input.canvas_id, ctx);

        const spill = await spillover({
          canvas: instance,
          source: works,
          previewChars: 40_000,
          caps: { maxRows: 10_000 },
          signal: ctx.signal,
        });

        if (spill.spilled && spill.handle) {
          canvasInfo = {
            canvasId: instance.canvasId,
            tableName: spill.handle.tableName,
            rowCount: spill.handle.rowCount,
            isNew: instance.isNew,
            expiresAt: instance.expiresAt,
          };
        }
      } catch {
        // Canvas unavailable or failed — continue without spillover
        ctx.log.info('Canvas spillover skipped');
      }
    }

    return {
      totalResults: result.totalResults,
      returned: works.length,
      ...(result.nextCursor && { nextCursor: result.nextCursor }),
      works,
      ...(canvasInfo && { canvas: canvasInfo }),
    };
  },

  format: (result) => {
    const lines: string[] = [
      `**Total results:** ${result.totalResults} | **Returned:** ${result.returned}`,
    ];
    if (result.nextCursor) lines.push(`**Next cursor:** \`${result.nextCursor}\``);
    if (result.canvas) {
      const newMark = result.canvas.isNew ? ' (new)' : '';
      lines.push(
        `**Canvas:** \`${result.canvas.canvasId}\`${newMark} — table \`${result.canvas.tableName}\` (${result.canvas.rowCount} rows, expires ${result.canvas.expiresAt})`,
      );
    }
    lines.push('');

    for (const w of result.works) {
      lines.push(`### ${w.title ?? w.doi}`);
      lines.push(`**DOI:** ${w.doi}${w.type ? ` | **Type:** ${w.type}` : ''}`);
      if (w.published?.year) {
        const parts = [w.published.year, w.published.month, w.published.day].filter(
          (x) => x !== undefined,
        );
        lines.push(`**Published:** ${parts.join('-')}`);
      }
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
      if (w.abstract) lines.push(`**Abstract:** ${w.abstract.slice(0, 300)}…`);
      lines.push('');
    }

    if (result.works.length === 0) {
      lines.push(
        'No results matched the query. Try broadening the search terms or removing filters.',
      );
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
