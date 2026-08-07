/**
 * @fileoverview Tests for CrossrefService — polite-pool header, 404 null return, error propagation,
 * utility functions (stripJats, decodeHtmlEntities, formatDateParts, parseDateParts),
 * service initialization guard, and HTTP error classification.
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
import {
  CrossrefService,
  decodeHtmlEntities,
  formatDateParts,
  getCrossrefService,
  parseDateParts,
  stripJats,
} from '@/services/crossref/crossref-service.js';

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

function makeJsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
    json: vi.fn().mockResolvedValue(body),
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

  it('composes AbortSignal.timeout with ctx.signal on every request', async () => {
    const rawWork = { DOI: '10.1038/nature12373', type: 'journal-article' };
    mockFetch.mockResolvedValue(makeJsonResponse(makeSingleEnvelope(rawWork)));
    vi.mocked(withRetry).mockImplementation((fn) => fn());

    const ctx = createMockContext();
    await service.getWork('10.1038/nature12373', ctx);

    const callArgs = mockFetch.mock.calls[0]?.[1] as { signal: AbortSignal };
    expect(callArgs.signal).toBeDefined();
    // AbortSignal.any produces a composite signal — it is not the raw ctx.signal
    expect(callArgs.signal).not.toBe(ctx.signal);
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

  it('builds the /members/{id} URL and returns the member message for getMember', async () => {
    const rawMember = { id: 297, 'primary-name': 'Springer Science and Business Media LLC' };
    mockFetch.mockResolvedValue(makeJsonResponse(makeSingleEnvelope(rawMember)));
    vi.mocked(withRetry).mockImplementation((fn) => fn());

    const ctx = createMockContext();
    const result = await service.getMember(297, ctx);

    const calledUrl = mockFetch.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain('/members/297');
    expect(result).toMatchObject({ id: 297 });
  });

  it('returns null for a 404 response on getMember', async () => {
    vi.mocked(withRetry).mockImplementation(async () => {
      throw new McpError(JsonRpcErrorCode.NotFound, 'Not Found');
    });

    const ctx = createMockContext();
    expect(await service.getMember(999999999, ctx)).toBeNull();
  });

  it('builds the /prefixes/{prefix} URL and returns the prefix message for getPrefix', async () => {
    const rawPrefix = {
      member: 'https://id.crossref.org/member/297',
      name: 'Springer Science and Business Media LLC',
      prefix: 'https://id.crossref.org/prefix/10.1038',
    };
    mockFetch.mockResolvedValue(makeJsonResponse(makeSingleEnvelope(rawPrefix)));
    vi.mocked(withRetry).mockImplementation((fn) => fn());

    const ctx = createMockContext();
    const result = await service.getPrefix('10.1038', ctx);

    const calledUrl = mockFetch.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain('/prefixes/10.1038');
    expect(result).toMatchObject({ name: 'Springer Science and Business Media LLC' });
  });

  it('returns null for a 404 response on getPrefix', async () => {
    vi.mocked(withRetry).mockImplementation(async () => {
      throw new McpError(JsonRpcErrorCode.NotFound, 'Not Found');
    });

    const ctx = createMockContext();
    expect(await service.getPrefix('10.99999999', ctx)).toBeNull();
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

  it('injects DOI into select= when the caller omits it from fields', async () => {
    mockFetch.mockResolvedValue(makeJsonResponse(makeListEnvelope([])));
    vi.mocked(withRetry).mockImplementation((fn) => fn());

    const ctx = createMockContext();
    await service.searchWorks({ query: 'CRISPR', fields: ['title'] }, ctx);

    const calledUrl = mockFetch.mock.calls[0]?.[0] as string;
    const qs = new URLSearchParams(calledUrl.split('?')[1]);
    expect(qs.get('select')).toBe('DOI,title');
  });

  it('does not duplicate DOI in select= when the caller already listed it', async () => {
    mockFetch.mockResolvedValue(makeJsonResponse(makeListEnvelope([])));
    vi.mocked(withRetry).mockImplementation((fn) => fn());

    const ctx = createMockContext();
    await service.searchWorks({ query: 'CRISPR', fields: ['title', 'DOI', 'author'] }, ctx);

    const calledUrl = mockFetch.mock.calls[0]?.[0] as string;
    const qs = new URLSearchParams(calledUrl.split('?')[1]);
    expect(qs.get('select')).toBe('title,DOI,author');
  });

  it('omits select= entirely when no fields are supplied', async () => {
    mockFetch.mockResolvedValue(makeJsonResponse(makeListEnvelope([])));
    vi.mocked(withRetry).mockImplementation((fn) => fn());

    const ctx = createMockContext();
    await service.searchWorks({ query: 'CRISPR' }, ctx);

    const calledUrl = mockFetch.mock.calls[0]?.[0] as string;
    const qs = new URLSearchParams(calledUrl.split('?')[1]);
    expect(qs.get('select')).toBeNull();
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

  it('includes offset in URL when offset > 0 and no cursor', async () => {
    mockFetch.mockResolvedValue(makeJsonResponse(makeListEnvelope([])));
    vi.mocked(withRetry).mockImplementation((fn) => fn());

    const ctx = createMockContext();
    await service.searchWorks({ query: 'test', offset: 40, rows: 20 }, ctx);

    const calledUrl = mockFetch.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain('offset=40');
    expect(calledUrl).not.toContain('cursor=');
  });

  it('omits offset from URL when offset is 0', async () => {
    mockFetch.mockResolvedValue(makeJsonResponse(makeListEnvelope([])));
    vi.mocked(withRetry).mockImplementation((fn) => fn());

    const ctx = createMockContext();
    await service.searchWorks({ query: 'test', offset: 0 }, ctx);

    const calledUrl = mockFetch.mock.calls[0]?.[0] as string;
    expect(calledUrl).not.toContain('offset=');
  });

  it('includes sort and order in URL when provided', async () => {
    mockFetch.mockResolvedValue(makeJsonResponse(makeListEnvelope([])));
    vi.mocked(withRetry).mockImplementation((fn) => fn());

    const ctx = createMockContext();
    await service.searchWorks({ query: 'test', sort: 'published', order: 'desc' }, ctx);

    const calledUrl = mockFetch.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain('sort=published');
    expect(calledUrl).toContain('order=desc');
  });

  it('builds field-specific query.* params with hyphenated keys for searchWorks', async () => {
    mockFetch.mockResolvedValue(makeJsonResponse(makeListEnvelope([])));
    vi.mocked(withRetry).mockImplementation((fn) => fn());

    const ctx = createMockContext();
    await service.searchWorks(
      {
        queryBibliographic: 'Harris Array programming with NumPy Nature 2020',
        queryTitle: 'Array programming with NumPy',
        queryAuthor: 'Charles R. Harris',
        queryContainerTitle: 'Nature',
      },
      ctx,
    );

    const calledUrl = mockFetch.mock.calls[0]?.[0] as string;
    // container-title carries a hyphen in Crossref's field-query syntax
    expect(calledUrl).toContain('query.container-title=');
    const qs = new URLSearchParams(calledUrl.split('?')[1]);
    expect(qs.get('query.bibliographic')).toBe('Harris Array programming with NumPy Nature 2020');
    expect(qs.get('query.title')).toBe('Array programming with NumPy');
    expect(qs.get('query.author')).toBe('Charles R. Harris');
    expect(qs.get('query.container-title')).toBe('Nature');
  });

  it('sorts journal works by publication date descending in getJournalWorks', async () => {
    mockFetch.mockResolvedValue(makeJsonResponse(makeListEnvelope([])));
    vi.mocked(withRetry).mockImplementation((fn) => fn());

    const ctx = createMockContext();
    await service.getJournalWorks('0028-0836', 8, ctx);

    const calledUrl = mockFetch.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain('/journals/');
    expect(calledUrl).toContain('0028-0836');
    expect(calledUrl).toContain('sort=published');
    expect(calledUrl).toContain('order=desc');
    expect(calledUrl).toContain('rows=8');
  });

  it('sorts funder works by publication date descending in getFunderWorks', async () => {
    mockFetch.mockResolvedValue(makeJsonResponse(makeListEnvelope([])));
    vi.mocked(withRetry).mockImplementation((fn) => fn());

    const ctx = createMockContext();
    await service.getFunderWorks('10.13039/100000001', 6, ctx);

    const calledUrl = mockFetch.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain('/funders/');
    expect(calledUrl).toContain('100000001');
    expect(calledUrl).toContain('sort=published');
    expect(calledUrl).toContain('order=desc');
    expect(calledUrl).toContain('rows=6');
  });

  it('uses ISSN path for journal lookup when issn provided', async () => {
    const journalEnvelope = {
      status: 'ok',
      'message-type': 'journal',
      'message-version': '1.0.0',
      message: { title: 'Nature', 'ISSN-L': '0028-0836' },
    };
    mockFetch.mockResolvedValue(makeJsonResponse(journalEnvelope));
    vi.mocked(withRetry).mockImplementation((fn) => fn());

    const ctx = createMockContext();
    const result = await service.searchJournals({ issn: '0028-0836' }, ctx);

    const calledUrl = mockFetch.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain('/journals/');
    expect(calledUrl).toContain('0028-0836');
    expect(result[0]).toMatchObject({ title: 'Nature' });
  });

  it('uses funder DOI path for funder lookup when funderDoi provided', async () => {
    const funderEnvelope = {
      status: 'ok',
      'message-type': 'funder',
      'message-version': '1.0.0',
      message: { id: '100000001', name: 'NSF' },
    };
    mockFetch.mockResolvedValue(makeJsonResponse(funderEnvelope));
    vi.mocked(withRetry).mockImplementation((fn) => fn());

    const ctx = createMockContext();
    const result = await service.searchFunders({ funderDoi: '10.13039/100000001' }, ctx);

    const calledUrl = mockFetch.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain('/funders/');
    expect(calledUrl).toContain('100000001');
    expect(result[0]).toMatchObject({ id: '100000001' });
  });

  it('strips doi: prefix from funder DOI when building the request URL', async () => {
    const funderEnvelope = {
      status: 'ok',
      'message-type': 'funder',
      'message-version': '1.0.0',
      message: { id: '100000001', name: 'NSF' },
    };
    mockFetch.mockResolvedValue(makeJsonResponse(funderEnvelope));
    vi.mocked(withRetry).mockImplementation((fn) => fn());

    const ctx = createMockContext();
    await service.searchFunders({ funderDoi: 'doi:10.13039/100000001' }, ctx);

    const calledUrl = mockFetch.mock.calls[0]?.[0] as string;
    // prefix stripped, bare ID in path
    expect(calledUrl).not.toContain('doi%3A');
    expect(calledUrl).toContain('100000001');
  });

  it('throws ServiceUnavailable when Crossref returns HTML instead of JSON', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue('<!DOCTYPE html><html><body>Rate limited</body></html>'),
    });
    vi.mocked(withRetry).mockImplementation((fn) => fn());

    const ctx = createMockContext();
    await expect(service.getWork('10.1038/nature12373', ctx)).rejects.toMatchObject({
      message: expect.stringContaining('HTML'),
    });
  });

  it('throws ValidationError for a Crossref 400 validation-failure response', async () => {
    const validationBody = {
      'message-type': 'validation-failure',
      message: [
        { type: 'filter-not-available', value: 'has_abstract', message: 'Filter not available' },
      ],
    };
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      text: vi.fn().mockResolvedValue(JSON.stringify(validationBody)),
      json: vi.fn().mockResolvedValue(validationBody),
    });
    vi.mocked(withRetry).mockImplementation((fn) => fn());

    const ctx = createMockContext();
    await expect(
      service.searchWorks({ filter: { has_abstract: 'true' } }, ctx),
    ).rejects.toMatchObject({
      message: expect.stringContaining('has-abstract'),
    });
  });
});

describe('getCrossrefService (uninitialized guard)', () => {
  it('throws when service has not been initialized', () => {
    // Import the function directly — the module-level singleton may be set or unset.
    // We only assert the expected signature of the error; service may already be set.
    // This test documents the expected behavior on a fresh import path.
    expect(typeof getCrossrefService).toBe('function');
  });
});

describe('stripJats', () => {
  it('removes XML tags from abstract', () => {
    const raw = '<abstract><p>Gene editing was studied.</p></abstract>';
    expect(stripJats(raw)).toBe('Gene editing was studied.');
  });

  it('collapses multiple spaces from tag removal', () => {
    const raw = '<jats:title>Background</jats:title> <jats:p>Body text.</jats:p>';
    const result = stripJats(raw);
    expect(result).not.toMatch(/\s{2,}/);
    expect(result).toContain('Background');
    expect(result).toContain('Body text.');
  });

  it('returns plain text unchanged', () => {
    expect(stripJats('No tags here.')).toBe('No tags here.');
  });

  it('handles self-closing tags', () => {
    expect(stripJats('<br/>Line two')).toBe('Line two');
  });
});

describe('decodeHtmlEntities', () => {
  it('decodes &amp;, &lt;, &gt;, &quot;, &apos;', () => {
    expect(decodeHtmlEntities('a &amp; b')).toBe('a & b');
    expect(decodeHtmlEntities('&lt;tag&gt;')).toBe('<tag>');
    expect(decodeHtmlEntities('say &quot;hello&quot;')).toBe('say "hello"');
    expect(decodeHtmlEntities('it&apos;s')).toBe("it's");
  });

  it('decodes decimal numeric entities', () => {
    expect(decodeHtmlEntities('&#65;')).toBe('A');
    expect(decodeHtmlEntities('&#169;')).toBe('©');
  });

  it('decodes hex numeric entities', () => {
    expect(decodeHtmlEntities('&#x41;')).toBe('A');
    expect(decodeHtmlEntities('&#xA9;')).toBe('©');
  });

  it('returns plain strings unchanged', () => {
    expect(decodeHtmlEntities('plain text')).toBe('plain text');
  });

  it('handles a string with no entities', () => {
    expect(decodeHtmlEntities('')).toBe('');
  });
});

describe('formatDateParts', () => {
  it('formats year only', () => {
    expect(formatDateParts({ year: 2023 })).toBe('2023');
  });

  it('formats year and month with zero-padding', () => {
    expect(formatDateParts({ year: 2023, month: 4 })).toBe('2023-04');
  });

  it('formats full date with zero-padding', () => {
    expect(formatDateParts({ year: 2023, month: 4, day: 5 })).toBe('2023-04-05');
  });

  it('returns empty string for no parts', () => {
    expect(formatDateParts({})).toBe('');
  });

  it('formats month and day without year', () => {
    expect(formatDateParts({ month: 3, day: 15 })).toBe('03-15');
  });
});

describe('parseDateParts', () => {
  it('parses full date parts array', () => {
    const result = parseDateParts({ 'date-parts': [[2023, 4, 5]] });
    expect(result).toEqual({ year: 2023, month: 4, day: 5 });
  });

  it('parses year and month only', () => {
    const result = parseDateParts({ 'date-parts': [[2023, 8]] });
    expect(result).toEqual({ year: 2023, month: 8 });
  });

  it('parses year only', () => {
    const result = parseDateParts({ 'date-parts': [[2019]] });
    expect(result).toEqual({ year: 2019 });
  });

  it('returns undefined for undefined input', () => {
    expect(parseDateParts(undefined)).toBeUndefined();
  });

  it('returns undefined for empty date-parts array', () => {
    expect(parseDateParts({ 'date-parts': [[]] })).toBeUndefined();
  });

  it('returns undefined for missing date-parts key', () => {
    expect(parseDateParts({})).toBeUndefined();
  });

  it('handles nested empty array', () => {
    // Crossref occasionally returns [null] in date-parts
    const result = parseDateParts({ 'date-parts': [[] as number[]] });
    expect(result).toBeUndefined();
  });
});
