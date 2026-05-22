/**
 * @fileoverview CrossrefService wraps the Crossref REST API with polite-pool User-Agent injection,
 * per-request timeout, retry with exponential backoff, and pagination helpers.
 * @module services/crossref/crossref-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { httpErrorFromResponse, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import type {
  CrossrefListMessage,
  CrossrefSingleMessage,
  RawCrossrefFunder,
  RawCrossrefJournal,
  RawCrossrefWork,
} from './types.js';

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
  private readonly userAgent: string;

  constructor() {
    const cfg = getServerConfig();
    this.baseUrl = cfg.baseUrl;
    this.userAgent = cfg.mailto
      ? `crossref-mcp-server/0.1.1 (mailto:${cfg.mailto})`
      : 'crossref-mcp-server/0.1.1';
  }

  private request<T>(path: string, ctx: Context): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const userAgent = this.userAgent;
    return withRetry(
      async () => {
        const response = await fetch(url, {
          signal: ctx.signal,
          headers: { 'User-Agent': userAgent },
        });
        if (!response.ok) {
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
      // withRetry surfaces non-retryable errors immediately.
      if (err instanceof Error && 'code' in err && (err as { code?: number }).code === -32001) {
        return null;
      }
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
      const id = opts.funderDoi.replace(/^https?:\/\/dx\.doi\.org\//i, '').replace(/^doi:/i, '');
      const envelope = await this.request<CrossrefSingleMessage<RawCrossrefFunder>>(
        `/funders/${encodeURIComponent(id)}`,
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
    const id = funderId.replace(/^https?:\/\/dx\.doi\.org\//i, '').replace(/^doi:/i, '');
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
}

export function getCrossrefService(): CrossrefService {
  if (!_service) {
    throw new Error('CrossrefService not initialized — call initCrossrefService() in setup()');
  }
  return _service;
}
