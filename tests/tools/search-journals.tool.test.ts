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

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
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

  it('performs direct ISSN lookup when issn param is provided', async () => {
    const ctx = createMockContext();
    mockSearchJournals.mockResolvedValue([RAW_JOURNAL]);

    const input = searchJournalsTool.input.parse({ issn: '0028-0836' });
    const result = await searchJournalsTool.handler(input, ctx);

    expect(mockSearchJournals).toHaveBeenCalledWith(
      expect.objectContaining({ issn: '0028-0836' }),
      expect.anything(),
    );
    expect(result.journals[0]?.issnL).toBe('0028-0836');
  });

  it('throws issn_not_found when upstream returns McpError(NotFound)', async () => {
    const ctx = createMockContext({ errors: searchJournalsTool.errors });
    mockSearchJournals.mockRejectedValue(new McpError(JsonRpcErrorCode.NotFound, 'Not found'));

    const input = searchJournalsTool.input.parse({ issn: '9999-9999' });
    await expect(searchJournalsTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'issn_not_found' },
    });
  });

  it('re-throws non-NotFound errors from journal search', async () => {
    const ctx = createMockContext({ errors: searchJournalsTool.errors });
    mockSearchJournals.mockRejectedValue(new McpError(JsonRpcErrorCode.Conflict, 'Server error'));

    const input = searchJournalsTool.input.parse({ query: 'Nature' });
    await expect(searchJournalsTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.Conflict,
    });
  });

  it('throws ambiguous_journal when include_works=true and multiple journals match without issn', async () => {
    const ctx = createMockContext({ errors: searchJournalsTool.errors });
    const secondJournal = { ...RAW_JOURNAL, title: 'Nature Communications', 'ISSN-L': '2041-1723' };
    mockSearchJournals.mockResolvedValue([RAW_JOURNAL, secondJournal]);

    const input = searchJournalsTool.input.parse({ query: 'Nature', include_works: true });
    await expect(searchJournalsTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'ambiguous_journal' },
    });
  });

  it('does not throw ambiguous_journal when issn is provided with include_works=true', async () => {
    const ctx = createMockContext({ errors: searchJournalsTool.errors });
    const secondJournal = { ...RAW_JOURNAL, title: 'Nature Communications', 'ISSN-L': '2041-1723' };
    mockSearchJournals.mockResolvedValue([RAW_JOURNAL, secondJournal]);
    mockGetJournalWorks.mockResolvedValue({
      totalResults: 100,
      itemsPerPage: 10,
      items: [],
    });

    const input = searchJournalsTool.input.parse({
      issn: '0028-0836',
      include_works: true,
    });
    const result = await searchJournalsTool.handler(input, ctx);
    expect(result.journals).toHaveLength(2);
  });

  it('handles sparse journal record — no subjects, no counts', async () => {
    const ctx = createMockContext();
    mockSearchJournals.mockResolvedValue([{ title: 'Sparse Journal', 'ISSN-L': '1234-5678' }]);

    const input = searchJournalsTool.input.parse({ query: 'Sparse' });
    const result = await searchJournalsTool.handler(input, ctx);

    expect(result.journals[0]?.title).toBe('Sparse Journal');
    expect(result.journals[0]?.subjects).toBeUndefined();
    expect(result.journals[0]?.totalDois).toBeUndefined();
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

  it('formats recentWorks section when present', () => {
    const result = {
      journals: [{ title: 'Nature', issnL: '0028-0836' }],
      recentWorks: [
        {
          doi: '10.1038/s41586-024-0001-1',
          title: 'Groundbreaking Discovery',
          type: 'journal-article',
          published: { year: 2024, month: 1 },
          isReferencedByCount: 55,
        },
      ],
    };
    const blocks = searchJournalsTool.format!(result);
    const text = blocks[0]?.text ?? '';
    expect(text).toContain('Groundbreaking Discovery');
    expect(text).toContain('10.1038/s41586-024-0001-1');
    expect(text).toContain('2024');
    expect(text).toContain('55');
  });

  it('accepts rows between 1 and 100', () => {
    expect(() => searchJournalsTool.input.parse({ query: 'test', rows: 1 })).not.toThrow();
    expect(() => searchJournalsTool.input.parse({ query: 'test', rows: 100 })).not.toThrow();
  });

  it('rejects rows outside 1–100 range', () => {
    expect(() => searchJournalsTool.input.parse({ query: 'test', rows: 0 })).toThrow();
    expect(() => searchJournalsTool.input.parse({ query: 'test', rows: 101 })).toThrow();
  });

  it('accepts valid ISSN formats — with and without hyphen, uppercase X check digit', () => {
    expect(() => searchJournalsTool.input.parse({ issn: '0028-0836' })).not.toThrow();
    expect(() => searchJournalsTool.input.parse({ issn: '00280836' })).not.toThrow();
    expect(() => searchJournalsTool.input.parse({ issn: '1476-4687' })).not.toThrow();
    expect(() => searchJournalsTool.input.parse({ issn: '0028-083X' })).not.toThrow();
  });

  it('rejects malformed ISSN values before any upstream call', () => {
    expect(() => searchJournalsTool.input.parse({ issn: 'not-an-issn' })).toThrow();
    expect(() => searchJournalsTool.input.parse({ issn: '123-456' })).toThrow();
    expect(() => searchJournalsTool.input.parse({ issn: '12345-678' })).toThrow();
    expect(() => searchJournalsTool.input.parse({ issn: '0028-08361' })).toThrow();
  });
});
