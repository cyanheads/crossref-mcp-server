/**
 * @fileoverview The not-found message, hint, and agency for each DOI registry answer, for a DOI
 * and for a prefix, and the citation a DOI's answer can carry. The three tools that call
 * `notFoundDetail` pin only their wiring.
 * @module tests/tools/registration-agency.test
 */

import { describe, expect, it } from 'vitest';
import { notFoundDetail } from '@/mcp-server/tools/registration-agency.js';
import type { CslRecord } from '@/services/crossref/crossref-service.js';
import { expectLinearScaling, repeatWhole } from '../helpers/scaling.js';

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

/**
 * The citation doi.org served for a DOI another agency registered, projected into
 * `data.citation` and written out in the message — the one part of the error a `content[]`
 * reader sees besides the hint. The records here are shaped to each edge; the agencies' real
 * records run end to end in upstream-classification.test.ts.
 */
describe('notFoundDetail with a citation', () => {
  const AGENCY_TEXT = `${DOI_MESSAGE} — it is registered with JaLC, not Crossref.`;
  const HINT =
    "No Crossref tool can return a DOI registered with JaLC; query JaLC's metadata service for it.";
  const cited = (citation: CslRecord) => doi({ kind: 'registered', agency: 'JaLC', citation });

  it('writes every citation value into the message and carries each on data.citation', () => {
    const detail = cited({
      title: 'An <i>in vitro</i> study of\n caf&eacute; ink',
      author: [{ given: 'Ana', family: 'Ruiz' }, { literal: 'The  Ink\nConsortium' }],
      'container-title': 'Journal of <b>Ink</b>',
      issued: { 'date-parts': [[2019, 6, 9]] },
      publisher: 'Fern&#225;ndez &amp; Sons',
      type: 'article-journal',
    });

    expect(detail).toEqual({
      message: `${AGENCY_TEXT} JaLC's citation: title "An in vitro study of café ink"; authors "Ana Ruiz", "The Ink Consortium"; container "Journal of Ink"; issued 2019-06-09; publisher "Fernández & Sons"; type article-journal.`,
      data: {
        registrationAgency: 'JaLC',
        citation: {
          title: 'An in vitro study of café ink',
          authors: [{ given: 'Ana', family: 'Ruiz' }, { name: 'The Ink Consortium' }],
          authorCount: 2,
          containerTitle: 'Journal of Ink',
          issued: { year: 2019, month: 6, day: 9 },
          publisher: 'Fernández & Sons',
          type: 'article-journal',
        },
        recovery: { hint: HINT },
      },
    });
  });

  it('drops a name whose parts are all blank, and the author list once none is left', () => {
    const detail = cited({
      title: 'T',
      author: [
        { family: '', given: '' },
        { given: ' &nbsp; ', literal: '\n' },
      ],
    });

    expect(detail.data.citation).toEqual({ title: 'T' });
    expect(detail.message).toBe(`${AGENCY_TEXT} JaLC's citation: title "T".`);
  });

  it('names the first 25 named authors in deposited order and says how many the record names', () => {
    const author = Array.from({ length: 30 }, (_, i) =>
      i === 10 ? { family: ' ', given: '' } : { given: 'A', family: `N${i + 1}` },
    );

    const { message, data } = cited({ title: 'T', author });

    const shown = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23];
    shown.push(24, 25, 26);
    expect(data.citation?.authors).toEqual(shown.map((n) => ({ given: 'A', family: `N${n}` })));
    expect(data.citation?.authorCount).toBe(29);
    expect(message).toBe(
      `${AGENCY_TEXT} JaLC's citation: title "T"; authors (first 25 of 29) ${shown.map((n) => `"A N${n}"`).join(', ')}.`,
    );
    expect(message).not.toContain('N27');
  });

  it('says nothing of a cut when the record names exactly 25 authors', () => {
    const author = Array.from({ length: 25 }, (_, i) => ({ family: `N${i + 1}` }));

    const { message, data } = cited({ title: 'T', author });

    expect(data.citation?.authors).toHaveLength(25);
    expect(data.citation?.authorCount).toBe(25);
    expect(message).toContain('; authors "N1", "N2", ');
    expect(message).not.toContain('first 25');
  });

  it.each([
    [[[2008]], { year: 2008 }, 'issued 2008'],
    [[[2020, 7]], { year: 2020, month: 7 }, 'issued 2020-07'],
    [[[2020, null, 5]], { year: 2020 }, 'issued 2020'],
  ])('keeps the date the record states in %j, and no more', (dateParts, issued, text) => {
    const { message, data } = cited({ title: 'T', issued: { 'date-parts': dateParts } });

    expect(data.citation?.issued).toEqual(issued);
    expect(message).toBe(`${AGENCY_TEXT} JaLC's citation: title "T"; ${text}.`);
  });

  it.each([
    ['a date with no known component', { title: 'T', issued: { 'date-parts': [[null]] } }],
    ['an empty date', { title: 'T', issued: { 'date-parts': [] } }],
    [
      'a blank container title and publisher',
      { title: 'T', 'container-title': ' ', publisher: '' },
    ],
    ['a blank type', { title: 'T', type: '' }],
  ])('leaves out %s', (_label, record) => {
    const { message, data } = cited(record);

    expect(data.citation).toEqual({ title: 'T' });
    expect(message).toBe(`${AGENCY_TEXT} JaLC's citation: title "T".`);
  });

  it('answers exactly as without a citation when the title normalizes to nothing', () => {
    expect(cited({ title: ' <i></i> \n', publisher: 'P' })).toEqual(
      doi({ kind: 'registered', agency: 'JaLC' }),
    );
  });

  /**
   * Every free-text field of a citation goes through the normalization passes and into the
   * message, so a field of any size costs time linear in it. Each shape fills every field.
   */
  it.each([
    ['one long line ending in a break', (size: number) => `${repeatWhole('§1 x', size - 2)}\ny`],
    ['line breaks throughout', (size: number) => `x${repeatWhole('  \r\n', size - 1)}`],
  ])(
    'stays linear on %s in every field',
    (_name, make) => {
      expectLinearScaling(make, (text) =>
        cited({
          title: text,
          author: [{ given: text, family: text, literal: text }],
          'container-title': text,
          publisher: text,
          type: text,
        }),
      );
    },
    60_000,
  );
});
