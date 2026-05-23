/**
 * @fileoverview crossref_get_references — returns the outgoing reference list for a DOI.
 * Fetches the full /works/{doi} record and extracts the reference[] array client-side.
 * Incoming citations are not available through Crossref; use OpenAlex for those.
 * @module mcp-server/tools/definitions/get-references.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCrossrefService } from '@/services/crossref/crossref-service.js';

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
    'Returns the outgoing reference list for a DOI — the works cited by this paper. Each reference includes the raw citation string and, where Crossref has resolved it, a DOI you can look up with crossref_get_work. Reference list coverage varies by publisher; many older works and non-participating publishers have no indexed references. Incoming citations — the works that cite this paper — are not available through Crossref; use OpenAlex for that.',
  annotations: { readOnlyHint: true, idempotentHint: true },

  input: z.object({
    doi: z
      .string()
      .regex(/^10\.\d{4,9}\/\S+$/)
      .describe(
        'DOI in the format "10.NNNN/suffix", e.g. "10.1038/nature12373". Must start with "10." followed by 4–9 digits and a slash.',
      ),
  }),

  output: z.object({
    doi: z.string().describe('DOI of the citing work'),
    referenceCount: z.number().describe('Number of references in the deposited list'),
    references: z.array(ReferenceSchema).describe('Outgoing reference list'),
  }),

  errors: [
    {
      reason: 'doi_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Valid DOI format but no Crossref record exists.',
      recovery:
        'Verify the DOI is correct or use crossref_search_works to find the work by title or author.',
    },
    {
      reason: 'no_references',
      code: JsonRpcErrorCode.NotFound,
      when: 'Record exists but no reference list is indexed for this work.',
      recovery:
        'Reference coverage varies by publisher. Try the DOI in OpenAlex for alternative reference data.',
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
      throw ctx.fail(
        'no_references',
        `No indexed reference list for DOI: ${input.doi}. Coverage varies by publisher.`,
        { doi: input.doi, ...ctx.recoveryFor('no_references') },
      );
    }

    const references = raw.reference.map((r) => ({
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
      referenceCount: references.length,
      references,
    };
  },

  format: (result) => {
    const lines: string[] = [
      `**DOI:** ${result.doi}`,
      `**Reference count:** ${result.referenceCount}`,
      '',
    ];

    const MAX_INLINE = 50;
    const shown = result.references.slice(0, MAX_INLINE);
    const remaining = result.referenceCount - shown.length;

    for (const [i, r] of shown.entries()) {
      const doi = r.doi ? ` — DOI: ${r.doi}` : '';
      const year = r.year ? ` (${r.year})` : '';
      const journal = r.journalTitle ? ` *${r.journalTitle}*` : '';
      const authorPart = r.author ? ` ${r.author}` : '';
      const volPage =
        r.volume || r.firstPage ? ` ${r.volume ?? ''}${r.firstPage ? `:${r.firstPage}` : ''}` : '';
      const issnPart = r.issn ? ` ISSN:${r.issn}` : '';
      const title = r.articleTitle ?? `[${i + 1}]`;
      const keyPart = r.key ? ` key:${r.key}` : '';
      const rawPart = r.unstructured ? ` | ${r.unstructured.slice(0, 120)}` : '';
      lines.push(
        `${i + 1}.${authorPart} ${title}${year}${journal}${volPage}${issnPart}${doi}${keyPart}${rawPart}`,
      );
    }

    if (remaining > 0) {
      lines.push('');
      lines.push(`…and ${remaining} more references in structuredContent.`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
