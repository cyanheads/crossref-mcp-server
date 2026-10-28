/**
 * @fileoverview Tests for the crossref_search_works tool.
 * @module tests/tools/search-works.tool.test
 */

import { readFileSync } from 'node:fs';
import { z } from '@cyanheads/mcp-ts-core';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { HtmlRenderer, Parser } from 'commonmark';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { searchWorksTool } from '@/mcp-server/tools/definitions/search-works.tool.js';
import { blockText, contentText, renderedText } from '../helpers/content.js';

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
    // Crossref has handed a token back on the empty page past the end — the empty page is the signal.
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

/** `count` distinct work records, `10.5555/w<start>` onward. */
function makeItems(count: number, start = 0) {
  return Array.from({ length: count }, (_, i) => ({ DOI: `10.5555/w${start + i}` }));
}

describe('searchWorksTool page-size clamp', () => {
  it('clamps rows above 100 and names the next offset on both surfaces', async () => {
    mockSearchWorks.mockResolvedValue(
      makeSearchResult({ totalResults: 1500, items: makeItems(100) }),
    );

    const result = await runToolContract(searchWorksTool, { query: 'test', rows: 250 });

    expect(mockSearchWorks).toHaveBeenCalledWith(
      expect.objectContaining({ rows: 100 }),
      expect.anything(),
    );
    const structured = result.structuredContent as { works: unknown[]; notice?: string };
    expect(structured.works).toHaveLength(100);
    const notice =
      'rows 250 is above the per-call cap of 100, so 100 was applied. Pass offset=100 for the next page — the offset after the 100 records returned, not after the 250 requested.';
    expect(structured.notice).toBe(notice);
    expect(result.content.map(blockText).join('\n')).toContain(notice);
  });

  it('names offset + returned, not offset + requested, on a later offset page', async () => {
    mockSearchWorks.mockResolvedValue(
      makeSearchResult({ totalResults: 1500, items: makeItems(100, 200) }),
    );

    const result = await runToolContract(searchWorksTool, {
      query: 'test',
      offset: 200,
      rows: 250,
    });

    const notice = (result.structuredContent as { notice?: string }).notice;
    expect(notice).toContain('Pass offset=300 for the next page');
    expect(notice).not.toContain('offset=450');
  });

  it('accepts a numeric string and clamps it', async () => {
    mockSearchWorks.mockResolvedValue(makeSearchResult({ items: makeItems(100) }));

    const result = await runToolContract(searchWorksTool, { query: 'test', rows: '250' } as never);

    expect(result.isError).toBeFalsy();
    expect(mockSearchWorks).toHaveBeenCalledWith(
      expect.objectContaining({ rows: 100 }),
      expect.anything(),
    );
    expect((result.structuredContent as { notice?: string }).notice).toMatch(
      /^rows 250 is above the per-call cap of 100, so 100 was applied\. /,
    );
  });

  it('evaluates the offset ceiling on the clamped rows: offset 9900 + rows 250 succeeds', async () => {
    mockSearchWorks.mockResolvedValue(
      makeSearchResult({ totalResults: 50_000, items: makeItems(100, 9900) }),
    );

    const result = await runToolContract(searchWorksTool, {
      query: 'test',
      offset: 9900,
      rows: 250,
    });

    expect(result.isError).toBeFalsy();
    expect(mockSearchWorks).toHaveBeenCalledWith(
      expect.objectContaining({ rows: 100, offset: 9900 }),
      expect.anything(),
    );
    // offset 10000 is unusable for any rows, so the page routes to the cursor alone.
    expect((result.structuredContent as { notice?: string }).notice).toBe(
      'rows 250 is above the per-call cap of 100, so 100 was applied. Records past offset 10000 are beyond the ~10000 offset limit; re-run with cursor="*" to reach them.',
    );
  });

  it('rejects offset 9950 + rows 250 with offset_too_large evaluated on rows 100', async () => {
    const result = await runToolContract(searchWorksTool, {
      query: 'test',
      offset: 9950,
      rows: 250,
    });

    expect(result.isError).toBe(true);
    const error = (
      result.structuredContent as {
        error?: { message?: string; data?: { reason?: string; rows?: number } };
      }
    ).error;
    expect(error?.data).toMatchObject({ reason: 'offset_too_large', rows: 100 });
    expect(error?.message).toContain('Offset 9950 + rows 100 = 10050');
    expect(error?.message).toContain('rows 250 is above the per-call cap of 100');
    expect(mockSearchWorks).not.toHaveBeenCalled();
  });

  it('omits the next offset on a cursor page and on a page that ends the list', async () => {
    mockSearchWorks.mockResolvedValue(
      makeSearchResult({ totalResults: 1500, items: makeItems(100), nextCursor: 'AoE=' }),
    );
    const cursorPage = await runToolContract(searchWorksTool, {
      query: 'test',
      cursor: '*',
      rows: 250,
    });
    const cursorNotice = (cursorPage.structuredContent as { notice?: string }).notice;
    expect(cursorNotice).toBe('rows 250 is above the per-call cap of 100, so 100 was applied.');

    mockSearchWorks.mockResolvedValue(makeSearchResult({ totalResults: 60, items: makeItems(60) }));
    const lastPage = await runToolContract(searchWorksTool, { query: 'test', rows: 250 });
    expect((lastPage.structuredContent as { notice?: string }).notice).toBe(
      'rows 250 is above the per-call cap of 100, so 100 was applied.',
    );
  });

  it('clamps authorLimit above 500: slices 500, reports cap 500, and names the clamp', async () => {
    mockSearchWorks.mockResolvedValue(
      makeSearchResult({
        items: [{ DOI: '10.1234/consortium', type: 'journal-article', author: makeAuthors(600) }],
      }),
    );

    const result = await runToolContract(searchWorksTool, { query: 'test', authorLimit: 1000 });

    const structured = result.structuredContent as {
      works: Array<{ authors?: unknown[]; authorCount?: number }>;
      cap?: number;
      truncated?: boolean;
      notice?: string;
    };
    expect(structured.works[0]?.authors).toHaveLength(500);
    expect(structured.works[0]?.authorCount).toBe(600);
    expect(structured).toMatchObject({ truncated: true, cap: 500 });
    expect(structured.notice).toContain('authorLimit 1000 is above the per-call cap of 500');
    expect(structured.notice).toContain('capped at 500 per work');
    const text = result.content.map(blockText).join('\n');
    expect(text).toContain('authorLimit 1000 is above the per-call cap of 500');
    expect(text).toContain('showing 500 of 600');
  });

  it('leaves every in-cap value untouched and notice-free', async () => {
    mockSearchWorks.mockResolvedValue(makeSearchResult({ items: makeItems(100) }));

    const result = await runToolContract(searchWorksTool, {
      query: 'test',
      rows: 100,
      authorLimit: 500,
    });

    expect(mockSearchWorks).toHaveBeenCalledWith(
      expect.objectContaining({ rows: 100 }),
      expect.anything(),
    );
    expect((result.structuredContent as { notice?: string }).notice).toBeUndefined();
  });
});

/**
 * Crossref accepts `offset + rows` up to exactly 10000 on `/works` (9950 + 50 → 200, 9950 + 51 →
 * 400). Every request a page or a rejection tells the caller to make next has to be one the next
 * call accepts — so each recipe here is executed, not just read.
 */
describe('searchWorksTool offset-ceiling recipes', () => {
  type ErrorShape = { error?: { data?: { reason?: string; recovery?: { hint?: string } } } };
  const hintOf = (result: { structuredContent?: unknown }) =>
    (result.structuredContent as ErrorShape).error?.data?.recovery?.hint ?? '';

  it('names a request the next call accepts when the clamped page ends 50 short of the ceiling', async () => {
    mockSearchWorks.mockResolvedValue(
      makeSearchResult({ totalResults: 371_635, items: makeItems(100, 9850) }),
    );

    const page = await runToolContract(searchWorksTool, {
      filter: { issn: '0028-0836' },
      offset: 9850,
      rows: 250,
    });

    const notice =
      'rows 250 is above the per-call cap of 100, so 100 was applied. Pass offset=9950 with rows=50 for the last page offset paging reaches — offset + rows cannot pass ~10000; re-run with cursor="*" to reach the records after it.';
    expect((page.structuredContent as { notice?: string }).notice).toBe(notice);
    expect(page.content.map(blockText).join('\n')).toContain(notice);

    mockSearchWorks.mockResolvedValue(
      makeSearchResult({ totalResults: 371_635, items: makeItems(50, 9950) }),
    );
    const next = await runToolContract(searchWorksTool, {
      filter: { issn: '0028-0836' },
      offset: 9950,
      rows: 50,
    });
    expect(next.isError).toBeFalsy();
    expect(mockSearchWorks).toHaveBeenLastCalledWith(
      expect.objectContaining({ offset: 9950, rows: 50 }),
      expect.anything(),
    );
  });

  it('names the rows that still fit when an unclamped offset page passes the ceiling', async () => {
    const rejected = await runToolContract(searchWorksTool, {
      query: 'test',
      offset: 9950,
      rows: 100,
    });

    expect(rejected.isError).toBe(true);
    expect((rejected.structuredContent as ErrorShape).error?.data?.reason).toBe('offset_too_large');
    const hint = hintOf(rejected);
    expect(hint).toBe(
      'Pass offset=9950 with rows=50 to read the last records offset paging reaches, or switch to cursor-based paging with cursor="*" and chain the nextCursor token from each response to reach the records after them.',
    );
    expect(renderedText(contentText(rejected.content))).toContain(hint);
    expect(mockSearchWorks).not.toHaveBeenCalled();

    mockSearchWorks.mockResolvedValue(makeSearchResult({ items: makeItems(50, 9950) }));
    const next = await runToolContract(searchWorksTool, { query: 'test', offset: 9950, rows: 50 });
    expect(next.isError).toBeFalsy();
  });

  it('names rows=1 at offset 9999, the last offset any page reaches', async () => {
    const rejected = await runToolContract(searchWorksTool, {
      query: 'test',
      offset: 9999,
      rows: 2,
    });
    expect(hintOf(rejected)).toMatch(/^Pass offset=9999 with rows=1 to read /);
  });

  it('routes only to the cursor once the offset itself reaches the ceiling', async () => {
    const rejected = await runToolContract(searchWorksTool, {
      query: 'test',
      offset: 10_000,
      rows: 1,
    });

    expect((rejected.structuredContent as ErrorShape).error?.data?.reason).toBe('offset_too_large');
    const hint = hintOf(rejected);
    expect(hint).toContain('cursor="*"');
    expect(hint).not.toContain('with rows=');
  });
});

describe('searchWorksTool author-cap guidance', () => {
  const noticeFor = async (authorLimit: number) => {
    mockSearchWorks.mockResolvedValue(
      makeSearchResult({
        items: [{ DOI: '10.1234/consortium', type: 'journal-article', author: makeAuthors(2932) }],
      }),
    );
    const result = await runToolContract(searchWorksTool, { query: 'test', authorLimit });
    return {
      notice: (result.structuredContent as { notice?: string }).notice ?? '',
      text: result.content.map(blockText).join('\n'),
    };
  };

  it('suggests raising authorLimit while the cap applied is below 500', async () => {
    for (const authorLimit of [25, 499]) {
      const { notice, text } = await noticeFor(authorLimit);
      expect(notice).toContain('raise authorLimit');
      expect(notice).toContain('crossref_get_work');
      expect(text).toContain('raise authorLimit');
    }
  });

  it('points only to crossref_get_work at the 500 cap, requested or clamped', async () => {
    for (const authorLimit of [500, 1000]) {
      const { notice, text } = await noticeFor(authorLimit);
      expect(notice).toContain('capped at 500 per work');
      expect(notice).toContain('crossref_get_work');
      expect(notice).not.toContain('raise authorLimit');
      expect(notice).toContain('500 is the most authorLimit applies');
      expect(text).not.toContain('raise authorLimit');
    }
  });
});

/**
 * Crossref walks a cursor in registration order unless the request names a sort, and ignores
 * `order` without one — so a query walk left to upstream order loses relevance entirely, and
 * `sort=score&order=asc` puts the least relevant records first.
 */
describe('searchWorksTool cursor walk order', () => {
  /** The options the one service call carried. */
  async function sentOptions(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    mockSearchWorks.mockResolvedValue(makeSearchResult({ nextCursor: 'AoE=' }));
    const result = await runToolContract(searchWorksTool, input);
    expect(result.isError).toBeFalsy();
    expect(mockSearchWorks).toHaveBeenCalledTimes(1);
    return mockSearchWorks.mock.calls[0]?.[0] as Record<string, unknown>;
  }

  const QUERY_FIELDS = [
    'query',
    'queryBibliographic',
    'queryTitle',
    'queryAuthor',
    'queryContainerTitle',
  ] as const;

  it.each(QUERY_FIELDS)('ranks a %s walk with no sort by score', async (field) => {
    const opts = await sentOptions({ [field]: 'thermometry', cursor: '*' });
    expect(opts.sort).toBe('score');
    expect(opts).not.toHaveProperty('order');
  });

  it.each(QUERY_FIELDS)('ranks a later page of a %s walk by score too', async (field) => {
    const opts = await sentOptions({ [field]: 'thermometry', cursor: 'AoE=' });
    expect(opts).toMatchObject({ cursor: 'AoE=', sort: 'score' });
  });

  it('reads sort:"" as omitted on a query walk', async () => {
    const opts = await sentOptions({ queryTitle: 'thermometry', cursor: '*', sort: '' });
    expect(opts.sort).toBe('score');
  });

  it.each(['asc', 'desc'])(
    'does not forward order %s without a sort on a query walk',
    async (order) => {
      const opts = await sentOptions({ query: 'thermometry', cursor: '*', order });
      expect(opts.sort).toBe('score');
      expect(opts).not.toHaveProperty('order');
    },
  );

  it.each([
    ['relevance', 'asc'],
    ['created', 'desc'],
    ['score', 'asc'],
  ])('passes an explicit sort %s and order %s through on a query walk', async (sort, order) => {
    const opts = await sentOptions({ query: 'thermometry', cursor: '*', sort, order });
    expect(opts).toMatchObject({ sort, order });
  });

  it('sends no sort on a filter-only walk', async () => {
    const opts = await sentOptions({ filter: { type: 'journal-article' }, cursor: '*' });
    expect(opts).not.toHaveProperty('sort');
    expect(opts).not.toHaveProperty('order');
  });

  it('sends no sort on a walk whose every query term is blank', async () => {
    const opts = await sentOptions({ query: '  ', filter: { type: 'dataset' }, cursor: '*' });
    expect(opts).not.toHaveProperty('sort');
  });

  it('sends no sort on an offset page with a query term, and passes order as given', async () => {
    const first = await sentOptions({ queryTitle: 'thermometry' });
    expect(first).not.toHaveProperty('sort');

    mockSearchWorks.mockClear();
    const later = await sentOptions({ queryTitle: 'thermometry', offset: 20, order: 'asc' });
    expect(later).not.toHaveProperty('sort');
    expect(later.order).toBe('asc');
  });

  it('describes the order a cursor walk follows', () => {
    const schema = z.toJSONSchema(searchWorksTool.input, { io: 'input' }) as {
      properties?: Record<string, { description?: string }>;
    };
    const description = schema.properties?.cursor?.description ?? '';
    expect(description).toMatch(/query term runs by relevance unless sort is set/);
    expect(description).toMatch(/registration order/);
    expect(description).toMatch(/repeat or skip a record at a page boundary/);
    expect(description).toContain('sort:"created"');
  });
});

/** The live `/works/10.1016/S0140-6736(20)31180-6` record — 7 `updated-by`, 4 `update-to`. */
function lancetRecord(): Record<string, unknown> {
  const file = new URL('../fixtures/works/10.1016_s0140-6736_20_31180-6.json', import.meta.url);
  return (JSON.parse(readFileSync(file, 'utf8')) as { message: Record<string, unknown> }).message;
}

describe('searchWorksTool update notices', () => {
  it('relays every updatedBy and updateTo entry in deposited order, never merged', async () => {
    mockSearchWorks.mockResolvedValue(
      makeSearchResult({ totalResults: 1, items: [lancetRecord()] }),
    );

    const result = await runToolContract(searchWorksTool, {
      filter: { doi: '10.1016/S0140-6736(20)31180-6' },
    });

    const work = (
      result.structuredContent as {
        works: Array<{
          updatedBy?: Array<Record<string, unknown>>;
          updateTo?: Array<Record<string, unknown>>;
        }>;
      }
    ).works[0];
    expect(work?.updatedBy?.map((u) => [u.doi, u.type, u.source])).toEqual([
      ['10.1016/s0140-6736(20)31290-3', 'expression_of_concern', 'retraction-watch'],
      ['10.1016/s0140-6736(20)31249-6', 'correction', 'retraction-watch'],
      ['10.1016/s0140-6736(20)31324-6', 'retraction', 'retraction-watch'],
      ['10.1016/s0140-6736(20)31174-0', 'retraction', 'publisher'],
      ['10.1016/s0140-6736(20)31324-6', 'erratum', 'publisher'],
      ['10.1016/s0140-6736(20)31528-2', 'erratum', 'publisher'],
      ['10.1016/s0140-6736(20)31249-6', 'erratum', 'publisher'],
    ]);
    expect(work?.updatedBy?.[2]).toEqual({
      doi: '10.1016/s0140-6736(20)31324-6',
      type: 'retraction',
      source: 'retraction-watch',
      recordId: '23529',
      updated: { year: 2020, month: 6, day: 5 },
    });
    expect(JSON.stringify(work?.updatedBy)).not.toContain('label');
    expect(work?.updateTo?.map((u) => u.doi)).toEqual([
      '10.1016/s0140-6736(20)31174-0',
      '10.1016/s0140-6736(20)31290-3',
      '10.1016/s0140-6736(20)31324-6',
      '10.1016/s0140-6736(20)31528-2',
    ]);
    expect(work?.updateTo?.[0]).toEqual({
      doi: '10.1016/s0140-6736(20)31174-0',
      type: 'retraction',
      source: 'publisher',
      updated: { year: 2020, month: 5, day: 22 },
    });
  });

  it('renders every entry field on content[], one line per entry, under both labels', async () => {
    mockSearchWorks.mockResolvedValue(
      makeSearchResult({ totalResults: 1, items: [lancetRecord()] }),
    );

    const result = await runToolContract(searchWorksTool, { query: 'hydroxychloroquine' });
    const text = result.content.map(blockText).join('\n');

    expect(text).toContain(
      [
        '',
        '**Updated by:**',
        '- 10.1016/s0140-6736(20)31290-3 — expression_of_concern (retraction-watch, record 23527), 2020-06-03',
        '- 10.1016/s0140-6736(20)31249-6 — correction (retraction-watch, record 23528), 2020-05-30',
        '- 10.1016/s0140-6736(20)31324-6 — retraction (retraction-watch, record 23529), 2020-06-05',
        '- 10.1016/s0140-6736(20)31174-0 — retraction (publisher), 2020-05-22',
        '- 10.1016/s0140-6736(20)31324-6 — erratum (publisher), 2020-06-13',
        '- 10.1016/s0140-6736(20)31528-2 — erratum (publisher), 2020-07-18',
        '- 10.1016/s0140-6736(20)31249-6 — erratum (publisher), 2020-05-30',
        '',
        '**Update notice for:**',
        '- 10.1016/s0140-6736(20)31174-0 — retraction (publisher), 2020-05-22',
        '- 10.1016/s0140-6736(20)31290-3 — retraction (publisher), 2020-05-22',
        '- 10.1016/s0140-6736(20)31324-6 — retraction (publisher), 2020-05-22',
        '- 10.1016/s0140-6736(20)31528-2 — retraction (publisher), 2020-05-22',
        '',
      ].join('\n'),
    );
  });

  it('closes the update lists so the next field is not read into the last entry', () => {
    const blocks = searchWorksTool.format!({
      works: [
        {
          doi: '10.1000/a',
          title: 'Retracted',
          publisher: 'Elsevier BV',
          updatedBy: [{ doi: '10.1000/notice', type: 'retraction', source: 'publisher' }],
          authors: [{ given: 'Ada', family: 'Lovelace' }],
          isReferencedByCount: 3,
        },
        {
          doi: '10.1000/b',
          updateTo: [{ doi: '10.1000/a', type: 'retraction', source: 'publisher' }],
        },
      ],
    });
    const html = new HtmlRenderer().render(new Parser().parse(blockText(blocks[0])));

    expect(html).toContain('<li>10.1000/notice — retraction (publisher)</li>');
    expect(html).toContain('<li>10.1000/a — retraction (publisher)</li>');
    expect(html).toMatch(
      /<p><strong>Authors:<\/strong> Ada Lovelace\n<strong>Cited by:<\/strong> 3<\/p>/,
    );
    expect(html).toContain('<h3>10.1000/b</h3>');
  });

  it('omits both keys, and adds no line, for a work recording neither', async () => {
    mockSearchWorks.mockResolvedValue(makeSearchResult());

    const result = await runToolContract(searchWorksTool, { query: 'CRISPR' });

    const work = (result.structuredContent as { works: Array<Record<string, unknown>> }).works[0];
    expect(work).not.toHaveProperty('updatedBy');
    expect(work).not.toHaveProperty('updateTo');
    expect(blockText(result.content[0])).toBe(
      [
        '### Cas9 in mammals',
        '**DOI:** 10.1038/nature12373 | **Type:** journal-article',
        '**Published:** 2013-08',
        '**Journal:** Nature',
        '**Authors:** Le Cong',
        '**Cited by:** 1500',
        '**Score:** 99.5',
        '',
      ].join('\n'),
    );
  });

  it('treats an update list deposited as [] as no update at all', async () => {
    mockSearchWorks.mockResolvedValue(
      makeSearchResult({ items: [{ DOI: '10.1000/x', 'updated-by': [], 'update-to': [] }] }),
    );

    const result = await runToolContract(searchWorksTool, { query: 'x' });

    const work = (result.structuredContent as { works: Array<Record<string, unknown>> }).works[0];
    expect(work).toEqual({ doi: '10.1000/x' });
  });
});
