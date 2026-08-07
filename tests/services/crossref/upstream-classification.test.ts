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

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  searchWorksTool,
} from '@/mcp-server/tools/definitions/index.js';
import { initCrossrefService } from '@/services/crossref/crossref-service.js';
import {
  MALFORMED_RESPONSE,
  RATE_LIMITED,
  REQUEST_TIMEOUT,
  UPSTREAM_ERROR_CONTRACT,
  UPSTREAM_UNAVAILABLE,
} from '@/services/crossref/upstream-errors.js';

const DOI = '10.1038/nature12373';
const WORKS_ROUTE = /\/works/;

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
  return result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
}

/** Run `crossref_get_work` through the full definition pipeline against the fetch fake. */
function getWork(): Promise<ToolResult> {
  return settle(runToolContract(getWorkTool, { doi: DOI }));
}

describe('upstream failure classification', () => {
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
    // Retry policy is out of #37's scope: a timeout still costs the full budget.
    expect(http.calls).toHaveLength(TOTAL_ATTEMPTS);
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

  it('maps 408 and 504 onto the timeout reason rather than the generic status code', async () => {
    for (const status of [408, 504]) {
      http.reset();
      http.route({ match: WORKS_ROUTE, respond: () => new Response('gateway', { status }) });

      const error = errorOf(await getWork());

      expect(error.code, `HTTP ${status}`).toBe(JsonRpcErrorCode.Timeout);
      expect(error.data, `HTTP ${status}`).toMatchObject({ reason: 'request_timeout' });
    }
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

  it('keeps Crossref validation detail on a 400 and does not retry it', async () => {
    http.route({
      match: WORKS_ROUTE,
      respond: () =>
        Response.json(
          {
            'message-type': 'validation-failure',
            message: [{ type: 'filter-not-available', value: 'has_abstract' }],
          },
          { status: 400 },
        ),
    });

    const result = await settle(
      runToolContract(searchWorksTool, { filter: { has_abstract: 'true' } }),
    );

    expect(errorOf(result).code).toBe(JsonRpcErrorCode.ValidationError);
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

describe('upstream error contract', () => {
  it('is declared on every tool, since every tool reaches Crossref through the service', () => {
    for (const definition of allToolDefinitions) {
      const declared = definition.errors.map((entry) => entry.reason);
      for (const entry of UPSTREAM_ERROR_CONTRACT) {
        expect(declared).toContain(entry.reason);
      }
    }
  });
});
