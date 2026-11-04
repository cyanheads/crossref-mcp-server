/**
 * @fileoverview `select=` on every works list. `crossref_search_works.fields` is the caller's
 * projection: every name the input accepts has an output field on both result surfaces, so a
 * selection is never fetched and then discarded, and any other name is refused by the schema
 * before a request is made. A works list the caller does not narrow still names its fields —
 * `crossref_search_works` without `fields`, and the journal and funder works lists — each the
 * names its summary reads, which projecting full captured records against the same records cut
 * to that select proves on both surfaces. Driven through the real `CrossrefService` behind a
 * fetch fake, so the `select=` that leaves the server and the projection of what comes back are
 * both the production code.
 * @module tests/tools/search-works-fields.test
 */

import { readdirSync, readFileSync } from 'node:fs';
import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { singleRecord, type ToolResult, textOf, workList } from '../helpers/crossref-responses.js';

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

/** The select names the projection covers, in the order the input advertises them. */
const ACCEPTED = [
  'DOI',
  'title',
  'type',
  'author',
  'published',
  'published-print',
  'published-online',
  'container-title',
  'publisher',
  'member',
  'is-referenced-by-count',
  'score',
  'abstract',
  'volume',
  'issue',
  'page',
  'article-number',
  'ISSN',
  'updated-by',
  'update-to',
];

/** The live record for 10.1038/s41586-020-2649-2 under `select=DOI,ISSN,volume,issue,page`. */
const NUMPY = {
  DOI: '10.1038/s41586-020-2649-2',
  ISSN: ['0028-0836', '1476-4687'],
  volume: '585',
  issue: '7825',
  page: '357-362',
};

const http = createFetchMock();

beforeEach(() => {
  http.reset();
  http.install();
  initCrossrefService();
});

afterEach(() => {
  http.restore();
});

/** The `select=` the one request carried, split into names. */
function selected(): string[] {
  expect(http.calls).toHaveLength(1);
  return (new URL(http.calls[0]?.request.url ?? '').searchParams.get('select') ?? '').split(',');
}

type WorkOut = Record<string, unknown>;

function firstWork(result: Awaited<ReturnType<typeof runToolContract>>): WorkOut {
  expect(result.isError).toBeFalsy();
  return ((result.structuredContent as { works: WorkOut[] }).works[0] ?? {}) as WorkOut;
}

describe('crossref_search_works fields', () => {
  it('advertises exactly the names the summary projects', () => {
    const schema = z.toJSONSchema(searchWorksTool.input, { io: 'input' }) as {
      properties?: Record<string, { items?: { enum?: string[] } }>;
    };

    expect(schema.properties?.fields?.items?.enum).toEqual(ACCEPTED);
  });

  it('returns the citation locators and ISSNs on both surfaces', async () => {
    http.route({ match: WORKS, respond: () => workList([NUMPY]) });

    const result = await runToolContract(searchWorksTool, {
      filter: { doi: '10.1038/s41586-020-2649-2' },
      fields: ['ISSN', 'volume', 'issue', 'page'],
      rows: 1,
    });

    expect(selected()).toEqual(['DOI', 'ISSN', 'volume', 'issue', 'page']);
    expect(firstWork(result)).toEqual({
      doi: '10.1038/s41586-020-2649-2',
      issn: ['0028-0836', '1476-4687'],
      volume: '585',
      issue: '7825',
      page: '357-362',
    });
    const text = textOf(result);
    expect(text).toContain('**ISSN:** 0028-0836, 1476-4687');
    expect(text).toContain('**Volume:** 585');
    expect(text).toContain('**Issue:** 7825');
    expect(text).toContain('**Pages:** 357-362');
  });

  it('projects an article number where a journal numbers articles instead of paging them', async () => {
    http.route({
      match: WORKS,
      respond: () =>
        workList([{ DOI: '10.1038/s41467-024-00001-1', volume: '15', 'article-number': '1234' }]),
    });

    const result = await runToolContract(searchWorksTool, {
      query: 'q',
      fields: ['volume', 'article-number'],
      rows: 1,
    });

    expect(firstWork(result)).toEqual({
      doi: '10.1038/s41467-024-00001-1',
      volume: '15',
      articleNumber: '1234',
    });
    expect(textOf(result)).toContain('**Article number:** 1234');
  });

  /**
   * The locator line crossref_get_work renders too: one line, citation order, each part only
   * where deposited. A page and an article number are relayed independently even when a
   * publisher deposits the same value in both.
   */
  it('renders every deposited locator on one line, in citation order', async () => {
    http.route({
      match: WORKS,
      respond: () =>
        workList([
          {
            DOI: '10.1016/j.chemosphere.2021.130212',
            volume: '276',
            page: '130212',
            'article-number': '130212',
          },
          { DOI: '10.1038/s41586-020-2649-2', volume: '585', issue: '7825', page: '357-362' },
        ]),
    });

    const result = await runToolContract(searchWorksTool, {
      query: 'q',
      fields: ['volume', 'issue', 'page', 'article-number'],
      rows: 2,
    });
    const lines = textOf(result).split('\n');

    expect(lines).toContain('**Volume:** 276 | **Pages:** 130212 | **Article number:** 130212');
    expect(lines).toContain('**Volume:** 585 | **Issue:** 7825 | **Pages:** 357-362');
  });

  it('fills containerTitle and containerTitles from the one container-title name', async () => {
    http.route({
      match: WORKS,
      respond: () =>
        workList([
          {
            DOI: '10.1007/978-3-030-58452-8_1',
            'container-title': ['Lecture Notes in Computer Science', 'Computer Vision – ECCV 2020'],
          },
        ]),
    });

    const result = await runToolContract(searchWorksTool, {
      query: 'q',
      fields: ['container-title'],
      rows: 1,
    });

    expect(selected()).toEqual(['DOI', 'container-title']);
    expect(firstWork(result)).toEqual({
      doi: '10.1007/978-3-030-58452-8_1',
      containerTitle: 'Lecture Notes in Computer Science',
      containerTitles: ['Lecture Notes in Computer Science', 'Computer Vision – ECCV 2020'],
    });
    expect(textOf(result)).toContain(
      '**Journal:** Lecture Notes in Computer Science | Computer Vision – ECCV 2020',
    );
  });

  it('returns doi and memberId alone under fields ["member"]', async () => {
    http.route({
      match: WORKS,
      respond: () => workList([{ DOI: '10.1155/2024/9760680', member: '311' }]),
    });

    const result = await runToolContract(searchWorksTool, {
      filter: { doi: '10.1155/2024/9760680' },
      fields: ['member'],
      rows: 1,
    });

    expect(selected()).toEqual(['DOI', 'member']);
    expect(firstWork(result)).toEqual({ doi: '10.1155/2024/9760680', memberId: 311 });
    expect(textOf(result)).toContain('**Member ID:** 311');
  });

  it('omits a selected field the record does not deposit, without erroring', async () => {
    http.route({ match: WORKS, respond: () => workList([{ DOI: '10.5555/sparse' }]) });

    const result = await runToolContract(searchWorksTool, {
      query: 'q',
      fields: ['ISSN', 'volume', 'issue', 'page', 'article-number'],
      rows: 1,
    });

    expect(firstWork(result)).toEqual({ doi: '10.5555/sparse' });
    expect(textOf(result)).not.toMatch(/Volume|Issue|Pages|Article number|ISSN/);
  });

  it('still returns each work doi when only title is selected', async () => {
    http.route({ match: WORKS, respond: () => workList([{ DOI: '10.5555/t', title: ['T'] }]) });

    const result = await runToolContract(searchWorksTool, {
      query: 'q',
      fields: ['title'],
      rows: 1,
    });

    expect(selected()).toEqual(['DOI', 'title']);
    expect(firstWork(result)).toEqual({ doi: '10.5555/t', title: 'T' });
  });

  /** Answer with the captured Lancet record cut to the `select=` names, as Crossref does. */
  function selectFromLancet(request: Request): Response {
    const file = new URL('../fixtures/works/10.1016_s0140-6736_20_31180-6.json', import.meta.url);
    const record = (JSON.parse(readFileSync(file, 'utf8')) as { message: Record<string, unknown> })
      .message;
    const names = new URL(request.url).searchParams.get('select')?.split(',');
    const item = names
      ? Object.fromEntries(Object.entries(record).filter(([key]) => names.includes(key)))
      : record;
    return workList([item]);
  }

  it('returns doi and updatedBy alone under fields ["updated-by"]', async () => {
    http.route({ match: WORKS, respond: selectFromLancet });

    const result = await runToolContract(searchWorksTool, {
      filter: { doi: '10.1016/S0140-6736(20)31180-6' },
      fields: ['updated-by'],
      rows: 1,
    });

    expect(selected()).toEqual(['DOI', 'updated-by']);
    const work = firstWork(result) as { doi: string; updatedBy: Array<{ recordId?: string }> };
    expect(Object.keys(work)).toEqual(['doi', 'updatedBy']);
    expect(work.doi).toBe('10.1016/s0140-6736(20)31180-6');
    expect(work.updatedBy).toHaveLength(7);
    expect(work.updatedBy.map((u) => u.recordId)).toEqual([
      '23527',
      '23528',
      '23529',
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    const text = textOf(result);
    expect(text).toContain('**Updated by:**');
    expect(text).toContain(
      '- 10.1016/s0140-6736(20)31324-6 — retraction (retraction-watch, record 23529), 2020-06-05',
    );
    expect(text).not.toContain('**Update notice for:**');
  });

  it('returns updateTo under fields ["update-to"]', async () => {
    http.route({ match: WORKS, respond: selectFromLancet });

    const result = await runToolContract(searchWorksTool, {
      query: 'hydroxychloroquine',
      fields: ['update-to'],
      rows: 1,
    });

    expect(selected()).toEqual(['DOI', 'update-to']);
    const work = firstWork(result) as { updateTo: Array<{ doi: string }> };
    expect(Object.keys(work)).toEqual(['doi', 'updateTo']);
    expect(work.updateTo.map((u) => u.doi)).toEqual([
      '10.1016/s0140-6736(20)31174-0',
      '10.1016/s0140-6736(20)31290-3',
      '10.1016/s0140-6736(20)31324-6',
      '10.1016/s0140-6736(20)31528-2',
    ]);
    expect(textOf(result)).toContain(
      '**Update notice for:**\n- 10.1016/s0140-6736(20)31174-0 — retraction (publisher), 2020-05-22',
    );
  });

  it('returns no update keys when the selection leaves them out', async () => {
    http.route({ match: WORKS, respond: selectFromLancet });

    const result = await runToolContract(searchWorksTool, {
      query: 'hydroxychloroquine',
      fields: ['title'],
      rows: 1,
    });

    expect(Object.keys(firstWork(result))).toEqual(['doi', 'title']);
    expect(textOf(result)).not.toMatch(/Updated by|Update notice for/);
  });

  it.each([[['license']], [['doi']], [['title', 'ISBN']]])(
    'refuses %j before any request, naming the accepted values',
    async (fields) => {
      const result = await runToolContract(searchWorksTool, { query: 'q', fields } as never);

      expect(result.isError).toBe(true);
      const error = (
        result.structuredContent as {
          error: { code: number; message: string; data?: { reason?: string } };
        }
      ).error;
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.data?.reason).toBe('invalid_arguments');
      expect(textOf(result)).toContain('article-number');
      expect(http.calls).toHaveLength(0);
    },
  );

  /**
   * Without a selection Crossref returns whole records — reference lists included — for a
   * projection that reads twenty fields of them: a heavy 1000-row page is 13.0 MB upstream
   * against 3.2 MB under the select, with identical output.
   */
  it.each([
    ['fields omitted', {}],
    ['fields empty', { fields: [] }],
    ['an offset page', { offset: 40 }],
    ['a cursor walk', { cursor: '*' }],
  ])('names every field the summary projects in select= with %s', async (_, input) => {
    http.route({ match: WORKS, respond: () => workList([]) });

    const result = await runToolContract(searchWorksTool, { query: 'q', rows: 1, ...input });

    expect(result.isError).toBeFalsy();
    expect(selected()).toEqual(ACCEPTED);
  });
});

/**
 * The names the journal and funder works-list summaries read: `doi`, `title`, `type`,
 * `published` (the first of three date sources that names one), and `isReferencedByCount`.
 */
const WORKS_LIST_SELECT = [
  'DOI',
  'title',
  'type',
  'published',
  'published-print',
  'published-online',
  'is-referenced-by-count',
];

const FIXTURES = new URL('../fixtures/works/', import.meta.url);

/**
 * Every captured full work record, plus two whose only date sits in a fallback source — no real
 * record lacks `published`, so without them nothing would show the fallbacks are read. Each
 * carries a `score`, as a search page's records do and a single-record fetch's do not.
 */
const RECORDS: Record<string, unknown>[] = [
  ...readdirSync(FIXTURES)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map(
      (name) =>
        (
          JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8')) as {
            message: Record<string, unknown>;
          }
        ).message,
    ),
  {
    DOI: '10.5555/print-only',
    type: 'journal-article',
    'published-print': { 'date-parts': [[2019, 4]] },
  },
  {
    DOI: '10.5555/online-only',
    type: 'journal-article',
    'published-online': { 'date-parts': [[2021, 3]] },
  },
].map((record, i) => ({ ...record, score: 40 - i }));

/** Whether a request is to this path on the configured Crossref host. */
function crossrefPath(path: string): (request: Request) => boolean {
  return (request) => {
    const url = new URL(request.url);
    return url.hostname === 'api.crossref.test' && url.pathname === path;
  };
}

/**
 * How the works route answers: every record whole, or each cut to the request's `select=` names
 * as Crossref cuts them — less one name, to show the projection reads it.
 */
type Answer = { kind: 'whole' } | { kind: 'selected'; without?: string };

/** One works list, driven through its tool for a page holding every record. */
type WorksListCase = {
  /** The names the list's request must carry in `select=`. */
  select: readonly string[];
  worksPath: string;
  /** Routes the call needs besides its works list — the journal or funder record. */
  setup(): void;
  run(): Promise<ToolResult>;
};

const LISTS: Record<string, WorksListCase> = {
  crossref_search_works: {
    select: ACCEPTED,
    worksPath: '/works',
    setup: () => {},
    run: () => runToolContract(searchWorksTool, { query: 'q', rows: RECORDS.length }),
  },
  'crossref_search_journals works list': {
    select: WORKS_LIST_SELECT,
    worksPath: '/works',
    setup: () => {
      http.route({
        match: crossrefPath('/journals/0959-8138'),
        respond: () => singleRecord({ title: 'BMJ', ISSN: ['0959-8138', '1756-1833'] }),
      });
    },
    run: () =>
      runToolContract(searchJournalsTool, {
        issn: '0959-8138',
        include_works: true,
        rows: RECORDS.length,
      }),
  },
  'crossref_search_funders works list': {
    select: WORKS_LIST_SELECT,
    worksPath: '/funders/100000001/works',
    setup: () => {
      http.route({
        match: crossrefPath('/funders/100000001'),
        respond: () => singleRecord({ id: '100000001', name: 'National Science Foundation' }),
      });
    },
    run: () =>
      runToolContract(searchFundersTool, {
        funder_doi: '100000001',
        include_works: true,
        rows: RECORDS.length,
      }),
  },
};

/** Both result surfaces of one call, with the works route answering as `answer` says. */
async function surfaces(list: WorksListCase, answer: Answer) {
  http.reset();
  list.setup();
  http.route({
    match: crossrefPath(list.worksPath),
    respond: (request) => {
      const names = new URL(request.url).searchParams.get('select')?.split(',');
      if (answer.kind === 'whole' || names === undefined) return workList(RECORDS);
      const kept = names.filter((name) => name !== answer.without);
      return workList(
        RECORDS.map((record) =>
          Object.fromEntries(Object.entries(record).filter(([key]) => kept.includes(key))),
        ),
      );
    },
  });
  const result = await list.run();
  expect(result.isError).toBeFalsy();
  const works = http.calls.filter((call) => crossrefPath(list.worksPath)(call.request));
  expect(works).toHaveLength(1);
  return {
    select: new URL(works[0]?.request.url ?? '').searchParams.get('select')?.split(','),
    structured: result.structuredContent,
    text: textOf(result),
  };
}

describe('select= on every works list', () => {
  describe.each(Object.entries(LISTS))('%s', (_, list) => {
    it('names exactly the fields its summary reads', async () => {
      expect((await surfaces(list, { kind: 'whole' })).select).toEqual(list.select);
    });

    /**
     * The guard on the select list: a raw key the projection reads but the select leaves out
     * reaches the projection as absent, so the two outputs part on whichever surface carries it.
     */
    it('projects records cut to its select exactly as it projects them whole', async () => {
      const whole = await surfaces(list, { kind: 'whole' });
      const selected = await surfaces(list, { kind: 'selected' });

      expect(selected.structured).toEqual(whole.structured);
      expect(selected.text).toBe(whole.text);
    });

    it.each(list.select.filter((name) => name !== 'DOI'))(
      'reads %s — a record cut without it projects differently',
      async (name) => {
        const whole = await surfaces(list, { kind: 'whole' });
        const without = await surfaces(list, { kind: 'selected', without: name });

        expect(without.structured).not.toEqual(whole.structured);
      },
    );
  });
});
