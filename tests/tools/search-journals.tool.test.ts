/**
 * @fileoverview Tests for the crossref_search_journals tool.
 * @module tests/tools/search-journals.tool.test
 */

import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { type Node, Parser } from 'commonmark';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { searchJournalsTool } from '@/mcp-server/tools/definitions/search-journals.tool.js';
import { blockText, contentText, renderedText } from '../helpers/content.js';

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
  } as unknown as ReturnType<typeof getCrossrefService>);
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
const wireSchema = searchJournalsTool.output.extend(searchJournalsTool.enrichment!);

describe('searchJournalsTool', () => {
  it('returns journal records for a title query', async () => {
    const ctx = createMockContext({ errors: searchJournalsTool.errors });
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
    const ctx = createMockContext({ errors: searchJournalsTool.errors });
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
    const ctx = createMockContext({ errors: searchJournalsTool.errors });
    mockSearchJournals.mockResolvedValue(journalList([]));

    const input = searchJournalsTool.input.parse({ query: 'ZZZUnknownJournal' });
    const result = await searchJournalsTool.handler(input, ctx);

    expect(result.journals).toHaveLength(0);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.journalCount).toBe(0);
    expect(enrichment.notice).toBeDefined();
  });

  it('performs direct ISSN lookup when issn param is provided', async () => {
    const ctx = createMockContext({ errors: searchJournalsTool.errors });
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
    const ctx = createMockContext({ errors: searchJournalsTool.errors });
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
   * Current Crossref journal records omit the `ISSN-L` key, but the raw type admits an explicit
   * `null`, and an `!== undefined` projection guard would put that null into a string-typed field.
   */
  it('omits issnL when the record carries a null ISSN-L', async () => {
    const ctx = createMockContext({ errors: searchJournalsTool.errors });
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
      searchJournalsTool.output.extend(searchJournalsTool.enrichment!).parse({
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
      const ctx = createMockContext({ errors: searchJournalsTool.errors });
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
      expect(notice).toContain('no well-formed ISSN registered');
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
      const text = result.content.map(blockText).join('\n');
      expect(text).toContain('no well-formed ISSN registered');
    });

    /**
     * An ISSN entry Crossref cannot read — no run of seven digits and a check character — gives
     * the works list nothing to filter on, so a record listing only such entries has no works
     * list to address, the same as one listing none.
     */
    it('skips the works lookup when no ISSN the record lists is one Crossref can read', async () => {
      mockSearchJournals.mockResolvedValue(
        journalList([{ ...ISSN_LESS, ISSN: ['0028-083', 'abcd-efgh'] }], 1),
      );
      mockGetJournalWorks.mockRejectedValue(
        new Error('getJournalWorks was given no ISSN Crossref can read'),
      );

      const result = await runToolContract(searchJournalsTool, {
        query: 'NatureJobs',
        include_works: true,
      });

      expect(result.isError).toBeFalsy();
      expect(mockGetJournalWorks).not.toHaveBeenCalled();
      const structured = result.structuredContent as { recentWorks?: unknown; notice?: string };
      expect(structured.recentWorks).toBeUndefined();
      expect(structured.notice).toContain('include_works was requested but skipped');
      // The record lists ISSN entries, so the notice must not claim it lists none.
      expect(structured.notice).toContain('has no well-formed ISSN registered in Crossref');
      expect(result.content.map(blockText).join('\n')).toContain('no well-formed ISSN registered');
    });

    it('looks the works up when one ISSN the record lists is readable', async () => {
      mockSearchJournals.mockResolvedValue(
        journalList([{ ...ISSN_LESS, ISSN: ['0028-083', '1476-4687'] }], 1),
      );
      mockGetJournalWorks.mockResolvedValue({ totalResults: 1, itemsPerPage: 10, items: [] });

      const result = await runToolContract(searchJournalsTool, {
        query: 'NatureJobs',
        include_works: true,
      });

      expect(result.isError).toBeFalsy();
      expect(mockGetJournalWorks).toHaveBeenCalledTimes(1);
      expect(result.structuredContent).toMatchObject({ worksTotal: 1, recentWorks: [] });
    });
  });

  /**
   * The works list covers every ISSN the matched record lists, whichever one the caller passed:
   * reading one of them left BMJ's list at 5,514 of 456,306 works, its newest from 1988.
   */
  describe('include_works on a journal with several ISSNs', () => {
    /** The live /journals/0959-8138 record's ISSNs, in record order. */
    const BMJ = {
      title: 'BMJ',
      ISSN: [
        '0267-0623',
        '1468-5833',
        '0959-535X',
        '0959-8138',
        '0959-8154',
        '1756-1833',
        '1759-2151',
      ],
      publisher: 'BMJ',
      counts: { 'total-dois': 456283 },
    };

    it('reads the works of every record ISSN on an issn lookup by any one of them', async () => {
      mockSearchJournals.mockResolvedValue(journalList([BMJ]));
      mockGetJournalWorks.mockResolvedValue({
        totalResults: 456306,
        itemsPerPage: 1,
        items: [{ DOI: '10.1136/bmj.r2201', title: ['A 2026 work'] }],
      });

      const result = await runToolContract(searchJournalsTool, {
        issn: '0959-8138',
        include_works: true,
        rows: 1,
      });

      expect(result.isError).toBeFalsy();
      expect(mockGetJournalWorks).toHaveBeenCalledWith(
        BMJ.ISSN,
        { rows: 1, offset: 0 },
        expect.anything(),
      );
      expect(result.structuredContent).toMatchObject({
        worksTotal: 456306,
        recentWorks: [{ doi: '10.1136/bmj.r2201' }],
      });
      expect(contentText(result.content)).toContain('456306');
    });

    it('reads the works of every record ISSN on a single-match title query', async () => {
      const ctx = createMockContext({ errors: searchJournalsTool.errors });
      mockSearchJournals.mockResolvedValue(journalList([BMJ], 1));
      mockGetJournalWorks.mockResolvedValue({ totalResults: 456306, itemsPerPage: 10, items: [] });

      const input = searchJournalsTool.input.parse({
        query: 'BMJ',
        include_works: true,
        works_cursor: '*',
      });
      await searchJournalsTool.handler(input, ctx);

      expect(mockGetJournalWorks).toHaveBeenCalledWith(
        BMJ.ISSN,
        { rows: 10, cursor: '*' },
        expect.anything(),
      );
      expect(getEnrichment(ctx).worksTotal).toBe(456306);
    });

    it('describes worksTotal as covering every ISSN of the journal', () => {
      const worksTotal = searchJournalsTool.enrichment?.worksTotal;
      expect(worksTotal?.description).toContain("any of the journal's ISSNs");
    });
  });

  it('strips JATS markup from recentWorks titles and decodes journal-record names', async () => {
    const ctx = createMockContext({ errors: searchJournalsTool.errors });
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
    const text = blockText(blocks[0]);
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
    const text = blockText(blocks[0]);
    expect(text).toContain('Groundbreaking Discovery');
    expect(text).toContain('10.1038/s41586-024-0001-1');
    expect(text).toContain('2024');
    expect(text).toContain('55');
  });

  it('accepts rows between 1 and 500', () => {
    expect(() => searchJournalsTool.input.parse({ query: 'test', rows: 1 })).not.toThrow();
    expect(() => searchJournalsTool.input.parse({ query: 'test', rows: 500 })).not.toThrow();
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
      const ctx = createMockContext({ errors: searchJournalsTool.errors });
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
      const ctx = createMockContext({ errors: searchJournalsTool.errors });
      mockSearchJournals.mockResolvedValue(journalList([RAW_JOURNAL, RAW_JOURNAL], 4));

      const input = searchJournalsTool.input.parse({ query: 'Nature', rows: 2, offset: 2 });
      const result = await searchJournalsTool.handler(input, ctx);

      const wire = wireSchema.parse({ ...result, ...getEnrichment(ctx) });
      expect(wire.journalsTotal).toBe(4);
      expect(wire.nextOffset).toBeUndefined();
    });

    it('returns a well-formed empty page past the end of the journal list', async () => {
      const ctx = createMockContext({ errors: searchJournalsTool.errors });
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
      const ctx = createMockContext({ errors: searchJournalsTool.errors });
      mockSearchJournals.mockResolvedValue(journalList([], 0));

      const input = searchJournalsTool.input.parse({ query: 'ZZZUnknownJournal', offset: 0 });
      const result = await searchJournalsTool.handler(input, ctx);

      const wire = wireSchema.parse({ ...result, ...getEnrichment(ctx) });
      expect(wire.notice).toContain('No journals matched');
      expect(wire.notice).not.toContain('past the end');
    });

    it('threads works_offset to the journal works list and hands back nextWorksOffset', async () => {
      const ctx = createMockContext({ errors: searchJournalsTool.errors });
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
        RAW_JOURNAL.ISSN,
        { rows: 2, offset: 20 },
        expect.anything(),
      );
      const wire = wireSchema.parse({ ...result, ...getEnrichment(ctx) });
      expect(wire.worksTotal).toBe(446507);
      expect(wire.nextWorksOffset).toBe(22);
    });

    it('omits nextWorksOffset at the 10000 ceiling but says why on the page', async () => {
      const ctx = createMockContext({ errors: searchJournalsTool.errors });
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
      // The cursor walk restarts at the most recently registered work rather than resuming
      // from this offset, and runs in registration order rather than by publication date, so
      // a caller who follows the notice must not expect to pick up where it left off.
      expect(wire.notice).toMatch(/restart/i);
      expect(wire.notice).toContain('registration date, not publication date');
      expect(wire.nextWorksCursor).toBeUndefined();
    });

    it('leaves the notice off when the works list simply ended', async () => {
      const ctx = createMockContext({ errors: searchJournalsTool.errors });
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
        RAW_JOURNAL.ISSN,
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
        RAW_JOURNAL.ISSN,
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
        RAW_JOURNAL.ISSN,
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
      // Crossref has handed a token back on the empty page past the end — the empty page is the signal.
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
      const text = result.content.map(blockText).join('\n');
      expect(text).toContain('nextWorksCursor');
      expect(text).toContain('wire-token');
    });

    it('discloses the 100000 ceiling on the journal list page', async () => {
      const ctx = createMockContext({ errors: searchJournalsTool.errors });
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

    it('cuts a page that would pass 100000 to the rows that fit, and throws offset_too_large at it before any upstream call', async () => {
      const ctx = createMockContext({ errors: searchJournalsTool.errors });
      mockSearchJournals.mockResolvedValue(journalList(titled(5), 169_103));

      const input = searchJournalsTool.input.parse({ query: 'Nature', rows: 10, offset: 99_995 });
      await searchJournalsTool.handler(input, ctx);
      expect(mockSearchJournals).toHaveBeenCalledWith(
        expect.objectContaining({ offset: 99_995, rows: 5 }),
        expect.anything(),
      );

      mockSearchJournals.mockClear();
      const atCap = searchJournalsTool.input.parse({ query: 'Nature', rows: 10, offset: 100_000 });
      await expect(searchJournalsTool.handler(atCap, ctx)).rejects.toMatchObject({
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

    it('cuts and refuses works pages at the ten-times-lower works ceiling', async () => {
      const ctx = createMockContext({ errors: searchJournalsTool.errors });
      mockSearchJournals.mockResolvedValue(journalList([RAW_JOURNAL], 1));
      mockGetJournalWorks.mockResolvedValue({ totalResults: 446_507, items: [] });

      const input = searchJournalsTool.input.parse({
        query: 'Nature',
        include_works: true,
        rows: 10,
        works_offset: 9_995,
      });
      await searchJournalsTool.handler(input, ctx);
      expect(mockGetJournalWorks).toHaveBeenCalledWith(
        RAW_JOURNAL.ISSN,
        { rows: 5, offset: 9_995 },
        expect.anything(),
      );

      mockSearchJournals.mockClear();
      const atCap = searchJournalsTool.input.parse({
        query: 'Nature',
        include_works: true,
        rows: 10,
        works_offset: 10_000,
      });
      await expect(searchJournalsTool.handler(atCap, ctx)).rejects.toMatchObject({
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
      const text = result.content.map(blockText).join('\n');
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
      const err = await Promise.resolve(searchJournalsTool.handler(input, ctx)).catch(
        (e: unknown) => e,
      );

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
      const err = await Promise.resolve(searchJournalsTool.handler(input, ctx)).catch(
        (e: unknown) => e,
      );

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
      const err = await Promise.resolve(searchJournalsTool.handler(input, ctx)).catch(
        (e: unknown) => e,
      );

      // A candidate that lists an ISSN can be re-run with it, so it must not be advertised as
      // having none.
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
      const err = await Promise.resolve(searchJournalsTool.handler(input, ctx)).catch(
        (e: unknown) => e,
      );

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
      const text = result.content.map(blockText).join('\n');
      expect(text).toContain('0028-0836');
      expect(text).toContain('2041-1723');
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason: 'ambiguous_journal' } },
      });
    });
  });
});

describe('searchJournalsTool page-size clamp', () => {
  const CLAMP = 'rows 501 is above the per-call cap of 500, so 500 was applied.';
  const journals = (count: number) =>
    Array.from({ length: count }, (_, i) => ({ ...RAW_JOURNAL, title: `Journal ${i}` }));

  it('clamps rows above 500 on the journal list, continuing nextOffset after the page returned', async () => {
    mockSearchJournals.mockResolvedValue(journalList(journals(500), 5000));

    const result = await runToolContract(searchJournalsTool, {
      query: 'Journal',
      rows: 501,
      offset: 40,
    });

    expect(mockSearchJournals).toHaveBeenCalledWith(
      expect.objectContaining({ rows: 500, offset: 40 }),
      expect.anything(),
    );
    expect(result.structuredContent).toMatchObject({ journalCount: 500, nextOffset: 540 });
    expect((result.structuredContent as { notice?: string }).notice).toBe(CLAMP);
    expect(result.content.map(blockText).join('\n')).toContain(CLAMP);
  });

  it('checks the title-search offset ceiling against the clamped rows', async () => {
    mockSearchJournals.mockResolvedValue(journalList(journals(500), 169_103));

    // 99400 + the requested 1000 would pass the 100000 ceiling; the 500 applied does not.
    const result = await runToolContract(searchJournalsTool, {
      query: 'Journal',
      rows: 1000,
      offset: 99_400,
    });

    expect(result.isError).toBeFalsy();
    expect(mockSearchJournals).toHaveBeenCalledWith(
      expect.objectContaining({ rows: 500, offset: 99_400 }),
      expect.anything(),
    );
  });

  it('applies the 400 rows that fit at offset 99600 + rows 501, naming the cap and the window once', async () => {
    mockSearchJournals.mockResolvedValue(journalList(journals(400), 169_103));

    const result = await runToolContract(searchJournalsTool, {
      query: 'Journal',
      rows: 501,
      offset: 99_600,
    });

    expect(result.isError).toBeFalsy();
    expect(mockSearchJournals).toHaveBeenCalledWith(
      expect.objectContaining({ rows: 400, offset: 99_600 }),
      expect.anything(),
    );
    const notice = (result.structuredContent as { notice?: string }).notice;
    expect(notice).toBe(
      'rows 501 is above the per-call cap of 500, and offset 99600 + 500 would pass the 100000 ceiling Crossref puts on offset + rows on journal title search, so 400 was applied — the last journal page reachable by offset, and 169103 journals matched. Narrow the query to bring the rest into reach.',
    );
    expect(notice).not.toContain(CLAMP);
  });

  /**
   * The works list carries no per-call cap: its summary is small enough that Crossref's own page
   * maximum bounds it, as on crossref_search_funders. The journal list beside it holds one
   * journal, so no clamp is named either.
   */
  it('returns up to 1000 works on an issn lookup with include_works, naming no clamp', async () => {
    mockSearchJournals.mockResolvedValue(journalList([RAW_JOURNAL], 1));
    mockGetJournalWorks.mockResolvedValue({
      totalResults: 90_000,
      items: Array.from({ length: 1000 }, (_, i) => ({ DOI: `10.1038/w${i}` })),
    });

    const result = await runToolContract(searchJournalsTool, {
      issn: '0028-0836',
      include_works: true,
      rows: 1000,
    });

    expect(result.isError).toBeFalsy();
    expect(mockGetJournalWorks).toHaveBeenCalledWith(
      RAW_JOURNAL.ISSN,
      { rows: 1000, offset: 0 },
      expect.anything(),
    );
    const structured = result.structuredContent as {
      recentWorks: unknown[];
      notice?: string;
      nextWorksOffset?: number;
    };
    expect(structured.recentWorks).toHaveLength(1000);
    expect(structured.nextWorksOffset).toBe(1000);
    expect(structured.notice).toBeUndefined();
    const text = contentText(result.content);
    expect(text).toContain('DOI: 10.1038/w999');
    expect(text).not.toContain('per-call cap');
  });

  it('fits rows above 500 on the works list to the works_offset window, never to a cap', async () => {
    mockSearchJournals.mockResolvedValue(journalList([RAW_JOURNAL], 1));
    mockGetJournalWorks.mockResolvedValue({
      totalResults: 90_000,
      items: Array.from({ length: 500 }, (_, i) => ({ DOI: `10.1038/w${i}` })),
    });

    const result = await runToolContract(searchJournalsTool, {
      issn: '0028-0836',
      include_works: true,
      rows: 501,
      works_offset: 9500,
    });

    expect(result.isError).toBeFalsy();
    expect(mockGetJournalWorks).toHaveBeenCalledWith(
      RAW_JOURNAL.ISSN,
      { rows: 500, offset: 9500 },
      expect.anything(),
    );
    // 9500 + 500 returned = 10000 leaves no room for another offset page.
    const structured = result.structuredContent as { notice?: string; nextWorksOffset?: number };
    expect(structured.nextWorksOffset).toBeUndefined();
    expect(structured.notice).toBe(
      'works_offset 9500 + rows 501 would pass the 10000 ceiling Crossref puts on works_offset + rows on a journal works list, so 500 was applied — the last works page reachable by works_offset, and 90000 works exist. Re-run with works_cursor="*" and chain nextWorksCursor to read the whole list; the walk restarts at the most recently registered work and runs by registration date, not publication date.',
    );
  });

  it('names no clamp on an issn lookup, which returns its one journal', async () => {
    mockSearchJournals.mockResolvedValue(journalList([RAW_JOURNAL], 1));

    const result = await runToolContract(searchJournalsTool, { issn: '0028-0836', rows: 1000 });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ journalCount: 1, journalsTotal: 1 });
    expect((result.structuredContent as { notice?: string }).notice).toBeUndefined();
    expect(contentText(result.content)).not.toContain('per-call cap');
  });

  it('clamps a title query at rows 1000 to 500 journals, with the same notice', async () => {
    mockSearchJournals.mockResolvedValue(journalList(journals(500), 5000));

    const result = await runToolContract(searchJournalsTool, { query: 'Journal', rows: 1000 });

    expect(mockSearchJournals).toHaveBeenCalledWith(
      expect.objectContaining({ rows: 500 }),
      expect.anything(),
    );
    expect(result.structuredContent).toMatchObject({ journalCount: 500, nextOffset: 500 });
    const notice = 'rows 1000 is above the per-call cap of 500, so 500 was applied.';
    expect((result.structuredContent as { notice?: string }).notice).toBe(notice);
    expect(contentText(result.content)).toContain(notice);
  });

  /**
   * A title query reaching include_works matched one journal — more is refused as ambiguous — so
   * the journal-list cap cut nothing worth naming, and the works list beside it takes rows whole.
   */
  it('takes rows whole on the works list of a title query that matched one journal', async () => {
    mockSearchJournals.mockResolvedValue(journalList([RAW_JOURNAL], 1));
    mockGetJournalWorks.mockResolvedValue({
      totalResults: 90_000,
      items: Array.from({ length: 1000 }, (_, i) => ({ DOI: `10.1038/w${i}` })),
    });

    const result = await runToolContract(searchJournalsTool, {
      query: 'Nature',
      include_works: true,
      rows: 1000,
    });

    expect(result.isError).toBeFalsy();
    expect(mockSearchJournals).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'Nature', rows: 500 }),
      expect.anything(),
    );
    expect(mockGetJournalWorks).toHaveBeenCalledWith(
      RAW_JOURNAL.ISSN,
      { rows: 1000, offset: 0 },
      expect.anything(),
    );
    expect((result.structuredContent as { notice?: string }).notice).toBeUndefined();
  });

  it('applies the 450 works that fit at works_offset 9550 + rows 501, naming the window alone', async () => {
    mockSearchJournals.mockResolvedValue(journalList([RAW_JOURNAL], 1));
    mockGetJournalWorks.mockResolvedValue({
      totalResults: 90_000,
      items: Array.from({ length: 450 }, (_, i) => ({ DOI: `10.1038/w${i}` })),
    });

    const result = await runToolContract(searchJournalsTool, {
      issn: '0028-0836',
      include_works: true,
      rows: 501,
      works_offset: 9550,
    });

    expect(result.isError).toBeFalsy();
    expect(mockGetJournalWorks).toHaveBeenCalledWith(
      RAW_JOURNAL.ISSN,
      { rows: 450, offset: 9550 },
      expect.anything(),
    );
    const notice = (result.structuredContent as { notice?: string }).notice;
    expect(notice).toBe(
      'works_offset 9550 + rows 501 would pass the 10000 ceiling Crossref puts on works_offset + rows on a journal works list, so 450 was applied — the last works page reachable by works_offset, and 90000 works exist. Re-run with works_cursor="*" and chain nextWorksCursor to read the whole list; the walk restarts at the most recently registered work and runs by registration date, not publication date.',
    );
    expect(notice).not.toContain('per-call cap');
  });

  it('leaves rows 500 untouched and notice-free', async () => {
    mockSearchJournals.mockResolvedValue(journalList(journals(500), 5000));

    const result = await runToolContract(searchJournalsTool, { query: 'Journal', rows: 500 });

    expect(mockSearchJournals).toHaveBeenCalledWith(
      expect.objectContaining({ rows: 500 }),
      expect.anything(),
    );
    expect(result.structuredContent).toMatchObject({ journalCount: 500, nextOffset: 500 });
    expect((result.structuredContent as { notice?: string }).notice).toBeUndefined();
  });
});

/**
 * Both Crossref ceilings are on `offset + rows`, accepted up to exactly the cap. Every request a
 * page or a rejection tells the caller to make next has to be one the next call accepts, so each
 * recipe is executed.
 */
describe('searchJournalsTool offset-ceiling recipes', () => {
  type ErrorShape = { error?: { data?: { reason?: string; recovery?: { hint?: string } } } };
  const hintOf = (result: { structuredContent?: unknown }) =>
    (result.structuredContent as ErrorShape).error?.data?.recovery?.hint ?? '';
  const works = (count: number) =>
    Array.from({ length: count }, (_, i) => ({ DOI: `10.1038/w${i}` }));

  it('applies the rows that still fit when works_offset + rows passes 10000', async () => {
    mockSearchJournals.mockResolvedValue(journalList([RAW_JOURNAL], 1));
    mockGetJournalWorks.mockResolvedValue({ totalResults: 90_000, items: works(50) });

    const page = await runToolContract(searchJournalsTool, {
      issn: '0028-0836',
      include_works: true,
      rows: 100,
      works_offset: 9950,
    });

    expect(page.isError).toBeFalsy();
    expect(mockGetJournalWorks).toHaveBeenCalledWith(
      RAW_JOURNAL.ISSN,
      { rows: 50, offset: 9950 },
      expect.anything(),
    );
    const notice =
      'works_offset 9950 + rows 100 would pass the 10000 ceiling Crossref puts on works_offset + rows on a journal works list, so 50 was applied — the last works page reachable by works_offset, and 90000 works exist. Re-run with works_cursor="*" and chain nextWorksCursor to read the whole list; the walk restarts at the most recently registered work and runs by registration date, not publication date.';
    expect((page.structuredContent as { notice?: string }).notice).toBe(notice);
    expect(renderedText(contentText(page.content))).toContain(notice);
  });

  it('routes only to works_cursor once works_offset itself reaches 10000', async () => {
    const rejected = await runToolContract(searchJournalsTool, {
      issn: '0028-0836',
      include_works: true,
      rows: 10,
      works_offset: 10_000,
    });
    expect((rejected.structuredContent as ErrorShape).error?.data?.reason).toBe(
      'works_offset_too_large',
    );
    const hint = hintOf(rejected);
    expect(hint).toContain('works_cursor="*"');
    expect(hint).not.toContain('with rows=');
  });

  it('applies the rows that still fit when offset + rows passes 100000 on title search', async () => {
    mockSearchJournals.mockResolvedValue(journalList(titled(50), 169_103));

    const page = await runToolContract(searchJournalsTool, {
      query: 'a',
      rows: 100,
      offset: 99_950,
    });

    expect(page.isError).toBeFalsy();
    expect(mockSearchJournals).toHaveBeenCalledWith(
      expect.objectContaining({ rows: 50, offset: 99_950 }),
      expect.anything(),
    );
    expect((page.structuredContent as { notice?: string }).notice).toMatch(
      /^offset 99950 \+ rows 100 would pass the 100000 ceiling Crossref puts on offset \+ rows on journal title search, so 50 was applied — /,
    );
  });

  it('hands out the works_offset short of the ceiling, and that page cuts itself to the rows that fit', async () => {
    mockSearchJournals.mockResolvedValue(journalList([RAW_JOURNAL], 1));
    mockGetJournalWorks.mockResolvedValue({ totalResults: 90_000, items: works(500) });

    const page = await runToolContract(searchJournalsTool, {
      issn: '0028-0836',
      include_works: true,
      rows: 500,
      works_offset: 9450,
    });

    const structured = page.structuredContent as { notice?: string; nextWorksOffset?: number };
    expect(structured.nextWorksOffset).toBe(9950);
    expect(structured.notice).toBeUndefined();

    mockGetJournalWorks.mockResolvedValue({ totalResults: 90_000, items: works(50) });
    const next = await runToolContract(searchJournalsTool, {
      issn: '0028-0836',
      include_works: true,
      rows: 500,
      works_offset: 9950,
    });
    expect(next.isError).toBeFalsy();
    expect(mockGetJournalWorks).toHaveBeenLastCalledWith(
      RAW_JOURNAL.ISSN,
      { rows: 50, offset: 9950 },
      expect.anything(),
    );
    expect((next.structuredContent as { recentWorks: unknown[] }).recentWorks).toHaveLength(50);
  });

  it('hands out the offset short of the ceiling, and that page cuts itself to the rows that fit', async () => {
    mockSearchJournals.mockResolvedValue(journalList(titled(100), 169_103));

    const page = await runToolContract(searchJournalsTool, {
      query: 'a',
      rows: 100,
      offset: 99_850,
    });

    const structured = page.structuredContent as { notice?: string; nextOffset?: number };
    expect(structured.nextOffset).toBe(99_950);
    expect(structured.notice).toBeUndefined();

    mockSearchJournals.mockResolvedValue(journalList(titled(50), 169_103));
    const next = await runToolContract(searchJournalsTool, {
      query: 'a',
      rows: 100,
      offset: 99_950,
    });
    expect(next.isError).toBeFalsy();
    expect(mockSearchJournals).toHaveBeenLastCalledWith(
      expect.objectContaining({ rows: 50, offset: 99_950 }),
      expect.anything(),
    );
    expect((next.structuredContent as { journalCount?: number }).journalCount).toBe(50);
  });
});

/**
 * Every (offset, rows) pair either side of each offset window, against fakes that answer the way
 * Crossref does: the records when `offset + rows` fits the route's ceiling, a rejection when it
 * does not (live: `offset + rows` exactly at the ceiling → 200, one past → 400, on both routes).
 * Offsets are written relative to the ceiling, which differs by an order of magnitude between the
 * two lists, so one table drives both guards. The per-call cap of 500 is the journal list's alone:
 * a row the journal list answers with `cap+cut` the works list answers with `cut`, every page in
 * the table fitting under both caps either way. `applied`
 * is the page returned and `next` the continuation offset handed out (null: withheld at the
 * ceiling). `v050` is what the published 0.5.0 returned — rows capped at 100, the window checked
 * on the capped rows, every pair that passed it refused. A pair 0.5.0 answered is answered here
 * with at least as many records.
 */
describe('searchJournalsTool offset windows', () => {
  type Notice = 'none' | 'last' | 'cut' | 'cap+cut';
  // [offset - ceiling, rows, applied (null: refused), next - ceiling (null: withheld), notice, 0.5.0 applied]
  type Row = [number, number, number | null, number | null, Notice, number | null];
  const WINDOW: Row[] = [
    [-1, 1, 1, null, 'last', 1],
    [-1, 100, 1, null, 'cut', null],
    [-1, 101, 1, null, 'cut', null],
    [-1, 500, 1, null, 'cut', null],
    [-1, 501, 1, null, 'cap+cut', null],
    [-1, 1000, 1, null, 'cap+cut', null],
    [-50, 1, 1, -49, 'none', 1],
    [-50, 100, 50, null, 'cut', null],
    [-50, 101, 50, null, 'cut', null],
    [-50, 500, 50, null, 'cut', null],
    [-50, 501, 50, null, 'cap+cut', null],
    [-50, 1000, 50, null, 'cap+cut', null],
    [-100, 1, 1, -99, 'none', 1],
    [-100, 100, 100, null, 'last', 100],
    [-100, 101, 100, null, 'cut', 100],
    [-100, 500, 100, null, 'cut', 100],
    [-100, 501, 100, null, 'cap+cut', 100],
    [-100, 1000, 100, null, 'cap+cut', 100],
    [-101, 1, 1, -100, 'none', 1],
    [-101, 100, 100, -1, 'none', 100],
    [-101, 101, 101, null, 'last', 100],
    [-101, 500, 101, null, 'cut', 100],
    [-101, 501, 101, null, 'cap+cut', 100],
    [-101, 1000, 101, null, 'cap+cut', 100],
    ...[1, 100, 101, 500, 501, 1000].flatMap((rows): Row[] => [
      [0, rows, null, null, 'none', null],
      [1, rows, null, null, 'none', null],
    ]),
  ];
  const works = (count: number) =>
    Array.from({ length: count }, (_, i) => ({ DOI: `10.1038/w${i}` }));

  type Structured = {
    journalCount?: number;
    recentWorks?: unknown[];
    nextOffset?: number;
    nextWorksOffset?: number;
    notice?: string;
    error?: { data?: { reason?: string } };
  };

  describe('the title-search journal list (ceiling 100000)', () => {
    const CEILING = 100_000;
    const ROUTE =
      'the last journal page reachable by offset, and 200000 journals matched. Narrow the query to bring the rest into reach.';

    beforeEach(() => {
      mockSearchJournals.mockImplementation(async (opts: { offset: number; rows: number }) => {
        if (opts.offset + opts.rows > CEILING)
          throw new Error(`Crossref refuses offset ${opts.offset} + rows ${opts.rows}`);
        return journalList(titled(opts.rows), 200_000);
      });
    });

    it.each(WINDOW)(
      'offset 100000 + (%i), rows %i → %s journals (next: 100000 + (%s); notice: %s; 0.5.0: %s)',
      async (delta, rows, applied, nextDelta, notice, v050) => {
        const offset = CEILING + delta;
        const result = await runToolContract(searchJournalsTool, { query: 'a', rows, offset });
        const structured = result.structuredContent as Structured;

        if (applied === null) {
          expect(structured.error?.data?.reason).toBe('offset_too_large');
          expect(mockSearchJournals).not.toHaveBeenCalled();
          return;
        }
        expect(result.isError).toBeFalsy();
        expect(mockSearchJournals).toHaveBeenCalledWith(
          expect.objectContaining({ offset, rows: applied }),
          expect.anything(),
        );
        expect(structured.journalCount).toBe(applied);
        if (v050 !== null) expect(applied).toBeGreaterThanOrEqual(v050);
        expect(structured.nextOffset).toBe(nextDelta === null ? undefined : CEILING + nextDelta);
        const expected = {
          none: undefined,
          last: 'This is the last journal page reachable by offset — Crossref caps offset + rows at 100000 on journal search and 200000 journals matched. Narrow the query to bring the rest into reach.',
          cut: `offset ${offset} + rows ${rows} would pass the 100000 ceiling Crossref puts on offset + rows on journal title search, so ${applied} was applied — ${ROUTE}`,
          'cap+cut': `rows ${rows} is above the per-call cap of 500, and offset ${offset} + 500 would pass the 100000 ceiling Crossref puts on offset + rows on journal title search, so ${applied} was applied — ${ROUTE}`,
        }[notice];
        expect(structured.notice).toBe(expected);
      },
    );

    it('carries a window-cut page identically on both surfaces', async () => {
      const result = await runToolContract(searchJournalsTool, {
        query: 'a',
        rows: 1000,
        offset: 99_900,
      });

      const structured = result.structuredContent as Structured & {
        journals: Array<{ title?: string }>;
      };
      const notice = `rows 1000 is above the per-call cap of 500, and offset 99900 + 500 would pass the 100000 ceiling Crossref puts on offset + rows on journal title search, so 100 was applied — ${ROUTE}`;
      expect(structured.notice).toBe(notice);
      const lines = renderedText(contentText(result.content)).split('\n');
      expect(lines.some((line) => line.endsWith(notice))).toBe(true);
      expect(structured.journals).toHaveLength(100);
      for (const journal of structured.journals) expect(lines).toContain(journal.title);
    });

    /** A cut page that ends the list has nothing past it to route to. */
    it('says only that the rows were cut when the list ends at the ceiling', async () => {
      mockSearchJournals.mockImplementation(async (opts: { rows: number }) =>
        journalList(titled(opts.rows), CEILING),
      );

      const result = await runToolContract(searchJournalsTool, {
        query: 'a',
        rows: 100,
        offset: 99_950,
      });

      const structured = result.structuredContent as Structured;
      const notice =
        'offset 99950 + rows 100 would pass the 100000 ceiling Crossref puts on offset + rows on journal title search, so 50 was applied.';
      expect(structured.journalCount).toBe(50);
      expect(structured.nextOffset).toBeUndefined();
      expect(structured.notice).toBe(notice);
      const lines = renderedText(contentText(result.content)).split('\n');
      expect(lines.some((line) => line.endsWith(notice))).toBe(true);
    });
  });

  describe('the journal works list (ceiling 10000)', () => {
    const CEILING = 10_000;
    const ROUTE =
      'the last works page reachable by works_offset, and 250000 works exist. Re-run with works_cursor="*" and chain nextWorksCursor to read the whole list; the walk restarts at the most recently registered work and runs by registration date, not publication date.';

    beforeEach(() => {
      mockSearchJournals.mockResolvedValue(journalList([RAW_JOURNAL], 1));
      mockGetJournalWorks.mockImplementation(
        async (_issns: string[], opts: { offset: number; rows: number }) => {
          if (opts.offset + opts.rows > CEILING)
            throw new Error(`Crossref refuses offset ${opts.offset} + rows ${opts.rows}`);
          return { totalResults: 250_000, items: works(opts.rows) };
        },
      );
    });

    it.each(WINDOW)(
      'works_offset 10000 + (%i), rows %i → %s works (next: 10000 + (%s); notice: %s; 0.5.0: %s)',
      async (delta, rows, applied, nextDelta, notice, v050) => {
        const worksOffset = CEILING + delta;
        const result = await runToolContract(searchJournalsTool, {
          issn: '0028-0836',
          include_works: true,
          rows,
          works_offset: worksOffset,
        });
        const structured = result.structuredContent as Structured;

        if (applied === null) {
          expect(structured.error?.data?.reason).toBe('works_offset_too_large');
          expect(mockSearchJournals).not.toHaveBeenCalled();
          return;
        }
        expect(result.isError).toBeFalsy();
        expect(mockGetJournalWorks).toHaveBeenCalledWith(
          RAW_JOURNAL.ISSN,
          { rows: applied, offset: worksOffset },
          expect.anything(),
        );
        expect(structured.recentWorks).toHaveLength(applied);
        if (v050 !== null) expect(applied).toBeGreaterThanOrEqual(v050);
        expect(structured.nextWorksOffset).toBe(
          nextDelta === null ? undefined : CEILING + nextDelta,
        );
        // The works list has no per-call cap, so only its window ever cuts the rows requested.
        const expected = {
          none: undefined,
          last: 'This is the last works page reachable by works_offset — Crossref caps works_offset + rows at 10000 on a journal works list and 250000 works exist. Re-run with works_cursor="*" and chain nextWorksCursor to read the whole list; the walk restarts at the most recently registered work and runs by registration date, not publication date.',
          cut: `works_offset ${worksOffset} + rows ${rows} would pass the 10000 ceiling Crossref puts on works_offset + rows on a journal works list, so ${applied} was applied — ${ROUTE}`,
        }[notice === 'cap+cut' ? 'cut' : notice];
        expect(structured.notice).toBe(expected);
      },
    );

    it('carries a window-cut page identically on both surfaces', async () => {
      const result = await runToolContract(searchJournalsTool, {
        issn: '0028-0836',
        include_works: true,
        rows: 250,
        works_offset: 9950,
      });

      const structured = result.structuredContent as Structured & {
        recentWorks: Array<{ doi: string }>;
      };
      const notice = `works_offset 9950 + rows 250 would pass the 10000 ceiling Crossref puts on works_offset + rows on a journal works list, so 50 was applied — ${ROUTE}`;
      expect(structured.notice).toBe(notice);
      const lines = renderedText(contentText(result.content)).split('\n');
      expect(lines.some((line) => line.endsWith(notice))).toBe(true);
      expect(structured.recentWorks).toHaveLength(50);
      for (const work of structured.recentWorks) expect(lines).toContain(`DOI: ${work.doi}`);
    });

    /** A cut page that ends the list has nothing past it to route to. */
    it('says only that the rows were cut when the list ends at the ceiling', async () => {
      mockGetJournalWorks.mockImplementation(async (_issns: string[], opts: { rows: number }) => ({
        totalResults: CEILING,
        items: works(opts.rows),
      }));

      const result = await runToolContract(searchJournalsTool, {
        issn: '0028-0836',
        include_works: true,
        rows: 100,
        works_offset: 9950,
      });

      const structured = result.structuredContent as Structured;
      const notice =
        'works_offset 9950 + rows 100 would pass the 10000 ceiling Crossref puts on works_offset + rows on a journal works list, so 50 was applied.';
      expect(structured.recentWorks).toHaveLength(50);
      expect(structured.nextWorksOffset).toBeUndefined();
      expect(structured.notice).toBe(notice);
      const lines = renderedText(contentText(result.content)).split('\n');
      expect(lines.some((line) => line.endsWith(notice))).toBe(true);
    });

    it('cuts the works list alone, leaving the journal list at the rows requested', async () => {
      const result = await runToolContract(searchJournalsTool, {
        query: 'Nature',
        include_works: true,
        rows: 300,
        works_offset: 9900,
      });

      expect(result.isError).toBeFalsy();
      expect(mockSearchJournals).toHaveBeenCalledWith(
        expect.objectContaining({ query: 'Nature', rows: 300 }),
        expect.anything(),
      );
      expect(mockGetJournalWorks).toHaveBeenCalledWith(
        RAW_JOURNAL.ISSN,
        { rows: 100, offset: 9900 },
        expect.anything(),
      );
    });

    it('leaves a works_cursor walk untouched by the window', async () => {
      mockGetJournalWorks.mockResolvedValue({ totalResults: 250_000, items: works(500) });

      await runToolContract(searchJournalsTool, {
        issn: '0028-0836',
        include_works: true,
        rows: 500,
        works_cursor: '*',
      });

      expect(mockGetJournalWorks).toHaveBeenCalledWith(
        RAW_JOURNAL.ISSN,
        { rows: 500, cursor: '*' },
        expect.anything(),
      );
    });
  });
});

/** `count` title-query journal records. */
function titled(count: number) {
  return Array.from({ length: count }, (_, i) => ({ ...RAW_JOURNAL, title: `Journal ${i}` }));
}

describe('searchJournalsTool coverage, ISSN types, and DOI counts', () => {
  /** Shape of the live /journals/1476-4687 record: no ISSN-L key, breakdown ordered by count. */
  const NATURE = {
    title: 'Nature',
    ISSN: ['0028-0836', '1476-4687'],
    'issn-type': [
      { type: 'print', value: '0028-0836' },
      { type: 'electronic', value: '1476-4687' },
    ],
    publisher: 'Springer Science and Business Media LLC',
    counts: { 'current-dois': 12598, 'backfile-dois': 435113, 'total-dois': 447711 },
    coverage: {
      'abstracts-current': 0.1172408318780759,
      'abstracts-backfile': 0.002803869339688771,
      'funders-current': 0,
      'funders-backfile': 0.00002068428201409749,
      'references-current': 0.6393872043181457,
      'references-backfile': 0.3926060586560273,
    },
    breakdowns: {
      'dois-by-issued-year': [
        [2025, 4550],
        [1869, 12],
        [2026, 3661],
        [1950, 900],
      ],
    },
  };
  type Structured = {
    journals: Array<Record<string, unknown>>;
  };
  const journalOf = (result: { structuredContent?: unknown }) =>
    (result.structuredContent as Structured).journals[0];
  const textOf = (result: { content: unknown[] }) =>
    result.content.map((b) => blockText(b as Parameters<typeof blockText>[0])).join('\n');

  it('projects every new field on an issn lookup, doisByYear ascending by year', async () => {
    mockSearchJournals.mockResolvedValue(journalList([NATURE]));

    const result = await runToolContract(searchJournalsTool, { issn: '1476-4687' });

    expect(result.isError).toBeFalsy();
    const journal = journalOf(result);
    expect(journal?.issnTypes).toEqual([
      { value: '0028-0836', type: 'print' },
      { value: '1476-4687', type: 'electronic' },
    ]);
    expect(journal?.totalDois).toBe(447711);
    expect(journal?.currentDois).toBe(12598);
    expect(journal?.backfileDois).toBe(435113);
    expect(journal?.coverage).toEqual([
      { category: 'abstracts', current: 0.1172408318780759, backfile: 0.002803869339688771 },
      { category: 'funders', current: 0, backfile: 0.00002068428201409749 },
      { category: 'references', current: 0.6393872043181457, backfile: 0.3926060586560273 },
    ]);
    expect(journal?.doisByYear).toEqual([
      { year: 1869, count: 12 },
      { year: 1950, count: 900 },
      { year: 2025, count: 4550 },
      { year: 2026, count: 3661 },
    ]);
    expect(journal).not.toHaveProperty('issnL');

    const text = textOf(result);
    expect(text).toContain('**ISSN types:** 0028-0836 (print), 1476-4687 (electronic)');
    expect(text).toContain('**Current DOIs:** 12598');
    expect(text).toContain('**Backfile DOIs:** 435113');
    expect(text).toContain(
      [
        '**Metadata coverage (0–1 fractions, current / backfile):**',
        '- abstracts: 0.1172408318780759 / 0.002803869339688771',
        '- funders: 0 / 0.00002068428201409749',
        '- references: 0.6393872043181457 / 0.3926060586560273',
      ].join('\n'),
    );
    expect(text).toContain('**DOIs by issued year:** 1869: 12, 1950: 900, 2025: 4550, 2026: 3661');
    expect(text).not.toContain('ISSN-L');
  });

  it('keeps the DOIs-by-year line out of the coverage list when CommonMark parses content[]', async () => {
    mockSearchJournals.mockResolvedValue(journalList([NATURE]));

    const result = await runToolContract(searchJournalsTool, { issn: '1476-4687' });

    /** Literal text under a node, softbreaks read as newlines. */
    const textUnder = (node: Node): string => {
      let out = '';
      const walker = node.walker();
      for (let step = walker.next(); step; step = walker.next()) {
        if (!step.entering) continue;
        if (step.node.literal) out += step.node.literal;
        if (step.node.type === 'softbreak') out += '\n';
      }
      return out;
    };
    const items: string[] = [];
    const paragraphs: string[] = [];
    for (const block of result.content) {
      const walker = new Parser().parse(blockText(block)).walker();
      for (let step = walker.next(); step; step = walker.next()) {
        if (!step.entering) continue;
        if (step.node.type === 'item') items.push(textUnder(step.node));
        if (step.node.type === 'paragraph' && step.node.parent?.type !== 'item')
          paragraphs.push(textUnder(step.node));
      }
    }

    expect(items).toEqual([
      'abstracts: 0.1172408318780759 / 0.002803869339688771',
      'funders: 0 / 0.00002068428201409749',
      'references: 0.6393872043181457 / 0.3926060586560273',
    ]);
    expect(items.some((item) => item.includes('DOIs by issued year'))).toBe(false);
    expect(paragraphs.some((p) => p.includes('DOIs by issued year: 1869: 12'))).toBe(true);
  });

  it('carries coverage, issnTypes, and DOI counts on a title query, but no doisByYear', async () => {
    mockSearchJournals.mockResolvedValue(
      journalList([NATURE, { ...NATURE, title: 'Nature 2' }], 2),
    );

    const result = await runToolContract(searchJournalsTool, { query: 'Nature' });

    expect(result.isError).toBeFalsy();
    const journals = (result.structuredContent as Structured).journals;
    expect(journals).toHaveLength(2);
    for (const journal of journals) {
      expect(journal.issnTypes).toHaveLength(2);
      expect(journal.currentDois).toBe(12598);
      expect(journal.backfileDois).toBe(435113);
      expect(journal.coverage).toHaveLength(3);
      expect(journal).not.toHaveProperty('doisByYear');
    }
    const text = textOf(result);
    expect(
      text.match(/\*\*Metadata coverage \(0–1 fractions, current \/ backfile\):\*\*/g),
    ).toHaveLength(2);
    expect(text).not.toContain('DOIs by issued year');
  });

  it('omits each key whose upstream field is absent or empty', async () => {
    mockSearchJournals.mockResolvedValue(
      journalList([
        { title: 'Bare', ISSN: ['1234-5678'] },
        {
          title: 'Hollow',
          ISSN: [],
          'issn-type': [],
          counts: { 'total-dois': 0 },
          coverage: { 'last-status-check-time': 1 },
          breakdowns: { 'dois-by-issued-year': [] },
        },
      ]),
    );
    const lookup = await runToolContract(searchJournalsTool, { query: 'x' });
    const listed = (lookup.structuredContent as Structured).journals;
    expect(listed.map((j) => j.title)).toEqual(['Bare', 'Hollow']);
    for (const journal of listed) {
      for (const key of ['issnTypes', 'currentDois', 'backfileDois', 'coverage', 'doisByYear']) {
        expect(journal).not.toHaveProperty(key);
      }
    }
    expect(textOf(lookup)).not.toMatch(/ISSN types|Current DOIs|Backfile DOIs|Metadata coverage/);

    mockSearchJournals.mockResolvedValue(
      journalList([{ title: 'Hollow', breakdowns: { 'dois-by-issued-year': [] } }]),
    );
    const single = await runToolContract(searchJournalsTool, { issn: '1234-5678' });
    expect(journalOf(single)).toEqual({ title: 'Hollow' });
    expect(textOf(single)).not.toContain('DOIs by issued year');
  });

  it('keeps an ISSN whose type Crossref records as null, without a type', async () => {
    mockSearchJournals.mockResolvedValue(
      journalList([
        {
          title: 'Sociedade & Natureza',
          ISSN: ['1982-4513', '1982-4513', '0103-1570'],
          'issn-type': [
            { type: 'print', value: '1982-4513' },
            { type: 'electronic', value: '1982-4513' },
            { type: null, value: '0103-1570' },
          ],
        },
      ]),
    );

    const result = await runToolContract(searchJournalsTool, { issn: '1982-4513' });

    expect(result.isError).toBeFalsy();
    expect(journalOf(result)?.issnTypes).toEqual([
      { value: '1982-4513', type: 'print' },
      { value: '1982-4513', type: 'electronic' },
      { value: '0103-1570' },
    ]);
    expect(textOf(result)).toContain(
      '**ISSN types:** 1982-4513 (print), 1982-4513 (electronic), 0103-1570',
    );
  });

  it('stops advertising ISSN-L as returned', () => {
    expect(searchJournalsTool.description).not.toContain('ISSN-L');
    const issnL = searchJournalsTool.output.shape.journals.element.shape.issnL;
    expect(issnL.description).toContain('Crossref journal records do not carry');
    expect(issnL.description).not.toContain('explicit null');
  });
});
