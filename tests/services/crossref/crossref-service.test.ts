/**
 * @fileoverview Request shaping and response handling for CrossrefService — the polite-pool
 * header, URL and query-string construction on every route, envelope unwrapping, the
 * 404 → null convention, and the status mapping and retry cost each failure carries.
 *
 * Nothing here replaces `@cyanheads/mcp-ts-core/utils`. An earlier revision stubbed
 * `withRetry` to a pass-through and `httpErrorFromResponse` to a bare `vi.fn()`, which put
 * the retry loop and the real status table out of reach of every case in the file and made
 * any new non-400 error status fail on `undefined.message` rather than on the behavior
 * under test. Upstream is a fetch fake and backoff sleeps run on fake timers, so an
 * exhausted retry path costs no wall time. `upstream-classification.test.ts` covers the
 * classification of each failure at the wire; this file covers the service surface.
 *
 * @module tests/services/crossref/crossref-service.test
 */

import { createFetchMock, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn().mockReturnValue({
    mailto: 'test@example.com',
    baseUrl: 'https://api.crossref.test',
    timeoutMs: 5000,
  }),
}));

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  CrossrefService,
  decodeHtmlEntities,
  formatDateParts,
  getCrossrefService,
  initCrossrefService,
  NAME_SEARCH_OFFSET_CAP,
  nextPageOffset,
  normalizeMarkupText,
  normalizeText,
  parseDateParts,
  stripJats,
  WORKS_OFFSET_CAP,
} from '@/services/crossref/crossref-service.js';

/** Every route this service calls lives under the configured base URL. */
const CROSSREF = /^https:\/\/api\.crossref\.test\//;

/** `withRetry`'s default budget: one attempt plus three retries. */
const TOTAL_ATTEMPTS = 4;

const http = createFetchMock();

function makeSingleEnvelope(message: unknown) {
  return { status: 'ok', 'message-type': 'work', 'message-version': '1.0.0', message };
}

function makeListEnvelope(items: unknown[], total = 1, extra: Record<string, unknown> = {}) {
  return {
    status: 'ok',
    'message-type': 'work-list',
    'message-version': '1.0.0',
    message: {
      'total-results': total,
      'items-per-page': 20,
      items,
      ...extra,
    },
  };
}

/** Answer every Crossref route with one body. */
function serve(body: unknown, init?: ResponseInit): void {
  http.route({ match: CROSSREF, respond: () => Response.json(body, init) });
}

/** Answer every Crossref route with a raw body — for non-JSON and error payloads. */
function serveRaw(body: BodyInit, init?: ResponseInit): void {
  http.route({ match: CROSSREF, respond: () => new Response(body, init) });
}

/** The URL of the nth captured request. */
function requestedUrl(index = 0): string {
  const url = http.calls[index]?.request.url;
  if (url === undefined) throw new Error(`No request captured at index ${index}`);
  return url;
}

/** The query string of the nth captured request, parsed. */
function requestedParams(index = 0): URLSearchParams {
  return new URL(requestedUrl(index)).searchParams;
}

/**
 * Drive a pending call past `withRetry`'s backoff sleeps without waiting on them. The outcome
 * is captured before the timers advance — a rejection settling mid-advance with no handler
 * attached would surface as an unhandled rejection rather than as this call's result.
 */
async function settle<T>(promise: Promise<T>): Promise<T> {
  const outcome = promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  await vi.runAllTimersAsync();
  const settled = await outcome;
  if (settled.ok) return settled.value;
  throw settled.error;
}

describe('CrossrefService', () => {
  let service: CrossrefService;

  beforeEach(() => {
    vi.useFakeTimers();
    http.reset();
    http.install();
    service = new CrossrefService();
  });

  afterEach(() => {
    http.restore();
    vi.useRealTimers();
  });

  it('injects polite-pool User-Agent header on every request', async () => {
    serve(makeSingleEnvelope({ DOI: '10.1038/nature12373', type: 'journal-article' }));

    await service.getWork('10.1038/nature12373', createMockContext());

    expect(requestedUrl()).toContain('/works/');
    expect(http.calls[0]?.request.headers.get('User-Agent')).toContain('mailto:test@example.com');
  });

  it('composes ctx.signal into the request signal, so caller cancellation reaches fetch', async () => {
    const controller = new AbortController();
    http.route({
      match: CROSSREF,
      respond: (request) =>
        new Promise<Response>((_, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason), {
            once: true,
          });
        }),
    });

    const ctx = createMockContext({ signal: controller.signal });
    const pending = service.getWork('10.1038/nature12373', ctx);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(new Error('caller cancelled'));

    await expect(pending).rejects.toThrow('caller cancelled');
    // A cancelled call is not an upstream failure — withRetry exits on the aborted signal
    // rather than spending the budget on a request nobody is waiting for.
    expect(http.calls).toHaveLength(1);
  });

  it('clears the per-request timeout timer once the call succeeds', async () => {
    serve(makeSingleEnvelope({ DOI: '10.1038/nature12373', type: 'journal-article' }));

    // Awaited directly: advancing timers would fire the abort timer and make an uncleared
    // one indistinguishable from a cleared one.
    await service.getWork('10.1038/nature12373', createMockContext());

    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns null for a 404 response on getWork', async () => {
    serveRaw('Resource not found.', { status: 404 });

    expect(await service.getWork('10.9999/nonexistent', createMockContext())).toBeNull();
    // 404 is a routine outcome the handlers turn into a typed reason, never a retry.
    expect(http.calls).toHaveLength(1);
  });

  it('propagates a non-404 client error from getWork instead of nulling it', async () => {
    serveRaw('conflict', { status: 409 });

    await expect(service.getWork('10.1038/nature12373', createMockContext())).rejects.toMatchObject(
      { code: JsonRpcErrorCode.Conflict },
    );
  });

  it('maps a 503 through the real status table rather than the caller-error path', async () => {
    serveRaw('down', { status: 503 });

    // 503 is outside the 400/404 statuses the handlers own, so it is reclassified onto the
    // upstream contract and retried to exhaustion.
    await expect(
      settle(service.getWork('10.1038/nature12373', createMockContext())),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'upstream_unavailable' },
    });
    expect(http.calls).toHaveLength(TOTAL_ATTEMPTS);
  });

  it('builds the /members/{id} URL and returns the member message for getMember', async () => {
    serve(
      makeSingleEnvelope({ id: 297, 'primary-name': 'Springer Science and Business Media LLC' }),
    );

    const result = await service.getMember(297, createMockContext());

    expect(requestedUrl()).toContain('/members/297');
    expect(result).toMatchObject({ id: 297 });
  });

  it('returns null for a 404 response on getMember', async () => {
    serveRaw('Resource not found.', { status: 404 });

    expect(await service.getMember(999999999, createMockContext())).toBeNull();
  });

  it('builds the /prefixes/{prefix} URL and returns the prefix message for getPrefix', async () => {
    serve(
      makeSingleEnvelope({
        member: 'https://id.crossref.org/member/297',
        name: 'Springer Science and Business Media LLC',
        prefix: 'https://id.crossref.org/prefix/10.1038',
      }),
    );

    const result = await service.getPrefix('10.1038', createMockContext());

    expect(requestedUrl()).toContain('/prefixes/10.1038');
    expect(result).toMatchObject({ name: 'Springer Science and Business Media LLC' });
  });

  it('returns null for a 404 response on getPrefix', async () => {
    serveRaw('Resource not found.', { status: 404 });

    expect(await service.getPrefix('10.99999999', createMockContext())).toBeNull();
  });

  it('builds correct URL with filter and select params for searchWorks', async () => {
    serve(makeListEnvelope([{ DOI: '10.1038/nature12373', type: 'journal-article' }]));

    await service.searchWorks(
      { query: 'CRISPR', filter: { type: 'journal-article' }, fields: ['DOI', 'title'], rows: 10 },
      createMockContext(),
    );

    const qs = requestedParams();
    expect(qs.get('query')).toBe('CRISPR');
    expect(qs.get('filter')).toBe('type:journal-article');
    expect(qs.get('select')).toBe('DOI,title');
    expect(qs.get('rows')).toBe('10');
  });

  it('injects DOI into select= when the caller omits it from fields', async () => {
    serve(makeListEnvelope([]));

    await service.searchWorks({ query: 'CRISPR', fields: ['title'] }, createMockContext());

    expect(requestedParams().get('select')).toBe('DOI,title');
  });

  it('does not duplicate DOI in select= when the caller already listed it', async () => {
    serve(makeListEnvelope([]));

    await service.searchWorks(
      { query: 'CRISPR', fields: ['title', 'DOI', 'author'] },
      createMockContext(),
    );

    expect(requestedParams().get('select')).toBe('title,DOI,author');
  });

  it('omits select= entirely when no fields are supplied', async () => {
    serve(makeListEnvelope([]));

    await service.searchWorks({ query: 'CRISPR' }, createMockContext());

    expect(requestedParams().get('select')).toBeNull();
  });

  it('uses cursor param when provided and omits offset', async () => {
    serve(makeListEnvelope([], 100, { 'next-cursor': 'AoE=' }));

    const result = await service.searchWorks({ cursor: '*', rows: 20 }, createMockContext());

    const qs = requestedParams();
    expect(qs.get('cursor')).toBe('*');
    expect(qs.get('offset')).toBeNull();
    expect(result.nextCursor).toBe('AoE=');
  });

  it('includes offset in URL when offset > 0 and no cursor', async () => {
    serve(makeListEnvelope([]));

    await service.searchWorks({ query: 'test', offset: 40, rows: 20 }, createMockContext());

    const qs = requestedParams();
    expect(qs.get('offset')).toBe('40');
    expect(qs.get('cursor')).toBeNull();
  });

  it('omits offset from URL when offset is 0', async () => {
    serve(makeListEnvelope([]));

    await service.searchWorks({ query: 'test', offset: 0 }, createMockContext());

    expect(requestedParams().get('offset')).toBeNull();
  });

  it('includes sort and order in URL when provided', async () => {
    serve(makeListEnvelope([]));

    await service.searchWorks(
      { query: 'test', sort: 'published', order: 'desc' },
      createMockContext(),
    );

    const qs = requestedParams();
    expect(qs.get('sort')).toBe('published');
    expect(qs.get('order')).toBe('desc');
  });

  it('builds field-specific query.* params with hyphenated keys for searchWorks', async () => {
    serve(makeListEnvelope([]));

    await service.searchWorks(
      {
        queryBibliographic: 'Harris Array programming with NumPy Nature 2020',
        queryTitle: 'Array programming with NumPy',
        queryAuthor: 'Charles R. Harris',
        queryContainerTitle: 'Nature',
      },
      createMockContext(),
    );

    // container-title carries a hyphen in Crossref's field-query syntax
    expect(requestedUrl()).toContain('query.container-title=');
    const qs = requestedParams();
    expect(qs.get('query.bibliographic')).toBe('Harris Array programming with NumPy Nature 2020');
    expect(qs.get('query.title')).toBe('Array programming with NumPy');
    expect(qs.get('query.author')).toBe('Charles R. Harris');
    expect(qs.get('query.container-title')).toBe('Nature');
  });

  it('sorts journal works by publication date descending in getJournalWorks', async () => {
    serve(makeListEnvelope([]));

    await service.getJournalWorks('0028-0836', { rows: 8 }, createMockContext());

    expect(requestedUrl()).toContain('/journals/0028-0836/works');
    const qs = requestedParams();
    expect(qs.get('sort')).toBe('published');
    expect(qs.get('order')).toBe('desc');
    expect(qs.get('rows')).toBe('8');
    expect(qs.get('offset')).toBeNull();
  });

  it('sorts funder works by publication date descending in getFunderWorks', async () => {
    serve(makeListEnvelope([]));

    await service.getFunderWorks('10.13039/100000001', { rows: 6 }, createMockContext());

    // The full DOI is percent-encoded into the path, one of the three forms /funders/{id} takes.
    expect(requestedUrl()).toContain('/funders/10.13039%2F100000001/works');
    const qs = requestedParams();
    expect(qs.get('sort')).toBe('published');
    expect(qs.get('order')).toBe('desc');
    expect(qs.get('rows')).toBe('6');
    expect(qs.get('offset')).toBeNull();
  });

  it('sends offset on the journal works sub-resource when a page offset is given', async () => {
    serve(makeListEnvelope([], 446507));

    const result = await service.getJournalWorks(
      '0028-0836',
      { rows: 10, offset: 20 },
      createMockContext(),
    );

    expect(requestedParams().get('offset')).toBe('20');
    expect(result.totalResults).toBe(446507);
  });

  it('sends offset on the funder works sub-resource when a page offset is given', async () => {
    serve(makeListEnvelope([], 559017));

    const result = await service.getFunderWorks(
      '100000001',
      { rows: 10, offset: 30 },
      createMockContext(),
    );

    expect(requestedParams().get('offset')).toBe('30');
    expect(result.totalResults).toBe(559017);
  });

  it('sends cursor instead of offset on the journal works sub-resource and returns the next token', async () => {
    serve(makeListEnvelope([{ DOI: '10.1038/a' }], 446507, { 'next-cursor': 'AoJw8P3T3fAC' }));

    const result = await service.getJournalWorks(
      '0028-0836',
      { rows: 2, cursor: '*', offset: 20 },
      createMockContext(),
    );

    // Crossref rejects the pair with `cursor-with-offset-or-sample`, so only the cursor is sent.
    const qs = requestedParams();
    expect(qs.get('cursor')).toBe('*');
    expect(qs.get('offset')).toBeNull();
    expect(qs.get('sort')).toBe('published');
    expect(result.nextCursor).toBe('AoJw8P3T3fAC');
  });

  it('sends cursor instead of offset on the funder works sub-resource and returns the next token', async () => {
    serve(makeListEnvelope([{ DOI: '10.1038/a' }], 559033, { 'next-cursor': 'AoJw8P3T3fAC' }));

    const result = await service.getFunderWorks(
      '10.13039/100000001',
      { rows: 2, cursor: 'continuation-token', offset: 20 },
      createMockContext(),
    );

    const qs = requestedParams();
    expect(qs.get('cursor')).toBe('continuation-token');
    expect(qs.get('offset')).toBeNull();
    expect(result.nextCursor).toBe('AoJw8P3T3fAC');
  });

  it('uses ISSN path for journal lookup when issn provided', async () => {
    serve({
      status: 'ok',
      'message-type': 'journal',
      'message-version': '1.0.0',
      message: { title: 'Nature', 'ISSN-L': '0028-0836' },
    });

    const result = await service.searchJournals(
      { issn: '0028-0836', offset: 40 },
      createMockContext(),
    );

    expect(requestedUrl()).toContain('/journals/0028-0836');
    // Single-record lookup — offset has no meaning on this route and is never sent
    expect(requestedUrl()).not.toContain('offset=');
    expect(result.totalResults).toBe(1);
    expect(result.items[0]).toMatchObject({ title: 'Nature' });
  });

  it('carries total-results and offset through the journal title search', async () => {
    serve(makeListEnvelope([{ title: 'Naturen' }], 223));

    const result = await service.searchJournals(
      { query: 'nature', rows: 2, offset: 2 },
      createMockContext(),
    );

    const qs = requestedParams();
    expect(qs.get('query')).toBe('nature');
    expect(qs.get('offset')).toBe('2');
    expect(result.totalResults).toBe(223);
    expect(result.items).toHaveLength(1);
  });

  it('uses funder DOI path for funder lookup when funderDoi provided', async () => {
    serve({
      status: 'ok',
      'message-type': 'funder',
      'message-version': '1.0.0',
      message: { id: '100000001', name: 'NSF' },
    });

    const result = await service.searchFunders(
      { funderDoi: '10.13039/100000001' },
      createMockContext(),
    );

    expect(requestedUrl()).toContain('/funders/10.13039%2F100000001');
    expect(result.totalResults).toBe(1);
    expect(result.items[0]).toMatchObject({ id: '100000001' });
  });

  it('passes a bare registry ID through unchanged on the funder lookup path', async () => {
    serve({
      status: 'ok',
      'message-type': 'funder',
      'message-version': '1.0.0',
      message: { id: '100000001', name: 'National Science Foundation' },
    });

    await service.searchFunders({ funderDoi: '100000001' }, createMockContext());

    expect(requestedUrl()).toContain('/funders/100000001');
  });

  it('carries total-results and offset through the funder name search', async () => {
    serve(makeListEnvelope([{ id: '501100004795' }], 2252));

    const result = await service.searchFunders(
      { query: 'National', rows: 2, offset: 2 },
      createMockContext(),
    );

    const qs = requestedParams();
    expect(qs.get('query')).toBe('National');
    expect(qs.get('offset')).toBe('2');
    expect(result.totalResults).toBe(2252);
  });

  it('strips doi: prefix from funder DOI when building the request URL', async () => {
    serve({
      status: 'ok',
      'message-type': 'funder',
      'message-version': '1.0.0',
      message: { id: '100000001', name: 'NSF' },
    });

    await service.searchFunders({ funderDoi: 'doi:10.13039/100000001' }, createMockContext());

    // prefix stripped; the 10.13039/ stem survives, percent-encoded into the path
    expect(requestedUrl()).not.toContain('doi%3A');
    expect(requestedUrl()).toContain('/funders/10.13039%2F100000001');
  });

  it('throws ServiceUnavailable when Crossref returns HTML instead of JSON', async () => {
    serveRaw('<!DOCTYPE html><html><body>Rate limited</body></html>', { status: 200 });

    await expect(
      settle(service.getWork('10.1038/nature12373', createMockContext())),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: expect.stringContaining('HTML'),
    });
    expect(http.calls).toHaveLength(TOTAL_ATTEMPTS);
  });

  it('throws ValidationError for a Crossref 400 validation-failure response', async () => {
    serve(
      {
        'message-type': 'validation-failure',
        message: [
          { type: 'filter-not-available', value: 'has_abstract', message: 'Filter not available' },
        ],
      },
      { status: 400 },
    );

    await expect(
      service.searchWorks({ filter: { has_abstract: 'true' } }, createMockContext()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining('has-abstract'),
    });
    // The caller's request to fix, so it is never retried.
    expect(http.calls).toHaveLength(1);
  });

  it('does not retry a body that arrived whole and failed to parse', async () => {
    serveRaw('{"status":"ok","message":{', { status: 200 });

    await expect(
      settle(service.getWork('10.1038/nature12373', createMockContext())),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.SerializationError,
      data: { reason: 'malformed_response', retryable: false },
    });
    expect(http.calls).toHaveLength(1);
  });

  it('recovers when a transient failure clears inside the retry budget', async () => {
    http.route({
      match: CROSSREF,
      once: true,
      respond: () => new Response('down', { status: 503 }),
    });
    serve(makeSingleEnvelope({ DOI: '10.1038/nature12373', type: 'journal-article' }));

    const result = await settle(service.getWork('10.1038/nature12373', createMockContext()));

    expect(result).toMatchObject({ DOI: '10.1038/nature12373' });
    expect(http.calls).toHaveLength(2);
  });
});

describe('service singleton', () => {
  it('hands back the initialized instance', () => {
    initCrossrefService();
    expect(getCrossrefService()).toBeInstanceOf(CrossrefService);
  });
});

describe('nextPageOffset', () => {
  it('advances by the number of records actually returned', () => {
    expect(nextPageOffset({ offset: 0, returned: 10, total: 223, rows: 10, cap: 100_000 })).toEqual(
      {
        kind: 'next',
        offset: 10,
      },
    );
    expect(
      nextPageOffset({ offset: 10, returned: 10, total: 223, rows: 10, cap: 100_000 }),
    ).toEqual({ kind: 'next', offset: 20 });
  });

  it('reports end once the page reaches the end of the list', () => {
    expect(
      nextPageOffset({ offset: 220, returned: 3, total: 223, rows: 10, cap: 100_000 }),
    ).toEqual({ kind: 'end' });
  });

  it('reports end for an empty page past the end of the list', () => {
    expect(
      nextPageOffset({ offset: 500, returned: 0, total: 223, rows: 10, cap: 100_000 }),
    ).toEqual({ kind: 'end' });
  });

  it('distinguishes the route ceiling from the end of the list', () => {
    // Records remain (total is far larger) but the next call would breach the ceiling. That is a
    // different fact from `end` and must not collapse into it — a caller reading only an absent
    // offset would conclude it had retrieved everything.
    expect(
      nextPageOffset({
        offset: WORKS_OFFSET_CAP - 20,
        returned: 10,
        total: 446_507,
        rows: 10,
        cap: WORKS_OFFSET_CAP,
      }),
    ).toEqual({ kind: 'next', offset: WORKS_OFFSET_CAP - 10 });
    expect(
      nextPageOffset({
        offset: WORKS_OFFSET_CAP - 10,
        returned: 10,
        total: 446_507,
        rows: 10,
        cap: WORKS_OFFSET_CAP,
      }),
    ).toEqual({ kind: 'ceiling' });
  });

  it('applies the name-search ceiling an order of magnitude above the works ceiling', () => {
    // The same position that ends paging on a works sub-resource keeps going on a name search.
    const at = { offset: WORKS_OFFSET_CAP - 10, returned: 10, total: 446_507, rows: 10 };
    expect(nextPageOffset({ ...at, cap: WORKS_OFFSET_CAP })).toEqual({ kind: 'ceiling' });
    expect(nextPageOffset({ ...at, cap: NAME_SEARCH_OFFSET_CAP })).toEqual({
      kind: 'next',
      offset: WORKS_OFFSET_CAP,
    });
  });

  it('reports end, not ceiling, when the ceiling and the end of the list coincide', () => {
    // Exhausted list at the ceiling: nothing is being withheld, so there is nothing to disclose.
    expect(
      nextPageOffset({
        offset: WORKS_OFFSET_CAP - 10,
        returned: 10,
        total: WORKS_OFFSET_CAP,
        rows: 10,
        cap: WORKS_OFFSET_CAP,
      }),
    ).toEqual({ kind: 'end' });
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

  /**
   * A lone newline with no adjacent indentation is a single whitespace character, so a
   * collapse keyed on runs of two or more leaves it in place — enough to split a Markdown
   * heading in `content[]` on its own.
   */
  it('collapses a lone newline, not just runs of two or more', () => {
    expect(stripJats('In vivo\nCRISPR biosensing')).toBe('In vivo CRISPR biosensing');
    expect(stripJats('Tab\tseparated')).toBe('Tab separated');
  });
});

describe('normalizeText', () => {
  it('decodes entities and collapses whitespace', () => {
    expect(normalizeText('  Users&apos; guides   to the\n   literature ')).toBe(
      "Users' guides to the literature",
    );
  });

  it('leaves angle-bracketed content in place', () => {
    expect(normalizeText('International <IR> Framework')).toBe('International <IR> Framework');
  });

  it('collapses whitespace an entity decodes into', () => {
    expect(normalizeText('a&#10;b')).toBe('a b');
  });
});

describe('normalizeMarkupText', () => {
  it('strips JATS tags and collapses the newline-plus-indent they leave behind', () => {
    expect(normalizeMarkupText('<i>In vivo</i>\n                    CRISPR biosensing')).toBe(
      'In vivo CRISPR biosensing',
    );
  });

  it('collapses a lone newline in a title with no adjacent indentation', () => {
    expect(normalizeMarkupText('<i>In vivo</i>\nCRISPR biosensing')).toBe(
      'In vivo CRISPR biosensing',
    );
  });

  /**
   * Tags come out before entities are decoded, so a deposited `&lt;i&gt;` stays literal text
   * rather than decoding into a tag the strip pass then eats.
   */
  it('keeps an escaped tag as literal text', () => {
    expect(normalizeMarkupText('Use &lt;i&gt; for italics')).toBe('Use <i> for italics');
  });

  /**
   * A subscript or superscript continues the token around it, so removing one must leave no
   * separator behind — a space there splits a chemical formula. Every other tag is a word
   * boundary and still becomes a space.
   */
  it('joins subscripts and superscripts tight while other tags stay word boundaries', () => {
    expect(normalizeMarkupText('CO<sub>2</sub> uptake in <i>E. coli</i> &amp; yeast')).toBe(
      'CO2 uptake in E. coli & yeast',
    );
    expect(normalizeMarkupText('Adsorption of Co<sup>2+</sup> by Oxides')).toBe(
      'Adsorption of Co2+ by Oxides',
    );
    expect(normalizeMarkupText('Fe<jats:sub>3</jats:sub>O<jats:sub>4</jats:sub> Core')).toBe(
      'Fe3O4 Core',
    );
  });

  /**
   * The tight join keys on the element name, so it must not catch an unrelated element that
   * merely starts with the same letters, and it must not disturb the space an abstract's
   * paragraph boundary depends on.
   */
  it('keeps the paragraph separator and leaves sub-prefixed element names as boundaries', () => {
    expect(normalizeMarkupText('<jats:p>Para one.</jats:p><jats:p>Para two.</jats:p>')).toBe(
      'Para one. Para two.',
    );
    expect(normalizeMarkupText('end<jats:supplementary-material />next')).toBe('end next');
    expect(normalizeMarkupText('a<subject>b</subject>c')).toBe('a b c');
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
