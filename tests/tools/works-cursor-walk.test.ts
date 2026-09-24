/**
 * @fileoverview A `works_cursor` walk of the journal and funder works lists, run end to end:
 * the real tool definitions and the real `CrossrefService` against a fetch fake that answers
 * the way Crossref does — including refusing a publication-date sort alongside a cursor. The
 * tool tests stub the service, so the query string a walk actually sends is only visible here.
 * @module tests/tools/works-cursor-walk.test
 */

import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { blockText } from '../helpers/content.js';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn().mockReturnValue({
    mailto: 'test@example.com',
    baseUrl: 'https://api.crossref.test',
    timeoutMs: 10_000,
  }),
}));

import { searchFundersTool, searchJournalsTool } from '@/mcp-server/tools/definitions/index.js';
import { initCrossrefService } from '@/services/crossref/crossref-service.js';

type ToolResult = Awaited<ReturnType<typeof runToolContract>>;

/** The sorts Crossref refuses to walk by cursor. */
const DATE_SORTS = new Set(['issued', 'published', 'published-print', 'published-online']);

/** Three pages of a works list: two full ones, then the empty page past the end. */
const PAGES: Record<string, { dois: string[]; next?: string }> = {
  '*': { dois: ['10.5555/w1', '10.5555/w2'], next: 'MTc5MDE4MzAxMDAwMCwxMC41NTU1L3cy' },
  MTc5MDE4MzAxMDAwMCwxMC41NTU1L3cy: {
    dois: ['10.5555/w3', '10.5555/w4'],
    next: 'MTc5MDE4MjAwMDAwMCwxMC41NTU1L3c0',
  },
  MTc5MDE4MjAwMDAwMCwxMC41NTU1L3c0: { dois: [] },
};

/** Answer a works sub-resource request the way Crossref does. */
function worksPage(request: Request): Response {
  const qs = new URL(request.url).searchParams;
  const cursor = qs.get('cursor');
  const sort = qs.get('sort');
  if (cursor !== null && sort !== null && DATE_SORTS.has(sort)) {
    return Response.json(
      {
        status: 'failed',
        'message-type': 'validation-failure',
        message: [
          {
            type: 'sort-criteria-incompatible-with-cursor',
            value: 'sort',
            message:
              'Sorting by [issued, published, published-print, published-online] is not supported when using a cursor',
          },
        ],
      },
      { status: 400 },
    );
  }
  const page = cursor === null ? undefined : PAGES[cursor];
  if (!page) return new Response('Resource not found.', { status: 404 });
  return Response.json({
    status: 'ok',
    'message-type': 'work-list',
    message: {
      'total-results': 4,
      'items-per-page': 2,
      items: page.dois.map((DOI) => ({ DOI, type: 'journal-article', title: [DOI] })),
      ...(page.next !== undefined && { 'next-cursor': page.next }),
    },
  });
}

const http = createFetchMock();

beforeEach(() => {
  http.reset();
  http.install();
  initCrossrefService();
});

afterEach(() => {
  http.restore();
});

function textOf(result: ToolResult): string {
  return result.content.map(blockText).join('\n');
}

const SUB_RESOURCES = [
  {
    name: 'crossref_search_journals',
    definition: searchJournalsTool,
    input: { issn: '0028-0836', include_works: true, rows: 2 },
    worksRoute: /\/journals\/0028-0836\/works\?/,
    recordRoute: /\/journals\/0028-0836$/,
    record: { title: 'Nature', 'ISSN-L': '0028-0836', ISSN: ['0028-0836'] },
    worksKey: 'recentWorks',
  },
  {
    name: 'crossref_search_funders',
    definition: searchFundersTool,
    input: { funder_doi: '100000001', include_works: true, rows: 2 },
    worksRoute: /\/funders\/100000001\/works\?/,
    recordRoute: /\/funders\/100000001$/,
    record: { id: '100000001', name: 'National Science Foundation' },
    worksKey: 'fundedWorks',
  },
] as const;

describe.each(SUB_RESOURCES)('a works_cursor walk on $name', (target) => {
  beforeEach(() => {
    http.route({ match: target.worksRoute, respond: worksPage });
    http.route({
      match: target.recordRoute,
      respond: () =>
        Response.json({ status: 'ok', 'message-type': 'record', message: target.record }),
    });
  });

  /** One page of the walk, with the parts of the response a caller chains on. */
  async function page(worksCursor: string) {
    const result = await runToolContract(target.definition, {
      ...target.input,
      works_cursor: worksCursor,
    });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Record<string, unknown>;
    const works = (structured[target.worksKey] as Array<{ doi: string }> | undefined) ?? [];
    return {
      dois: works.map((w) => w.doi),
      next: structured.nextWorksCursor as string | undefined,
      text: textOf(result),
    };
  }

  /** The works requests the walk sent, in order. */
  function worksRequests(): URLSearchParams[] {
    return http.calls
      .map((call) => new URL(call.request.url))
      .filter((url) => target.worksRoute.test(url.href))
      .map((url) => url.searchParams);
  }

  it('walks two pages deep by chaining the returned token, then ends on the empty page', async () => {
    const first = await page('*');
    expect(first.dois).toEqual(['10.5555/w1', '10.5555/w2']);
    expect(first.next).toBe(PAGES['*']?.next);
    // The token rides content[] too, so a content-only client can chain it.
    expect(first.text).toContain(first.next);

    const second = await page(first.next ?? '');
    expect(second.dois).toEqual(['10.5555/w3', '10.5555/w4']);
    expect(second.dois.some((doi) => first.dois.includes(doi))).toBe(false);
    expect(second.next).toBeDefined();
    expect(second.next).not.toBe(first.next);
    expect(second.text).toContain(second.next);

    const last = await page(second.next ?? '');
    expect(last.dois).toEqual([]);
    expect(last.next).toBeUndefined();

    expect(worksRequests().map((qs) => qs.get('cursor'))).toEqual(['*', first.next, second.next]);
  });

  it('orders every cursor request by registration date, newest first', async () => {
    const first = await page('*');
    await page(first.next ?? '');

    const requests = worksRequests();
    expect(requests).toHaveLength(2);
    for (const qs of requests) {
      expect(qs.getAll('sort')).toEqual(['created']);
      expect(qs.get('order')).toBe('desc');
      expect(qs.get('offset')).toBeNull();
    }
  });
});
