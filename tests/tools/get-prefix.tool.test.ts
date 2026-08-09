/**
 * @fileoverview Tests for the crossref_get_prefix tool.
 * @module tests/tools/get-prefix.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getPrefixTool } from '@/mcp-server/tools/definitions/get-prefix.tool.js';

// Mock the service module so tests never hit the network
vi.mock('@/services/crossref/crossref-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/crossref/crossref-service.js')>();
  return {
    ...actual,
    getCrossrefService: vi.fn(),
  };
});

import { getCrossrefService } from '@/services/crossref/crossref-service.js';

const mockGetPrefix = vi.fn();

beforeEach(() => {
  vi.mocked(getCrossrefService).mockReturnValue({ getPrefix: mockGetPrefix } as ReturnType<
    typeof getCrossrefService
  >);
  mockGetPrefix.mockReset();
});

/** Raw Crossref prefix record — member and prefix are URIs, matching the live response. */
function makeRawPrefix(overrides: Record<string, unknown> = {}) {
  return {
    member: 'https://id.crossref.org/member/297',
    name: 'Springer Science and Business Media LLC',
    prefix: 'https://id.crossref.org/prefix/10.1038',
    ...overrides,
  };
}

describe('getPrefixTool', () => {
  it('resolves a prefix to owner name and numeric member ID', async () => {
    const ctx = createMockContext({ errors: getPrefixTool.errors });
    mockGetPrefix.mockResolvedValue(makeRawPrefix());

    const input = getPrefixTool.input.parse({ prefix: '10.1038' });
    const result = await getPrefixTool.handler(input, ctx);

    expect(result.prefix).toBe('10.1038');
    expect(result.ownerName).toBe('Springer Science and Business Media LLC');
    expect(result.memberId).toBe(297);
  });

  it('extracts the bare prefix from the prefix URI', async () => {
    const ctx = createMockContext({ errors: getPrefixTool.errors });
    mockGetPrefix.mockResolvedValue(
      makeRawPrefix({
        prefix: 'https://id.crossref.org/prefix/10.1371',
        member: 'https://id.crossref.org/member/340',
        name: 'Public Library of Science (PLoS)',
      }),
    );

    const input = getPrefixTool.input.parse({ prefix: '10.1371' });
    const result = await getPrefixTool.handler(input, ctx);

    expect(result.prefix).toBe('10.1371');
    expect(result.memberId).toBe(340);
  });

  it('decodes HTML entities in the owner name', async () => {
    const ctx = createMockContext({ errors: getPrefixTool.errors });
    mockGetPrefix.mockResolvedValue(
      makeRawPrefix({ name: '&quot;Medycyna Praktyczna&quot; Spolka Jawna' }),
    );

    const input = getPrefixTool.input.parse({ prefix: '10.1038' });
    const result = await getPrefixTool.handler(input, ctx);

    expect(result.ownerName).toBe('"Medycyna Praktyczna" Spolka Jawna');
    const text = getPrefixTool.format!(result)[0]?.text ?? '';
    expect(text).toContain('**Owner:** "Medycyna Praktyczna" Spolka Jawna');
    expect(text).not.toContain('&quot;');
  });

  it('handles a thin payload — member URI absent, falls back to input prefix', async () => {
    const ctx = createMockContext({ errors: getPrefixTool.errors });
    mockGetPrefix.mockResolvedValue({ name: 'Some Publisher' });

    const input = getPrefixTool.input.parse({ prefix: '10.5555' });
    const result = await getPrefixTool.handler(input, ctx);

    expect(result.prefix).toBe('10.5555');
    expect(result.ownerName).toBe('Some Publisher');
    expect(result.memberId).toBeUndefined();
  });

  it('throws prefix_not_found when the service returns null', async () => {
    const ctx = createMockContext({ errors: getPrefixTool.errors });
    mockGetPrefix.mockResolvedValue(null);

    const input = getPrefixTool.input.parse({ prefix: '10.99999999' });
    await expect(getPrefixTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'prefix_not_found' },
    });
  });

  it('rejects a malformed prefix via the Zod schema', () => {
    expect(() => getPrefixTool.input.parse({ prefix: '10.1038/nature12373' })).toThrow();
    expect(() => getPrefixTool.input.parse({ prefix: 'abc' })).toThrow();
    expect(() => getPrefixTool.input.parse({ prefix: '10.' })).toThrow();
  });

  it('formats output with prefix, owner, and member ID', () => {
    const result = {
      prefix: '10.1038',
      ownerName: 'Springer Science and Business Media LLC',
      memberId: 297,
    };
    const blocks = getPrefixTool.format!(result);
    const text = blocks[0]?.text ?? '';
    expect(text).toContain('10.1038');
    expect(text).toContain('Springer Science and Business Media LLC');
    expect(text).toContain('297');
  });
});
