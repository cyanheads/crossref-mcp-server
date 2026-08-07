/**
 * @fileoverview Error contract for Crossref transport and upstream failures, plus the
 * factory that throws against it. `CrossrefService` is shared by every tool, so the
 * reasons it can raise are declared once here, spread into each tool's `errors[]`, and
 * used as the wire recovery hint at the throw site — one table, so a tool's declared
 * contract and the hint its caller receives cannot drift apart.
 * @module services/crossref/upstream-errors
 */

import type { ErrorContract } from '@cyanheads/mcp-ts-core/errors';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';

/**
 * HTTP 429 that the retry budget could not clear — either the retries were spent, or
 * the upstream asked for a wait longer than the budget and `withRetry` failed fast.
 *
 * This `recovery` reaches the wire only when the 429 carried no `Retry-After` header:
 * when one is present, {@link rateLimitHint} overrides it with the concrete value. So
 * the text names no interval and no `retryAfter` field — neither exists in this case.
 */
export const RATE_LIMITED = {
  reason: 'rate_limited',
  code: JsonRpcErrorCode.RateLimited,
  when: 'Crossref answered HTTP 429 and the limit did not clear inside the retry budget.',
  recovery:
    'Crossref named no wait interval, so back off at least a minute before reissuing the same call, and lower the request rate. Setting CROSSREF_MAILTO on the server moves requests into the polite pool, which has higher limits.',
} as const satisfies ErrorContract;

/**
 * Crossref unreachable or failing: a network-level error, a 5xx, or an HTML error page
 * served in place of JSON. One reason rather than three, because the caller's move is
 * the same for all of them — the request was fine, the upstream was not.
 */
export const UPSTREAM_UNAVAILABLE = {
  reason: 'upstream_unavailable',
  code: JsonRpcErrorCode.ServiceUnavailable,
  when: 'Crossref was unreachable, returned a 5xx status, or served an HTML error page instead of JSON.',
  recovery:
    'The request was accepted as well-formed and Crossref failed to serve it — retry the same call in a minute rather than rewriting the query, and check https://status.crossref.org if it keeps failing.',
} as const satisfies ErrorContract;

/**
 * HTTP 200 whose body is non-empty and not JSON. `retryable: false` because the body
 * read completed and produced content — a stream that died mid-transfer rejects in
 * `Response.text()`, and an empty body is caught before the parser; both classify as
 * unavailable instead. So reaching the parser with bytes that will not parse means the
 * upstream serialized something broken and an identical GET will serialize it again.
 */
export const MALFORMED_RESPONSE = {
  reason: 'malformed_response',
  code: JsonRpcErrorCode.SerializationError,
  retryable: false,
  when: 'Crossref returned HTTP 200 with a body that is not valid JSON.',
  recovery:
    'Do not repeat the call unchanged — the body is corrupt rather than transient. Request less of the record (fewer rows, a narrower select) so a smaller response is serialized, or report the query that reproduces it.',
} as const satisfies ErrorContract;

/**
 * The request exceeded `CROSSREF_TIMEOUT_MS`, or Crossref answered 408/504.
 *
 * The entry stays retryable because 408 and 504 arrive at whatever speed the upstream answers,
 * so retrying one costs about what any other transient status costs. The deadline-expiry throw
 * site is the exception and opts itself out — see `transportError` in `crossref-service.ts`.
 */
export const REQUEST_TIMEOUT = {
  reason: 'request_timeout',
  code: JsonRpcErrorCode.Timeout,
  when: 'Crossref did not respond within CROSSREF_TIMEOUT_MS, or answered HTTP 408/504.',
  recovery:
    'Ask for less work per call — lower rows, drop select fields, or split a broad query — or raise CROSSREF_TIMEOUT_MS on the server, then retry.',
} as const satisfies ErrorContract;

/**
 * Spread into every tool's `errors[]`. Each tool reaches Crossref through the shared
 * service, so each can raise all four; a contract listing only the tool's own
 * input-shape failures under-reports what a caller has to handle.
 */
export const UPSTREAM_ERROR_CONTRACT = [
  RATE_LIMITED,
  UPSTREAM_UNAVAILABLE,
  MALFORMED_RESPONSE,
  REQUEST_TIMEOUT,
] as const;

/**
 * Build an `McpError` against a contract entry, mirroring what `ctx.fail` +
 * `ctx.recoveryFor` do inside a handler. The service throws from outside any tool's
 * contract, so it cannot use those: `ctx.recoveryFor` resolves against the calling
 * tool's declared reasons and returns an empty object — silently, with no hint on the
 * wire — for any tool that has not declared the one being raised.
 *
 * `hint` overrides the contract's static `recovery` text when the throw site has
 * specifics worth carrying (the concrete `Retry-After` value, for instance). The
 * override lands on `data.recovery.hint`, which is the only surface a content-only
 * client sees — `error.data` itself never reaches it.
 *
 * `retryable` overrides the entry's own value for a throw site whose retry cost differs
 * from the rest of the reason. `withRetry`'s default predicate reads `data.retryable`,
 * so a `false` here fails the call on its first attempt.
 */
export function upstreamError(
  entry: ErrorContract,
  message: string,
  options: {
    data?: Record<string, unknown> | undefined;
    hint?: string | undefined;
    retryable?: boolean | undefined;
    cause?: unknown;
  } = {},
): McpError {
  const { data, hint, retryable, cause } = options;
  const effectiveRetryable = retryable ?? entry.retryable;
  return new McpError(
    entry.code,
    message,
    {
      ...data,
      ...(effectiveRetryable !== undefined && { retryable: effectiveRetryable }),
      reason: entry.reason,
      recovery: { hint: hint ?? entry.recovery },
    },
    cause !== undefined ? { cause } : undefined,
  );
}

/**
 * The contract entry an HTTP status maps to, or `undefined` when the status is the
 * caller's to act on rather than the upstream's. 404 and 400 are deliberately absent:
 * the tool handlers turn those into their own typed reasons (`doi_not_found`,
 * `issn_not_found`, Crossref's own validation message), and re-classifying them here
 * would bury those.
 */
export function upstreamEntryForStatus(status: number): ErrorContract | undefined {
  if (status === 429) return RATE_LIMITED;
  if (status === 408 || status === 504) return REQUEST_TIMEOUT;
  if (status >= 500) return UPSTREAM_UNAVAILABLE;
  return;
}

/**
 * Recovery text carrying the upstream's own `Retry-After`. The header value is quoted
 * rather than described in seconds because RFC 9110 allows both delta-seconds and an
 * HTTP-date, and only the raw value is correct for both.
 */
export function rateLimitHint(retryAfter: string): string {
  return `Crossref returned Retry-After: ${retryAfter} — wait that long before reissuing the same call. Setting CROSSREF_MAILTO on the server moves requests into the polite pool, which has higher limits.`;
}
