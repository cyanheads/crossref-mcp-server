/**
 * @fileoverview crossref_search_journals — finds Crossref journal records by ISSN or title query.
 * Optionally fetches the journal's most recent works in a second sequential call.
 * @module mcp-server/tools/definitions/search-journals.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  getCrossrefService,
  type JournalsSearchOptions,
} from '@/services/crossref/crossref-service.js';
import type { RawCrossrefJournal } from '@/services/crossref/types.js';

const JournalSchema = z.object({
  title: z.string().optional().describe('Journal title'),
  issnL: z.string().optional().describe('Linking ISSN (ISSN-L)'),
  issn: z.array(z.string()).optional().describe('All ISSN variants for this journal'),
  publisher: z.string().optional().describe('Publisher name'),
  subjects: z
    .array(z.object({ name: z.string().describe('Subject area name') }))
    .optional()
    .describe('Subject classifications'),
  totalDois: z.number().optional().describe('Total registered DOIs in this journal'),
});

const WorkSummarySchema = z.object({
  doi: z.string().describe('Work DOI'),
  title: z.string().optional().describe('Work title'),
  type: z.string().optional().describe('Work type'),
  published: z
    .object({
      year: z.number().optional().describe('Year'),
      month: z.number().optional().describe('Month'),
    })
    .optional()
    .describe('Publication date'),
  isReferencedByCount: z.number().optional().describe('Incoming citation count'),
});

export const searchJournalsTool = tool('crossref_search_journals', {
  title: 'Search Journals',
  description:
    "Finds Crossref journal records by ISSN or title query. Provide issn for an exact single-journal lookup, or query for title-based search returning up to rows results. Set include_works to true to fetch the journal's most recent registered works in a second call (sequential — requires a resolved ISSN from step 1). Returns journal metadata: title, publisher, ISSN-L, subject areas, and total DOI count.",
  annotations: { readOnlyHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'issn_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'ISSN lookup returned 404 — ISSN is not registered in Crossref.',
      recovery:
        'Verify the ISSN format (xxxx-xxxx) and check that the journal is registered in Crossref, or use a title query instead.',
    },
  ],

  input: z.object({
    query: z
      .string()
      .optional()
      .describe(
        'Journal title search query, e.g. "Nature" or "Journal of Machine Learning Research"',
      ),
    issn: z
      .string()
      .optional()
      .describe(
        'ISSN for exact single-journal lookup (print or electronic, with or without hyphen). Supersedes query when provided.',
      ),
    include_works: z
      .boolean()
      .default(false)
      .describe(
        "When true, fetch the journal's most recent registered works (adds a second upstream call)",
      ),
    rows: z
      .number()
      .min(1)
      .max(100)
      .default(10)
      .describe(
        'Maximum number of journals to return for title queries, or works when include_works is true (1–100, default 10)',
      ),
  }),

  output: z.object({
    journals: z.array(JournalSchema).describe('Matching journal records'),
    recentWorks: z
      .array(WorkSummarySchema)
      .optional()
      .describe(
        'Most recent works from the first matched journal. Only present when include_works is true.',
      ),
    worksTotal: z
      .number()
      .optional()
      .describe('Total works count for the journal, when include_works is true'),
  }),

  async handler(input, ctx) {
    ctx.log.info('Searching journals', { query: input.query, issn: input.issn });
    const svc = getCrossrefService();

    const journalOpts: JournalsSearchOptions = {
      rows: input.rows,
    };
    if (input.query !== undefined) journalOpts.query = input.query;
    if (input.issn !== undefined) journalOpts.issn = input.issn;

    let rawJournals: RawCrossrefJournal[];
    try {
      rawJournals = await svc.searchJournals(journalOpts, ctx);
    } catch (err) {
      if (
        input.issn &&
        err instanceof Error &&
        'code' in err &&
        (err as { code?: number }).code === -32001
      ) {
        throw ctx.fail('issn_not_found', `No journal found for ISSN: ${input.issn}`, {
          issn: input.issn,
          ...ctx.recoveryFor('issn_not_found'),
        });
      }
      throw err;
    }

    const journals = rawJournals.map((j) => ({
      ...(j.title !== undefined && { title: j.title }),
      ...(j['ISSN-L'] !== undefined && { issnL: j['ISSN-L'] }),
      ...(j.ISSN?.length && { issn: j.ISSN }),
      ...(j.publisher !== undefined && { publisher: j.publisher }),
      ...(j.subjects?.length && {
        subjects: j.subjects.map((s) => ({ name: s.name })),
      }),
      ...(j.counts?.['total-dois'] !== undefined && { totalDois: j.counts['total-dois'] }),
    }));

    if (!input.include_works || journals.length === 0) {
      return { journals };
    }

    // Use the first matched journal's ISSN for the works call
    const firstJournal = rawJournals[0] as (typeof rawJournals)[number] | undefined;
    const issnForWorks = firstJournal?.['ISSN-L'] ?? firstJournal?.ISSN?.[0];
    if (!issnForWorks) {
      return { journals };
    }

    const worksResult = await svc.getJournalWorks(issnForWorks, input.rows, ctx);
    const recentWorks = worksResult.items.map((raw) => {
      const parts =
        raw.published?.['date-parts']?.[0] ??
        raw['published-print']?.['date-parts']?.[0] ??
        raw['published-online']?.['date-parts']?.[0];
      return {
        doi: raw.DOI,
        ...(raw.title?.[0] !== undefined && { title: raw.title[0] }),
        ...(raw.type != null && { type: raw.type }),
        ...(parts?.length && {
          published: {
            ...(parts[0] !== undefined && { year: parts[0] }),
            ...(parts[1] !== undefined && { month: parts[1] }),
          },
        }),
        ...(raw['is-referenced-by-count'] !== undefined && {
          isReferencedByCount: raw['is-referenced-by-count'],
        }),
      };
    });

    return {
      journals,
      recentWorks,
      worksTotal: worksResult.totalResults,
    };
  },

  format: (result) => {
    const lines: string[] = [];

    if (result.journals.length === 0) {
      lines.push('No journals matched the query.');
      return [{ type: 'text', text: lines.join('\n') }];
    }

    for (const j of result.journals) {
      lines.push(`## ${j.title ?? '(untitled)'}`);
      if (j.publisher) lines.push(`**Publisher:** ${j.publisher}`);
      if (j.issnL) lines.push(`**ISSN-L:** ${j.issnL}`);
      if (j.issn?.length) lines.push(`**ISSN:** ${j.issn.join(', ')}`);
      if (j.subjects?.length)
        lines.push(`**Subjects:** ${j.subjects.map((s) => s.name).join(', ')}`);
      if (j.totalDois !== undefined) lines.push(`**Total DOIs:** ${j.totalDois}`);
      lines.push('');
    }

    if (result.recentWorks?.length) {
      lines.push(`### Recent works (${result.worksTotal ?? result.recentWorks.length} total)`);
      for (const w of result.recentWorks) {
        const dateParts = [w.published?.year, w.published?.month].filter((x) => x !== undefined);
        const date = dateParts.length ? ` (${dateParts.join('-')})` : '';
        const cited =
          w.isReferencedByCount !== undefined ? ` | Cited: ${w.isReferencedByCount}` : '';
        lines.push(`- **${w.title ?? w.doi}**${date}${cited}`);
        lines.push(`  DOI: ${w.doi}${w.type ? ` | Type: ${w.type}` : ''}`);
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
