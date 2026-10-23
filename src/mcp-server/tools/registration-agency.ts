/**
 * @fileoverview The not-found answer for a DOI or prefix Crossref holds nothing for, branched on
 * which registration agency the DOI registry says holds it. A DOI another agency registered
 * (DataCite, JaLC, mEDRA, …) is valid and simply absent from Crossref, a DOI no agency registered
 * is mistyped or invented, and the two call for opposite next moves; without the registry's
 * answer both get the same advice. The agency is named in the message and the hint as well as
 * on `data.registrationAgency`, since `error.data` never reaches a client that reads only
 * `content[]`. When the registry gives no readable answer, the message and hint are exactly the
 * ones the tool gave before the lookup existed.
 * @module mcp-server/tools/registration-agency
 */

import type { RegistrationLookup } from '@/services/crossref/crossref-service.js';

/** What the throw site passes to `ctx.fail`: the message, and the fields to spread into `data`. */
export type NotFoundDetail = {
  message: string;
  data: { registrationAgency?: string; recovery?: { hint: string } };
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
      return {
        message: `${message} — it is registered with ${agency}, not Crossref.`,
        data: {
          registrationAgency: agency,
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
