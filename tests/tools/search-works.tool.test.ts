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

  it('cuts a page that would pass the ~10K cap to the rows that fit, and throws offset_too_large at it', async () => {
    const ctx = createMockContext({ errors: searchWorksTool.errors });
    mockSearchWorks.mockResolvedValue(makeSearchResult({ totalResults: 50_000 }));

    const input = searchWorksTool.input.parse({ query: 'test', offset: 9990, rows: 20 });
    await searchWorksTool.handler(input, ctx);
    expect(mockSearchWorks.mock.calls[0]?.[0]).toMatchObject({ offset: 9990, rows: 10 });

    const atCap = searchWorksTool.input.parse({ query: 'test', offset: 10_000, rows: 20 });
    await expect(searchWorksTool.handler(atCap, ctx)).rejects.toMatchObject({
      data: { reason: 'offset_too_large' },
    });
    expect(mockSearchWorks).toHaveBeenCalledTimes(1);
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

  /** The same heading markup deposited as a title or container title keeps the JATS pass. */
  it('leaves a title and container title carrying heading markup on the JATS pass', async () => {
    const markup =
      '<jats:title>Abstract</jats:title><jats:sec><jats:title>Objectives</jats:title><jats:p>Reducing sedentary behaviour.</jats:p></jats:sec>';
    mockSearchWorks.mockResolvedValue(
      makeSearchResult({
        items: [
          { DOI: '10.1136/bmjopen-2024-095775', title: [markup], 'container-title': [markup] },
        ],
      }),
    );

    const result = await runToolContract(searchWorksTool, { query: 'sedentary' });

    const asTitle = 'Abstract Objectives Reducing sedentary behaviour.';
    const works = (result.structuredContent as { works: Record<string, unknown>[] }).works;
    expect(works[0]).toMatchObject({
      title: asTitle,
      containerTitle: asTitle,
      containerTitles: [asTitle],
    });
  });

  /** The summary's abstract goes through the same normalizer as crossref_get_work's. */
  it('keeps structured-abstract headings apart from their text on both surfaces', async () => {
    mockSearchWorks.mockResolvedValue(
      makeSearchResult({
        items: [
          {
            DOI: '10.1186/s13007-021-00734-5',
            abstract:
              '<jats:title>Abstract</jats:title><jats:sec><jats:title>Background</jats:title><jats:p>Plant traits related to nutrition.</jats:p></jats:sec><jats:sec><jats:title>Results:</jats:title><jats:p>Yield rose.</jats:p></jats:sec>',
          },
        ],
      }),
    );

    const result = await runToolContract(searchWorksTool, { query: 'plant traits' });

    const expected = 'Background: Plant traits related to nutrition. Results: Yield rose.';
    const works = (result.structuredContent as { works: { abstract?: string }[] }).works;
    expect(works[0]?.abstract).toBe(expected);
    expect(contentText(result.content).split('\n')).toContain(`**Abstract:** ${expected}`);
  });

  it('omits an abstract with no text left from both surfaces', async () => {
    mockSearchWorks.mockResolvedValue(
      makeSearchResult({
        items: [
          {
            DOI: '10.1093/eurheartj/ehaa444',
            title: ['A record'],
            abstract: '<jats:title>Abstract</jats:title><jats:p/>',
          },
        ],
      }),
    );
    const emptied = await runToolContract(searchWorksTool, { query: 'q' });
    mockSearchWorks.mockResolvedValue(
      makeSearchResult({ items: [{ DOI: '10.1093/eurheartj/ehaa444', title: ['A record'] }] }),
    );
    const absent = await runToolContract(searchWorksTool, { query: 'q' });

    const works = (emptied.structuredContent as { works: object[] }).works;
    expect(works[0]).not.toHaveProperty('abstract');
    expect(emptied.structuredContent).toEqual(absent.structuredContent);
    expect(emptied.content).toEqual(absent.content);
    expect(contentText(emptied.content)).not.toContain('**Abstract:**');
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

  it('accepts rows 0 through 1000 and refuses either side of them', () => {
    for (const rows of [0, 1, 500, 1000]) {
      expect(() => searchWorksTool.input.parse({ query: 'test', rows })).not.toThrow();
    }
    for (const rows of [-1, 1001]) {
      expect(() => searchWorksTool.input.parse({ query: 'test', rows })).toThrow();
    }
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
  it('clamps rows above 500 and names the next offset on both surfaces', async () => {
    mockSearchWorks.mockResolvedValue(
      makeSearchResult({ totalResults: 1500, items: makeItems(500) }),
    );

    const result = await runToolContract(searchWorksTool, { query: 'test', rows: 501 });

    expect(mockSearchWorks).toHaveBeenCalledWith(
      expect.objectContaining({ rows: 500 }),
      expect.anything(),
    );
    const structured = result.structuredContent as { works: unknown[]; notice?: string };
    expect(structured.works).toHaveLength(500);
    const notice =
      'rows 501 is above the per-call cap of 500, so 500 was applied. Pass offset=500 for the next page — the offset after the 500 records returned, not after the 501 requested.';
    expect(structured.notice).toBe(notice);
    expect(result.content.map(blockText).join('\n')).toContain(notice);
  });

  it('names offset + returned, not offset + requested, on a later offset page', async () => {
    mockSearchWorks.mockResolvedValue(
      makeSearchResult({ totalResults: 1500, items: makeItems(500, 200) }),
    );

    const result = await runToolContract(searchWorksTool, {
      query: 'test',
      offset: 200,
      rows: 1000,
    });

    const notice = (result.structuredContent as { notice?: string }).notice;
    expect(notice).toContain('Pass offset=700 for the next page');
    expect(notice).not.toContain('offset=1200');
  });

  it('accepts a numeric string and clamps it', async () => {
    mockSearchWorks.mockResolvedValue(makeSearchResult({ items: makeItems(500) }));

    const result = await runToolContract(searchWorksTool, { query: 'test', rows: '501' } as never);

    expect(result.isError).toBeFalsy();
    expect(mockSearchWorks).toHaveBeenCalledWith(
      expect.objectContaining({ rows: 500 }),
      expect.anything(),
    );
    expect((result.structuredContent as { notice?: string }).notice).toMatch(
      /^rows 501 is above the per-call cap of 500, so 500 was applied\. /,
    );
  });

  it('evaluates the offset ceiling on the clamped rows: offset 9500 + rows 501 succeeds', async () => {
    mockSearchWorks.mockResolvedValue(
      makeSearchResult({ totalResults: 50_000, items: makeItems(500, 9500) }),
    );

    const result = await runToolContract(searchWorksTool, {
      query: 'test',
      offset: 9500,
      rows: 501,
    });

    expect(result.isError).toBeFalsy();
    expect(mockSearchWorks).toHaveBeenCalledWith(
      expect.objectContaining({ rows: 500, offset: 9500 }),
      expect.anything(),
    );
    // offset 10000 is unusable for any rows, so the page routes to the cursor alone.
    expect((result.structuredContent as { notice?: string }).notice).toBe(
      'rows 501 is above the per-call cap of 500, so 500 was applied. Records past offset 10000 are beyond the ~10000 offset limit. To read them, walk the list with cursor="*" and chain nextCursor; the walk starts at the first record, not at offset 10000.',
    );
  });

  it('applies the 200 rows that fit at offset 9800 + rows 501, naming the cap and the window once', async () => {
    mockSearchWorks.mockResolvedValue(
      makeSearchResult({ totalResults: 50_000, items: makeItems(200, 9800) }),
    );

    const result = await runToolContract(searchWorksTool, {
      query: 'test',
      offset: 9800,
      rows: 501,
    });

    expect(result.isError).toBeFalsy();
    expect(mockSearchWorks).toHaveBeenCalledWith(
      expect.objectContaining({ offset: 9800, rows: 200 }),
      expect.anything(),
    );
    expect((result.structuredContent as { notice?: string }).notice).toBe(
      'rows 501 is above the per-call cap of 500, and offset 9800 + 500 would pass the ~10000 limit Crossref puts on offset + rows, so 200 was applied — the last records offset paging reaches. To read past them, walk the list with cursor="*" and chain nextCursor; the walk starts at the first record, not after these.',
    );
  });

  it('omits the next offset on a cursor page and on a page that ends the list', async () => {
    mockSearchWorks.mockResolvedValue(
      makeSearchResult({ totalResults: 1500, items: makeItems(500), nextCursor: 'AoE=' }),
    );
    const cursorPage = await runToolContract(searchWorksTool, {
      query: 'test',
      cursor: '*',
      rows: 501,
    });
    const cursorNotice = (cursorPage.structuredContent as { notice?: string }).notice;
    expect(cursorNotice).toBe('rows 501 is above the per-call cap of 500, so 500 was applied.');

    mockSearchWorks.mockResolvedValue(makeSearchResult({ totalResults: 60, items: makeItems(60) }));
    const lastPage = await runToolContract(searchWorksTool, { query: 'test', rows: 501 });
    expect((lastPage.structuredContent as { notice?: string }).notice).toBe(
      'rows 501 is above the per-call cap of 500, so 500 was applied.',
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
    mockSearchWorks.mockResolvedValue(makeSearchResult({ items: makeItems(500) }));

    const result = await runToolContract(searchWorksTool, {
      query: 'test',
      rows: 500,
      authorLimit: 500,
    });

    expect(mockSearchWorks).toHaveBeenCalledWith(
      expect.objectContaining({ rows: 500 }),
      expect.anything(),
    );
    expect((result.structuredContent as { works: unknown[] }).works).toHaveLength(500);
    expect((result.structuredContent as { notice?: string }).notice).toBeUndefined();
  });
});

/**
 * `rows` is capped by what the selection carries: 500 when it includes `abstract` or `author` —
 * as an omitted or empty `fields` does, selecting every field — and not at all when it names
 * neither, beyond the schema's 1000. The cap keys on those two names alone, so every other
 * selectable field takes Crossref's full page.
 */
describe('searchWorksTool rows cap by selection', () => {
  const HEAVY_TIER =
    'That cap holds for a fields selection including abstract or author; one naming neither takes rows up to 1000.';
  const ROUTE =
    'the last records offset paging reaches. To read past them, walk the list with cursor="*" and chain nextCursor; the walk starts at the first record, not after these.';
  const selectable = (
    z.toJSONSchema(searchWorksTool.input, { io: 'input' }) as unknown as {
      properties: { fields: { items: { enum: string[] } } };
    }
  ).properties.fields.items.enum;
  const light = selectable.filter((name) => name !== 'abstract' && name !== 'author');

  it.each([
    ['DOI and title', ['DOI', 'title']],
    ['DOI and update-to', ['DOI', 'update-to']],
    ['DOI alone', ['DOI']],
    ['every field but abstract and author', light],
  ])('returns 1000 works and no clamp notice at rows 1000 for %s', async (_label, fields) => {
    mockSearchWorks.mockResolvedValue(
      makeSearchResult({ totalResults: 5000, items: makeItems(1000) }),
    );

    const result = await runToolContract(searchWorksTool, {
      query: 'test',
      fields,
      rows: 1000,
    } as never);

    expect(mockSearchWorks).toHaveBeenCalledWith(
      expect.objectContaining({ rows: 1000 }),
      expect.anything(),
    );
    expect((result.structuredContent as { works: unknown[] }).works).toHaveLength(1000);
    expect((result.structuredContent as { notice?: string }).notice).toBeUndefined();
    expect(contentText(result.content)).not.toContain('per-call cap');
  });

  it.each([
    ['abstract', ['DOI', 'abstract']],
    ['author', ['DOI', 'author']],
    ['both', ['author', 'abstract', 'title']],
  ])('passes rows 500 through untouched once the selection includes %s', async (_label, fields) => {
    mockSearchWorks.mockResolvedValue(
      makeSearchResult({ totalResults: 5000, items: makeItems(500) }),
    );

    const result = await runToolContract(searchWorksTool, {
      query: 'test',
      fields,
      rows: 500,
    } as never);

    expect(mockSearchWorks).toHaveBeenCalledWith(
      expect.objectContaining({ rows: 500 }),
      expect.anything(),
    );
    expect((result.structuredContent as { notice?: string }).notice).toBeUndefined();
  });

  it.each([
    ['abstract', ['DOI', 'abstract'], 501],
    ['author', ['DOI', 'author'], 1000],
    ['both', ['author', 'abstract', 'title'], 750],
  ])(
    'clamps rows at 500 once the selection includes %s, naming the 1000 route',
    async (_label, fields, rows) => {
      mockSearchWorks.mockResolvedValue(
        makeSearchResult({ totalResults: 5000, items: makeItems(500) }),
      );

      const result = await runToolContract(searchWorksTool, {
        query: 'test',
        fields,
        rows,
      } as never);

      expect(mockSearchWorks).toHaveBeenCalledWith(
        expect.objectContaining({ rows: 500 }),
        expect.anything(),
      );
      const notice = `rows ${rows} is above the per-call cap of 500, so 500 was applied. ${HEAVY_TIER} Pass offset=500 for the next page — the offset after the 500 records returned, not after the ${rows} requested.`;
      expect((result.structuredContent as { notice?: string }).notice).toBe(notice);
      expect(renderedText(contentText(result.content))).toContain(notice);
    },
  );

  it.each([
    ['an empty fields', { fields: [] }],
    ['an omitted fields', {}],
  ])('clamps %s at 500 with no selection advice, every field selected', async (_label, extra) => {
    mockSearchWorks.mockResolvedValue(
      makeSearchResult({ totalResults: 5000, items: makeItems(500) }),
    );

    const result = await runToolContract(searchWorksTool, { query: 'test', rows: 601, ...extra });

    expect(mockSearchWorks).toHaveBeenCalledWith(
      expect.objectContaining({ rows: 500 }),
      expect.anything(),
    );
    expect((result.structuredContent as { notice?: string }).notice).toBe(
      'rows 601 is above the per-call cap of 500, so 500 was applied. Pass offset=500 for the next page — the offset after the 500 records returned, not after the 601 requested.',
    );
  });

  it.each([
    [9200, 800],
    [9500, 500],
  ])(
    'fits a light page at offset %i + rows 1000 into the offset window as %i works, naming the cursor route',
    async (offset, applied) => {
      mockSearchWorks.mockResolvedValue(
        makeSearchResult({ totalResults: 50_000, items: makeItems(applied, offset) }),
      );

      const result = await runToolContract(searchWorksTool, {
        query: 'test',
        fields: ['DOI', 'update-to'],
        offset,
        rows: 1000,
      });

      expect(result.isError).toBeFalsy();
      expect(mockSearchWorks).toHaveBeenCalledWith(
        expect.objectContaining({ offset, rows: applied }),
        expect.anything(),
      );
      expect((result.structuredContent as { works: unknown[] }).works).toHaveLength(applied);
      const notice = `offset ${offset} + rows 1000 would pass the ~10000 limit Crossref puts on offset + rows, so ${applied} was applied — ${ROUTE}`;
      expect((result.structuredContent as { notice?: string }).notice).toBe(notice);
      expect(renderedText(contentText(result.content))).toContain(notice);
    },
  );

  it('states the cap and the selection that lifts it in the rows description', () => {
    const schema = z.toJSONSchema(searchWorksTool.input, { io: 'input' }) as unknown as {
      properties: { rows: { description: string } };
    };
    const { description } = schema.properties.rows;
    expect(description).toContain(
      '0–500 per call when fields names abstract or author, or is omitted or empty',
    );
    expect(description).toContain('0–1000 when fields names neither');
    expect(description).not.toContain('600');
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

  it('names a next offset the same rows can follow when the clamped page ends 50 short of the ceiling', async () => {
    mockSearchWorks.mockResolvedValue(
      makeSearchResult({ totalResults: 371_635, items: makeItems(500, 9450) }),
    );

    const page = await runToolContract(searchWorksTool, {
      filter: { issn: '0028-0836' },
      offset: 9450,
      rows: 501,
    });

    const notice =
      'rows 501 is above the per-call cap of 500, so 500 was applied. Pass offset=9950 for the next page — the offset after the 500 records returned, not after the 501 requested.';
    expect((page.structuredContent as { notice?: string }).notice).toBe(notice);
    expect(renderedText(contentText(page.content))).toContain(notice);

    mockSearchWorks.mockResolvedValue(
      makeSearchResult({ totalResults: 371_635, items: makeItems(50, 9950) }),
    );
    const next = await runToolContract(searchWorksTool, {
      filter: { issn: '0028-0836' },
      offset: 9950,
      rows: 501,
    });
    expect(next.isError).toBeFalsy();
    expect(mockSearchWorks).toHaveBeenLastCalledWith(
      expect.objectContaining({ offset: 9950, rows: 50 }),
      expect.anything(),
    );
    expect((next.structuredContent as { works: unknown[] }).works).toHaveLength(50);
  });

  it('applies the rows that still fit when an unclamped offset page passes the ceiling', async () => {
    mockSearchWorks.mockResolvedValue(
      makeSearchResult({ totalResults: 371_635, items: makeItems(50, 9950) }),
    );

    const page = await runToolContract(searchWorksTool, {
      query: 'test',
      offset: 9950,
      rows: 100,
    });

    expect(page.isError).toBeFalsy();
    expect(mockSearchWorks).toHaveBeenCalledWith(
      expect.objectContaining({ offset: 9950, rows: 50 }),
      expect.anything(),
    );
    const notice =
      'offset 9950 + rows 100 would pass the ~10000 limit Crossref puts on offset + rows, so 50 was applied — the last records offset paging reaches. To read past them, walk the list with cursor="*" and chain nextCursor; the walk starts at the first record, not after these.';
    expect((page.structuredContent as { notice?: string }).notice).toBe(notice);
    expect(renderedText(contentText(page.content))).toContain(notice);
  });

  it('answers offset 9999, the last offset any page reaches, with one record', async () => {
    mockSearchWorks.mockResolvedValue(
      makeSearchResult({ totalResults: 371_635, items: makeItems(1, 9999) }),
    );

    const page = await runToolContract(searchWorksTool, { query: 'test', offset: 9999, rows: 2 });

    expect(mockSearchWorks).toHaveBeenCalledWith(
      expect.objectContaining({ offset: 9999, rows: 1 }),
      expect.anything(),
    );
    expect((page.structuredContent as { notice?: string }).notice).toMatch(
      /^offset 9999 \+ rows 2 would pass the ~10000 limit Crossref puts on offset \+ rows, so 1 was applied — /,
    );
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

/**
 * Every (offset, rows) pair either side of the ~10000 offset window on `/works`, run against a
 * fake that answers the way Crossref does: the records when `offset + rows` fits, a rejection when
 * it does not (live: 9950 + 50 → 200, 9950 + 51 → 400). `applied` is the page the call returns;
 * `v050` is what the published 0.5.0 returned — rows capped at 100, and the window checked on the
 * capped rows, refusing every pair that passed it. A pair 0.5.0 answered is answered here with at
 * least as many records.
 */
describe('searchWorksTool offset window', () => {
  const TOTAL = 371_635;
  type Notice = 'none' | 'cut' | 'cap+cut';
  // [offset, rows, applied (null: refused), notice, 0.5.0 applied (null: refused)]
  const WINDOW: Array<[number, number, number | null, Notice, number | null]> = [
    [9999, 1, 1, 'none', 1],
    [9999, 100, 1, 'cut', null],
    [9999, 101, 1, 'cut', null],
    [9999, 500, 1, 'cut', null],
    [9999, 501, 1, 'cap+cut', null],
    [9999, 1000, 1, 'cap+cut', null],
    [9950, 1, 1, 'none', 1],
    [9950, 100, 50, 'cut', null],
    [9950, 101, 50, 'cut', null],
    [9950, 500, 50, 'cut', null],
    [9950, 501, 50, 'cap+cut', null],
    [9950, 1000, 50, 'cap+cut', null],
    [9900, 1, 1, 'none', 1],
    [9900, 100, 100, 'none', 100],
    [9900, 101, 100, 'cut', 100],
    [9900, 500, 100, 'cut', 100],
    [9900, 501, 100, 'cap+cut', 100],
    [9900, 1000, 100, 'cap+cut', 100],
    [9899, 1, 1, 'none', 1],
    [9899, 100, 100, 'none', 100],
    [9899, 101, 101, 'none', 100],
    [9899, 500, 101, 'cut', 100],
    [9899, 501, 101, 'cap+cut', 100],
    [9899, 1000, 101, 'cap+cut', 100],
    [9500, 500, 500, 'none', 100],
    [9501, 500, 499, 'cut', 100],
    [9501, 1000, 499, 'cap+cut', 100],
    ...[1, 100, 101, 500, 501, 1000].flatMap((rows) => [
      [10_000, rows, null, 'none', null] as [number, number, null, Notice, null],
      [10_001, rows, null, 'none', null] as [number, number, null, Notice, null],
    ]),
  ];
  const ROUTE =
    'the last records offset paging reaches. To read past them, walk the list with cursor="*" and chain nextCursor; the walk starts at the first record, not after these.';

  beforeEach(() => {
    mockSearchWorks.mockImplementation(async (opts: { offset?: number; rows: number }) => {
      const offset = opts.offset ?? 0;
      if (offset + opts.rows > 10_000)
        throw new Error(`Crossref refuses offset ${offset} + rows ${opts.rows}`);
      return makeSearchResult({ totalResults: TOTAL, items: makeItems(opts.rows, offset) });
    });
  });

  it.each(WINDOW)(
    'offset %i + rows %i → %s records (notice: %s; 0.5.0: %s)',
    async (offset, rows, applied, notice, v050) => {
      const result = await runToolContract(searchWorksTool, { query: 'test', offset, rows });
      const structured = result.structuredContent as {
        works?: unknown[];
        notice?: string;
        error?: { data?: { reason?: string } };
      };

      if (applied === null) {
        expect(structured.error?.data?.reason).toBe('offset_too_large');
        expect(mockSearchWorks).not.toHaveBeenCalled();
        return;
      }
      expect(result.isError).toBeFalsy();
      expect(mockSearchWorks).toHaveBeenCalledWith(
        expect.objectContaining({ offset, rows: applied }),
        expect.anything(),
      );
      expect(structured.works).toHaveLength(applied);
      if (v050 !== null) expect(applied).toBeGreaterThanOrEqual(v050);
      const expected = {
        none: undefined,
        cut: `offset ${offset} + rows ${rows} would pass the ~10000 limit Crossref puts on offset + rows, so ${applied} was applied — ${ROUTE}`,
        'cap+cut': `rows ${rows} is above the per-call cap of 500, and offset ${offset} + 500 would pass the ~10000 limit Crossref puts on offset + rows, so ${applied} was applied — ${ROUTE}`,
      }[notice];
      expect(structured.notice).toBe(expected);
    },
  );

  it('carries a window-cut page identically on both surfaces', async () => {
    const result = await runToolContract(searchWorksTool, {
      query: 'test',
      offset: 9900,
      rows: 1000,
    });

    const structured = result.structuredContent as {
      works: Array<{ doi: string }>;
      notice?: string;
    };
    const notice = `rows 1000 is above the per-call cap of 500, and offset 9900 + 500 would pass the ~10000 limit Crossref puts on offset + rows, so 100 was applied — ${ROUTE}`;
    expect(structured.notice).toBe(notice);
    const lines = renderedText(contentText(result.content)).split('\n');
    expect(lines.some((line) => line.endsWith(notice))).toBe(true);
    expect(structured.works.map((w) => w.doi)).toEqual(
      Array.from({ length: 100 }, (_, i) => `10.5555/w${9900 + i}`),
    );
    for (const work of structured.works) expect(lines).toContain(`DOI: ${work.doi}`);
  });

  it('says only that the rows were cut when the list ends before the ceiling', async () => {
    mockSearchWorks.mockImplementation(async (opts: { offset?: number; rows: number }) =>
      makeSearchResult({
        totalResults: 9960,
        items: makeItems(9960 - (opts.offset ?? 0), opts.offset),
      }),
    );

    const result = await runToolContract(searchWorksTool, {
      query: 'test',
      offset: 9950,
      rows: 100,
    });

    expect(mockSearchWorks).toHaveBeenCalledWith(
      expect.objectContaining({ offset: 9950, rows: 50 }),
      expect.anything(),
    );
    expect((result.structuredContent as { notice?: string }).notice).toBe(
      'offset 9950 + rows 100 would pass the ~10000 limit Crossref puts on offset + rows, so 50 was applied.',
    );
  });

  /**
   * A list of exactly 10000 records ends on the ceiling itself: the cut page reaches it, and no
   * record lies past it for a cursor walk to reach.
   */
  it('routes nowhere when the list ends exactly at the ceiling', async () => {
    mockSearchWorks.mockImplementation(async (opts: { offset?: number; rows: number }) =>
      makeSearchResult({ totalResults: 10_000, items: makeItems(opts.rows, opts.offset) }),
    );

    const result = await runToolContract(searchWorksTool, {
      query: 'test',
      offset: 9950,
      rows: 100,
    });

    const notice =
      'offset 9950 + rows 100 would pass the ~10000 limit Crossref puts on offset + rows, so 50 was applied.';
    expect((result.structuredContent as { notice?: string }).notice).toBe(notice);
    const lines = renderedText(contentText(result.content)).split('\n');
    expect(lines.some((line) => line.endsWith(notice))).toBe(true);
  });

  it('leaves the cursor page untouched by the window', async () => {
    mockSearchWorks.mockResolvedValue(
      makeSearchResult({ totalResults: TOTAL, items: makeItems(500), nextCursor: 'AoE=' }),
    );

    const result = await runToolContract(searchWorksTool, {
      query: 'test',
      cursor: '*',
      rows: 500,
    });

    expect(mockSearchWorks).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: '*', rows: 500 }),
      expect.anything(),
    );
    expect((result.structuredContent as { notice?: string }).notice).toBeUndefined();
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

/**
 * A book chapter or a proceedings paper deposits its series and then its book or volume as two
 * container titles; `containerTitle` keeps the first, `containerTitles` carries them all.
 */
describe('searchWorksTool container titles', () => {
  function work(result: Awaited<ReturnType<typeof runToolContract>>, index = 0) {
    return (result.structuredContent as { works: Array<Record<string, unknown>> }).works[index];
  }

  it('returns every container title, normalized and escaped like the first', async () => {
    mockSearchWorks.mockResolvedValue(
      makeSearchResult({
        items: [
          {
            DOI: '10.1007/978-3-030-58452-8_1',
            'container-title': ['Lecture Notes in <i>Computer</i> Science', 'ECCV &amp; *2020*'],
          },
        ],
      }),
    );

    const result = await runToolContract(searchWorksTool, { query: 'eccv' });
    const text = result.content.map(blockText).join('\n');

    expect(work(result)).toMatchObject({
      containerTitle: 'Lecture Notes in Computer Science',
      containerTitles: ['Lecture Notes in Computer Science', 'ECCV & *2020*'],
    });
    expect(text.split('\n')).toContain(
      '**Journal:** Lecture Notes in Computer Science | ECCV & \\*2020\\*',
    );
    expect(renderedText(text).split('\n')).toContain(
      'Journal: Lecture Notes in Computer Science | ECCV & *2020*',
    );
  });

  it('returns a one-entry list for one title, and neither field for none', async () => {
    mockSearchWorks.mockResolvedValue(
      makeSearchResult({
        items: [
          { DOI: '10.1000/one', 'container-title': ['Nature'] },
          { DOI: '10.1000/none', 'container-title': [] },
        ],
      }),
    );

    const result = await runToolContract(searchWorksTool, { query: 'x' });
    const text = result.content.map(blockText).join('\n');

    expect(work(result, 0)).toEqual({
      doi: '10.1000/one',
      containerTitle: 'Nature',
      containerTitles: ['Nature'],
    });
    expect(work(result, 1)).toEqual({ doi: '10.1000/none' });
    expect(text.split('\n').filter((line) => line.startsWith('**Journal:**'))).toEqual([
      '**Journal:** Nature',
    ]);
  });
});

/**
 * The member a work record names is the one that holds the DOI now, which for a transferred
 * title is not the member its prefix names. With no `fields`, every work carries it.
 */
describe('searchWorksTool member', () => {
  it('returns memberId on every work that deposits a member, on both surfaces', async () => {
    mockSearchWorks.mockResolvedValue(
      makeSearchResult({
        items: [
          { DOI: '10.1155/2024/9760680', publisher: 'Wiley', member: '311' },
          { DOI: '10.1038/s41586-020-2649-2', member: '297' },
          { DOI: '10.1000/no-member' },
        ],
      }),
    );

    const result = await runToolContract(searchWorksTool, { query: 'x' });
    const works = (result.structuredContent as { works: Array<Record<string, unknown>> }).works;
    const text = result.content.map(blockText).join('\n');

    expect(works.map((w) => w.memberId)).toEqual([311, 297, undefined]);
    expect(works[2]).not.toHaveProperty('memberId');
    expect(
      renderedText(text)
        .split('\n')
        .filter((line) => line.startsWith('Member ID:')),
    ).toEqual(['Member ID: 311', 'Member ID: 297']);
    expect(text).toContain('**Publisher:** Wiley\n**Member ID:** 311');
  });

  /** A member that does not read as a digit string is no ID to pass to crossref_get_member. */
  it.each([
    ['311', 311],
    ['', undefined],
    ['n/a', undefined],
    ['311a', undefined],
    ['http://id.crossref.org/member/297', undefined],
  ])('reads member %j as memberId %j on both surfaces', async (member, memberId) => {
    mockSearchWorks.mockResolvedValue(makeSearchResult({ items: [{ DOI: '10.1000/m', member }] }));

    const result = await runToolContract(searchWorksTool, { query: 'x' });
    const [work] = (result.structuredContent as { works: Array<Record<string, unknown>> }).works;
    const lines = renderedText(result.content.map(blockText).join('\n')).split('\n');

    expect(result.isError).toBeFalsy();
    expect(work?.memberId).toBe(memberId);
    expect(lines.filter((line) => line.startsWith('Member ID:'))).toEqual(
      memberId === undefined ? [] : [`Member ID: ${memberId}`],
    );
  });
});

/**
 * Facet counts: each name and limit reaches the service in the caller's order, a count above the
 * 1000 values Crossref returns per facet goes as 1000, and every facet whose values reached its
 * limit is named with the route to the rest. The service hands values back already ordered.
 */
describe('searchWorksTool facets', () => {
  /** `count` values for one facet, highest count first. */
  function facetValues(count: number) {
    return Array.from({ length: count }, (_, i) => ({ value: `v${i}`, count: count - i }));
  }
  const noticeOf = (result: { structuredContent?: unknown }) =>
    (result.structuredContent as { notice?: string }).notice;

  it('sends each facet with its limit, in the order given, beside the rest of the request', async () => {
    mockSearchWorks.mockResolvedValue(makeSearchResult({ facets: [] }));

    await runToolContract(searchWorksTool, {
      query: 'CRISPR',
      filter: { type: 'journal-article' },
      sort: 'published',
      order: 'desc',
      fields: ['DOI', 'title'],
      offset: 40,
      rows: 5,
      facets: { 'publisher-name': 10, published: '*' },
    });

    expect(mockSearchWorks).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'CRISPR',
        filter: { type: 'journal-article' },
        sort: 'published',
        order: 'desc',
        fields: ['DOI', 'title'],
        offset: 40,
        rows: 5,
        facets: [
          { name: 'publisher-name', limit: 10 },
          { name: 'published', limit: '*' },
        ],
      }),
      expect.anything(),
    );
  });

  it.each([
    ['omitted', {}],
    ['empty', { facets: {} }],
  ])('sends no facets and returns no facets field when facets is %s', async (_label, extra) => {
    mockSearchWorks.mockResolvedValue(makeSearchResult());

    const result = await runToolContract(searchWorksTool, { query: 'CRISPR', ...extra });

    expect(mockSearchWorks.mock.calls[0]?.[0]).not.toHaveProperty('facets');
    expect(result.structuredContent).not.toHaveProperty('facets');
    expect(contentText(result.content)).not.toContain('Facet');
  });

  it('returns the facets in the order requested, on both surfaces, whatever order Crossref sent', async () => {
    const published = [
      { value: '2023', count: 15_590 },
      { value: '2024', count: 9710 },
    ];
    const publishers = [{ value: 'Elsevier BV', count: 20_587 }];
    mockSearchWorks.mockResolvedValue(
      makeSearchResult({
        totalResults: 81_613,
        items: [],
        facets: [
          { name: 'publisher-name', values: publishers },
          { name: 'published', values: published },
        ],
      }),
    );

    const result = await runToolContract(searchWorksTool, {
      filter: { 'update-type': 'retraction' },
      rows: 0,
      facets: { published: '*', 'publisher-name': 10 },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      works: [],
      totalResults: 81_613,
      returned: 0,
      facets: [
        { name: 'published', values: published },
        { name: 'publisher-name', values: publishers },
      ],
    });
    expect(blockText(result.content[0]).split('\n')).toEqual([
      '**Facet:** published — 2 values',
      '- 2023: 15590',
      '- 2024: 9710',
      '',
      '**Facet:** publisher-name — 1 value',
      '- Elsevier BV: 20587',
      '',
    ]);
    expect(blockText(result.content[1])).toContain('81613');
  });

  it('sends a count above 1000 as 1000, naming the count requested and applied on both surfaces', async () => {
    mockSearchWorks.mockResolvedValue(
      makeSearchResult({ facets: [{ name: 'affiliation', values: facetValues(3) }] }),
    );

    const result = await runToolContract(searchWorksTool, {
      query: 'q',
      facets: { affiliation: 1500 },
    });

    expect(mockSearchWorks).toHaveBeenCalledWith(
      expect.objectContaining({ facets: [{ name: 'affiliation', limit: 1000 }] }),
      expect.anything(),
    );
    const notice =
      'facets.affiliation 1500 is above the 1000 values Crossref returns per facet, so 1000 was applied.';
    expect(noticeOf(result)).toBe(notice);
    expect(renderedText(contentText(result.content))).toContain(notice);
  });

  it('sends 1000 and "*" as given, with no clamp notice', async () => {
    mockSearchWorks.mockResolvedValue(
      makeSearchResult({
        facets: [
          { name: 'orcid', values: facetValues(4) },
          { name: 'issn', values: facetValues(4) },
        ],
      }),
    );

    const result = await runToolContract(searchWorksTool, {
      query: 'q',
      facets: { orcid: 1000, issn: '*' },
    });

    expect(mockSearchWorks).toHaveBeenCalledWith(
      expect.objectContaining({
        facets: [
          { name: 'orcid', limit: 1000 },
          { name: 'issn', limit: '*' },
        ],
      }),
      expect.anything(),
    );
    expect(noticeOf(result)).toBeUndefined();
  });

  it('names a facet that returned as many values as its count, and none that returned fewer', async () => {
    mockSearchWorks.mockResolvedValue(
      makeSearchResult({
        facets: [
          { name: 'publisher-name', values: facetValues(10) },
          { name: 'published', values: facetValues(62) },
          { name: 'type-name', values: facetValues(12) },
          { name: 'orcid', values: facetValues(999) },
        ],
      }),
    );

    const result = await runToolContract(searchWorksTool, {
      query: 'q',
      facets: { 'publisher-name': 10, published: '*', 'type-name': 20, orcid: '*' },
    });

    const notice =
      'Facet publisher-name (10) returned as many values as its limit and may have more: a larger count, up to 1000, or "*" returns more.';
    expect(noticeOf(result)).toBe(notice);
    expect(renderedText(contentText(result.content))).toContain(notice);
  });

  it('names every facet that reached a count below 1000 in one sentence', async () => {
    mockSearchWorks.mockResolvedValue(
      makeSearchResult({
        facets: [
          { name: 'publisher-name', values: facetValues(10) },
          { name: 'orcid', values: facetValues(20) },
          { name: 'funder-name', values: facetValues(5) },
        ],
      }),
    );

    const result = await runToolContract(searchWorksTool, {
      query: 'q',
      facets: { 'publisher-name': 10, orcid: 20, 'funder-name': 5 },
    });

    expect(noticeOf(result)).toBe(
      'Facets publisher-name (10), orcid (20), and funder-name (5) returned as many values as their limits and may have more: a larger count, up to 1000, or "*" returns more.',
    );
  });

  it.each([
    ['"*"', '*'],
    ['1000', 1000],
    ['a count of 5000, applied as 1000', 5000],
  ])(
    'names a facet that returned 1000 values under %s with the narrowing route alone',
    async (_label, limit) => {
      mockSearchWorks.mockResolvedValue(
        makeSearchResult({ facets: [{ name: 'affiliation', values: facetValues(1000) }] }),
      );

      const result = await runToolContract(searchWorksTool, {
        query: 'q',
        facets: { affiliation: limit },
      } as never);

      const notice = noticeOf(result) ?? '';
      expect(notice).toContain(
        'Facet affiliation returned 1000 values, the most Crossref returns per facet, and may have more: only a narrower query or filter reaches the rest.',
      );
      expect(notice).not.toContain('larger count');
      expect(renderedText(contentText(result.content))).toContain(notice);
    },
  );

  it('carries the clamp and both kinds of filled facet in one notice', async () => {
    mockSearchWorks.mockResolvedValue(
      makeSearchResult({
        facets: [
          { name: 'affiliation', values: facetValues(1000) },
          { name: 'publisher-name', values: facetValues(10) },
          { name: 'container-title', values: facetValues(1000) },
        ],
      }),
    );

    const result = await runToolContract(searchWorksTool, {
      query: 'q',
      facets: { affiliation: 1500, 'publisher-name': 10, 'container-title': '*' },
    });

    expect(noticeOf(result)).toBe(
      'facets.affiliation 1500 is above the 1000 values Crossref returns per facet, so 1000 was applied. Facet publisher-name (10) returned as many values as its limit and may have more: a larger count, up to 1000, or "*" returns more. Facets affiliation and container-title returned 1000 values, the most Crossref returns per facet, and may have more: only a narrower query or filter reaches the rest.',
    );
  });

  it('sends rows 0 and returns no works and no nextCursor, even beside a token Crossref sent', async () => {
    mockSearchWorks.mockResolvedValue(
      makeSearchResult({
        totalResults: 81_613,
        items: [],
        nextCursor: 'AoE=',
        facets: [{ name: 'type-name', values: facetValues(3) }],
      }),
    );

    const result = await runToolContract(searchWorksTool, {
      filter: { 'update-type': 'retraction' },
      cursor: '*',
      rows: 0,
      facets: { 'type-name': '*' },
    });

    expect(mockSearchWorks).toHaveBeenCalledWith(
      expect.objectContaining({ rows: 0, cursor: '*' }),
      expect.anything(),
    );
    expect(result.structuredContent).toMatchObject({ works: [], returned: 0 });
    expect(result.structuredContent).not.toHaveProperty('nextCursor');
    expect(contentText(result.content)).not.toContain('Next cursor');
  });

  it('renders the facets ahead of the works, and the cursor line ahead of both', () => {
    const blocks = searchWorksTool.format!({
      works: [{ doi: '10.1000/a', title: 'A work' }],
      nextCursor: 'AoE=',
      facets: [
        { name: 'type-name', values: [{ value: 'Journal Article', count: 3 }] },
        { name: 'category-name', values: [] },
      ],
    });

    expect(blockText(blocks[0]).split('\n')).toEqual([
      '**Next cursor:** `AoE=`',
      '',
      '**Facet:** type-name — 1 value',
      '- Journal Article: 3',
      '',
      '**Facet:** category-name — no values',
      '',
      '### A work',
      '**DOI:** 10.1000/a',
      '',
    ]);
  });

  it('renders every value of a 1000-value facet, one list item each', () => {
    const values = facetValues(1000);
    const [block] = searchWorksTool.format!({
      works: [],
      facets: [{ name: 'affiliation', values }],
    });

    const items = blockText(block)
      .split('\n')
      .filter((line) => line.startsWith('- '));
    expect(items).toHaveLength(1000);
    expect(items[0]).toBe('- v0: 1000');
    expect(items.at(-1)).toBe('- v999: 1');
  });

  it('declares facets on the wire schema clients receive', async () => {
    mockSearchWorks.mockResolvedValue(
      makeSearchResult({ facets: [{ name: 'published', values: facetValues(2) }] }),
    );
    const ctx = createMockContext({ errors: searchWorksTool.errors });

    const result = await searchWorksTool.handler(
      searchWorksTool.input.parse({ query: 'q', facets: { published: '*' } }),
      ctx,
    );

    const wire = wireSchema.parse({ ...result, ...getEnrichment(ctx) });
    expect(wire.facets).toEqual([{ name: 'published', values: facetValues(2) }]);
  });
});
