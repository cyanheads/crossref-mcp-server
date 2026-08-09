/**
 * @fileoverview crossref_search_funders — finds funders in the Crossref Funder Registry by name or
 * DOI, optionally returning a page of works funded by the matched funder. The funder list and the
 * funded-works list page independently, and their upstream offset ceilings differ by an order of
 * magnitude; the funded-works list also pages by cursor, which has no ceiling. A name query
 * matching more than one funder is rejected rather than silently resolved, and a funder the
 * registry has deprecated is reported with its successor's ID rather than redirected to it.
 * @module mcp-server/tools/definitions/search-funders.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  type FundersSearchOptions,
  formatDateParts,
  getCrossrefService,
  type ListSearchResult,
  NAME_SEARCH_OFFSET_CAP,
  nextPageOffset,
  normalizeMarkupText,
  normalizeText,
  parseDateParts,
  WORKS_OFFSET_CAP,
} from '@/services/crossref/crossref-service.js';
import type { RawCrossrefFunder } from '@/services/crossref/types.js';
import { UPSTREAM_ERROR_CONTRACT } from '@/services/crossref/upstream-errors.js';

const FunderSchema = z
  .object({
    id: z.string().optional().describe('Funder registry ID'),
    name: z.string().optional().describe('Funder canonical name'),
    altNames: z.array(z.string()).optional().describe('Alternate names for this funder'),
    country: z
      .string()
      .optional()
      .describe(
        'Free-text place the registry records for this funder. Usually a country name, but supranational entries carry values like "European Union" — there is no machine-readable country code on the record.',
      ),
    uri: z.string().optional().describe('Funder registry URI'),
    worksCount: z
      .number()
      .optional()
      .describe('Number of works associated with this funder in Crossref'),
    replacedBy: z
      .array(z.string())
      .optional()
      .describe(
        'Registry IDs that supersede this funder. Present only on a deprecated entry — a deprecated funder carries a fraction of its successor\'s works, so re-run with funder_doi set to one of these IDs to reach the current entry. Pass a bare ID ("501100004543") or the full DOI.',
      ),
    replaces: z
      .array(z.string())
      .optional()
      .describe(
        'Registry IDs this funder supersedes. Present only when the funder has absorbed a deprecated entry; works registered against those IDs are not counted here.',
      ),
  })
  .describe('Funder record');

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

export const searchFundersTool = tool('crossref_search_funders', {
  title: 'Search Funders',
  description:
    'Finds funders registered in the Crossref Funder Registry by name or funder DOI. Provide funder_doi for an exact single-funder lookup — the full DOI ("10.13039/100000001"), the bare registry ID ("100000001"), or either behind a doi: or https://doi.org/ prefix — or query for name-based search. Name-query results page with offset — the nextOffset enrichment carries the value for the following page, up to offset + rows = 100000. Set include_works to true to also return a page of works funded by the matched funder; that list pages two ways. works_offset is the simple one and is capped ten times lower at works_offset + rows = 10000. works_cursor has no ceiling and reaches the whole funded-works list: pass works_cursor="*" on the first call, then chain the nextWorksCursor token from each response. The two cannot be combined, and a cursor walk always starts at the newest work — it cannot resume from an offset. This list also counts works funded by the funder\'s registry descendants, which a crossref_search_works filter on {"funder": "10.13039/<id>"} does not. Returns funder name, registry ID, country, and alternate names. The Funder Registry supersedes entries, and a deprecated one answers to the same names as its successor while carrying only a fraction of its works: such a record carries replacedBy with the superseding registry ID and the response carries a notice naming it. The replacement is never followed automatically — re-run with funder_doi set to that ID to get the current entry.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  errors: [
    ...UPSTREAM_ERROR_CONTRACT,
    {
      reason: 'funder_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Funder DOI lookup returned 404 — funder is not in the Crossref Funder Registry.',
      recovery:
        'Verify the registry ID (100000001) or full funder DOI (10.13039/100000001) is correct, or use a name query instead.',
    },
    {
      reason: 'ambiguous_funder',
      code: JsonRpcErrorCode.ValidationError,
      when: 'include_works is true but the name query matched more than one funder, making the target ambiguous.',
      recovery:
        'Re-run with funder_doi set to one of the registry IDs listed in the error message and in the candidates field of the error data, or narrow the query when the funder you want is not among them.',
    },
    {
      reason: 'offset_too_large',
      code: JsonRpcErrorCode.ValidationError,
      when: 'offset + rows exceeds the 100000-record ceiling Crossref allows on funder name search.',
      recovery:
        'Narrow the name query so the funders you want fall within the first 100000 matches.',
    },
    {
      reason: 'works_offset_too_large',
      code: JsonRpcErrorCode.ValidationError,
      when: 'works_offset + rows exceeds the 10000-record ceiling Crossref allows on a funded-works list.',
      recovery:
        'Restart the funded-works list with works_cursor="*" and chain the nextWorksCursor token from each response — cursor paging has no offset ceiling and reaches the whole list.',
    },
    {
      reason: 'works_cursor_offset_conflict',
      code: JsonRpcErrorCode.ValidationError,
      when: 'include_works is true and works_cursor was supplied alongside a works_offset above zero.',
      recovery:
        'Page the funded-works list one way or the other. Keep works_cursor and drop works_offset to walk the whole list, or drop works_cursor to stay on offset paging.',
    },
  ],

  input: z.object({
    query: z
      .string()
      .optional()
      .describe('Funder name search query, e.g. "National Science Foundation" or "Wellcome Trust"'),
    funder_doi: z
      .string()
      .regex(/^(?:(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:)?10\.13039\/)?\d+$/i, {
        message:
          'Funder DOI must be the bare registry ID ("100000001") or the full DOI "10.13039/" followed by digits ("10.13039/100000001"), optionally behind a doi: or https://doi.org/ prefix.',
      })
      .optional()
      .describe(
        'Funder DOI for exact lookup — the full DOI "10.13039/100000001" (NSF) or the bare registry ID "100000001". Supersedes query when provided.',
      ),
    include_works: z
      .boolean()
      .default(false)
      .describe(
        'When true, also return a page of works funded by the matched funder. Requires an unambiguous funder — pass funder_doi when a name query matches more than one.',
      ),
    rows: z
      .number()
      .min(1)
      .max(100)
      .default(10)
      .describe(
        'Maximum funders to return for name queries, or works when include_works is true (1–100, default 10)',
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Zero-based offset into the name-query funder list. Pass the nextOffset value from the previous response to continue. Ignored when funder_doi is set, which resolves exactly one record.',
      ),
    works_offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Zero-based offset into the funded-works list when include_works is true. Pass the nextWorksOffset value from the previous response to continue. Capped at works_offset + rows = 10000; use works_cursor to read the whole list. Cannot be combined with works_cursor.',
      ),
    works_cursor: z
      .string()
      .optional()
      .describe(
        'Cursor token for deep paging of the funded-works list when include_works is true. Pass "*" to start the walk at the newest work, then pass the nextWorksCursor value from each response. Has no offset ceiling and cannot be combined with works_offset. Each token runs about 1500 characters and is returned on both result surfaces, a fixed cost per page — raise rows to spread it across more works on a long walk.',
      ),
  }),

  output: z.object({
    funders: z.array(FunderSchema).describe('Matching funder records'),
    fundedWorks: z
      .array(WorkSummarySchema)
      .optional()
      .describe(
        'Page of works funded by the matched funder, ordered by publication date (newest first). Only present when include_works is true.',
      ),
  }),

  enrichment: {
    funderCount: z.number().describe('Number of funder records returned in this page'),
    fundersTotal: z.number().describe('Total funder records matching the query in Crossref'),
    nextOffset: z
      .number()
      .optional()
      .describe(
        'Value to pass as offset on the next call for the following page of funders. Absent when this page ends the matches or the next page would breach the 100000-record offset ceiling.',
      ),
    fundedWorksTotal: z
      .number()
      .optional()
      .describe('Total count of funded works for the matched funder, when include_works is true'),
    nextWorksOffset: z
      .number()
      .optional()
      .describe(
        'Value to pass as works_offset on the next call for the following page of funded works. Absent when this page ends the works list, the next page would breach the 10000-record offset ceiling, or the page was requested with works_cursor.',
      ),
    nextWorksCursor: z
      .string()
      .optional()
      .describe(
        'Value to pass as works_cursor on the next call for the following page of funded works. Present only on a page requested with works_cursor, and absent once the walk reaches the end of the works list.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance on a page that needs a caveat: a query nothing matched, an offset past the end of a list that did match, a page that stops at one of the route offset ceilings with records still unretrieved, or a returned funder that the Funder Registry has deprecated in favor of another entry. Absent otherwise. A page needing more than one caveat carries them all in this one string.',
      ),
  },

  async handler(input, ctx) {
    if (!input.funder_doi && input.offset + input.rows > NAME_SEARCH_OFFSET_CAP) {
      throw ctx.fail(
        'offset_too_large',
        `offset ${input.offset} + rows ${input.rows} = ${input.offset + input.rows} exceeds the ${NAME_SEARCH_OFFSET_CAP}-record ceiling Crossref allows on funder name search.`,
        {
          offset: input.offset,
          rows: input.rows,
          cap: NAME_SEARCH_OFFSET_CAP,
          ...ctx.recoveryFor('offset_too_large'),
        },
      );
    }
    /**
     * A blank string is not a cursor. Form-based clients send `""` for an optional field the
     * user never filled in, and taking that as a cursor picks the cursor path with nothing to
     * send upstream: the request carries neither selector, Crossref answers page one with no
     * `next-cursor`, and the response then withholds every continuation field — which this
     * tool documents as meaning the list is exhausted. Normalized to absent so a blank falls
     * back to offset paging instead of truncating the list to its first page.
     */
    const worksCursor = input.works_cursor?.trim() || undefined;
    /**
     * The guard keys on whether an offset would actually be spent, not on whether the field
     * arrived: `works_offset` carries a schema default of 0, so an omitted field and an
     * explicit 0 are the same value here. Zero is the start of the list and is never sent
     * upstream, so pairing it with a cursor discards nothing — every combination that would
     * have silently dropped one of the two inputs has a nonzero offset and fails here.
     */
    if (input.include_works && worksCursor !== undefined && input.works_offset > 0) {
      throw ctx.fail(
        'works_cursor_offset_conflict',
        `works_cursor and works_offset ${input.works_offset} cannot be combined — Crossref rejects the pair, and the funded-works list pages one way or the other.`,
        {
          worksOffset: input.works_offset,
          ...ctx.recoveryFor('works_cursor_offset_conflict'),
        },
      );
    }
    // Unconditional: the guard above leaves works_offset at 0 whenever a cursor is present,
    // and 0 + rows is inside the cap for every rows the schema admits.
    if (input.include_works && input.works_offset + input.rows > WORKS_OFFSET_CAP) {
      throw ctx.fail(
        'works_offset_too_large',
        `works_offset ${input.works_offset} + rows ${input.rows} = ${input.works_offset + input.rows} exceeds the ${WORKS_OFFSET_CAP}-record ceiling Crossref allows on a funded-works list.`,
        {
          worksOffset: input.works_offset,
          rows: input.rows,
          cap: WORKS_OFFSET_CAP,
          ...ctx.recoveryFor('works_offset_too_large'),
        },
      );
    }

    ctx.log.info('Searching funders', {
      query: input.query,
      funderDoi: input.funder_doi,
      offset: input.offset,
    });
    const svc = getCrossrefService();

    const funderOpts: FundersSearchOptions = {
      rows: input.rows,
      offset: input.offset,
      ...(input.query !== undefined && { query: input.query }),
      ...(input.funder_doi !== undefined && { funderDoi: input.funder_doi }),
    };

    let fundersResult: ListSearchResult<RawCrossrefFunder>;
    try {
      fundersResult = await svc.searchFunders(funderOpts, ctx);
    } catch (err) {
      if (input.funder_doi && err instanceof McpError && err.code === -32001) {
        throw ctx.fail('funder_not_found', `No funder found for DOI: ${input.funder_doi}`, {
          funderDoi: input.funder_doi,
          ...ctx.recoveryFor('funder_not_found'),
        });
      }
      throw err;
    }

    const rawFunders = fundersResult.items;
    const fundersTotal = fundersResult.totalResults;
    const listContinuation = nextPageOffset({
      offset: input.offset,
      returned: rawFunders.length,
      total: fundersTotal,
      rows: input.rows,
      cap: NAME_SEARCH_OFFSET_CAP,
    });

    /**
     * `replaced-by` and `replaces` come back on every funder record, on both the single
     * lookup and the name search, as arrays that are empty when the relationship does not
     * apply. Projected only when non-empty so an ordinary funder does not carry a
     * meaningless `replacedBy: []`.
     */
    const funders = rawFunders.map((f) => ({
      ...(f.id !== undefined && { id: f.id }),
      ...(f.name !== undefined && { name: normalizeText(f.name) }),
      ...(f['alt-names']?.length && { altNames: f['alt-names'].map(normalizeText) }),
      ...(f.location !== undefined && { country: normalizeText(f.location) }),
      ...(f.uri !== undefined && { uri: f.uri }),
      ...(f['work-count'] !== undefined && { worksCount: f['work-count'] }),
      ...(f['replaced-by']?.length && { replacedBy: f['replaced-by'] }),
      ...(f.replaces?.length && { replaces: f.replaces }),
    }));

    const listEnrichment = {
      funderCount: funders.length,
      fundersTotal,
      ...(listContinuation.kind === 'next' && { nextOffset: listContinuation.offset }),
    };

    /**
     * `notice` is last-wins, and a page can need more than one caveat at once — a deprecated
     * match on a page that also stops at an offset ceiling. Collected and emitted as a single
     * string so neither silently overwrites the other.
     */
    const notices: string[] = [];
    const flushNotices = () => {
      if (notices.length > 0) ctx.enrich.notice(notices.join(' '));
    };

    const deprecation = deprecationNotice(funders);
    if (deprecation) notices.push(deprecation);

    if (!input.include_works || funders.length === 0) {
      ctx.enrich(listEnrichment);
      // An empty page has two causes a caller reading only content[] cannot otherwise tell
      // apart: nothing matched, or the offset ran off the end of a list that did match.
      if (funders.length === 0) {
        notices.push(
          fundersTotal > 0
            ? `Offset ${input.offset} is past the end of this result list — ${fundersTotal} funders matched. Request an offset below ${fundersTotal}.`
            : 'No funders matched the query. Try a name-based query or verify the funder DOI is a registry ID like "100000001" or "10.13039/100000001".',
        );
      } else if (listContinuation.kind === 'ceiling') {
        // A missing nextOffset here would be indistinguishable from the end of the list, and
        // withholding the offset also means the caller never trips offset_too_large and never
        // reads its recovery. Say it on the page instead.
        notices.push(
          `This is the last funder page reachable by offset — Crossref caps offset + rows at ${NAME_SEARCH_OFFSET_CAP} on funder search and ${fundersTotal} funders matched. Narrow the query to bring the rest into reach.`,
        );
      }
      flushNotices();
      return { funders };
    }

    // A name query can match several funders. Reject rather than resolve one silently — funded
    // works carry no funder attribution of their own, so a caller reading the response would
    // have no way to tell which funder they belong to. The test is the upstream match count,
    // not this page's length: a page holding one of many matches (rows=1, or the tail of a
    // list) identifies no funder the caller chose. Each candidate's registry ID is named in
    // both the message and the error data so re-running needs no probe call.
    if (!input.funder_doi && fundersTotal > 1) {
      const candidates = rawFunders.map((f, i) => ({
        name: funders[i]?.name ?? '(unnamed)',
        ...(f.id !== undefined && { id: f.id }),
      }));
      const listed = candidates.map((c) => `"${c.name}" (${c.id ?? 'no registry ID'})`).join(', ');
      // The candidate list is one page of the matches; saying "matched N" with N as the page
      // length would understate the choice and hide that the wanted funder may not be listed.
      const partial = candidates.length < fundersTotal;
      throw ctx.fail(
        'ambiguous_funder',
        `include_works requires an unambiguous funder. The query matched ${fundersTotal} funders` +
          `${partial ? `; this page lists ${candidates.length}` : ''}: ${listed}. ` +
          `Re-run with funder_doi set to one of those registry IDs` +
          `${partial ? ', or narrow the query if the funder you want is not among them,' : ''} to fetch its funded works.`,
        { candidates, matchedTotal: fundersTotal, ...ctx.recoveryFor('ambiguous_funder') },
      );
    }

    const firstFunder = rawFunders[0];
    const funderId = firstFunder?.id ?? input.funder_doi;
    if (!funderId) {
      ctx.enrich(listEnrichment);
      flushNotices();
      return { funders };
    }

    const worksResult = await svc.getFunderWorks(
      funderId,
      worksCursor !== undefined
        ? { rows: input.rows, cursor: worksCursor }
        : { rows: input.rows, offset: input.works_offset },
      ctx,
    );
    const fundedWorks = worksResult.items.map((raw) => {
      const published =
        parseDateParts(raw.published) ??
        parseDateParts(raw['published-print']) ??
        parseDateParts(raw['published-online']);
      return {
        doi: raw.DOI,
        ...(raw.title?.[0] !== undefined && { title: normalizeMarkupText(raw.title[0]) }),
        ...(raw.type != null && { type: raw.type }),
        ...(published !== undefined && {
          published: { year: published.year, month: published.month },
        }),
        ...(raw['is-referenced-by-count'] !== undefined && {
          isReferencedByCount: raw['is-referenced-by-count'],
        }),
      };
    });

    if (worksCursor !== undefined) {
      // A cursor walk has no offset ceiling and no offset position, so neither
      // nextWorksOffset nor the ceiling notice applies. Crossref keeps minting a token past
      // the end of the list, so the token is withheld on an empty page — that keeps "no
      // continuation field means the list is exhausted" true for the cursor path too.
      ctx.enrich({
        ...listEnrichment,
        fundedWorksTotal: worksResult.totalResults,
        ...(fundedWorks.length > 0 &&
          worksResult.nextCursor !== undefined && { nextWorksCursor: worksResult.nextCursor }),
      });
    } else {
      const worksContinuation = nextPageOffset({
        offset: input.works_offset,
        returned: fundedWorks.length,
        total: worksResult.totalResults,
        rows: input.rows,
        cap: WORKS_OFFSET_CAP,
      });

      ctx.enrich({
        ...listEnrichment,
        fundedWorksTotal: worksResult.totalResults,
        ...(worksContinuation.kind === 'next' && { nextWorksOffset: worksContinuation.offset }),
      });
      if (worksContinuation.kind === 'ceiling') {
        notices.push(
          `This is the last works page reachable by works_offset — Crossref caps works_offset + rows at ${WORKS_OFFSET_CAP} on a funded-works list and ${worksResult.totalResults} works exist. Re-run with works_cursor="*" and chain nextWorksCursor to read the whole list; the walk restarts at the newest work.`,
        );
      }
    }
    flushNotices();

    return {
      funders,
      fundedWorks,
    };
  },

  format: (result) => {
    const lines: string[] = [];

    for (const f of result.funders) {
      lines.push(`## ${f.name ?? f.id ?? '(unknown)'}`);
      if (f.id) lines.push(`**ID:** ${f.id}`);
      if (f.uri) lines.push(`**URI:** ${f.uri}`);
      if (f.country) lines.push(`**Country:** ${f.country}`);
      if (f.altNames?.length) lines.push(`**Also known as:** ${f.altNames.join(', ')}`);
      if (f.worksCount !== undefined) lines.push(`**Works in Crossref:** ${f.worksCount}`);
      if (f.replacedBy?.length)
        lines.push(`**Deprecated — replaced by:** ${f.replacedBy.join(', ')}`);
      if (f.replaces?.length) lines.push(`**Replaces:** ${f.replaces.join(', ')}`);
      lines.push('');
    }

    if (result.fundedWorks?.length) {
      lines.push(`### Funded works`);
      for (const w of result.fundedWorks) {
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

// --- Helpers ---

/**
 * Notice text for deprecated funder records on a page, or undefined when there are none.
 *
 * A superseded registry entry answers to the same name and abbreviation as its successor
 * while carrying only the works registered against the old ID, so a caller who lands on one
 * is handed an undercount as the answer. Naming the successor puts the fact on `content[]`,
 * where the record's own `replacedBy` field is otherwise the only trace. The replacement is
 * never followed — resolving to a funder the caller did not ask for would be worse than the
 * undercount, so the successor ID is reported and the choice left to the caller.
 */
function deprecationNotice(
  funders: Array<{ id?: string; name?: string; replacedBy?: string[] }>,
): string | undefined {
  const deprecated = funders.filter((f) => f.replacedBy?.length);
  if (deprecated.length === 0) return;
  const listed = deprecated
    .map(
      (f) =>
        `"${f.name ?? f.id ?? '(unnamed)'}" (${f.id ?? 'no registry ID'}) → ${f.replacedBy?.join(', ')}`,
    )
    .join('; ');
  const subject =
    deprecated.length === 1
      ? 'One returned funder is'
      : `${deprecated.length} returned funders are`;
  return `${subject} deprecated in the Crossref Funder Registry and superseded by another entry: ${listed}. A deprecated entry keeps only the works registered against its own ID, so its work counts and funded-works list undercount the current funder. Re-run with funder_doi set to the superseding registry ID for the current record — this response was not redirected.`;
}
