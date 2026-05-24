/**
 * @fileoverview crossref_get_work — resolves a DOI to its full Crossref metadata record.
 * @module mcp-server/tools/definitions/get-work.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  decodeHtmlEntities,
  formatDateParts,
  getCrossrefService,
  parseDateParts,
  stripJats,
} from '@/services/crossref/crossref-service.js';
import type { CrossrefAuthor } from '@/services/crossref/types.js';

const AuthorSchema = z
  .object({
    given: z.string().optional().describe('Given (first) name'),
    family: z.string().optional().describe('Family (last) name'),
    name: z.string().optional().describe('Name when no given/family split is available'),
    orcid: z.string().optional().describe('ORCID identifier URI'),
    affiliation: z
      .array(z.object({ name: z.string().describe('Affiliation name') }).describe('Affiliation'))
      .optional()
      .describe('Institutional affiliations'),
    sequence: z.string().optional().describe('Author order role (first, additional)'),
  })
  .describe('Author or contributor');

const FunderSchema = z
  .object({
    name: z.string().describe('Funder name'),
    doi: z.string().optional().describe('Funder DOI'),
    award: z.array(z.string()).optional().describe('Grant or award numbers'),
  })
  .describe('Funding assertion');

const LicenseSchema = z
  .object({
    url: z.string().describe('License URL'),
    contentVersion: z.string().optional().describe('Content version (vor, am, tdm, unspecified)'),
    delayInDays: z.number().optional().describe('Embargo delay in days from publication date'),
  })
  .describe('License entry');

const LinkSchema = z
  .object({
    url: z.string().describe('Full-text URL'),
    contentType: z.string().optional().describe('MIME type of linked content'),
    intendedApplication: z
      .string()
      .optional()
      .describe('Intended use (text-mining, similarity-checking, etc.)'),
  })
  .describe('Registered full-text link');

const DatePartsSchema = z.object({
  year: z.number().optional().describe('Year'),
  month: z.number().optional().describe('Month (1–12)'),
  day: z.number().optional().describe('Day of month'),
});

export const getWorkTool = tool('crossref_get_work', {
  title: 'Get Work by DOI',
  description:
    'Resolves a DOI to its full Crossref metadata record: title, authors, affiliations, abstract (when deposited), journal or container, publication date, type, license, full-text links, funder acknowledgements, and outgoing reference list. The is_referenced_by_count field reports the total incoming citation count from Crossref; the citing works themselves are not available through Crossref — use OpenAlex for citation graphs.',
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
  }),

  output: z.object({
    doi: z.string().describe('Canonical DOI'),
    title: z.string().optional().describe('Work title'),
    subtitle: z.string().optional().describe('Subtitle when present'),
    type: z
      .string()
      .optional()
      .describe('Work type (e.g. journal-article, book-chapter, posted-content)'),
    authors: z.array(AuthorSchema).optional().describe('Author and contributor list'),
    abstract: z
      .string()
      .optional()
      .describe('Abstract when deposited by the publisher. Many records lack abstracts.'),
    isReferencedByCount: z
      .number()
      .optional()
      .describe('Incoming citation count from Crossref — the count of works citing this DOI'),
    referencesCount: z
      .number()
      .optional()
      .describe('Number of outgoing references (works cited by this paper)'),
    containerTitle: z
      .string()
      .optional()
      .describe('Journal, book, or proceedings name containing this work'),
    issn: z.array(z.string()).optional().describe('ISSN(s) of the containing journal'),
    publisher: z.string().optional().describe('Publisher name'),
    published: DatePartsSchema.optional().describe('Primary publication date'),
    funders: z.array(FunderSchema).optional().describe('Funding acknowledgements'),
    licenses: z.array(LicenseSchema).optional().describe('License terms'),
    links: z.array(LinkSchema).optional().describe('Registered full-text links'),
    url: z.string().optional().describe('DOI resolution URL'),
    subject: z.array(z.string()).optional().describe('Subject classification terms'),
    language: z.string().optional().describe('Language code (ISO 639)'),
  }),

  errors: [
    {
      reason: 'doi_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Valid DOI format but no Crossref record exists.',
      recovery:
        'Verify the DOI is correct or use crossref_search_works to find similar works by title or author.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Resolving DOI', { doi: input.doi });
    const svc = getCrossrefService();
    const raw = await svc.getWork(input.doi, ctx);
    if (!raw) {
      throw ctx.fail('doi_not_found', `No Crossref record for DOI: ${input.doi}`, {
        doi: input.doi,
        ...ctx.recoveryFor('doi_not_found'),
      });
    }

    const title = raw.title?.[0] !== undefined ? decodeHtmlEntities(raw.title[0]) : undefined;
    const subtitle =
      raw.subtitle?.[0] !== undefined
        ? decodeHtmlEntities(raw.subtitle[0])
        : raw['short-title']?.[0] !== undefined
          ? decodeHtmlEntities(raw['short-title'][0])
          : undefined;
    const containerTitle =
      raw['container-title']?.[0] !== undefined
        ? decodeHtmlEntities(raw['container-title'][0])
        : undefined;

    const published = parseDateParts(
      raw.published ?? raw['published-print'] ?? raw['published-online'] ?? raw.issued,
    );

    return {
      doi: raw.DOI,
      ...(title !== undefined && { title }),
      ...(subtitle !== undefined && { subtitle }),
      ...(raw.type != null && { type: raw.type }),
      ...(raw.author && { authors: raw.author.map(normalizeAuthor) }),
      ...(raw.abstract !== undefined && { abstract: decodeHtmlEntities(stripJats(raw.abstract)) }),
      ...(raw['is-referenced-by-count'] !== undefined && {
        isReferencedByCount: raw['is-referenced-by-count'],
      }),
      ...(raw['references-count'] !== undefined && {
        referencesCount: raw['references-count'],
      }),
      ...(containerTitle !== undefined && { containerTitle }),
      ...(raw.ISSN && raw.ISSN.length > 0 && { issn: raw.ISSN }),
      ...(raw.publisher !== undefined && { publisher: raw.publisher }),
      ...(published !== undefined && { published }),
      ...(raw.funder && {
        funders: raw.funder.map((f) => ({
          name: f.name,
          ...(f.DOI && { doi: f.DOI }),
          ...(f.award && f.award.length > 0 && { award: f.award }),
        })),
      }),
      ...(raw.license && {
        licenses: raw.license.map((l) => ({
          url: l.URL,
          ...(l['content-version'] && { contentVersion: l['content-version'] }),
          ...(l['delay-in-days'] !== undefined && { delayInDays: l['delay-in-days'] }),
        })),
      }),
      ...(raw.link && {
        links: raw.link.map((l) => ({
          url: l.URL,
          ...(l['content-type'] && { contentType: l['content-type'] }),
          ...(l['intended-application'] && {
            intendedApplication: l['intended-application'],
          }),
        })),
      }),
      ...(raw.URL && { url: raw.URL }),
      ...(raw.subject && raw.subject.length > 0 && { subject: raw.subject }),
      ...(raw.language && { language: raw.language }),
    };
  },

  format: (result) => {
    const lines: string[] = [];

    lines.push(`## ${result.title ?? result.doi}`);
    if (result.subtitle) lines.push(`*${result.subtitle}*`);
    lines.push('');

    lines.push(`**DOI:** ${result.doi}${result.type ? ` | **Type:** ${result.type}` : ''}`);
    if (result.publisher) lines.push(`**Publisher:** ${result.publisher}`);
    if (result.containerTitle) lines.push(`**Journal/Container:** ${result.containerTitle}`);
    if (result.issn?.length) lines.push(`**ISSN:** ${result.issn.join(', ')}`);
    if (result.published?.year) lines.push(`**Published:** ${formatDateParts(result.published)}`);
    if (result.language) lines.push(`**Language:** ${result.language}`);

    if (result.isReferencedByCount !== undefined)
      lines.push(`**Cited by:** ${result.isReferencedByCount}`);
    if (result.referencesCount !== undefined)
      lines.push(`**References:** ${result.referencesCount}`);

    if (result.authors?.length) {
      lines.push('**Authors:**');
      for (const a of result.authors) {
        const nameParts = [a.given, a.family, a.name].filter(Boolean);
        const displayName = nameParts.join(' ') || '(unknown)';
        const orcidPart = a.orcid ? ` [ORCID: ${a.orcid}]` : '';
        const seqPart = a.sequence ? ` (${a.sequence})` : '';
        const affPart = a.affiliation?.length
          ? ` — ${a.affiliation.map((af) => af.name).join(', ')}`
          : '';
        lines.push(`- ${displayName}${orcidPart}${seqPart}${affPart}`);
      }
    }

    if (result.subject?.length) lines.push(`**Subjects:** ${result.subject.join(', ')}`);

    lines.push('');
    lines.push('**Abstract:**');
    lines.push(result.abstract ?? '*Not deposited*');

    if (result.funders?.length) {
      lines.push('');
      lines.push('**Funders:**');
      for (const f of result.funders) {
        const awards = f.award?.length ? ` (${f.award.join(', ')})` : '';
        lines.push(`- ${f.name}${f.doi ? ` — ${f.doi}` : ''}${awards}`);
      }
    }

    if (result.licenses?.length) {
      lines.push('');
      lines.push('**Licenses:**');
      for (const l of result.licenses) {
        const delay = l.delayInDays !== undefined ? ` (${l.delayInDays}d embargo)` : '';
        lines.push(`- ${l.url}${l.contentVersion ? ` [${l.contentVersion}]` : ''}${delay}`);
      }
    }

    if (result.links?.length) {
      lines.push('');
      lines.push('**Full-text links:**');
      for (const l of result.links) {
        const ct = l.contentType ? ` (${l.contentType})` : '';
        const app = l.intendedApplication ? ` [${l.intendedApplication}]` : '';
        lines.push(`- ${l.url}${ct}${app}`);
      }
    }

    if (result.url) lines.push(`\n**URL:** ${result.url}`);

    return [{ type: 'text', text: lines.join('\n') }];
  },
});

// --- Helpers ---

function normalizeAuthor(a: CrossrefAuthor) {
  return {
    ...(a.given && { given: a.given }),
    ...(a.family && { family: a.family }),
    ...(a.name && { name: a.name }),
    ...(a.ORCID && { orcid: a.ORCID }),
    ...(a.affiliation?.length && {
      affiliation: a.affiliation.map((af) => ({ name: af.name })),
    }),
    ...(a.sequence && { sequence: a.sequence }),
  };
}
