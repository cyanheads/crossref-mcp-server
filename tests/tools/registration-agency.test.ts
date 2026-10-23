/**
 * @fileoverview The not-found message, hint, and agency for each DOI registry answer, for a DOI
 * and for a prefix. The three tools that call `notFoundDetail` pin only their wiring.
 * @module tests/tools/registration-agency.test
 */

import { describe, expect, it } from 'vitest';
import { notFoundDetail } from '@/mcp-server/tools/registration-agency.js';

const DOI_MESSAGE = 'No Crossref record for DOI: 10.5281/zenodo.3242074';
const DOI_RECOVERY = 'Verify the DOI is correct or use crossref_search_works.';
const PREFIX_MESSAGE = 'No Crossref member owns prefix: 10.5281';
const PREFIX_RECOVERY = 'Verify the prefix or use crossref_search_works.';

const doi = (lookup: Parameters<typeof notFoundDetail>[0]['lookup']) =>
  notFoundDetail({ subject: 'doi', message: DOI_MESSAGE, recovery: DOI_RECOVERY, lookup });
const prefix = (lookup: Parameters<typeof notFoundDetail>[0]['lookup']) =>
  notFoundDetail({ subject: 'prefix', message: PREFIX_MESSAGE, recovery: PREFIX_RECOVERY, lookup });

describe('notFoundDetail', () => {
  it('returns the message untouched and adds nothing when the registry answer is unreadable', () => {
    expect(doi({ kind: 'unknown' })).toEqual({ message: DOI_MESSAGE, data: {} });
    expect(prefix({ kind: 'unknown' })).toEqual({ message: PREFIX_MESSAGE, data: {} });
  });

  it('names another agency in the message, the hint, and registrationAgency', () => {
    expect(doi({ kind: 'registered', agency: 'JaLC' })).toEqual({
      message: `${DOI_MESSAGE} — it is registered with JaLC, not Crossref.`,
      data: {
        registrationAgency: 'JaLC',
        recovery: {
          hint: "No Crossref tool can return a DOI registered with JaLC; query JaLC's metadata service for it.",
        },
      },
    });
    expect(prefix({ kind: 'registered', agency: 'DataCite' })).toEqual({
      message: `${PREFIX_MESSAGE} — it is registered with DataCite, not Crossref.`,
      data: {
        registrationAgency: 'DataCite',
        recovery: {
          hint: "No Crossref tool can return works under a prefix registered with DataCite; query DataCite's metadata service for them.",
        },
      },
    });
  });

  it('keeps the declared advice for a Crossref-registered DOI and adds the Funder Registry pointer', () => {
    expect(doi({ kind: 'registered', agency: 'Crossref' })).toEqual({
      message: `${DOI_MESSAGE} — Crossref registered this DOI but serves no work record for it.`,
      data: {
        registrationAgency: 'Crossref',
        recovery: {
          hint: `${DOI_RECOVERY} A Funder Registry DOI (10.13039/…) is looked up with crossref_search_funders funder_doi.`,
        },
      },
    });
  });

  it('leaves the declared advice in place for a Crossref-registered prefix', () => {
    expect(prefix({ kind: 'registered', agency: 'Crossref' })).toEqual({
      message: `${PREFIX_MESSAGE} — Crossref registered this prefix but serves no member record for it.`,
      data: { registrationAgency: 'Crossref' },
    });
  });

  it('reads Crossref in any casing as Crossref, keeping the spelling the registry used', () => {
    expect(prefix({ kind: 'registered', agency: 'CrossRef' }).data).toEqual({
      registrationAgency: 'CrossRef',
    });
  });

  it('says no agency registered it, and points at a typo or a search', () => {
    expect(doi({ kind: 'unregistered' })).toEqual({
      message: `${DOI_MESSAGE} — no registration agency has registered this DOI.`,
      data: {
        recovery: {
          hint: 'Check the DOI for a typo or truncation, or find the work with crossref_search_works.',
        },
      },
    });
    expect(prefix({ kind: 'unregistered' })).toEqual({
      message: `${PREFIX_MESSAGE} — no registration agency has registered this prefix.`,
      data: {
        recovery: {
          hint: 'Check the prefix for a typo, or find the work and its publisher with crossref_search_works.',
        },
      },
    });
  });
});
