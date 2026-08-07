/**
 * @fileoverview crossref_search_journals — finds Crossref journal records by ISSN or title query,
 * optionally returning a page of the matched journal's most recent works. The journal list and the
 * works list page independently, and their upstream offset ceilings differ by an order of magnitude.
 * @module mcp-server/tools/definitions/search-journals.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  decodeHtmlEntities,
  formatDateParts,
  getCrossrefService,
  type JournalsSearchOptions,
  type ListSearchResult,
  NAME_SEARCH_OFFSET_CAP,
  nextPageOffset,
  parseDateParts,
  WORKS_OFFSET_CAP,
} from '@/services/crossref/crossref-service.js';
import type { RawCrossrefJournal } from '@/services/crossref/types.js';
import { UPSTREAM_ERROR_CONTRACT } from '@/services/crossref/upstream-errors.js';

const JournalSchema = z
  .object({
    title: z.string().optional().describe('Journal title'),
    issnL: z.string().optional().describe('Linking ISSN (ISSN-L)'),
    issn: z.array(z.string()).optional().describe('All ISSN variants for this journal'),
    publisher: z.string().optional().describe('Publisher name'),
    subjects: z
      .array(z.object({ name: z.string().describe('Subject area name') }).describe('Subject'))
      .optional()
      .describe('Subject classifications'),
    totalDois: z.number().optional().describe('Total registered DOIs in this journal'),
  })
  .describe('Journal record');

/**
 * The ISSN this server addresses a journal by. Shared between the works lookup and the ambiguity
 * candidate list so the two never disagree — a candidate reported as having no ISSN while the
 * works call would have resolved it sends the caller down a dead end.
 */
function journalIssn(j: RawCrossrefJournal | undefined): string | undefined {
  return j?.['ISSN-L'] ?? j?.ISSN?.[0];
}

const WorkSummarySchema = z
  .object({
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
  })
  .describe('Work summary');

export const searchJournalsTool = tool('crossref_search_journals', {
  title: 'Search Journals',
  description:
    'Finds Crossref journal records by ISSN or title query. Provide issn for an exact single-journal lookup, or query for title-based search returning up to rows results. Title-query results page with offset — the nextOffset enrichment carries the value for the following page, up to offset + rows = 100000. Set include_works to true to also return a page of the matched journal\'s most recent works by publication date; that list pages separately with works_offset, capped ten times lower at works_offset + rows = 10000. Read a journal\'s works past that ceiling with crossref_search_works using filter {"issn": "<issn>"} and cursor="*". Returns journal metadata: title, publisher, ISSN-L, subject areas, and total DOI count.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  errors: [
    ...UPSTREAM_ERROR_CONTRACT,
    {
      reason: 'issn_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'ISSN lookup returned 404 — ISSN is not registered in Crossref.',
      recovery:
        'Verify the ISSN format (xxxx-xxxx) and check that the journal is registered in Crossref, or use a title query instead.',
    },
    {
      reason: 'ambiguous_journal',
      code: JsonRpcErrorCode.ValidationError,
      when: 'include_works is true but the title query matched more than one journal, making the target ambiguous.',
      recovery:
        'Re-run with issn set to one of the ISSNs listed in the error message and in the candidates field of the error data, or narrow the query when the journal you want is not among them.',
    },
    {
      reason: 'offset_too_large',
      code: JsonRpcErrorCode.ValidationError,
      when: 'offset + rows exceeds the 100000-record ceiling Crossref allows on journal title search.',
      recovery:
        'Narrow the title query so the journals you want fall within the first 100000 matches.',
    },
    {
      reason: 'works_offset_too_large',
      code: JsonRpcErrorCode.ValidationError,
      when: 'works_offset + rows exceeds the 10000-record ceiling Crossref allows on a journal works list.',
      recovery:
        'Page deeper with crossref_search_works using filter {"issn": "<issn>"} and cursor="*", chaining the nextCursor token from each response.',
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
      .regex(/^\d{4}-?\d{3}[\dX]$/i, {
        message: 'ISSN must be 8 digits in the format xxxx-xxxx or xxxxxxxx, e.g. "1234-5678".',
      })
      .optional()
      .describe(
        'ISSN for exact single-journal lookup (print or electronic, with or without hyphen). Example: "1234-5678".',
      ),
    include_works: z
      .boolean()
      .default(false)
      .describe(
        "When true, also return a page of the journal's most recent works by publication date. Requires an unambiguous journal — pass issn when a title query matches more than one.",
      ),
    rows: z
      .number()
      .min(1)
      .max(100)
      .default(10)
      .describe(
        'Maximum number of journals to return for title queries, or works when include_works is true (1–100, default 10)',
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Zero-based offset into the title-query journal list. Pass the nextOffset value from the previous response to continue. Ignored when issn is set, which resolves exactly one record.',
      ),
    works_offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Zero-based offset into the journal works list when include_works is true. Pass the nextWorksOffset value from the previous response to continue.',
      ),
  }),

  output: z.object({
    journals: z.array(JournalSchema).describe('Matching journal records'),
    recentWorks: z
      .array(WorkSummarySchema)
      .optional()
      .describe(
        'Page of works from the matched journal, ordered by publication date (newest first). Only present when include_works is true.',
      ),
  }),

  enrichment: {
    journalCount: z.number().describe('Number of journal records returned in this page'),
    journalsTotal: z.number().describe('Total journal records matching the query in Crossref'),
    nextOffset: z
      .number()
      .optional()
      .describe(
        'Value to pass as offset on the next call for the following page of journals. Absent when this page ends the matches or the next page would breach the 100000-record offset ceiling.',
      ),
    worksTotal: z
      .number()
      .optional()
      .describe('Total works count for the journal, when include_works is true'),
    nextWorksOffset: z
      .number()
      .optional()
      .describe(
        'Value to pass as works_offset on the next call for the following page of works. Absent when this page ends the works list or the next page would breach the 10000-record offset ceiling.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance on a page that needs a caveat: a query nothing matched, an offset past the end of a list that did match, or a page that stops at one of the route offset ceilings with records still unretrieved. Absent otherwise.',
      ),
  },

  async handler(input, ctx) {
    if (!input.issn && input.offset + input.rows > NAME_SEARCH_OFFSET_CAP) {
      throw ctx.fail(
        'offset_too_large',
        `offset ${input.offset} + rows ${input.rows} = ${input.offset + input.rows} exceeds the ${NAME_SEARCH_OFFSET_CAP}-record ceiling Crossref allows on journal title search.`,
        {
          offset: input.offset,
          rows: input.rows,
          cap: NAME_SEARCH_OFFSET_CAP,
          ...ctx.recoveryFor('offset_too_large'),
        },
      );
    }
    if (input.include_works && input.works_offset + input.rows > WORKS_OFFSET_CAP) {
      throw ctx.fail(
        'works_offset_too_large',
        `works_offset ${input.works_offset} + rows ${input.rows} = ${input.works_offset + input.rows} exceeds the ${WORKS_OFFSET_CAP}-record ceiling Crossref allows on a journal works list.`,
        {
          worksOffset: input.works_offset,
          rows: input.rows,
          cap: WORKS_OFFSET_CAP,
          ...ctx.recoveryFor('works_offset_too_large'),
        },
      );
    }

    ctx.log.info('Searching journals', {
      query: input.query,
      issn: input.issn,
      offset: input.offset,
    });
    const svc = getCrossrefService();

    const journalOpts: JournalsSearchOptions = {
      rows: input.rows,
      offset: input.offset,
      ...(input.query !== undefined && { query: input.query }),
      ...(input.issn !== undefined && { issn: input.issn }),
    };

    let journalsResult: ListSearchResult<RawCrossrefJournal>;
    try {
      journalsResult = await svc.searchJournals(journalOpts, ctx);
    } catch (err) {
      if (input.issn && err instanceof McpError && err.code === -32001) {
        throw ctx.fail('issn_not_found', `No journal found for ISSN: ${input.issn}`, {
          issn: input.issn,
          ...ctx.recoveryFor('issn_not_found'),
        });
      }
      throw err;
    }

    const rawJournals = journalsResult.items;
    const journalsTotal = journalsResult.totalResults;
    const listContinuation = nextPageOffset({
      offset: input.offset,
      returned: rawJournals.length,
      total: journalsTotal,
      rows: input.rows,
      cap: NAME_SEARCH_OFFSET_CAP,
    });

    const journals = rawJournals.map((j) => ({
      ...(j.title !== undefined && { title: decodeHtmlEntities(j.title) }),
      ...(j['ISSN-L'] !== undefined && { issnL: j['ISSN-L'] }),
      ...(j.ISSN?.length && { issn: j.ISSN }),
      ...(j.publisher !== undefined && { publisher: j.publisher }),
      ...(j.subjects?.length && {
        subjects: j.subjects.map((s) => ({ name: s.name })),
      }),
      ...(j.counts?.['total-dois'] !== undefined && { totalDois: j.counts['total-dois'] }),
    }));

    const listEnrichment = {
      journalCount: journals.length,
      journalsTotal,
      ...(listContinuation.kind === 'next' && { nextOffset: listContinuation.offset }),
    };

    if (!input.include_works || journals.length === 0) {
      ctx.enrich(listEnrichment);
      // An empty page has two causes a caller reading only content[] cannot otherwise tell
      // apart: nothing matched, or the offset ran off the end of a list that did match.
      if (journals.length === 0) {
        ctx.enrich.notice(
          journalsTotal > 0
            ? `Offset ${input.offset} is past the end of this result list — ${journalsTotal} journals matched. Request an offset below ${journalsTotal}.`
            : 'No journals matched the query. Try a shorter title or check the ISSN format (xxxx-xxxx).',
        );
      } else if (listContinuation.kind === 'ceiling') {
        // A missing nextOffset here would be indistinguishable from the end of the list, and
        // withholding the offset also means the caller never trips offset_too_large and never
        // reads its recovery. Say it on the page instead.
        ctx.enrich.notice(
          `This is the last journal page reachable by offset — Crossref caps offset + rows at ${NAME_SEARCH_OFFSET_CAP} on journal search and ${journalsTotal} journals matched. Narrow the query to bring the rest into reach.`,
        );
      }
      return { journals };
    }

    // When include_works is requested without an ISSN, multiple journals may match.
    // Require an unambiguous ISSN to avoid silently fetching works from the wrong journal.
    // The test is the upstream match count, not this page's length: a page holding one of many
    // matches (rows=1, or the tail of a list) identifies no journal the caller chose.
    // Each candidate's ISSN is named in both the message and the error data, so a client
    // reading only content[] has the identifier it needs to re-run without a probe call.
    if (!input.issn && journalsTotal > 1) {
      const candidates = rawJournals.map((j, i) => {
        const issn = journalIssn(j);
        return {
          title: journals[i]?.title ?? '(untitled)',
          ...(issn !== undefined && { issn }),
        };
      });
      const listed = candidates
        .map((c) => `"${c.title}" (${c.issn ?? 'no ISSN registered'})`)
        .join(', ');
      // The candidate list is one page of the matches; saying "matched N" with N as the page
      // length would understate the choice and hide that the wanted journal may not be listed.
      const partial = candidates.length < journalsTotal;
      throw ctx.fail(
        'ambiguous_journal',
        `include_works requires an unambiguous journal. The query matched ${journalsTotal} journals` +
          `${partial ? `; this page lists ${candidates.length}` : ''}: ${listed}. ` +
          `Re-run with issn set to one of those ISSNs` +
          `${partial ? ', or narrow the query if the journal you want is not among them,' : ''} to fetch its works.`,
        { candidates, matchedTotal: journalsTotal, ...ctx.recoveryFor('ambiguous_journal') },
      );
    }

    // Use the matched journal's ISSN for the works call
    const issnForWorks = journalIssn(rawJournals[0]);
    if (!issnForWorks) {
      ctx.enrich(listEnrichment);
      return { journals };
    }

    const worksResult = await svc.getJournalWorks(
      issnForWorks,
      { rows: input.rows, offset: input.works_offset },
      ctx,
    );
    const recentWorks = worksResult.items.map((raw) => {
      const published =
        parseDateParts(raw.published) ??
        parseDateParts(raw['published-print']) ??
        parseDateParts(raw['published-online']);
      return {
        doi: raw.DOI,
        ...(raw.title?.[0] !== undefined && { title: decodeHtmlEntities(raw.title[0]) }),
        ...(raw.type != null && { type: raw.type }),
        ...(published !== undefined && {
          published: { year: published.year, month: published.month },
        }),
        ...(raw['is-referenced-by-count'] !== undefined && {
          isReferencedByCount: raw['is-referenced-by-count'],
        }),
      };
    });

    const worksContinuation = nextPageOffset({
      offset: input.works_offset,
      returned: recentWorks.length,
      total: worksResult.totalResults,
      rows: input.rows,
      cap: WORKS_OFFSET_CAP,
    });

    ctx.enrich({
      ...listEnrichment,
      worksTotal: worksResult.totalResults,
      ...(worksContinuation.kind === 'next' && { nextWorksOffset: worksContinuation.offset }),
    });
    if (worksContinuation.kind === 'ceiling') {
      ctx.enrich.notice(
        `This is the last works page reachable by works_offset — Crossref caps works_offset + rows at ${WORKS_OFFSET_CAP} on a journal works list and ${worksResult.totalResults} works exist. Read further with crossref_search_works using filter {"issn": "${issnForWorks}"} and cursor="*".`,
      );
    }

    return {
      journals,
      recentWorks,
    };
  },

  format: (result) => {
    const lines: string[] = [];

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
      lines.push(`### Recent works`);
      for (const w of result.recentWorks) {
        const date = w.published?.year !== undefined ? ` (${formatDateParts(w.published)})` : '';
        const cited =
          w.isReferencedByCount !== undefined ? ` | Cited: ${w.isReferencedByCount}` : '';
        lines.push(`- **${w.title ?? w.doi}**${date}${cited}`);
        lines.push(`  DOI: ${w.doi}${w.type ? ` | Type: ${w.type}` : ''}`);
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
