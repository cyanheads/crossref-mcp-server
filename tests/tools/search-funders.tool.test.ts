/**
 * @fileoverview Tests for the crossref_search_funders tool.
 * @module tests/tools/search-funders.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { searchFundersTool } from '@/mcp-server/tools/definitions/search-funders.tool.js';

vi.mock('@/services/crossref/crossref-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/crossref/crossref-service.js')>();
  return {
    ...actual,
    getCrossrefService: vi.fn(),
  };
});

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getCrossrefService } from '@/services/crossref/crossref-service.js';

const mockSearchFunders = vi.fn();
const mockGetFunderWorks = vi.fn();

beforeEach(() => {
  vi.mocked(getCrossrefService).mockReturnValue({
    searchFunders: mockSearchFunders,
    getFunderWorks: mockGetFunderWorks,
  } as ReturnType<typeof getCrossrefService>);
  mockSearchFunders.mockReset();
  mockGetFunderWorks.mockReset();
});

const RAW_FUNDER = {
  id: '100000001',
  name: 'National Science Foundation',
  'alt-names': ['NSF'],
  country: null,
  'country-code': null,
  location: 'United States',
  uri: 'http://dx.doi.org/10.13039/100000001',
  'work-count': 250000,
};

describe('searchFundersTool', () => {
  it('returns funder records for a name query', async () => {
    const ctx = createMockContext();
    mockSearchFunders.mockResolvedValue([RAW_FUNDER]);

    const input = searchFundersTool.input.parse({ query: 'National Science Foundation' });
    const result = await searchFundersTool.handler(input, ctx);

    expect(result.funders).toHaveLength(1);
    expect(result.funders[0]?.name).toBe('National Science Foundation');
    expect(result.funders[0]?.id).toBe('100000001');
    expect(result.funders[0]?.country).toBe('United States');
    expect(result.funders[0]?.worksCount).toBe(250000);
    expect(result.fundedWorks).toBeUndefined();
    expect(getEnrichment(ctx)).toMatchObject({ funderCount: 1 });
  });

  it('fetches funded works when include_works is true and enriches fundedWorksTotal', async () => {
    const ctx = createMockContext();
    mockSearchFunders.mockResolvedValue([RAW_FUNDER]);
    mockGetFunderWorks.mockResolvedValue({
      totalResults: 250000,
      itemsPerPage: 10,
      items: [
        { DOI: '10.1038/s41586-024-0001-1', type: 'journal-article', title: ['NSF-funded work'] },
      ],
    });

    const input = searchFundersTool.input.parse({
      query: 'National Science Foundation',
      include_works: true,
    });
    const result = await searchFundersTool.handler(input, ctx);

    expect(result.fundedWorks).toHaveLength(1);
    expect(result.fundedWorks?.[0]?.doi).toBe('10.1038/s41586-024-0001-1');
    expect(getEnrichment(ctx)).toMatchObject({ funderCount: 1, fundedWorksTotal: 250000 });
  });

  it('returns empty funders and sets notice when none match', async () => {
    const ctx = createMockContext();
    mockSearchFunders.mockResolvedValue([]);

    const input = searchFundersTool.input.parse({ query: 'ZZZUnknownFunder' });
    const result = await searchFundersTool.handler(input, ctx);

    expect(result.funders).toHaveLength(0);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.funderCount).toBe(0);
    expect(enrichment.notice).toBeDefined();
  });

  it('performs direct funder DOI lookup when funder_doi is provided', async () => {
    const ctx = createMockContext();
    mockSearchFunders.mockResolvedValue([RAW_FUNDER]);

    const input = searchFundersTool.input.parse({ funder_doi: '10.13039/100000001' });
    const result = await searchFundersTool.handler(input, ctx);

    expect(mockSearchFunders).toHaveBeenCalledWith(
      expect.objectContaining({ funderDoi: '10.13039/100000001' }),
      expect.anything(),
    );
    expect(result.funders[0]?.id).toBe('100000001');
  });

  it('throws funder_not_found when upstream returns McpError(NotFound)', async () => {
    const ctx = createMockContext({ errors: searchFundersTool.errors });
    mockSearchFunders.mockRejectedValue(new McpError(JsonRpcErrorCode.NotFound, 'Not found'));

    const input = searchFundersTool.input.parse({ funder_doi: '10.13039/999999999' });
    await expect(searchFundersTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'funder_not_found' },
    });
  });

  it('re-throws non-NotFound errors from funder search', async () => {
    const ctx = createMockContext({ errors: searchFundersTool.errors });
    mockSearchFunders.mockRejectedValue(new McpError(JsonRpcErrorCode.Conflict, 'Server error'));

    const input = searchFundersTool.input.parse({ query: 'NSF' });
    await expect(searchFundersTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.Conflict,
    });
  });

  it('handles sparse funder record — no alt-names, no country-code', async () => {
    const ctx = createMockContext();
    mockSearchFunders.mockResolvedValue([
      { id: '999', name: 'Minimal Funder', location: 'Unknown' },
    ]);

    const input = searchFundersTool.input.parse({ query: 'Minimal' });
    const result = await searchFundersTool.handler(input, ctx);

    expect(result.funders[0]?.name).toBe('Minimal Funder');
    expect(result.funders[0]?.altNames).toBeUndefined();
    expect(result.funders[0]?.countryCode).toBeUndefined();
  });

  it('decodes HTML entities in funder name and altNames', async () => {
    const ctx = createMockContext();
    mockSearchFunders.mockResolvedValue([
      {
        id: '123',
        name: 'Agence Nationale de la Recherche &amp; Innovation',
        'alt-names': ['ANR &amp; Innovation'],
        location: 'France',
      },
    ]);

    const input = searchFundersTool.input.parse({ query: 'ANR' });
    const result = await searchFundersTool.handler(input, ctx);

    expect(result.funders[0]?.name).toBe('Agence Nationale de la Recherche & Innovation');
    expect(result.funders[0]?.altNames?.[0]).toBe('ANR & Innovation');
  });

  it('uses funder_doi from input as fallback ID when raw funder has no id', async () => {
    const ctx = createMockContext();
    // Funder record missing `id` field
    mockSearchFunders.mockResolvedValue([{ name: 'Some Funder', location: 'Country' }]);
    mockGetFunderWorks.mockResolvedValue({
      totalResults: 100,
      itemsPerPage: 10,
      items: [],
    });

    const input = searchFundersTool.input.parse({
      funder_doi: '10.13039/100000999',
      include_works: true,
    });
    const result = await searchFundersTool.handler(input, ctx);

    expect(mockGetFunderWorks).toHaveBeenCalledWith(
      '10.13039/100000999',
      expect.any(Number),
      expect.anything(),
    );
    expect(result.fundedWorks).toHaveLength(0);
  });

  it('formats output with funder metadata', () => {
    const result = {
      funders: [
        {
          id: '100000001',
          name: 'National Science Foundation',
          altNames: ['NSF'],
          country: 'United States',
          countryCode: 'US',
          uri: 'http://dx.doi.org/10.13039/100000001',
          worksCount: 250000,
        },
      ],
    };
    const blocks = searchFundersTool.format!(result);
    const text = blocks[0]?.text ?? '';
    expect(text).toContain('National Science Foundation');
    expect(text).toContain('United States');
    expect(text).toContain('250000');
    expect(text).toContain('NSF');
  });

  it('formats fundedWorks section when present', () => {
    const result = {
      funders: [{ id: '100000001', name: 'NSF', worksCount: 100 }],
      fundedWorks: [
        {
          doi: '10.1038/s41586-024-0001-1',
          title: 'NSF-funded Discovery',
          type: 'journal-article',
          published: { year: 2024, month: 3 },
          isReferencedByCount: 10,
        },
      ],
    };
    const blocks = searchFundersTool.format!(result);
    const text = blocks[0]?.text ?? '';
    expect(text).toContain('NSF-funded Discovery');
    expect(text).toContain('10.1038/s41586-024-0001-1');
    expect(text).toContain('2024');
    expect(text).toContain('10');
  });

  it('accepts rows between 1 and 100', () => {
    expect(() => searchFundersTool.input.parse({ query: 'test', rows: 1 })).not.toThrow();
    expect(() => searchFundersTool.input.parse({ query: 'test', rows: 100 })).not.toThrow();
  });

  it('rejects rows outside valid range', () => {
    expect(() => searchFundersTool.input.parse({ query: 'test', rows: 0 })).toThrow();
    expect(() => searchFundersTool.input.parse({ query: 'test', rows: 101 })).toThrow();
  });

  it('accepts valid funder_doi formats — bare, doi: prefix, and URL prefix', () => {
    expect(() => searchFundersTool.input.parse({ funder_doi: '10.13039/100000001' })).not.toThrow();
    expect(() =>
      searchFundersTool.input.parse({ funder_doi: 'doi:10.13039/100000001' }),
    ).not.toThrow();
    expect(() =>
      searchFundersTool.input.parse({ funder_doi: 'https://doi.org/10.13039/100000001' }),
    ).not.toThrow();
    expect(() =>
      searchFundersTool.input.parse({ funder_doi: 'http://dx.doi.org/10.13039/100000001' }),
    ).not.toThrow();
  });

  it('rejects malformed funder_doi values before any upstream call', () => {
    expect(() => searchFundersTool.input.parse({ funder_doi: 'not-a-doi' })).toThrow();
    expect(() => searchFundersTool.input.parse({ funder_doi: '10.1038/nature12373' })).toThrow();
    expect(() => searchFundersTool.input.parse({ funder_doi: '10.13039/' })).toThrow();
    expect(() => searchFundersTool.input.parse({ funder_doi: '100000001' })).toThrow();
  });
});
