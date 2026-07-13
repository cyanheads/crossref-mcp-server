/**
 * @fileoverview Tests for the crossref_get_member tool.
 * @module tests/tools/get-member.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getMemberTool } from '@/mcp-server/tools/definitions/get-member.tool.js';

// Mock the service module so tests never hit the network
vi.mock('@/services/crossref/crossref-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/crossref/crossref-service.js')>();
  return {
    ...actual,
    getCrossrefService: vi.fn(),
  };
});

import { getCrossrefService } from '@/services/crossref/crossref-service.js';

const mockGetMember = vi.fn();

beforeEach(() => {
  vi.mocked(getCrossrefService).mockReturnValue({ getMember: mockGetMember } as ReturnType<
    typeof getCrossrefService
  >);
  mockGetMember.mockReset();
});

/** Minimal but realistic raw Crossref member record (shape mirrors the live /members/{id} response). */
function makeRawMember(overrides: Record<string, unknown> = {}) {
  return {
    id: 297,
    'primary-name': 'Springer Science and Business Media LLC',
    names: [
      'Springer Science and Business Media LLC',
      'Springer-Verlag',
      'Springer (Biomed Central Ltd.)',
    ],
    prefixes: ['10.1007', '10.1038', '10.1186'],
    prefix: [
      { name: 'Springer-Verlag', value: '10.1007' },
      { name: 'Springer Nature', value: '10.1038' },
    ],
    counts: {
      'current-dois': 2401320,
      'backfile-dois': 16326264,
      'total-dois': 18727584,
    },
    'counts-type': {
      all: {
        'journal-article': 11168081,
        'book-chapter': 7312822,
        book: 370941,
        'posted-content': 351969,
        proceedings: 0,
      },
      current: {},
      backfile: {},
    },
    coverage: {
      'references-current': 0.8656243232888579,
      'references-backfile': 0.7042172661179557,
      'abstracts-current': 0.2459951193510236,
      'abstracts-backfile': 0.07027088377353202,
    },
    flags: {
      deposits: true,
      'deposits-articles': true,
      'deposits-references-current': true,
    },
    location: 'Dordrecht, GX, Netherlands',
    tokens: ['springer'],
    'last-status-check-time': 1783897818337,
    ...overrides,
  };
}

describe('getMemberTool', () => {
  it('returns projected publisher metadata for a valid member ID', async () => {
    const ctx = createMockContext({ errors: getMemberTool.errors });
    mockGetMember.mockResolvedValue(makeRawMember());

    const input = getMemberTool.input.parse({ member_id: 297 });
    const result = await getMemberTool.handler(input, ctx);

    expect(result.id).toBe(297);
    expect(result.primaryName).toBe('Springer Science and Business Media LLC');
    expect(result.location).toBe('Dordrecht, GX, Netherlands');
    expect(result.prefixes).toContain('10.1038');
    expect(result.counts?.totalDois).toBe(18727584);
    expect(result.counts?.currentDois).toBe(2401320);
    expect(result.counts?.backfileDois).toBe(16326264);
    expect(result.deposits).toBe(true);
    expect(result.depositsArticles).toBe(true);
  });

  it('filters the primary name out of the alternate names list', async () => {
    const ctx = createMockContext({ errors: getMemberTool.errors });
    mockGetMember.mockResolvedValue(makeRawMember());

    const input = getMemberTool.input.parse({ member_id: 297 });
    const result = await getMemberTool.handler(input, ctx);

    expect(result.names).not.toContain('Springer Science and Business Media LLC');
    expect(result.names).toContain('Springer-Verlag');
  });

  it('normalizes coverage into per-category current/backfile pairs, sorted by category', async () => {
    const ctx = createMockContext({ errors: getMemberTool.errors });
    mockGetMember.mockResolvedValue(makeRawMember());

    const input = getMemberTool.input.parse({ member_id: 297 });
    const result = await getMemberTool.handler(input, ctx);

    const references = result.coverage?.find((c) => c.category === 'references');
    expect(references?.current).toBeCloseTo(0.8656, 3);
    expect(references?.backfile).toBeCloseTo(0.7042, 3);
    // Sorted alphabetically → abstracts precedes references
    expect(result.coverage?.[0]?.category).toBe('abstracts');
  });

  it('sorts worksByType by count descending and drops zero-count types', async () => {
    const ctx = createMockContext({ errors: getMemberTool.errors });
    mockGetMember.mockResolvedValue(makeRawMember());

    const input = getMemberTool.input.parse({ member_id: 297 });
    const result = await getMemberTool.handler(input, ctx);

    expect(result.worksByType?.[0]).toEqual({ type: 'journal-article', count: 11168081 });
    expect(result.worksByType?.[1]).toEqual({ type: 'book-chapter', count: 7312822 });
    // proceedings has count 0 and must be excluded
    expect(result.worksByType?.some((w) => w.type === 'proceedings')).toBe(false);
  });

  it('handles a sparse member — no coverage, counts, or flags', async () => {
    const ctx = createMockContext({ errors: getMemberTool.errors });
    mockGetMember.mockResolvedValue(
      makeRawMember({
        coverage: undefined,
        counts: undefined,
        'counts-type': undefined,
        flags: undefined,
        location: undefined,
      }),
    );

    const input = getMemberTool.input.parse({ member_id: 297 });
    const result = await getMemberTool.handler(input, ctx);

    expect(result.coverage).toBeUndefined();
    expect(result.counts).toBeUndefined();
    expect(result.worksByType).toBeUndefined();
    expect(result.deposits).toBeUndefined();
    expect(result.depositsArticles).toBeUndefined();
    expect(result.location).toBeUndefined();
    // format must still render without fabricating values
    const blocks = getMemberTool.format!(result);
    expect(blocks[0]?.text).toContain('Springer Science and Business Media LLC');
  });

  it('throws member_not_found when the service returns null', async () => {
    const ctx = createMockContext({ errors: getMemberTool.errors });
    mockGetMember.mockResolvedValue(null);

    const input = getMemberTool.input.parse({ member_id: 999999999 });
    await expect(getMemberTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'member_not_found' },
    });
  });

  it('rejects non-positive or non-integer member_id via the Zod schema', () => {
    expect(() => getMemberTool.input.parse({ member_id: 0 })).toThrow();
    expect(() => getMemberTool.input.parse({ member_id: -5 })).toThrow();
    expect(() => getMemberTool.input.parse({ member_id: 1.5 })).toThrow();
  });

  it('formats output with publisher name, DOI counts, works, and coverage', () => {
    const result = {
      id: 297,
      primaryName: 'Springer Science and Business Media LLC',
      names: ['Springer-Verlag'],
      location: 'Dordrecht, GX, Netherlands',
      prefixes: ['10.1007', '10.1038'],
      counts: { totalDois: 18727584, currentDois: 2401320, backfileDois: 16326264 },
      worksByType: [{ type: 'journal-article', count: 11168081 }],
      coverage: [{ category: 'references', current: 0.86, backfile: 0.7 }],
      deposits: true,
      depositsArticles: true,
    };
    const blocks = getMemberTool.format!(result);
    const text = blocks[0]?.text ?? '';
    expect(text).toContain('Springer Science and Business Media LLC');
    expect(text).toContain('297');
    expect(text).toContain('10.1038');
    expect(text).toContain('18727584');
    expect(text).toContain('journal-article');
    expect(text).toContain('references');
    expect(text).toContain('86%');
    expect(text).toContain('Yes');
  });

  it('security: output does not leak CROSSREF_MAILTO env value', async () => {
    const originalMailto = process.env.CROSSREF_MAILTO;
    process.env.CROSSREF_MAILTO = 'secret@internal.example.com';
    try {
      const ctx = createMockContext({ errors: getMemberTool.errors });
      mockGetMember.mockResolvedValue(makeRawMember());

      const input = getMemberTool.input.parse({ member_id: 297 });
      const result = await getMemberTool.handler(input, ctx);
      const blocks = getMemberTool.format!(result);
      const outputText = JSON.stringify(result) + (blocks[0]?.text ?? '');

      expect(outputText).not.toContain('secret@internal.example.com');
    } finally {
      if (originalMailto === undefined) delete process.env.CROSSREF_MAILTO;
      else process.env.CROSSREF_MAILTO = originalMailto;
    }
  });
});
