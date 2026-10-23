/**
 * @fileoverview Tests for the crossref_get_prefix tool.
 * @module tests/tools/get-prefix.tool.test
 */

import { JsonRpcErrorCode, requestCancelled } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getPrefixTool } from '@/mcp-server/tools/definitions/get-prefix.tool.js';
import { blockText } from '../helpers/content.js';

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
const mockLookup = vi.fn();

beforeEach(() => {
  vi.mocked(getCrossrefService).mockReturnValue({
    getPrefix: mockGetPrefix,
    getRegistrationAgency: mockLookup,
  } as unknown as ReturnType<typeof getCrossrefService>);
  mockGetPrefix.mockReset();
  mockLookup.mockReset();
  mockLookup.mockResolvedValue({ kind: 'unknown' });
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
    const text = blockText(getPrefixTool.format!(result)[0]);
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
    const text = blockText(blocks[0]);
    expect(text).toContain('10.1038');
    expect(text).toContain('Springer Science and Business Media LLC');
    expect(text).toContain('297');
  });
});

/**
 * The message, hint, and agency for each registry answer are tabled once in
 * registration-agency.test.ts; these pin this tool's wiring: the lookup reads the requested
 * prefix, and the answer reaches both surfaces.
 */
describe('getPrefixTool not-found answer, by registration agency', () => {
  const RECOVERY =
    'Verify the prefix (the "10.NNNN" portion of a DOI), or use crossref_search_works to find the work and its publisher.';

  async function notFound(prefix: string) {
    mockGetPrefix.mockResolvedValue(null);
    const result = await runToolContract(getPrefixTool, { prefix });
    const { error } = result.structuredContent as {
      error: { code: number; message: string; data: Record<string, unknown> };
    };
    return { error, text: result.content.map(blockText).join('\n') };
  }

  it('keeps the message and recovery exactly as before when the registry gives no readable answer', async () => {
    const { error, text } = await notFound('10.99999999');

    expect(mockLookup).toHaveBeenCalledWith('10.99999999', expect.anything());
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.message).toBe('No Crossref member owns prefix: 10.99999999');
    expect(error.data).toMatchObject({
      reason: 'prefix_not_found',
      prefix: '10.99999999',
      recovery: { hint: RECOVERY },
    });
    expect(error.data).not.toHaveProperty('registrationAgency');
    expect(text).toContain(
      `Error: No Crossref member owns prefix: 10.99999999\n\nRecovery: ${RECOVERY}`,
    );
  });

  it('names the agency that holds a prefix Crossref does not, on both surfaces', async () => {
    mockLookup.mockResolvedValue({ kind: 'registered', agency: 'DataCite' });
    const { error, text } = await notFound('10.5281');

    expect(error.message).toBe(
      'No Crossref member owns prefix: 10.5281 — it is registered with DataCite, not Crossref.',
    );
    expect(error.data).toMatchObject({
      reason: 'prefix_not_found',
      prefix: '10.5281',
      registrationAgency: 'DataCite',
      recovery: {
        hint: "No Crossref tool can return works under a prefix registered with DataCite; query DataCite's metadata service for them.",
      },
    });
    expect(text).toContain(
      "Error: No Crossref member owns prefix: 10.5281 — it is registered with DataCite, not Crossref.\n\nRecovery: No Crossref tool can return works under a prefix registered with DataCite; query DataCite's metadata service for them.",
    );
  });

  it('propagates caller cancellation during the lookup instead of the not-found answer', async () => {
    mockGetPrefix.mockResolvedValue(null);
    mockLookup.mockRejectedValue(requestCancelled('DOI registry lookup cancelled by caller.'));
    const ctx = createMockContext({ errors: getPrefixTool.errors });

    await expect(
      getPrefixTool.handler(getPrefixTool.input.parse({ prefix: '10.5281' }), ctx),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
  });

  it('asks the registry nothing when Crossref resolves the prefix', async () => {
    mockGetPrefix.mockResolvedValue(makeRawPrefix());

    await runToolContract(getPrefixTool, { prefix: '10.1038' });

    expect(mockLookup).not.toHaveBeenCalled();
  });
});
