/**
 * @fileoverview CrossrefService wraps the Crossref REST API with polite-pool User-Agent injection,
 * per-request timeout, retry with exponential backoff, and pagination helpers.
 * @module services/crossref/crossref-service
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Context } from '@cyanheads/mcp-ts-core';
import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { httpErrorFromResponse, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import type {
  CrossrefListMessage,
  CrossrefSingleMessage,
  RawCrossrefFunder,
  RawCrossrefJournal,
  RawCrossrefWork,
} from './types.js';

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
function normalizeFunderId(raw: string): string {
  return raw.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:/i, '');
}

/** Crossref works search options. */
export type WorksSearchOptions = {
  query?: string;
  filter?: Record<string, string>;
  fields?: string[];
  rows?: number;
  offset?: number;
  cursor?: string;
  sort?: string;
  order?: string;
};

/** Crossref journals search options. */
export type JournalsSearchOptions = {
  query?: string;
  issn?: string;
  rows?: number;
};

/** Crossref funders search options. */
export type FundersSearchOptions = {
  query?: string;
  funderDoi?: string;
  rows?: number;
};

/** Result of a works search, including pagination metadata. */
export type WorksSearchResult = {
  totalResults: number;
  itemsPerPage: number;
  nextCursor?: string | undefined;
  items: RawCrossrefWork[];
};

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

  private request<T>(path: string, ctx: Context): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    return withRetry(
      async () => {
        const deadline = AbortSignal.timeout(this.timeoutMs);
        const signal = AbortSignal.any([ctx.signal, deadline]);
        const response = await fetch(url, {
          signal,
          headers: { 'User-Agent': this.userAgent },
        });
        if (!response.ok) {
          if (response.status === 400) {
            // Crossref returns a structured validation-failure body on 400.
            // Parse it and surface an actionable message instead of leaking the raw body.
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
              // fall through to generic message
            }
            const { validationError } = await import('@cyanheads/mcp-ts-core/errors');
            throw validationError(
              detail
                ? `Crossref rejected the request: ${detail}`
                : 'Crossref returned HTTP 400 Bad Request — check filter key names (use hyphens, not underscores) and field names.',
            );
          }
          throw await httpErrorFromResponse(response, { service: 'Crossref', data: { url } });
        }
        const text = await response.text();
        if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
          const { serviceUnavailable } = await import('@cyanheads/mcp-ts-core/errors');
          throw serviceUnavailable(
            'Crossref returned HTML instead of JSON — likely rate-limited or under maintenance.',
            { url },
          );
        }
        return JSON.parse(text) as T;
      },
      { operation: 'CrossrefService.request', baseDelayMs: 1_000, signal: ctx.signal },
    );
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
      // httpErrorFromResponse maps 404 → McpError(NotFound, code = -32001).
      if (err instanceof McpError && err.code === -32001) return null;
      throw err;
    }
  }

  /** Search works with filter, field selection, and cursor/offset pagination. */
  async searchWorks(opts: WorksSearchOptions, ctx: Context): Promise<WorksSearchResult> {
    const params = new URLSearchParams();
    if (opts.query) params.set('query', opts.query);
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

    // select= only on /works (search), never on /works/{doi}
    if (opts.fields && opts.fields.length > 0) {
      params.set('select', opts.fields.join(','));
    }

    const qs = params.toString();
    const envelope = await this.request<CrossrefListMessage<RawCrossrefWork>>(
      `/works${qs ? `?${qs}` : ''}`,
      ctx,
    );
    return toWorksSearchResult(envelope.message);
  }

  /** Search journals by query or fetch one by ISSN. */
  async searchJournals(opts: JournalsSearchOptions, ctx: Context): Promise<RawCrossrefJournal[]> {
    if (opts.issn) {
      const envelope = await this.request<CrossrefSingleMessage<RawCrossrefJournal>>(
        `/journals/${encodeURIComponent(opts.issn)}`,
        ctx,
      );
      return [envelope.message];
    }
    const params = new URLSearchParams();
    if (opts.query) params.set('query', opts.query);
    if (opts.rows != null) params.set('rows', String(opts.rows));
    const qs = params.toString();
    const envelope = await this.request<CrossrefListMessage<RawCrossrefJournal>>(
      `/journals${qs ? `?${qs}` : ''}`,
      ctx,
    );
    return envelope.message.items;
  }

  /** Fetch works for a specific journal by ISSN. */
  async getJournalWorks(issn: string, rows: number, ctx: Context): Promise<WorksSearchResult> {
    const params = new URLSearchParams({ rows: String(rows) });
    const envelope = await this.request<CrossrefListMessage<RawCrossrefWork>>(
      `/journals/${encodeURIComponent(issn)}/works?${params}`,
      ctx,
    );
    return toWorksSearchResult(envelope.message);
  }

  /** Search funders by query or fetch one by funder DOI. */
  async searchFunders(opts: FundersSearchOptions, ctx: Context): Promise<RawCrossrefFunder[]> {
    if (opts.funderDoi) {
      const envelope = await this.request<CrossrefSingleMessage<RawCrossrefFunder>>(
        `/funders/${encodeURIComponent(normalizeFunderId(opts.funderDoi))}`,
        ctx,
      );
      return [envelope.message];
    }
    const params = new URLSearchParams();
    if (opts.query) params.set('query', opts.query);
    if (opts.rows != null) params.set('rows', String(opts.rows));
    const qs = params.toString();
    const envelope = await this.request<CrossrefListMessage<RawCrossrefFunder>>(
      `/funders${qs ? `?${qs}` : ''}`,
      ctx,
    );
    return envelope.message.items;
  }

  /** Fetch works for a specific funder by funder DOI/ID. */
  async getFunderWorks(funderId: string, rows: number, ctx: Context): Promise<WorksSearchResult> {
    const id = normalizeFunderId(funderId);
    const params = new URLSearchParams({ rows: String(rows) });
    const envelope = await this.request<CrossrefListMessage<RawCrossrefWork>>(
      `/funders/${encodeURIComponent(id)}/works?${params}`,
      ctx,
    );
    return toWorksSearchResult(envelope.message);
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
