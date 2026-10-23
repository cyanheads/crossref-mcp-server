/**
 * @fileoverview crossref_get_references — returns a page of the outgoing reference list for a DOI.
 * Fetches the full /works/{doi} record and extracts the reference[] array client-side, then slices
 * it by offset/limit so structuredContent and content[] carry the identical page. The entry's
 * free-text fields are entity-decoded, whitespace-collapsed, and stripped of the markup a
 * publisher deposits into a citation string — see normalizeReferenceText in the service, whose
 * bounded rule is what keeps a bracketed URL or a Miller index from being read as a tag. What
 * that rule keeps is escaped again by mdText on its way into content[], or the client's
 * Markdown renderer consumes the bracket the strip just protected.
 * Incoming citations are not available through Crossref; use OpenAlex for those.
 * @module mcp-server/tools/definitions/get-references.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { mdText } from '@/mcp-server/tools/markdown-text.js';
import {
  clampPageSize,
  ENTRY_LIMIT_CAP,
  ENTRY_LIMIT_CEILING,
} from '@/mcp-server/tools/page-size.js';
import { notFoundDetail } from '@/mcp-server/tools/registration-agency.js';
import {
  getCrossrefService,
  normalizeDoi,
  normalizeReferenceText,
} from '@/services/crossref/crossref-service.js';
import { UPSTREAM_ERROR_CONTRACT } from '@/services/crossref/upstream-errors.js';

/**
 * Crossref deposits a reference's ISSN as `https://id.crossref.org/issn/<ISSN>`; the ISSN is what
 * follows. Scheme and host are case-insensitive, so the match is too. A fully anchored literal
 * prefix, so it is linear by construction.
 */
const ISSN_URI_PREFIX = /^https?:\/\/id\.crossref\.org\/issn\//i;

/** The ISSN a reference deposits, less its URI and surrounding whitespace; absent when nothing is left. */
function referenceIssn(deposited: string): string | undefined {
  return deposited.trim().replace(ISSN_URI_PREFIX, '') || undefined;
}

const ReferenceSchema = z
  .object({
    key: z.string().optional().describe('Reference key as deposited'),
    doi: z.string().optional().describe('Resolved DOI for this reference, when available'),
    unstructured: z
      .string()
      .optional()
      .describe(
        'Citation string as deposited by the publisher, with formatting markup and structured-citation tags removed. Angle-bracketed text that is not recognizable as markup — a cited URL, a Miller index, a DOI fragment — is left exactly as deposited, and so is a link whose href holds an address the text it wraps does not already carry.',
      ),
    author: z
      .string()
      .optional()
      .describe('Author field from the reference entry, with inline formatting markup removed'),
    year: z.string().optional().describe('Publication year of the referenced work'),
    journalTitle: z
      .string()
      .optional()
      .describe('Journal title of the referenced work, with inline formatting markup removed'),
    articleTitle: z
      .string()
      .optional()
      .describe('Article title of the referenced work, with inline formatting markup removed'),
    volumeTitle: z
      .string()
      .optional()
      .describe(
        'Title of the cited book or proceedings volume, with inline formatting markup removed. The only title on many book and chapter citations.',
      ),
    seriesTitle: z
      .string()
      .optional()
      .describe(
        'Title of the series the cited work belongs to, with inline formatting markup removed',
      ),
    volume: z.string().optional().describe('Volume'),
    issue: z.string().optional().describe('Issue'),
    firstPage: z.string().optional().describe('First page'),
    edition: z.string().optional().describe('Edition of the cited book, as deposited'),
    issn: z.string().optional().describe('ISSN of the referenced journal'),
    doiAssertedBy: z
      .string()
      .optional()
      .describe(
        'Who supplied the DOI: "publisher" when the citing work\'s publisher deposited it, "crossref" when Crossref matched the citation to it.',
      ),
  })
  .describe('Reference entry');

export const getReferencesTool = tool('crossref_get_references', {
  title: 'Get Reference List',
  description:
    'Returns the outgoing reference list for a DOI — the works cited by this paper. Each reference includes the deposited citation string and, where Crossref has resolved it, a DOI you can look up with crossref_get_work. Results are paged: referenceCount is the full deposited total, and when more remain the response carries a nextOffset to pass back as offset. Reference list coverage varies by publisher; many older works and non-participating publishers have no indexed references. Incoming citations — the works that cite this paper — are not available through Crossref; use OpenAlex for that.',
  annotations: { readOnlyHint: true, idempotentHint: true },

  input: z.object({
    doi: z
      .string()
      .regex(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:)?10\.\d{4,9}\/\S+$/i, {
        message:
          'DOI must be "10." followed by 4–9 digits and a slash, e.g. "10.1038/nature12373", optionally wrapped in its resolver ("https://doi.org/…", "doi:…").',
      })
      .describe(
        'DOI in the format "10.NNNN/suffix", e.g. "10.1038/nature12373". A resolver-wrapped form — "https://doi.org/10.1038/nature12373", "https://dx.doi.org/…", "doi:10.1038/nature12373" — is accepted and unwrapped.',
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
      .max(ENTRY_LIMIT_CEILING)
      .default(100)
      .describe(
        `Maximum number of references to return in one page (1–${ENTRY_LIMIT_CAP} per call, default 100). A larger value, up to ${ENTRY_LIMIT_CEILING}, returns ${ENTRY_LIMIT_CAP} and says so in notice; nextOffset continues after the references returned. Most works fit in a single page; bibliography records can carry tens of thousands.`,
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
        'Coverage guidance when no references are indexed, a range explanation when the requested offset is past the end of the list, or which references this page covers and the offset that reaches the next ones. Leads with the value requested and the cap applied when limit was above its per-call cap. Absent on a page that holds the whole list with limit within its cap.',
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
    /**
     * The schema admits the resolver-wrapped forms; the request path, the log, and the
     * not-found message all read the bare DOI, so the unwrap happens once, here.
     */
    const doi = normalizeDoi(input.doi);
    /**
     * Clamped once, here, so the slice, nextOffset, and the `cap` enrichment read the page size
     * used. `notice` is last-wins, so the clamp disclosure leads whichever notice this page writes.
     */
    const limitClamp = clampPageSize('limit', input.limit, ENTRY_LIMIT_CAP);
    const limit = limitClamp.value;
    const withClamp = (text: string) => (limitClamp.notice ? `${limitClamp.notice} ${text}` : text);
    ctx.log.info('Fetching references', { doi });
    const svc = getCrossrefService();
    const raw = await svc.getWork(doi, ctx);

    if (!raw) {
      const detail = notFoundDetail({
        subject: 'doi',
        message: `No Crossref record for DOI: ${doi}`,
        recovery: ctx.recoveryFor('doi_not_found').recovery.hint,
        lookup: await svc.getRegistrationAgency(doi, ctx),
      });
      throw ctx.fail('doi_not_found', detail.message, { doi, ...detail.data });
    }

    if (!raw.reference || raw.reference.length === 0) {
      ctx.enrich.notice(
        withClamp(
          'No reference list indexed for this work. Coverage varies by publisher and era; ' +
            'pre-2000 works and non-participating publishers often have no indexed references. ' +
            'Try OpenAlex for alternative reference data.',
        ),
      );
      return { doi: raw.DOI, referenceCount: 0, offset: input.offset, references: [] };
    }

    const total = raw.reference.length;
    if (input.offset >= total) {
      ctx.enrich.notice(
        withClamp(
          `Offset ${input.offset} is past the end of this reference list (${total} references). ` +
            `Request an offset below ${total}.`,
        ),
      );
      return { doi: raw.DOI, referenceCount: total, offset: input.offset, references: [] };
    }

    const page = raw.reference.slice(input.offset, input.offset + limit);
    const nextOffset = input.offset + page.length;
    if (nextOffset < total) {
      ctx.enrich({ nextOffset });
      ctx.enrich.truncated({
        shown: page.length,
        cap: limit,
        guidance: withClamp(
          `Showing references ${input.offset + 1}–${nextOffset} of ${total}. Call again with offset=${nextOffset} for the next page.`,
        ),
      });
    } else if (limitClamp.notice) {
      ctx.enrich.notice(limitClamp.notice);
    }

    /**
     * The free-text fields get the entity decode and whitespace collapse every other
     * human-readable value this server returns does, plus a strip of the markup a publisher
     * deposits into a citation string. The identifiers and numeric strings stay byte-exact.
     * The strip is bounded — by tag shape, by markup region, and by an element-name
     * allow-list — rather than matching every angle bracket, because a bracket here is as
     * often content as markup, and deleting a cited URL is a worse failure than leaving one
     * unrecognized tag in place.
     */
    const references = page.map((r) => {
      const issn = r.ISSN ? referenceIssn(r.ISSN) : undefined;
      return {
        ...(r.key && { key: r.key }),
        ...(r.DOI && { doi: r.DOI }),
        ...(r.unstructured && { unstructured: normalizeReferenceText(r.unstructured) }),
        ...(r.author && { author: normalizeReferenceText(r.author) }),
        ...(r.year && { year: r.year }),
        ...(r['journal-title'] && { journalTitle: normalizeReferenceText(r['journal-title']) }),
        ...(r['article-title'] && { articleTitle: normalizeReferenceText(r['article-title']) }),
        ...(r['volume-title'] && { volumeTitle: normalizeReferenceText(r['volume-title']) }),
        ...(r['series-title'] && { seriesTitle: normalizeReferenceText(r['series-title']) }),
        ...(r.volume && { volume: r.volume }),
        ...(r.issue && { issue: r.issue }),
        ...(r['first-page'] && { firstPage: r['first-page'] }),
        ...(r.edition && { edition: r.edition }),
        ...(issn && { issn }),
        ...(r['doi-asserted-by'] && { doiAssertedBy: r['doi-asserted-by'] }),
      };
    });

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
      const assertedBy = r.doiAssertedBy ? ` (asserted by ${mdText(r.doiAssertedBy)})` : '';
      const doi = r.doi ? ` — DOI: ${r.doi}${assertedBy}` : assertedBy;
      const year = r.year ? ` (${r.year})` : '';
      const journal = r.journalTitle ? ` *${mdText(r.journalTitle)}*` : '';
      const authorPart = r.author ? ` ${mdText(r.author)}` : '';
      const volPage =
        r.volume || r.issue || r.firstPage
          ? ` ${mdText(r.volume ?? '')}${r.issue ? `(${mdText(r.issue)})` : ''}${r.firstPage ? `:${mdText(r.firstPage)}` : ''}`
          : '';
      const series = r.seriesTitle ? ` series:${mdText(r.seriesTitle)}` : '';
      const edition = r.edition ? ` edition:${mdText(r.edition)}` : '';
      const issnPart = r.issn ? ` ISSN:${mdText(r.issn)}` : '';
      // A cited book's title is often its only title; with an article title beside it, it names the volume the article is in.
      const title = r.articleTitle
        ? mdText(r.articleTitle)
        : r.volumeTitle
          ? mdText(r.volumeTitle)
          : `[${position}]`;
      const inVolume = r.articleTitle && r.volumeTitle ? ` In: *${mdText(r.volumeTitle)}*` : '';
      const keyPart = r.key ? ` key:${r.key}` : '';
      const rawPart = r.unstructured ? ` | ${mdText(r.unstructured)}` : '';
      lines.push(
        `${position}.${authorPart} ${title}${inVolume}${year}${journal}${volPage}${series}${edition}${issnPart}${doi}${keyPart}${rawPart}`,
      );
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
