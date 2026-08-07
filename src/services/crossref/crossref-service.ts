/**
 * @fileoverview CrossrefService wraps the Crossref REST API with polite-pool User-Agent injection,
 * per-request timeout, retry with exponential backoff, and pagination helpers. Offset paging is
 * honored on the name-search and works sub-resource routes, whose ceilings differ by an order of
 * magnitude — see NAME_SEARCH_OFFSET_CAP and WORKS_OFFSET_CAP.
 * @module services/crossref/crossref-service
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError, validationError } from '@cyanheads/mcp-ts-core/errors';
import { httpErrorFromResponse, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import type {
  CrossrefListMessage,
  CrossrefSingleMessage,
  RawCrossrefFunder,
  RawCrossrefJournal,
  RawCrossrefMember,
  RawCrossrefPrefix,
  RawCrossrefWork,
} from './types.js';
import {
  MALFORMED_RESPONSE,
  REQUEST_TIMEOUT,
  rateLimitHint,
  UPSTREAM_UNAVAILABLE,
  upstreamEntryForStatus,
  upstreamError,
} from './upstream-errors.js';

/** Resolve package version at init time — avoids hardcoding the version string. */
function readPackageVersion(): string {
  try {
    // dist/services/crossref/ → dist/ → project root
    const pkgPath = fileURLToPath(new URL('../../../package.json', import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string };
    return pkg.version;
  } catch {
    return 'unknown';
  }
}

const _packageVersion = readPackageVersion();

/** Strip JATS XML tags from an abstract string. Many publishers deposit abstracts as JATS XML. */
export function stripJats(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Decode HTML entities in a string (e.g. &amp; → &, &lt; → <). */
export function decodeHtmlEntities(raw: string): string {
  return raw
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

/** Format a year/month/day object as an ISO-style date string (e.g. "2023-04-15" or "2023"). */
export function formatDateParts(d: {
  year?: number | undefined;
  month?: number | undefined;
  day?: number | undefined;
}): string {
  const parts: string[] = [];
  if (d.year !== undefined) parts.push(String(d.year));
  if (d.month !== undefined) parts.push(String(d.month).padStart(2, '0'));
  if (d.day !== undefined) parts.push(String(d.day).padStart(2, '0'));
  return parts.join('-');
}

/** Extract year/month/day from a Crossref date-parts array. Returns undefined when no parts exist. */
export function parseDateParts(
  raw: { 'date-parts'?: Array<Array<number>> } | undefined,
): { year?: number; month?: number; day?: number } | undefined {
  const parts = raw?.['date-parts']?.[0];
  if (!parts?.length) return;
  return {
    ...(parts[0] !== undefined && { year: parts[0] }),
    ...(parts[1] !== undefined && { month: parts[1] }),
    ...(parts[2] !== undefined && { day: parts[2] }),
  };
}

/** Strip URL/doi: prefix from a funder DOI, yielding a bare registry ID for the Crossref path. */
export function normalizeFunderId(raw: string): string {
  return raw.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:/i, '');
}

/** Crossref works search options. */
export type WorksSearchOptions = {
  query?: string;
  queryBibliographic?: string;
  queryTitle?: string;
  queryAuthor?: string;
  queryContainerTitle?: string;
  filter?: Record<string, string>;
  fields?: string[];
  rows?: number;
  offset?: number;
  cursor?: string;
  sort?: string;
  order?: string;
};

/** Crossref journals search options. `offset` applies to the title-query path only. */
export type JournalsSearchOptions = {
  query?: string;
  issn?: string;
  rows?: number;
  offset?: number;
};

/** Crossref funders search options. `offset` applies to the name-query path only. */
export type FundersSearchOptions = {
  query?: string;
  funderDoi?: string;
  rows?: number;
  offset?: number;
};

/** Paging options for the `/journals/{issn}/works` and `/funders/{id}/works` sub-resources. */
export type SubResourceWorksOptions = {
  rows: number;
  offset?: number;
};

/** Result of a works search, including pagination metadata. */
export type WorksSearchResult = {
  totalResults: number;
  itemsPerPage: number;
  nextCursor?: string | undefined;
  items: RawCrossrefWork[];
};

/** Result of a journal/funder name search, carrying the upstream total so callers can page. */
export type ListSearchResult<T> = {
  totalResults: number;
  items: T[];
};

/**
 * Crossref caps offset paging on the `/journals` and `/funders` name-search routes at
 * `offset + rows <= 100000`; past that it answers HTTP 400 `integer-not-valid`.
 */
export const NAME_SEARCH_OFFSET_CAP = 100_000;

/**
 * The `/journals/{issn}/works` and `/funders/{id}/works` sub-resources cap ten times lower —
 * `offset + rows <= 10000` — and their rejection body directs callers to cursor paging. This
 * server does not thread a cursor through those sub-resources, so the deep-paging path it offers
 * instead is `/works` with an `issn:` / `funder:` filter.
 */
export const WORKS_OFFSET_CAP = 10_000;

/**
 * Where the page after this one lives. `end` means the list is exhausted; `ceiling` means further
 * records exist upstream but the route's offset ceiling puts them out of reach through this input.
 * Those are different facts for a caller, so they are separate variants rather than one absent
 * offset — a page that stops at the ceiling has to say so or it reads as the end of the list.
 */
export type PageContinuation =
  | { kind: 'next'; offset: number }
  | { kind: 'end' }
  | { kind: 'ceiling' };

/** Classify the continuation for a page against its route's offset ceiling. */
export function nextPageOffset(args: {
  offset: number;
  returned: number;
  total: number;
  rows: number;
  cap: number;
}): PageContinuation {
  const next = args.offset + args.returned;
  if (next >= args.total) return { kind: 'end' };
  if (next + args.rows > args.cap) return { kind: 'ceiling' };
  return { kind: 'next', offset: next };
}

export class CrossrefService {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  constructor() {
    const cfg = getServerConfig();
    this.baseUrl = cfg.baseUrl;
    this.timeoutMs = cfg.timeoutMs;
    this.userAgent = cfg.mailto
      ? `crossref-mcp-server/${_packageVersion} (mailto:${cfg.mailto})`
      : `crossref-mcp-server/${_packageVersion}`;
  }

  /**
   * Retry boundary for a Crossref call. The default transient predicate is left in
   * place deliberately — the fix for "retries burned on a failure that can never
   * succeed" belongs one layer down, in `attempt()`, which returns every failure as an
   * `McpError` so the predicate classifies by error code. A custom predicate would only
   * re-sort the same unclassified exceptions by shape at the wrong layer.
   */
  private request<T>(path: string, ctx: Context): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    return withRetry(() => this.attempt<T>(url, ctx), {
      operation: 'CrossrefService.request',
      baseDelayMs: 1_000,
      signal: ctx.signal,
    });
  }

  /**
   * One attempt at a Crossref request. Every failure leaves here as an `McpError` with a
   * classified code and a recovery hint. `withRetry`'s default predicate treats any
   * non-`McpError` throw as transient and the framework's classifier reads the outer
   * error's constructor name, so an unwrapped throw is wrong twice over: a `SyntaxError`
   * from `JSON.parse` is retried to exhaustion and then surfaces as a caller
   * `ValidationError`, and a `TypeError` from `fetch` surfaces as an `InternalError`
   * — an upstream outage reported as a bug in this server.
   */
  private async attempt<T>(url: string, ctx: Context): Promise<T> {
    /**
     * An `AbortController` aborted with a `TimeoutError` DOMException rather than
     * `AbortSignal.timeout()`: the reason is then recognizable by identity below,
     * instead of by matching "timed out" in a message the runtime owns.
     */
    const controller = new AbortController();
    const timeoutReason = new DOMException(
      `Crossref request timed out after ${this.timeoutMs}ms.`,
      'TimeoutError',
    );
    const timer = setTimeout(() => controller.abort(timeoutReason), this.timeoutMs);
    const signal = AbortSignal.any([ctx.signal, controller.signal]);

    try {
      let response: Response;
      try {
        response = await fetch(url, { signal, headers: { 'User-Agent': this.userAgent } });
      } catch (err) {
        throw this.transportError(err, url, controller.signal.reason === timeoutReason, ctx);
      }

      if (!response.ok) throw await this.responseError(response, url);

      let text: string;
      try {
        // The timeout still covers the body read — a stalled stream is a timeout too.
        text = await response.text();
      } catch (err) {
        throw this.transportError(err, url, controller.signal.reason === timeoutReason, ctx);
      }

      if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
        throw upstreamError(
          UPSTREAM_UNAVAILABLE,
          'Crossref returned HTML instead of JSON — likely rate-limited or under maintenance.',
          { data: { url } },
        );
      }

      // A 200 with nothing in it is a truncated or dropped response, not a corrupt
      // serialization: retrying can succeed, and `malformed_response`'s advice to ask
      // for a smaller record has nothing to act on. Tested with a scan rather than
      // `trim()`, which copies the whole body on every successful request to answer.
      if (!/\S/.test(text)) {
        throw upstreamError(
          UPSTREAM_UNAVAILABLE,
          'Crossref returned HTTP 200 with an empty body.',
          { data: { url } },
        );
      }

      try {
        return JSON.parse(text) as T;
      } catch (err) {
        throw upstreamError(
          MALFORMED_RESPONSE,
          'Crossref returned HTTP 200 with a body that is not valid JSON.',
          { data: { url }, cause: err },
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Classify a raw transport rejection. `timedOut` is decided by which signal fired, not
   * by the rejection value: `fetch` rejects with the abort *reason*, which may be any
   * value. The network path rejects with a `TypeError` whose message ("fetch failed")
   * says nothing — the real reason sits on `.cause`, which the framework's classifier
   * never reads.
   */
  private transportError(err: unknown, url: string, timedOut: boolean, ctx: Context): unknown {
    if (timedOut) {
      return upstreamError(
        REQUEST_TIMEOUT,
        `Crossref did not respond within ${this.timeoutMs}ms.`,
        {
          data: { url, timeoutMs: this.timeoutMs },
          cause: err,
        },
      );
    }
    // Caller cancellation, not an upstream failure — withRetry exits on an aborted signal.
    if (ctx.signal.aborted) return err;
    return upstreamError(UPSTREAM_UNAVAILABLE, `Crossref could not be reached: ${causeOf(err)}`, {
      data: { url },
      cause: err,
    });
  }

  /**
   * Convert a non-2xx response into a classified error carrying recovery. Statuses the
   * caller owns keep their existing treatment: 400 surfaces Crossref's own
   * validation-failure detail, and everything else outside the upstream set (404 above
   * all) passes through as `httpErrorFromResponse` classified it, for the tool handlers
   * to turn into their own typed reasons.
   */
  private async responseError(response: Response, url: string): Promise<McpError> {
    if (response.status === 400) return crossrefValidationError(response);

    const retryAfter = response.headers.get('retry-after');
    const error = await httpErrorFromResponse(response, { service: 'Crossref', data: { url } });
    const entry = upstreamEntryForStatus(response.status);
    if (!entry) return error;

    return upstreamError(entry, error.message, {
      data: error.data,
      // The concrete wait is only reachable from content[] through the hint —
      // error.data.retryAfter never reaches a content-only client.
      hint:
        entry.code === JsonRpcErrorCode.RateLimited && retryAfter
          ? rateLimitHint(retryAfter)
          : undefined,
    });
  }

  /**
   * Fetch a single work by DOI. Returns null when the DOI is not found (404).
   * Lets the caller (tool handler) throw the appropriate typed error.
   */
  async getWork(doi: string, ctx: Context): Promise<RawCrossrefWork | null> {
    try {
      const envelope = await this.request<CrossrefSingleMessage<RawCrossrefWork>>(
        `/works/${encodeURIComponent(doi)}`,
        ctx,
      );
      return envelope.message;
    } catch (err) {
      // httpErrorFromResponse maps 404 → McpError(NotFound); the upstream contract
      // deliberately leaves 404 alone so it arrives here unmodified.
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) return null;
      throw err;
    }
  }

  /**
   * Fetch a Crossref member (publisher/organization) by numeric ID. Returns null on 404,
   * letting the caller throw the appropriate typed error. Mirrors getWork()'s 404→null pattern.
   */
  async getMember(id: number, ctx: Context): Promise<RawCrossrefMember | null> {
    try {
      const envelope = await this.request<CrossrefSingleMessage<RawCrossrefMember>>(
        `/members/${encodeURIComponent(String(id))}`,
        ctx,
      );
      return envelope.message;
    } catch (err) {
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) return null;
      throw err;
    }
  }

  /**
   * Resolve a DOI prefix (e.g. "10.1038") to its owning member. Returns null on 404.
   * Same 404→null pattern as getWork()/getMember().
   */
  async getPrefix(prefix: string, ctx: Context): Promise<RawCrossrefPrefix | null> {
    try {
      const envelope = await this.request<CrossrefSingleMessage<RawCrossrefPrefix>>(
        `/prefixes/${encodeURIComponent(prefix)}`,
        ctx,
      );
      return envelope.message;
    } catch (err) {
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) return null;
      throw err;
    }
  }

  /** Search works with filter, field selection, and cursor/offset pagination. */
  async searchWorks(opts: WorksSearchOptions, ctx: Context): Promise<WorksSearchResult> {
    const params = new URLSearchParams();
    if (opts.query) params.set('query', opts.query);
    // Field-specific query.* params scope matching to one indexed field and combine
    // with each other and with the generic query. Keys are hyphenated per Crossref.
    if (opts.queryBibliographic) params.set('query.bibliographic', opts.queryBibliographic);
    if (opts.queryTitle) params.set('query.title', opts.queryTitle);
    if (opts.queryAuthor) params.set('query.author', opts.queryAuthor);
    if (opts.queryContainerTitle) params.set('query.container-title', opts.queryContainerTitle);
    if (opts.rows != null) params.set('rows', String(opts.rows));

    if (opts.cursor) {
      params.set('cursor', opts.cursor);
    } else if (opts.offset != null && opts.offset > 0) {
      params.set('offset', String(opts.offset));
    }

    if (opts.sort) params.set('sort', opts.sort);
    if (opts.order) params.set('order', opts.order);

    if (opts.filter && Object.keys(opts.filter).length > 0) {
      const filterStr = Object.entries(opts.filter)
        .map(([k, v]) => `${k}:${v}`)
        .join(',');
      params.set('filter', filterStr);
    }

    /**
     * select= only on /works (search), never on /works/{doi}.
     *
     * DOI is force-included in every projection: it is the work summary's only
     * identifier and the sole key that chains into /works/{doi}, so a projection
     * that drops it yields records nothing downstream can resolve. Crossref's
     * select names are case-sensitive ("DOI" is valid, "doi" is rejected as
     * select-not-available), so the dedupe matches exactly — a caller who
     * miscases the name still gets the upstream validation error naming it.
     */
    if (opts.fields && opts.fields.length > 0) {
      const fields = opts.fields.includes('DOI') ? opts.fields : ['DOI', ...opts.fields];
      params.set('select', fields.join(','));
    }

    const qs = params.toString();
    const envelope = await this.request<CrossrefListMessage<RawCrossrefWork>>(
      `/works${qs ? `?${qs}` : ''}`,
      ctx,
    );
    return toWorksSearchResult(envelope.message);
  }

  /**
   * Search journals by query, or fetch one by ISSN. The ISSN path is a single-record lookup,
   * so it reports a total of 1 and ignores `offset`.
   */
  async searchJournals(
    opts: JournalsSearchOptions,
    ctx: Context,
  ): Promise<ListSearchResult<RawCrossrefJournal>> {
    if (opts.issn) {
      const envelope = await this.request<CrossrefSingleMessage<RawCrossrefJournal>>(
        `/journals/${encodeURIComponent(opts.issn)}`,
        ctx,
      );
      return { totalResults: 1, items: [envelope.message] };
    }
    const params = new URLSearchParams();
    if (opts.query) params.set('query', opts.query);
    if (opts.rows != null) params.set('rows', String(opts.rows));
    if (opts.offset != null && opts.offset > 0) params.set('offset', String(opts.offset));
    const qs = params.toString();
    const envelope = await this.request<CrossrefListMessage<RawCrossrefJournal>>(
      `/journals${qs ? `?${qs}` : ''}`,
      ctx,
    );
    return { totalResults: envelope.message['total-results'], items: envelope.message.items };
  }

  /** Fetch a page of works for a specific journal by ISSN, most recent first. */
  async getJournalWorks(
    issn: string,
    opts: SubResourceWorksOptions,
    ctx: Context,
  ): Promise<WorksSearchResult> {
    // Sort by publication date descending so "most recent works" is accurate — the
    // /works endpoint's default ordering is not chronological. `published` (chosen)
    // reflects publication date; `deposited` would reflect Crossref registration date.
    const params = new URLSearchParams({
      rows: String(opts.rows),
      sort: 'published',
      order: 'desc',
    });
    if (opts.offset != null && opts.offset > 0) params.set('offset', String(opts.offset));
    const envelope = await this.request<CrossrefListMessage<RawCrossrefWork>>(
      `/journals/${encodeURIComponent(issn)}/works?${params}`,
      ctx,
    );
    return toWorksSearchResult(envelope.message);
  }

  /**
   * Search funders by query, or fetch one by funder DOI. The DOI path is a single-record
   * lookup, so it reports a total of 1 and ignores `offset`.
   */
  async searchFunders(
    opts: FundersSearchOptions,
    ctx: Context,
  ): Promise<ListSearchResult<RawCrossrefFunder>> {
    if (opts.funderDoi) {
      const envelope = await this.request<CrossrefSingleMessage<RawCrossrefFunder>>(
        `/funders/${encodeURIComponent(normalizeFunderId(opts.funderDoi))}`,
        ctx,
      );
      return { totalResults: 1, items: [envelope.message] };
    }
    const params = new URLSearchParams();
    if (opts.query) params.set('query', opts.query);
    if (opts.rows != null) params.set('rows', String(opts.rows));
    if (opts.offset != null && opts.offset > 0) params.set('offset', String(opts.offset));
    const qs = params.toString();
    const envelope = await this.request<CrossrefListMessage<RawCrossrefFunder>>(
      `/funders${qs ? `?${qs}` : ''}`,
      ctx,
    );
    return { totalResults: envelope.message['total-results'], items: envelope.message.items };
  }

  /** Fetch a page of works for a specific funder by funder DOI/ID, most recent first. */
  async getFunderWorks(
    funderId: string,
    opts: SubResourceWorksOptions,
    ctx: Context,
  ): Promise<WorksSearchResult> {
    const id = normalizeFunderId(funderId);
    // Sort by publication date descending for predictable, most-recent-first ordering —
    // the /works endpoint's default ordering is not chronological. Matches
    // getJournalWorks so both funded-works and journal-works surfaces agree.
    const params = new URLSearchParams({
      rows: String(opts.rows),
      sort: 'published',
      order: 'desc',
    });
    if (opts.offset != null && opts.offset > 0) params.set('offset', String(opts.offset));
    const envelope = await this.request<CrossrefListMessage<RawCrossrefWork>>(
      `/funders/${encodeURIComponent(id)}/works?${params}`,
      ctx,
    );
    return toWorksSearchResult(envelope.message);
  }
}

/**
 * The most specific message available for a transport rejection. `fetch` wraps the real
 * failure — ECONNRESET, ENOTFOUND — in a `TypeError` whose own message is the useless
 * "fetch failed", so the cause is what a caller can act on.
 */
function causeOf(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  return err.cause instanceof Error ? err.cause.message : err.message;
}

/**
 * Crossref returns a structured validation-failure body on 400. Parse it and surface an
 * actionable message instead of leaking the raw body. Consumes the response body.
 */
async function crossrefValidationError(response: Response): Promise<McpError> {
  let detail = '';
  try {
    const json = (await response.json()) as {
      'message-type'?: string;
      message?: Array<{ type?: string; value?: string; message?: string }>;
    };
    if (json['message-type'] === 'validation-failure' && Array.isArray(json.message)) {
      detail = json.message
        .map((m) => {
          const badKey = m.value ? `"${m.value}"` : '';
          const hint =
            m.type === 'filter-not-available'
              ? ` — Crossref filter keys use hyphens (e.g. "${(m.value ?? '').replace(/_/g, '-')}")`
              : m.message
                ? ` — ${m.message}`
                : '';
          return `${badKey}${hint}`;
        })
        .filter(Boolean)
        .join('; ');
    }
  } catch {
    // Body was not the documented JSON shape — fall through to the generic message.
  }
  return validationError(
    detail
      ? `Crossref rejected the request: ${detail}`
      : 'Crossref returned HTTP 400 Bad Request — check filter key names (use hyphens, not underscores) and field names.',
  );
}

function toWorksSearchResult(
  msg: CrossrefListMessage<RawCrossrefWork>['message'],
): WorksSearchResult {
  return {
    totalResults: msg['total-results'],
    itemsPerPage: msg['items-per-page'],
    items: msg.items,
    ...(msg['next-cursor'] !== undefined && { nextCursor: msg['next-cursor'] }),
  };
}

// --- Init/accessor pattern ---

let _service: CrossrefService | undefined;

export function initCrossrefService(): void {
  _service = new CrossrefService();
  const cfg = getServerConfig();
  if (!cfg.mailto) {
    // Logger is not yet initialized when setup() runs, so use console.warn directly.
    console.warn(
      '[crossref-mcp-server] CROSSREF_MAILTO is not set — using the anonymous Crossref pool with stricter rate limits. ' +
        'Set CROSSREF_MAILTO to your contact email to enable polite-pool priority access.',
    );
  }
}

export function getCrossrefService(): CrossrefService {
  if (!_service) {
    throw new Error('CrossrefService not initialized — call initCrossrefService() in setup()');
  }
  return _service;
}
