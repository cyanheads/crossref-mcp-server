/**
 * @fileoverview Tests for the crossref_search_journals tool.
 * @module tests/tools/search-journals.tool.test
 */

import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
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

/** Journal-list envelope shape returned by CrossrefService.searchJournals. */
function journalList(items: unknown[], totalResults = items.length) {
  return { totalResults, items };
}

/**
 * The schema clients actually receive: domain output merged with enrichment. Parsing through
 * it proves a field reaches the wire — an undeclared key is stripped here, silently.
 */
const wireSchema = searchJournalsTool.output.extend(searchJournalsTool.enrichment);

describe('searchJournalsTool', () => {
  it('returns journal records for a title query', async () => {
    const ctx = createMockContext();
    mockSearchJournals.mockResolvedValue(journalList([RAW_JOURNAL]));

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
    mockSearchJournals.mockResolvedValue(journalList([RAW_JOURNAL]));
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
    mockSearchJournals.mockResolvedValue(journalList([]));

    const input = searchJournalsTool.input.parse({ query: 'ZZZUnknownJournal' });
    const result = await searchJournalsTool.handler(input, ctx);

    expect(result.journals).toHaveLength(0);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.journalCount).toBe(0);
    expect(enrichment.notice).toBeDefined();
  });

  it('performs direct ISSN lookup when issn param is provided', async () => {
    const ctx = createMockContext();
    mockSearchJournals.mockResolvedValue(journalList([RAW_JOURNAL]));

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
    mockSearchJournals.mockResolvedValue(journalList([RAW_JOURNAL, secondJournal]));

    const input = searchJournalsTool.input.parse({ query: 'Nature', include_works: true });
    await expect(searchJournalsTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'ambiguous_journal' },
    });
  });

  it('does not throw ambiguous_journal when issn is provided with include_works=true', async () => {
    const ctx = createMockContext({ errors: searchJournalsTool.errors });
    const secondJournal = { ...RAW_JOURNAL, title: 'Nature Communications', 'ISSN-L': '2041-1723' };
    mockSearchJournals.mockResolvedValue(journalList([RAW_JOURNAL, secondJournal]));
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
    mockSearchJournals.mockResolvedValue(
      journalList([{ title: 'Sparse Journal', 'ISSN-L': '1234-5678' }]),
    );

    const input = searchJournalsTool.input.parse({ query: 'Sparse' });
    const result = await searchJournalsTool.handler(input, ctx);

    expect(result.journals[0]?.title).toBe('Sparse Journal');
    expect(result.journals[0]?.subjects).toBeUndefined();
    expect(result.journals[0]?.totalDois).toBeUndefined();
  });

  /**
   * Crossref sends `"ISSN-L": null` — not an absent key — on a journal with no linking ISSN,
   * so an `!== undefined` projection guard would put a null into a string-typed output field.
   */
  it('omits issnL when the record carries a null ISSN-L', async () => {
    const ctx = createMockContext();
    mockSearchJournals.mockResolvedValue(
      journalList([
        {
          title: 'NatureJobs',
          'ISSN-L': null,
          ISSN: [],
          publisher: 'Springer Science and Business Media LLC',
          counts: { 'total-dois': 0 },
        },
      ]),
    );

    const input = searchJournalsTool.input.parse({ query: 'NatureJobs' });
    const result = await searchJournalsTool.handler(input, ctx);

    expect(result.journals[0]).not.toHaveProperty('issnL');
    expect(
      searchJournalsTool.output.extend(searchJournalsTool.enrichment).parse({
        ...result,
        ...getEnrichment(ctx),
      }).journals[0]?.issnL,
    ).toBeUndefined();
  });

  describe('include_works on a journal with no registered ISSN', () => {
    const ISSN_LESS = {
      title: 'NatureJobs',
      'ISSN-L': null,
      ISSN: [],
      publisher: 'Springer Science and Business Media LLC',
      counts: { 'total-dois': 0 },
    };

    it('skips the works lookup and says so instead of returning silently', async () => {
      const ctx = createMockContext();
      mockSearchJournals.mockResolvedValue(journalList([ISSN_LESS], 1));

      const input = searchJournalsTool.input.parse({
        query: 'NatureJobs',
        include_works: true,
        rows: 5,
      });
      const result = await searchJournalsTool.handler(input, ctx);

      expect(mockGetJournalWorks).not.toHaveBeenCalled();
      expect(result.recentWorks).toBeUndefined();

      const notice = getEnrichment(ctx).notice ?? '';
      expect(notice).toContain('NatureJobs');
      expect(notice).toContain('no ISSN registered');
      // The point of the notice: "skipped" must not read as "the journal has no works".
      expect(notice).toContain('not a statement that the journal has none');
      expect(getEnrichment(ctx).worksTotal).toBeUndefined();
    });

    it('carries the notice into content[] through the full contract', async () => {
      mockSearchJournals.mockResolvedValue(journalList([ISSN_LESS], 1));

      const result = await runToolContract(searchJournalsTool, {
        query: 'NatureJobs',
        include_works: true,
      });

      expect(result.isError).toBeFalsy();
      const text = result.content.map((b) => ('text' in b ? b.text : '')).join('\n');
      expect(text).toContain('no ISSN registered');
    });
  });

  it('strips JATS markup from recentWorks titles and decodes journal-record names', async () => {
    const ctx = createMockContext();
    mockSearchJournals.mockResolvedValue(
      journalList([
        {
          ...RAW_JOURNAL,
          title: 'Ecology &amp; Evolution',
          publisher: 'Wiley &amp; Sons',
          subjects: [{ name: 'Ecology, Evolution, Behavior &amp; Systematics' }],
        },
      ]),
    );
    mockGetJournalWorks.mockResolvedValue({
      totalResults: 1,
      itemsPerPage: 10,
      items: [
        { DOI: '10.1002/ece3.1', type: 'journal-article', title: ['<i>In vivo</i>\n  biosensing'] },
      ],
    });

    const input = searchJournalsTool.input.parse({ issn: '0028-0836', include_works: true });
    const result = await searchJournalsTool.handler(input, ctx);

    expect(result.journals[0]?.title).toBe('Ecology & Evolution');
    expect(result.journals[0]?.publisher).toBe('Wiley & Sons');
    expect(result.journals[0]?.subjects?.[0]?.name).toBe(
      'Ecology, Evolution, Behavior & Systematics',
    );
    expect(result.recentWorks?.[0]?.title).toBe('In vivo biosensing');
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

  describe('paging', () => {
    it('threads offset to the journal search and hands back the next page offset', async () => {
      const ctx = createMockContext();
      mockSearchJournals.mockResolvedValue(journalList([RAW_JOURNAL, RAW_JOURNAL], 223));

      const input = searchJournalsTool.input.parse({ query: 'Nature', rows: 2, offset: 2 });
      const result = await searchJournalsTool.handler(input, ctx);

      expect(mockSearchJournals).toHaveBeenCalledWith(
        expect.objectContaining({ offset: 2, rows: 2 }),
        expect.anything(),
      );
      const wire = wireSchema.parse({ ...result, ...getEnrichment(ctx) });
      expect(wire.journalsTotal).toBe(223);
      expect(wire.journalCount).toBe(2);
      expect(wire.nextOffset).toBe(4);
    });

    it('omits nextOffset on the last page of journals', async () => {
      const ctx = createMockContext();
      mockSearchJournals.mockResolvedValue(journalList([RAW_JOURNAL, RAW_JOURNAL], 4));

      const input = searchJournalsTool.input.parse({ query: 'Nature', rows: 2, offset: 2 });
      const result = await searchJournalsTool.handler(input, ctx);

      const wire = wireSchema.parse({ ...result, ...getEnrichment(ctx) });
      expect(wire.journalsTotal).toBe(4);
      expect(wire.nextOffset).toBeUndefined();
    });

    it('returns a well-formed empty page past the end of the journal list', async () => {
      const ctx = createMockContext();
      mockSearchJournals.mockResolvedValue(journalList([], 223));

      const input = searchJournalsTool.input.parse({ query: 'Nature', rows: 2, offset: 500 });
      const result = await searchJournalsTool.handler(input, ctx);

      expect(result.journals).toHaveLength(0);
      const wire = wireSchema.parse({ ...result, ...getEnrichment(ctx) });
      expect(wire.journalsTotal).toBe(223);
      expect(wire.nextOffset).toBeUndefined();
      // The query matched — the offset ran off the end. Saying "no journals matched" here
      // would send the caller off rewriting a query that was fine.
      expect(wire.notice).toContain('past the end');
      expect(wire.notice).toContain('223');
      expect(wire.notice).not.toContain('No journals matched');
    });

    it('keeps the no-match notice distinct from the past-the-end notice', async () => {
      const ctx = createMockContext();
      mockSearchJournals.mockResolvedValue(journalList([], 0));

      const input = searchJournalsTool.input.parse({ query: 'ZZZUnknownJournal', offset: 0 });
      const result = await searchJournalsTool.handler(input, ctx);

      const wire = wireSchema.parse({ ...result, ...getEnrichment(ctx) });
      expect(wire.notice).toContain('No journals matched');
      expect(wire.notice).not.toContain('past the end');
    });

    it('threads works_offset to the works sub-resource and hands back nextWorksOffset', async () => {
      const ctx = createMockContext();
      mockSearchJournals.mockResolvedValue(journalList([RAW_JOURNAL], 1));
      mockGetJournalWorks.mockResolvedValue({
        totalResults: 446507,
        itemsPerPage: 2,
        items: [{ DOI: '10.1038/a' }, { DOI: '10.1038/b' }],
      });

      const input = searchJournalsTool.input.parse({
        query: 'Nature',
        include_works: true,
        rows: 2,
        works_offset: 20,
      });
      const result = await searchJournalsTool.handler(input, ctx);

      expect(mockGetJournalWorks).toHaveBeenCalledWith(
        '0028-0836',
        { rows: 2, offset: 20 },
        expect.anything(),
      );
      const wire = wireSchema.parse({ ...result, ...getEnrichment(ctx) });
      expect(wire.worksTotal).toBe(446507);
      expect(wire.nextWorksOffset).toBe(22);
    });

    it('omits nextWorksOffset at the 10000 ceiling but says why on the page', async () => {
      const ctx = createMockContext();
      mockSearchJournals.mockResolvedValue(journalList([RAW_JOURNAL], 1));
      mockGetJournalWorks.mockResolvedValue({
        totalResults: 446507,
        itemsPerPage: 10,
        items: Array.from({ length: 10 }, (_, i) => ({ DOI: `10.1038/x${i}` })),
      });

      const input = searchJournalsTool.input.parse({
        query: 'Nature',
        include_works: true,
        rows: 10,
        works_offset: 9990,
      });
      const result = await searchJournalsTool.handler(input, ctx);

      const wire = wireSchema.parse({ ...result, ...getEnrichment(ctx) });
      expect(wire.worksTotal).toBe(446507);
      // Records remain, but offset 10000 + rows 10 would be rejected upstream.
      expect(wire.nextWorksOffset).toBeUndefined();
      // A missing offset alone is indistinguishable from the end of the list, so the page names
      // the ceiling, the true total, and the input that reaches the rest.
      expect(wire.notice).toContain('10000');
      expect(wire.notice).toContain('446507');
      expect(wire.notice).toContain('works_cursor');
      // The cursor walk restarts at the newest work rather than resuming from this offset,
      // so a caller who follows the notice must not expect to pick up where it left off.
      expect(wire.notice).toMatch(/restart/i);
      expect(wire.nextWorksCursor).toBeUndefined();
    });

    it('leaves the notice off when the works list simply ended', async () => {
      const ctx = createMockContext();
      mockSearchJournals.mockResolvedValue(journalList([RAW_JOURNAL], 1));
      mockGetJournalWorks.mockResolvedValue({
        totalResults: 2,
        itemsPerPage: 10,
        items: [{ DOI: '10.1038/a' }, { DOI: '10.1038/b' }],
      });

      const input = searchJournalsTool.input.parse({
        query: 'Nature',
        include_works: true,
        rows: 10,
      });
      const result = await searchJournalsTool.handler(input, ctx);

      const wire = wireSchema.parse({ ...result, ...getEnrichment(ctx) });
      expect(wire.nextWorksOffset).toBeUndefined();
      expect(wire.notice).toBeUndefined();
    });

    it('starts a cursor walk of the works list and hands back nextWorksCursor', async () => {
      const ctx = createMockContext({ errors: searchJournalsTool.errors });
      mockSearchJournals.mockResolvedValue(journalList([RAW_JOURNAL], 1));
      mockGetJournalWorks.mockResolvedValue({
        totalResults: 446507,
        itemsPerPage: 2,
        items: [{ DOI: '10.1038/a' }, { DOI: '10.1038/b' }],
        nextCursor: 'AoJw8P3T3fACPBhodHRwOi8vZHguZG9pLm9yZy8xMC4xMDM4L2E=',
      });

      const input = searchJournalsTool.input.parse({
        issn: '0028-0836',
        include_works: true,
        rows: 2,
        works_cursor: '*',
      });
      const result = await searchJournalsTool.handler(input, ctx);

      // No offset on the call: the two page selectors are alternatives upstream.
      expect(mockGetJournalWorks).toHaveBeenCalledWith(
        '0028-0836',
        { rows: 2, cursor: '*' },
        expect.anything(),
      );
      const wire = wireSchema.parse({ ...result, ...getEnrichment(ctx) });
      expect(wire.worksTotal).toBe(446507);
      expect(wire.nextWorksCursor).toBe('AoJw8P3T3fACPBhodHRwOi8vZHguZG9pLm9yZy8xMC4xMDM4L2E=');
      // An offset is not a valid continuation of a cursor walk, so none is offered.
      expect(wire.nextWorksOffset).toBeUndefined();
      expect(wire.notice).toBeUndefined();
    });

    it('reads a blank works_cursor as absent and stays on offset paging', async () => {
      const ctx = createMockContext({ errors: searchJournalsTool.errors });
      mockSearchJournals.mockResolvedValue(journalList([RAW_JOURNAL], 1));
      mockGetJournalWorks.mockResolvedValue({
        totalResults: 446507,
        itemsPerPage: 2,
        items: [{ DOI: '10.1038/a' }, { DOI: '10.1038/b' }],
      });

      // A form-based client sends "" for an optional field nobody filled in.
      const input = searchJournalsTool.input.parse({
        issn: '0028-0836',
        include_works: true,
        rows: 2,
        works_cursor: '',
      });
      const result = await searchJournalsTool.handler(input, ctx);

      // Taking "" as a cursor sends neither selector upstream, so Crossref answers page one
      // with no next-cursor, and the cursor branch withholds nextWorksOffset as well — a
      // 446507-work list truncated to its first page with no field saying so.
      expect(mockGetJournalWorks).toHaveBeenCalledWith(
        '0028-0836',
        { rows: 2, offset: 0 },
        expect.anything(),
      );
      const wire = wireSchema.parse({ ...result, ...getEnrichment(ctx) });
      expect(wire.nextWorksOffset).toBe(2);
      expect(wire.nextWorksCursor).toBeUndefined();
    });

    it('ignores works_cursor paired with works_offset when include_works is false', async () => {
      const ctx = createMockContext({ errors: searchJournalsTool.errors });
      mockSearchJournals.mockResolvedValue(journalList([RAW_JOURNAL], 1));

      // Without a works list neither input selects anything, so the pair is not a conflict.
      const input = searchJournalsTool.input.parse({
        issn: '0028-0836',
        include_works: false,
        works_cursor: '*',
        works_offset: 20,
      });
      const result = await searchJournalsTool.handler(input, ctx);

      expect(result.recentWorks).toBeUndefined();
      expect(mockGetJournalWorks).not.toHaveBeenCalled();
    });

    it('continues a cursor walk from a returned token', async () => {
      const ctx = createMockContext({ errors: searchJournalsTool.errors });
      mockSearchJournals.mockResolvedValue(journalList([RAW_JOURNAL], 1));
      mockGetJournalWorks.mockResolvedValue({
        totalResults: 446507,
        itemsPerPage: 2,
        items: [{ DOI: '10.1038/c' }, { DOI: '10.1038/d' }],
        nextCursor: 'page-three-token',
      });

      const input = searchJournalsTool.input.parse({
        issn: '0028-0836',
        include_works: true,
        rows: 2,
        works_cursor: 'page-two-token',
      });
      const result = await searchJournalsTool.handler(input, ctx);

      expect(mockGetJournalWorks).toHaveBeenCalledWith(
        '0028-0836',
        { rows: 2, cursor: 'page-two-token' },
        expect.anything(),
      );
      const wire = wireSchema.parse({ ...result, ...getEnrichment(ctx) });
      expect(wire.nextWorksCursor).toBe('page-three-token');
      expect(result.recentWorks?.map((w) => w.doi)).toEqual(['10.1038/c', '10.1038/d']);
    });

    it('withholds nextWorksCursor once the walk runs off the end of the works list', async () => {
      const ctx = createMockContext({ errors: searchJournalsTool.errors });
      mockSearchJournals.mockResolvedValue(journalList([RAW_JOURNAL], 1));
      // Crossref keeps minting a token past the end of a list — the empty page is the signal.
      mockGetJournalWorks.mockResolvedValue({
        totalResults: 446507,
        itemsPerPage: 2,
        items: [],
        nextCursor: 'a-token-that-yields-nothing',
      });

      const input = searchJournalsTool.input.parse({
        issn: '0028-0836',
        include_works: true,
        rows: 2,
        works_cursor: 'last-token',
      });
      const result = await searchJournalsTool.handler(input, ctx);

      const wire = wireSchema.parse({ ...result, ...getEnrichment(ctx) });
      // Absence of a continuation field means "exhausted" on the offset path; handing back a
      // token here would break that on the cursor path and loop a caller forever.
      expect(wire.nextWorksCursor).toBeUndefined();
      expect(result.recentWorks).toHaveLength(0);
    });

    it('throws works_cursor_offset_conflict when a cursor is paired with a spendable offset', async () => {
      const ctx = createMockContext({ errors: searchJournalsTool.errors });

      const input = searchJournalsTool.input.parse({
        issn: '0028-0836',
        include_works: true,
        works_cursor: '*',
        works_offset: 20,
      });
      await expect(searchJournalsTool.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'works_cursor_offset_conflict', worksOffset: 20 },
      });
      expect(mockSearchJournals).not.toHaveBeenCalled();
    });

    it('accepts a cursor alongside the works_offset schema default', async () => {
      const ctx = createMockContext({ errors: searchJournalsTool.errors });
      mockSearchJournals.mockResolvedValue(journalList([RAW_JOURNAL], 1));
      mockGetJournalWorks.mockResolvedValue({ totalResults: 5, itemsPerPage: 10, items: [] });

      // works_offset defaults to 0, so every cursor call carries one. Zero is the start of the
      // list and is never sent upstream — rejecting it would make the cursor input unusable.
      const input = searchJournalsTool.input.parse({
        issn: '0028-0836',
        include_works: true,
        works_cursor: '*',
      });
      expect(input.works_offset).toBe(0);
      await expect(searchJournalsTool.handler(input, ctx)).resolves.toBeDefined();
    });

    it('carries nextWorksCursor onto both structuredContent and content[]', async () => {
      mockSearchJournals.mockResolvedValue(journalList([RAW_JOURNAL], 1));
      mockGetJournalWorks.mockResolvedValue({
        totalResults: 446507,
        itemsPerPage: 1,
        items: [{ DOI: '10.1038/a' }],
        nextCursor: 'wire-token',
      });

      const result = await runToolContract(searchJournalsTool, {
        issn: '0028-0836',
        include_works: true,
        rows: 1,
        works_cursor: '*',
      });

      expect(result.structuredContent).toMatchObject({ nextWorksCursor: 'wire-token' });
      const text = result.content.map((b) => ('text' in b ? b.text : '')).join('\n');
      expect(text).toContain('nextWorksCursor');
      expect(text).toContain('wire-token');
    });

    it('discloses the 100000 ceiling on the journal list page', async () => {
      const ctx = createMockContext();
      mockSearchJournals.mockResolvedValue(
        journalList(
          Array.from({ length: 10 }, () => RAW_JOURNAL),
          169_103,
        ),
      );

      const input = searchJournalsTool.input.parse({ query: 'a', rows: 10, offset: 99_990 });
      const result = await searchJournalsTool.handler(input, ctx);

      const wire = wireSchema.parse({ ...result, ...getEnrichment(ctx) });
      expect(wire.nextOffset).toBeUndefined();
      expect(wire.notice).toContain('100000');
      expect(wire.notice).toContain('169103');
    });

    it('throws offset_too_large before any upstream call when offset + rows passes 100000', async () => {
      const ctx = createMockContext({ errors: searchJournalsTool.errors });

      const input = searchJournalsTool.input.parse({ query: 'Nature', rows: 10, offset: 99_995 });
      await expect(searchJournalsTool.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'offset_too_large', cap: 100_000 },
      });
      expect(mockSearchJournals).not.toHaveBeenCalled();
    });

    it('accepts the largest offset the name-search route allows', async () => {
      const ctx = createMockContext({ errors: searchJournalsTool.errors });
      mockSearchJournals.mockResolvedValue(journalList([], 223));

      const input = searchJournalsTool.input.parse({ query: 'Nature', rows: 10, offset: 99_990 });
      await expect(searchJournalsTool.handler(input, ctx)).resolves.toBeDefined();
    });

    it('throws works_offset_too_large at the ten-times-lower works ceiling', async () => {
      const ctx = createMockContext({ errors: searchJournalsTool.errors });

      const input = searchJournalsTool.input.parse({
        query: 'Nature',
        include_works: true,
        rows: 10,
        works_offset: 9_995,
      });
      await expect(searchJournalsTool.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'works_offset_too_large', cap: 10_000 },
      });
      expect(mockSearchJournals).not.toHaveBeenCalled();
    });

    it('leaves works_offset unchecked when include_works is false', async () => {
      const ctx = createMockContext({ errors: searchJournalsTool.errors });
      mockSearchJournals.mockResolvedValue(journalList([RAW_JOURNAL], 1));

      const input = searchJournalsTool.input.parse({
        query: 'Nature',
        rows: 10,
        works_offset: 50_000,
      });
      await expect(searchJournalsTool.handler(input, ctx)).resolves.toBeDefined();
    });

    it('carries paging metadata on both structuredContent and content[]', async () => {
      mockSearchJournals.mockResolvedValue(journalList([RAW_JOURNAL, RAW_JOURNAL], 223));
      mockGetJournalWorks.mockReset();

      const result = await runToolContract(searchJournalsTool, {
        query: 'Nature',
        rows: 2,
        offset: 2,
      });

      expect(result.structuredContent).toMatchObject({
        journalsTotal: 223,
        journalCount: 2,
        nextOffset: 4,
      });
      const text = result.content.map((b) => ('text' in b ? b.text : '')).join('\n');
      expect(text).toContain('223');
      expect(text).toContain('nextOffset');
      expect(text).toContain('4');
    });
  });

  describe('ambiguity recovery', () => {
    const THIRD_JOURNAL = { title: 'Nature Methods', 'ISSN-L': '1548-7091' };

    it('names each listed journal and its ISSN in the error message', async () => {
      const ctx = createMockContext({ errors: searchJournalsTool.errors });
      const second = { ...RAW_JOURNAL, title: 'Nature Communications', 'ISSN-L': '2041-1723' };
      mockSearchJournals.mockResolvedValue(journalList([RAW_JOURNAL, second, THIRD_JOURNAL], 3));

      const input = searchJournalsTool.input.parse({ query: 'Nature', include_works: true });
      const err = await searchJournalsTool.handler(input, ctx).catch((e: unknown) => e);

      const message = (err as { message: string }).message;
      expect(message).toContain('0028-0836');
      expect(message).toContain('2041-1723');
      // The third match is named too — the message is not capped at two examples.
      expect(message).toContain('1548-7091');
      expect(message).toContain('Nature Methods');
      expect(message).toContain('matched 3 journals');
    });

    it('reports the upstream match count, not the page length, when the page is partial', async () => {
      const ctx = createMockContext({ errors: searchJournalsTool.errors });
      const second = { ...RAW_JOURNAL, title: 'Nature Communications', 'ISSN-L': '2041-1723' };
      mockSearchJournals.mockResolvedValue(journalList([RAW_JOURNAL, second], 223));

      const input = searchJournalsTool.input.parse({
        query: 'Nature',
        include_works: true,
        rows: 2,
      });
      const err = await searchJournalsTool.handler(input, ctx).catch((e: unknown) => e);

      const message = (err as { message: string }).message;
      // 223 journals matched; two are listed. Saying "matched 2" would hide both the size of the
      // choice and the chance the journal the caller wants is not on this page.
      expect(message).toContain('matched 223 journals');
      expect(message).toContain('this page lists 2');
      expect(message).not.toContain('matched 2 journals');
      expect(message).toContain('narrow the query');
      expect((err as { data: { matchedTotal: number } }).data.matchedTotal).toBe(223);
    });

    it('throws when a single-record page is one of many matches', async () => {
      const ctx = createMockContext({ errors: searchJournalsTool.errors });
      // rows=1 returns one journal out of 223. The page is unambiguous; the caller's choice is
      // not — nothing selected this journal, so resolving its works is the silent pick again.
      mockSearchJournals.mockResolvedValue(journalList([RAW_JOURNAL], 223));

      const input = searchJournalsTool.input.parse({
        query: 'Nature',
        include_works: true,
        rows: 1,
      });
      await expect(searchJournalsTool.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'ambiguous_journal', matchedTotal: 223 },
      });
      expect(mockGetJournalWorks).not.toHaveBeenCalled();
    });

    it('falls back to the first ISSN variant when a candidate has no ISSN-L', async () => {
      const ctx = createMockContext({ errors: searchJournalsTool.errors });
      mockSearchJournals.mockResolvedValue(
        journalList([RAW_JOURNAL, { title: 'Naturen', ISSN: ['0028-0887', '1504-3118'] }], 2),
      );

      const input = searchJournalsTool.input.parse({ query: 'Nature', include_works: true });
      const err = await searchJournalsTool.handler(input, ctx).catch((e: unknown) => e);

      // The works call resolves the target the same way, so a candidate reachable by ISSN must
      // not be advertised as having none.
      expect((err as { message: string }).message).toContain('0028-0887');
      expect((err as { data: { candidates: unknown[] } }).data.candidates).toContainEqual({
        title: 'Naturen',
        issn: '0028-0887',
      });
    });

    it('exposes the candidate ISSNs in the error data for structured clients', async () => {
      const ctx = createMockContext({ errors: searchJournalsTool.errors });
      const second = { ...RAW_JOURNAL, title: 'Nature Communications', 'ISSN-L': '2041-1723' };
      mockSearchJournals.mockResolvedValue(journalList([RAW_JOURNAL, second], 2));

      const input = searchJournalsTool.input.parse({ query: 'Nature', include_works: true });
      await expect(searchJournalsTool.handler(input, ctx)).rejects.toMatchObject({
        data: {
          reason: 'ambiguous_journal',
          candidates: [
            { title: 'Nature', issn: '0028-0836' },
            { title: 'Nature Communications', issn: '2041-1723' },
          ],
        },
      });
    });

    it('marks a candidate with no registered ISSN rather than dropping it', async () => {
      const ctx = createMockContext({ errors: searchJournalsTool.errors });
      mockSearchJournals.mockResolvedValue(
        journalList([RAW_JOURNAL, { title: 'Journal With No ISSN' }], 2),
      );

      const input = searchJournalsTool.input.parse({ query: 'Nature', include_works: true });
      const err = await searchJournalsTool.handler(input, ctx).catch((e: unknown) => e);

      expect((err as { message: string }).message).toContain('no ISSN registered');
      expect((err as { data: { candidates: unknown[] } }).data.candidates).toHaveLength(2);
    });

    it('surfaces the ISSNs on both error surfaces through the full contract', async () => {
      const second = { ...RAW_JOURNAL, title: 'Nature Communications', 'ISSN-L': '2041-1723' };
      mockSearchJournals.mockResolvedValue(journalList([RAW_JOURNAL, second], 2));

      const result = await runToolContract(searchJournalsTool, {
        query: 'Nature',
        include_works: true,
      });

      expect(result.isError).toBe(true);
      const text = result.content.map((b) => ('text' in b ? b.text : '')).join('\n');
      expect(text).toContain('0028-0836');
      expect(text).toContain('2041-1723');
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason: 'ambiguous_journal' } },
      });
    });
  });
});
