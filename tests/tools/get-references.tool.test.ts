/**
 * @fileoverview Tests for the crossref_get_references tool.
 * @module tests/tools/get-references.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
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

  it('throws doi_not_found when service returns null', async () => {
    const ctx = createMockContext({ errors: getReferencesTool.errors });
    mockGetWork.mockResolvedValue(null);

    const input = getReferencesTool.input.parse({ doi: '10.9999/nonexistent' });
    await expect(getReferencesTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'doi_not_found' },
    });
  });

  it('throws no_references when record has empty reference list', async () => {
    const ctx = createMockContext({ errors: getReferencesTool.errors });
    mockGetWork.mockResolvedValue({
      DOI: '10.1038/nature12373',
      type: 'journal-article',
      reference: [],
    });

    const input = getReferencesTool.input.parse({ doi: '10.1038/nature12373' });
    await expect(getReferencesTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_references' },
    });
  });

  it('throws no_references when reference field is absent', async () => {
    const ctx = createMockContext({ errors: getReferencesTool.errors });
    mockGetWork.mockResolvedValue({ DOI: '10.1038/nature12373', type: 'journal-article' });

    const input = getReferencesTool.input.parse({ doi: '10.1038/nature12373' });
    await expect(getReferencesTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_references' },
    });
  });

  it('formats output including doi, key, and raw citation', () => {
    const result = {
      doi: '10.1038/nature12373',
      referenceCount: 2,
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
});
