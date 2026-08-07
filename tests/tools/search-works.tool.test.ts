/**
 * @fileoverview Tests for the crossref_search_works tool.
 * @module tests/tools/search-works.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { searchWorksTool } from '@/mcp-server/tools/definitions/search-works.tool.js';

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
  vi.mocked(getCrossrefService).mockReturnValue({ searchWorks: mockSearchWorks } as ReturnType<
    typeof getCrossrefService
  >);
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
    await searchWorksTool.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toMatch(/No results/);
  });

  it('throws cursor_offset_conflict when both cursor and offset are supplied', async () => {
    const ctx = createMockContext({ errors: searchWorksTool.errors });

    const input = searchWorksTool.input.parse({ query: 'test', cursor: '*', offset: 20 });
    await expect(searchWorksTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'cursor_offset_conflict' },
    });
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

    expect(result.nextCursor).toBe('AoE=');
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

  it('returns the full author list per work, uncapped', async () => {
    const ctx = createMockContext({ errors: searchWorksTool.errors });
    const authors = Array.from({ length: 15 }, (_, i) => ({ given: `G${i}`, family: `F${i}` }));
    mockSearchWorks.mockResolvedValue(
      makeSearchResult({
        items: [{ DOI: '10.1234/test', type: 'journal-article', author: authors }],
      }),
    );

    const input = searchWorksTool.input.parse({ query: 'test' });
    const result = await searchWorksTool.handler(input, ctx);

    expect(result.works[0]?.authors?.length).toBe(15);
    expect(result.works[0]?.authors?.at(-1)).toMatchObject({ given: 'G14', family: 'F14' });
  });

  it('renders every author in format() — no cap between the two result paths', async () => {
    const ctx = createMockContext({ errors: searchWorksTool.errors });
    const authors = Array.from({ length: 15 }, (_, i) => ({ given: `G${i}`, family: `F${i}` }));
    mockSearchWorks.mockResolvedValue(
      makeSearchResult({
        items: [{ DOI: '10.1234/test', type: 'journal-article', author: authors }],
      }),
    );

    const input = searchWorksTool.input.parse({ query: 'test' });
    const result = await searchWorksTool.handler(input, ctx);
    const text = searchWorksTool.format!(result)[0]?.text ?? '';

    for (const a of result.works[0]?.authors ?? []) {
      expect(text).toContain(`${a.given} ${a.family}`);
    }
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
    const text = searchWorksTool.format!(result)[0]?.text ?? '';

    expect(result.works[0]?.abstract).toBe(abstract);
    expect(text).toContain(abstract);
    expect(text).not.toContain('…');
  });

  it('renders a short abstract without a false truncation marker', () => {
    const text =
      searchWorksTool.format!({
        works: [{ doi: '10.1234/short', abstract: 'A very short abstract.' }],
      })[0]?.text ?? '';

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

    // HTML stripped by decodeHtmlEntities on the title string
    expect(result.works[0]?.title).toContain('&');
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
    const text = blocks[0]?.text ?? '';
    expect(text).toContain('10.1038/nature12373');
    expect(text).toContain('Le');
    expect(text).toContain('Cong');
    expect(text).toContain('1500');
  });

  it('formats output with nextCursor when present', () => {
    const result = { works: [], nextCursor: 'cursor-abc' };
    const blocks = searchWorksTool.format!(result);
    const text = blocks[0]?.text ?? '';
    expect(text).toContain('cursor-abc');
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
      const outputText = JSON.stringify(result) + (blocks[0]?.text ?? '');

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
