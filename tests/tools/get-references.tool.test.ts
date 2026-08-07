/**
 * @fileoverview Tests for the crossref_get_references tool.
 * @module tests/tools/get-references.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getReferencesTool } from '@/mcp-server/tools/definitions/get-references.tool.js';

vi.mock('@/services/crossref/crossref-service.js', () => ({
  getCrossrefService: vi.fn(),
}));

import { getCrossrefService } from '@/services/crossref/crossref-service.js';

const mockGetWork = vi.fn();

beforeEach(() => {
  vi.mocked(getCrossrefService).mockReturnValue({ getWork: mockGetWork } as ReturnType<
    typeof getCrossrefService
  >);
  mockGetWork.mockReset();
});

const REF_LIST = [
  {
    key: 'ref1',
    DOI: '10.1000/ref1',
    unstructured: 'Smith J. 2010. A paper. Nature.',
    author: 'Smith',
    year: '2010',
    'article-title': 'A paper',
    'journal-title': 'Nature',
    volume: '42',
    'first-page': '100',
    issn: '1234-5678',
  },
  { key: 'ref2', unstructured: 'Jones B. 2015. Another paper.' },
];

describe('getReferencesTool', () => {
  it('returns the reference list for a valid DOI', async () => {
    const ctx = createMockContext({ errors: getReferencesTool.errors });
    mockGetWork.mockResolvedValue({
      DOI: '10.1038/nature12373',
      type: 'journal-article',
      reference: REF_LIST,
    });

    const input = getReferencesTool.input.parse({ doi: '10.1038/nature12373' });
    const result = await getReferencesTool.handler(input, ctx);

    expect(result.doi).toBe('10.1038/nature12373');
    expect(result.referenceCount).toBe(2);
    expect(result.references[0]?.doi).toBe('10.1000/ref1');
    expect(result.references[0]?.key).toBe('ref1');
    expect(result.references[0]?.author).toBe('Smith');
    expect(result.references[1]?.unstructured).toBe('Jones B. 2015. Another paper.');
  });

  it('normalizes all reference fields — journalTitle, articleTitle, volume, firstPage, issn', async () => {
    const ctx = createMockContext({ errors: getReferencesTool.errors });
    mockGetWork.mockResolvedValue({
      DOI: '10.1038/nature12373',
      type: 'journal-article',
      reference: [REF_LIST[0]],
    });

    const input = getReferencesTool.input.parse({ doi: '10.1038/nature12373' });
    const result = await getReferencesTool.handler(input, ctx);

    const ref = result.references[0];
    expect(ref?.journalTitle).toBe('Nature');
    expect(ref?.articleTitle).toBe('A paper');
    expect(ref?.volume).toBe('42');
    expect(ref?.firstPage).toBe('100');
    expect(ref?.issn).toBe('1234-5678');
    expect(ref?.year).toBe('2010');
  });

  it('handles reference with only unstructured field', async () => {
    const ctx = createMockContext({ errors: getReferencesTool.errors });
    mockGetWork.mockResolvedValue({
      DOI: '10.1038/nature12373',
      type: 'journal-article',
      reference: [{ unstructured: 'Minimal citation string only.' }],
    });

    const input = getReferencesTool.input.parse({ doi: '10.1038/nature12373' });
    const result = await getReferencesTool.handler(input, ctx);

    expect(result.referenceCount).toBe(1);
    expect(result.references[0]?.unstructured).toBe('Minimal citation string only.');
    expect(result.references[0]?.doi).toBeUndefined();
    expect(result.references[0]?.key).toBeUndefined();
  });

  it('throws doi_not_found when service returns null', async () => {
    const ctx = createMockContext({ errors: getReferencesTool.errors });
    mockGetWork.mockResolvedValue(null);

    const input = getReferencesTool.input.parse({ doi: '10.9999/nonexistent' });
    await expect(getReferencesTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'doi_not_found' },
    });
  });

  it('returns empty reference list and notice when record has empty reference array', async () => {
    const ctx = createMockContext({ errors: getReferencesTool.errors });
    mockGetWork.mockResolvedValue({
      DOI: '10.1038/nature12373',
      type: 'journal-article',
      reference: [],
    });

    const input = getReferencesTool.input.parse({ doi: '10.1038/nature12373' });
    const result = await getReferencesTool.handler(input, ctx);

    expect(result.doi).toBe('10.1038/nature12373');
    expect(result.referenceCount).toBe(0);
    expect(result.references).toHaveLength(0);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toBeDefined();
    expect(enrichment.notice).toMatch(/OpenAlex/);
  });

  it('returns empty reference list and notice when reference field is absent', async () => {
    const ctx = createMockContext({ errors: getReferencesTool.errors });
    mockGetWork.mockResolvedValue({ DOI: '10.1038/nature12373', type: 'journal-article' });

    const input = getReferencesTool.input.parse({ doi: '10.1038/nature12373' });
    const result = await getReferencesTool.handler(input, ctx);

    expect(result.doi).toBe('10.1038/nature12373');
    expect(result.referenceCount).toBe(0);
    expect(result.references).toHaveLength(0);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toBeDefined();
  });

  it('rejects DOI with invalid format via Zod schema', () => {
    expect(() => getReferencesTool.input.parse({ doi: 'not-a-doi' })).toThrow();
    expect(() => getReferencesTool.input.parse({ doi: '10./suffix' })).toThrow();
  });

  it('renders every reference on the page — content[] matches structuredContent', () => {
    const refs = Array.from({ length: 60 }, (_, i) => ({
      key: `ref${i}`,
      doi: `10.1000/r${i}`,
      unstructured: `Citation ${i}`,
      articleTitle: `Title ${i}`,
      year: '2020',
    }));
    const result = { doi: '10.1038/nature12373', referenceCount: 60, offset: 0, references: refs };
    const text = getReferencesTool.format!(result)[0]?.text ?? '';

    expect(text).toContain('10.1038/nature12373');
    for (const r of refs) {
      expect(text).toContain(r.doi);
      expect(text).toContain(r.articleTitle);
      expect(text).toContain(r.unstructured);
    }
    expect(text).not.toContain('more references');
    expect(text).not.toContain('structuredContent');
  });

  it('renders long raw citation strings in full', () => {
    const unstructured = `Author A. 2020. ${'w'.repeat(400)}. Journal of Long Titles.`;
    const result = {
      doi: '10.1038/nature12373',
      referenceCount: 1,
      offset: 0,
      references: [{ key: 'r1', unstructured }],
    };
    const text = getReferencesTool.format!(result)[0]?.text ?? '';

    expect(text).toContain(unstructured);
  });

  it('numbers references by absolute position when rendering a later page', () => {
    const result = {
      doi: '10.1038/nature12373',
      referenceCount: 250,
      offset: 100,
      references: [{ key: 'r101', articleTitle: 'Page two opener' }],
    };
    const text = getReferencesTool.format!(result)[0]?.text ?? '';

    expect(text).toContain('101. Page two opener');
    expect(text).toContain('showing 1 of 250');
  });

  it('pages a long reference list and discloses nextOffset', async () => {
    const ctx = createMockContext({ errors: getReferencesTool.errors });
    const reference = Array.from({ length: 250 }, (_, i) => ({
      key: `ref${i}`,
      unstructured: `Citation ${i}`,
    }));
    mockGetWork.mockResolvedValue({ DOI: '10.1038/big', type: 'journal-article', reference });

    const input = getReferencesTool.input.parse({ doi: '10.1038/big' });
    const result = await getReferencesTool.handler(input, ctx);

    expect(result.referenceCount).toBe(250);
    expect(result.offset).toBe(0);
    expect(result.references).toHaveLength(100);
    expect(getEnrichment(ctx)).toMatchObject({
      nextOffset: 100,
      truncated: true,
      shown: 100,
      cap: 100,
    });
    expect(getEnrichment(ctx).notice).toMatch(/offset=100/);

    /**
     * The wire payload is `output.extend(enrichment).parse({ ...result, ...enrichment })` —
     * a key missing from either schema is stripped there, not at the accumulator getEnrichment
     * reads. Parsing through the effective schema is what pins offset and the paging disclosure
     * to what a client actually receives.
     */
    const wire = getReferencesTool.output
      .extend(getReferencesTool.enrichment!)
      .parse({ ...result, ...getEnrichment(ctx) });
    expect(wire).toMatchObject({
      offset: 0,
      referenceCount: 250,
      nextOffset: 100,
      truncated: true,
      shown: 100,
      cap: 100,
    });
  });

  it('returns the requested page and omits nextOffset on the final page', async () => {
    const ctx = createMockContext({ errors: getReferencesTool.errors });
    const reference = Array.from({ length: 250 }, (_, i) => ({
      key: `ref${i}`,
      unstructured: `Citation ${i}`,
    }));
    mockGetWork.mockResolvedValue({ DOI: '10.1038/big', type: 'journal-article', reference });

    const input = getReferencesTool.input.parse({ doi: '10.1038/big', offset: 200, limit: 100 });
    const result = await getReferencesTool.handler(input, ctx);

    expect(result.offset).toBe(200);
    expect(result.references).toHaveLength(50);
    expect(result.references[0]?.key).toBe('ref200');
    expect(getEnrichment(ctx).nextOffset).toBeUndefined();
    expect(getEnrichment(ctx).truncated).toBeUndefined();
  });

  it('returns every reference in one page when the list fits under the limit', async () => {
    const ctx = createMockContext({ errors: getReferencesTool.errors });
    const reference = Array.from({ length: 60 }, (_, i) => ({ key: `ref${i}` }));
    mockGetWork.mockResolvedValue({ DOI: '10.1038/mid', type: 'journal-article', reference });

    const input = getReferencesTool.input.parse({ doi: '10.1038/mid' });
    const result = await getReferencesTool.handler(input, ctx);

    expect(result.references).toHaveLength(60);
    expect(result.referenceCount).toBe(60);
    expect(getEnrichment(ctx).nextOffset).toBeUndefined();
  });

  it('explains an offset past the end of the reference list', async () => {
    const ctx = createMockContext({ errors: getReferencesTool.errors });
    mockGetWork.mockResolvedValue({
      DOI: '10.1038/nature12373',
      type: 'journal-article',
      reference: REF_LIST,
    });

    const input = getReferencesTool.input.parse({ doi: '10.1038/nature12373', offset: 500 });
    const result = await getReferencesTool.handler(input, ctx);

    expect(result.referenceCount).toBe(2);
    expect(result.references).toHaveLength(0);
    expect(getEnrichment(ctx).notice).toMatch(/past the end/);
  });

  it('rejects a limit above the 500 page ceiling', () => {
    expect(() => getReferencesTool.input.parse({ doi: '10.1038/x1', limit: 501 })).toThrow();
    expect(() => getReferencesTool.input.parse({ doi: '10.1038/x1', offset: -1 })).toThrow();
  });

  it('formats output including doi, key, and raw citation', () => {
    const result = {
      doi: '10.1038/nature12373',
      referenceCount: 2,
      offset: 0,
      references: [
        {
          doi: '10.1000/ref1',
          key: 'ref1',
          unstructured: 'Smith 2010',
          articleTitle: 'A paper',
          year: '2010',
        },
        { unstructured: 'Jones 2015' },
      ],
    };
    const blocks = getReferencesTool.format!(result);
    expect(blocks[0]?.type).toBe('text');
    const text = blocks[0]?.text ?? '';
    expect(text).toContain('10.1038/nature12373');
    expect(text).toContain('10.1000/ref1');
    expect(text).toContain('ref1');
    expect(text).toContain('Smith 2010');
    expect(text).toContain('Jones 2015');
  });

  it('formats volume and firstPage in output', () => {
    const result = {
      doi: '10.1038/nature12373',
      referenceCount: 1,
      offset: 0,
      references: [
        {
          key: 'r1',
          articleTitle: 'Deep Learning',
          year: '2015',
          journalTitle: 'Nature',
          volume: '12',
          firstPage: '5',
        },
      ],
    };
    const blocks = getReferencesTool.format!(result);
    const text = blocks[0]?.text ?? '';
    expect(text).toContain('12');
    expect(text).toContain('5');
    expect(text).toContain('Nature');
  });
});
