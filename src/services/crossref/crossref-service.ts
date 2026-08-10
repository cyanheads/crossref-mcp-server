/**
 * @fileoverview CrossrefService wraps the Crossref REST API with polite-pool User-Agent injection,
 * per-request timeout, retry with exponential backoff, and pagination helpers. Offset paging is
 * honored on the name-search and works sub-resource routes, whose ceilings differ by an order of
 * magnitude — see NAME_SEARCH_OFFSET_CAP and WORKS_OFFSET_CAP. Cursor paging has no ceiling and
 * is available on `/works` and on both works sub-resources.
 *
 * Also home to the text normalization every tool projects free-text values through —
 * `normalizeText` for the baseline pass, `normalizeMarkupText` for the JATS-deposited fields,
 * and `normalizeReferenceText` for the deposited citation strings, where an angle bracket is
 * as likely to be content as markup and a tag is recognized by its shape, by sitting inside a
 * markup region, or by an element-name allow-list — see `stripReferenceMarkup` for the rule.
 * All three end in the same baseline: character references decoded against the HTML5 named
 * set in `html-entities`, then whitespace collapsed.
 * @module services/crossref/crossref-service
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError, validationError } from '@cyanheads/mcp-ts-core/errors';
import { httpErrorFromResponse, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { decodeHtmlEntities } from './html-entities.js';
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

/**
 * Collapse every run of whitespace to a single space and trim. Any run, not runs of two or
 * more: a lone newline inside a deposited string is enough to split a Markdown heading in
 * `content[]` and turn the indented continuation into a code block.
 */
function collapseWhitespace(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/**
 * Subscript and superscript tags, with or without a namespace prefix (`<jats:sub>`) or
 * attributes. `\b` after the name keeps `<subject>` and `<supplementary-material>` out.
 */
const TIGHT_TAG = /<\/?(?:[A-Za-z][\w.-]*:)?su[bp]\b[^>]*>/gi;

/**
 * Strip JATS XML tags from a deposited string, collapsing the whitespace they leave behind.
 *
 * A tag is a word boundary and becomes a space — that separator is what keeps adjacent JATS
 * paragraphs in an abstract from running together. Subscripts and superscripts are the
 * exception: their content continues the token around them, so `CO<sub>2</sub>` is one
 * formula and a space there splits it. Those come out with no separator; every other tag
 * still yields one.
 */
export function stripJats(raw: string): string {
  return collapseWhitespace(raw.replace(TIGHT_TAG, '').replace(/<[^>]+>/g, ' '));
}

/**
 * Normalize a human-readable upstream string for output: decode character references,
 * collapse whitespace, trim.
 *
 * This is the baseline every free-text value this server projects from a Crossref record
 * passes through — work and journal titles, publisher and funder and member names,
 * affiliations, subjects, reference text. Identifiers and machine-format values (DOIs, URIs,
 * ISSNs, prefixes, dates, work types, coverage categories) are projected byte-exact and never
 * come through here.
 *
 * The decode runs before the collapse, so a reference naming a whitespace character —
 * `&#10;`, `&nbsp;` — folds into the surrounding run rather than reaching `content[]` as a
 * line break that splits the Markdown around it.
 */
export function normalizeText(raw: string): string {
  return collapseWhitespace(decodeHtmlEntities(raw));
}

/**
 * Normalize a field publishers deposit as JATS/XML markup — work titles, subtitles, container
 * titles, and abstracts — by stripping inline tags before the baseline pass.
 *
 * Order matters: tags come out before entities are decoded, so a deposited `&lt;i&gt;` stays
 * literal text instead of decoding into a tag the strip pass would then eat.
 */
export function normalizeMarkupText(raw: string): string {
  return normalizeText(stripJats(raw));
}

/**
 * The attribute tail of a well-formed tag: zero or more `name="value"` pairs, quoted or bare.
 * Requiring the `=` is what separates a tag from a bracketed phrase that merely opens with an
 * element name. `<Stack Overflow, https://…>`, `<Available from: http://…>`, and `<The Internet
 * Movie DataBase, http://…>` are all text a reader needs, and all three read as a tag under a
 * looser `<name\b[^>]*>`.
 */
const TAG_ATTRIBUTES = String.raw`(?:\s+[A-Za-z_:][\w.:-]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))*\s*`;

/**
 * Build a tag matcher over a closed set of element names. Namespace prefixes (`<jats:italic>`)
 * and attributes (`<p class="Reference">`) are admitted; a space after `<` is not, so an
 * inequality written `0.01 < x > 0.8` can never read as a tag. `\b` after the name keeps a
 * longer element out — `<subject>` is not `<sub>`, `<smallcaps>` is not `<small>`.
 */
function tagSource(names: readonly string[]): string {
  return String.raw`<\/?(?:[A-Za-z][\w.-]*:)?(?:${names.join('|')})\b${TAG_ATTRIBUTES}\/?>`;
}

/** Elements whose value lives in an attribute. Never stripped — anywhere, at any nesting. */
const LINK_ELEMENTS = ['ext-link', 'uri', 'a'];

/**
 * Inline emphasis in the HTML, JATS, and Springer spellings, plus the JATS citation fields
 * publishers deposit bare into an otherwise typed citation string.
 */
const INLINE_ELEMENTS = [
  'article-title',
  'given-names',
  'person-group',
  'string-name',
  'surname',
  'italic',
  'strong',
  'collab',
  'small',
  'bold',
  'fname',
  'span',
  'etal',
  'scp',
  'em',
  'sc',
  'i',
  'b',
  'u',
];

/** Block boundaries. A publisher packing several citations into one field separates them here. */
const BLOCK_ELEMENTS = ['disp-formula', 'br', 'p'];

/**
 * Scripts and inline formula wrappers: their content continues the token around them, and the
 * wrapper itself carries nothing the text does not — `<tex Notation="TeX">$\hbox{1}/f$</tex>`
 * reads as the TeX it wraps.
 */
const TIGHT_ELEMENTS = [
  'inline-formula',
  'ref_formula',
  'superscript',
  'subscript',
  'tex-math',
  'formula',
  'stack',
  'sub',
  'sup',
  'inf',
  'tex',
];

const INLINE_MARKUP_TAG = new RegExp(`(?:${tagSource(INLINE_ELEMENTS)})+`, 'gi');
const BLOCK_MARKUP_TAG = new RegExp(tagSource(BLOCK_ELEMENTS), 'gi');
const TIGHT_MARKUP_TAG = new RegExp(tagSource(TIGHT_ELEMENTS), 'gi');

/**
 * A whole MathML formula, matched end to end so a strip can never half-consume one. Its inner
 * tags come out tight, so `<msub><mi>Airy</mi><mn>2</mn></msub>` reads as `Airy2` — removing
 * the region outright would delete the symbol the sentence is about.
 */
const MATHML_SPAN =
  /<(?:[A-Za-z][\w.-]*:)?math\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z][\w.-]*:)?math\s*>/gi;

/**
 * A JATS structured citation deposited whole into a free-text field, matched end to end the
 * way a MathML formula is. Inside one, every bracket is a tag by construction — nobody types
 * a Miller index inside `<mixed-citation>` — so the name-by-name allow-list does not apply
 * there and the whole vocabulary comes out, however it is spelled.
 */
const CITATION_ELEMENTS = ['mixed-citation', 'element-citation', 'nlm-citation', 'citation'];
const CITATION_SPAN = new RegExp(
  String.raw`<(?:[A-Za-z][\w.-]*:)?(?:${CITATION_ELEMENTS.join('|')})\b${TAG_ATTRIBUTES}>([\s\S]*?)<\/(?:[A-Za-z][\w.-]*:)?(?:${CITATION_ELEMENTS.join('|')})\s*>`,
  'gi',
);

/**
 * Every tag inside a citation envelope that is not a link and not already spoken for by the
 * tight or block class. Runs merge so two abutting tags are one boundary, the same way the
 * inline matcher merges them.
 */
const CITATION_INNER_TAG = new RegExp(
  String.raw`(?:<\/?(?!(?:[A-Za-z][\w.-]*:)?(?:${[...LINK_ELEMENTS, ...TIGHT_ELEMENTS, ...BLOCK_ELEMENTS].join('|')})\b)(?:[A-Za-z][\w.-]*:)?[A-Za-z][\w.-]*\b${TAG_ATTRIBUTES}\/?>)+`,
  'gi',
);

/** Letters and digits in any script — Latin, CJK, Greek — not just ASCII `\w`. */
const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * A word boundary leaves a space only where it separates two word characters, so an italic
 * journal title followed by a comma closes up instead of gaining a stray space before it.
 */
function separateWords(run: string, offset: number, whole: string): string {
  const before = whole[offset - 1];
  const after = whole[offset + run.length];
  return before && after && WORD_CHAR.test(before) && WORD_CHAR.test(after) ? ' ' : '';
}

/** Empty a citation envelope of its markup, links excepted, on the outer separator classes. */
function stripCitationMarkup(inner: string): string {
  return inner
    .replace(CITATION_INNER_TAG, separateWords)
    .replace(TIGHT_MARKUP_TAG, '')
    .replace(BLOCK_MARKUP_TAG, ' ');
}

/**
 * Strip the formatting markup a reference free-text field carries, and nothing else.
 *
 * The rule resolves an ambiguity the other normalization passes do not have. A work title is
 * deposited as JATS and every bracket in it is a tag; a reference entry is a citation string a
 * publisher typed, where a bracket carries a cited URL (`<http://faostat.fao.org/…>`), a Miller
 * index (`Silicon <100> nanowires`), a DOI fragment (`<131::AID-QUA4>`), an acronym (`<IR>`), or
 * a guillemet quotation (`<<ruptures>>`) about as often as it carries a tag. Deleting any of
 * those is a worse failure than leaving one tag in place, so the line falls here:
 *
 * 1. A bracket is a tag only if it is **well formed** — the name follows `<` with no space, and
 *    the attribute tail is `name="value"` pairs rather than prose.
 * 2. A whole **markup region** — a MathML formula, a JATS structured citation — is matched end
 *    to end and emptied of tags, because inside one there is no typed bracket to protect.
 *    All or nothing: an unclosed region matches nothing and is left whole.
 * 3. Everywhere else a well-formed tag comes out only if its **element name is on the
 *    allow-list**, which admits a name on two tests: nothing of the element's value lives in an
 *    attribute, and the name is a markup-only token rather than an ordinary word. Link elements
 *    fail the first — an `<a href>` stripped of its tag has lost its address. `volume`, `year`,
 *    `source`, `comment`, and the rest of the bare-word JATS vocabulary fail the second, since a
 *    bracketed ordinary word is how a person writes a quotation or a note; they come out inside
 *    a citation envelope, where rule 2 has already settled that nothing there was typed.
 *
 * Three separator classes, by what the element means for the text around it:
 * - Scripts and inline formula wrappers leave nothing — `O<sub>2</sub>` is one formula and a
 *   space there splits it, and `T<inf>c</inf>` is one symbol.
 * - Inline emphasis and the inline citation fields are a word boundary and leave a space only
 *   between two word characters, so `<i>Ann. Probab.</i>, 49` closes up to `Ann. Probab., 49`.
 * - Block elements always leave a space: `…revision.</p><p>Smith, J.…` is two citations packed
 *   into one field, and they must not run together.
 *
 * Every separator is decided against the string as deposited, which is why the inline pass runs
 * before the tight one: a tag never counts as a word character, and removing a script must not
 * create an adjacency the inline rule then reads as two words —
 * `<span class="smallcaps">xvii</span><sup>e</sup>` is `xviie`, not `xvii e`.
 */
export function stripReferenceMarkup(raw: string): string {
  return raw
    .replace(MATHML_SPAN, (_, inner: string) => inner.replace(/<[^>]*>/g, ''))
    .replace(CITATION_SPAN, (_, inner: string) => stripCitationMarkup(inner))
    .replace(INLINE_MARKUP_TAG, separateWords)
    .replace(TIGHT_MARKUP_TAG, '')
    .replace(BLOCK_MARKUP_TAG, ' ');
}

/**
 * Normalize a reference entry's free text: strip formatting markup, then the baseline pass.
 *
 * Separate from `normalizeMarkupText` because the two fields are not the same surface. A work
 * title is deposited as JATS and every tag in it is markup, so a blanket strip is right there.
 * A reference entry is a citation string a publisher typed, and the same syntax carries both
 * markup and content — hence the bounded rule above. Order matches: markup comes out before
 * entities are decoded, so a deposited `&lt;i&gt;` stays literal.
 */
export function normalizeReferenceText(raw: string): string {
  return normalizeText(stripReferenceMarkup(raw));
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

/**
 * Paging options for the `/journals/{issn}/works` and `/funders/{id}/works` sub-resources.
 * `cursor` and `offset` are alternatives, not a pair — Crossref rejects the combination with
 * `cursor-with-offset-or-sample`, so `cursor` wins here and callers validate ahead of the call.
 */
export type SubResourceWorksOptions = {
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
 * The `/journals/{issn}/works` and `/funders/{id}/works` sub-resources cap ten times lower —
 * `offset + rows <= 10000` — and their rejection body directs callers to cursor paging. It is a
 * ceiling on the `offset` input alone: both routes accept `cursor=*` and return a `next-cursor`
 * token, which the tools thread as `works_cursor` / `nextWorksCursor` to read past it.
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
   * re-sort the same unclassified exceptions by shape at the wrong layer. The same holds
   * for retry *cost*: the deadline-expiry opt-out sets `retryable: false` at its throw
   * site, which the stock predicate honors, so no budget arithmetic lives here.
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
          data: { url, timeoutMs: this.timeoutMs },
          retryable: false,
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
    setSubResourcePage(params, opts);
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
    setSubResourcePage(params, opts);
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

/**
 * Apply the page selector for a works sub-resource. Cursor and offset are mutually exclusive
 * upstream, so only one is ever written — the same precedence `searchWorks` uses on `/works`.
 * An offset of 0 is the start of the list and is left off the query string entirely.
 */
function setSubResourcePage(params: URLSearchParams, opts: SubResourceWorksOptions): void {
  if (opts.cursor) {
    params.set('cursor', opts.cursor);
  } else if (opts.offset != null && opts.offset > 0) {
    params.set('offset', String(opts.offset));
  }
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
