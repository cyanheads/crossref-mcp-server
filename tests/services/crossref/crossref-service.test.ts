/**
 * @fileoverview Tests for CrossrefService — polite-pool header, 404 null return, and error propagation.
 * @module tests/services/crossref/crossref-service.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Stub network and retry utilities before importing the service
vi.mock('@cyanheads/mcp-ts-core/utils', () => ({
  httpErrorFromResponse: vi.fn(),
  withRetry: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn().mockReturnValue({
    mailto: 'test@example.com',
    baseUrl: 'https://api.crossref.org',
    timeoutMs: 5000,
  }),
}));

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { httpErrorFromResponse, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { CrossrefService } from '@/services/crossref/crossref-service.js';

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

function makeJsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  };
}

function makeSingleEnvelope(message: unknown) {
  return { status: 'ok', 'message-type': 'work', 'message-version': '1.0.0', message };
}

function makeListEnvelope(items: unknown[], total = 1) {
  return {
    status: 'ok',
    'message-type': 'work-list',
    'message-version': '1.0.0',
    message: {
      'total-results': total,
      'items-per-page': 20,
      items,
    },
  };
}

describe('CrossrefService', () => {
  let service: CrossrefService;

  beforeEach(() => {
    service = new CrossrefService();
    mockFetch.mockReset();
    vi.mocked(withRetry).mockImplementation((fn) => fn());
    vi.mocked(httpErrorFromResponse).mockReset();
  });

  it('injects polite-pool User-Agent header on every request', async () => {
    const rawWork = { DOI: '10.1038/nature12373', type: 'journal-article' };
    mockFetch.mockResolvedValue(makeJsonResponse(makeSingleEnvelope(rawWork)));

    const ctx = createMockContext();
    await service.getWork('10.1038/nature12373', ctx);

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/works/'),
      expect.objectContaining({
        headers: expect.objectContaining({
          'User-Agent': expect.stringContaining('mailto:test@example.com'),
        }),
      }),
    );
  });

  it('returns null for a 404 response on getWork', async () => {
    // Simulate httpErrorFromResponse mapping a 404 → McpError(NotFound)
    vi.mocked(withRetry).mockImplementation(async () => {
      throw new McpError(JsonRpcErrorCode.NotFound, 'Not Found');
    });

    const ctx = createMockContext();
    const result = await service.getWork('10.9999/nonexistent', ctx);
    expect(result).toBeNull();
  });

  it('propagates non-404 errors from getWork', async () => {
    vi.mocked(withRetry).mockRejectedValue(
      new McpError(JsonRpcErrorCode.Conflict, 'Service Unavailable'),
    );

    const ctx = createMockContext();
    await expect(service.getWork('10.1038/nature12373', ctx)).rejects.toMatchObject({
      code: -32002,
    });
  });

  it('builds correct URL with filter and select params for searchWorks', async () => {
    mockFetch.mockResolvedValue(
      makeJsonResponse(makeListEnvelope([{ DOI: '10.1038/nature12373', type: 'journal-article' }])),
    );
    vi.mocked(withRetry).mockImplementation((fn) => fn());

    const ctx = createMockContext();
    await service.searchWorks(
      { query: 'CRISPR', filter: { type: 'journal-article' }, fields: ['DOI', 'title'], rows: 10 },
      ctx,
    );

    const calledUrl = mockFetch.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain('query=CRISPR');
    expect(calledUrl).toContain('filter=type%3Ajournal-article');
    expect(calledUrl).toContain('select=DOI%2Ctitle');
    expect(calledUrl).toContain('rows=10');
  });

  it('uses cursor param when provided and omits offset', async () => {
    mockFetch.mockResolvedValue(
      makeJsonResponse({
        ...makeListEnvelope([]),
        message: {
          'total-results': 100,
          'items-per-page': 20,
          items: [],
          'next-cursor': 'AoE=',
        },
      }),
    );
    vi.mocked(withRetry).mockImplementation((fn) => fn());

    const ctx = createMockContext();
    const result = await service.searchWorks({ cursor: '*', rows: 20 }, ctx);

    const calledUrl = mockFetch.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain('cursor=');
    expect(calledUrl).not.toContain('offset=');
    expect(result.nextCursor).toBe('AoE=');
  });
});
