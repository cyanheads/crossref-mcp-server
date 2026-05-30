/**
 * @fileoverview Tests for the crossref_search_journals tool.
 * @module tests/tools/search-journals.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { searchJournalsTool } from '@/mcp-server/tools/definitions/search-journals.tool.js';

vi.mock('@/services/crossref/crossref-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/crossref/crossref-service.js')>();
  return {
    ...actual,
    getCrossrefService: vi.fn(),
  };
});

import { getCrossrefService } from '@/services/crossref/crossref-service.js';

const mockSearchJournals = vi.fn();
const mockGetJournalWorks = vi.fn();

beforeEach(() => {
  vi.mocked(getCrossrefService).mockReturnValue({
    searchJournals: mockSearchJournals,
    getJournalWorks: mockGetJournalWorks,
  } as ReturnType<typeof getCrossrefService>);
  mockSearchJournals.mockReset();
  mockGetJournalWorks.mockReset();
});

const RAW_JOURNAL = {
  title: 'Nature',
  'ISSN-L': '0028-0836',
  ISSN: ['0028-0836', '1476-4687'],
  publisher: 'Springer Nature',
  subjects: [{ name: 'Multidisciplinary', ASJC: 1000 }],
  counts: { 'total-dois': 90000 },
};

describe('searchJournalsTool', () => {
  it('returns journal records for a title query', async () => {
    const ctx = createMockContext();
    mockSearchJournals.mockResolvedValue([RAW_JOURNAL]);

    const input = searchJournalsTool.input.parse({ query: 'Nature' });
    const result = await searchJournalsTool.handler(input, ctx);

    expect(result.journals).toHaveLength(1);
    expect(result.journals[0]?.title).toBe('Nature');
    expect(result.journals[0]?.issnL).toBe('0028-0836');
    expect(result.journals[0]?.publisher).toBe('Springer Nature');
    expect(result.journals[0]?.totalDois).toBe(90000);
    expect(result.recentWorks).toBeUndefined();
    expect(getEnrichment(ctx)).toMatchObject({ journalCount: 1 });
  });

  it('fetches recent works when include_works is true and enriches worksTotal', async () => {
    const ctx = createMockContext();
    mockSearchJournals.mockResolvedValue([RAW_JOURNAL]);
    mockGetJournalWorks.mockResolvedValue({
      totalResults: 5000,
      itemsPerPage: 10,
      items: [
        { DOI: '10.1038/s41586-024-0001-1', type: 'journal-article', title: ['New finding'] },
      ],
    });

    const input = searchJournalsTool.input.parse({ query: 'Nature', include_works: true });
    const result = await searchJournalsTool.handler(input, ctx);

    expect(result.recentWorks).toHaveLength(1);
    expect(result.recentWorks?.[0]?.doi).toBe('10.1038/s41586-024-0001-1');
    expect(getEnrichment(ctx)).toMatchObject({ journalCount: 1, worksTotal: 5000 });
  });

  it('returns empty journals and sets notice when none match', async () => {
    const ctx = createMockContext();
    mockSearchJournals.mockResolvedValue([]);

    const input = searchJournalsTool.input.parse({ query: 'ZZZUnknownJournal' });
    const result = await searchJournalsTool.handler(input, ctx);

    expect(result.journals).toHaveLength(0);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.journalCount).toBe(0);
    expect(enrichment.notice).toBeDefined();
  });

  it('formats output with journal metadata', () => {
    const result = {
      journals: [
        {
          title: 'Nature',
          issnL: '0028-0836',
          issn: ['0028-0836', '1476-4687'],
          publisher: 'Springer Nature',
          subjects: [{ name: 'Multidisciplinary' }],
          totalDois: 90000,
        },
      ],
    };
    const blocks = searchJournalsTool.format!(result);
    const text = blocks[0]?.text ?? '';
    expect(text).toContain('Nature');
    expect(text).toContain('0028-0836');
    expect(text).toContain('Springer Nature');
    expect(text).toContain('90000');
  });
});
