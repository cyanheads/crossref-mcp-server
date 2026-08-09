/**
 * @fileoverview Tests for the crossref_get_work tool.
 * @module tests/tools/get-work.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getWorkTool } from '@/mcp-server/tools/definitions/get-work.tool.js';

// Mock the service module so tests never hit the network
vi.mock('@/services/crossref/crossref-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/crossref/crossref-service.js')>();
  return {
    ...actual,
    getCrossrefService: vi.fn(),
  };
});

import { getCrossrefService } from '@/services/crossref/crossref-service.js';

const mockGetWork = vi.fn();

beforeEach(() => {
  vi.mocked(getCrossrefService).mockReturnValue({ getWork: mockGetWork } as ReturnType<
    typeof getCrossrefService
  >);
  mockGetWork.mockReset();
});

/** Minimal raw Crossref work record. */
function makeRawWork(overrides: Record<string, unknown> = {}) {
  return {
    DOI: '10.1038/nature12373',
    type: 'journal-article',
    title: ['Cas9 in mammals'],
    'container-title': ['Nature'],
    publisher: 'Springer Nature',
    'is-referenced-by-count': 1500,
    'references-count': 42,
    published: { 'date-parts': [[2013, 8, 22]] },
    author: [
      {
        given: 'Le',
        family: 'Cong',
        ORCID: 'https://orcid.org/0000-0001-1234-5678',
        sequence: 'first',
      },
    ],
    abstract: 'Abstract text here.',
    ...overrides,
  };
}

describe('getWorkTool', () => {
  it('returns full metadata for a valid DOI', async () => {
    const ctx = createMockContext({ errors: getWorkTool.errors });
    mockGetWork.mockResolvedValue(makeRawWork());

    const input = getWorkTool.input.parse({ doi: '10.1038/nature12373' });
    const result = await getWorkTool.handler(input, ctx);

    expect(result.doi).toBe('10.1038/nature12373');
    expect(result.type).toBe('journal-article');
    expect(result.title).toBe('Cas9 in mammals');
    expect(result.containerTitle).toBe('Nature');
    expect(result.isReferencedByCount).toBe(1500);
    expect(result.referencesCount).toBe(42);
    expect(result.published?.year).toBe(2013);
    expect(result.published?.month).toBe(8);
    expect(result.published?.day).toBe(22);
    expect(result.authors?.[0]?.given).toBe('Le');
    expect(result.authors?.[0]?.family).toBe('Cong');
  });

  it('handles sparse upstream record — no abstract, no authors', async () => {
    const ctx = createMockContext({ errors: getWorkTool.errors });
    mockGetWork.mockResolvedValue(makeRawWork({ abstract: undefined, author: undefined }));

    const input = getWorkTool.input.parse({ doi: '10.1038/nature12373' });
    const result = await getWorkTool.handler(input, ctx);

    expect(result.abstract).toBeUndefined();
    expect(result.authors).toBeUndefined();
    // format should still work without fabricating values
    const blocks = getWorkTool.format!(result);
    expect(blocks[0]?.text).toContain('*Not deposited*');
  });

  it('handles sparse record — no container title, no publisher, no date', async () => {
    const ctx = createMockContext({ errors: getWorkTool.errors });
    mockGetWork.mockResolvedValue(
      makeRawWork({
        'container-title': undefined,
        publisher: undefined,
        published: undefined,
        'published-print': undefined,
        'published-online': undefined,
        issued: undefined,
      }),
    );

    const input = getWorkTool.input.parse({ doi: '10.1038/nature12373' });
    const result = await getWorkTool.handler(input, ctx);

    expect(result.containerTitle).toBeUndefined();
    expect(result.publisher).toBeUndefined();
    expect(result.published).toBeUndefined();
  });

  it('normalizes funders, licenses, and links fields', async () => {
    const ctx = createMockContext({ errors: getWorkTool.errors });
    mockGetWork.mockResolvedValue(
      makeRawWork({
        funder: [{ name: 'NSF', DOI: '10.13039/100000001', award: ['DMR-0123'] }],
        license: [
          {
            URL: 'https://creativecommons.org/licenses/by/4.0/',
            'content-version': 'vor',
            'delay-in-days': 0,
          },
        ],
        link: [
          {
            URL: 'https://example.com/fulltext.pdf',
            'content-type': 'application/pdf',
            'intended-application': 'text-mining',
          },
        ],
      }),
    );

    const input = getWorkTool.input.parse({ doi: '10.1038/nature12373' });
    const result = await getWorkTool.handler(input, ctx);

    expect(result.funders?.[0]?.name).toBe('NSF');
    expect(result.funders?.[0]?.doi).toBe('10.13039/100000001');
    expect(result.funders?.[0]?.award).toEqual(['DMR-0123']);
    expect(result.licenses?.[0]?.url).toBe('https://creativecommons.org/licenses/by/4.0/');
    expect(result.licenses?.[0]?.contentVersion).toBe('vor');
    expect(result.licenses?.[0]?.delayInDays).toBe(0);
    expect(result.links?.[0]?.url).toBe('https://example.com/fulltext.pdf');
    expect(result.links?.[0]?.contentType).toBe('application/pdf');
    expect(result.links?.[0]?.intendedApplication).toBe('text-mining');
  });

  it('returns subject and language fields', async () => {
    const ctx = createMockContext({ errors: getWorkTool.errors });
    mockGetWork.mockResolvedValue(
      makeRawWork({
        subject: ['Genetics', 'Biochemistry'],
        language: 'en',
        URL: 'https://doi.org/10.1038/nature12373',
      }),
    );

    const input = getWorkTool.input.parse({ doi: '10.1038/nature12373' });
    const result = await getWorkTool.handler(input, ctx);

    expect(result.subject).toEqual(['Genetics', 'Biochemistry']);
    expect(result.language).toBe('en');
    expect(result.url).toBe('https://doi.org/10.1038/nature12373');
  });

  it('decodes HTML entities in title and abstract', async () => {
    const ctx = createMockContext({ errors: getWorkTool.errors });
    mockGetWork.mockResolvedValue(
      makeRawWork({
        title: ['Proteins &amp; Lipids &lt;3&gt;'],
        abstract: 'Rate &gt; 50% &amp; efficiency &lt;100%.',
      }),
    );

    const input = getWorkTool.input.parse({ doi: '10.1038/nature12373' });
    const result = await getWorkTool.handler(input, ctx);

    expect(result.title).toBe('Proteins & Lipids <3>');
    expect(result.abstract).toBe('Rate > 50% & efficiency <100%.');
  });

  it('strips JATS XML tags from abstract', async () => {
    const ctx = createMockContext({ errors: getWorkTool.errors });
    mockGetWork.mockResolvedValue(
      makeRawWork({
        abstract: '<abstract><title>Background</title><p>Gene editing was studied.</p></abstract>',
      }),
    );

    const input = getWorkTool.input.parse({ doi: '10.1038/nature12373' });
    const result = await getWorkTool.handler(input, ctx);

    expect(result.abstract).not.toContain('<');
    expect(result.abstract).not.toContain('>');
    expect(result.abstract).toContain('Gene editing was studied');
  });

  it('strips JATS markup and embedded newlines from title, subtitle, and container title', async () => {
    const ctx = createMockContext({ errors: getWorkTool.errors });
    mockGetWork.mockResolvedValue(
      makeRawWork({
        title: ['<i>In vivo</i>\n                    CRISPR biosensing'],
        subtitle: ['a <scp>Review</scp>\nof methods'],
        'container-title': ['<i>Chem.</i> Soc. Rev.'],
      }),
    );

    const input = getWorkTool.input.parse({ doi: '10.1039/d5cs00921a' });
    const result = await getWorkTool.handler(input, ctx);

    expect(result.title).toBe('In vivo CRISPR biosensing');
    expect(result.subtitle).toBe('a Review of methods');
    expect(result.containerTitle).toBe('Chem. Soc. Rev.');
    // The Markdown heading in content[] has to stay on one line.
    const text = getWorkTool.format!(result)[0]?.text ?? '';
    expect(text.split('\n')[0]).toBe('## In vivo CRISPR biosensing');
  });

  it('collapses a lone newline in a title with no adjacent indentation', async () => {
    const ctx = createMockContext({ errors: getWorkTool.errors });
    mockGetWork.mockResolvedValue(makeRawWork({ title: ['<i>In vivo</i>\nCRISPR biosensing'] }));

    const input = getWorkTool.input.parse({ doi: '10.1039/d5cs00921a' });
    const result = await getWorkTool.handler(input, ctx);

    expect(result.title).toBe('In vivo CRISPR biosensing');
  });

  it('decodes entities in publisher, funder names, subjects, and affiliations', async () => {
    const ctx = createMockContext({ errors: getWorkTool.errors });
    mockGetWork.mockResolvedValue(
      makeRawWork({
        publisher: 'Taylor &amp; Francis',
        funder: [{ name: 'Bill &amp; Melinda Gates Foundation', DOI: '10.13039/100000865' }],
        subject: ['Ecology, Evolution, Behavior &amp; Systematics'],
        author: [
          {
            given: 'Jane',
            family: 'Doe',
            affiliation: [{ name: 'Dept. of Ecology &amp; Evolution' }],
          },
        ],
      }),
    );

    const input = getWorkTool.input.parse({ doi: '10.1038/nature12373' });
    const result = await getWorkTool.handler(input, ctx);

    expect(result.publisher).toBe('Taylor & Francis');
    expect(result.funders?.[0]?.name).toBe('Bill & Melinda Gates Foundation');
    expect(result.subject?.[0]).toBe('Ecology, Evolution, Behavior & Systematics');
    expect(result.authors?.[0]?.affiliation?.[0]?.name).toBe('Dept. of Ecology & Evolution');
  });

  it('uses subtitle/short-title as subtitle when present', async () => {
    const ctx = createMockContext({ errors: getWorkTool.errors });
    mockGetWork.mockResolvedValue(makeRawWork({ subtitle: ['A systematic review'] }));

    const input = getWorkTool.input.parse({ doi: '10.1038/nature12373' });
    const result = await getWorkTool.handler(input, ctx);

    expect(result.subtitle).toBe('A systematic review');
  });

  it('normalizes author ORCID and affiliation', async () => {
    const ctx = createMockContext({ errors: getWorkTool.errors });
    mockGetWork.mockResolvedValue(
      makeRawWork({
        author: [
          {
            given: 'Jane',
            family: 'Doe',
            ORCID: 'https://orcid.org/0000-0002-1234-5678',
            affiliation: [{ name: 'MIT' }],
            sequence: 'first',
          },
          {
            name: 'The ENCODE Consortium',
          },
        ],
      }),
    );

    const input = getWorkTool.input.parse({ doi: '10.1038/nature12373' });
    const result = await getWorkTool.handler(input, ctx);

    expect(result.authors?.[0]?.orcid).toBe('https://orcid.org/0000-0002-1234-5678');
    expect(result.authors?.[0]?.affiliation?.[0]?.name).toBe('MIT');
    expect(result.authors?.[0]?.sequence).toBe('first');
    expect(result.authors?.[1]?.name).toBe('The ENCODE Consortium');
    expect(result.authors?.[1]?.given).toBeUndefined();
    expect(result.authors?.[1]?.family).toBeUndefined();
  });

  it('uses published-print date when published is absent', async () => {
    const ctx = createMockContext({ errors: getWorkTool.errors });
    mockGetWork.mockResolvedValue(
      makeRawWork({
        published: undefined,
        'published-print': { 'date-parts': [[2019, 3]] },
      }),
    );

    const input = getWorkTool.input.parse({ doi: '10.1038/nature12373' });
    const result = await getWorkTool.handler(input, ctx);

    expect(result.published?.year).toBe(2019);
    expect(result.published?.month).toBe(3);
    expect(result.published?.day).toBeUndefined();
  });

  it('throws doi_not_found when service returns null', async () => {
    const ctx = createMockContext({ errors: getWorkTool.errors });
    mockGetWork.mockResolvedValue(null);

    const input = getWorkTool.input.parse({ doi: '10.9999/nonexistent' });
    await expect(getWorkTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'doi_not_found' },
    });
  });

  it('rejects DOI with invalid format via Zod schema', () => {
    expect(() => getWorkTool.input.parse({ doi: 'not-a-doi' })).toThrow();
    expect(() => getWorkTool.input.parse({ doi: '10.x/suffix' })).toThrow();
    expect(() => getWorkTool.input.parse({ doi: 'https://doi.org/10.1038/nature' })).toThrow();
  });

  it('accepts minimum-length DOI registrant (4 digits)', () => {
    const parsed = getWorkTool.input.parse({ doi: '10.1234/suffix' });
    expect(parsed.doi).toBe('10.1234/suffix');
  });

  it('formats output with title, doi, and authors', () => {
    const result = {
      doi: '10.1038/nature12373',
      type: 'journal-article',
      title: 'Cas9 in mammals',
      authors: [{ given: 'Le', family: 'Cong' }],
      abstract: 'Some abstract.',
      isReferencedByCount: 1500,
    };
    const blocks = getWorkTool.format!(result);
    expect(blocks[0]?.type).toBe('text');
    const text = blocks[0]?.text ?? '';
    expect(text).toContain('10.1038/nature12373');
    expect(text).toContain('Le');
    expect(text).toContain('Cong');
    expect(text).toContain('Some abstract.');
    expect(text).toContain('1500');
  });

  it('formats funders, licenses, and links in output', () => {
    const result = {
      doi: '10.1038/nature12373',
      title: 'Test',
      isReferencedByCount: 0,
      funders: [{ name: 'NIH', doi: '10.13039/100000002', award: ['R01-GM123'] }],
      licenses: [
        {
          url: 'https://creativecommons.org/licenses/by/4.0/',
          contentVersion: 'vor',
          delayInDays: 0,
        },
      ],
      links: [
        {
          url: 'https://example.com/full.pdf',
          contentType: 'application/pdf',
          intendedApplication: 'text-mining',
        },
      ],
    };
    const blocks = getWorkTool.format!(result);
    const text = blocks[0]?.text ?? '';
    expect(text).toContain('NIH');
    expect(text).toContain('R01-GM123');
    expect(text).toContain('creativecommons.org');
    expect(text).toContain('vor');
    expect(text).toContain('example.com/full.pdf');
    expect(text).toContain('text-mining');
  });

  it('security: output does not leak CROSSREF_MAILTO env value', async () => {
    const originalMailto = process.env.CROSSREF_MAILTO;
    process.env.CROSSREF_MAILTO = 'secret@internal.example.com';
    try {
      const ctx = createMockContext({ errors: getWorkTool.errors });
      mockGetWork.mockResolvedValue(makeRawWork());

      const input = getWorkTool.input.parse({ doi: '10.1038/nature12373' });
      const result = await getWorkTool.handler(input, ctx);
      const blocks = getWorkTool.format!(result);
      const outputText = JSON.stringify(result) + (blocks[0]?.text ?? '');

      expect(outputText).not.toContain('secret@internal.example.com');
    } finally {
      if (originalMailto === undefined) delete process.env.CROSSREF_MAILTO;
      else process.env.CROSSREF_MAILTO = originalMailto;
    }
  });
});
