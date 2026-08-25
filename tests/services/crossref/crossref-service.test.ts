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
  ELEMENT_VERDICTS,
  formatDateParts,
  getCrossrefService,
  initCrossrefService,
  NAME_SEARCH_OFFSET_CAP,
  nextPageOffset,
  normalizeMarkupText,
  normalizeReferenceText,
  normalizeText,
  parseDateParts,
  resolveWorkDate,
  resolveWorkSummaryDate,
  stripJats,
  stripReferenceMarkup,
  WORKS_OFFSET_CAP,
} from '@/services/crossref/crossref-service.js';
import { decodeHtmlEntities } from '@/services/crossref/html-entities.js';

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
function serveRaw(body: string, init?: ResponseInit): void {
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

  /**
   * The named whitespace references fold the same way the numeric ones do, because the decode
   * runs before the collapse. A non-breaking space reaching `content[]` intact renders as an
   * ordinary space a reader cannot select or search for.
   */
  it('collapses whitespace a named reference decodes into', () => {
    expect(normalizeText('Vol.&nbsp;12,&Tab;p.&NewLine;44')).toBe('Vol. 12, p. 44');
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
    // Same protection through the numeric spelling, and through a double escape.
    expect(normalizeMarkupText('Use &#60;i&#62; for italics')).toBe('Use <i> for italics');
    expect(normalizeMarkupText('Deposited as &amp;lt;i&amp;gt;')).toBe('Deposited as &lt;i&gt;');
  });

  /** A title carries the same named references a citation does. */
  it('decodes a named reference in a title', () => {
    expect(normalizeMarkupText('Kinase isoforms p38&alpha; and p38&beta;')).toBe(
      'Kinase isoforms p38α and p38β',
    );
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

  /**
   * The deposit behind the divergence: an abstract whose formulas are presentation MathML
   * wrapped in `<inline-formula>`. Every tag inside the region comes out with the whitespace
   * a deposit pretty-prints between them, so the expression reads as one token instead of
   * being shattered into single characters.
   */
  it('renders a MathML formula in an abstract as one expression', () => {
    const abstract = [
      '<p>If',
      '  <inline-formula content-type="math/mathml">',
      '    <mml:math xmlns:mml="http://www.w3.org/1998/Math/MathML" alttext="script upper H">',
      '      <mml:semantics>',
      '        <mml:mrow class="MJX-TeXAtom-ORD">',
      '          <mml:mi mathvariant="script">H</mml:mi>',
      '        </mml:mrow>',
      '        <mml:annotation encoding="application/x-tex">\\mathcal {H}</mml:annotation>',
      '      </mml:semantics>',
      '    </mml:math>',
      '  </inline-formula>',
      '  is a Hilbert space.</p>',
    ].join('\n');
    expect(normalizeMarkupText(abstract)).toBe('If H is a Hilbert space.');
  });

  /**
   * A formula region stands as its own token in the sentence — a MathML deposit carries the
   * whole symbol, and publishers deposit it hard against the prose — so its outer edge is a
   * block boundary even though its inner tags join tight.
   */
  it('separates a MathML region from the prose it abuts', () => {
    const raw =
      'states of neutron-rich<mml:math xmlns:mml="x"><mml:mmultiscripts><mml:mi>Si</mml:mi><mml:mprescripts /><mml:none /><mml:mn>33</mml:mn></mml:mmultiscripts></mml:math>and thin films';
    expect(normalizeMarkupText(raw)).toBe('states of neutron-rich Si33 and thin films');
    expect(normalizeReferenceText(raw)).toBe('states of neutron-rich Si33 and thin films');
  });

  /**
   * Whitespace between a region's tags is the deposit's pretty-printing, not part of the
   * expression — it is insignificant in XML, and keeping it splits one token into two. A formula
   * that needs a visible space writes it as a character reference, which the strip leaves for
   * the decode.
   */
  it('drops the whitespace a MathML deposit pretty-prints between its tags', () => {
    expect(normalizeMarkupText('<math>\n  <mi>Airy</mi>\n  <mn>2</mn>\n</math>')).toBe('Airy2');
    expect(
      normalizeMarkupText('<math>\n  <mi>a</mi>\n  <mo>&nbsp;</mo>\n  <mi>b</mi>\n</math>'),
    ).toBe('a b');
  });

  /**
   * The alternate encoding a MathML deposit carries beside its presentation markup is the same
   * expression a second time. Emitting both renders one formula twice.
   */
  it('drops the alternate encoding a MathML deposit carries', () => {
    expect(
      normalizeMarkupText(
        '<math><msup><mi>A</mi><mn>2</mn></msup><annotation-xml encoding="MathML-Content"><apply><power/><ci>A</ci><cn>2</cn></apply></annotation-xml></math>',
      ),
    ).toBe('A2');
  });

  /**
   * The tight class is shared with the reference pass, so the spellings only that pass used to
   * know join tight here too rather than shattering the token they sit in.
   */
  it('joins every script and formula-wrapper spelling tight', () => {
    expect(normalizeMarkupText('high T<inf>c</inf>-dc-SQUID gradiometers')).toBe(
      'high Tc-dc-SQUID gradiometers',
    );
    expect(normalizeMarkupText('O<Stack><Subscript>2</Subscript></Stack> uptake')).toBe(
      'O2 uptake',
    );
    expect(
      normalizeMarkupText(
        'Ni/<inline-formula><tex-math>$\\hbox{HfO}_{2}$</tex-math></inline-formula>/TiN',
      ),
    ).toBe('Ni/$\\hbox{HfO}_{2}$/TiN');
    // A displayed formula is still a block boundary, here as there.
    expect(normalizeMarkupText('result<disp-formula>E = mc2</disp-formula>follows')).toBe(
      'result E = mc2 follows',
    );
  });

  /**
   * The link exception holds on this surface too, where it is earned. An `<ext-link>` whose
   * `xlink:href` addresses a trial record its text does not name keeps its tag, because
   * removing the tag deletes the address — the same failure the rule exists to prevent,
   * whichever field it happens in.
   */
  it('leaves a link in an abstract whole when its address is only in the href', () => {
    const raw =
      '<jats:p>Registered at <jats:ext-link ext-link-type="clintrialgov" xlink:href="https://clinicaltrials.gov/ct2/show/NCT01234567">NCT01234567</jats:ext-link>.</jats:p>';
    expect(normalizeMarkupText(raw)).toBe(
      'Registered at <jats:ext-link ext-link-type="clintrialgov" xlink:href="https://clinicaltrials.gov/ct2/show/NCT01234567">NCT01234567</jats:ext-link>.',
    );
  });

  /**
   * And comes out where it is not. A structured abstract deposits its trial registration,
   * accession, or URL as the element's own text and repeats it in the `href`, so the tag
   * protects nothing while putting a namespace-bearing XML tag in the middle of an abstract.
   * The trailing space before the period is the deposit's own line break, not the strip's.
   */
  it('removes a link in an abstract whose text already carries the address', () => {
    expect(
      normalizeMarkupText(
        '<jats:sec><jats:title>Trial registration number</jats:title><jats:p>\n  <jats:ext-link xmlns:xlink="http://www.w3.org/1999/xlink" ext-link-type="clintrialgov" xlink:href="NCT06494904">NCT06494904</jats:ext-link>\n  .\n</jats:p></jats:sec>',
      ),
    ).toBe('Trial registration number NCT06494904 .');
    expect(
      normalizeMarkupText(
        'Visit <jats:uri xmlns:xlink="http://www.w3.org/1999/xlink" xlink:type="simple" xlink:href="http://www.microscopy.com">http://www.microscopy.com</jats:uri> today.',
      ),
    ).toBe('Visit http://www.microscopy.com today.');
  });
});

describe('stripReferenceMarkup', () => {
  it('removes inline emphasis in its HTML, JATS, and Springer spellings', () => {
    expect(stripReferenceMarkup('<em>Remarks on the breakdown</em>')).toBe(
      'Remarks on the breakdown',
    );
    expect(stripReferenceMarkup('<jats:italic>Escherichia coli</jats:italic>')).toBe(
      'Escherichia coli',
    );
    expect(stripReferenceMarkup('<small>DAUVERGNE, D.</small>')).toBe('DAUVERGNE, D.');
    expect(stripReferenceMarkup('<b>94</b>')).toBe('94');
  });

  /**
   * The whole point of the allow-list: every one of these is text a reader needs, written in
   * the same syntax as a tag. A blanket strip deletes all four.
   */
  it('leaves an angle-bracket span whose name is not a formatting element', () => {
    const cases = [
      'FAOSTAT. <http://faostat.fao.org/site/291/default.aspx>.',
      'Silicon <100> nanowires',
      '10.1002/(SICI)1097-461X(1998)66:2<131::AID-QUA4>3.0.CO;2-W',
      'International <IR> Framework',
      'EPA standards, <www.ecfr.gov>, as of May 27, 2014.',
      'ZnxFe3-xO4 (0.01 < x > 0.8) nanoparticles',
      'Si1−xGex layers (0.3<x<0.4)',
      'The subject <subject>Ecology</subject>',
    ];
    for (const raw of cases) expect(stripReferenceMarkup(raw)).toBe(raw);
  });

  /**
   * A link's URL can live in an attribute, so removing the tag can delete it. `a`, `ext-link`,
   * and `uri` — which takes an `xlink:href` in JATS — are off the name list for that reason,
   * and stay whole wherever the text does not already carry what the `href` holds.
   */
  it('leaves a link tag whole so its href survives', () => {
    const anchor = 'Preprint, <a href="http://arxiv.org/abs/1102.1113v1">arXiv:1102.1113v1</a>.';
    expect(stripReferenceMarkup(anchor)).toBe(anchor);
    const doi =
      'Bagci A.S. <a href="http://dx.doi.org/10.2118/113234-MS">doi: 10.2118/113234-MS.</a>';
    expect(stripReferenceMarkup(doi)).toBe(doi);
  });

  /**
   * And comes out where the deposit put the same address in the element's text — the common
   * shape in a reference list, where a publisher links a citation to the URL it already prints.
   */
  it('removes a link tag whose text already carries the address', () => {
    expect(
      stripReferenceMarkup(
        'WHO. <ext-link xlink:href="http://www.who.int/mediacentre/fs375/en/">http://www.who.int/mediacentre/fs375/en/</ext-link>.',
      ),
    ).toBe('WHO. http://www.who.int/mediacentre/fs375/en/.');
    expect(
      stripReferenceMarkup(
        'Available from <uri>https://www.pcne.org/upload/files/417.pdf</uri>. Accessed.',
      ),
    ).toBe('Available from https://www.pcne.org/upload/files/417.pdf. Accessed.');
  });

  /**
   * A bracketed phrase that opens with an allow-listed name is a citation a reader needs, not
   * a tag. Requiring the attribute tail to be `name="value"` pairs is what tells them apart —
   * every one of these reads as a tag under a looser `<name\b[^>]*>` and loses its whole span.
   */
  it('leaves a bracketed phrase that merely opens with an element name', () => {
    const cases = [
      'See <Stack Overflow, https://stackoverflow.com/q/1234>, retrieved 2020.',
      'SCOGS opinion. <Available from: http://www.fda.gov/Food/GRAS/ucm261485.htm>.',
      'Website <The Internet Movie DataBase, http://www.imdb.com/>, November 2012.',
      'La Sécurité Sociale, entre <<ruptures>> affichées',
      'Miller JH (1992) A Short Course, <Small et al. 1990> reprinted.',
    ];
    for (const raw of cases) expect(stripReferenceMarkup(raw)).toBe(raw);
  });

  /**
   * Where the boundary actually falls: a bare single-letter tag is stripped, because the
   * measured cost of leaving `<i>` and `<b>` in place across the corpus far outweighs the
   * bracketed-letter-as-content case, which the sampled corpus does not contain. The
   * multi-word form above is closed by construction; this one is the residual, pinned so a
   * later change to the shape rule cannot move it silently.
   */
  it('strips a bare single-letter tag even where the letter reads as content', () => {
    expect(normalizeReferenceText('variant <b> allele')).toBe('variant allele');
    expect(stripReferenceMarkup('The <B. subtilis> strain')).toBe('The <B. subtilis> strain');
  });

  /**
   * A reference separator one publisher appends to each packed citation. It is self-closing,
   * carries nothing in an attribute, and has no ordinary-word reading, so it is admitted by
   * name like any other block boundary. Admitting it by *shape* instead — treating a
   * self-closing tag as markup whatever its name — was the tempting alternative and would
   * delete `<www.voith.com/>`, a bare-domain URL bracket that parses the same way.
   */
  it('separates on the refersplit marker in both its self-closing spellings', () => {
    expect(
      normalizeReferenceText(
        'BASILE F. Modeling and Design for the Attitude Control Phase of the LISA Drag-Free Mission[D]. Torino: Politecnico di Torino, 2019<refersplit />',
      ),
    ).toBe(
      'BASILE F. Modeling and Design for the Attitude Control Phase of the LISA Drag-Free Mission[D]. Torino: Politecnico di Torino, 2019',
    );
    expect(normalizeReferenceText('First citation.<refersplit/>Second citation.')).toBe(
      'First citation. Second citation.',
    );
    expect(stripReferenceMarkup('Voith turbo, <www.voith.com/>, accessed 2019.')).toBe(
      'Voith turbo, <www.voith.com/>, accessed 2019.',
    );
  });

  /**
   * A valueless attribute is prose as far as the shape test can tell — admitting one reopens
   * `<Bold statement about X>`, which parses as three of them — so `<span hidden>` is not a
   * tag. Its attribute-free closer matches the shape on its own, which is how the element used
   * to come apart: opener kept, closer removed. A closer is now removed only if the matching
   * opener was, so the pair stands or falls together.
   */
  it('keeps both halves of an element whose opening tag fails the shape test', () => {
    expect(stripReferenceMarkup('a <span hidden>b</span> c')).toBe('a <span hidden>b</span> c');
    expect(stripReferenceMarkup('a <i lang>b</i> c')).toBe('a <i lang>b</i> c');
    expect(stripJats('a <span hidden>b</span> c')).toBe('a <span hidden>b</span> c');
    // A closer with no opener at all has the same standing: nothing to close.
    expect(stripReferenceMarkup('trailing</i> fragment')).toBe('trailing</i> fragment');
    // Improper nesting still resolves each closer against its own opener.
    expect(stripReferenceMarkup('<i><b>x</i></b>')).toBe('x');
    // And a closer resolves against its own name, not against whatever opener is on top:
    // an enclosing `<i>` is not what `</span>` closes.
    expect(stripReferenceMarkup('<i>a <span hidden>b</span> c</i>')).toBe(
      'a <span hidden>b</span> c',
    );
  });

  /** A deeply nested or bracket-heavy field must not send the matcher exponential. */
  it('returns promptly on adversarial bracket input', () => {
    const adversarial = [
      `${'<i><b><sub>'.repeat(400)}x${'</sub></b></i>'.repeat(400)}`,
      // A tag the deposit never terminated: the attribute tail has to reject it without
      // exploring a parse per attribute. A budget of seconds hides exactly that blowup, so
      // the bound is tight enough to fail on it — the shape costs under a millisecond.
      `<p class="a" ${'x = "y" '.repeat(600)}`,
      `${'<math><mi>'.repeat(400)}z`,
      `${'<mixed-citation><surname>A</surname>'.repeat(400)}`,
      '</i>'.repeat(20_000),
      // Link elements are the one class that scans forward from a tag for its own closing
      // tag, so a field packed with openers that never close is what makes that scan
      // quadratic if it is written carelessly.
      `${'<ext-link xlink:href="https://example.org/a">'.repeat(2_000)}x`,
      `${'<a href="https://example.org/a">text</a>'.repeat(2_000)}`,
      // A link whose href is a long unterminated attribute run: the href matcher has to
      // reject it without exploring a parse per space.
      `<ext-link ${'href = "y" '.repeat(600)}`,
    ];
    const started = Date.now();
    for (const raw of adversarial) {
      stripReferenceMarkup(raw);
      stripJats(raw);
    }
    expect(Date.now() - started).toBeLessThan(500);
  });

  /**
   * `<span>` is styling with nothing in an attribute to lose, and the smallcaps role it
   * carries is already admitted as `scp`. The ordinal beside it is the reason the separator
   * is decided against the string as deposited: removing the `<sup>` first would leave
   * `xvii` abutting `e` and the word-boundary rule would split what is one word.
   */
  it('strips a styling span and keeps the ordinal that follows it tight', () => {
    expect(
      stripReferenceMarkup(
        'Les sciences de la vie au <span class="smallcaps">xvii</span><sup>e</sup> et <span class="smallcaps">xviii</span><sup>e</sup> siècles',
      ),
    ).toBe('Les sciences de la vie au xviie et xviiie siècles');
  });

  /** `inf` is the Elsevier and IEEE spelling of a subscript, so it joins tight like `sub`. */
  it('joins the inf spelling of a subscript tight', () => {
    expect(
      stripReferenceMarkup('development of a heart monitoring system with high T<inf>c</inf>-dc'),
    ).toBe('development of a heart monitoring system with high Tc-dc');
  });

  /**
   * A TeX formula wrapper carries nothing its content does not — stripping it leaves the
   * formula in a notation a reader can follow, where leaving it wraps that same formula in
   * XML. The wrapper joins tight for the same reason a script does.
   */
  it('unwraps a TeX formula to the notation it wraps', () => {
    expect(
      stripReferenceMarkup(
        'Correlation of <ref_formula><tex Notation="TeX">$\\hbox{1}/f$</tex></ref_formula> noise',
      ),
    ).toBe('Correlation of $\\hbox{1}/f$ noise');
    expect(
      stripReferenceMarkup(
        'Ni-Silicide/<formula formulatype="inline"><tex Notation="TeX">$\\hbox{HfO}_{2}$</tex></formula>/TiN cells',
      ),
    ).toBe('Ni-Silicide/$\\hbox{HfO}_{2}$/TiN cells');
  });

  /** The JATS citation fields publishers deposit bare into an otherwise typed citation. */
  it('strips bare JATS citation fields', () => {
    expect(
      stripReferenceMarkup('Cartwright EJ, Jackson KA, Silk BJ, <etal>et al</etal>.. (2013)'),
    ).toBe('Cartwright EJ, Jackson KA, Silk BJ, et al.. (2013)');
    expect(stripReferenceMarkup('(<fname lang = "en">Knobil, E., eds</fname>.), pp. 1177')).toBe(
      '(Knobil, E., eds.), pp. 1177',
    );
  });

  /**
   * A name that is also an ordinary word stays off the list even when JATS defines it: a
   * bracketed word is how a person writes a quotation or a note, so admitting `volume` would
   * delete a bracketed phrase opening with it. It comes out inside a citation envelope
   * instead, where nothing was typed by hand.
   */
  it('leaves a bare ordinary-word JATS element alone', () => {
    const raw = 'Cold Spring Harbor, N.Y., <volume>876</volume> pp.';
    expect(stripReferenceMarkup(raw)).toBe(raw);
    const wikipedia = "'I Updated the <ref> ': The Evolution of References";
    expect(stripReferenceMarkup(wikipedia)).toBe(wikipedia);
  });

  /**
   * A structured citation deposited whole into a free-text field is XML end to end, so the
   * name-by-name allow-list has nothing to protect there and the envelope is emptied of tags
   * — ordinary-word names included. A link inside it still keeps its address.
   */
  it('renders a JATS structured citation as the citation it encodes', () => {
    expect(
      normalizeReferenceText(
        '<mixed-citation publication-type="journal"><person-group person-group-type="author"><string-name><surname>Fan</surname> <given-names>Li</given-names></string-name>., <string-name><surname>Whitson</surname> <given-names>C. H.</given-names></string-name></person-group> (<year>2006</year>) <article-title>Understanding Gas Condensate Reservoir</article-title>, <source />Oilfield Review, <comment>Winter, 2005/2006</comment>;</mixed-citation>',
      ),
    ).toBe(
      'Fan Li., Whitson C. H. (2006) Understanding Gas Condensate Reservoir, Oilfield Review, Winter, 2005/2006;',
    );
    expect(
      normalizeReferenceText(
        '<p><mixed-citation publication-type="journal"><h3>References</h3><p>Bagci, A.S. 2008. SAGD. <a href="http://dx.doi.org/10.2118/113234-MS">doi: 10.2118/113234-MS.</a></p><p>Kisman, K.E. 1993. Steam Injection.</p></mixed-citation>',
      ),
    ).toBe(
      'References Bagci, A.S. 2008. SAGD. <a href="http://dx.doi.org/10.2118/113234-MS">doi: 10.2118/113234-MS.</a> Kisman, K.E. 1993. Steam Injection.',
    );
  });

  /** All or nothing, the same way an unclosed MathML span is left whole. */
  it('leaves an unclosed citation envelope untouched', () => {
    const raw = '<mixed-citation publication-type="journal"><surname>Fan</surname> with no end';
    expect(stripReferenceMarkup(raw)).toBe(
      '<mixed-citation publication-type="journal">Fan with no end',
    );
  });

  /** The envelope is recognized under every spelling JATS and NLM define for it. */
  it('empties a citation envelope in each of its spellings', () => {
    expect(
      normalizeReferenceText(
        '<element-citation publication-type="journal"><surname>Fan</surname> <given-names>Li</given-names>. <article-title>A title</article-title>. <year>2006</year>.</element-citation>',
      ),
    ).toBe('Fan Li. A title. 2006.');
    expect(
      normalizeReferenceText(
        '<nlm-citation citation-type="journal"><collab>WHO</collab>. <source>Bulletin</source>. <year>2011</year>.</nlm-citation>',
      ),
    ).toBe('WHO. Bulletin. 2011.');
    expect(
      normalizeReferenceText(
        '<citation><surname>Kato</surname> <given-names>T.</given-names>, <source>Comm. Math. Phys.</source> <volume>94</volume>.</citation>',
      ),
    ).toBe('Kato T., Comm. Math. Phys. 94.');
  });

  /** Each envelope closes at its own end tag, so two in one field stay two citations. */
  it('closes each envelope at its own end tag', () => {
    expect(
      normalizeReferenceText(
        '<citation>Kato T. 1984.</citation> and <citation>Beale J. 1986.</citation>',
      ),
    ).toBe('Kato T. 1984. and Beale J. 1986.');
  });

  /**
   * The link exception holds at any nesting: inside an envelope every other name comes out
   * unconditionally, while a link is still decided against its own text. An envelope settles
   * that nothing inside it was typed by hand; it says nothing about where an address lives.
   */
  it('decides a link inside a citation envelope on its own text', () => {
    expect(
      normalizeReferenceText(
        '<mixed-citation>Available from <uri>https://www.pcne.org/x.pdf</uri>. Accessed.</mixed-citation>',
      ),
    ).toBe('Available from https://www.pcne.org/x.pdf. Accessed.');
    expect(
      normalizeReferenceText(
        '<mixed-citation>WHO. <ext-link xlink:href="http://who.int/a/b">factsheet</ext-link>.</mixed-citation>',
      ),
    ).toBe('WHO. <ext-link xlink:href="http://who.int/a/b">factsheet</ext-link>.');
  });

  /** A displayed formula is a block boundary; an inline one and its TeX body join tight. */
  it('separates a displayed formula and joins an inline one tight', () => {
    expect(
      normalizeReferenceText('the result<disp-formula id="e1">E = mc2</disp-formula>follows'),
    ).toBe('the result E = mc2 follows');
    expect(
      normalizeReferenceText(
        'Ni/<inline-formula><tex-math>$\\hbox{HfO}_{2}$</tex-math></inline-formula>/TiN',
      ),
    ).toBe('Ni/$\\hbox{HfO}_{2}$/TiN');
  });

  /**
   * The name fields a publisher deposits bare, outside any envelope. Each is a markup-only
   * token with no ordinary-word reading, so it is on the allow-list and comes out as a word
   * boundary — the same treatment inline emphasis gets.
   */
  it('strips bare JATS name fields outside an envelope', () => {
    expect(
      normalizeReferenceText('Published by <collab>World Health Organization</collab>, 2011.'),
    ).toBe('Published by World Health Organization, 2011.');
    expect(
      normalizeReferenceText(
        'Cited: <string-name><surname>Fan</surname> <given-names>Li</given-names></string-name>, 2006.',
      ),
    ).toBe('Cited: Fan Li, 2006.');
    expect(
      normalizeReferenceText(
        'Kato T., <article-title>Remarks on the breakdown</article-title>, Comm. Math. Phys.',
      ),
    ).toBe('Kato T., Remarks on the breakdown, Comm. Math. Phys.');
    expect(
      normalizeReferenceText(
        '<person-group person-group-type="author">Kato T., Majda A.</person-group> (1984)',
      ),
    ).toBe('Kato T., Majda A. (1984)');
  });

  /**
   * Inline emphasis is a word boundary, so it leaves a space only where it separates two word
   * characters. A citation's italic journal title is followed by a comma far more often than
   * by a word, and a space before that comma is the artifact a blanket space-for-every-tag
   * rule introduces on nearly every entry it touches.
   */
  it('leaves a separator only between two word characters', () => {
    expect(stripReferenceMarkup('T.Isobe, <i>J. Am. ceram. Soc.</i>, <b>90</b>, 3720')).toBe(
      'T.Isobe, J. Am. ceram. Soc., 90, 3720',
    );
    expect(stripReferenceMarkup('A<i>B</i>C')).toBe('A B C');
  });

  /**
   * A publisher packing several citations into one field separates them with a block tag, and
   * the separator has to survive the word-character test the inline rule applies — the text
   * before it ends in a period, not a word character.
   */
  it('always separates block boundaries', () => {
    expect(
      normalizeReferenceText(
        '<p class="Reference">Barraud, P.J. (1929) A revision.</p><p class="Reference">Smith, J. (1930) Another.</p>',
      ),
    ).toBe('Barraud, P.J. (1929) A revision. Smith, J. (1930) Another.');
  });

  /** Scripts continue the token around them, in every spelling a deposit uses. */
  it('joins scripts tight', () => {
    expect(stripReferenceMarkup('H<sub>2</sub>O<sub>2</sub>')).toBe('H2O2');
    expect(
      stripReferenceMarkup('O<Stack><Subscript>2</Subscript><Superscript>-</Superscript></Stack>'),
    ).toBe('O2-');
  });

  /**
   * A MathML span is matched end to end and its inner tags come out tight, so the formula
   * reads as one token. Deleting the span would delete the symbol the sentence is about.
   */
  it('renders a MathML formula as its tight-joined content', () => {
    expect(
      stripReferenceMarkup(
        'Fractal geometry of <math xmlns="http://www.w3.org/1998/Math/MathML" id="eq_3"><msub><mrow><mi mathvariant="normal">Airy</mi></mrow><mrow><mn>2</mn></mrow></msub></math> processes',
      ),
    ).toBe('Fractal geometry of Airy2 processes');
  });

  /** An unclosed formula matches nothing, so it is left whole rather than half-stripped. */
  it('leaves an unclosed MathML span untouched', () => {
    const raw = 'Unclosed <math xmlns="x"><mi>Z</mi> formula with no end tag';
    expect(stripReferenceMarkup(raw)).toBe(raw);
  });

  it('returns plain text unchanged', () => {
    expect(stripReferenceMarkup('Smith J. 2010. A paper. Nature.')).toBe(
      'Smith J. 2010. A paper. Nature.',
    );
  });
});

/**
 * An `<alternatives>` wrapper holds one object encoded several ways and expects a consumer to
 * pick one. It is a region rather than a name on a class list, so what it does is settled by
 * position — the first child carrying text — rather than by ranking one notation above another,
 * and a child element nobody has classified is covered by the same rule.
 */
describe('an <alternatives> wrapper', () => {
  /** The deposit behind the report: TeX first, the same formula as presentation MathML second. */
  const REPRODUCTION =
    'for the anti-<inline-formula><alternatives><tex-math>$$k_{\\bot }$$</tex-math>' +
    '<mml:math xmlns:mml="http://www.w3.org/1998/Math/MathML"><mml:msub><mml:mi>k</mml:mi>' +
    '<mml:mi>⊥</mml:mi></mml:msub></mml:math></alternatives></inline-formula> algorithm';

  it('emits one encoding of a formula deposited twice', () => {
    expect(normalizeMarkupText(REPRODUCTION)).toBe('for the anti- $$k_{\\bot }$$ algorithm');
    expect(normalizeReferenceText(REPRODUCTION)).toBe('for the anti- $$k_{\\bot }$$ algorithm');
  });

  /**
   * The wrapper stands as its own token, so consuming it leaves the boundary its tags used to.
   * Publishers deposit the formula hard against the prose on both sides, and without the
   * boundary the sentence runs into the notation and out of it again.
   */
  it('leaves a word boundary where the deposit packs prose against the formula', () => {
    expect(
      normalizeMarkupText(
        'on a time scale<inline-formula><alternatives><tex-math>$\\mathbb{T}$</tex-math>' +
          '<mml:math><mml:mi>T</mml:mi></mml:math></alternatives></inline-formula>with two',
      ),
    ).toBe('on a time scale $\\mathbb{T}$ with two');

    expect(
      normalizeMarkupText(
        'is 43 μV/cm<inline-formula><alternatives><tex-math>$\\sqrt{\\text{Hz}}$</tex-math>' +
          '<mml:math><mml:msqrt><mml:mtext>Hz</mml:mtext></mml:msqrt></mml:math>' +
          '</alternatives></inline-formula> in the absence',
      ),
    ).toBe('is 43 μV/cm $\\sqrt{\\text{Hz}}$ in the absence');
  });

  /**
   * The boundary is the wrapper's own rather than the selected child's, so the same construct
   * spaces the same way whichever notation a publisher deposited first. Decided by the child it
   * would not: a MathML region carries a boundary and a `<tex-math>` wrapper joins tight.
   */
  it('spaces the same however the encodings are ordered', () => {
    const texFirst =
      'scale<alternatives><tex-math>$T$</tex-math><mml:math><mml:mi>T</mml:mi></mml:math>' +
      '</alternatives>with';
    const mathmlFirst =
      'scale<alternatives><mml:math><mml:mi>T</mml:mi></mml:math><tex-math>$T$</tex-math>' +
      '</alternatives>with';
    expect(normalizeMarkupText(texFirst)).toBe('scale $T$ with');
    expect(normalizeMarkupText(mathmlFirst)).toBe('scale T with');
  });

  /**
   * The selected child is handed back as deposited, so the pass that follows classifies it like
   * any other markup — here a MathML region, emptied of tags and read as one token.
   */
  it('classifies the child it selects rather than emitting it raw', () => {
    const graphicFirst =
      'the <alternatives><inline-graphic xlink:href="eq1.gif" />' +
      '<mml:math><mml:msub><mml:mi>Airy</mml:mi><mml:mn>2</mml:mn></mml:msub></mml:math>' +
      '</alternatives> process';
    expect(normalizeMarkupText(graphicFirst)).toBe('the Airy2 process');
    expect(normalizeReferenceText(graphicFirst)).toBe('the Airy2 process');
  });

  /** A child carrying no text is passed over on that basis, not by its element name. */
  it('passes over a text-free child whatever it is called', () => {
    expect(
      normalizeMarkupText(
        'a <alternatives><novel-encoding data="x" /><tex-math>$y$</tex-math></alternatives> b',
      ),
    ).toBe('a $y$ b');
    /**
     * A wrapper whose every child is text-free selects nothing and emits nothing. On the JATS
     * surface that is indistinguishable from emitting the children and letting the block
     * default remove them; the reference surface, where an unrecognized name is content, is
     * where the difference between "selected nothing" and "selected the wrapper's contents"
     * is visible at all.
     */
    const allGraphics =
      'a <alternatives><graphic href="e.png" /><inline-graphic href="f.png" /></alternatives> b';
    expect(normalizeMarkupText(allGraphics)).toBe('a b');
    expect(normalizeReferenceText(allGraphics)).toBe('a b');
  });

  /**
   * All or nothing, as every region is. An unclosed wrapper matches nothing and falls to the
   * name rule, which is what keeps the ordinary word `alternatives` from costing a reader a
   * bracketed phrase on the surface where an unrecognized name is content.
   */
  it('is the closed pair, not the word', () => {
    expect(normalizeReferenceText('see <alternatives> to this approach')).toBe(
      'see <alternatives> to this approach',
    );
    expect(normalizeReferenceText('two <alternatives, both untested> remain')).toBe(
      'two <alternatives, both untested> remain',
    );
  });

  /** A wrapper holding no child element keeps its content: nothing in it can be a duplicate. */
  it('keeps content it cannot have selected between', () => {
    expect(normalizeMarkupText('a <alternatives>bare text</alternatives> b')).toBe('a bare text b');
  });

  /** A child's own nested markup travels with it rather than ending it early. */
  it('takes a nested child whole', () => {
    expect(
      normalizeMarkupText(
        'x <alternatives><tex-math><i>a</i>+<i>b</i></tex-math><graphic href="g.png" /></alternatives> y',
      ),
    ).toBe('x a+b y');
  });

  /** Deeply nested children cost work proportional to the input, not exponential in its depth. */
  it('stays linear on an adversarially nested wrapper', () => {
    const deep = `<alternatives>${'<a-child>'.repeat(4000)}x${'</a-child>'.repeat(4000)}</alternatives>`;
    const started = performance.now();
    normalizeReferenceText(deep);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

/**
 * The two markup passes run one implementation over one rule and differ in exactly one thing:
 * what an unrecognized element name means. Everything else — the shape test, the regions, the
 * three separator classes, the link exception — is shared, and this file is what keeps it that
 * way. Each surface drifting from the other has been the defect four times running; a case that
 * belongs in the agreeing list and is not there is how the fifth one starts.
 */
describe('the JATS pass and the reference pass', () => {
  /**
   * Everything a recognized element name decides is shared, so both passes answer identically.
   * Half of these are the content survivors the reference rule exists to protect — they are
   * listed here rather than only on the reference surface because the shape test now guards
   * both, and a bracketed URL in a container title is no more disposable than one in a citation.
   */
  it('agrees on every input either surface recognizes', () => {
    const agreeing: Array<[string, string]> = [
      // Scripts and formula wrappers join tight, in every spelling.
      ['Uptake of CO<sub>2</sub> and H<sub>2</sub>O', 'Uptake of CO2 and H2O'],
      ['high T<inf>c</inf>-dc-SQUID gradiometers', 'high Tc-dc-SQUID gradiometers'],
      ['O<Stack><Subscript>2</Subscript><Superscript>-</Superscript></Stack>', 'O2-'],
      ['Ni/<inline-formula><tex-math>$x$</tex-math></inline-formula>/TiN', 'Ni/$x$/TiN'],
      [
        'Correlation of <ref_formula><tex>$1/f$</tex></ref_formula> noise',
        'Correlation of $1/f$ noise',
      ],
      // A MathML formula is a region on both surfaces, and renders once.
      [
        'Fractal geometry of <math xmlns="x"><semantics><msub><mi>Airy</mi><mn>2</mn></msub><annotation encoding="application/x-tex">\\mathrm{Airy}_2</annotation></semantics></math> processes',
        'Fractal geometry of Airy2 processes',
      ],
      // An alternatives wrapper is a region too, and renders one of its encodings.
      [
        'the <alternatives><tex-math>$x$</tex-math><graphic href="e.png" /></alternatives> case',
        'the $x$ case',
      ],
      // Inline emphasis is a word boundary, not an unconditional space.
      [
        'T.Isobe, <i>J. Am. ceram. Soc.</i>, <b>90</b>, 3720',
        'T.Isobe, J. Am. ceram. Soc., 90, 3720',
      ],
      ['A<i>B</i>C', 'A B C'],
      // A word character is any script's letter or digit, not just ASCII.
      ['Влияние<i>температуры</i>на', 'Влияние температуры на'],
      ['<span class="smallcaps">xvii</span><sup>e</sup> siècles', 'xviie siècles'],
      // A sentence-ending mark counts on the left the way a word character does, so a heading
      // a publisher marks with `<bold>` instead of `<title>` keeps its space.
      [
        'effectiveness of MOC.<bold>Methods</bold>We performed',
        'effectiveness of MOC. Methods We performed',
      ],
      [
        'Nobility or Utility?<i>Zamindars</i>, businessmen',
        'Nobility or Utility? Zamindars, businessmen',
      ],
      // It counts on the left only, or an italic journal title gains back the stray space
      // before the comma that the word-boundary rule exists to remove.
      ['<i>J. Am. Ceram. Soc.</i>, 49', 'J. Am. Ceram. Soc., 49'],
      // And a comma does not end a sentence: a chemical name that italicizes its locants runs
      // through one, and a space there splits the compound.
      [
        'Sodium Bromide in <i>N</i>,<i>N</i>-Dimethylformamide',
        'Sodium Bromide in N,N-Dimethylformamide',
      ],
      // Block elements always separate.
      ['<p>One citation.</p><p>Another.</p>', 'One citation. Another.'],
      ['Torino: Politecnico, 2019<refersplit />', 'Torino: Politecnico, 2019'],
      // A link keeps its tag, because the address lives in an attribute.
      [
        'Preprint, <a href="http://arxiv.org/abs/1102.1113v1">arXiv:1102.1113v1</a>.',
        'Preprint, <a href="http://arxiv.org/abs/1102.1113v1">arXiv:1102.1113v1</a>.',
      ],
      // The content survivors: a bracket that is not shaped like a tag is not markup, anywhere.
      [
        'FAOSTAT. <http://faostat.fao.org/site/291/default.aspx>.',
        'FAOSTAT. <http://faostat.fao.org/site/291/default.aspx>.',
      ],
      ['Silicon <100> nanowires', 'Silicon <100> nanowires'],
      [
        '10.1002/(SICI)1097-461X(1998)66:2<131::AID-QUA4>3.0.CO;2-W',
        '10.1002/(SICI)1097-461X(1998)66:2<131::AID-QUA4>3.0.CO;2-W',
      ],
      ['ZnxFe3-xO4 (0.01 < x > 0.8) nanoparticles', 'ZnxFe3-xO4 (0.01 < x > 0.8) nanoparticles'],
      ['The <B. subtilis> strain', 'The <B. subtilis> strain'],
      [
        'See <Stack Overflow, https://stackoverflow.com/q/1234>, retrieved 2020.',
        'See <Stack Overflow, https://stackoverflow.com/q/1234>, retrieved 2020.',
      ],
      // A citation envelope closes at its own end tag on both surfaces.
      [
        '<citation>Kato T. 1984.</citation> and <citation>Beale J. 1986.</citation>',
        'Kato T. 1984. and Beale J. 1986.',
      ],
      // The ordering both passes depend on: markup out, then entities.
      ['Use &lt;i&gt; for italics', 'Use <i> for italics'],
      ['Deposited as &amp;lt;i&amp;gt;', 'Deposited as &lt;i&gt;'],
      ['Interleukin-1-&beta; and M&uuml;ller', 'Interleukin-1-β and Müller'],
    ];
    for (const [raw, expected] of agreeing) {
      expect(normalizeMarkupText(raw), `JATS pass on ${raw}`).toBe(expected);
      expect(normalizeReferenceText(raw), `reference pass on ${raw}`).toBe(expected);
    }
  });

  /**
   * The one justified difference, and the whole of it. A title or abstract is deposited as JATS,
   * so a raw `<` in it came out of an XML document: an unrecognized name is structure and is
   * removed as a block boundary, which is the only reason `<sec>` and `<list-item>` do not reach
   * a reader. A reference entry is a citation string a publisher typed, where the same syntax
   * carries content, so an unrecognized name stays.
   */
  it('differs only on an element name neither surface classifies', () => {
    const differing: Array<[string, string, string]> = [
      [
        '<sec><title>Background</title><p>Body.</p></sec>',
        'Background Body.',
        '<sec><title>Background</title> Body. </sec>',
      ],
      ['a<subject>b</subject>c', 'a b c', 'a<subject>b</subject>c'],
      ['<list><list-item>One</list-item></list>', 'One', '<list><list-item>One</list-item></list>'],
      [
        'Cold Spring Harbor, <volume>876</volume> pp.',
        'Cold Spring Harbor, 876 pp.',
        'Cold Spring Harbor, <volume>876</volume> pp.',
      ],
      /**
       * An unclosed region matches nothing on either surface — that part is shared. What is
       * left behind then falls to the same one difference, because no MathML element name is
       * on a class list.
       */
      [
        'Unclosed <math xmlns="x"><mi>Z</mi> with no end',
        'Unclosed Z with no end',
        'Unclosed <math xmlns="x"><mi>Z</mi> with no end',
      ],
    ];
    for (const [raw, jats, reference] of differing) {
      expect(normalizeMarkupText(raw), `JATS pass on ${raw}`).toBe(jats);
      expect(normalizeReferenceText(raw), `reference pass on ${raw}`).toBe(reference);
    }
  });

  /**
   * Every admitted name, pinned by what a caller sees rather than by its presence in a list.
   * Two probes separate the four verdicts: one where the tag sits between two word characters,
   * one where it sits between two periods. A name admitted with no case behind it is how the
   * separator classes drifted the first time. The second probe also separates the two halves of
   * the word-boundary rule: an inline tag opening after a period starts a new word and takes the
   * space, while its closer sits before a period and does not.
   */
  it('gives every classified element name the behavior its class promises', () => {
    const joined: Record<string, [string, string]> = {
      tight: ['aXc', 'a.X.c'],
      inline: ['a X c', 'a. X.c'],
      block: ['a X c', 'a. X .c'],
      keep: ['a<n>X</n>c', 'a.<n>X</n>.c'],
    };
    for (const [name, verdict] of ELEMENT_VERDICTS) {
      const [tight, spaced] = joined[verdict] as [string, string];
      /**
       * A `keep` name is a link element, and it keeps its tags only while its `href` holds an
       * address its text does not. The probe hands it one, so what is measured is the verdict
       * rather than the absence of an attribute; the conditional half is pinned on its own.
       */
      const open =
        verdict === 'keep' ? `<${name} href="https://example.org/${name}/deep">` : `<${name}>`;
      const expand = (s: string) => s.replaceAll('<n>', open).replaceAll('</n>', `</${name}>`);
      for (const pass of [normalizeMarkupText, normalizeReferenceText]) {
        expect(pass(`a${open}X</${name}>c`), `${name} (${verdict})`).toBe(expand(tight));
        expect(pass(`a.${open}X</${name}>.c`), `${name} (${verdict})`).toBe(expand(spaced));
      }
    }
  });

  /**
   * The whole of the link rule, driven on both surfaces because both read it. A link element is
   * the one class decided per occurrence rather than per name: its tags come out exactly when
   * removing them cannot cost the reader the address, and stay whenever it can.
   */
  it('removes a link element only where its address survives without the tag', () => {
    /** Cases where nothing is at risk, so the tags come out as a word boundary. */
    const removed: Array<[string, string]> = [
      // The text repeats the href verbatim — an accession, a registration, a bare URL.
      [
        'number <ext-link ext-link-type="clintrialgov" xlink:href="NCT06494904">NCT06494904</ext-link>.',
        'number NCT06494904.',
      ],
      [
        'number <ext-link ext-link-type="clintrialgov" xlink:href="NCT02105844">NCT02105844</ext-link>.',
        'number NCT02105844.',
      ],
      [
        'at <uri xlink:type="simple" xlink:href="http://www.microscopy.com">http://www.microscopy.com</uri>.',
        'at http://www.microscopy.com.',
      ],
      [
        'Data: <ext-link xlink:href="https://osf.io/t5nes/?view_only=07c7590306624eb7a6510d5c69e26c02" ext-link-type="uri">https://osf.io/t5nes/?view_only=07c7590306624eb7a6510d5c69e26c02</ext-link>',
        'Data: https://osf.io/t5nes/?view_only=07c7590306624eb7a6510d5c69e26c02',
      ],
      // Everything but the scheme is in the text: the reader keeps what identifies the resource.
      [
        'See <ext-link xlink:href="http://www.fasebj.org">www.fasebj.org</ext-link>.',
        'See www.fasebj.org.',
      ],
      [
        'See <ext-link xlink:href="http://www.interscience.wiley.com">www.interscience.wiley.com</ext-link>.',
        'See www.interscience.wiley.com.',
      ],
      // A bare fragment names a place inside the publisher's own XML, which the reader does not
      // have, so it resolves to nothing and there is nothing to preserve.
      [
        'as <ext-link xlink:href="#b1">Turner’s (1995</ext-link>) argued',
        'as Turner’s (1995) argued',
      ],
      ['see <a href="#nph15488-sec-0002">Introduction</a>', 'see Introduction'],
      // No attribute at all: nothing of the element's value lives anywhere but its text.
      [
        'Registered at <ext-link>https://osf.io/cxqrz</ext-link>.',
        'Registered at https://osf.io/cxqrz.',
      ],
      ['<a name="fn1">note</a>', 'note'],
      ['an empty <a href="">anchor</a>', 'an empty anchor'],
      // The tags are a word boundary like any other inline element, not an unconditional space.
      ['A<a href="#x">B</a>C', 'A B C'],
      ['J. Am. Ceram. Soc.<a href="#x">49</a>, 1', 'J. Am. Ceram. Soc. 49, 1'],
      ['see<a href="#x">Fig. 1</a>, and', 'see Fig. 1, and'],
    ];

    /** Cases where the href addresses something the text does not name. */
    const kept = [
      // The path behind a bare host is exactly what identifies the record.
      'URL: <ext-link ext-link-type="uri" xlink:href="https://clinicaltrials.gov/ct2/show/NCT02196038">https://clinicaltrials.gov/</ext-link>;',
      // A hyperlinked taxon or gene name: the text names the thing, the href addresses it.
      '<ext-link xlink:href="https://lpsn.dsmz.de/genus/haloactinopolyspora">Haloactinopolyspora</ext-link>',
      '<ext-link xlink:href="http://www.uniprot.org/uniprot/P12643">BMP-2</ext-link>',
      // `www.` is a DNS label and a trailing slash is a path, so neither is a difference the
      // comparison forgives — the text has to carry the host and path it is given.
      'at <ext-link xlink:href="https://www.example.org/a">example.org/a</ext-link>.',
      'at <ext-link xlink:href="https://example.org/a/">example.org/a</ext-link>.',
      // Nor is a resolver host: `doi.org` is part of the address, not a prefix to be assumed.
      'see <a href="https://doi.org/10.1002/cssc.201600243">10.1002/cssc.201600243</a>.',
      // A self-closing link wraps no text, so nothing there can carry the address.
      'Source <ext-link xlink:href="https://example.org/a" />.',
      // An element the deposit never closes: its text cannot be seen, so it is not judged.
      'Source <ext-link xlink:href="https://example.org/a">unterminated',
    ];

    // A link the deposit never closes does not settle the ones before it. Recording the name
    // as unclosed is what keeps the scan for a closing tag from running once per opener, and
    // it is sound only because tags are visited left to right.
    expect(normalizeMarkupText('a <a href="#x">B</a> c <a href="https://e.org/z">d')).toBe(
      'a B c <a href="https://e.org/z">d',
    );

    for (const [raw, expected] of removed) {
      expect(normalizeMarkupText(raw), `JATS pass on ${raw}`).toBe(expected);
      expect(normalizeReferenceText(raw), `reference pass on ${raw}`).toBe(expected);
    }
    for (const raw of kept) {
      expect(normalizeMarkupText(raw), `JATS pass on ${raw}`).toBe(raw);
      expect(normalizeReferenceText(raw), `reference pass on ${raw}`).toBe(raw);
    }
  });

  /**
   * What the block default costs on the JATS surface, and the whole of that too: a bracketed
   * single token that reads as an element name — an acronym, a bare domain, an ordinary word —
   * is removed as though it were structure. It is the counterpart of the bare single-letter tag
   * the reference surface strips, accepted for the same kind of reason: the alternative leaves
   * `<sec>`, `<title>`, and `<list-item>` standing in every structured abstract. Pinned so a
   * later change to the default cannot move it silently.
   */
  it('removes a bracketed single token from a JATS-deposited field', () => {
    const residual = [
      'International <IR> Framework',
      'EPA standards, <www.ecfr.gov>, as of May 27, 2014.',
      'entre <ruptures> affichées',
    ];
    for (const raw of residual) {
      expect(normalizeMarkupText(raw), `JATS pass on ${raw}`).not.toContain('<');
      expect(normalizeReferenceText(raw), `reference pass on ${raw}`).toBe(raw);
    }
    expect(normalizeMarkupText('International <IR> Framework')).toBe('International Framework');
  });
});

describe('normalizeReferenceText', () => {
  it('strips markup, decodes entities, and collapses whitespace in one pass', () => {
    expect(
      normalizeReferenceText('<i>Users&apos; guides</i>   to the\n     medical literature'),
    ).toBe("Users' guides to the medical literature");
  });

  /**
   * Markup comes out before entities are decoded, so a deposited `&lt;i&gt;` stays literal
   * text rather than decoding into a tag the strip pass then eats — the same order
   * `normalizeMarkupText` depends on.
   */
  it('keeps an escaped tag as literal text', () => {
    expect(normalizeReferenceText('Deposited entity &lt;i&gt;stays literal&lt;/i&gt;')).toBe(
      'Deposited entity <i>stays literal</i>',
    );
    expect(normalizeReferenceText('Double-escaped &amp;lt;i&amp;gt; stays escaped')).toBe(
      'Double-escaped &lt;i&gt; stays escaped',
    );
  });

  /**
   * The deposits behind #51, through the whole pass: a guillemet quotation inside a structured
   * citation, and the Greek and accented Latin a reference list carries.
   */
  it('decodes the named references a citation string carries', () => {
    expect(
      normalizeReferenceText(
        '<mixed-citation publication-type="journal">(<year>2006</year>) <article-title>&laquo;Understanding Gas Condensate Reservoir&raquo;</article-title>, <source />Oilfieald Review</mixed-citation>',
      ),
    ).toBe('(2006) «Understanding Gas Condensate Reservoir», Oilfieald Review');
    expect(
      normalizeReferenceText(
        'Interleukin-1-&beta; (IL-1&beta;), interleukin 6 (IL-6) and tumor necrosis factor',
      ),
    ).toBe('Interleukin-1-β (IL-1β), interleukin 6 (IL-6) and tumor necrosis factor');
    expect(
      normalizeReferenceText('McLaren J, Millican SA, M&uuml;ller KH, et al.: 8, 21&ndash;28'),
    ).toBe('McLaren J, Millican SA, Müller KH, et al.: 8, 21–28');
  });

  /**
   * The bracket rule and the entity table have to stay independent. A cited URL carrying a
   * query string is the case where they meet: `&` there is punctuation the address needs.
   */
  it('leaves a cited URL and its query string byte-exact', () => {
    const raw = 'FAOSTAT. <http://faostat.fao.org/site/291/default.aspx?id=1&lang=en>.';
    expect(normalizeReferenceText(raw)).toBe(raw);
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

  /**
   * The names a scientific citation actually carries: Greek letters, accented Latin,
   * guillemets, dashes, typographic quotes. None is XML-reserved, so none was reachable
   * through the five-name table the decode started with.
   */
  it('decodes the named references deposits carry beyond the five XML names', () => {
    expect(decodeHtmlEntities('&laquo;Understanding Gas Condensate&raquo;')).toBe(
      '«Understanding Gas Condensate»',
    );
    expect(decodeHtmlEntities('Interleukin-1-&beta; (IL-1&beta;)')).toBe('Interleukin-1-β (IL-1β)');
    expect(decodeHtmlEntities('M&uuml;ller KH, S&aacute;rk&ouml;zy A')).toBe(
      'Müller KH, Sárközy A',
    );
    expect(decodeHtmlEntities('8, 21&ndash;28, 1991')).toBe('8, 21–28, 1991');
    expect(decodeHtmlEntities('&ldquo;High-Temperature Properties&rdquo;')).toBe(
      '“High-Temperature Properties”',
    );
    expect(decodeHtmlEntities('KUD&Ocirc; A, Wei&szlig;e P, O&prime;Neill M, &middot;')).toBe(
      'KUDÔ A, Weiße P, O′Neill M, ·',
    );
  });

  /** A few names resolve to more than one code point; the table carries the whole value. */
  it('decodes a reference whose value is more than one code point', () => {
    expect(decodeHtmlEntities('e&fjlig;ord')).toBe('efjord');
  });

  /**
   * Names are case-sensitive and the table is closed, so a name the spec does not define
   * stays as deposited. `&Amp;` and `&Eng;` are both real deposits — the second is the
   * journal abbreviation "Nuclear Science & Engineering", not a reference at all.
   */
  it('decodes only the exact names the spec defines', () => {
    expect(decodeHtmlEntities('Civil &AMP; Structural')).toBe('Civil & Structural');
    expect(decodeHtmlEntities('Civil &Amp; Structural')).toBe('Civil &Amp; Structural');
    expect(decodeHtmlEntities('Nuc. Sci. &Eng; 2013')).toBe('Nuc. Sci. &Eng; 2013');
  });

  /**
   * One pass, so a reference is resolved exactly once. `&amp;lt;` is the escaped text
   * `&lt;` and must stay that — a chained per-name replace resolves it twice and
   * manufactures a tag out of text a publisher escaped so it would not be one.
   */
  it('decodes each reference once, never the result of a previous decode', () => {
    expect(decodeHtmlEntities('&amp;lt;')).toBe('&lt;');
    expect(decodeHtmlEntities('&amp;amp;')).toBe('&amp;');
    expect(decodeHtmlEntities('&amp;#65;')).toBe('&#65;');
    expect(decodeHtmlEntities('&amp;beta;')).toBe('&beta;');
  });

  /**
   * A bare `&` is an ampersand somebody typed. Requiring the terminating semicolon is what
   * keeps it one — the legacy no-semicolon forms HTML still parses (`&copy`, `&times`) are
   * deliberately outside the table.
   */
  it('leaves a bare ampersand and a malformed reference exactly as deposited', () => {
    const cases = [
      'R&D and AT&T',
      'Guyatt & Rennie',
      '&notarealentity;',
      '&#;',
      '&#xZZ;',
      '&#x;',
      '&;',
      '& copy;',
      '&copy 2020, all rights reserved',
      'query?a=1&b=2',
    ];
    for (const raw of cases) expect(decodeHtmlEntities(raw)).toBe(raw);
  });

  /**
   * A numeric reference that names no scalar value — zero, past the last code point, or half
   * of a surrogate pair — is left as source text rather than emitting a character that would
   * be a hazard on the wire. Astral references resolve whole rather than being truncated to
   * sixteen bits.
   */
  it('resolves astral numeric references and passes over the ones naming no scalar', () => {
    expect(decodeHtmlEntities('&#128169;')).toBe('💩');
    expect(decodeHtmlEntities('&#x1F600;')).toBe('😀');
    expect(decodeHtmlEntities('&#0;')).toBe('&#0;');
    expect(decodeHtmlEntities('&#1114112;')).toBe('&#1114112;');
    expect(decodeHtmlEntities('&#55296;')).toBe('&#55296;');
  });

  it('returns plain strings unchanged', () => {
    expect(decodeHtmlEntities('plain text')).toBe('plain text');
  });

  it('handles a string with no entities', () => {
    expect(decodeHtmlEntities('')).toBe('');
  });

  /**
   * An abstract packed with references, and a long run of ampersands that start a name and
   * never terminate it, are both linear for this matcher — no nested quantifier to send it
   * exponential.
   */
  it('returns promptly on entity-dense and unterminated-reference input', () => {
    const unit = '&alpha;&beta;&#160;&amp;&notaname;&#x1F600;';
    const dense = unit.repeat(20_000);
    const unterminated = `${'&amp'.repeat(20_000)}&${'a'.repeat(50_000)}`;
    const started = Date.now();
    expect(decodeHtmlEntities(dense)).toBe(decodeHtmlEntities(unit).repeat(20_000));
    expect(decodeHtmlEntities(unterminated)).toBe(unterminated);
    expect(Date.now() - started).toBeLessThan(2_000);
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
    const result = parseDateParts({ 'date-parts': [[] as number[]] });
    expect(result).toBeUndefined();
  });

  /**
   * Crossref deposits an unknown component as `null` in the tuple rather than leaving it off, so
   * a record with no registered year arrives as `[[null]]`. That is the same fact as no date at
   * all, and each component is declared a number on every output schema that carries one —
   * passing the null through fails the whole call on a record whose every other field parsed.
   */
  it('returns undefined for a year Crossref does not know', () => {
    expect(parseDateParts({ 'date-parts': [[null]] })).toBeUndefined();
    expect(parseDateParts({ 'date-parts': [[null, 4, 5]] })).toBeUndefined();
  });

  /**
   * The tuple is positional, so the components below an unknown one carry no meaning on their
   * own: a day belonging to a month nobody named renders through formatDateParts as `2020-15`,
   * a date the deposit never made.
   */
  it('stops at the first component Crossref does not know', () => {
    expect(parseDateParts({ 'date-parts': [[2020, null]] })).toEqual({ year: 2020 });
    expect(parseDateParts({ 'date-parts': [[2020, null, 15]] })).toEqual({ year: 2020 });
    expect(parseDateParts({ 'date-parts': [[2020, 3, null]] })).toEqual({ year: 2020, month: 3 });
  });
});

describe('resolveWorkDate / resolveWorkSummaryDate', () => {
  it('answers with the preferred source when it names a date', () => {
    const raw = {
      published: { 'date-parts': [[2021, 6, 2]] },
      'published-print': { 'date-parts': [[2021, 7]] },
      issued: { 'date-parts': [[2021, 6, 2]] },
    };
    expect(resolveWorkDate(raw)).toEqual({ year: 2021, month: 6, day: 2 });
    expect(resolveWorkSummaryDate(raw)).toEqual({ year: 2021, month: 6, day: 2 });
  });

  /**
   * The whole point of the chain, and the one shape the two possible orders disagree on.
   * Crossref writes a component it does not know as `null` inside the tuple, so a source
   * deposited holding only unknowns states no date — the same fact an absent field states.
   * Selecting the source object first and parsing once would read its presence as an answer
   * and report no publication date for a record that names one two fields along.
   */
  it('falls through a source deposited with only unknown components', () => {
    const raw = {
      published: { 'date-parts': [[null]] },
      'published-print': { 'date-parts': [[2020, 5]] },
    };
    expect(resolveWorkDate(raw)).toEqual({ year: 2020, month: 5 });
    expect(resolveWorkSummaryDate(raw)).toEqual({ year: 2020, month: 5 });
  });

  it('falls through every unknown source in turn', () => {
    const raw = {
      published: { 'date-parts': [[null]] },
      'published-print': { 'date-parts': [[null, 4]] },
      'published-online': { 'date-parts': [[2018, 11, 30]] },
    };
    expect(resolveWorkDate(raw)).toEqual({ year: 2018, month: 11, day: 30 });
    expect(resolveWorkSummaryDate(raw)).toEqual({ year: 2018, month: 11, day: 30 });
  });

  /**
   * It advances on nothing, never on less. `published` is the earliest of the two publication
   * events and `published-online` is one particular event, so completing a coarse `published`
   * from a precise `published-online` would answer with the online date instead of the
   * publication date — on the ~10% of works whose sources differ in precision.
   */
  it('keeps a coarse date rather than refining it from a later source', () => {
    const raw = {
      published: { 'date-parts': [[2024]] },
      'published-print': { 'date-parts': [[2024]] },
      'published-online': { 'date-parts': [[2024, 1, 5]] },
    };
    expect(resolveWorkDate(raw)).toEqual({ year: 2024 });
    expect(resolveWorkSummaryDate(raw)).toEqual({ year: 2024 });
  });

  /** `issued` is the full record's last resort, and a work summary reads none of it. */
  it('reads issued for a record and never for a summary', () => {
    const raw = { issued: { 'date-parts': [[1997, 2]] } };
    expect(resolveWorkDate(raw)).toEqual({ year: 1997, month: 2 });
    expect(resolveWorkSummaryDate(raw)).toBeUndefined();
  });

  it('answers with nothing when no source names a date', () => {
    expect(resolveWorkDate({})).toBeUndefined();
    expect(resolveWorkDate({ issued: { 'date-parts': [[null]] } })).toBeUndefined();
    expect(resolveWorkSummaryDate({ published: { 'date-parts': [[null]] } })).toBeUndefined();
  });
});
