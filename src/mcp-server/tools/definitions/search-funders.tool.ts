/**
 * @fileoverview crossref_search_funders — finds funders in the Crossref Funder Registry by name or DOI.
 * Optionally retrieves works funded by the matched funder in a second sequential call.
 * @module mcp-server/tools/definitions/search-funders.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import {
  type FundersSearchOptions,
  getCrossrefService,
} from '@/services/crossref/crossref-service.js';

const FunderSchema = z.object({
  id: z.string().optional().describe('Funder registry ID'),
  name: z.string().optional().describe('Funder canonical name'),
  altNames: z.array(z.string()).optional().describe('Alternate names for this funder'),
  country: z.string().optional().describe('Country name'),
  countryCode: z.string().optional().describe('ISO country code'),
  uri: z.string().optional().describe('Funder registry URI'),
  worksCount: z
    .number()
    .optional()
    .describe('Number of works associated with this funder in Crossref'),
});

const WorkSummarySchema = z.object({
  doi: z.string().describe('Work DOI'),
  title: z.string().optional().describe('Work title'),
  type: z.string().describe('Work type'),
  published: z
    .object({
      year: z.number().optional().describe('Year'),
      month: z.number().optional().describe('Month'),
    })
    .optional()
    .describe('Publication date'),
  isReferencedByCount: z.number().optional().describe('Incoming citation count'),
});

export const searchFundersTool = tool('crossref_search_funders', {
  title: 'Search Funders',
  description:
    'Finds funders registered in the Crossref Funder Registry by name or funder DOI. Provide funder_doi for an exact single-funder lookup (accepts the full DOI like "10.13039/100000001" or just the registry ID), or query for name-based search. Set include_works to true to fetch a paginated list of works funded by the first matched funder (adds a second upstream call). Returns funder name, DOI, country, and alternate names.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  input: z.object({
    query: z
      .string()
      .optional()
      .describe('Funder name search query, e.g. "National Science Foundation" or "Wellcome Trust"'),
    funder_doi: z
      .string()
      .optional()
      .describe(
        'Funder DOI for exact lookup, e.g. "10.13039/100000001" (NSF). Supersedes query when provided.',
      ),
    include_works: z
      .boolean()
      .default(false)
      .describe(
        'When true, fetch funded works for the first matched funder (adds a second upstream call)',
      ),
    rows: z
      .number()
      .min(1)
      .max(100)
      .default(10)
      .describe(
        'Maximum funders to return for name queries, or works when include_works is true (1–100, default 10)',
      ),
  }),

  output: z.object({
    funders: z.array(FunderSchema).describe('Matching funder records'),
    fundedWorks: z
      .array(WorkSummarySchema)
      .optional()
      .describe(
        'Works funded by the first matched funder. Only present when include_works is true.',
      ),
    fundedWorksTotal: z
      .number()
      .optional()
      .describe('Total count of funded works, when include_works is true'),
  }),

  async handler(input, ctx) {
    ctx.log.info('Searching funders', { query: input.query, funderDoi: input.funder_doi });
    const svc = getCrossrefService();

    const funderOpts: FundersSearchOptions = {
      rows: input.rows,
    };
    if (input.query !== undefined) funderOpts.query = input.query;
    if (input.funder_doi !== undefined) funderOpts.funderDoi = input.funder_doi;
    const rawFunders = await svc.searchFunders(funderOpts, ctx);

    const funders = rawFunders.map((f) => ({
      ...(f.id !== undefined && { id: f.id }),
      ...(f.name !== undefined && { name: f.name }),
      ...(f['alt-names']?.length && { altNames: f['alt-names'] }),
      ...(f.country !== undefined && { country: f.country }),
      ...(f['country-code'] !== undefined && { countryCode: f['country-code'] }),
      ...(f.uri !== undefined && { uri: f.uri }),
      ...(f.works !== undefined && { worksCount: f.works }),
    }));

    if (!input.include_works || funders.length === 0) {
      return { funders };
    }

    const firstFunder = rawFunders[0] as (typeof rawFunders)[number] | undefined;
    const funderId = firstFunder?.id ?? input.funder_doi;
    if (!funderId) {
      return { funders };
    }

    const worksResult = await svc.getFunderWorks(funderId, input.rows, ctx);
    const fundedWorks = worksResult.items.map((raw) => {
      const parts =
        raw.published?.['date-parts']?.[0] ??
        raw['published-print']?.['date-parts']?.[0] ??
        raw['published-online']?.['date-parts']?.[0];
      return {
        doi: raw.DOI,
        ...(raw.title?.[0] !== undefined && { title: raw.title[0] }),
        type: raw.type,
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
      funders,
      fundedWorks,
      fundedWorksTotal: worksResult.totalResults,
    };
  },

  format: (result) => {
    const lines: string[] = [];

    if (result.funders.length === 0) {
      lines.push('No funders matched the query.');
      return [{ type: 'text', text: lines.join('\n') }];
    }

    for (const f of result.funders) {
      lines.push(`## ${f.name ?? f.id ?? '(unknown)'}`);
      if (f.id) lines.push(`**ID:** ${f.id}`);
      if (f.uri) lines.push(`**URI:** ${f.uri}`);
      if (f.country)
        lines.push(`**Country:** ${f.country}${f.countryCode ? ` (${f.countryCode})` : ''}`);
      if (f.altNames?.length) lines.push(`**Also known as:** ${f.altNames.join(', ')}`);
      if (f.worksCount !== undefined) lines.push(`**Works in Crossref:** ${f.worksCount}`);
      lines.push('');
    }

    if (result.fundedWorks?.length) {
      lines.push(
        `### Funded works (${result.fundedWorksTotal ?? result.fundedWorks.length} total)`,
      );
      for (const w of result.fundedWorks) {
        const dateParts = [w.published?.year, w.published?.month].filter((x) => x !== undefined);
        const date = dateParts.length ? ` (${dateParts.join('-')})` : '';
        const cited =
          w.isReferencedByCount !== undefined ? ` | Cited: ${w.isReferencedByCount}` : '';
        lines.push(`- **${w.title ?? w.doi}**${date}${cited}`);
        lines.push(`  DOI: ${w.doi} | Type: ${w.type}`);
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
