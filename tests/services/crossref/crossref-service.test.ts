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
  formatDateParts,
  getCrossrefService,
  initCrossrefService,
  NAME_SEARCH_OFFSET_CAP,
  nextPageOffset,
  normalizeMarkupText,
  normalizeReferenceText,
  normalizeText,
  parseDateParts,
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
   * A link's URL lives in an attribute, so stripping the tag would delete it. `a`, `ext-link`,
   * and `uri` — which takes an `xlink:href` in JATS — stay off the allow-list for that reason,
   * not by oversight.
   */
  it('leaves a link tag whole so its href survives', () => {
    const anchor = 'Preprint, <a href="http://arxiv.org/abs/1102.1113v1">arXiv:1102.1113v1</a>.';
    expect(stripReferenceMarkup(anchor)).toBe(anchor);
    const extLink = 'at <ext-link xlink:href="http://x.org/a.pdf">http://x.org/a.pdf</ext-link>.';
    expect(stripReferenceMarkup(extLink)).toBe(extLink);
    const uri = 'Available from <uri>https://www.pcne.org/upload/files/417.pdf</uri>. Accessed.';
    expect(stripReferenceMarkup(uri)).toBe(uri);
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

  /** A deeply nested or bracket-heavy field must not send the matcher exponential. */
  it('returns promptly on adversarial bracket input', () => {
    const nested = `${'<i><b><sub>'.repeat(400)}x${'</sub></b></i>'.repeat(400)}`;
    const unterminated = `<p class="a" ${'x = "y" '.repeat(600)}`;
    const started = Date.now();
    stripReferenceMarkup(nested);
    stripReferenceMarkup(unterminated);
    stripReferenceMarkup(`${'<math><mi>'.repeat(400)}z`);
    expect(Date.now() - started).toBeLessThan(2_000);
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
   * The link exception holds at any nesting: inside an envelope every other name comes out,
   * and `uri` and `ext-link` still keep their tags because their address can live in an
   * attribute. This is the only place the exception does any work — outside an envelope
   * neither name is on a strip list to begin with.
   */
  it('spares every link spelling inside a citation envelope', () => {
    expect(
      normalizeReferenceText(
        '<mixed-citation>Available from <uri>https://www.pcne.org/x.pdf</uri>. Accessed.</mixed-citation>',
      ),
    ).toBe('Available from <uri>https://www.pcne.org/x.pdf</uri>. Accessed.');
    expect(
      normalizeReferenceText(
        '<mixed-citation>WHO. <ext-link xlink:href="http://who.int/a">http://who.int/a</ext-link>.</mixed-citation>',
      ),
    ).toBe('WHO. <ext-link xlink:href="http://who.int/a">http://who.int/a</ext-link>.');
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
    // Crossref occasionally returns [null] in date-parts
    const result = parseDateParts({ 'date-parts': [[] as number[]] });
    expect(result).toBeUndefined();
  });
});
