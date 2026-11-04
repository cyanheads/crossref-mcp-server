/**
 * @fileoverview Tests for the crossref_search_funders tool.
 * @module tests/tools/search-funders.tool.test
 */

import { readFileSync } from 'node:fs';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { searchFundersTool } from '@/mcp-server/tools/definitions/search-funders.tool.js';
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

const mockSearchFunders = vi.fn();
const mockGetFunderWorks = vi.fn();

beforeEach(() => {
  vi.mocked(getCrossrefService).mockReturnValue({
    searchFunders: mockSearchFunders,
    getFunderWorks: mockGetFunderWorks,
  } as unknown as ReturnType<typeof getCrossrefService>);
  mockSearchFunders.mockReset();
  mockGetFunderWorks.mockReset();
});

/**
 * Shaped after a live `/funders` record: geography arrives as the free-text `location` key —
 * there is no `country` on the payload, and the output field of that name is projected from it.
 * `replaced-by` and `replaces` are present-but-empty on every record, which is how Crossref
 * reports "no such relationship".
 */
const RAW_FUNDER = {
  id: '100000001',
  name: 'National Science Foundation',
  'alt-names': ['NSF'],
  location: 'United States',
  uri: 'http://dx.doi.org/10.13039/100000001',
  'work-count': 250000,
  'replaced-by': [],
  replaces: [],
};

/** Live shape of a superseded registry entry (China Sponsorship Council → China Scholarship Council). */
const RAW_DEPRECATED_FUNDER = {
  id: '501100002860',
  name: 'China Sponsorship Council',
  'alt-names': ['CSC'],
  location: 'China',
  uri: 'http://dx.doi.org/10.13039/501100002860',
  'work-count': 965,
  'replaced-by': ['501100004543'],
  replaces: [],
};

/** Funder-list envelope shape returned by CrossrefService.searchFunders. */
function funderList(items: unknown[], totalResults = items.length) {
  return { totalResults, items };
}

/**
 * The schema clients actually receive: domain output merged with enrichment. Parsing through
 * it proves a field reaches the wire — an undeclared key is stripped here, silently.
 */
const wireSchema = searchFundersTool.output.extend(searchFundersTool.enrichment!);

describe('searchFundersTool', () => {
  it('returns funder records for a name query', async () => {
    const ctx = createMockContext({ errors: searchFundersTool.errors });
    mockSearchFunders.mockResolvedValue(funderList([RAW_FUNDER]));

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
    const ctx = createMockContext({ errors: searchFundersTool.errors });
    mockSearchFunders.mockResolvedValue(funderList([RAW_FUNDER]));
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
    const ctx = createMockContext({ errors: searchFundersTool.errors });
    mockSearchFunders.mockResolvedValue(funderList([]));

    const input = searchFundersTool.input.parse({ query: 'ZZZUnknownFunder' });
    const result = await searchFundersTool.handler(input, ctx);

    expect(result.funders).toHaveLength(0);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.funderCount).toBe(0);
    expect(enrichment.notice).toBeDefined();
  });

  it('performs direct funder DOI lookup when funder_doi is provided', async () => {
    const ctx = createMockContext({ errors: searchFundersTool.errors });
    mockSearchFunders.mockResolvedValue(funderList([RAW_FUNDER]));

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

  it('handles sparse funder record — no alt-names, no supersession arrays', async () => {
    const ctx = createMockContext({ errors: searchFundersTool.errors });
    mockSearchFunders.mockResolvedValue(
      funderList([{ id: '999', name: 'Minimal Funder', location: 'Unknown' }]),
    );

    const input = searchFundersTool.input.parse({ query: 'Minimal' });
    const result = await searchFundersTool.handler(input, ctx);

    expect(result.funders[0]?.name).toBe('Minimal Funder');
    expect(result.funders[0]?.altNames).toBeUndefined();
    expect(result.funders[0]?.replacedBy).toBeUndefined();
    expect(result.funders[0]?.replaces).toBeUndefined();
  });

  it('omits replacedBy/replaces when the registry reports them as empty arrays', async () => {
    const ctx = createMockContext({ errors: searchFundersTool.errors });
    mockSearchFunders.mockResolvedValue(funderList([RAW_FUNDER]));

    const input = searchFundersTool.input.parse({ query: 'National Science Foundation' });
    const result = await searchFundersTool.handler(input, ctx);

    expect(result.funders[0]?.replacedBy).toBeUndefined();
    expect(result.funders[0]?.replaces).toBeUndefined();
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('surfaces the successor on a deprecated funder resolved by query', async () => {
    const ctx = createMockContext({ errors: searchFundersTool.errors });
    mockSearchFunders.mockResolvedValue(funderList([RAW_DEPRECATED_FUNDER]));
    mockGetFunderWorks.mockResolvedValue({ totalResults: 965, itemsPerPage: 10, items: [] });

    const input = searchFundersTool.input.parse({
      query: 'China Sponsorship Council',
      include_works: true,
    });
    const result = await searchFundersTool.handler(input, ctx);

    expect(result.funders[0]?.replacedBy).toEqual(['501100004543']);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toContain('501100004543');
    expect(enrichment.notice).toContain('deprecated');
    // Never redirected — the works list still belongs to the ID the caller resolved.
    expect(mockGetFunderWorks).toHaveBeenCalledWith(
      '501100002860',
      expect.anything(),
      expect.anything(),
    );
    expect(enrichment.fundedWorksTotal).toBe(965);
  });

  it('surfaces the successor on a deprecated funder resolved by funder_doi', async () => {
    const ctx = createMockContext({ errors: searchFundersTool.errors });
    mockSearchFunders.mockResolvedValue(funderList([RAW_DEPRECATED_FUNDER]));

    const input = searchFundersTool.input.parse({ funder_doi: '501100002860' });
    const result = await searchFundersTool.handler(input, ctx);

    expect(result.funders[0]?.replacedBy).toEqual(['501100004543']);
    expect(getEnrichment(ctx).notice).toContain('501100004543');
  });

  it('projects replaces on the entry that superseded a deprecated one', async () => {
    const ctx = createMockContext({ errors: searchFundersTool.errors });
    mockSearchFunders.mockResolvedValue(
      funderList([
        {
          id: '501100004543',
          name: 'China Scholarship Council',
          location: 'China',
          'work-count': 101911,
          'replaced-by': [],
          replaces: ['501100002860'],
        },
      ]),
    );

    const input = searchFundersTool.input.parse({ funder_doi: '501100004543' });
    const result = await searchFundersTool.handler(input, ctx);

    expect(result.funders[0]?.replaces).toEqual(['501100002860']);
    expect(result.funders[0]?.replacedBy).toBeUndefined();
    // `replaces` alone is not a deprecation — this is the current entry.
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('carries both the deprecation and the offset-ceiling caveat in one notice', async () => {
    const ctx = createMockContext({ errors: searchFundersTool.errors });
    mockSearchFunders.mockResolvedValue(funderList([RAW_DEPRECATED_FUNDER], 200_000));

    // The one funder returned at 99999 ends the page on the ceiling with records still past it.
    const input = searchFundersTool.input.parse({ query: 'council', offset: 99_999, rows: 1 });
    const result = await searchFundersTool.handler(input, ctx);

    expect(result.funders).toHaveLength(1);
    const notice = getEnrichment(ctx).notice ?? '';
    expect(notice).toContain('501100004543');
    expect(notice).toContain('last funder page reachable by offset');
  });

  it('reaches the wire with replacedBy and replaces', async () => {
    const ctx = createMockContext({ errors: searchFundersTool.errors });
    mockSearchFunders.mockResolvedValue(funderList([RAW_DEPRECATED_FUNDER]));

    const input = searchFundersTool.input.parse({ funder_doi: '501100002860' });
    const result = await searchFundersTool.handler(input, ctx);
    const wire = wireSchema.parse({ ...result, ...getEnrichment(ctx) });

    expect(wire.funders[0]?.replacedBy).toEqual(['501100004543']);
    expect(wire.notice).toContain('501100004543');
  });

  it('decodes HTML entities in funder name and altNames', async () => {
    const ctx = createMockContext({ errors: searchFundersTool.errors });
    mockSearchFunders.mockResolvedValue(
      funderList([
        {
          id: '123',
          name: 'Agence Nationale de la Recherche &amp; Innovation',
          'alt-names': ['ANR &amp; Innovation'],
          location: 'France',
        },
      ]),
    );

    const input = searchFundersTool.input.parse({ query: 'ANR' });
    const result = await searchFundersTool.handler(input, ctx);

    expect(result.funders[0]?.name).toBe('Agence Nationale de la Recherche & Innovation');
    expect(result.funders[0]?.altNames?.[0]).toBe('ANR & Innovation');
  });

  it('strips JATS markup from fundedWorks titles and decodes the funder location', async () => {
    const ctx = createMockContext({ errors: searchFundersTool.errors });
    mockSearchFunders.mockResolvedValue(
      funderList([{ ...RAW_FUNDER, location: 'Trinidad &amp; Tobago' }]),
    );
    mockGetFunderWorks.mockResolvedValue({
      totalResults: 1,
      itemsPerPage: 10,
      items: [
        { DOI: '10.1039/d5cs00921a', type: 'journal-article', title: ['<i>In vivo</i>\n  assay'] },
      ],
    });

    const input = searchFundersTool.input.parse({
      funder_doi: '100000001',
      include_works: true,
    });
    const result = await searchFundersTool.handler(input, ctx);

    expect(result.funders[0]?.country).toBe('Trinidad & Tobago');
    expect(result.fundedWorks?.[0]?.title).toBe('In vivo assay');
  });

  it('uses funder_doi from input as fallback ID when raw funder has no id', async () => {
    const ctx = createMockContext({ errors: searchFundersTool.errors });
    // Funder record missing `id` field
    mockSearchFunders.mockResolvedValue(funderList([{ name: 'Some Funder', location: 'Country' }]));
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
      expect.objectContaining({ rows: expect.any(Number) }),
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
          uri: 'http://dx.doi.org/10.13039/100000001',
          worksCount: 250000,
        },
      ],
    };
    const blocks = searchFundersTool.format!(result);
    const text = blockText(blocks[0]);
    expect(text).toContain('National Science Foundation');
    expect(text).toContain('United States');
    expect(text).toContain('250000');
    expect(text).toContain('NSF');
  });

  it('renders the deprecation and successor IDs in content[]', () => {
    const result = {
      funders: [
        {
          id: '501100002860',
          name: 'China Sponsorship Council',
          country: 'China',
          worksCount: 965,
          replacedBy: ['501100004543'],
        },
        {
          id: '501100004543',
          name: 'China Scholarship Council',
          country: 'China',
          worksCount: 101911,
          replaces: ['501100002860'],
        },
      ],
    };
    const text = blockText(searchFundersTool.format!(result)[0]);
    expect(text).toContain('**Deprecated — replaced by:** 501100004543');
    expect(text).toContain('**Replaces:** 501100002860');
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
    const text = blockText(blocks[0]);
    expect(text).toContain('NSF-funded Discovery');
    expect(text).toContain('10.1038/s41586-024-0001-1');
    expect(text).toContain('2024');
    expect(text).toContain('10');
  });

  it('accepts rows between 1 and 1000', () => {
    expect(() => searchFundersTool.input.parse({ query: 'test', rows: 1 })).not.toThrow();
    expect(() => searchFundersTool.input.parse({ query: 'test', rows: 1000 })).not.toThrow();
  });

  it('accepts valid funder_doi formats — full DOI, doi: prefix, and URL prefix', () => {
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

  it('accepts the bare registry ID the description documents', () => {
    expect(() => searchFundersTool.input.parse({ funder_doi: '100000001' })).not.toThrow();
    expect(searchFundersTool.input.parse({ funder_doi: '100000001' }).funder_doi).toBe('100000001');
  });

  it('passes a bare registry ID straight through to the funder lookup', async () => {
    const ctx = createMockContext({ errors: searchFundersTool.errors });
    mockSearchFunders.mockResolvedValue(funderList([RAW_FUNDER]));

    const input = searchFundersTool.input.parse({ funder_doi: '100000001' });
    const result = await searchFundersTool.handler(input, ctx);

    expect(mockSearchFunders).toHaveBeenCalledWith(
      expect.objectContaining({ funderDoi: '100000001' }),
      expect.anything(),
    );
    expect(result.funders[0]?.name).toBe('National Science Foundation');
  });

  it('rejects malformed funder_doi values before any upstream call', () => {
    expect(() => searchFundersTool.input.parse({ funder_doi: 'not-a-doi' })).toThrow();
    expect(() => searchFundersTool.input.parse({ funder_doi: '10.1038/nature12373' })).toThrow();
    expect(() => searchFundersTool.input.parse({ funder_doi: '10.13039/' })).toThrow();
    // A bare ID is valid, but only bare — the doi:/URL prefixes still require the 10.13039/ stem.
    expect(() => searchFundersTool.input.parse({ funder_doi: 'doi:100000001' })).toThrow();
    expect(() =>
      searchFundersTool.input.parse({ funder_doi: 'https://doi.org/100000001' }),
    ).toThrow();
  });

  describe('paging', () => {
    it('threads offset to the funder search and hands back the next page offset', async () => {
      const ctx = createMockContext({ errors: searchFundersTool.errors });
      mockSearchFunders.mockResolvedValue(funderList([RAW_FUNDER, RAW_FUNDER], 2252));

      const input = searchFundersTool.input.parse({ query: 'National', rows: 2, offset: 2 });
      const result = await searchFundersTool.handler(input, ctx);

      expect(mockSearchFunders).toHaveBeenCalledWith(
        expect.objectContaining({ offset: 2, rows: 2 }),
        expect.anything(),
      );
      const wire = wireSchema.parse({ ...result, ...getEnrichment(ctx) });
      expect(wire.fundersTotal).toBe(2252);
      expect(wire.funderCount).toBe(2);
      expect(wire.nextOffset).toBe(4);
    });

    it('omits nextOffset on the last page of funders', async () => {
      const ctx = createMockContext({ errors: searchFundersTool.errors });
      mockSearchFunders.mockResolvedValue(funderList([RAW_FUNDER, RAW_FUNDER], 4));

      const input = searchFundersTool.input.parse({ query: 'National', rows: 2, offset: 2 });
      const result = await searchFundersTool.handler(input, ctx);

      const wire = wireSchema.parse({ ...result, ...getEnrichment(ctx) });
      expect(wire.fundersTotal).toBe(4);
      expect(wire.nextOffset).toBeUndefined();
    });

    it('returns a well-formed empty page past the end of the funder list', async () => {
      const ctx = createMockContext({ errors: searchFundersTool.errors });
      mockSearchFunders.mockResolvedValue(funderList([], 2252));

      const input = searchFundersTool.input.parse({ query: 'National', rows: 2, offset: 5000 });
      const result = await searchFundersTool.handler(input, ctx);

      expect(result.funders).toHaveLength(0);
      const wire = wireSchema.parse({ ...result, ...getEnrichment(ctx) });
      expect(wire.fundersTotal).toBe(2252);
      expect(wire.nextOffset).toBeUndefined();
      // The query matched — the offset ran off the end. Saying "no funders matched" here
      // would send the caller off rewriting a query that was fine.
      expect(wire.notice).toContain('past the end');
      expect(wire.notice).toContain('2252');
      expect(wire.notice).not.toContain('No funders matched');
    });

    it('keeps the no-match notice distinct from the past-the-end notice', async () => {
      const ctx = createMockContext({ errors: searchFundersTool.errors });
      mockSearchFunders.mockResolvedValue(funderList([], 0));

      const input = searchFundersTool.input.parse({ query: 'ZZZUnknownFunder', offset: 0 });
      const result = await searchFundersTool.handler(input, ctx);

      const wire = wireSchema.parse({ ...result, ...getEnrichment(ctx) });
      expect(wire.notice).toContain('No funders matched');
      expect(wire.notice).not.toContain('past the end');
    });

    it('threads works_offset to the works sub-resource and hands back nextWorksOffset', async () => {
      const ctx = createMockContext({ errors: searchFundersTool.errors });
      mockSearchFunders.mockResolvedValue(funderList([RAW_FUNDER], 1));
      mockGetFunderWorks.mockResolvedValue({
        totalResults: 559017,
        itemsPerPage: 2,
        items: [{ DOI: '10.1038/a' }, { DOI: '10.1038/b' }],
      });

      const input = searchFundersTool.input.parse({
        funder_doi: '100000001',
        include_works: true,
        rows: 2,
        works_offset: 20,
      });
      const result = await searchFundersTool.handler(input, ctx);

      expect(mockGetFunderWorks).toHaveBeenCalledWith(
        '100000001',
        { rows: 2, offset: 20 },
        expect.anything(),
      );
      const wire = wireSchema.parse({ ...result, ...getEnrichment(ctx) });
      expect(wire.fundedWorksTotal).toBe(559017);
      expect(wire.nextWorksOffset).toBe(22);
    });

    it('omits nextWorksOffset at the 10000 ceiling but says why on the page', async () => {
      const ctx = createMockContext({ errors: searchFundersTool.errors });
      mockSearchFunders.mockResolvedValue(funderList([RAW_FUNDER], 1));
      mockGetFunderWorks.mockResolvedValue({
        totalResults: 559017,
        itemsPerPage: 10,
        items: Array.from({ length: 10 }, (_, i) => ({ DOI: `10.1038/x${i}` })),
      });

      const input = searchFundersTool.input.parse({
        funder_doi: '100000001',
        include_works: true,
        rows: 10,
        works_offset: 9990,
      });
      const result = await searchFundersTool.handler(input, ctx);

      const wire = wireSchema.parse({ ...result, ...getEnrichment(ctx) });
      expect(wire.nextWorksOffset).toBeUndefined();
      // Absence alone reads as end-of-list. 559017 works exist, so the page has to disclose the
      // ceiling and name the input that reaches the rest.
      expect(wire.notice).toContain('10000');
      expect(wire.notice).toContain('559017');
      expect(wire.notice).toContain('works_cursor');
      // The cursor walk restarts at the most recently registered work rather than resuming
      // from this offset, and runs in registration order rather than by publication date, so
      // a caller who follows the notice must not expect to pick up where it left off.
      expect(wire.notice).toMatch(/restart/i);
      expect(wire.notice).toContain('registration date, not publication date');
      expect(wire.nextWorksCursor).toBeUndefined();
    });

    it('leaves the notice off when the works list simply ended', async () => {
      const ctx = createMockContext({ errors: searchFundersTool.errors });
      mockSearchFunders.mockResolvedValue(funderList([RAW_FUNDER], 1));
      mockGetFunderWorks.mockResolvedValue({
        totalResults: 2,
        itemsPerPage: 10,
        items: [{ DOI: '10.1038/a' }, { DOI: '10.1038/b' }],
      });

      const input = searchFundersTool.input.parse({
        funder_doi: '100000001',
        include_works: true,
        rows: 10,
      });
      const result = await searchFundersTool.handler(input, ctx);

      const wire = wireSchema.parse({ ...result, ...getEnrichment(ctx) });
      expect(wire.nextWorksOffset).toBeUndefined();
      expect(wire.notice).toBeUndefined();
    });

    it('starts a cursor walk of the funded-works list and hands back nextWorksCursor', async () => {
      const ctx = createMockContext({ errors: searchFundersTool.errors });
      mockSearchFunders.mockResolvedValue(funderList([RAW_FUNDER], 1));
      mockGetFunderWorks.mockResolvedValue({
        totalResults: 559033,
        itemsPerPage: 2,
        items: [{ DOI: '10.1038/a' }, { DOI: '10.1038/b' }],
        nextCursor: 'AoJw8P3T3fACPBhodHRwOi8vZHguZG9pLm9yZy8xMC4xMDM4L2E=',
      });

      const input = searchFundersTool.input.parse({
        funder_doi: '100000001',
        include_works: true,
        rows: 2,
        works_cursor: '*',
      });
      const result = await searchFundersTool.handler(input, ctx);

      // No offset on the call: the two page selectors are alternatives upstream.
      expect(mockGetFunderWorks).toHaveBeenCalledWith(
        '100000001',
        { rows: 2, cursor: '*' },
        expect.anything(),
      );
      const wire = wireSchema.parse({ ...result, ...getEnrichment(ctx) });
      expect(wire.fundedWorksTotal).toBe(559033);
      expect(wire.nextWorksCursor).toBe('AoJw8P3T3fACPBhodHRwOi8vZHguZG9pLm9yZy8xMC4xMDM4L2E=');
      // An offset is not a valid continuation of a cursor walk, so none is offered.
      expect(wire.nextWorksOffset).toBeUndefined();
      expect(wire.notice).toBeUndefined();
    });

    it('reads a blank works_cursor as absent and stays on offset paging', async () => {
      const ctx = createMockContext({ errors: searchFundersTool.errors });
      mockSearchFunders.mockResolvedValue(funderList([RAW_FUNDER], 1));
      mockGetFunderWorks.mockResolvedValue({
        totalResults: 559033,
        itemsPerPage: 2,
        items: [{ DOI: '10.1038/a' }, { DOI: '10.1038/b' }],
      });

      // A form-based client sends "" for an optional field nobody filled in.
      const input = searchFundersTool.input.parse({
        funder_doi: '10.13039/100000001',
        include_works: true,
        rows: 2,
        works_cursor: '',
      });
      const result = await searchFundersTool.handler(input, ctx);

      // Taking "" as a cursor sends neither selector upstream, so Crossref answers page one
      // with no next-cursor, and the cursor branch withholds nextWorksOffset as well — a
      // 559033-work list truncated to its first page with no field saying so.
      expect(mockGetFunderWorks).toHaveBeenCalledWith(
        '100000001',
        { rows: 2, offset: 0 },
        expect.anything(),
      );
      const wire = wireSchema.parse({ ...result, ...getEnrichment(ctx) });
      expect(wire.nextWorksOffset).toBe(2);
      expect(wire.nextWorksCursor).toBeUndefined();
    });

    it('ignores works_cursor paired with works_offset when include_works is false', async () => {
      const ctx = createMockContext({ errors: searchFundersTool.errors });
      mockSearchFunders.mockResolvedValue(funderList([RAW_FUNDER], 1));

      // Without a works list neither input selects anything, so the pair is not a conflict.
      const input = searchFundersTool.input.parse({
        funder_doi: '10.13039/100000001',
        include_works: false,
        works_cursor: '*',
        works_offset: 20,
      });
      const result = await searchFundersTool.handler(input, ctx);

      expect(result.fundedWorks).toBeUndefined();
      expect(mockGetFunderWorks).not.toHaveBeenCalled();
    });

    it('continues a cursor walk from a returned token', async () => {
      const ctx = createMockContext({ errors: searchFundersTool.errors });
      mockSearchFunders.mockResolvedValue(funderList([RAW_FUNDER], 1));
      mockGetFunderWorks.mockResolvedValue({
        totalResults: 559033,
        itemsPerPage: 2,
        items: [{ DOI: '10.1038/c' }, { DOI: '10.1038/d' }],
        nextCursor: 'page-three-token',
      });

      const input = searchFundersTool.input.parse({
        funder_doi: '100000001',
        include_works: true,
        rows: 2,
        works_cursor: 'page-two-token',
      });
      const result = await searchFundersTool.handler(input, ctx);

      expect(mockGetFunderWorks).toHaveBeenCalledWith(
        '100000001',
        { rows: 2, cursor: 'page-two-token' },
        expect.anything(),
      );
      const wire = wireSchema.parse({ ...result, ...getEnrichment(ctx) });
      expect(wire.nextWorksCursor).toBe('page-three-token');
      expect(result.fundedWorks?.map((w) => w.doi)).toEqual(['10.1038/c', '10.1038/d']);
    });

    it('withholds nextWorksCursor once the walk runs off the end of the works list', async () => {
      const ctx = createMockContext({ errors: searchFundersTool.errors });
      mockSearchFunders.mockResolvedValue(funderList([RAW_FUNDER], 1));
      // Crossref has handed a token back on the empty page past the end — the empty page is the signal.
      mockGetFunderWorks.mockResolvedValue({
        totalResults: 559033,
        itemsPerPage: 2,
        items: [],
        nextCursor: 'a-token-that-yields-nothing',
      });

      const input = searchFundersTool.input.parse({
        funder_doi: '100000001',
        include_works: true,
        rows: 2,
        works_cursor: 'last-token',
      });
      const result = await searchFundersTool.handler(input, ctx);

      const wire = wireSchema.parse({ ...result, ...getEnrichment(ctx) });
      // Absence of a continuation field means "exhausted" on the offset path; handing back a
      // token here would break that on the cursor path and loop a caller forever.
      expect(wire.nextWorksCursor).toBeUndefined();
      expect(result.fundedWorks).toHaveLength(0);
    });

    it('throws works_cursor_offset_conflict when a cursor is paired with a spendable offset', async () => {
      const ctx = createMockContext({ errors: searchFundersTool.errors });

      const input = searchFundersTool.input.parse({
        funder_doi: '100000001',
        include_works: true,
        works_cursor: '*',
        works_offset: 20,
      });
      await expect(searchFundersTool.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'works_cursor_offset_conflict', worksOffset: 20 },
      });
      expect(mockSearchFunders).not.toHaveBeenCalled();
    });

    it('accepts a cursor alongside the works_offset schema default', async () => {
      const ctx = createMockContext({ errors: searchFundersTool.errors });
      mockSearchFunders.mockResolvedValue(funderList([RAW_FUNDER], 1));
      mockGetFunderWorks.mockResolvedValue({ totalResults: 5, itemsPerPage: 10, items: [] });

      // works_offset defaults to 0, so every cursor call carries one. Zero is the start of the
      // list and is never sent upstream — rejecting it would make the cursor input unusable.
      const input = searchFundersTool.input.parse({
        funder_doi: '100000001',
        include_works: true,
        works_cursor: '*',
      });
      expect(input.works_offset).toBe(0);
      await expect(searchFundersTool.handler(input, ctx)).resolves.toBeDefined();
    });

    it('carries nextWorksCursor onto both structuredContent and content[]', async () => {
      mockSearchFunders.mockResolvedValue(funderList([RAW_FUNDER], 1));
      mockGetFunderWorks.mockResolvedValue({
        totalResults: 559033,
        itemsPerPage: 1,
        items: [{ DOI: '10.1038/a' }],
        nextCursor: 'wire-token',
      });

      const result = await runToolContract(searchFundersTool, {
        funder_doi: '100000001',
        include_works: true,
        rows: 1,
        works_cursor: '*',
      });

      expect(result.structuredContent).toMatchObject({ nextWorksCursor: 'wire-token' });
      const text = result.content.map(blockText).join('\n');
      expect(text).toContain('nextWorksCursor');
      expect(text).toContain('wire-token');
    });

    it('discloses the 100000 ceiling on the funder list page', async () => {
      const ctx = createMockContext({ errors: searchFundersTool.errors });
      mockSearchFunders.mockResolvedValue(
        funderList(
          Array.from({ length: 10 }, () => RAW_FUNDER),
          169_103,
        ),
      );

      const input = searchFundersTool.input.parse({
        query: 'a',
        rows: 10,
        offset: 99_990,
      });
      const result = await searchFundersTool.handler(input, ctx);

      const wire = wireSchema.parse({ ...result, ...getEnrichment(ctx) });
      expect(wire.nextOffset).toBeUndefined();
      expect(wire.notice).toContain('100000');
      expect(wire.notice).toContain('169103');
    });

    it('cuts a page that would pass 100000 to the rows that fit, and throws offset_too_large at it before any upstream call', async () => {
      const ctx = createMockContext({ errors: searchFundersTool.errors });
      mockSearchFunders.mockResolvedValue(funderList([], 2252));

      const input = searchFundersTool.input.parse({ query: 'National', rows: 10, offset: 99_995 });
      await searchFundersTool.handler(input, ctx);
      expect(mockSearchFunders).toHaveBeenCalledWith(
        expect.objectContaining({ offset: 99_995, rows: 5 }),
        expect.anything(),
      );

      mockSearchFunders.mockClear();
      const atCap = searchFundersTool.input.parse({ query: 'National', rows: 10, offset: 100_000 });
      await expect(searchFundersTool.handler(atCap, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'offset_too_large', cap: 100_000 },
      });
      expect(mockSearchFunders).not.toHaveBeenCalled();
    });

    it('cuts and refuses works pages at the ten-times-lower works ceiling', async () => {
      const ctx = createMockContext({ errors: searchFundersTool.errors });
      mockSearchFunders.mockResolvedValue(funderList([RAW_FUNDER], 1));
      mockGetFunderWorks.mockResolvedValue({ totalResults: 559_017, items: [] });

      const input = searchFundersTool.input.parse({
        funder_doi: '100000001',
        include_works: true,
        rows: 10,
        works_offset: 9_995,
      });
      await searchFundersTool.handler(input, ctx);
      expect(mockGetFunderWorks).toHaveBeenCalledWith(
        '100000001',
        { rows: 5, offset: 9_995 },
        expect.anything(),
      );

      mockSearchFunders.mockClear();
      const atCap = searchFundersTool.input.parse({
        funder_doi: '100000001',
        include_works: true,
        rows: 10,
        works_offset: 10_000,
      });
      await expect(searchFundersTool.handler(atCap, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'works_offset_too_large', cap: 10_000 },
      });
      expect(mockSearchFunders).not.toHaveBeenCalled();
    });

    it('carries paging metadata on both structuredContent and content[]', async () => {
      mockSearchFunders.mockResolvedValue(funderList([RAW_FUNDER, RAW_FUNDER], 2252));

      const result = await runToolContract(searchFundersTool, {
        query: 'National',
        rows: 2,
        offset: 2,
      });

      expect(result.structuredContent).toMatchObject({
        fundersTotal: 2252,
        funderCount: 2,
        nextOffset: 4,
      });
      const text = result.content.map(blockText).join('\n');
      expect(text).toContain('2252');
      expect(text).toContain('nextOffset');
      expect(text).toContain('4');
    });
  });

  describe('ambiguity recovery', () => {
    const BNB = { id: '100031012', name: 'Nationale Bank van België', location: 'Belgium' };
    const OENB = { id: '501100004061', name: 'Oesterreichische Nationalbank', location: 'Austria' };
    const BNF = {
      id: '501100006427',
      name: 'Bibliothèque nationale de France',
      location: 'France',
    };

    it('throws ambiguous_funder instead of silently resolving the first match', async () => {
      const ctx = createMockContext({ errors: searchFundersTool.errors });
      mockSearchFunders.mockResolvedValue(funderList([BNB, OENB, BNF], 2252));

      const input = searchFundersTool.input.parse({
        query: 'National',
        include_works: true,
        rows: 3,
      });
      await expect(searchFundersTool.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'ambiguous_funder' },
      });
      expect(mockGetFunderWorks).not.toHaveBeenCalled();
    });

    it('names each listed funder and its registry ID in the error message', async () => {
      const ctx = createMockContext({ errors: searchFundersTool.errors });
      mockSearchFunders.mockResolvedValue(funderList([BNB, OENB, BNF], 3));

      const input = searchFundersTool.input.parse({
        query: 'National',
        include_works: true,
        rows: 3,
      });
      const err = await Promise.resolve(searchFundersTool.handler(input, ctx)).catch(
        (e: unknown) => e,
      );

      const message = (err as { message: string }).message;
      expect(message).toContain('matched 3 funders');
      expect(message).toContain('100031012');
      expect(message).toContain('501100004061');
      expect(message).toContain('501100006427');
      expect(message).toContain('Bibliothèque nationale de France');
    });

    it('reports the upstream match count, not the page length, when the page is partial', async () => {
      const ctx = createMockContext({ errors: searchFundersTool.errors });
      mockSearchFunders.mockResolvedValue(funderList([BNB, OENB, BNF], 2252));

      const input = searchFundersTool.input.parse({
        query: 'National',
        include_works: true,
        rows: 3,
      });
      const err = await Promise.resolve(searchFundersTool.handler(input, ctx)).catch(
        (e: unknown) => e,
      );

      const message = (err as { message: string }).message;
      // 2252 funders matched; three are listed. Saying "matched 3" would hide from the caller
      // both the size of the choice and the chance the funder it wants is not on this page.
      expect(message).toContain('matched 2252 funders');
      expect(message).toContain('this page lists 3');
      expect(message).not.toContain('matched 3 funders');
      expect(message).toContain('narrow the query');
      expect((err as { data: { matchedTotal: number } }).data.matchedTotal).toBe(2252);
    });

    it('throws when a single-record page is one of many matches', async () => {
      const ctx = createMockContext({ errors: searchFundersTool.errors });
      // rows=1 returns one funder out of 2252. The page is unambiguous; the caller's choice is
      // not — nothing selected this funder, so resolving its works is the silent pick again.
      mockSearchFunders.mockResolvedValue(funderList([BNB], 2252));

      const input = searchFundersTool.input.parse({
        query: 'National',
        include_works: true,
        rows: 1,
      });
      await expect(searchFundersTool.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'ambiguous_funder', matchedTotal: 2252 },
      });
      expect(mockGetFunderWorks).not.toHaveBeenCalled();
    });

    it('marks a candidate with no registry ID rather than dropping it', async () => {
      const ctx = createMockContext({ errors: searchFundersTool.errors });
      mockSearchFunders.mockResolvedValue(funderList([BNB, { name: 'Funder With No ID' }], 2));

      const input = searchFundersTool.input.parse({ query: 'National', include_works: true });
      const err = await Promise.resolve(searchFundersTool.handler(input, ctx)).catch(
        (e: unknown) => e,
      );

      expect((err as { message: string }).message).toContain('no registry ID');
      expect((err as { data: { candidates: unknown[] } }).data.candidates).toHaveLength(2);
    });

    it('exposes the candidate registry IDs in the error data for structured clients', async () => {
      const ctx = createMockContext({ errors: searchFundersTool.errors });
      mockSearchFunders.mockResolvedValue(funderList([BNB, OENB], 2252));

      const input = searchFundersTool.input.parse({ query: 'National', include_works: true });
      await expect(searchFundersTool.handler(input, ctx)).rejects.toMatchObject({
        data: {
          reason: 'ambiguous_funder',
          candidates: [
            { name: 'Nationale Bank van België', id: '100031012' },
            { name: 'Oesterreichische Nationalbank', id: '501100004061' },
          ],
        },
      });
    });

    it('does not throw ambiguous_funder when funder_doi pins the target', async () => {
      const ctx = createMockContext({ errors: searchFundersTool.errors });
      mockSearchFunders.mockResolvedValue(funderList([RAW_FUNDER], 1));
      mockGetFunderWorks.mockResolvedValue({ totalResults: 5, itemsPerPage: 10, items: [] });

      const input = searchFundersTool.input.parse({
        funder_doi: '10.13039/100000001',
        include_works: true,
      });
      const result = await searchFundersTool.handler(input, ctx);

      expect(result.fundedWorks).toHaveLength(0);
      expect(mockGetFunderWorks).toHaveBeenCalled();
    });

    it('does not throw ambiguous_funder when include_works is false', async () => {
      const ctx = createMockContext({ errors: searchFundersTool.errors });
      mockSearchFunders.mockResolvedValue(funderList([BNB, OENB, BNF], 2252));

      const input = searchFundersTool.input.parse({ query: 'National', rows: 3 });
      const result = await searchFundersTool.handler(input, ctx);

      expect(result.funders).toHaveLength(3);
      expect(result.fundedWorks).toBeUndefined();
    });

    it('surfaces the registry IDs on both error surfaces through the full contract', async () => {
      mockSearchFunders.mockResolvedValue(funderList([BNB, OENB], 2252));

      const result = await runToolContract(searchFundersTool, {
        query: 'National',
        include_works: true,
      });

      expect(result.isError).toBe(true);
      const text = result.content.map(blockText).join('\n');
      expect(text).toContain('100031012');
      expect(text).toContain('501100004061');
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason: 'ambiguous_funder' } },
      });
    });
  });
});

/**
 * `rows` on this tool caps at Crossref's own page maximum of 1000, which the schema already
 * enforces, so every value it accepts reaches both requests as sent unless an offset window cuts it.
 */
describe('searchFundersTool rows at the page maximum', () => {
  const funders = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      ...RAW_FUNDER,
      id: `1000${i}`,
      name: `Funder ${i}`,
    }));
  const works = (count: number) =>
    Array.from({ length: count }, (_, i) => ({ DOI: `10.5555/f${i}` }));

  it('sends rows 1000 to the funder list as requested, with no notice', async () => {
    mockSearchFunders.mockResolvedValue({ totalResults: 5000, items: funders(1000) });

    const result = await runToolContract(searchFundersTool, {
      query: 'Funder',
      rows: 1000,
      offset: 40,
    });

    expect(mockSearchFunders).toHaveBeenCalledWith(
      expect.objectContaining({ rows: 1000, offset: 40 }),
      expect.anything(),
    );
    expect(result.structuredContent).toMatchObject({ funderCount: 1000, nextOffset: 1040 });
    expect((result.structuredContent as { notice?: string }).notice).toBeUndefined();
    expect(result.content.map(blockText).join('\n')).toContain('## Funder 999');
  });

  it('sends rows 1000 to the funded-works list as requested, continuing nextWorksOffset after it', async () => {
    mockSearchFunders.mockResolvedValue({ totalResults: 1, items: [RAW_FUNDER] });
    mockGetFunderWorks.mockResolvedValue({ totalResults: 250_000, items: works(1000) });

    const result = await runToolContract(searchFundersTool, {
      funder_doi: '100000001',
      include_works: true,
      rows: 1000,
      works_offset: 200,
    });

    expect(mockGetFunderWorks).toHaveBeenCalledWith(
      '100000001',
      { rows: 1000, offset: 200 },
      expect.anything(),
    );
    expect(result.structuredContent).toMatchObject({ nextWorksOffset: 1200 });
    expect((result.structuredContent as { notice?: string }).notice).toBeUndefined();
  });

  it('reaches works_offset 9000 + rows 1000, the last full page offset paging allows', async () => {
    mockSearchFunders.mockResolvedValue({ totalResults: 1, items: [RAW_FUNDER] });
    mockGetFunderWorks.mockResolvedValue({ totalResults: 250_000, items: works(1000) });

    const result = await runToolContract(searchFundersTool, {
      funder_doi: '100000001',
      include_works: true,
      rows: 1000,
      works_offset: 9000,
    });

    expect(result.isError).toBeFalsy();
    expect(mockGetFunderWorks).toHaveBeenCalledWith(
      '100000001',
      { rows: 1000, offset: 9000 },
      expect.anything(),
    );
    expect((result.structuredContent as { notice?: string }).notice).toBe(
      'This is the last works page reachable by works_offset — Crossref caps works_offset + rows at 10000 on a funded-works list and 250000 works exist. Re-run with works_cursor="*" and chain nextWorksCursor to read the whole list; the walk restarts at the most recently registered work and runs by registration date, not publication date.',
    );
  });

  it('applies the 950 works that fit at works_offset 9050 + rows 1000', async () => {
    mockSearchFunders.mockResolvedValue({ totalResults: 1, items: [RAW_FUNDER] });
    mockGetFunderWorks.mockResolvedValue({ totalResults: 250_000, items: works(950) });

    const result = await runToolContract(searchFundersTool, {
      funder_doi: '100000001',
      include_works: true,
      rows: 1000,
      works_offset: 9050,
    });

    expect(result.isError).toBeFalsy();
    expect(mockGetFunderWorks).toHaveBeenCalledWith(
      '100000001',
      { rows: 950, offset: 9050 },
      expect.anything(),
    );
    expect((result.structuredContent as { notice?: string }).notice).toBe(
      'works_offset 9050 + rows 1000 would pass the 10000 ceiling Crossref puts on works_offset + rows on a funded-works list, so 950 was applied — the last works page reachable by works_offset, and 250000 works exist. Re-run with works_cursor="*" and chain nextWorksCursor to read the whole list; the walk restarts at the most recently registered work and runs by registration date, not publication date.',
    );
  });
});

/**
 * Both Crossref ceilings are on `offset + rows`, accepted up to exactly the cap. Every request a
 * page or a rejection tells the caller to make next has to be one the next call accepts, so each
 * recipe is executed.
 */
describe('searchFundersTool offset-ceiling recipes', () => {
  type ErrorShape = { error?: { data?: { reason?: string; recovery?: { hint?: string } } } };
  const hintOf = (result: { structuredContent?: unknown }) =>
    (result.structuredContent as ErrorShape).error?.data?.recovery?.hint ?? '';
  const works = (count: number) =>
    Array.from({ length: count }, (_, i) => ({ DOI: `10.5555/f${i}` }));
  const named = (count: number) =>
    Array.from({ length: count }, (_, i) => ({ ...RAW_FUNDER, id: `1000${i}`, name: `F ${i}` }));

  it('applies the rows that still fit when works_offset + rows passes 10000', async () => {
    mockSearchFunders.mockResolvedValue({ totalResults: 1, items: [RAW_FUNDER] });
    mockGetFunderWorks.mockResolvedValue({ totalResults: 250_000, items: works(50) });

    const page = await runToolContract(searchFundersTool, {
      funder_doi: '100000001',
      include_works: true,
      rows: 100,
      works_offset: 9950,
    });

    expect(page.isError).toBeFalsy();
    expect(mockGetFunderWorks).toHaveBeenCalledWith(
      '100000001',
      { rows: 50, offset: 9950 },
      expect.anything(),
    );
    const notice =
      'works_offset 9950 + rows 100 would pass the 10000 ceiling Crossref puts on works_offset + rows on a funded-works list, so 50 was applied — the last works page reachable by works_offset, and 250000 works exist. Re-run with works_cursor="*" and chain nextWorksCursor to read the whole list; the walk restarts at the most recently registered work and runs by registration date, not publication date.';
    expect((page.structuredContent as { notice?: string }).notice).toBe(notice);
    expect(renderedText(contentText(page.content))).toContain(notice);
  });

  it('routes only to works_cursor once works_offset itself reaches 10000', async () => {
    const rejected = await runToolContract(searchFundersTool, {
      funder_doi: '100000001',
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

  it('applies the rows that still fit when offset + rows passes 100000 on name search', async () => {
    mockSearchFunders.mockResolvedValue({ totalResults: 200_000, items: named(50) });

    const page = await runToolContract(searchFundersTool, {
      query: 'council',
      rows: 100,
      offset: 99_950,
    });

    expect(page.isError).toBeFalsy();
    expect(mockSearchFunders).toHaveBeenCalledWith(
      expect.objectContaining({ rows: 50, offset: 99_950 }),
      expect.anything(),
    );
    expect((page.structuredContent as { notice?: string }).notice).toMatch(
      /^offset 99950 \+ rows 100 would pass the 100000 ceiling Crossref puts on offset \+ rows on funder name search, so 50 was applied — /,
    );
  });

  it('hands out the works_offset short of the ceiling, and that page cuts itself to the rows that fit', async () => {
    mockSearchFunders.mockResolvedValue({ totalResults: 1, items: [RAW_FUNDER] });
    mockGetFunderWorks.mockResolvedValue({ totalResults: 250_000, items: works(1000) });

    const page = await runToolContract(searchFundersTool, {
      funder_doi: '100000001',
      include_works: true,
      rows: 1000,
      works_offset: 8950,
    });

    const structured = page.structuredContent as { notice?: string; nextWorksOffset?: number };
    expect(structured.nextWorksOffset).toBe(9950);
    expect(structured.notice).toBeUndefined();

    mockGetFunderWorks.mockResolvedValue({ totalResults: 250_000, items: works(50) });
    const next = await runToolContract(searchFundersTool, {
      funder_doi: '100000001',
      include_works: true,
      rows: 1000,
      works_offset: 9950,
    });
    expect(next.isError).toBeFalsy();
    expect(mockGetFunderWorks).toHaveBeenLastCalledWith(
      '100000001',
      { rows: 50, offset: 9950 },
      expect.anything(),
    );
    expect((next.structuredContent as { fundedWorks: unknown[] }).fundedWorks).toHaveLength(50);
  });

  it('hands out the offset short of the ceiling, and that page cuts itself to the rows that fit', async () => {
    mockSearchFunders.mockResolvedValue({ totalResults: 200_000, items: named(100) });

    const page = await runToolContract(searchFundersTool, {
      query: 'council',
      rows: 100,
      offset: 99_850,
    });

    const structured = page.structuredContent as { notice?: string; nextOffset?: number };
    expect(structured.nextOffset).toBe(99_950);
    expect(structured.notice).toBeUndefined();

    mockSearchFunders.mockResolvedValue({ totalResults: 200_000, items: named(50) });
    const next = await runToolContract(searchFundersTool, {
      query: 'council',
      rows: 100,
      offset: 99_950,
    });
    expect(next.isError).toBeFalsy();
    expect(mockSearchFunders).toHaveBeenLastCalledWith(
      expect.objectContaining({ rows: 50, offset: 99_950 }),
      expect.anything(),
    );
    expect((next.structuredContent as { funderCount?: number }).funderCount).toBe(50);
  });
});

/**
 * Every (offset, rows) pair either side of each offset window, against fakes that answer the way
 * Crossref does: the records when `offset + rows` fits the route's ceiling, a rejection when it
 * does not (live: `offset + rows` exactly at the ceiling → 200, one past → 400, on both routes).
 * Offsets are written relative to the ceiling, so one table drives both guards. `rows` here has
 * no per-call cap below Crossref's page maximum of 1000, which the schema enforces, so 1001 is
 * refused before either window applies. `applied` is the page returned and `next` the
 * continuation offset handed out (null: withheld at the ceiling). `v050` is what the published
 * 0.5.0 returned — rows capped at 100, the window checked on the capped rows, every pair that
 * passed it refused. A pair 0.5.0 answered is answered here with at least as many records.
 */
describe('searchFundersTool offset windows', () => {
  type Notice = 'none' | 'last' | 'cut';
  // [offset - ceiling, rows, applied (null: refused; 'invalid': schema), next - ceiling (null: withheld), notice, 0.5.0 applied]
  type Row = [number, number, number | null | 'invalid', number | null, Notice, number | null];
  const WINDOW: Row[] = [
    [-1, 1, 1, null, 'last', 1],
    [-1, 100, 1, null, 'cut', null],
    [-1, 101, 1, null, 'cut', null],
    [-1, 1000, 1, null, 'cut', null],
    [-50, 1, 1, -49, 'none', 1],
    [-50, 100, 50, null, 'cut', null],
    [-50, 101, 50, null, 'cut', null],
    [-50, 1000, 50, null, 'cut', null],
    [-100, 1, 1, -99, 'none', 1],
    [-100, 100, 100, null, 'last', 100],
    [-100, 101, 100, null, 'cut', 100],
    [-100, 1000, 100, null, 'cut', 100],
    [-101, 1, 1, -100, 'none', 1],
    [-101, 100, 100, -1, 'none', 100],
    [-101, 101, 101, null, 'last', 100],
    [-101, 1000, 101, null, 'cut', 100],
    ...[1, 100, 101, 1000].flatMap((rows): Row[] => [
      [0, rows, null, null, 'none', null],
      [1, rows, null, null, 'none', null],
    ]),
    ...[-1, -50, -100, -101, 0, 1].map(
      (delta): Row => [delta, 1001, 'invalid', null, 'none', null],
    ),
  ];
  const works = (count: number) =>
    Array.from({ length: count }, (_, i) => ({ DOI: `10.5555/f${i}` }));
  const named = (count: number) =>
    Array.from({ length: count }, (_, i) => ({ ...RAW_FUNDER, id: `1000${i}`, name: `F ${i}` }));

  type Structured = {
    funderCount?: number;
    fundedWorks?: unknown[];
    nextOffset?: number;
    nextWorksOffset?: number;
    notice?: string;
    error?: { code?: number; data?: { reason?: string } };
  };

  describe('the funder name list (ceiling 100000)', () => {
    const CEILING = 100_000;
    const ROUTE =
      'the last funder page reachable by offset, and 200000 funders matched. Narrow the query to bring the rest into reach.';

    beforeEach(() => {
      mockSearchFunders.mockImplementation(async (opts: { offset: number; rows: number }) => {
        if (opts.offset + opts.rows > CEILING)
          throw new Error(`Crossref refuses offset ${opts.offset} + rows ${opts.rows}`);
        return funderList(named(opts.rows), 200_000);
      });
    });

    it.each(WINDOW)(
      'offset 100000 + (%i), rows %i → %s funders (next: 100000 + (%s); notice: %s; 0.5.0: %s)',
      async (delta, rows, applied, nextDelta, notice, v050) => {
        const offset = CEILING + delta;
        const result = await runToolContract(searchFundersTool, { query: 'council', rows, offset });
        const structured = result.structuredContent as Structured;

        if (applied === 'invalid') {
          expect(structured.error?.code).toBe(JsonRpcErrorCode.InvalidParams);
          expect(mockSearchFunders).not.toHaveBeenCalled();
          return;
        }
        if (applied === null) {
          expect(structured.error?.data?.reason).toBe('offset_too_large');
          expect(mockSearchFunders).not.toHaveBeenCalled();
          return;
        }
        expect(result.isError).toBeFalsy();
        expect(mockSearchFunders).toHaveBeenCalledWith(
          expect.objectContaining({ offset, rows: applied }),
          expect.anything(),
        );
        expect(structured.funderCount).toBe(applied);
        if (v050 !== null) expect(applied).toBeGreaterThanOrEqual(v050);
        expect(structured.nextOffset).toBe(nextDelta === null ? undefined : CEILING + nextDelta);
        const expected = {
          none: undefined,
          last: 'This is the last funder page reachable by offset — Crossref caps offset + rows at 100000 on funder search and 200000 funders matched. Narrow the query to bring the rest into reach.',
          cut: `offset ${offset} + rows ${rows} would pass the 100000 ceiling Crossref puts on offset + rows on funder name search, so ${applied} was applied — ${ROUTE}`,
        }[notice];
        expect(structured.notice).toBe(expected);
      },
    );

    it('carries a window-cut page identically on both surfaces', async () => {
      const result = await runToolContract(searchFundersTool, {
        query: 'council',
        rows: 1000,
        offset: 99_900,
      });

      const structured = result.structuredContent as Structured & {
        funders: Array<{ id?: string }>;
      };
      const notice = `offset 99900 + rows 1000 would pass the 100000 ceiling Crossref puts on offset + rows on funder name search, so 100 was applied — ${ROUTE}`;
      expect(structured.notice).toBe(notice);
      const lines = renderedText(contentText(result.content)).split('\n');
      expect(lines.some((line) => line.endsWith(notice))).toBe(true);
      expect(structured.funders).toHaveLength(100);
      for (const funder of structured.funders) expect(lines).toContain(`ID: ${funder.id}`);
    });

    /** A cut page that ends the list has nothing past it to route to. */
    it('says only that the rows were cut when the list ends at the ceiling', async () => {
      mockSearchFunders.mockImplementation(async (opts: { rows: number }) =>
        funderList(named(opts.rows), CEILING),
      );

      const result = await runToolContract(searchFundersTool, {
        query: 'council',
        rows: 100,
        offset: 99_950,
      });

      const structured = result.structuredContent as Structured;
      const notice =
        'offset 99950 + rows 100 would pass the 100000 ceiling Crossref puts on offset + rows on funder name search, so 50 was applied.';
      expect(structured.funderCount).toBe(50);
      expect(structured.nextOffset).toBeUndefined();
      expect(structured.notice).toBe(notice);
      const lines = renderedText(contentText(result.content)).split('\n');
      expect(lines.some((line) => line.endsWith(notice))).toBe(true);
    });
  });

  describe('the funded-works list (ceiling 10000)', () => {
    const CEILING = 10_000;
    const ROUTE =
      'the last works page reachable by works_offset, and 250000 works exist. Re-run with works_cursor="*" and chain nextWorksCursor to read the whole list; the walk restarts at the most recently registered work and runs by registration date, not publication date.';

    beforeEach(() => {
      mockSearchFunders.mockResolvedValue(funderList([RAW_FUNDER], 1));
      mockGetFunderWorks.mockImplementation(
        async (_id: string, opts: { offset: number; rows: number }) => {
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
        const result = await runToolContract(searchFundersTool, {
          funder_doi: '100000001',
          include_works: true,
          rows,
          works_offset: worksOffset,
        });
        const structured = result.structuredContent as Structured;

        if (applied === 'invalid') {
          expect(structured.error?.code).toBe(JsonRpcErrorCode.InvalidParams);
          expect(mockSearchFunders).not.toHaveBeenCalled();
          return;
        }
        if (applied === null) {
          expect(structured.error?.data?.reason).toBe('works_offset_too_large');
          expect(mockSearchFunders).not.toHaveBeenCalled();
          return;
        }
        expect(result.isError).toBeFalsy();
        expect(mockGetFunderWorks).toHaveBeenCalledWith(
          '100000001',
          { rows: applied, offset: worksOffset },
          expect.anything(),
        );
        expect(structured.fundedWorks).toHaveLength(applied);
        if (v050 !== null) expect(applied).toBeGreaterThanOrEqual(v050);
        expect(structured.nextWorksOffset).toBe(
          nextDelta === null ? undefined : CEILING + nextDelta,
        );
        const expected = {
          none: undefined,
          last: 'This is the last works page reachable by works_offset — Crossref caps works_offset + rows at 10000 on a funded-works list and 250000 works exist. Re-run with works_cursor="*" and chain nextWorksCursor to read the whole list; the walk restarts at the most recently registered work and runs by registration date, not publication date.',
          cut: `works_offset ${worksOffset} + rows ${rows} would pass the 10000 ceiling Crossref puts on works_offset + rows on a funded-works list, so ${applied} was applied — ${ROUTE}`,
        }[notice];
        expect(structured.notice).toBe(expected);
      },
    );

    it('carries a window-cut page identically on both surfaces', async () => {
      const result = await runToolContract(searchFundersTool, {
        funder_doi: '100000001',
        include_works: true,
        rows: 1000,
        works_offset: 9950,
      });

      const structured = result.structuredContent as Structured & {
        fundedWorks: Array<{ doi: string }>;
      };
      const notice = `works_offset 9950 + rows 1000 would pass the 10000 ceiling Crossref puts on works_offset + rows on a funded-works list, so 50 was applied — ${ROUTE}`;
      expect(structured.notice).toBe(notice);
      const lines = renderedText(contentText(result.content)).split('\n');
      expect(lines.some((line) => line.endsWith(notice))).toBe(true);
      expect(structured.fundedWorks).toHaveLength(50);
      for (const work of structured.fundedWorks) expect(lines).toContain(`DOI: ${work.doi}`);
    });

    /** A cut page that ends the list has nothing past it to route to. */
    it('says only that the rows were cut when the list ends at the ceiling', async () => {
      mockGetFunderWorks.mockImplementation(async (_id: string, opts: { rows: number }) => ({
        totalResults: CEILING,
        items: works(opts.rows),
      }));

      const result = await runToolContract(searchFundersTool, {
        funder_doi: '100000001',
        include_works: true,
        rows: 100,
        works_offset: 9950,
      });

      const structured = result.structuredContent as Structured;
      const notice =
        'works_offset 9950 + rows 100 would pass the 10000 ceiling Crossref puts on works_offset + rows on a funded-works list, so 50 was applied.';
      expect(structured.fundedWorks).toHaveLength(50);
      expect(structured.nextWorksOffset).toBeUndefined();
      expect(structured.notice).toBe(notice);
      const lines = renderedText(contentText(result.content)).split('\n');
      expect(lines.some((line) => line.endsWith(notice))).toBe(true);
    });

    it('cuts the works list alone, leaving the funder list at the rows requested', async () => {
      const result = await runToolContract(searchFundersTool, {
        query: 'National Science Foundation',
        include_works: true,
        rows: 1000,
        works_offset: 9500,
      });

      expect(result.isError).toBeFalsy();
      expect(mockSearchFunders).toHaveBeenCalledWith(
        expect.objectContaining({ query: 'National Science Foundation', rows: 1000 }),
        expect.anything(),
      );
      expect(mockGetFunderWorks).toHaveBeenCalledWith(
        '100000001',
        { rows: 500, offset: 9500 },
        expect.anything(),
      );
    });

    it('leaves a works_cursor walk untouched by the window', async () => {
      mockGetFunderWorks.mockResolvedValue({ totalResults: 250_000, items: works(1000) });

      await runToolContract(searchFundersTool, {
        funder_doi: '100000001',
        include_works: true,
        rows: 1000,
        works_cursor: '*',
      });

      expect(mockGetFunderWorks).toHaveBeenCalledWith(
        '100000001',
        { rows: 1000, cursor: '*' },
        expect.anything(),
      );
    });
  });
});

/**
 * The funded-works list counts a funder's registry descendants and the `funder` filter does not,
 * so a filtered count with sub-agencies needs their IDs: a funder_doi lookup relays them whole.
 * Records are live `/funders/{id}` captures — NIH (59 descendants, NCI's own among them), the
 * European Commission (195, the longest list across 24 umbrella funders), and DFG (none).
 */
describe('searchFundersTool registry descendants', () => {
  type RawFunder = { id: string; name: string; 'work-count': number; descendants: string[] };
  const captured = (id: string): RawFunder =>
    (
      JSON.parse(
        readFileSync(new URL(`../fixtures/funders/${id}.json`, import.meta.url), 'utf8'),
      ) as { message: RawFunder }
    ).message;
  const NIH = captured('100000002');
  const NCI = captured('100000054');
  const EC = captured('501100000780');
  const DFG = captured('501100001659');

  type Structured = { funders: Array<Record<string, unknown>> };
  const funderOf = (result: { structuredContent?: unknown }) =>
    (result.structuredContent as Structured).funders[0];
  /** The lines a CommonMark reader sees in `content[]`, escapes resolved. */
  const readLines = (result: { content: Parameters<typeof contentText>[0] }) =>
    renderedText(contentText(result.content)).split('\n');

  it('relays every descendant at every depth on both surfaces of a funder_doi lookup', async () => {
    mockSearchFunders.mockResolvedValue(funderList([NIH]));

    const result = await runToolContract(searchFundersTool, { funder_doi: '100000002' });

    expect(result.isError).toBeFalsy();
    const funder = funderOf(result);
    expect(funder?.descendants).toEqual(NIH.descendants);
    expect(funder?.descendants).toHaveLength(59);
    // NCI sits under NIH, and the institutes under NCI are on NIH's list too — not its children alone.
    expect(NCI.descendants).toHaveLength(7);
    expect(funder?.descendants).toEqual(expect.arrayContaining([NCI.id, ...NCI.descendants]));
    expect(readLines(result)).toContain(`Descendants (59): ${NIH.descendants.join(', ')}`);
  });

  it('returns the longest list whole, uncapped, on both surfaces', async () => {
    mockSearchFunders.mockResolvedValue(funderList([EC]));

    const result = await runToolContract(searchFundersTool, { funder_doi: '501100000780' });

    expect(EC.descendants).toHaveLength(195);
    expect(funderOf(result)?.descendants).toEqual(EC.descendants);
    expect(readLines(result)).toContain(`Descendants (195): ${EC.descendants.join(', ')}`);
    expect((result.structuredContent as { notice?: string }).notice).toBeUndefined();
  });

  it('carries no field and no line for a funder with no descendants', async () => {
    mockSearchFunders.mockResolvedValue(funderList([DFG]));

    const result = await runToolContract(searchFundersTool, { funder_doi: '501100001659' });

    expect(DFG.descendants).toEqual([]);
    expect(result.isError).toBeFalsy();
    expect(funderOf(result)).not.toHaveProperty('descendants');
    expect(contentText(result.content)).not.toContain('Descendants');
  });

  /**
   * Crossref's name search returns rows without `descendants`; the lookup path is what the field
   * rides, so a name page of umbrella funders is never carrying ~2.5 KB of IDs per row.
   */
  it('never carries descendants on a name-query row, even one whose record lists them', async () => {
    mockSearchFunders.mockResolvedValue(funderList([NIH]));

    const result = await runToolContract(searchFundersTool, {
      query: 'National Institutes of Health',
    });

    expect(result.isError).toBeFalsy();
    expect(funderOf(result)).not.toHaveProperty('descendants');
    expect(contentText(result.content)).not.toContain('Descendants');
  });

  it('renders the descendants line beside the registry relationships', () => {
    const text = blockText(
      searchFundersTool.format!({
        funders: [
          {
            id: '100000054',
            name: 'National Cancer Institute',
            worksCount: 83567,
            descendants: NCI.descendants,
          },
        ],
      })[0],
    );
    expect(text.split('\n')).toEqual([
      '## National Cancer Institute',
      '**ID:** 100000054',
      '**Works in Crossref:** 83567',
      `**Descendants (7):** ${NCI.descendants.join(', ')}`,
      '',
    ]);
  });

  it('names the scope of each count and the route to a filtered count with sub-agencies', () => {
    const funder = searchFundersTool.output.shape.funders.element.shape;
    expect(funder.worksCount.description).toContain('this registry ID alone');
    expect(funder.descendants.description).toContain('funder filter');
    expect(searchFundersTool.enrichment?.fundedWorksTotal?.description).toContain(
      'registry descendants',
    );
    expect(searchFundersTool.description).toContain('descendants');
    expect(searchFundersTool.description).toContain('funder filter');
  });
});
