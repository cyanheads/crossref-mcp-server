/**
 * @fileoverview Tests for the crossref_search_funders tool.
 * @module tests/tools/search-funders.tool.test
 */

import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
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

/**
 * Shaped after a live `/funders` record: `country` and `country-code` are omitted rather than
 * nulled, matching both the observed payload and RawCrossrefFunder's non-nullable typing.
 */
const RAW_FUNDER = {
  id: '100000001',
  name: 'National Science Foundation',
  'alt-names': ['NSF'],
  location: 'United States',
  uri: 'http://dx.doi.org/10.13039/100000001',
  'work-count': 250000,
};

/** Funder-list envelope shape returned by CrossrefService.searchFunders. */
function funderList(items: unknown[], totalResults = items.length) {
  return { totalResults, items };
}

/**
 * The schema clients actually receive: domain output merged with enrichment. Parsing through
 * it proves a field reaches the wire — an undeclared key is stripped here, silently.
 */
const wireSchema = searchFundersTool.output.extend(searchFundersTool.enrichment);

describe('searchFundersTool', () => {
  it('returns funder records for a name query', async () => {
    const ctx = createMockContext();
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
    const ctx = createMockContext();
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
    const ctx = createMockContext();
    mockSearchFunders.mockResolvedValue(funderList([]));

    const input = searchFundersTool.input.parse({ query: 'ZZZUnknownFunder' });
    const result = await searchFundersTool.handler(input, ctx);

    expect(result.funders).toHaveLength(0);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.funderCount).toBe(0);
    expect(enrichment.notice).toBeDefined();
  });

  it('performs direct funder DOI lookup when funder_doi is provided', async () => {
    const ctx = createMockContext();
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

  it('handles sparse funder record — no alt-names, no country-code', async () => {
    const ctx = createMockContext();
    mockSearchFunders.mockResolvedValue(
      funderList([{ id: '999', name: 'Minimal Funder', location: 'Unknown' }]),
    );

    const input = searchFundersTool.input.parse({ query: 'Minimal' });
    const result = await searchFundersTool.handler(input, ctx);

    expect(result.funders[0]?.name).toBe('Minimal Funder');
    expect(result.funders[0]?.altNames).toBeUndefined();
    expect(result.funders[0]?.countryCode).toBeUndefined();
  });

  it('decodes HTML entities in funder name and altNames', async () => {
    const ctx = createMockContext();
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

  it('uses funder_doi from input as fallback ID when raw funder has no id', async () => {
    const ctx = createMockContext();
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
    const ctx = createMockContext();
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
      const ctx = createMockContext();
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
      const ctx = createMockContext();
      mockSearchFunders.mockResolvedValue(funderList([RAW_FUNDER, RAW_FUNDER], 4));

      const input = searchFundersTool.input.parse({ query: 'National', rows: 2, offset: 2 });
      const result = await searchFundersTool.handler(input, ctx);

      const wire = wireSchema.parse({ ...result, ...getEnrichment(ctx) });
      expect(wire.fundersTotal).toBe(4);
      expect(wire.nextOffset).toBeUndefined();
    });

    it('returns a well-formed empty page past the end of the funder list', async () => {
      const ctx = createMockContext();
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
      const ctx = createMockContext();
      mockSearchFunders.mockResolvedValue(funderList([], 0));

      const input = searchFundersTool.input.parse({ query: 'ZZZUnknownFunder', offset: 0 });
      const result = await searchFundersTool.handler(input, ctx);

      const wire = wireSchema.parse({ ...result, ...getEnrichment(ctx) });
      expect(wire.notice).toContain('No funders matched');
      expect(wire.notice).not.toContain('past the end');
    });

    it('threads works_offset to the works sub-resource and hands back nextWorksOffset', async () => {
      const ctx = createMockContext();
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
      const ctx = createMockContext();
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
      // ceiling and name the route that reaches the rest.
      expect(wire.notice).toContain('10000');
      expect(wire.notice).toContain('559017');
      expect(wire.notice).toContain('crossref_search_works');
      expect(wire.notice).toContain('100000001');
    });

    it('leaves the notice off when the works list simply ended', async () => {
      const ctx = createMockContext();
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

    it('discloses the 100000 ceiling on the funder list page', async () => {
      const ctx = createMockContext();
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

    it('throws offset_too_large before any upstream call when offset + rows passes 100000', async () => {
      const ctx = createMockContext({ errors: searchFundersTool.errors });

      const input = searchFundersTool.input.parse({ query: 'National', rows: 10, offset: 99_995 });
      await expect(searchFundersTool.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'offset_too_large', cap: 100_000 },
      });
      expect(mockSearchFunders).not.toHaveBeenCalled();
    });

    it('throws works_offset_too_large at the ten-times-lower works ceiling', async () => {
      const ctx = createMockContext({ errors: searchFundersTool.errors });

      const input = searchFundersTool.input.parse({
        funder_doi: '100000001',
        include_works: true,
        rows: 10,
        works_offset: 9_995,
      });
      await expect(searchFundersTool.handler(input, ctx)).rejects.toMatchObject({
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
      const text = result.content.map((b) => ('text' in b ? b.text : '')).join('\n');
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
      const err = await searchFundersTool.handler(input, ctx).catch((e: unknown) => e);

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
      const err = await searchFundersTool.handler(input, ctx).catch((e: unknown) => e);

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
      const err = await searchFundersTool.handler(input, ctx).catch((e: unknown) => e);

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
      const text = result.content.map((b) => ('text' in b ? b.text : '')).join('\n');
      expect(text).toContain('100031012');
      expect(text).toContain('501100004061');
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason: 'ambiguous_funder' } },
      });
    });
  });
});
