/**
 * @fileoverview Tests for the crossref_get_work tool.
 * @module tests/tools/get-work.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getWorkTool } from '@/mcp-server/tools/definitions/get-work.tool.js';

// Mock the service module so tests never hit the network
vi.mock('@/services/crossref/crossref-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/crossref/crossref-service.js')>();
  return {
    ...actual,
    getCrossrefService: vi.fn(),
  };
});

import { getCrossrefService } from '@/services/crossref/crossref-service.js';

const mockGetWork = vi.fn();

beforeEach(() => {
  vi.mocked(getCrossrefService).mockReturnValue({ getWork: mockGetWork } as ReturnType<
    typeof getCrossrefService
  >);
  mockGetWork.mockReset();
});

/** Minimal raw Crossref work record. */
function makeRawWork(overrides: Record<string, unknown> = {}) {
  return {
    DOI: '10.1038/nature12373',
    type: 'journal-article',
    title: ['Cas9 in mammals'],
    'container-title': ['Nature'],
    publisher: 'Springer Nature',
    'is-referenced-by-count': 1500,
    'references-count': 42,
    published: { 'date-parts': [[2013, 8, 22]] },
    author: [
      {
        given: 'Le',
        family: 'Cong',
        ORCID: 'https://orcid.org/0000-0001-1234-5678',
        sequence: 'first',
      },
    ],
    abstract: 'Abstract text here.',
    ...overrides,
  };
}

describe('getWorkTool', () => {
  it('returns full metadata for a valid DOI', async () => {
    const ctx = createMockContext({ errors: getWorkTool.errors });
    mockGetWork.mockResolvedValue(makeRawWork());

    const input = getWorkTool.input.parse({ doi: '10.1038/nature12373' });
    const result = await getWorkTool.handler(input, ctx);

    expect(result.doi).toBe('10.1038/nature12373');
    expect(result.type).toBe('journal-article');
    expect(result.title).toBe('Cas9 in mammals');
    expect(result.containerTitle).toBe('Nature');
    expect(result.isReferencedByCount).toBe(1500);
    expect(result.referencesCount).toBe(42);
    expect(result.published?.year).toBe(2013);
    expect(result.authors?.[0]?.given).toBe('Le');
    expect(result.authors?.[0]?.family).toBe('Cong');
  });

  it('handles sparse upstream record — no abstract, no authors', async () => {
    const ctx = createMockContext({ errors: getWorkTool.errors });
    mockGetWork.mockResolvedValue(makeRawWork({ abstract: undefined, author: undefined }));

    const input = getWorkTool.input.parse({ doi: '10.1038/nature12373' });
    const result = await getWorkTool.handler(input, ctx);

    expect(result.abstract).toBeUndefined();
    expect(result.authors).toBeUndefined();
    // format should still work without fabricating values
    const blocks = getWorkTool.format!(result);
    expect(blocks[0]?.text).toContain('*Not deposited*');
  });

  it('throws doi_not_found when service returns null', async () => {
    const ctx = createMockContext({ errors: getWorkTool.errors });
    mockGetWork.mockResolvedValue(null);

    const input = getWorkTool.input.parse({ doi: '10.9999/nonexistent' });
    await expect(getWorkTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'doi_not_found' },
    });
  });

  it('formats output with title, doi, and authors', () => {
    const result = {
      doi: '10.1038/nature12373',
      type: 'journal-article',
      title: 'Cas9 in mammals',
      authors: [{ given: 'Le', family: 'Cong' }],
      abstract: 'Some abstract.',
      isReferencedByCount: 1500,
    };
    const blocks = getWorkTool.format!(result);
    expect(blocks[0]?.type).toBe('text');
    const text = blocks[0]?.text ?? '';
    expect(text).toContain('10.1038/nature12373');
    expect(text).toContain('Le');
    expect(text).toContain('Cong');
    expect(text).toContain('Some abstract.');
    expect(text).toContain('1500');
  });
});
