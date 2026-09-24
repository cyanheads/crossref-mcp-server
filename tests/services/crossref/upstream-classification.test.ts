/**
 * @fileoverview Transport and upstream failure handling for CrossrefService, asserted at
 * the wire: the JSON-RPC code, the retry cost, and whether recovery reaches `content[]`
 * as well as `structuredContent`.
 *
 * Nothing here stubs `withRetry` or `httpErrorFromResponse` — unlike
 * `crossref-service.test.ts`, which pass-throughs both. The misclassifications covered
 * below only appear when an unclassified throw meets the real transient predicate, so a
 * stubbed retry loop cannot reproduce or regress them. Upstream is a fetch fake and the
 * backoff sleeps run on fake timers, so an exhausted retry path costs no wall time.
 *
 * @module tests/services/crossref/upstream-classification.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createMockContext,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { logger } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { blockText } from '../../helpers/content.js';

/** The SDK's `CallToolResult`, reached through the runner so the SDK stays a transitive dep. */
type ToolResult = Awaited<ReturnType<typeof runToolContract>>;

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn().mockReturnValue({
    mailto: 'test@example.com',
    baseUrl: 'https://api.crossref.test',
    timeoutMs: 10_000,
  }),
}));

import {
  allToolDefinitions,
  getWorkTool,
  searchFundersTool,
  searchJournalsTool,
  searchWorksTool,
} from '@/mcp-server/tools/definitions/index.js';
import { getCrossrefService, initCrossrefService } from '@/services/crossref/crossref-service.js';
import {
  MALFORMED_RESPONSE,
  RATE_LIMITED,
  REQUEST_TIMEOUT,
  UPSTREAM_ERROR_CONTRACT,
  UPSTREAM_UNAVAILABLE,
} from '@/services/crossref/upstream-errors.js';

const DOI = '10.1038/nature12373';
const WORKS_ROUTE = /\/works/;

/** The configured `CROSSREF_BASE_URL` the mocked config above serves. */
const BASE_URL = 'https://api.crossref.test';

/** `withRetry`'s default budget: one attempt plus three retries. */
const TOTAL_ATTEMPTS = 4;

const http = createFetchMock();

beforeEach(() => {
  vi.useFakeTimers();
  http.reset();
  http.install();
  initCrossrefService();
});

afterEach(() => {
  http.restore();
  vi.useRealTimers();
});

/** Drive a pending call past `withRetry`'s backoff sleeps without waiting on them. */
async function settle<T>(promise: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return promise;
}

/** The wire error envelope a client reads from `structuredContent`. */
function errorOf(result: ToolResult) {
  const structured = result.structuredContent as {
    error: { code: number; message: string; data?: Record<string, unknown> };
  };
  return structured.error;
}

/** The rendered text a `content[]`-only client reads — the surface `error.data` never reaches. */
function textOf(result: ToolResult): string {
  return result.content.map(blockText).join('\n');
}

/** Run `crossref_get_work` through the full definition pipeline against the fetch fake. */
function getWork(): Promise<ToolResult> {
  return settle(runToolContract(getWorkTool, { doi: DOI }));
}

describe('upstream failure classification', () => {
  it('preserves the non-retryable 501 classification', async () => {
    http.route({ match: WORKS_ROUTE, respond: () => new Response('unsupported', { status: 501 }) });
    const result = await getWork();
    expect(errorOf(result)).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { retryable: false, reason: 'upstream_unavailable' },
    });
    expect(textOf(result)).toContain('501');
    expect(http.calls).toHaveLength(1);
  });

  it('classifies a malformed 200 body as SerializationError and spends one attempt', async () => {
    http.route({
      match: WORKS_ROUTE,
      respond: () =>
        new Response('{"status":"ok","message":{', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });

    const result = await getWork();
    const error = errorOf(result);

    // Was ValidationError (-32007) after four attempts: the raw SyntaxError was neither
    // an McpError (so the transient predicate retried it) nor classifiable by anything
    // but its constructor name (so it landed on the caller's input).
    expect(error.code).toBe(JsonRpcErrorCode.SerializationError);
    expect(error.data).toMatchObject({ reason: 'malformed_response', retryable: false });
    expect(http.calls).toHaveLength(1);
    expect(textOf(result)).toContain(MALFORMED_RESPONSE.recovery);
  });

  it('classifies a network-level failure as ServiceUnavailable and names its cause', async () => {
    http.route({
      match: WORKS_ROUTE,
      respond: () =>
        Promise.reject(new TypeError('fetch failed', { cause: new Error('ECONNRESET') })),
    });

    const result = await getWork();
    const error = errorOf(result);

    // Was InternalError (-32603): TypeError is excluded from the framework's type
    // mappings and "fetch failed" matches no message pattern, so an upstream outage
    // surfaced as a bug in this server.
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({ reason: 'upstream_unavailable' });
    expect(error.message).toContain('ECONNRESET');
    expect(http.calls).toHaveLength(TOTAL_ATTEMPTS);
    expect(textOf(result)).toContain(UPSTREAM_UNAVAILABLE.recovery);
  });

  it('classifies a timeout from the abort reason, not from the message text', async () => {
    http.route({
      match: WORKS_ROUTE,
      respond: (request) =>
        new Promise<Response>((_, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason), {
            once: true,
          });
        }),
    });

    const result = await getWork();
    const error = errorOf(result);

    // The code alone proved nothing before: a DOMException whose message happens to
    // contain "timed out" pattern-matches to Timeout with no reason and no hint. The
    // reason and the hint are only present when the abort was identified by identity.
    expect(error.code).toBe(JsonRpcErrorCode.Timeout);
    expect(error.data).toMatchObject({ reason: 'request_timeout', timeoutMs: 10_000 });
    expect(textOf(result)).toContain(REQUEST_TIMEOUT.recovery);
    // A deadline expiry costs the full CROSSREF_TIMEOUT_MS per attempt, so four of them is
    // ~47s of silence before the caller hears anything and can act on the hint above.
    expect(error.data).toMatchObject({ retryable: false });
    expect(http.calls).toHaveLength(1);
  });

  it('maps 408 and 504 onto the timeout reason and keeps their full retry budget', async () => {
    for (const status of [408, 504]) {
      http.reset();
      http.route({ match: WORKS_ROUTE, respond: () => new Response('gateway', { status }) });

      const error = errorOf(await getWork());

      expect(error.code, `HTTP ${status}`).toBe(JsonRpcErrorCode.Timeout);
      expect(error.data, `HTTP ${status}`).toMatchObject({ reason: 'request_timeout' });
      // Same reason as a deadline expiry, opposite retry economics: the response arrives as
      // fast as Crossref answers, so an attempt here is no more expensive than any other
      // transient status. Only the throw site whose cost this server's own clock sets opts out.
      expect(error.data, `HTTP ${status}`).not.toMatchObject({ retryable: false });
      expect(http.calls, `HTTP ${status}`).toHaveLength(TOTAL_ATTEMPTS);
    }
  });

  it('reclassifies an upstream 500 as ServiceUnavailable rather than InternalError', async () => {
    http.route({
      match: WORKS_ROUTE,
      respond: () => new Response('boom', { status: 500 }),
    });

    const result = await getWork();

    // InternalError is not in withRetry's transient set, so before this the 500 also
    // failed on the first attempt.
    expect(errorOf(result).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(errorOf(result).data).toMatchObject({ reason: 'upstream_unavailable' });
    expect(textOf(result)).toContain(UPSTREAM_UNAVAILABLE.recovery);
    expect(http.calls).toHaveLength(TOTAL_ATTEMPTS);
  });

  it('classifies a body read that fails mid-stream as unavailable, not malformed', async () => {
    http.route({
      match: WORKS_ROUTE,
      respond: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new TypeError('terminated'));
            },
          }),
        ),
    });

    const error = errorOf(await getWork());

    // The read never reached the parser, so this is transport, not serialization:
    // unwrapped it would escape `attempt()` as a raw TypeError and classify as an
    // InternalError after four attempts.
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({ reason: 'upstream_unavailable' });
    expect(http.calls).toHaveLength(TOTAL_ATTEMPTS);
  });

  it('classifies an empty 200 body as unavailable, and retries it', async () => {
    http.route({ match: WORKS_ROUTE, respond: () => new Response('', { status: 200 }) });

    const result = await getWork();
    const error = errorOf(result);

    // Not `malformed_response`: nothing was serialized to be corrupt, and that
    // reason's advice — ask for a smaller record — has nothing to act on.
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({ reason: 'upstream_unavailable' });
    expect(textOf(result)).toContain(UPSTREAM_UNAVAILABLE.recovery);
    expect(http.calls).toHaveLength(TOTAL_ATTEMPTS);
  });

  it('leaves a 404 to the tool handler and does not retry it', async () => {
    http.route({
      match: WORKS_ROUTE,
      respond: () => new Response('Resource not found.', { status: 404 }),
    });

    const result = await getWork();

    expect(errorOf(result).code).toBe(JsonRpcErrorCode.NotFound);
    expect(errorOf(result).data).toMatchObject({ reason: 'doi_not_found' });
    expect(http.calls).toHaveLength(1);
  });

  /**
   * The journal and funder single-record lookups read a plain-text 404 off the service as
   * their own not-found reason. The `cursor-invalid` rejection also arrives as a 404, so the
   * body decides which one a 404 is — these pin that a plain-text one is still left alone.
   */
  it('leaves a plain-text 404 on the journal and funder lookups to their handlers', async () => {
    http.route({
      match: /\/(journals|funders)\//,
      respond: () => new Response('Resource not found.', { status: 404 }),
    });

    const journal = await settle(runToolContract(searchJournalsTool, { issn: '1234-5678' }));
    const funder = await settle(runToolContract(searchFundersTool, { funder_doi: '999999999' }));

    expect(errorOf(journal)).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'issn_not_found' },
    });
    expect(errorOf(funder)).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'funder_not_found' },
    });
    expect(http.calls).toHaveLength(2);
  });

  it('keeps the upstream status on an exhausted 5xx', async () => {
    http.route({ match: WORKS_ROUTE, respond: () => new Response('down', { status: 503 }) });

    const error = errorOf(await getWork());

    expect(error.data).toMatchObject({ reason: 'upstream_unavailable', status: 503 });
    expect(error.message).toContain('503');
  });

  it('keeps Crossref validation detail on a 400 and does not retry it', async () => {
    http.route({
      match: WORKS_ROUTE,
      respond: () =>
        Response.json(
          {
            'message-type': 'validation-failure',
            message: [
              {
                type: 'filter-not-available',
                value: 'has_abstract',
                message:
                  "Filter 'has_abstract' specified but there is no such filter for this route. Valid filters for this route are: has-abstract, type",
              },
            ],
          },
          { status: 400 },
        ),
    });

    const result = await settle(
      runToolContract(searchWorksTool, { filter: { has_abstract: 'true' } }),
    );

    expect(errorOf(result).code).toBe(JsonRpcErrorCode.ValidationError);
    expect(errorOf(result).data).toMatchObject({ reason: 'unknown_filter' });
    expect(errorOf(result).message).toContain('has-abstract');
    expect(http.calls).toHaveLength(1);
  });
});

describe('recovery on both result surfaces', () => {
  it('carries the Retry-After wait into content[] on an exhausted rate limit', async () => {
    http.route({
      match: WORKS_ROUTE,
      respond: () => new Response('slow down', { status: 429, headers: { 'retry-after': '2' } }),
    });

    const result = await getWork();
    const error = errorOf(result);

    expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(error.data).toMatchObject({ reason: 'rate_limited', retryAfter: '2' });
    // A content-only client never sees error.data, so the wait has to be in the text.
    expect(textOf(result)).toContain('Retry-After: 2');
    expect(http.calls).toHaveLength(TOTAL_ATTEMPTS);
  });

  it('falls back to the contract hint when a 429 names no Retry-After', async () => {
    http.route({
      match: WORKS_ROUTE,
      respond: () => new Response('slow down', { status: 429 }),
    });

    const result = await getWork();
    const error = errorOf(result);

    expect(error.data).not.toHaveProperty('retryAfter');
    expect(textOf(result)).toContain(RATE_LIMITED.recovery);
    expect(textOf(result)).not.toContain('Retry-After:');
    // This is the only path on which RATE_LIMITED.recovery itself reaches the wire,
    // and on it there is no interval in the message and no retryAfter in the data —
    // so the text must not send a caller looking for either.
    expect(RATE_LIMITED.recovery).not.toMatch(/retryAfter|interval named/i);
  });

  it('renders recovery for an exhausted 503 alongside the attempt count', async () => {
    http.route({
      match: WORKS_ROUTE,
      respond: () => new Response('down', { status: 503 }),
    });

    const result = await getWork();
    const error = errorOf(result);

    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({ reason: 'upstream_unavailable' });
    expect(error.message).toContain(`failed after ${TOTAL_ATTEMPTS} attempts`);
    expect(textOf(result)).toContain(UPSTREAM_UNAVAILABLE.recovery);
  });

  it('renders recovery when Crossref serves an HTML error page as a 200', async () => {
    http.route({
      match: WORKS_ROUTE,
      respond: () =>
        new Response('<!DOCTYPE html><html><body>Rate limited</body></html>', { status: 200 }),
    });

    const result = await getWork();

    expect(errorOf(result).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(errorOf(result).message).toContain('HTML');
    expect(textOf(result)).toContain(UPSTREAM_UNAVAILABLE.recovery);
    expect(http.calls).toHaveLength(TOTAL_ATTEMPTS);
  });
});

describe('upstream request URL', () => {
  /**
   * Every failure shape the service classifies, as the upstream behavior that produces it.
   * Each one built its error on a different path — `httpErrorFromResponse`, `upstreamError`,
   * the tool handler's own typed reason — so the surface has to be checked on all of them
   * rather than on whichever one a single case happens to exercise.
   */
  const FAILURES: ReadonlyArray<readonly [string, (request: Request) => Promise<Response>]> = [
    ['a network-level rejection', () => Promise.reject(new TypeError('fetch failed'))],
    ['an upstream 500', async () => new Response('boom', { status: 500 })],
    [
      'an exhausted 429',
      async () => new Response('slow down', { status: 429, headers: { 'retry-after': '2' } }),
    ],
    ['a 501 the retry budget skips', async () => new Response('unsupported', { status: 501 })],
    [
      'an HTML error page served as 200',
      async () => new Response('<!DOCTYPE html><html><body>nope</body></html>', { status: 200 }),
    ],
    ['an empty 200 body', async () => new Response('', { status: 200 })],
    ['a malformed 200 body', async () => new Response('{"message":{', { status: 200 })],
    ['a 404 the handler owns', async () => new Response('Resource not found.', { status: 404 })],
    [
      'a deadline expiry',
      (request) =>
        new Promise<Response>((_, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason), {
            once: true,
          });
        }),
    ],
  ];

  /**
   * `error.data` is forwarded to the client as `structuredContent.error.data`, and
   * `CROSSREF_BASE_URL` is operator-configurable — a deployment pointed at a private mirror
   * would otherwise hand that hostname, plus every query string this server builds, to every
   * caller on every failure. The whole result is scanned rather than `data.url` alone: the
   * URL reaching `content[]`, the message, or a nested field costs the same as reaching the
   * key it used to sit on.
   */
  it.each(FAILURES)('is absent from the client-facing envelope on %s', async (_label, respond) => {
    http.route({ match: WORKS_ROUTE, respond });

    const result = await getWork();

    expect(errorOf(result).data ?? {}).not.toHaveProperty('url');
    expect(JSON.stringify(result)).not.toContain(BASE_URL);
  });

  /**
   * The body goes the same way as the URL. Crossref's 5xx bodies carry Java exception
   * names and stack excerpts, and nothing in a relayed body is a next step for the caller —
   * the status and the message say what failed.
   */
  it.each(FAILURES)('carries no upstream body on %s', async (_label, respond) => {
    http.route({ match: WORKS_ROUTE, respond });

    const data = errorOf(await getWork()).data ?? {};

    expect(data).not.toHaveProperty('body');
    expect(data).not.toHaveProperty('responseBody');
  });

  /**
   * Where the line actually sits. A socket rejection's own message embeds the address it
   * dialled (`connect ECONNREFUSED host:port`), and `causeOf` puts that message on the wire
   * because it is the only thing that says what went wrong — the framework draws the same
   * line, keeping the host in an upstream error's message while dropping the URL from
   * `error.data`. What must never travel is the rest of the URL: the route, the DOI, the
   * query string this server built. An HTTP-status failure carries neither, since
   * `httpErrorFromResponse` is given `service: 'Crossref'` and names that instead of a host.
   */
  it('keeps the route and query out of a transport rejection that names its address', async () => {
    http.route({
      match: WORKS_ROUTE,
      respond: () =>
        Promise.reject(
          new TypeError('fetch failed', {
            cause: new Error('connect ECONNREFUSED 10.0.0.4:8080'),
          }),
        ),
    });

    const result = await getWork();
    const wire = JSON.stringify(result);

    expect(errorOf(result).data ?? {}).not.toHaveProperty('url');
    expect(wire).not.toContain('/works');
    expect(wire).not.toContain(encodeURIComponent(DOI));
    expect(wire).not.toContain(BASE_URL);
  });

  it('reaches the operator through the Pino-only sink instead', async () => {
    const warning = vi.spyOn(logger, 'warning').mockImplementation(() => {});
    http.route({ match: WORKS_ROUTE, respond: () => new Response('down', { status: 503 }) });

    await getWork();

    // `ctx.log` is dual-sink — a line written there ships to the client as
    // `notifications/message`, which is the surface this whole block exists to keep clear.
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('Crossref request failed'),
      expect.objectContaining({
        extra: expect.objectContaining({
          url: `${BASE_URL}/works/${encodeURIComponent(DOI)}`,
        }),
      }),
    );
    warning.mockRestore();
  });

  it('is not logged as a failure when the caller cancelled', async () => {
    const warning = vi.spyOn(logger, 'warning').mockImplementation(() => {});
    const controller = new AbortController();
    http.route({
      match: WORKS_ROUTE,
      respond: (request) =>
        new Promise<Response>((_, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason), {
            once: true,
          });
        }),
    });

    const pending = runToolContract(
      getWorkTool,
      { doi: DOI },
      { context: { signal: controller.signal } },
    );
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(new Error('caller cancelled'));
    await pending;

    // A cancellation is the caller hanging up, not an upstream fault an operator has to chase.
    expect(warning).not.toHaveBeenCalled();
    warning.mockRestore();
  });
});

describe('timeout timer lifecycle', () => {
  it('clears the per-attempt timer once a request succeeds', async () => {
    http.route({
      match: WORKS_ROUTE,
      respond: () =>
        Response.json({
          status: 'ok',
          'message-type': 'work',
          message: { DOI, title: ['Ok'], type: 'journal-article' },
        }),
    });

    // Awaited directly, not through `settle` — `runAllTimersAsync` would fire the
    // pending abort timer and make an uncleared one indistinguishable from a cleared
    // one. A success path needs no timer advanced.
    await runToolContract(getWorkTool, { doi: DOI });

    // A `setTimeout` left armed after a successful call holds the event loop open for
    // the remainder of CROSSREF_TIMEOUT_MS on every request.
    expect(vi.getTimerCount()).toBe(0);
  });
});

/** The data keys a relayed upstream response would carry, none of which may reach the caller. */
const UPSTREAM_RESPONSE_KEYS = ['url', 'body', 'responseBody', 'status', 'statusCode'] as const;

/** Every key a Crossref filter can be checked against — a slice of the ~90 the route lists. */
const VALID_FILTERS =
  'until-approved-date, has-assertion, issn, has-abstract, directory, type, from-pub-date, has-full-text, has-references';

type RejectionEntry = { type: string; value: string; message: string };

function filterNotAvailable(key: string): RejectionEntry {
  return {
    type: 'filter-not-available',
    value: key,
    message: `Filter '${key}' specified but there is no such filter for this route. Valid filters for this route are: ${VALID_FILTERS}`,
  };
}

const TYPE_NOT_VALID = (value: string): RejectionEntry => ({
  type: 'type-not-valid',
  value,
  message: `Type specified as ${value} but must be one of: book-section, monograph, journal-article, book-chapter, dataset`,
});

const SORT_WITH_CURSOR: RejectionEntry = {
  type: 'sort-criteria-incompatible-with-cursor',
  value: 'sort',
  message:
    'Sorting by [issued, published, published-print, published-online] is not supported when using a cursor',
};

const CURSOR_INVALID: RejectionEntry = {
  type: 'cursor-invalid',
  value: 'garbage',
  message: 'Cursor specified but it is invalid',
};

/** Crossref's 400 body for a request it refuses to run, one entry per rejected input. */
function validationFailure(...entries: RejectionEntry[]): Response {
  return Response.json(
    { status: 'failed', 'message-type': 'validation-failure', message: entries },
    { status: 400 },
  );
}

/** Crossref's 404 body for a cursor token it does not recognize. */
function cursorInvalid(): Response {
  return Response.json(
    { status: 'failed', 'message-type': 'resource-failure', message: [CURSOR_INVALID] },
    { status: 404 },
  );
}

/** The declared recovery for a reason, failing the test when the tool does not declare it. */
function declaredRecovery(
  definition: { errors?: ReadonlyArray<{ reason: string; recovery: string }> },
  reason: string,
): string {
  const entry = definition.errors?.find((e) => e.reason === reason);
  if (!entry) throw new Error(`reason ${reason} is not declared`);
  return entry.recovery;
}

/**
 * The shape every rejection of caller input takes on the wire: a `ValidationError` naming its
 * declared reason, the declared recovery on `data.recovery.hint` and as a `Recovery:` line in
 * `content[]`, nothing of the upstream response on `data`, and a single attempt.
 */
function expectRejection(result: ToolResult, reason: string, recovery: string) {
  const error = errorOf(result);
  expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
  expect(error.data).toMatchObject({ reason, recovery: { hint: recovery } });
  expect(textOf(result)).toContain(`Recovery: ${recovery}`);
  expect(textOf(result)).toContain(`reason ${reason}`);
  for (const key of UPSTREAM_RESPONSE_KEYS) expect(error.data).not.toHaveProperty(key);
  return error;
}

describe('Crossref rejections of caller input', () => {
  const searchWorks = (input: Record<string, unknown>) =>
    settle(runToolContract(searchWorksTool, input));

  it('names an unknown filter key and suggests the hyphenated key Crossref lists', async () => {
    http.route({
      match: WORKS_ROUTE,
      respond: () => validationFailure(filterNotAvailable('has_abstract')),
    });

    const result = await searchWorks({ filter: { has_abstract: 'true' }, rows: 1 });

    const error = expectRejection(
      result,
      'unknown_filter',
      declaredRecovery(searchWorksTool, 'unknown_filter'),
    );
    expect(error.data).toMatchObject({
      suggestion: 'has-abstract',
      rejected: [{ type: 'filter-not-available', value: 'has_abstract' }],
    });
    expect(error.message).toContain('"has_abstract"');
    expect(error.message).toContain('"has-abstract"');
    // Crossref's ~90-key list stays off the message — the suggestion is the part to act on.
    expect(error.message).not.toContain('until-approved-date');
    expect(http.calls).toHaveLength(1);
  });

  it('suggests nothing when the hyphenated key is not a Crossref filter either', async () => {
    http.route({
      match: WORKS_ROUTE,
      respond: () => validationFailure(filterNotAvailable('is_open_access')),
    });

    const result = await searchWorks({ filter: { is_open_access: 'true' }, rows: 1 });

    const error = expectRejection(
      result,
      'unknown_filter',
      declaredRecovery(searchWorksTool, 'unknown_filter'),
    );
    expect(error.data).not.toHaveProperty('suggestion');
    expect(textOf(result)).not.toContain('is-open-access');
    /**
     * The recovery is what points an open-access filter somewhere that exists — and that
     * answers: Crossref accepts `directory:DOAJ` but fails every request carrying it with a 500.
     */
    expect(textOf(result)).toContain('license.url');
    expect(textOf(result)).not.toContain('directory:DOAJ');
  });

  it('reports a date sort paired with a cursor as sort_cursor_conflict', async () => {
    http.route({ match: WORKS_ROUTE, respond: () => validationFailure(SORT_WITH_CURSOR) });

    const result = await searchWorks({ query: 'crispr', sort: 'published', cursor: '*', rows: 1 });

    const error = expectRejection(
      result,
      'sort_cursor_conflict',
      declaredRecovery(searchWorksTool, 'sort_cursor_conflict'),
    );
    expect(error.data).toMatchObject({
      rejected: [{ type: 'sort-criteria-incompatible-with-cursor', value: 'sort' }],
    });
    expect(error.message).toContain('not supported when using a cursor');
    expect(http.calls).toHaveLength(1);
  });

  it('reports an unrecognized cursor token as invalid_cursor, not a bare not-found', async () => {
    http.route({ match: WORKS_ROUTE, respond: cursorInvalid });

    const result = await searchWorks({ query: 'crispr', cursor: 'garbage', rows: 1 });

    const error = expectRejection(
      result,
      'invalid_cursor',
      declaredRecovery(searchWorksTool, 'invalid_cursor'),
    );
    expect(error.data).toMatchObject({ rejected: [{ type: 'cursor-invalid', value: 'garbage' }] });
    expect(JSON.stringify(result)).not.toContain('resource-failure');
    expect(http.calls).toHaveLength(1);
  });

  it.each([
    [
      'crossref_search_journals',
      searchJournalsTool,
      { issn: '0028-0836', include_works: true, works_cursor: 'garbage', rows: 2 },
      /\/journals\/0028-0836\/works/,
      /\/journals\/0028-0836(?:\?|$)/,
      { title: 'Nature', 'ISSN-L': '0028-0836', ISSN: ['0028-0836'] },
    ],
    [
      'crossref_search_funders',
      searchFundersTool,
      { funder_doi: '100000001', include_works: true, works_cursor: 'garbage', rows: 2 },
      /\/funders\/100000001\/works/,
      /\/funders\/100000001(?:\?|$)/,
      { id: '100000001', name: 'National Science Foundation' },
    ],
  ] as const)(
    'reports an unrecognized works_cursor on %s as invalid_cursor',
    async (_name, definition, input, worksRoute, recordRoute, record) => {
      http.route({ match: worksRoute, respond: cursorInvalid });
      http.route({
        match: recordRoute,
        respond: () => Response.json({ status: 'ok', 'message-type': 'record', message: record }),
      });

      const result = await settle(runToolContract(definition, input));

      expectRejection(result, 'invalid_cursor', declaredRecovery(definition, 'invalid_cursor'));
      // The record lookup and the one works request — the rejection is not retried.
      expect(http.calls).toHaveLength(2);
    },
  );

  it.each([
    [{ type: 'journal-articl' }, TYPE_NOT_VALID('journal-articl')],
    [
      { 'has-abstract': 'yes' },
      {
        type: 'boolean-not-valid',
        value: 'yes',
        message: 'Boolean specified as yes but must be one of: t, true, 1, f, false, 0',
      },
    ],
  ])('reports a malformed filter value %j as invalid_parameter', async (filter, entry) => {
    http.route({ match: WORKS_ROUTE, respond: () => validationFailure(entry) });

    const result = await searchWorks({ filter, rows: 1 });

    const error = expectRejection(
      result,
      'invalid_parameter',
      declaredRecovery(searchWorksTool, 'invalid_parameter'),
    );
    expect(error.data).toMatchObject({ rejected: [{ type: entry.type, value: entry.value }] });
    // Crossref's own statement of the accepted form is what the caller corrects against.
    expect(error.message).toContain('must be one of');
    expect(http.calls).toHaveLength(1);
  });

  /**
   * Crossref rejects a blank value on a type-checked key with an entry whose value is empty —
   * nothing to quote back. The tool drops a blank value before the request instead, so that
   * rejection is never reached and a blank value never needs naming.
   */
  it('never sends a blank filter value from the tool, so that rejection is not reached', async () => {
    http.route({
      match: WORKS_ROUTE,
      respond: () =>
        Response.json({
          status: 'ok',
          'message-type': 'work-list',
          message: { 'total-results': 5, 'items-per-page': 1, items: [] },
        }),
    });

    const result = await searchWorks({ filter: { type: '', 'has-abstract': 'true' }, rows: 1 });

    expect(result.isError).toBeFalsy();
    expect(new URL(http.calls[0]?.request.url ?? '').searchParams.get('filter')).toBe(
      'has-abstract:true',
    );
  });

  it('lists every rejected input and takes the reason from the first', async () => {
    http.route({
      match: WORKS_ROUTE,
      respond: () => validationFailure(filterNotAvailable('has_abstract'), TYPE_NOT_VALID('foo')),
    });

    const result = await searchWorks({ filter: { has_abstract: 'true', type: 'foo' }, rows: 1 });

    const error = expectRejection(
      result,
      'unknown_filter',
      declaredRecovery(searchWorksTool, 'unknown_filter'),
    );
    expect(error.data?.rejected).toEqual([
      { type: 'filter-not-available', value: 'has_abstract' },
      { type: 'type-not-valid', value: 'foo' },
    ]);
    expect(error.message).toContain('"has_abstract"');
    expect(error.message).toContain('"foo"');
  });

  it('reads a 400 whose body does not parse as invalid_parameter', async () => {
    http.route({
      match: WORKS_ROUTE,
      respond: () => new Response('<html>Bad Request</html>', { status: 400 }),
    });

    const result = await searchWorks({ query: 'crispr', rows: 1 });

    const error = expectRejection(
      result,
      'invalid_parameter',
      declaredRecovery(searchWorksTool, 'invalid_parameter'),
    );
    expect(error.data?.rejected).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('<html>');
    expect(http.calls).toHaveLength(1);
  });

  it('is declared on the tools that can reach it, with one recovery per reason', () => {
    const reasons = (definition: { errors?: ReadonlyArray<{ reason: string }> }) =>
      (definition.errors ?? []).map((entry) => entry.reason);

    expect(reasons(searchWorksTool)).toEqual(
      expect.arrayContaining([
        'unknown_filter',
        'sort_cursor_conflict',
        'invalid_cursor',
        'invalid_parameter',
      ]),
    );
    for (const definition of [searchJournalsTool, searchFundersTool]) {
      expect(reasons(definition)).toEqual(
        expect.arrayContaining(['invalid_cursor', 'invalid_parameter']),
      );
      for (const reason of ['invalid_cursor', 'invalid_parameter']) {
        expect(declaredRecovery(definition, reason)).toBe(
          declaredRecovery(searchWorksTool, reason),
        );
      }
    }
  });
});

describe('the issn filter value', () => {
  /** Crossref's answer to an issn value it cannot read: a 500 carrying a Java exception. */
  const JAVA_EXCEPTION = JSON.stringify({
    status: 'error',
    'message-type': 'exception',
    'message-version': '1.0.0',
    message: {
      name: 'class java.lang.NullPointerException',
      description:
        'java.lang.NullPointerException: Cannot invoke "java.lang.CharSequence.length()"',
      stack: ['clojure.core$re_matcher.invokeStatic(core.clj:4912)'],
    },
  });

  /**
   * A blank value is dropped by the tool before this check (the key is then omitted), so it is
   * refused here only when it reaches the service directly.
   */
  it.each(['', '  '])('refuses a blank %j at the service, naming the key', async (issn) => {
    http.route({
      match: WORKS_ROUTE,
      respond: () => new Response(JAVA_EXCEPTION, { status: 500 }),
    });

    const error = await getCrossrefService()
      .searchWorks({ filter: { issn }, rows: 1 }, createMockContext())
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).message).toContain('filter "issn" was sent blank');
    expect((error as McpError).data).toMatchObject({
      reason: 'invalid_parameter',
      rejected: [{ type: 'issn-not-valid', value: issn }],
    });
    expect(http.calls).toHaveLength(0);
  });

  /**
   * Each value Crossref answers with a 500 — no run of seven digits and a check character once
   * everything but digits and X is stripped. The last two write a second `issn:` pair inside the
   * value, which Crossref splits off and reads on its own; the bad one of the two is named.
   */
  it.each([
    ['123', '123'],
    ['abcd-efgh', 'abcd-efgh'],
    ['0028-083', '0028-083'],
    ['0028-O836', '0028-O836'],
    ['0028X0836', '0028X0836'],
    ['0028-0836,issn:123', '123'],
    ['123,issn:0028-0836', '123'],
  ])('rejects %j before any request, naming the ISSN shape', async (issn, named) => {
    http.route({
      match: WORKS_ROUTE,
      respond: () => new Response(JAVA_EXCEPTION, { status: 500 }),
    });

    const result = await settle(runToolContract(searchWorksTool, { filter: { issn }, rows: 1 }));

    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({
      reason: 'invalid_parameter',
      rejected: [{ type: 'issn-not-valid', value: named }],
    });
    expect(error.message).toContain(`"${named}"`);
    expect(error.message).toContain('NNNN-NNNX');
    expect(textOf(result)).toMatch(/Recovery: .*NNNN-NNNX/);
    expect(http.calls).toHaveLength(0);
  });

  /**
   * Every spelling Crossref reads as an ISSN — measured against the live route, each of these
   * resolves to its journal's works — so none is refused here. The separator variants are what a
   * value copied from a web page or a PDF looks like; the last is Crossref's own filter syntax
   * for two ISSNs at once.
   */
  it.each([
    '0028-0836',
    '00280836',
    '2167-647X',
    '2167-647x',
    ' 0028-0836 ',
    '0028–0836',
    '0028 0836',
    'ISSN 0028-0836',
    '0028-08361',
    '0028-0836,issn:1476-4687',
  ])('sends %j through as given', async (issn) => {
    http.route({
      match: WORKS_ROUTE,
      respond: () =>
        Response.json({
          status: 'ok',
          'message-type': 'work-list',
          message: { 'total-results': 0, 'items-per-page': 1, items: [] },
        }),
    });

    const result = await settle(runToolContract(searchWorksTool, { filter: { issn }, rows: 1 }));

    expect(result.isError).toBeFalsy();
    expect(http.calls).toHaveLength(1);
    expect(new URL(http.calls[0]?.request.url ?? '').searchParams.get('filter')).toBe(
      `issn:${issn}`,
    );
  });

  it('keeps the raw body of a 500 off the error data', async () => {
    // A filter the pre-request check does not cover, reaching the same upstream failure.
    http.route({
      match: WORKS_ROUTE,
      respond: () => new Response(JAVA_EXCEPTION, { status: 500 }),
    });

    const result = await settle(runToolContract(searchWorksTool, { query: 'crispr', rows: 1 }));

    const error = errorOf(result);
    expect(error.data).toMatchObject({ reason: 'upstream_unavailable', status: 500 });
    expect(error.data).not.toHaveProperty('body');
    expect(error.data).not.toHaveProperty('responseBody');
    expect(JSON.stringify(result)).not.toContain('NullPointerException');
  });
});

describe('upstream error contract', () => {
  it('is declared on every tool, since every tool reaches Crossref through the service', () => {
    for (const definition of allToolDefinitions) {
      const declared = (definition.errors ?? []).map((entry) => entry.reason);
      for (const entry of UPSTREAM_ERROR_CONTRACT) {
        expect(declared).toContain(entry.reason);
      }
    }
  });
});
