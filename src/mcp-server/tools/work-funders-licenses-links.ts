/**
 * @fileoverview The funding acknowledgements, license terms, and registered full-text links a work
 * record deposits — an entry schema, a projection, and a labelled Markdown list for each. Both
 * crossref_get_work and crossref_search_works return them, and sharing the pieces is what keeps the
 * two tools naming, describing, and rendering an entry identically. Each tool decides how many
 * entries a record contributes; the shapes, the projection of one entry, and its line are here.
 *
 * A funder is an organization the record names, and a publisher may assert it through the ROR
 * registry instead of by name, so the ROR reader and the placeholder for an organization named in
 * no way this server reads sit here too — the affiliations and institutions crossref_get_work
 * renders follow the same two rules.
 * @module mcp-server/tools/work-funders-licenses-links
 */

import { z } from '@cyanheads/mcp-ts-core';
import { mdText } from '@/mcp-server/tools/markdown-text.js';
import { normalizeText } from '@/services/crossref/markup-text.js';
import type {
  CrossrefFunder,
  CrossrefOrganizationId,
  RawCrossrefWork,
} from '@/services/crossref/types.js';

/**
 * What an organization is called on the Markdown surface when the deposit named none. Shared by
 * the renders so a funder, an affiliation, and an institution say the same thing about the same
 * absence.
 */
export const UNNAMED = '(no name deposited)';

/**
 * The ROR identifier on an organization Crossref carries by identifier rather than by name.
 *
 * A funder, an affiliation, or an institution deposited without a name is not an empty entry —
 * it is an organization the publisher asserted through the registry instead of spelling out, and
 * its `id` array is where that assertion lives. Crossref puts several identifier schemes in that
 * one array, so the type decides which is read: ROR is the one every nameless funder and
 * affiliation in a sampled draw carried, and the only one ever seen alone on them. An ISNI
 * appears beside a ROR and never in place of one, so reading ROR loses nothing those entries
 * depend on for their identity. One sampled institution, on a dataset, carried a Wikidata ID and
 * nothing else; it reads as unnamed, the one rule kept across all three kinds of organization.
 */
export function rorId(ids: CrossrefOrganizationId[] | undefined): string | undefined {
  return ids?.find((entry) => entry['id-type']?.toUpperCase() === 'ROR')?.id;
}

export const FunderSchema = z
  .object({
    name: z
      .string()
      .optional()
      .describe(
        'Funder name as deposited. Absent when the publisher asserted the funder by identifier alone, where ror carries it instead.',
      ),
    doi: z
      .string()
      .optional()
      .describe('Funder DOI — the Crossref Funder Registry entry this assertion resolved to'),
    ror: z
      .string()
      .optional()
      .describe(
        'ROR identifier for the funding organization, when the deposit carries one. It is the whole identity of an assertion deposited without a name.',
      ),
    award: z.array(z.string()).optional().describe('Grant or award numbers'),
  })
  .describe('Funding assertion');

export const LicenseSchema = z
  .object({
    url: z.string().describe('License URL'),
    contentVersion: z.string().optional().describe('Content version (vor, am, tdm, unspecified)'),
    delayInDays: z.number().optional().describe('Embargo delay in days from publication date'),
    start: z.string().optional().describe('License start date-time as deposited by the publisher'),
  })
  .describe('License entry');

export const LinkSchema = z
  .object({
    url: z.string().describe('Full-text URL'),
    contentType: z.string().optional().describe('MIME type of linked content'),
    contentVersion: z
      .string()
      .optional()
      .describe('Content version of the linked manuscript as deposited (e.g. vor, am)'),
    intendedApplication: z
      .string()
      .optional()
      .describe('Intended use (text-mining, similarity-checking, etc.)'),
  })
  .describe('Registered full-text link');

/** One funding assertion as both tools return it. */
type Funder = z.infer<typeof FunderSchema>;
/** One license entry as both tools return it. */
type License = z.infer<typeof LicenseSchema>;
/** One full-text link as both tools return it. */
type Link = z.infer<typeof LinkSchema>;

/**
 * Project a funding assertion. Every field is conditional because Crossref guarantees none of
 * them: an assertion made by identifier carries a ROR, an award number, and nothing else.
 */
export function normalizeFunder(f: CrossrefFunder): Funder {
  const ror = rorId(f.id);
  return {
    ...(f.name !== undefined && { name: normalizeText(f.name) }),
    ...(f.DOI && { doi: f.DOI }),
    ...(ror !== undefined && { ror }),
    ...(f.award && f.award.length > 0 && { award: f.award }),
  };
}

/** Every license entry the record deposits, in deposited order. */
export function projectLicenses(raw: Pick<RawCrossrefWork, 'license'>): { licenses?: License[] } {
  return {
    ...(raw.license && {
      licenses: raw.license.map((l) => ({
        url: l.URL,
        ...(l['content-version'] && { contentVersion: l['content-version'] }),
        ...(l['delay-in-days'] !== undefined && { delayInDays: l['delay-in-days'] }),
        ...(l.start?.['date-time'] !== undefined && { start: l.start['date-time'] }),
      })),
    }),
  };
}

/** Every full-text link the record registers, in deposited order. */
export function projectLinks(raw: Pick<RawCrossrefWork, 'link'>): { links?: Link[] } {
  return {
    ...(raw.link && {
      links: raw.link.map((l) => ({
        url: l.URL,
        ...(l['content-type'] && { contentType: l['content-type'] }),
        ...(l['content-version'] !== undefined && { contentVersion: l['content-version'] }),
        ...(l['intended-application'] && { intendedApplication: l['intended-application'] }),
      })),
    }),
  };
}

/**
 * A funder's line. An assertion deposited without a name leads with the identifier that stands in
 * for one, and whatever identifiers remain trail it exactly as they trail a name. Every identifier
 * the record carries reaches this surface either way — a name that hid one would leave a
 * `content[]` reader unable to resolve what `structuredContent` names. An award number is a string
 * the publisher typed rather than a registry identifier — `2016R1\-D1A1B\-01010135` — so it takes
 * the escape the rest of the deposited text takes.
 */
function funderLine(f: Funder): string {
  const awards = f.award?.length ? ` (${f.award.map(mdText).join(', ')})` : '';
  const ids = [f.doi, f.ror].filter((id) => id !== undefined);
  const label = f.name ? mdText(f.name) : (ids.shift() ?? UNNAMED);
  return `- ${label}${ids.length > 0 ? ` — ${ids.join(' ')}` : ''}${awards}`;
}

/**
 * The labelled funder list, or nothing when the work carries no funder. A list cut below the
 * deposited total — `funderCount` above the number of entries — says so in its label and names
 * the call that returns the rest.
 */
export function funderSection(w: {
  doi: string;
  funders?: Funder[] | undefined;
  funderCount?: number | undefined;
}): string[] | undefined {
  if (!w.funders?.length) return undefined;
  const cut =
    w.funderCount !== undefined && w.funderCount > w.funders.length
      ? ` showing ${w.funders.length} of ${w.funderCount}; call crossref_get_work with doi ${w.doi} for the whole list`
      : '';
  return [`**Funders:**${cut}`, ...w.funders.map(funderLine)];
}

/**
 * The labelled license list, or nothing when the work carries no license. The content version
 * and start are relayed as deposited, so each takes the escape, as a link's version does.
 */
export function licenseSection(w: { licenses?: License[] | undefined }): string[] | undefined {
  if (!w.licenses?.length) return undefined;
  return [
    '**Licenses:**',
    ...w.licenses.map((l) => {
      const version = l.contentVersion ? ` [${mdText(l.contentVersion)}]` : '';
      const delay = l.delayInDays !== undefined ? ` (${l.delayInDays}d embargo)` : '';
      const start = l.start !== undefined ? ` — starts ${mdText(l.start)}` : '';
      return `- ${l.url}${version}${delay}${start}`;
    }),
  ];
}

/** The labelled full-text link list, or nothing when the work registers no link. */
export function linkSection(w: { links?: Link[] | undefined }): string[] | undefined {
  if (!w.links?.length) return undefined;
  return [
    '**Full-text links:**',
    ...w.links.map((l) => {
      const ct = l.contentType ? ` (${l.contentType})` : '';
      const app = l.intendedApplication ? ` [${l.intendedApplication}]` : '';
      const version = l.contentVersion !== undefined ? ` [${mdText(l.contentVersion)}]` : '';
      return `- ${l.url}${ct}${app}${version}`;
    }),
  ];
}
