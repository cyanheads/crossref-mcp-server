/**
 * @fileoverview Tests for the crossref_search_works tool.
 * @module tests/tools/search-works.tool.test
 */

import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { searchWorksTool } from '@/mcp-server/tools/definitions/search-works.tool.js';
import { blockText } from '../helpers/content.js';

vi.mock('@/services/crossref/crossref-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/crossref/crossref-service.js')>();
  return {
    ...actual,
    getCrossrefService: vi.fn(),
  };
});

import { getCrossrefService } from '@/services/crossref/crossref-service.js';

const mockSearchWorks = vi.fn();

beforeEach(() => {
  vi.mocked(getCrossrefService).mockReturnValue({
    searchWorks: mockSearchWorks,
  } as unknown as ReturnType<typeof getCrossrefService>);
  mockSearchWorks.mockReset();
});

function makeSearchResult(overrides: Record<string, unknown> = {}) {
  return {
    totalResults: 1500,
    itemsPerPage: 20,
    items: [
      {
        DOI: '10.1038/nature12373',
        type: 'journal-article',
        title: ['Cas9 in mammals'],
        author: [{ given: 'Le', family: 'Cong' }],
        'container-title': ['Nature'],
        'is-referenced-by-count': 1500,
        score: 99.5,
        published: { 'date-parts': [[2013, 8]] },
      },
    ],
    ...overrides,
  };
}

/** Distinct, order-checkable author entries — `G0 F0`, `G1 F1`, … */
function makeAuthors(count: number) {
  return Array.from({ length: count }, (_, i) => ({ given: `G${i}`, family: `F${i}` }));
}

/**
 * The schema clients actually receive: domain output merged with enrichment. Parsing through
 * it proves a field reaches the wire — an undeclared key is stripped here, silently.
 */
const wireSchema = searchWorksTool.output.extend(searchWorksTool.enrichment!);

describe('searchWorksTool', () => {
  it('returns works for a simple query', async () => {
    const ctx = createMockContext({ errors: searchWorksTool.errors });
    mockSearchWorks.mockResolvedValue(makeSearchResult());

    const input = searchWorksTool.input.parse({ query: 'CRISPR' });
    const result = await searchWorksTool.handler(input, ctx);

    expect(result.works[0]?.doi).toBe('10.1038/nature12373');
    expect(result.works[0]?.authors?.[0]?.given).toBe('Le');
    expect(result.works[0]?.authors?.[0]?.family).toBe('Cong');
  });

  it('populates enrichment with totalResults and returned', async () => {
    const ctx = createMockContext({ errors: searchWorksTool.errors });
    mockSearchWorks.mockResolvedValue(makeSearchResult());

    const input = searchWorksTool.input.parse({ query: 'CRISPR' });
    await searchWorksTool.handler(input, ctx);

    expect(getEnrichment(ctx)).toMatchObject({ totalResults: 1500, returned: 1 });
  });

  it('sets empty-result notice in enrichment when no results', async () => {
    const ctx = createMockContext({ errors: searchWorksTool.errors });
    mockSearchWorks.mockResolvedValue(makeSearchResult({ totalResults: 0, items: [] }));

    const input = searchWorksTool.input.parse({ query: 'ZZZNoMatch' });
    const result = await searchWorksTool.handler(input, ctx);

    const wire = wireSchema.parse({ ...result, ...getEnrichment(ctx) });
    expect(wire.notice).toMatch(/No results/);
  });

  it('notices an offset that ran past the end of a list that did match', async () => {
    const ctx = createMockContext({ errors: searchWorksTool.errors });
    mockSearchWorks.mockResolvedValue(makeSearchResult({ totalResults: 100, items: [] }));

    const input = searchWorksTool.input.parse({ query: 'CRISPR', offset: 500, rows: 20 });
    const result = await searchWorksTool.handler(input, ctx);

    // Empty with matches upstream is a different fact from empty with none, and the advice
    // differs — "broaden the query" would send a caller away from results that do exist.
    const wire = wireSchema.parse({ ...result, ...getEnrichment(ctx) });
    expect(wire.notice).toMatch(/past the end/);
    expect(wire.notice).toContain('500');
    expect(wire.notice).not.toMatch(/No results/);
  });

  it('throws cursor_offset_conflict when both cursor and offset are supplied', async () => {
    const ctx = createMockContext({ errors: searchWorksTool.errors });

    const input = searchWorksTool.input.parse({ query: 'test', cursor: '*', offset: 20 });
    await expect(searchWorksTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'cursor_offset_conflict' },
    });
  });

  it('reads a blank cursor as absent rather than as a cursor', async () => {
    const ctx = createMockContext({ errors: searchWorksTool.errors });
    mockSearchWorks.mockResolvedValue(makeSearchResult({ totalResults: 49_141 }));

    // Form-based clients send "" for an optional field nobody filled in. The service picks
    // its selector by truthiness, so a blank never reaches Crossref — the page comes back
    // through the offset path and must not be labelled a cursor page.
    const input = searchWorksTool.input.parse({ query: 'CRISPR', cursor: '  ' });
    await searchWorksTool.handler(input, ctx);

    expect(mockSearchWorks.mock.calls[0]?.[0]).not.toHaveProperty('cursor');
  });

  it('does not refuse an offset paired with a blank cursor', async () => {
    const ctx = createMockContext({ errors: searchWorksTool.errors });
    mockSearchWorks.mockResolvedValue(makeSearchResult({ totalResults: 49_141 }));

    // Nothing conflicts: a blank is not a cursor, so the offset is the only selector, and
    // refusing it strands a caller whose client filled the field in with "".
    const input = searchWorksTool.input.parse({ query: 'CRISPR', cursor: '', offset: 20 });
    await searchWorksTool.handler(input, ctx);

    expect(mockSearchWorks.mock.calls[0]?.[0]).toMatchObject({ offset: 20 });
  });

  it('calls an empty blank-cursor page an offset page, not a completed walk', async () => {
    const ctx = createMockContext({ errors: searchWorksTool.errors });
    mockSearchWorks.mockResolvedValue(makeSearchResult({ totalResults: 100, items: [] }));

    const input = searchWorksTool.input.parse({ query: 'CRISPR', cursor: '' });
    const result = await searchWorksTool.handler(input, ctx);

    const wire = wireSchema.parse({ ...result, ...getEnrichment(ctx) });
    expect(wire.notice).toMatch(/past the end/);
    expect(wire.notice).not.toMatch(/walk is complete/);
  });

  it('throws offset_too_large when offset exceeds ~10K cap', async () => {
    const ctx = createMockContext({ errors: searchWorksTool.errors });

    const input = searchWorksTool.input.parse({ query: 'test', offset: 9990, rows: 20 });
    await expect(searchWorksTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'offset_too_large' },
    });
  });

  it('includes next_cursor in output when API returns one', async () => {
    const ctx = createMockContext({ errors: searchWorksTool.errors });
    mockSearchWorks.mockResolvedValue({ ...makeSearchResult(), nextCursor: 'AoE=' });

    const input = searchWorksTool.input.parse({ query: 'CRISPR', cursor: '*' });
    const result = await searchWorksTool.handler(input, ctx);

    const wire = wireSchema.parse({ ...result, ...getEnrichment(ctx) });
    expect(wire.nextCursor).toBe('AoE=');
    expect(wire.notice).toBeUndefined();
  });

  it('withholds nextCursor once the walk runs off the end of the result list', async () => {
    const ctx = createMockContext({ errors: searchWorksTool.errors });
    // Crossref keeps minting a token past the end of a list — the empty page is the signal.
    mockSearchWorks.mockResolvedValue(
      makeSearchResult({ totalResults: 100, items: [], nextCursor: 'a-token-that-yields-nothing' }),
    );

    const input = searchWorksTool.input.parse({ query: 'CRISPR', cursor: 'last-token', rows: 100 });
    const result = await searchWorksTool.handler(input, ctx);

    const wire = wireSchema.parse({ ...result, ...getEnrichment(ctx) });
    // Absence of a continuation field means "exhausted" on the offset path; handing back a
    // token here would break that on the cursor path and loop a caller forever.
    expect(wire.nextCursor).toBeUndefined();
    expect(wire.works).toHaveLength(0);
    // Absence alone is a weak signal on a tool whose entire payload is `works` — an empty page
    // with nothing said about it renders as blank text. The notice is the affirmative half.
    expect(wire.notice).toMatch(/walk is complete/);
    expect(wire.notice).toContain('100');
    // Nothing on either surface invites another call.
    expect(blockText(searchWorksTool.format!(result)[0])).not.toContain('Next cursor');
  });

  it('terminates a cursor walk instead of looping on the token Crossref re-mints', async () => {
    // Live upstream behavior: the token that yields an empty page comes back on that page
    // unchanged, so an unguarded walk re-sends it forever.
    const recycled = 'DnF1ZXJ5VGhlbkZldGNo-recycled';
    mockSearchWorks.mockImplementation((opts: { cursor?: string }) =>
      Promise.resolve(
        opts.cursor === '*'
          ? makeSearchResult({ totalResults: 100, nextCursor: recycled })
          : makeSearchResult({ totalResults: 100, items: [], nextCursor: recycled }),
      ),
    );

    let cursor: string | undefined = '*';
    const pageSizes: number[] = [];
    for (let i = 0; i < 10 && cursor !== undefined; i++) {
      const ctx = createMockContext({ errors: searchWorksTool.errors });
      const input = searchWorksTool.input.parse({ query: 'CRISPR', cursor, rows: 100 });
      const result = await searchWorksTool.handler(input, ctx);
      pageSizes.push(result.works.length);
      cursor = wireSchema.parse({ ...result, ...getEnrichment(ctx) }).nextCursor;
    }

    // The full page, then the empty one that ends it — the loop bound is never reached.
    expect(pageSizes).toEqual([1, 0]);
    expect(cursor).toBeUndefined();
  });

  it('carries the walk-complete notice onto content[] for a client that reads only text', async () => {
    mockSearchWorks.mockResolvedValue(
      makeSearchResult({ totalResults: 100, items: [], nextCursor: 'recycled-token' }),
    );

    const result = await runToolContract(searchWorksTool, {
      query: 'CRISPR',
      cursor: 'last-token',
      rows: 100,
    });

    const text = result.content.map(blockText).join('\n');
    expect(text).toMatch(/walk is complete/);
    expect(text).not.toContain('recycled-token');
    expect(result.structuredContent).not.toHaveProperty('nextCursor');
  });

  it('passes sort and order to the service', async () => {
    const ctx = createMockContext({ errors: searchWorksTool.errors });
    mockSearchWorks.mockResolvedValue(makeSearchResult());

    const input = searchWorksTool.input.parse({ query: 'test', sort: 'published', order: 'desc' });
    await searchWorksTool.handler(input, ctx);

    expect(mockSearchWorks).toHaveBeenCalledWith(
      expect.objectContaining({ sort: 'published', order: 'desc' }),
      expect.anything(),
    );
  });

  it('passes filter to the service', async () => {
    const ctx = createMockContext({ errors: searchWorksTool.errors });
    mockSearchWorks.mockResolvedValue(makeSearchResult());

    const input = searchWorksTool.input.parse({
      query: 'climate',
      filter: { type: 'journal-article', 'has-abstract': 'true' },
    });
    await searchWorksTool.handler(input, ctx);

    expect(mockSearchWorks).toHaveBeenCalledWith(
      expect.objectContaining({ filter: { type: 'journal-article', 'has-abstract': 'true' } }),
      expect.anything(),
    );
  });

  it('passes fields (select) to the service', async () => {
    const ctx = createMockContext({ errors: searchWorksTool.errors });
    mockSearchWorks.mockResolvedValue(makeSearchResult());

    const input = searchWorksTool.input.parse({ query: 'test', fields: ['DOI', 'title'] });
    await searchWorksTool.handler(input, ctx);

    expect(mockSearchWorks).toHaveBeenCalledWith(
      expect.objectContaining({ fields: ['DOI', 'title'] }),
      expect.anything(),
    );
  });

  it('passes queryTitle to the service (field-specific query)', async () => {
    const ctx = createMockContext({ errors: searchWorksTool.errors });
    mockSearchWorks.mockResolvedValue(makeSearchResult());

    const input = searchWorksTool.input.parse({ queryTitle: 'Array programming with NumPy' });
    await searchWorksTool.handler(input, ctx);

    expect(mockSearchWorks).toHaveBeenCalledWith(
      expect.objectContaining({ queryTitle: 'Array programming with NumPy' }),
      expect.anything(),
    );
  });

  it('passes multiple field-specific query params together to the service', async () => {
    const ctx = createMockContext({ errors: searchWorksTool.errors });
    mockSearchWorks.mockResolvedValue(makeSearchResult());

    const input = searchWorksTool.input.parse({
      queryTitle: 'Array programming with NumPy',
      queryAuthor: 'Charles R. Harris',
      queryContainerTitle: 'Nature',
    });
    await searchWorksTool.handler(input, ctx);

    expect(mockSearchWorks).toHaveBeenCalledWith(
      expect.objectContaining({
        queryTitle: 'Array programming with NumPy',
        queryAuthor: 'Charles R. Harris',
        queryContainerTitle: 'Nature',
      }),
      expect.anything(),
    );
  });

  it('maps a sparse field-query result without fabricating fields', async () => {
    const ctx = createMockContext({ errors: searchWorksTool.errors });
    mockSearchWorks.mockResolvedValue(
      makeSearchResult({
        items: [{ DOI: '10.1038/s41586-020-2649-2', type: 'journal-article' }],
      }),
    );

    const input = searchWorksTool.input.parse({ queryBibliographic: 'Harris NumPy Nature 2020' });
    const result = await searchWorksTool.handler(input, ctx);

    // Upstream omitted title/authors/abstract — output preserves the gap, invents nothing.
    expect(() => searchWorksTool.output.parse(result)).not.toThrow();
    expect(result.works[0]?.doi).toBe('10.1038/s41586-020-2649-2');
    expect(result.works[0]?.title).toBeUndefined();
    expect(result.works[0]?.authors).toBeUndefined();
    expect(result.works[0]?.abstract).toBeUndefined();
  });

  /**
   * #32 removed a silent ten-author slice. What it established is not "no cap ever" — the
   * fix that closed it said a deliberate bound was a separate decision — but that no cap is
   * applied *silently*: an ordinary list comes back whole with nothing claiming otherwise,
   * and a bounded one says so on both surfaces and hands back the route to the rest. These
   * two tests guard the two halves of that.
   */
  it('leaves an ordinary author list whole, with nothing claiming it was cut', async () => {
    const ctx = createMockContext({ errors: searchWorksTool.errors });
    const authors = makeAuthors(15);
    mockSearchWorks.mockResolvedValue(
      makeSearchResult({
        items: [{ DOI: '10.1234/test', type: 'journal-article', author: authors }],
      }),
    );

    // 15 sits under the default authorLimit of 25 — the ordinary record, untouched.
    const input = searchWorksTool.input.parse({ query: 'test' });
    const result = await searchWorksTool.handler(input, ctx);

    expect(result.works[0]?.authors?.length).toBe(15);
    expect(result.works[0]?.authors?.at(-1)).toMatchObject({ given: 'G14', family: 'F14' });
    expect(result.works[0]?.authorCount).toBe(15);

    const wire = wireSchema.parse({ ...result, ...getEnrichment(ctx) });
    expect(wire.truncated).toBeUndefined();
    expect(wire.cap).toBeUndefined();
    expect(wire.notice).toBeUndefined();
    // A whole list renders as a plain list — no "showing N of M" on a record that lost nothing.
    expect(blockText(searchWorksTool.format!(result)[0])).not.toContain('showing');
  });

  it('renders exactly the page the handler kept — no cap between the two result paths', async () => {
    const ctx = createMockContext({ errors: searchWorksTool.errors });
    mockSearchWorks.mockResolvedValue(
      makeSearchResult({
        items: [{ DOI: '10.1234/test', type: 'journal-article', author: makeAuthors(40) }],
      }),
    );

    const input = searchWorksTool.input.parse({ query: 'test', authorLimit: 10 });
    const result = await searchWorksTool.handler(input, ctx);
    const kept = result.works[0]?.authors ?? [];
    const text = blockText(searchWorksTool.format!(result)[0]);

    // Asserted before the loop: a cap that emptied the array would make the loop vacuous.
    expect(kept).toHaveLength(10);
    for (const a of kept) {
      expect(text).toContain(`${a.given} ${a.family}`);
    }
    // And nothing beyond the page leaks into either surface via the render path.
    expect(text).not.toContain('G10 F10');
    expect(JSON.stringify(result)).not.toContain('G10');
  });

  it('caps each work at authorLimit and reports the full deposited total', async () => {
    const ctx = createMockContext({ errors: searchWorksTool.errors });
    mockSearchWorks.mockResolvedValue(
      makeSearchResult({
        items: [
          { DOI: '10.1234/consortium', type: 'journal-article', author: makeAuthors(2932) },
          { DOI: '10.1234/small', type: 'journal-article', author: makeAuthors(3) },
        ],
      }),
    );

    const input = searchWorksTool.input.parse({ query: 'test' });
    const result = await searchWorksTool.handler(input, ctx);

    expect(result.works[0]?.authors).toHaveLength(25);
    expect(result.works[0]?.authorCount).toBe(2932);
    // The cap is per work, not per page — the small record is untouched beside the big one.
    expect(result.works[1]?.authors).toHaveLength(3);
    expect(result.works[1]?.authorCount).toBe(3);

    const wire = wireSchema.parse({ ...result, ...getEnrichment(ctx) });
    expect(wire).toMatchObject({ truncated: true, cap: 25 });
    expect(wire.notice).toMatch(/1 of the 2 works/);
    expect(wire.notice).toMatch(/crossref_get_work/);
  });

  it('discloses the cut on content[] as well as structuredContent', async () => {
    mockSearchWorks.mockResolvedValue(
      makeSearchResult({
        items: [{ DOI: '10.1234/consortium', type: 'journal-article', author: makeAuthors(400) }],
      }),
    );

    const result = await runToolContract(searchWorksTool, { query: 'test', authorLimit: 25 });

    const text = result.content.map(blockText).join('\n');
    // The per-work line names the count and the retrieval path; the enrichment trailer
    // repeats the page-level fact. A client reading only text gets both.
    expect(text).toContain('showing 25 of 400');
    expect(text).toContain('crossref_get_work with doi 10.1234/consortium');
    expect(text).toMatch(/capped at 25 per work/);
    expect(result.structuredContent).toMatchObject({ truncated: true, cap: 25 });
  });

  it('rejects an authorLimit outside the 1–500 range', () => {
    expect(() => searchWorksTool.input.parse({ query: 'test', authorLimit: 0 })).toThrow();
    expect(() => searchWorksTool.input.parse({ query: 'test', authorLimit: 501 })).toThrow();
    expect(() => searchWorksTool.input.parse({ query: 'test', authorLimit: 2.5 })).toThrow();
  });

  it('succeeds end-to-end when fields omits DOI and upstream still returns it', async () => {
    const ctx = createMockContext({ errors: searchWorksTool.errors });
    // The service force-includes DOI in select=, so the projected record still carries it
    // even though the caller asked only for title.
    mockSearchWorks.mockResolvedValue(
      makeSearchResult({ items: [{ DOI: '10.1038/nature12373', title: ['Cas9 in mammals'] }] }),
    );

    const input = searchWorksTool.input.parse({
      queryTitle: 'CRISPR',
      fields: ['title'],
      rows: 1,
    });
    const result = await searchWorksTool.handler(input, ctx);

    expect(() => searchWorksTool.output.parse(result)).not.toThrow();
    expect(result.works[0]?.doi).toBe('10.1038/nature12373');
    expect(result.works[0]?.type).toBeUndefined();
  });

  it('renders the abstract in full, with no truncation marker', async () => {
    const ctx = createMockContext({ errors: searchWorksTool.errors });
    const abstract = `Start. ${'x'.repeat(2_700)} End.`;
    mockSearchWorks.mockResolvedValue(
      makeSearchResult({
        items: [{ DOI: '10.1234/long', type: 'journal-article', abstract }],
      }),
    );

    const input = searchWorksTool.input.parse({ query: 'test' });
    const result = await searchWorksTool.handler(input, ctx);
    const text = blockText(searchWorksTool.format!(result)[0]);

    expect(result.works[0]?.abstract).toBe(abstract);
    expect(text).toContain(abstract);
    expect(text).not.toContain('…');
  });

  it('renders a short abstract without a false truncation marker', () => {
    const text = blockText(
      searchWorksTool.format!({
        works: [{ doi: '10.1234/short', abstract: 'A very short abstract.' }],
      })[0],
    );

    expect(text).toContain('A very short abstract.');
    expect(text).not.toContain('…');
  });

  it('handles items with no title or authors gracefully', async () => {
    const ctx = createMockContext({ errors: searchWorksTool.errors });
    mockSearchWorks.mockResolvedValue(
      makeSearchResult({
        items: [{ DOI: '10.1234/sparse', type: 'journal-article' }],
      }),
    );

    const input = searchWorksTool.input.parse({ query: 'test' });
    const result = await searchWorksTool.handler(input, ctx);

    expect(result.works[0]?.doi).toBe('10.1234/sparse');
    expect(result.works[0]?.title).toBeUndefined();
    expect(result.works[0]?.authors).toBeUndefined();
  });

  it('decodes HTML entities in work titles from search results', async () => {
    const ctx = createMockContext({ errors: searchWorksTool.errors });
    mockSearchWorks.mockResolvedValue(
      makeSearchResult({
        items: [
          {
            DOI: '10.1234/test',
            type: 'journal-article',
            title: ['CO&lt;sub&gt;2&lt;/sub&gt; &amp; climate'],
          },
        ],
      }),
    );

    const input = searchWorksTool.input.parse({ query: 'test' });
    const result = await searchWorksTool.handler(input, ctx);

    /**
     * Asserted exactly, not with a `toContain('&')` that the escaped input satisfies whatever
     * the projection does. The escaped tags stay literal text: markup is stripped before
     * entities are decoded, so nothing here decodes into a tag the strip pass would eat.
     */
    expect(result.works[0]?.title).toBe('CO<sub>2</sub> & climate');
  });

  it('strips JATS markup and embedded newlines from title and container title', async () => {
    const ctx = createMockContext({ errors: searchWorksTool.errors });
    mockSearchWorks.mockResolvedValue(
      makeSearchResult({
        items: [
          {
            DOI: '10.1039/d5cs00921a',
            type: 'journal-article',
            title: ['<i>In vivo</i>\n                    CRISPR biosensing'],
            'container-title': ['<i>Chem.</i> Soc. Rev.'],
            publisher: 'Royal Society of Chemistry &amp; Partners',
            author: [{ given: 'Jane', family: 'Doe &amp; Sons' }],
          },
        ],
      }),
    );

    const input = searchWorksTool.input.parse({ queryTitle: 'In vivo CRISPR biosensing' });
    const result = await searchWorksTool.handler(input, ctx);

    expect(result.works[0]?.title).toBe('In vivo CRISPR biosensing');
    expect(result.works[0]?.containerTitle).toBe('Chem. Soc. Rev.');
    expect(result.works[0]?.publisher).toBe('Royal Society of Chemistry & Partners');
    expect(result.works[0]?.authors?.[0]?.family).toBe('Doe & Sons');

    const text = blockText(searchWorksTool.format!(result)[0]);
    expect(text).toContain('### In vivo CRISPR biosensing\n');
  });

  it('accepts valid rows range (1–100)', () => {
    expect(() => searchWorksTool.input.parse({ query: 'test', rows: 1 })).not.toThrow();
    expect(() => searchWorksTool.input.parse({ query: 'test', rows: 100 })).not.toThrow();
  });

  it('rejects rows outside valid range', () => {
    expect(() => searchWorksTool.input.parse({ query: 'test', rows: 0 })).toThrow();
    expect(() => searchWorksTool.input.parse({ query: 'test', rows: 101 })).toThrow();
  });

  it('allows cursor="*" for the initial deep-page call', async () => {
    const ctx = createMockContext({ errors: searchWorksTool.errors });
    mockSearchWorks.mockResolvedValue(makeSearchResult({ nextCursor: 'token123' }));

    const input = searchWorksTool.input.parse({ query: 'test', cursor: '*' });
    const result = await searchWorksTool.handler(input, ctx);

    expect(mockSearchWorks).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: '*' }),
      expect.anything(),
    );
    expect(result.nextCursor).toBe('token123');
  });

  it('formats output with title, doi, and authors', () => {
    const result = {
      works: [
        {
          doi: '10.1038/nature12373',
          type: 'journal-article',
          title: 'Cas9 in mammals',
          authors: [{ given: 'Le', family: 'Cong', name: undefined }],
          isReferencedByCount: 1500,
          score: 99.5,
        },
      ],
    };
    const blocks = searchWorksTool.format!(result);
    const text = blockText(blocks[0]);
    expect(text).toContain('10.1038/nature12373');
    expect(text).toContain('Le');
    expect(text).toContain('Cong');
    expect(text).toContain('1500');
  });

  it('formats output with nextCursor when present', () => {
    // A token now only ever rides a page that carried records, so that is the shape rendered.
    const result = { works: [{ doi: '10.1038/nature12373' }], nextCursor: 'cursor-abc' };
    const blocks = searchWorksTool.format!(result);
    const text = blockText(blocks[0]);
    expect(text).toContain('cursor-abc');
    expect(text).toContain('10.1038/nature12373');
  });

  it('security: output does not include CROSSREF_BASE_URL or CROSSREF_MAILTO', async () => {
    const originalMailto = process.env.CROSSREF_MAILTO;
    const originalBase = process.env.CROSSREF_BASE_URL;
    process.env.CROSSREF_MAILTO = 'private@example.com';
    process.env.CROSSREF_BASE_URL = 'https://private.api.example.com';
    try {
      const ctx = createMockContext({ errors: searchWorksTool.errors });
      mockSearchWorks.mockResolvedValue(makeSearchResult());

      const input = searchWorksTool.input.parse({ query: 'test' });
      const result = await searchWorksTool.handler(input, ctx);
      const blocks = searchWorksTool.format!(result);
      const outputText = JSON.stringify(result) + blockText(blocks[0]);

      expect(outputText).not.toContain('private@example.com');
      expect(outputText).not.toContain('private.api.example.com');
    } finally {
      if (originalMailto === undefined) delete process.env.CROSSREF_MAILTO;
      else process.env.CROSSREF_MAILTO = originalMailto;
      if (originalBase === undefined) delete process.env.CROSSREF_BASE_URL;
      else process.env.CROSSREF_BASE_URL = originalBase;
    }
  });
});
