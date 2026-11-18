/**
 * @fileoverview The funder, license, and full-text link pieces both work tools return: each entry
 * schema, the projection of a deposited entry, and the labelled list each renders. The values
 * expected here are crossref_get_work's — the shapes its output declares and the lines its tests
 * pin — so these pieces hold get_work's behavior whichever tool imports them, and the per-tool
 * suites prove only the wiring.
 * @module tests/tools/work-funders-licenses-links.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import { getWorkTool } from '@/mcp-server/tools/definitions/get-work.tool.js';
import {
  FunderSchema,
  funderSection,
  LicenseSchema,
  LinkSchema,
  licenseSection,
  linkSection,
  normalizeFunder,
  projectLicenses,
  projectLinks,
  rorId,
  UNNAMED,
} from '@/mcp-server/tools/work-funders-licenses-links.js';
import { blockText, renderedText } from '../helpers/content.js';

/** The entry schema get_work declares for one of its list fields. */
function getWorkEntry(field: 'funders' | 'licenses' | 'links'): z.ZodType {
  const shape = (getWorkTool.output as unknown as z.ZodObject).shape;
  return (shape[field] as unknown as z.ZodOptional<z.ZodArray<z.ZodType>>).unwrap().element;
}

describe('the entry schemas', () => {
  it.each([
    ['funders', FunderSchema],
    ['licenses', LicenseSchema],
    ['links', LinkSchema],
  ] as const)('%s advertises the entry shape crossref_get_work declares', (field, schema) => {
    expect(z.toJSONSchema(schema)).toEqual(z.toJSONSchema(getWorkEntry(field)));
  });
});

describe('rorId', () => {
  it.each([
    ['a ROR', [{ id: 'https://ror.org/0439y7842', 'id-type': 'ROR' }], 'https://ror.org/0439y7842'],
    [
      'a lowercase type',
      [{ id: 'https://ror.org/01h0zpd94', 'id-type': 'ror' }],
      'https://ror.org/01h0zpd94',
    ],
    [
      'a ROR after a DOI',
      [
        { id: '10.13039/501100011033', 'id-type': 'DOI' },
        { id: 'https://ror.org/003x0zc53', 'id-type': 'ROR' },
      ],
      'https://ror.org/003x0zc53',
    ],
    ['a DOI alone', [{ id: '10.13039/501100001809', 'id-type': 'DOI' }], undefined],
    ['no id-type', [{ id: 'Q42' }], undefined],
    ['no ids', undefined, undefined],
  ])('reads %s', (_label, ids, expected) => {
    expect(rorId(ids)).toBe(expected);
  });
});

describe('normalizeFunder', () => {
  it.each([
    [
      'a named funder with its registry DOI and award',
      { name: 'NSF', DOI: '10.13039/100000001', award: ['DMR-0123'] },
      { name: 'NSF', doi: '10.13039/100000001', award: ['DMR-0123'] },
    ],
    [
      'an assertion by ROR alone, with no name',
      {
        award: ['EP/S020527/1'],
        id: [{ id: 'https://ror.org/0439y7842', 'id-type': 'ROR', 'asserted-by': 'publisher' }],
      },
      { ror: 'https://ror.org/0439y7842', award: ['EP/S020527/1'] },
    ],
    [
      'a DOI-typed id, which restates the funder DOI and is not read as a ROR',
      {
        DOI: '10.13039/501100001809',
        name: 'National Natural Science Foundation of China',
        award: ['41801279'],
        id: [{ id: '10.13039/501100001809', 'id-type': 'DOI', 'asserted-by': 'crossref' }],
      },
      {
        name: 'National Natural Science Foundation of China',
        doi: '10.13039/501100001809',
        award: ['41801279'],
      },
    ],
    [
      'a name, a DOI, and a ROR together',
      {
        name: 'Agencia Estatal de Investigación',
        DOI: '10.13039/501100011033',
        award: ['PID2020-01'],
        id: [
          { id: '10.13039/501100011033', 'id-type': 'DOI', 'asserted-by': 'crossref' },
          { id: 'https://ror.org/003x0zc53', 'id-type': 'ROR', 'asserted-by': 'publisher' },
        ],
      },
      {
        name: 'Agencia Estatal de Investigación',
        doi: '10.13039/501100011033',
        ror: 'https://ror.org/003x0zc53',
        award: ['PID2020-01'],
      },
    ],
    [
      'an entity-escaped name',
      { name: 'Bill &amp; Melinda Gates Foundation', DOI: '10.13039/100000865' },
      { name: 'Bill & Melinda Gates Foundation', doi: '10.13039/100000865' },
    ],
    ['an award list deposited empty', { name: 'NIH', award: [] }, { name: 'NIH' }],
    ['an award alone', { award: ['X-1'] }, { award: ['X-1'] }],
  ])('projects %s', (_label, deposited, expected) => {
    expect(normalizeFunder(deposited)).toEqual(expected);
  });

  /** The expectation is its own literal: one sharing the deposited array moves with it. */
  it('relays an award number exactly as deposited, backslashes and brackets included', () => {
    const award = ['2016R1\\-D1A1B\\-01010135', '[R01] *A*', 'GA\\'];
    expect(normalizeFunder({ name: 'NRF', award }).award).toEqual([
      '2016R1\\-D1A1B\\-01010135',
      '[R01] *A*',
      'GA\\',
    ]);
  });
});

describe('projectLicenses and projectLinks', () => {
  it('projects every deposited field, in deposited order', () => {
    const raw = {
      license: ['tdm', 'vor'].map((version) => ({
        URL: 'https://creativecommons.org/licenses/by/4.0',
        'content-version': version,
        'delay-in-days': 0,
        start: { 'date-time': '2020-09-16T00:00:00Z' },
      })),
      link: [
        {
          URL: 'https://www.nature.com/articles/s41586-020-2649-2.pdf',
          'content-type': 'application/pdf',
          'content-version': 'vor',
          'intended-application': 'text-mining',
        },
        {
          URL: 'https://www.nature.com/articles/s41586-020-2649-2',
          'content-type': 'text/html',
          'content-version': 'vor',
          'intended-application': 'similarity-checking',
        },
      ],
    };

    expect(projectLicenses(raw)).toEqual({
      licenses: ['tdm', 'vor'].map((contentVersion) => ({
        url: 'https://creativecommons.org/licenses/by/4.0',
        contentVersion,
        delayInDays: 0,
        start: '2020-09-16T00:00:00Z',
      })),
    });
    expect(projectLinks(raw)).toEqual({
      links: [
        {
          url: 'https://www.nature.com/articles/s41586-020-2649-2.pdf',
          contentType: 'application/pdf',
          contentVersion: 'vor',
          intendedApplication: 'text-mining',
        },
        {
          url: 'https://www.nature.com/articles/s41586-020-2649-2',
          contentType: 'text/html',
          contentVersion: 'vor',
          intendedApplication: 'similarity-checking',
        },
      ],
    });
  });

  it('keeps a sparse entry to the URL it deposits, inferring nothing', () => {
    expect(
      projectLicenses({ license: [{ URL: 'https://example.com/license', start: {} }] }),
    ).toEqual({ licenses: [{ url: 'https://example.com/license' }] });
    expect(projectLinks({ link: [{ URL: 'https://example.com/text' }] })).toEqual({
      links: [{ url: 'https://example.com/text' }],
    });
  });

  it('keeps an embargo of zero days, which is a deposited value', () => {
    expect(
      projectLicenses({ license: [{ URL: 'https://example.com/l', 'delay-in-days': 0 }] }),
    ).toEqual({ licenses: [{ url: 'https://example.com/l', delayInDays: 0 }] });
  });

  it('returns no key for a record that deposits neither', () => {
    expect(projectLicenses({})).toEqual({});
    expect(projectLinks({})).toEqual({});
  });
});

describe('the labelled lists', () => {
  const funders = [
    {
      name: 'National Natural Science Foundation of China',
      doi: '10.13039/501100001809',
      award: ['41801279'],
    },
    { ror: 'https://ror.org/01h0zpd94', award: ['41801279'] },
    {
      name: 'Agencia Estatal de Investigación',
      doi: '10.13039/501100011033',
      ror: 'https://ror.org/003x0zc53',
      award: ['PID2020-01'],
    },
    { award: ['X-1'] },
    { name: 'Wellcome Trust' },
  ];

  it('renders each funder by name, or by the identifier standing in for one', () => {
    expect(funderSection({ doi: '10.5555/w', funders })).toEqual([
      '**Funders:**',
      '- National Natural Science Foundation of China — 10.13039/501100001809 (41801279)',
      '- https://ror.org/01h0zpd94 (41801279)',
      '- Agencia Estatal de Investigación — 10.13039/501100011033 https://ror.org/003x0zc53 (PID2020-01)',
      `- ${UNNAMED} (X-1)`,
      '- Wellcome Trust',
    ]);
  });

  it('names the cut and the call for the rest only when funderCount passes the list', () => {
    const shown = funders.slice(0, 2);
    expect(funderSection({ doi: '10.1103/x', funders: shown, funderCount: 381 })?.[0]).toBe(
      '**Funders:** showing 2 of 381; call crossref_get_work with doi 10.1103/x for the whole list',
    );
    expect(funderSection({ doi: '10.1103/x', funders: shown, funderCount: 2 })?.[0]).toBe(
      '**Funders:**',
    );
  });

  it('renders each license and link with what it deposits', () => {
    expect(
      licenseSection({
        licenses: [
          {
            url: 'https://creativecommons.org/licenses/by/4.0',
            contentVersion: 'tdm',
            delayInDays: 0,
            start: '2020-09-16T00:00:00Z',
          },
          { url: 'https://example.com/license' },
        ],
      }),
    ).toEqual([
      '**Licenses:**',
      '- https://creativecommons.org/licenses/by/4.0 [tdm] (0d embargo) — starts 2020-09-16T00:00:00Z',
      '- https://example.com/license',
    ]);
    expect(
      linkSection({
        links: [
          {
            url: 'https://www.nature.com/articles/s41586-020-2649-2.pdf',
            contentType: 'application/pdf',
            contentVersion: 'vor',
            intendedApplication: 'text-mining',
          },
          { url: 'https://example.com/text' },
        ],
      }),
    ).toEqual([
      '**Full-text links:**',
      '- https://www.nature.com/articles/s41586-020-2649-2.pdf (application/pdf) [text-mining] [vor]',
      '- https://example.com/text',
    ]);
  });

  it.each([
    ['an absent list', {}],
    ['an empty list', { funders: [], licenses: [], links: [] }],
  ])('renders nothing for %s', (_label, w) => {
    expect(funderSection({ doi: '10.5555/w', ...w })).toBeUndefined();
    expect(licenseSection(w)).toBeUndefined();
    expect(linkSection(w)).toBeUndefined();
  });

  /** crossref_get_work's own render carries each list, as a section opened by a blank line. */
  it('match the sections crossref_get_work renders for the same record', () => {
    const result = {
      doi: '10.5555/w',
      funders,
      licenses: [{ url: 'https://example.com/license', contentVersion: 'vor', delayInDays: 0 }],
      links: [{ url: 'https://example.com/full.pdf', contentType: 'application/pdf' }],
    };
    const text = blockText(getWorkTool.format?.(result as never)[0]);

    for (const section of [funderSection(result), licenseSection(result), linkSection(result)]) {
      expect(text).toContain(['', ...(section ?? ['missing'])].join('\n'));
    }
  });
});

/**
 * Award numbers and license content versions are strings a publisher typed, relayed unnormalized.
 * A backslash, an asterisk, or a bracket in one is markup to a CommonMark reader unless escaped,
 * so the rendered list has to read back as the deposited value.
 */
describe('award numbers and content versions on the Markdown surface', () => {
  it('read back from CommonMark exactly as deposited', () => {
    const funder = normalizeFunder({
      name: 'NRF',
      DOI: '10.13039/501100003725',
      award: ['2016R1\\-D1A1B\\-01010135', 'H2020 *MSCA*', 'GA\\'],
    });
    const license = projectLicenses({
      license: [{ URL: 'https://example.com/license', 'content-version': '*accepted*' }],
    }).licenses;
    const markdown = [
      ...(funderSection({ doi: '10.5555/w', funders: [funder] }) ?? []),
      '',
      ...(licenseSection({ licenses: license }) ?? []),
    ].join('\n');

    const read = renderedText(markdown).split('\n');
    expect(read).toContain(
      'NRF — 10.13039/501100003725 (2016R1\\-D1A1B\\-01010135, H2020 *MSCA*, GA\\)',
    );
    expect(read).toContain('https://example.com/license [*accepted*]');
  });
});
