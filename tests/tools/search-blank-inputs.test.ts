/**
 * @fileoverview Blank optional inputs on the three search tools. Form-based clients send `""`
 * for a field nobody filled in, so a blank or whitespace-only value is read as omitted rather
 * than sent or rejected — query terms, IDs, `sort`/`order`, and each `filter` value alike. When
 * dropping blanks leaves no search criterion, the response is an unfiltered listing and a notice
 * says so. Driven through the real `CrossrefService` behind a fetch fake, so what is asserted is
 * the query string that actually leaves the server.
 * @module tests/tools/search-blank-inputs.test
 */

import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
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
const JOURNALS = /^https:\/\/api\.crossref\.test\/journals(?:\?|$)/;
const FUNDERS = /^https:\/\/api\.crossref\.test\/funders(?:\?|$)/;

const WORK = { DOI: '10.5555/w1', type: 'journal-article', title: ['A work'] };
const JOURNAL = { title: 'Nature', 'ISSN-L': '0028-0836', ISSN: ['0028-0836', '1476-4687'] };
const FUNDER = { id: '100010269', name: 'Wellcome Trust', 'replaced-by': [] };

const http = createFetchMock();

beforeEach(() => {
  http.reset();
  http.install();
  initCrossrefService();
  http.route({ match: WORKS, respond: () => workList([WORK], 186_897_538) });
  http.route({ match: /\/journals\/0028-0836$/, respond: () => singleRecord(JOURNAL) });
  http.route({ match: JOURNALS, respond: () => entityList([JOURNAL], 171_152) });
  http.route({ match: FUNDERS, respond: () => entityList([FUNDER], 45_700) });
});

afterEach(() => {
  http.restore();
});

/** The one request a call sent: its path and its query parameters. */
function sent(): { path: string; params: Record<string, string> } {
  expect(http.calls).toHaveLength(1);
  const url = new URL(http.calls[0]?.request.url ?? '');
  return { path: url.pathname, params: Object.fromEntries(url.searchParams) };
}

function noticeOf(result: ToolResult): string | undefined {
  expect(result.isError).toBeFalsy();
  return (result.structuredContent as { notice?: string }).notice;
}

/** The unfiltered-listing notice, on both surfaces, said once. */
function expectBlankNotice(result: ToolResult): string {
  const notice = noticeOf(result) ?? '';
  expect(notice).toMatch(/every search term supplied was blank/i);
  expect(notice).toMatch(/unfiltered/);
  expect(occurrences(result, notice)).toBe(1);
  return notice;
}

describe('non-blank inputs are sent as supplied', () => {
  it('passes every crossref_search_works term, filter value, sort, and order through', async () => {
    await runToolContract(searchWorksTool, {
      query: ' crispr ',
      queryTitle: 'Array programming',
      filter: { type: 'journal-article', 'container-title': ' Nature ' },
      sort: 'score',
      order: 'desc',
      rows: 1,
    });

    expect(sent().params).toMatchObject({
      query: ' crispr ',
      'query.title': 'Array programming',
      filter: 'type:journal-article,container-title: Nature ',
      sort: 'score',
      order: 'desc',
    });
  });

  it('resolves a journal ISSN and a funder DOI directly', async () => {
    await runToolContract(searchJournalsTool, { issn: '0028-0836' });
    expect(sent().path).toBe('/journals/0028-0836');

    http.reset();
    http.route({ match: /\/funders\/100010269$/, respond: () => singleRecord(FUNDER) });
    await runToolContract(searchFundersTool, { funder_doi: '100010269' });
    expect(sent().path).toBe('/funders/100010269');
  });

  it('carries no notice on a filter-only search or a call that omits every term', async () => {
    const filterOnly = await runToolContract(searchWorksTool, {
      filter: { type: 'journal-article' },
      rows: 1,
    });
    expect(noticeOf(filterOnly)).toBeUndefined();

    http.reset();
    http.route({ match: WORKS, respond: () => workList([WORK], 186_897_538) });
    const bare = await runToolContract(searchWorksTool, { rows: 1 });
    expect(noticeOf(bare)).toBeUndefined();
  });
});

describe('crossref_search_works blank query terms', () => {
  const TERMS = [
    ['query', 'query'],
    ['queryBibliographic', 'query.bibliographic'],
    ['queryTitle', 'query.title'],
    ['queryAuthor', 'query.author'],
    ['queryContainerTitle', 'query.container-title'],
  ] as const;

  describe.each(TERMS)('%s', (field, param) => {
    it.each(['', '   '])('sends no %j and says the listing is unfiltered', async (blank) => {
      const result = await runToolContract(searchWorksTool, { [field]: blank, rows: 1 });

      expect(sent().params).toEqual({ rows: '1' });
      expect(param in sent().params).toBe(false);
      expectBlankNotice(result);
    });

    it.each(['', '   '])('drops %j silently beside a term that still searches', async (blank) => {
      const result = await runToolContract(searchWorksTool, {
        [field]: blank,
        ...(field === 'query' ? { queryTitle: 'NumPy' } : { query: 'NumPy' }),
        rows: 1,
      });

      expect(param in sent().params).toBe(false);
      expect(noticeOf(result)).toBeUndefined();
    });
  });
});

describe('crossref_search_works blank filter values', () => {
  it('drops a blank value and keeps the rest of the filter', async () => {
    const result = await runToolContract(searchWorksTool, {
      filter: { 'container-title': '', type: 'journal-article', publisher: '  ' },
      rows: 1,
    });

    expect(sent().params.filter).toBe('type:journal-article');
    expect(noticeOf(result)).toBeUndefined();
  });

  it('sends no filter when every value is blank, and says so', async () => {
    const result = await runToolContract(searchWorksTool, {
      filter: { 'container-title': '' },
      rows: 1,
    });

    expect(sent().params).toEqual({ rows: '1' });
    const notice = expectBlankNotice(result);
    // content[] carries the same notice a structuredContent reader gets.
    expect(textOf(result)).toContain(notice);
  });

  it('does not reach the blank-type or blank-issn rejections a blank value used to', async () => {
    const result = await runToolContract(searchWorksTool, {
      filter: { type: '', issn: ' ' },
      query: 'crispr',
      rows: 1,
    });

    expect(result.isError).toBeFalsy();
    expect(sent().params).toEqual({ query: 'crispr', rows: '1' });
  });
});

describe('crossref_search_works form-blank payload', () => {
  it('returns the filtered set with nothing blank sent and no notice', async () => {
    const result = await runToolContract(searchWorksTool, {
      filter: { type: 'journal-article' },
      query: '',
      queryTitle: '',
      queryAuthor: '',
      queryContainerTitle: '',
      queryBibliographic: '',
      cursor: '',
      sort: '',
      order: '',
    });

    expect(result.isError).toBeFalsy();
    expect(sent().params).toEqual({ filter: 'type:journal-article', rows: '20' });
    expect(noticeOf(result)).toBeUndefined();
  });

  it('keeps both the blank-term and the author-cap notices on one page', async () => {
    http.reset();
    const crowded = {
      ...WORK,
      author: Array.from({ length: 40 }, (_, i) => ({ given: `G${i}`, family: `F${i}` })),
    };
    http.route({ match: WORKS, respond: () => workList([crowded], 186_897_538) });

    const result = await runToolContract(searchWorksTool, { queryTitle: '', rows: 1 });

    const notice = expectBlankNotice(result);
    expect(notice).toMatch(/capped at 25 per work/);
    expect(notice).toContain('1 of the 1 work on this page carries more authors');
    expect(result.structuredContent).toMatchObject({ truncated: true, cap: 25 });
  });
});

describe('crossref_search_journals blank inputs', () => {
  it.each(['', '   '])(
    'reads query %j as omitted and says the listing is unfiltered',
    async (blank) => {
      const result = await runToolContract(searchJournalsTool, { query: blank, rows: 1 });

      expect(sent()).toEqual({ path: '/journals', params: { rows: '1' } });
      expectBlankNotice(result);
    },
  );

  it('searches by name when issn is blank', async () => {
    const result = await runToolContract(searchJournalsTool, {
      issn: '',
      query: 'Nature',
      rows: 1,
    });

    expect(sent()).toEqual({ path: '/journals', params: { query: 'Nature', rows: '1' } });
    expect(noticeOf(result)).toBeUndefined();
  });

  it('still resolves the ISSN when query is blank', async () => {
    const result = await runToolContract(searchJournalsTool, { issn: '0028-0836', query: '' });

    expect(sent().path).toBe('/journals/0028-0836');
    expect(noticeOf(result)).toBeUndefined();
  });

  it('reads a blank issn with no query as an unfiltered listing', async () => {
    const result = await runToolContract(searchJournalsTool, { issn: '', rows: 1 });

    expect(sent()).toEqual({ path: '/journals', params: { rows: '1' } });
    expectBlankNotice(result);
  });

  it('keeps the blank-term notice beside the offset-ceiling notice', async () => {
    http.reset();
    http.route({
      match: JOURNALS,
      respond: () =>
        entityList(
          Array.from({ length: 10 }, () => JOURNAL),
          171_152,
        ),
    });

    const result = await runToolContract(searchJournalsTool, {
      query: '',
      rows: 10,
      offset: 99_990,
    });

    const notice = expectBlankNotice(result);
    expect(notice).toContain('100000');
  });
});

describe('crossref_search_funders blank inputs', () => {
  it.each(['', '   '])(
    'reads query %j as omitted and says the listing is unfiltered',
    async (blank) => {
      const result = await runToolContract(searchFundersTool, { query: blank, rows: 1 });

      expect(sent()).toEqual({ path: '/funders', params: { rows: '1' } });
      expectBlankNotice(result);
    },
  );

  it('searches by name when funder_doi is blank', async () => {
    const result = await runToolContract(searchFundersTool, {
      funder_doi: '',
      query: 'Wellcome',
      rows: 1,
    });

    expect(sent()).toEqual({ path: '/funders', params: { query: 'Wellcome', rows: '1' } });
    expect(noticeOf(result)).toBeUndefined();
  });

  it('keeps the blank-term notice beside the past-the-end notice', async () => {
    http.reset();
    http.route({ match: FUNDERS, respond: () => entityList([], 45_700) });

    const result = await runToolContract(searchFundersTool, {
      query: '',
      rows: 10,
      offset: 50_000,
    });

    const notice = expectBlankNotice(result);
    expect(notice).toContain('Offset 50000 is past the end');
  });
});

describe('the sentinel inputs', () => {
  it.each([
    ['crossref_search_works', 'sort', searchWorksTool],
    ['crossref_search_works', 'order', searchWorksTool],
    ['crossref_search_journals', 'issn', searchJournalsTool],
    ['crossref_search_funders', 'funder_doi', searchFundersTool],
  ] as const)('%s admits a blank %s', (_name, field, definition) => {
    expect(definition.input.safeParse({ [field]: '' }).success).toBe(true);
  });

  it.each([
    ['crossref_search_works', 'sort', searchWorksTool, 'newest'],
    ['crossref_search_works', 'order', searchWorksTool, 'up'],
    ['crossref_search_journals', 'issn', searchJournalsTool, '123'],
    ['crossref_search_funders', 'funder_doi', searchFundersTool, 'nsf'],
  ] as const)('%s still refuses a malformed %s', (_name, field, definition, value) => {
    expect(definition.input.safeParse({ [field]: value }).success).toBe(false);
  });
});
