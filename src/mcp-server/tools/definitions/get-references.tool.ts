/**
 * @fileoverview crossref_get_references — returns a page of the outgoing reference list for a DOI.
 * Fetches the full /works/{doi} record and extracts the reference[] array client-side, then slices
 * it by offset/limit so structuredContent and content[] carry the identical page.
 * Incoming citations are not available through Crossref; use OpenAlex for those.
 * @module mcp-server/tools/definitions/get-references.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCrossrefService } from '@/services/crossref/crossref-service.js';
import { UPSTREAM_ERROR_CONTRACT } from '@/services/crossref/upstream-errors.js';

const ReferenceSchema = z
  .object({
    key: z.string().optional().describe('Reference key as deposited'),
    doi: z.string().optional().describe('Resolved DOI for this reference, when available'),
    unstructured: z
      .string()
      .optional()
      .describe('Raw citation string as deposited by the publisher'),
    author: z.string().optional().describe('Author field from the reference entry'),
    year: z.string().optional().describe('Publication year of the referenced work'),
    journalTitle: z.string().optional().describe('Journal title of the referenced work'),
    articleTitle: z.string().optional().describe('Article title of the referenced work'),
    volume: z.string().optional().describe('Volume'),
    firstPage: z.string().optional().describe('First page'),
    issn: z.string().optional().describe('ISSN of the referenced journal'),
  })
  .describe('Reference entry');

export const getReferencesTool = tool('crossref_get_references', {
  title: 'Get Reference List',
  description:
    'Returns the outgoing reference list for a DOI — the works cited by this paper. Each reference includes the raw citation string and, where Crossref has resolved it, a DOI you can look up with crossref_get_work. Results are paged: referenceCount is the full deposited total, and when more remain the response carries a nextOffset to pass back as offset. Reference list coverage varies by publisher; many older works and non-participating publishers have no indexed references. Incoming citations — the works that cite this paper — are not available through Crossref; use OpenAlex for that.',
  annotations: { readOnlyHint: true, idempotentHint: true },

  input: z.object({
    doi: z
      .string()
      .regex(/^10\.\d{4,9}\/\S+$/, {
        message:
          'DOI must start with "10." followed by 4–9 digits and a slash, e.g. "10.1038/nature12373". Strip any https://doi.org/ prefix before passing.',
      })
      .describe(
        'DOI in the format "10.NNNN/suffix", e.g. "10.1038/nature12373". Must start with "10." followed by 4–9 digits and a slash.',
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Zero-based index of the first reference to return. Pass the nextOffset value from the previous response to continue through a long reference list.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(100)
      .describe(
        'Maximum number of references to return in one page (1–500, default 100). Most works fit in a single page; bibliography records can carry tens of thousands.',
      ),
  }),

  output: z.object({
    doi: z.string().describe('DOI of the citing work'),
    referenceCount: z.number().describe('Total number of references in the deposited list'),
    offset: z
      .number()
      .describe('Zero-based index of the first returned reference within the deposited list'),
    references: z.array(ReferenceSchema).describe('Page of the outgoing reference list'),
  }),

  enrichment: {
    nextOffset: z
      .number()
      .optional()
      .describe(
        'Offset to pass in the next call to retrieve the following page. Absent when this page reaches the end of the reference list.',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe('True when references remain beyond this page. Absent when the page is the last.'),
    shown: z.number().optional().describe('Number of references returned in this page.'),
    cap: z.number().optional().describe('The limit that was applied to this page.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Coverage guidance when no references are indexed, or a range explanation when the requested offset is past the end of the list. Absent on a normal page.',
      ),
  },

  errors: [
    ...UPSTREAM_ERROR_CONTRACT,
    {
      reason: 'doi_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Valid DOI format but no Crossref record exists.',
      recovery:
        'Verify the DOI is correct or use crossref_search_works to find the work by title or author.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Fetching references', { doi: input.doi });
    const svc = getCrossrefService();
    const raw = await svc.getWork(input.doi, ctx);

    if (!raw) {
      throw ctx.fail('doi_not_found', `No Crossref record for DOI: ${input.doi}`, {
        doi: input.doi,
        ...ctx.recoveryFor('doi_not_found'),
      });
    }

    if (!raw.reference || raw.reference.length === 0) {
      ctx.enrich.notice(
        'No reference list indexed for this work. Coverage varies by publisher and era; ' +
          'pre-2000 works and non-participating publishers often have no indexed references. ' +
          'Try OpenAlex for alternative reference data.',
      );
      return { doi: raw.DOI, referenceCount: 0, offset: input.offset, references: [] };
    }

    const total = raw.reference.length;
    if (input.offset >= total) {
      ctx.enrich.notice(
        `Offset ${input.offset} is past the end of this reference list (${total} references). ` +
          `Request an offset below ${total}.`,
      );
      return { doi: raw.DOI, referenceCount: total, offset: input.offset, references: [] };
    }

    const page = raw.reference.slice(input.offset, input.offset + input.limit);
    const nextOffset = input.offset + page.length;
    if (nextOffset < total) {
      ctx.enrich({ nextOffset });
      ctx.enrich.truncated({
        shown: page.length,
        cap: input.limit,
        guidance: `Showing references ${input.offset + 1}–${nextOffset} of ${total}. Call again with offset=${nextOffset} for the next page.`,
      });
    }

    const references = page.map((r) => ({
      ...(r.key && { key: r.key }),
      ...(r.DOI && { doi: r.DOI }),
      ...(r.unstructured && { unstructured: r.unstructured }),
      ...(r.author && { author: r.author }),
      ...(r.year && { year: r.year }),
      ...(r['journal-title'] && { journalTitle: r['journal-title'] }),
      ...(r['article-title'] && { articleTitle: r['article-title'] }),
      ...(r.volume && { volume: r.volume }),
      ...(r['first-page'] && { firstPage: r['first-page'] }),
      ...(r.issn && { issn: r.issn }),
    }));

    return {
      doi: raw.DOI,
      referenceCount: total,
      offset: input.offset,
      references,
    };
  },

  format: (result) => {
    const lines: string[] = [
      `**DOI:** ${result.doi}`,
      `**References:** showing ${result.references.length} of ${result.referenceCount}, starting at index ${result.offset}`,
      '',
    ];

    for (const [i, r] of result.references.entries()) {
      const position = result.offset + i + 1;
      const doi = r.doi ? ` — DOI: ${r.doi}` : '';
      const year = r.year ? ` (${r.year})` : '';
      const journal = r.journalTitle ? ` *${r.journalTitle}*` : '';
      const authorPart = r.author ? ` ${r.author}` : '';
      const volPage =
        r.volume || r.firstPage ? ` ${r.volume ?? ''}${r.firstPage ? `:${r.firstPage}` : ''}` : '';
      const issnPart = r.issn ? ` ISSN:${r.issn}` : '';
      const title = r.articleTitle ?? `[${position}]`;
      const keyPart = r.key ? ` key:${r.key}` : '';
      const rawPart = r.unstructured ? ` | ${r.unstructured}` : '';
      lines.push(
        `${position}.${authorPart} ${title}${year}${journal}${volPage}${issnPart}${doi}${keyPart}${rawPart}`,
      );
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
