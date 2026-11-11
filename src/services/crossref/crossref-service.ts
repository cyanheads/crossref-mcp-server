/**
 * @fileoverview CrossrefService wraps the Crossref REST API with polite-pool User-Agent injection,
 * per-request timeout, retry with exponential backoff, and pagination helpers. Offset paging is
 * honored on the name-search routes and on the journal and funder works lists, whose ceilings
 * differ by an order of magnitude — see NAME_SEARCH_OFFSET_CAP and WORKS_OFFSET_CAP. Cursor
 * paging has no ceiling and is available on `/works` and `/funders/{id}/works`, the two routes
 * the works lists read. Every works-list request names its fields in `select=` — the caller's
 * `fields` on a works search, `WORKS_LIST_SELECT` on the journal and funder lists — since
 * without one Crossref returns whole records, reference lists included. Two requests leave
 * Crossref, both made only after a Crossref 404, both to `https://doi.org` whatever
 * `CROSSREF_BASE_URL` says, and neither carrying the polite-pool `mailto`: the DOI registry's
 * agency lookup (`getRegistrationAgency`, `getDoiRegistration`), and — for a DOI one of the
 * agencies in `CSL_AGENCIES` registered — the work's CSL-JSON citation, read inside the
 * lookup's own timeout window (`getDoiRegistration`).
 * @module services/crossref/crossref-service
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type Context, z } from '@cyanheads/mcp-ts-core';
import {
  type ErrorContract,
  JsonRpcErrorCode,
  McpError,
  requestCancelled,
} from '@cyanheads/mcp-ts-core/errors';
import { httpErrorFromResponse, logger, withExtra, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { collapseWhitespace } from './markup-text.js';
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
  INVALID_CURSOR,
  INVALID_PARAMETER,
  MALFORMED_RESPONSE,
  REQUEST_TIMEOUT,
  rateLimitHint,
  SORT_CURSOR_CONFLICT,
  UNKNOWN_FILTER,
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

/**
 * Unwrap a DOI from the resolver it was copied with — `https://doi.org/…`, the older
 * `dx.doi.org` host, or the `doi:` URI scheme — leaving the bare DOI Crossref's paths take.
 *
 * Every one of those forms names exactly one DOI, so the rewrite has a single reading and
 * costs the caller nothing: the argument is answerable as sent instead of being handed back
 * for the caller to edit. It is prefix removal and nothing more — a host that merely contains
 * `doi.org`, and any string that carries no recognized wrapper, comes back byte-exact, so the
 * tool schemas still reject what is not a DOI rather than hunting for one inside the argument.
 *
 * Shared by the DOI tools and the funder path, where the same wrappers arrive around a Funder
 * Registry DOI (`10.13039/100000001`) and a bare registry ID passes straight through.
 */
export function normalizeDoi(raw: string): string {
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
  fields?: readonly string[];
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

/**
 * Paging options for the journal and funder works lists — `/works` filtered on a journal's ISSNs,
 * and the `/funders/{id}/works` sub-resource. `cursor` and `offset` are alternatives, not a
 * pair — Crossref rejects the combination with
 * `cursor-with-offset-or-sample`, so `cursor` wins here and callers validate ahead of the call.
 * The two modes also order the list differently: an offset page is newest-published first, a
 * cursor walk newest-registered first — see `worksListPageParams`.
 */
export type WorksListOptions = {
  rows: number;
  offset?: number;
  cursor?: string;
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
 * The journal and funder works lists cap ten times lower — `offset + rows <= 10000`, the ceiling
 * `/works` and the `/funders/{id}/works` sub-resource share — and the rejection body directs
 * callers to cursor paging. It is a ceiling on the `offset` input alone: both routes accept
 * `cursor=*` and return a `next-cursor` token, which the tools thread as `works_cursor` /
 * `nextWorksCursor` to read past it.
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

/**
 * Classify the continuation for a page against its route's offset ceiling. Any offset below the
 * ceiling is spendable — the tools cut a page that would pass it to the rows that fit — so the
 * ceiling is reached only once the next offset sits on it.
 */
export function nextPageOffset(args: {
  offset: number;
  returned: number;
  total: number;
  cap: number;
}): PageContinuation {
  const next = args.offset + args.returned;
  if (next >= args.total) return { kind: 'end' };
  if (next >= args.cap) return { kind: 'ceiling' };
  return { kind: 'next', offset: next };
}

/** The DOI registry's agency lookup; it takes a full DOI or a bare prefix after the slash. */
const DOI_REGISTRY_URL = 'https://doi.org/doiRA';

/**
 * The registry answers with a one-element array: `[{ DOI, RA: "DataCite" }]` when an agency holds
 * the identifier, `[{ DOI, status: "DOI does not exist" }]` (or another status) when none does.
 *
 * The agency name reaches error text, so it is held to the shape of one: a single token of
 * letters and digits, as every agency the registry names is spelled (Crossref, DataCite, mEDRA,
 * JaLC, KISTI, CNKI, ISTIC, Airiti, OP, EIDR, Public). No space or period, so a value carrying a
 * sentence never reaches the message. The pattern is anchored and is one bounded character class
 * with no nested quantifier, so it is linear in the value by construction.
 *
 * The status branch refuses an `RA` key outright. Without that, an entry whose agency name fails
 * the shape would still parse as a status once the stricter branch rejected it, and an identifier
 * the registry says an agency holds would read as one nobody registered.
 */
const RegistryAnswerSchema = z.tuple([
  z.union([
    z.object({ RA: z.string().regex(/^[\p{L}\p{N}][\p{L}\p{N}&-]{0,31}$/u) }),
    z.object({ status: z.string(), RA: z.never().optional() }),
  ]),
]);

/** doi.org itself: a DOI's own path, content-negotiated, answers with its agency's metadata. */
const DOI_RESOLVER_URL = 'https://doi.org';

/** The citation request asks for CSL-JSON, and a response in any other media type is not read. */
const CSL_MEDIA_TYPE = 'application/vnd.citationstyles.csl+json';

/**
 * The registration agencies, lowercased, whose DOIs doi.org was seen to answer with CSL-JSON.
 * The registry's spelling is matched case-insensitively, as the Crossref branch of the not-found
 * text matches it. CNKI, ISTIC, and Airiti DOIs redirect to hosts that returned none — CNKI's to
 * the DOI's deposited landing page, a URL its registrant controls — so a DOI registered with an
 * agency not listed here is sent no citation request at all.
 */
const CSL_AGENCIES = new Set(['datacite', 'jalc', 'medra', 'kisti', 'op']);

/**
 * The CSL-JSON fields a citation reads. A string `title` is the one requirement: a body without
 * one is no citation. Any other field that arrives in another shape reads as absent rather than
 * costing the record its citation, since the agencies fill CSL unevenly — DataCite sends a null
 * `container-title`, JaLC no `type`, KISTI a name whose parts are both blank. Unread fields are
 * stripped.
 */
const CslNameSchema = z.object({
  given: z.string().optional().catch(undefined),
  family: z.string().optional().catch(undefined),
  literal: z.string().optional().catch(undefined),
});
const CslRecordSchema = z.object({
  title: z.string(),
  author: z.array(CslNameSchema).optional().catch(undefined),
  'container-title': z.string().optional().catch(undefined),
  issued: z
    .object({ 'date-parts': z.array(z.array(z.number().nullable())) })
    .optional()
    .catch(undefined),
  publisher: z.string().optional().catch(undefined),
  type: z.string().optional().catch(undefined),
});

/** A CSL-JSON record as doi.org serves it for a DOI another agency registered, as parsed. */
export type CslRecord = z.infer<typeof CslRecordSchema>;

/**
 * What the DOI registry says about an identifier Crossref has no record for: an agency holds
 * it (Crossref itself included), no agency has registered it, or no readable answer came back.
 * A DOI's lookup also carries the citation doi.org served for it, when the agency is one in
 * `CSL_AGENCIES` and the record was readable; a prefix's never does.
 */
export type RegistrationLookup =
  | { kind: 'registered'; agency: string; citation?: CslRecord }
  | { kind: 'unregistered' }
  | { kind: 'unknown' };

/**
 * One `CROSSREF_TIMEOUT_MS` window, combined with the caller's signal, shared by every request
 * made under it. Each Crossref attempt opens its own; a DOI's not-found lookup opens one for both
 * of its doi.org requests, so the citation request runs on what the registry request left.
 * Disposing it clears the timer.
 */
type Deadline = Disposable & {
  /** Aborts when the window closes or the caller cancels — the signal each request carries. */
  readonly signal: AbortSignal;
  /** Whether the window itself closed, as opposed to the caller cancelling. */
  expired(): boolean;
};

export class CrossrefService {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly userAgent: string;
  /**
   * What the DOI registry is told. The `mailto` is the operator's contact, given for Crossref's
   * polite pool; doi.org is a second party with no pool to admit anyone to, so it hears the
   * server and version and nothing else.
   */
  private readonly registryUserAgent = `crossref-mcp-server/${_packageVersion}`;

  constructor() {
    const cfg = getServerConfig();
    this.baseUrl = cfg.baseUrl;
    this.timeoutMs = cfg.timeoutMs;
    this.userAgent = cfg.mailto
      ? `${this.registryUserAgent} (mailto:${cfg.mailto})`
      : this.registryUserAgent;
  }

  /**
   * Retry boundary for a Crossref call. The default transient predicate is left in
   * place deliberately — the fix for "retries burned on a failure that can never
   * succeed" belongs one layer down, in `attempt()`, which returns every failure as an
   * `McpError` so the predicate classifies by error code. A custom predicate would only
   * re-sort the same unclassified exceptions by shape at the wrong layer. The same holds
   * for retry *cost*: the deadline-expiry opt-out sets `retryable: false` at its throw
   * site, which the stock predicate honors, so no budget arithmetic lives here.
   *
   * It is also where the request URL is recorded, which is why the whole retried call is
   * wrapped rather than returned straight through. The URL is both the field a Crossref
   * failure cannot be debugged without and the field that must not reach the caller:
   * `error.data` is forwarded as `structuredContent.error.data`, and `CROSSREF_BASE_URL`
   * is operator-configurable, so a deployment pointed at a private mirror would hand that
   * hostname — plus every query string this server builds — to every caller on every
   * failure. `ctx.log` is no refuge either, being dual-sink: a line written there ships to
   * the client as `notifications/message`. Only the Pino-only `logger` keeps the URL where
   * an operator can read it and a caller cannot.
   *
   * One line per failed call, after the retries rather than inside them, and none at all
   * for a caller cancellation — the caller hung up, which is nobody's upstream fault.
   */
  private async request<T>(path: string, ctx: Context): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    try {
      return await withRetry(
        async () => {
          using deadline = this.openDeadline(ctx);
          return await this.attempt<T>(url, this.userAgent, deadline, ctx);
        },
        { operation: 'CrossrefService.request', baseDelayMs: 1_000, signal: ctx.signal },
      );
    } catch (err) {
      if (!(err instanceof McpError && err.code === JsonRpcErrorCode.RequestCancelled)) {
        logger.warning('Crossref request failed', withExtra(ctx, { url, cause: causeOf(err) }));
      }
      throw err;
    }
  }

  /**
   * One attempt at a Crossref request. Every failure leaves here as an `McpError` with a
   * classified code and a recovery hint. `withRetry`'s default predicate treats any
   * non-`McpError` throw as transient and the framework's classifier reads the outer
   * error's constructor name, so an unwrapped throw is wrong twice over: a `SyntaxError`
   * from `JSON.parse` is retried to exhaustion and then surfaces as a caller
   * `ValidationError`, and a `TypeError` from `fetch` surfaces as an `InternalError`
   * — an upstream outage reported as a bug in this server.
   *
   * `userAgent` is passed rather than read off the instance because the requests that leave
   * Crossref must not carry the polite-pool `mailto` — see `registryUserAgent`. The window is
   * passed in for the same kind of reason: the registry lookup shares its window with the
   * citation request after it, while every Crossref attempt gets one of its own.
   */
  private async attempt<T>(
    url: string,
    userAgent: string,
    deadline: Deadline,
    ctx: Context,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(url, {
        signal: deadline.signal,
        headers: { 'User-Agent': userAgent },
      });
    } catch (err) {
      throw this.transportError(err, deadline.expired(), ctx);
    }

    if (!response.ok) throw await this.responseError(response);

    let text: string;
    try {
      // The window still covers the body read — a stalled stream is a timeout too.
      text = await response.text();
    } catch (err) {
      throw this.transportError(err, deadline.expired(), ctx);
    }

    if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
      throw upstreamError(
        UPSTREAM_UNAVAILABLE,
        'Crossref returned HTML instead of JSON — likely rate-limited or under maintenance.',
      );
    }

    // A 200 with nothing in it is a truncated or dropped response, not a corrupt
    // serialization: retrying can succeed, and `malformed_response`'s advice to ask
    // for a smaller record has nothing to act on. Tested with a scan rather than
    // `trim()`, which copies the whole body on every successful request to answer.
    if (!/\S/.test(text)) {
      throw upstreamError(UPSTREAM_UNAVAILABLE, 'Crossref returned HTTP 200 with an empty body.');
    }

    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw upstreamError(
        MALFORMED_RESPONSE,
        'Crossref returned HTTP 200 with a body that is not valid JSON.',
        { cause: err },
      );
    }
  }

  /** Open one timeout window, for the requests that are to share it — see `Deadline`. */
  private openDeadline(ctx: Context): Deadline {
    /**
     * An `AbortController` aborted with a `TimeoutError` DOMException rather than
     * `AbortSignal.timeout()`: the reason is then recognizable by identity in `expired`,
     * instead of by matching "timed out" in a message the runtime owns.
     */
    const timeout = new AbortController();
    const timeoutReason = new DOMException(
      `Crossref request timed out after ${this.timeoutMs}ms.`,
      'TimeoutError',
    );
    const timer = setTimeout(() => timeout.abort(timeoutReason), this.timeoutMs);
    return {
      signal: AbortSignal.any([ctx.signal, timeout.signal]),
      expired: () => timeout.signal.reason === timeoutReason,
      [Symbol.dispose]: () => clearTimeout(timer),
    };
  }

  /**
   * Classify a raw transport rejection. `timedOut` is decided by which signal fired, not
   * by the rejection value: `fetch` rejects with the abort *reason*, which may be any
   * value. The network path rejects with a `TypeError` whose message ("fetch failed")
   * says nothing — the real reason sits on `.cause`, which the framework's classifier
   * never reads.
   */
  private transportError(err: unknown, timedOut: boolean, ctx: Context): unknown {
    if (timedOut) {
      /**
       * Opted out of retry at the throw site rather than on the contract entry. A deadline
       * expiry is the one transient failure whose cost is set by this server's own clock
       * instead of by how fast the upstream answers, so each retry spends the full
       * `CROSSREF_TIMEOUT_MS` — four attempts plus backoff is ~47s of silence at the
       * default, past what an MCP client's own request budget usually allows, and the
       * recovery hint is then never read. 408 and 504 keep the full budget: they carry the
       * same reason but arrive at upstream speed, so retrying one costs nothing near the
       * deadline. The quantity that decides is which clock bounded the failure, not the code.
       */
      return upstreamError(
        REQUEST_TIMEOUT,
        `Crossref did not respond within ${this.timeoutMs}ms.`,
        {
          data: { timeoutMs: this.timeoutMs },
          retryable: false,
          cause: err,
        },
      );
    }
    // Caller cancellation, not an upstream failure — withRetry exits on an aborted signal.
    if (ctx.signal.aborted)
      return requestCancelled('Crossref request cancelled by caller.', undefined, { cause: err });
    return upstreamError(UPSTREAM_UNAVAILABLE, `Crossref could not be reached: ${causeOf(err)}`, {
      cause: err,
    });
  }

  /**
   * Convert a non-2xx response into a classified error carrying recovery.
   *
   * Crossref rejecting the request is the caller's to fix, and becomes a declared rejection
   * reason keyed on Crossref's own `type`: every 400, and the one 404 that is a rejection
   * rather than a missing record — a `cursor-invalid` body. Any other 404 passes through as
   * `httpErrorFromResponse` classified it, for the tool handlers to turn into their own typed
   * not-found reasons; the upstream statuses are re-classified onto the upstream contract.
   */
  private async responseError(response: Response): Promise<McpError> {
    if (response.status === 400) return crossrefRejection(await readRejected(response));
    if (response.status === 404) {
      const rejected = await readRejected(response);
      if (rejected?.some((entry) => entry.type === 'cursor-invalid')) {
        return crossrefRejection(rejected);
      }
    }

    const retryAfter = response.headers.get('retry-after');
    /**
     * Neither the URL nor the body reaches `error.data`, which is forwarded to the caller.
     * `includeUrl` is left at its default: the framework stopped putting `response.url` there
     * in 0.13.4, and this server's base URL is operator-set. `captureBody` is turned off: a
     * Crossref 5xx body is a Java exception with a stack excerpt, which tells the caller
     * nothing to do, and the status and message already say what failed. `request()` logs the
     * URL on the sink an operator reads.
     */
    const error = await httpErrorFromResponse(response, {
      service: 'Crossref',
      captureBody: false,
    });
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
   * Resolve a DOI prefix (e.g. "10.1038") to the member its prefix record names — the prefix's
   * registrant, which for a title transferred to another publisher is not the member holding
   * its DOIs now. Returns null on 404. Same 404→null pattern as getWork()/getMember().
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

  /**
   * Ask the DOI registry which registration agency holds a bare prefix (or a DOI) — read only
   * after Crossref has answered 404, to tell an identifier another agency registered from one
   * nobody did. One window of its own, the same per-request timeout every Crossref attempt
   * gets; see `readRegistry` for what it answers. A DOI's not-found lookup goes through
   * `getDoiRegistration` instead, which can also read the work's citation.
   */
  async getRegistrationAgency(id: string, ctx: Context): Promise<RegistrationLookup> {
    using deadline = this.openDeadline(ctx);
    return await this.readRegistry(id, deadline, ctx);
  }

  /**
   * Ask the DOI registry which agency holds a DOI Crossref has answered 404 for, and when that
   * agency is one in `CSL_AGENCIES`, read the work's citation from doi.org. Both requests share
   * one window opened as the registry request starts, so the not-found path still ends within
   * the Crossref 404 plus one `CROSSREF_TIMEOUT_MS`: the citation request runs on what the
   * registry request left, and a citation still outstanding when the window closes is given up.
   * A citation that cannot be read leaves the lookup exactly as it is without one.
   */
  async getDoiRegistration(doi: string, ctx: Context): Promise<RegistrationLookup> {
    using deadline = this.openDeadline(ctx);
    const lookup = await this.readRegistry(doi, deadline, ctx);
    if (lookup.kind !== 'registered' || !CSL_AGENCIES.has(lookup.agency.toLowerCase())) {
      return lookup;
    }
    const citation = await this.readCitation(doi, deadline, ctx);
    return citation ? { ...lookup, citation } : lookup;
  }

  /**
   * The registry's answer for one identifier, inside `deadline`. Best effort by design: one
   * attempt with no retry, and any failure to get a readable answer is `unknown`, which leaves
   * the caller's not-found text as it was. Caller cancellation is the one failure that is not
   * absorbed, and it is reworded here: `attempt` reports an abort as a cancelled Crossref
   * request, and this request did not go to Crossref.
   */
  private async readRegistry(
    id: string,
    deadline: Deadline,
    ctx: Context,
  ): Promise<RegistrationLookup> {
    let body: unknown;
    try {
      body = await this.attempt<unknown>(
        `${DOI_REGISTRY_URL}/${encodeURIComponent(id)}`,
        this.registryUserAgent,
        deadline,
        ctx,
      );
    } catch (err) {
      if (ctx.signal.aborted) {
        throw requestCancelled('DOI registry lookup cancelled by caller.', undefined, {
          cause: err,
        });
      }
      return { kind: 'unknown' };
    }
    const parsed = RegistryAnswerSchema.safeParse(body);
    if (!parsed.success) return { kind: 'unknown' };
    const [answer] = parsed.data;
    if (!('status' in answer)) return { kind: 'registered', agency: answer.RA };
    return answer.status === 'DOI does not exist' ? { kind: 'unregistered' } : { kind: 'unknown' };
  }

  /**
   * A DOI's citation, read from doi.org by content negotiation inside `deadline` — doi.org
   * redirects to the registering agency's metadata service, and `fetch` follows. One attempt,
   * no retry, no cache. The body is read only from a 200 in `CSL_MEDIA_TYPE` and is cancelled
   * unread otherwise; every outcome short of a CSL-JSON record with a string title — a failure
   * status, a timeout, a network error, another media type, a body that is not JSON or not a
   * record — is `undefined`. Caller cancellation alone is rethrown, worded for this request.
   */
  private async readCitation(
    doi: string,
    deadline: Deadline,
    ctx: Context,
  ): Promise<CslRecord | undefined> {
    try {
      const response = await fetch(`${DOI_RESOLVER_URL}/${encodeURIComponent(doi)}`, {
        signal: deadline.signal,
        headers: { 'User-Agent': this.registryUserAgent, Accept: CSL_MEDIA_TYPE },
      });
      const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim();
      if (response.status !== 200 || mediaType?.toLowerCase() !== CSL_MEDIA_TYPE) {
        await response.body?.cancel();
        return;
      }
      const parsed = CslRecordSchema.safeParse(JSON.parse(await response.text()));
      return parsed.success ? parsed.data : undefined;
    } catch (err) {
      if (ctx.signal.aborted) {
        throw requestCancelled('DOI citation lookup cancelled by caller.', undefined, {
          cause: err,
        });
      }
      return;
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
      assertIssnFilters(filterStr);
      params.set('filter', filterStr);
    }

    /**
     * select= on /works (search), never on /works/{doi}, which refuses the parameter.
     * crossref_search_works always names its fields — the caller's selection, or every name
     * its summary projects when there is none — so a page never carries whole records.
     *
     * DOI is force-included in every projection: it is the work summary's only
     * identifier and the sole key that chains into /works/{doi}, so a projection
     * that drops it yields records nothing downstream can resolve. Crossref's
     * select names are case-sensitive ("DOI" is valid, "doi" is rejected as
     * select-not-available), so the dedupe matches exactly. crossref_search_works
     * admits only the names its summary projects, so a miscased or unprojected
     * name is refused by the tool schema before it reaches here.
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

  /**
   * Fetch a page of a journal's works — every work deposited under any of `issns`, the ISSNs its
   * record lists — most recent first: by publication date on an offset page, by registration
   * date on a cursor walk. Read from `/works` with one `issn` filter pair per distinct ISSN
   * rather than from `/journals/{issn}/works`, which lists only the works of the one ISSN in its
   * path, and a journal's works are split across its ISSNs (BMJ's first of seven holds 5,514 of
   * its 456,306). `/works` pages that filter exactly as the sub-resource pages its ISSN: the same
   * offset order and 10,000 ceiling, the same cursor walk and tokens.
   *
   * Throws when no ISSN in `issns` is one Crossref can read: `/works` with no filter lists every
   * work in Crossref. A caller decides that case first, through `readableIssns`.
   */
  async getJournalWorks(
    issns: readonly string[],
    opts: WorksListOptions,
    ctx: Context,
  ): Promise<WorksSearchResult> {
    const readable = readableIssns(issns);
    if (readable.length === 0) {
      throw new Error(
        `getJournalWorks was given no ISSN Crossref can read (${JSON.stringify(issns)}), and /works without an issn filter lists every work.`,
      );
    }
    const params = worksListPageParams(opts);
    params.set('filter', readable.map((issn) => `issn:${issn}`).join(','));
    const envelope = await this.request<CrossrefListMessage<RawCrossrefWork>>(
      `/works?${params}`,
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
        `/funders/${encodeURIComponent(normalizeDoi(opts.funderDoi))}`,
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

  /**
   * Fetch a page of works for a specific funder by funder DOI/ID, most recent first — by
   * publication date on an offset page, by registration date on a cursor walk. Paged, ordered,
   * and selected the same way as `getJournalWorks`, so the two works lists agree.
   */
  async getFunderWorks(
    funderId: string,
    opts: WorksListOptions,
    ctx: Context,
  ): Promise<WorksSearchResult> {
    const id = normalizeDoi(funderId);
    const envelope = await this.request<CrossrefListMessage<RawCrossrefWork>>(
      `/funders/${encodeURIComponent(id)}/works?${worksListPageParams(opts)}`,
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

/** One input Crossref named in a rejection: its own `type` for the failure, and the value. */
type RejectedInput = { type: string; value: string; message: string };

/**
 * The entries of a Crossref rejection body — `{"message": [{type, value, message}, …]}`, the
 * shape both the 400 `validation-failure` and the 404 `resource-failure` bodies take — or
 * `undefined` when the body is anything else. Consumes the response body. `value` is the
 * rejected input as sent, or a parameter name (`"sort"`) when the rejection is about a
 * combination; the offset rejections carry it as a number.
 */
async function readRejected(response: Response): Promise<RejectedInput[] | undefined> {
  let body: unknown;
  try {
    body = JSON.parse(await response.text());
  } catch {
    return;
  }
  const entries = (body as { message?: unknown } | null)?.message;
  if (!Array.isArray(entries)) return;
  return entries.map((entry: { type?: unknown; value?: unknown; message?: unknown }) => ({
    type: String(entry?.type ?? ''),
    value: entry?.value == null ? '' : String(entry.value),
    message: typeof entry?.message === 'string' ? entry.message : '',
  }));
}

/** The reason each Crossref rejection `type` is declared under; anything else is `invalid_parameter`. */
const REJECTION_REASONS: Record<string, ErrorContract> = {
  'filter-not-available': UNKNOWN_FILTER,
  'sort-criteria-incompatible-with-cursor': SORT_CURSOR_CONFLICT,
  'cursor-invalid': INVALID_CURSOR,
};

/**
 * The hyphenated spelling of an underscored filter key, when Crossref lists it as a valid
 * filter for the route. The list rides the `filter-not-available` message; a key that only
 * hyphenates into another unknown key (`is_open_access`) gets no suggestion, since offering
 * one would send the caller to a second rejection.
 */
function filterSuggestion(rejected: RejectedInput): string | undefined {
  if (!rejected.value.includes('_')) return;
  const candidate = rejected.value.replace(/_/g, '-');
  const listed = /Valid filters for this route are:(.*)$/s.exec(rejected.message)?.[1];
  const valid = listed?.split(',').map((key) => key.trim());
  return valid?.includes(candidate) ? candidate : undefined;
}

/**
 * One rejected input, as a phrase: the value quoted, then Crossref's own statement of the form it
 * takes. An unknown filter drops Crossref's sentence, which is ninety-odd valid keys long, for the
 * suggestion that matters. No rejection here quotes a blank filter value — `crossref_search_works`
 * drops a blank value before the request is built.
 */
function describeRejected(rejected: RejectedInput): string {
  if (rejected.type === 'filter-not-available') {
    const suggestion = filterSuggestion(rejected);
    return `filter key "${rejected.value}" is not a Crossref filter${suggestion ? ` — did you mean "${suggestion}"?` : ''}`;
  }
  const subject = `"${rejected.value}"`;
  const detail = collapseWhitespace(rejected.message);
  return detail ? `${subject} — ${detail}` : subject;
}

/**
 * Crossref's rejection of the request as a declared reason. The reason follows the first
 * entry, `data.rejected` lists every one as `{type, value}`, and the message renders each in
 * turn. Nothing of the upstream response — body, status, URL — goes on `data`: the parsed
 * entries are the part a caller can act on. A body that did not parse is still the caller's
 * rejection, and lands on `invalid_parameter` with an empty `rejected`. Every key the message
 * suggests in place of a rejected one is declared a literal, the value the caller sends back.
 */
function crossrefRejection(rejected: RejectedInput[] | undefined): McpError {
  const first = rejected?.[0];
  if (!first) {
    return upstreamError(
      INVALID_PARAMETER,
      'Crossref rejected the request with HTTP 400 and no reason it could parse. Check that filter keys are hyphenated and that each filter value has the form its key takes.',
      { data: { rejected: [] } },
    );
  }
  const entry = REJECTION_REASONS[first.type] ?? INVALID_PARAMETER;
  const suggestion = first.type === 'filter-not-available' ? filterSuggestion(first) : undefined;
  const suggested = rejected
    .filter((input) => input.type === 'filter-not-available')
    .map(filterSuggestion)
    .filter((key) => key !== undefined);
  return upstreamError(
    entry,
    `Crossref rejected the request: ${rejected.map(describeRejected).join('; ')}`,
    {
      data: {
        rejected: rejected.map(({ type, value }) => ({ type, value })),
        ...(suggestion !== undefined && { suggestion }),
      },
      literals: suggested,
    },
  );
}

/**
 * How Crossref reads an `issn` filter value: it keeps only the digits and `X`s, then takes the
 * first run of seven digits and a check character. So it is lenient about separators —
 * `0028–0836`, `0028 0836`, and `ISSN 0028-0836` all resolve to the same journal — and reads
 * `0028-08361` as `0028-0836`. A value with no such run is the one it cannot read.
 */
const NOT_ISSN_CHARACTER = /[^\dX]/gi;
const ISSN_RUN = /\d{7}[\dX]/i;

/**
 * Refuse an `issn` filter value Crossref cannot read, before the request. Crossref answers one
 * with HTTP 500 and a Java exception rather than a validation failure, which would classify as
 * an outage, be retried, and tell the caller to resend the query unchanged — the one move that
 * cannot work. Everything Crossref does read goes through as written.
 *
 * The check walks the serialized filter string the way Crossref splits it, one `key:value` pair
 * per comma, so it sees what Crossref sees: an `issn:` pair written inside another value
 * (`0028-0836,issn:1476-4687`, which Crossref reads as two ISSNs) is checked on its own.
 */
function assertIssnFilters(filterStr: string): void {
  for (const pair of filterStr.split(',')) {
    if (!pair.startsWith('issn:')) continue;
    const value = pair.slice('issn:'.length);
    if (ISSN_RUN.test(value.replace(NOT_ISSN_CHARACTER, ''))) continue;
    const subject =
      value.trim() === '' ? 'filter "issn" was sent blank' : `filter "issn" value "${value}"`;
    throw upstreamError(
      INVALID_PARAMETER,
      `${subject} is not an ISSN — the issn filter takes NNNN-NNNX: four digits, three digits, then a check digit or X, the hyphen optional.`,
      {
        data: { rejected: [{ type: 'issn-not-valid', value }] },
        hint: 'Pass the issn filter one ISSN in NNNN-NNNX form, for example {"issn":"0028-0836"}; crossref_search_journals lists the ISSNs a journal is registered under.',
      },
    );
  }
}

/**
 * The distinct ISSNs Crossref reads from `values`, in first-seen order, each the run
 * `ISSN_RUN` finds written as `NNNN-NNNX`; a value with no run is left out. The values are a
 * journal record's ISSNs headed for an `issn` filter, which Crossref splits on commas with no
 * escape, so writing each as the one ISSN read from it is what keeps a value carrying
 * `,from-pub-date:…` or `,issn:…` from adding a pair of its own.
 *
 * Exported for `crossref_search_journals`, which decides by the same rule whether a matched
 * journal has a works list to look up at all: a record whose every ISSN entry yields nothing
 * here has none, exactly as a record listing no ISSN.
 */
export function readableIssns(values: readonly string[]): string[] {
  const issns = new Set<string>();
  for (const value of values) {
    const run = ISSN_RUN.exec(value.replace(NOT_ISSN_CHARACTER, ''))?.[0].toUpperCase();
    if (run) issns.add(`${run.slice(0, 4)}-${run.slice(4)}`);
  }
  return [...issns];
}

/**
 * The select names the journal and funder works-list summaries read: `DOI`, `title`, `type`, the
 * three date sources `published` is resolved from, and `is-referenced-by-count`. Both lists
 * project the same summary (`crossref_search_journals` `recentWorks`, `crossref_search_funders`
 * `fundedWorks`), so one list serves both. A raw key either projection starts reading joins this
 * list in the same change, or it reads as absent on every record — the projection tests cut full
 * records to this list and compare.
 *
 * Without a selection Crossref returns whole records, reference lists included: a 1000-row NSF
 * works page is 23.3 MB upstream, 0.29 MB under this one, for identical output.
 */
const WORKS_LIST_SELECT = [
  'DOI',
  'title',
  'type',
  'published',
  'published-print',
  'published-online',
  'is-referenced-by-count',
].join(',');

/**
 * The query string for one page of the journal or funder works list — `/works` filtered on a
 * journal's ISSNs, or `/funders/{id}/works`. Cursor and offset are mutually exclusive upstream,
 * so only one is ever written — the same precedence `searchWorks` uses — and an offset of 0 is
 * the start of the list, left off the query string entirely. Every page names
 * `WORKS_LIST_SELECT`, on a cursor walk as on an offset page.
 *
 * Both modes read newest first, by different dates. An offset page sorts by publication date.
 * A cursor walk cannot: Crossref refuses every publication-date sort alongside a cursor
 * (`sort-criteria-incompatible-with-cursor`), and a walk with no sort runs oldest-registered
 * first, which would put decades-old works at the head of a "most recent" list. So a walk sorts
 * by `created` — the date the DOI was first registered — which Crossref walks by cursor and
 * which never changes under a record, so a walk cannot reorder mid-way.
 */
function worksListPageParams(opts: WorksListOptions): URLSearchParams {
  const params = new URLSearchParams({ rows: String(opts.rows) });
  if (opts.cursor) {
    params.set('cursor', opts.cursor);
    params.set('sort', 'created');
  } else {
    if (opts.offset != null && opts.offset > 0) params.set('offset', String(opts.offset));
    params.set('sort', 'published');
  }
  params.set('order', 'desc');
  params.set('select', WORKS_LIST_SELECT);
  return params;
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
    logger.warning(
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
