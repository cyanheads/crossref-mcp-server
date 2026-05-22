/**
 * @fileoverview Tests for the crossref_search_funders tool.
 * @module tests/tools/search-funders.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { searchFundersTool } from '@/mcp-server/tools/definitions/search-funders.tool.js';

vi.mock('@/services/crossref/crossref-service.js', () => ({
  getCrossrefService: vi.fn(),
}));

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
  country: 'United States',
  'country-code': 'US',
  uri: 'http://dx.doi.org/10.13039/100000001',
  works: 250000,
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
  });

  it('fetches funded works when include_works is true', async () => {
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
    expect(result.fundedWorksTotal).toBe(250000);
  });

  it('returns empty funders when none match', async () => {
    const ctx = createMockContext();
    mockSearchFunders.mockResolvedValue([]);

    const input = searchFundersTool.input.parse({ query: 'ZZZUnknownFunder' });
    const result = await searchFundersTool.handler(input, ctx);

    expect(result.funders).toHaveLength(0);
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
});
