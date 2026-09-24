/**
 * @fileoverview Empty pages on the three search tools, asserted on the assembled `CallToolResult`
 * a client receives. A page with no records renders nothing of its own, so the enrichment trailer
 * — the counts plus the notice naming which empty-page cause applies — leads `content[]`, and the
 * notice appears there exactly once. The tools run against the real `CrossrefService` behind a
 * fetch fake, so the notice path and the formatter are both the production code.
 * @module tests/tools/search-empty-pages.test
 */

import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { blockText } from '../helpers/content.js';
import {
  blankTextBlocks,
  entityList,
  occurrences,
  singleRecord,
  type ToolResult,
  textOf,
  workList,
} from '../helpers/crossref-responses.js';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn().mockReturnValue({
    mailto: 'test@example.com',
    baseUrl: 'https://api.crossref.test',
    timeoutMs: 10_000,
  }),
}));

import {
  searchFundersTool,
  searchJournalsTool,
  searchWorksTool,
} from '@/mcp-server/tools/definitions/index.js';
import { initCrossrefService } from '@/services/crossref/crossref-service.js';

const WORKS = /^https:\/\/api\.crossref\.test\/works\?/;
const JOURNALS = /^https:\/\/api\.crossref\.test\/journals\?/;
const FUNDERS = /^https:\/\/api\.crossref\.test\/funders\?/;

const WORK = { DOI: '10.5555/w1', type: 'journal-article', title: ['A work'] };
const JOURNAL = { title: 'Blood Cells', 'ISSN-L': '1079-5146', ISSN: ['1079-5146'] };
const FUNDER = { id: '100000001', name: 'National Science Foundation', 'replaced-by': [] };

const http = createFetchMock();

beforeEach(() => {
  http.reset();
  http.install();
  initCrossrefService();
});

afterEach(() => {
  http.restore();
});

/** The notice a page carried on `structuredContent`, failing the test when it has none. */
function noticeOf(result: ToolResult): string {
  expect(result.isError).toBeFalsy();
  const notice = (result.structuredContent as { notice?: string }).notice;
  expect(notice).toBeTypeOf('string');
  return notice ?? '';
}

/**
 * What every empty page owes a client reading `content[]`: nothing blank ahead of the notice,
 * the notice in the first block, and the notice said once.
 */
function expectLeadingNotice(result: ToolResult): string {
  const notice = noticeOf(result);
  expect(blankTextBlocks(result)).toEqual([]);
  expect(blockText(result.content[0])).toContain(notice);
  expect(occurrences(result, notice)).toBe(1);
  return notice;
}

describe('a page carrying records', () => {
  it.each([
    [
      'crossref_search_works',
      searchWorksTool,
      { query: 'q', rows: 1 },
      WORKS,
      () => workList([WORK], 7),
      '### A work',
    ],
    [
      'crossref_search_journals',
      searchJournalsTool,
      { query: 'q', rows: 1 },
      JOURNALS,
      () => entityList([JOURNAL], 7),
      '## Blood Cells',
    ],
    [
      'crossref_search_funders',
      searchFundersTool,
      { query: 'q', rows: 1 },
      FUNDERS,
      () => entityList([FUNDER], 7),
      '## National Science Foundation',
    ],
  ] as const)(
    '%s renders its records first and the trailer after them',
    async (_name, definition, input, route, respond, heading) => {
      http.route({ match: route, respond });

      const result = await runToolContract(definition, input);

      expect(result.isError).toBeFalsy();
      expect(result.content).toHaveLength(2);
      expect(blockText(result.content[0]).startsWith(heading)).toBe(true);
      expect(blockText(result.content[1])).toContain('7');
    },
  );
});

describe('crossref_search_works empty pages', () => {
  it('leads with the no-match notice when nothing matched', async () => {
    http.route({ match: WORKS, respond: () => workList([], 0) });

    const result = await runToolContract(searchWorksTool, { query: 'zzzqqq' });

    expect(expectLeadingNotice(result)).toMatch(/No results matched/);
    expect(result.structuredContent).toMatchObject({ works: [], totalResults: 0, returned: 0 });
  });

  it('leads with the past-the-end notice when an offset overshoots', async () => {
    http.route({ match: WORKS, respond: () => workList([], 1) });

    const result = await runToolContract(searchWorksTool, {
      filter: { doi: '10.1038/s41586-020-2649-2' },
      offset: 5,
      rows: 1,
    });

    const notice = expectLeadingNotice(result);
    expect(notice).toContain('Offset 5 is past the end');
    expect(result.structuredContent).toMatchObject({ works: [], totalResults: 1 });
  });

  it('names a total of one in the singular', async () => {
    http.route({ match: WORKS, respond: () => workList([], 1) });

    const result = await runToolContract(searchWorksTool, { query: 'q', offset: 5, rows: 1 });

    const notice = noticeOf(result);
    expect(notice).toContain('1 record matched');
    expect(notice).not.toContain('1 records');
  });

  it('leads with the walk-complete notice on the page that ends a cursor walk', async () => {
    http.route({ match: WORKS, respond: () => workList([], 100, 'recycled') });

    const result = await runToolContract(searchWorksTool, { query: 'q', cursor: 'last' });

    expect(expectLeadingNotice(result)).toMatch(/walk is complete/);
    expect(result.structuredContent).not.toHaveProperty('nextCursor');
  });

  it('ends a two-page cursor walk on an empty page that leads with its notice', async () => {
    http.route({
      match: WORKS,
      respond: (request) =>
        new URL(request.url).searchParams.get('cursor') === '*'
          ? workList([WORK], 1, 'second')
          : workList([], 1, 'second'),
    });

    const first = await runToolContract(searchWorksTool, { query: 'q', cursor: '*' });
    const next = (first.structuredContent as { nextCursor?: string }).nextCursor;
    expect(next).toBe('second');
    expect(blockText(first.content[0])).toContain('second');

    const last = await runToolContract(searchWorksTool, { query: 'q', cursor: next ?? '' });

    const notice = expectLeadingNotice(last);
    expect(notice).toContain('the 1 matching record has been returned');
    expect(textOf(last)).not.toContain('Next cursor');
  });
});

describe.each([
  ['crossref_search_journals', searchJournalsTool, JOURNALS, 'journal', /No journals matched/],
  ['crossref_search_funders', searchFundersTool, FUNDERS, 'funder', /No funders matched/],
] as const)('%s empty pages', (_name, definition, route, noun, noMatch) => {
  it('leads with the no-match notice when nothing matched', async () => {
    http.route({ match: route, respond: () => entityList([], 0) });

    const result = await runToolContract(definition, { query: 'zzzqqq', rows: 1 });

    expect(expectLeadingNotice(result)).toMatch(noMatch);
  });

  it('leads with the past-the-end notice when an offset overshoots', async () => {
    http.route({ match: route, respond: () => entityList([], 223) });

    const result = await runToolContract(definition, { query: 'q', rows: 1, offset: 500 });

    const notice = expectLeadingNotice(result);
    expect(notice).toContain(`Offset 500 is past the end`);
    expect(notice).toContain(`223 ${noun}s matched`);
  });

  it('names a total of one in the singular', async () => {
    http.route({ match: route, respond: () => entityList([], 1) });

    const result = await runToolContract(definition, { query: 'q', rows: 1, offset: 5 });

    const notice = noticeOf(result);
    expect(notice).toContain(`1 ${noun} matched`);
    expect(notice).not.toContain(`1 ${noun}s`);
  });
});

describe.each([
  {
    name: 'crossref_search_journals',
    definition: searchJournalsTool,
    input: { issn: '1079-5146', include_works: true },
    recordRoute: /\/journals\/1079-5146$/,
    worksRoute: /\/journals\/1079-5146\/works\?/,
    record: JOURNAL,
    worksKey: 'recentWorks',
    totalKey: 'worksTotal',
  },
  {
    name: 'crossref_search_funders',
    definition: searchFundersTool,
    input: { funder_doi: '100000001', include_works: true },
    recordRoute: /\/funders\/100000001$/,
    worksRoute: /\/funders\/100000001\/works\?/,
    record: FUNDER,
    worksKey: 'fundedWorks',
    totalKey: 'fundedWorksTotal',
  },
] as const)('a works_offset past the end of the $name works list', (target) => {
  function routes(total: number, record: unknown = target.record) {
    http.route({ match: target.recordRoute, respond: () => singleRecord(record) });
    http.route({ match: target.worksRoute, respond: () => workList([], total) });
  }

  it('names the offset and the works total on both surfaces', async () => {
    routes(572);

    const result = await runToolContract(target.definition, {
      ...target.input,
      works_offset: 5000,
      rows: 5,
    });

    const notice = noticeOf(result);
    expect(notice).toContain('works_offset 5000');
    expect(notice).toContain('572 works');
    expect(occurrences(result, notice)).toBe(1);
    expect(result.structuredContent).toMatchObject({
      [target.worksKey]: [],
      [target.totalKey]: 572,
    });
    // The record the page is about still renders first; the notice rides the trailer.
    expect(blockText(result.content[0])).not.toContain(notice);
    expect(blankTextBlocks(result)).toEqual([]);
  });

  it('names a works total of one in the singular', async () => {
    routes(1);

    const result = await runToolContract(target.definition, {
      ...target.input,
      works_offset: 5,
      rows: 5,
    });

    const notice = noticeOf(result);
    expect(notice).toContain('1 work ');
    expect(notice).not.toContain('1 works');
  });

  it('says nothing when the works list itself is empty', async () => {
    routes(0);

    const result = await runToolContract(target.definition, { ...target.input, rows: 5 });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).not.toHaveProperty('notice');
  });
});

describe('crossref_search_funders works_offset past the end of a deprecated funder', () => {
  it('keeps both the deprecation and the past-the-end caveat', async () => {
    const deprecated = { ...FUNDER, id: '501100002860', 'replaced-by': ['501100004543'] };
    http.route({ match: /\/funders\/501100002860$/, respond: () => singleRecord(deprecated) });
    http.route({ match: /\/funders\/501100002860\/works\?/, respond: () => workList([], 965) });

    const result = await runToolContract(searchFundersTool, {
      funder_doi: '501100002860',
      include_works: true,
      works_offset: 2000,
      rows: 5,
    });

    const notice = noticeOf(result);
    expect(notice).toContain('501100004543');
    expect(notice).toContain('works_offset 2000');
    expect(notice).toContain('965 works');
    expect(occurrences(result, notice)).toBe(1);
  });
});
