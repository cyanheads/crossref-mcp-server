/**
 * @fileoverview The not-found answer for a DOI or prefix Crossref holds nothing for, branched on
 * which registration agency the DOI registry says holds it. A DOI another agency registered
 * (DataCite, JaLC, mEDRA, …) is valid and simply absent from Crossref, a DOI no agency registered
 * is mistyped or invented, and the two call for opposite next moves; without the registry's
 * answer both get the same advice. The agency is named in the message and the hint as well as
 * on `data.registrationAgency`, since `error.data` never reaches a client that reads only
 * `content[]`. When the registry gives no readable answer, the message and hint are exactly the
 * ones the tool gave before the lookup existed.
 *
 * A DOI's lookup can also carry the work's CSL-JSON citation from doi.org, for the agencies that
 * serve one. It is projected here into `data.citation` and written out in full in the message,
 * for the same reason: the message and hint are all of the error a `content[]` reader sees.
 * @module mcp-server/tools/registration-agency
 */

import type { CslRecord, RegistrationLookup } from '@/services/crossref/crossref-service.js';
import { formatDateParts, parseDateParts } from '@/services/crossref/date-parts.js';
import { normalizeMarkupText, normalizeText } from '@/services/crossref/markup-text.js';

/** One author of a citation, in the entry shape `crossref_get_work` gives an author. */
type CitationAuthor = { given?: string; family?: string; name?: string };

/**
 * A work's citation as doi.org serves it for the agency that registered the DOI. Each string is
 * normalized the way `crossref_get_work` normalizes the matching field, `issued` takes the shape
 * its `published` takes, and `type` is the CSL type as supplied. `authors` holds the first
 * `CITATION_AUTHOR_LIMIT` named authors in deposited order and `authorCount` how many the record
 * names; the two come together or not at all.
 */
export type Citation = {
  title: string;
  authors?: CitationAuthor[];
  authorCount?: number;
  containerTitle?: string;
  issued?: NonNullable<ReturnType<typeof parseDateParts>>;
  publisher?: string;
  type?: string;
};

/**
 * How many of a citation's authors the not-found answer names — the page `crossref_get_work`
 * returns by default. An error has no continuation to page the rest through, and an arXiv
 * collaboration record names thousands, each repeated across both surfaces; the count and the
 * message say how many were left out.
 */
const CITATION_AUTHOR_LIMIT = 25;

/** What the throw site passes to `ctx.fail`: the message, and the fields to spread into `data`. */
export type NotFoundDetail = {
  message: string;
  data: { registrationAgency?: string; citation?: Citation; recovery?: { hint: string } };
};

/**
 * Build the not-found message, hint, and agency for one registry answer. `message` and `recovery`
 * are the tool's own not-found text and declared recovery: the message leads every branch, and an
 * absent `data.recovery` leaves the declared recovery as the hint the framework sends.
 */
export function notFoundDetail(args: {
  subject: 'doi' | 'prefix';
  message: string;
  recovery: string;
  lookup: RegistrationLookup;
}): NotFoundDetail {
  const { subject, message, recovery, lookup } = args;
  const noun = subject === 'doi' ? 'DOI' : 'prefix';
  switch (lookup.kind) {
    case 'unknown':
      return { message, data: {} };
    case 'unregistered':
      return {
        message: `${message} — no registration agency has registered this ${noun}.`,
        data: {
          recovery: {
            hint:
              subject === 'doi'
                ? 'Check the DOI for a typo or truncation, or find the work with crossref_search_works.'
                : 'Check the prefix for a typo, or find the work and its publisher with crossref_search_works.',
          },
        },
      };
    case 'registered': {
      const agency = lookup.agency;
      if (agency.toLowerCase() === 'crossref') {
        if (subject === 'prefix') {
          return {
            message: `${message} — Crossref registered this prefix but serves no member record for it.`,
            data: { registrationAgency: agency },
          };
        }
        return {
          message: `${message} — Crossref registered this DOI but serves no work record for it.`,
          data: {
            registrationAgency: agency,
            recovery: {
              hint: `${recovery} A Funder Registry DOI (10.13039/…) is looked up with crossref_search_funders funder_doi.`,
            },
          },
        };
      }
      const citation = lookup.citation && citationOf(lookup.citation);
      return {
        message: `${message} — it is registered with ${agency}, not Crossref.${citation ? ` ${citationSentence(agency, citation)}` : ''}`,
        data: {
          registrationAgency: agency,
          ...(citation && { citation }),
          recovery: {
            hint:
              subject === 'doi'
                ? `No Crossref tool can return a DOI registered with ${agency}; query ${agency}'s metadata service for it.`
                : `No Crossref tool can return works under a prefix registered with ${agency}; query ${agency}'s metadata service for them.`,
          },
        },
      };
    }
    default: {
      const unreachable: never = lookup;
      return unreachable;
    }
  }
}

/**
 * Project a CSL-JSON record into a citation: `normalizeMarkupText` for the title and container
 * title, `normalizeText` for names and the publisher, `parseDateParts` for `issued`, and `type`
 * as supplied. A name whose parts all normalize to nothing is dropped — KISTI deposits one — and
 * a record whose title normalizes to nothing is no citation.
 */
function citationOf(record: CslRecord): Citation | undefined {
  const title = normalizeMarkupText(record.title);
  if (!title) return;
  const authors = (record.author ?? []).flatMap((name) => {
    const given = normalizeText(name.given ?? '');
    const family = normalizeText(name.family ?? '');
    const literal = normalizeText(name.literal ?? '');
    if (!given && !family && !literal) return [];
    return [
      { ...(given && { given }), ...(family && { family }), ...(literal && { name: literal }) },
    ];
  });
  const containerTitle = normalizeMarkupText(record['container-title'] ?? '');
  const issued = parseDateParts(record.issued);
  const publisher = normalizeText(record.publisher ?? '');
  return {
    title,
    ...(authors.length > 0 && {
      authors: authors.slice(0, CITATION_AUTHOR_LIMIT),
      authorCount: authors.length,
    }),
    ...(containerTitle && { containerTitle }),
    ...(issued && { issued }),
    ...(publisher && { publisher }),
    ...(record.type && { type: record.type }),
  };
}

/**
 * The citation as one sentence of the not-found message, carrying every value `data.citation`
 * holds: free-text values quoted, each author given name first as `crossref_get_work` lists them,
 * and a cut author list naming how many of how many it shows.
 */
function citationSentence(agency: string, citation: Citation): string {
  const fields = [`title "${citation.title}"`];
  if (citation.authors && citation.authorCount !== undefined) {
    const names = citation.authors
      .map((author) => `"${[author.given, author.family, author.name].filter(Boolean).join(' ')}"`)
      .join(', ');
    const cut =
      citation.authorCount > citation.authors.length
        ? ` (first ${citation.authors.length} of ${citation.authorCount})`
        : '';
    fields.push(`authors${cut} ${names}`);
  }
  if (citation.containerTitle) fields.push(`container "${citation.containerTitle}"`);
  if (citation.issued) fields.push(`issued ${formatDateParts(citation.issued)}`);
  if (citation.publisher) fields.push(`publisher "${citation.publisher}"`);
  if (citation.type) fields.push(`type ${citation.type}`);
  return `${agency}'s citation: ${fields.join('; ')}.`;
}
