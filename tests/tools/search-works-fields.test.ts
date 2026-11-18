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
import { Parser } from 'commonmark';
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

/** The selection a page carries when `fields` names none, in the order the input advertises it. */
const DEFAULT_SELECT = [
  'DOI',
  'title',
  'type',
  'author',
  'published',
  'published-print',
  'published-online',
  'approved',
  'container-title',
  'event',
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

/** The names a page carries only when `fields` names them. */
const OPT_IN = ['funder', 'license', 'link'];

/** Every select name the projection covers, in the order the input advertises them. */
const ACCEPTED = [...DEFAULT_SELECT, ...OPT_IN];

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

  /**
   * The event projection and line are shared with crossref_get_work and tabled in
   * `work-dates.test.ts`; this pins the wiring, on a record that deposits one and one that does
   * not.
   */
  it('returns doi and event alone under fields ["event"]', async () => {
    http.route({
      match: WORKS,
      respond: () =>
        workList([
          {
            DOI: '10.1109/iccar64901.2025.11073036',
            event: {
              name: '2025 11th International Conference on Control, Automation and Robotics (ICCAR)',
              location: 'Kyoto, Japan',
              start: { 'date-parts': [[2025, 4, 18]] },
              end: { 'date-parts': [[2025, 4, 20]] },
            },
          },
          { DOI: '10.5555/no-event' },
        ]),
    });

    const result = await runToolContract(searchWorksTool, {
      query: 'q',
      fields: ['event'],
      rows: 2,
    });

    expect(selected()).toEqual(['DOI', 'event']);
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { works: WorkOut[] }).works).toEqual([
      {
        doi: '10.1109/iccar64901.2025.11073036',
        event: {
          name: '2025 11th International Conference on Control, Automation and Robotics (ICCAR)',
          location: 'Kyoto, Japan',
          start: { year: 2025, month: 4, day: 18 },
          end: { year: 2025, month: 4, day: 20 },
        },
      },
      { doi: '10.5555/no-event' },
    ]);
    const text = textOf(result);
    expect(text.split('\n')).toContain(
      '**Event:** 2025 11th International Conference on Control, Automation and Robotics (ICCAR), Kyoto, Japan, 2025-04-18 – 2025-04-20',
    );
    expect(text.split('**Event:**')).toHaveLength(2);
  });

  /**
   * A dissertation's only date is `approved`, so a page selecting the publication dates alone
   * dates it nowhere — the approval date fills its own field and never `published`.
   */
  it('returns doi and approved alone under fields ["approved"], never as published', async () => {
    http.route({
      match: WORKS,
      respond: (request) => {
        const names = new URL(request.url).searchParams.get('select')?.split(',') ?? [];
        const thesis = {
          DOI: '10.11606/t.48.2015.tde-14122015-153241',
          approved: { 'date-parts': [[2015, 9, 22]] },
        };
        return workList([
          Object.fromEntries(Object.entries(thesis).filter(([key]) => names.includes(key))),
          { DOI: '10.5555/no-approval' },
        ]);
      },
    });

    const result = await runToolContract(searchWorksTool, {
      filter: { type: 'dissertation' },
      fields: ['approved', 'published'],
      rows: 2,
    });

    expect(selected()).toEqual(['DOI', 'approved', 'published']);
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { works: WorkOut[] }).works).toEqual([
      {
        doi: '10.11606/t.48.2015.tde-14122015-153241',
        approved: { year: 2015, month: 9, day: 22 },
      },
      { doi: '10.5555/no-approval' },
    ]);
    const text = textOf(result);
    expect(text.split('\n')).toContain('**Approved:** 2015-09-22');
    expect(text.split('**Approved:**')).toHaveLength(2);
    expect(text).not.toContain('**Published:**');
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

  /** facet= counts the match set; it rides beside the selection and never changes it. */
  it.each([
    ['a written selection', { fields: ['DOI', 'update-to'] }, ['DOI', 'update-to']],
    ['no selection', {}, DEFAULT_SELECT],
  ])('sends facet= beside the select= of %s, unchanged', async (_label, extra, select) => {
    http.route({ match: WORKS, respond: () => workList([{ DOI: '10.5555/t' }]) });

    const result = await runToolContract(searchWorksTool, {
      filter: { 'update-type': 'retraction' },
      rows: 1,
      facets: { published: '*', 'publisher-name': 10 },
      ...extra,
    } as never);

    expect(result.isError).toBeFalsy();
    expect(selected()).toEqual(select);
    expect(new URL(http.calls[0]?.request.url ?? '').searchParams.get('facet')).toBe(
      'published:*,publisher-name:10',
    );
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

  it.each([[['reference']], [['doi']], [['title', 'ISBN']], [['funder', 'Funder']]])(
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
   * projection that reads twenty-two fields of them: a heavy 1000-row page is 13.0 MB upstream
   * against 3.2 MB under the select, with identical output. The three opt-in names stay out of
   * it, so a page that names no fields is the page it has always been.
   */
  it.each([
    ['fields omitted', {}],
    ['fields empty', { fields: [] }],
    ['an offset page', { offset: 40 }],
    ['a cursor walk', { cursor: '*' }],
  ])(
    'names every default field, and none of funder, license, or link, in select= with %s',
    async (_, input) => {
      http.route({ match: WORKS, respond: () => workList([]) });

      const result = await runToolContract(searchWorksTool, { query: 'q', rows: 1, ...input });

      expect(result.isError).toBeFalsy();
      expect(selected()).toEqual(DEFAULT_SELECT);
    },
  );
});

/** A funder list of `count` distinct named entries, each with its own award. */
function makeFunders(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    name: `Funder ${i}`,
    DOI: `10.13039/50110000${i}`,
    award: [`AWARD-${i}`],
  }));
}

/**
 * The three opt-in names. Each fills its output field with crossref_get_work's entry shape and
 * renders get_work's labelled list inside the work's block — the shapes and lines are tabled in
 * `work-funders-licenses-links.test.ts`; this proves the wiring on both surfaces.
 */
describe('crossref_search_works funder, license, and link', () => {
  const RECORD = {
    DOI: '10.1038/s41586-020-2649-2',
    funder: [
      {
        name: 'National Natural Science Foundation of China',
        DOI: '10.13039/501100001809',
        award: ['41801279'],
      },
      { award: ['EP/S020527/1'], id: [{ id: 'https://ror.org/0439y7842', 'id-type': 'ROR' }] },
    ],
    license: [
      {
        URL: 'https://creativecommons.org/licenses/by/4.0',
        'content-version': 'vor',
        'delay-in-days': 0,
        start: { 'date-time': '2020-09-16T00:00:00Z' },
      },
    ],
    link: [
      {
        URL: 'https://www.nature.com/articles/s41586-020-2649-2.pdf',
        'content-type': 'application/pdf',
        'content-version': 'vor',
        'intended-application': 'text-mining',
      },
    ],
  };

  /** Answer with RECORD cut to the `select=` names, as Crossref does. */
  function selectFromRecord(request: Request): Response {
    const names = new URL(request.url).searchParams.get('select')?.split(',') ?? [];
    return workList([
      Object.fromEntries(Object.entries(RECORD).filter(([k]) => names.includes(k))),
    ]);
  }

  it('returns doi, funders, and funderCount alone under fields ["funder"]', async () => {
    http.route({ match: WORKS, respond: selectFromRecord });

    const result = await runToolContract(searchWorksTool, {
      query: 'q',
      fields: ['funder'],
      rows: 1,
    });

    expect(selected()).toEqual(['DOI', 'funder']);
    expect(firstWork(result)).toEqual({
      doi: '10.1038/s41586-020-2649-2',
      funderCount: 2,
      funders: [
        {
          name: 'National Natural Science Foundation of China',
          doi: '10.13039/501100001809',
          award: ['41801279'],
        },
        { ror: 'https://ror.org/0439y7842', award: ['EP/S020527/1'] },
      ],
    });
    expect(textOf(result)).toContain(
      '\n\n**Funders:**\n- National Natural Science Foundation of China — 10.13039/501100001809 (41801279)\n- https://ror.org/0439y7842 (EP/S020527/1)\n',
    );
    expect((result.structuredContent as { notice?: string }).notice).toBeUndefined();
  });

  it('returns doi and licenses alone under fields ["license"]', async () => {
    http.route({ match: WORKS, respond: selectFromRecord });

    const result = await runToolContract(searchWorksTool, {
      query: 'q',
      fields: ['license'],
      rows: 1,
    });

    expect(selected()).toEqual(['DOI', 'license']);
    expect(firstWork(result)).toEqual({
      doi: '10.1038/s41586-020-2649-2',
      licenses: [
        {
          url: 'https://creativecommons.org/licenses/by/4.0',
          contentVersion: 'vor',
          delayInDays: 0,
          start: '2020-09-16T00:00:00Z',
        },
      ],
    });
    expect(textOf(result)).toContain(
      '\n\n**Licenses:**\n- https://creativecommons.org/licenses/by/4.0 [vor] (0d embargo) — starts 2020-09-16T00:00:00Z\n',
    );
  });

  it('returns doi and links alone under fields ["link"]', async () => {
    http.route({ match: WORKS, respond: selectFromRecord });

    const result = await runToolContract(searchWorksTool, {
      query: 'q',
      fields: ['link'],
      rows: 1,
    });

    expect(selected()).toEqual(['DOI', 'link']);
    expect(firstWork(result)).toEqual({
      doi: '10.1038/s41586-020-2649-2',
      links: [
        {
          url: 'https://www.nature.com/articles/s41586-020-2649-2.pdf',
          contentType: 'application/pdf',
          contentVersion: 'vor',
          intendedApplication: 'text-mining',
        },
      ],
    });
    expect(textOf(result)).toContain(
      '\n\n**Full-text links:**\n- https://www.nature.com/articles/s41586-020-2649-2.pdf (application/pdf) [text-mining] [vor]\n',
    );
  });

  it('omits all three, field and line, from a work that deposits none of them', async () => {
    http.route({ match: WORKS, respond: () => workList([{ DOI: '10.5555/sparse' }]) });

    const result = await runToolContract(searchWorksTool, {
      query: 'q',
      fields: ['funder', 'license', 'link'],
      rows: 1,
    });

    expect(selected()).toEqual(['DOI', 'funder', 'license', 'link']);
    expect(firstWork(result)).toEqual({ doi: '10.5555/sparse' });
    expect(textOf(result)).not.toMatch(/Funders|Licenses|Full-text links/);
  });

  /**
   * The three are opt-in: a page that names no fields asks Crossref for none of them, and reads
   * none of them off a record that carries them anyway.
   */
  it.each([
    ['fields omitted', {}],
    ['fields empty', { fields: [] }],
    ['a selection naming none of the three', { fields: ['DOI', 'title'] }],
  ])(
    'returns no funders, licenses, or links with %s, whatever the record carries',
    async (_, extra) => {
      http.route({ match: WORKS, respond: () => workList([{ ...RECORD, title: ['T'] }]) });

      const result = await runToolContract(searchWorksTool, {
        query: 'q',
        rows: 1,
        ...extra,
      } as never);

      const work = firstWork(result);
      for (const key of ['funders', 'funderCount', 'licenses', 'links']) {
        expect(work).not.toHaveProperty(key);
      }
      expect(textOf(result)).not.toMatch(/Funders|Licenses|Full-text links/);
    },
  );

  /** `10.1103/physrevd.107.l091102` deposits 381 funders; the summary carries the first 25. */
  it('cuts a funder list at 25, reporting the deposited total and the route to the rest on both surfaces', async () => {
    const doi = '10.1103/physrevd.107.l091102';
    http.route({ match: WORKS, respond: () => workList([{ DOI: doi, funder: makeFunders(381) }]) });

    const result = await runToolContract(searchWorksTool, {
      filter: { doi },
      fields: ['DOI', 'funder'],
      rows: 1,
    });

    const work = firstWork(result) as { funders: { name: string }[]; funderCount: number };
    expect(work.funderCount).toBe(381);
    expect(work.funders).toHaveLength(25);
    expect(work.funders.map((f) => f.name)).toEqual(
      Array.from({ length: 25 }, (_, i) => `Funder ${i}`),
    );
    const notice =
      'Funder lists were capped at 25 per work — 1 of the 1 work on this page carries more funders than are shown. Each work reports its full deposited total as funderCount; call crossref_get_work with that work doi for its whole funder list.';
    expect((result.structuredContent as { notice?: string }).notice).toBe(notice);
    const text = textOf(result);
    expect(text).toContain(notice);
    expect(text).toContain(
      `**Funders:** showing 25 of 381; call crossref_get_work with doi ${doi} for the whole list\n- Funder 0 — 10.13039/501100000 (AWARD-0)`,
    );
    expect(text).toContain('- Funder 24 — 10.13039/5011000024 (AWARD-24)');
    expect(text).not.toContain('Funder 25');
  });

  it('renders no block on an empty page, leaving the empty-page notice to lead content[]', async () => {
    http.route({ match: WORKS, respond: () => workList([], 0) });

    const result = await runToolContract(searchWorksTool, {
      query: 'q',
      fields: ['funder', 'license', 'link'],
      rows: 1,
    });

    expect((result.structuredContent as { works: unknown[] }).works).toEqual([]);
    expect((result.structuredContent as { notice?: string }).notice).toBe(
      'No results matched the query. Try broadening the search terms or removing filters.',
    );
    expect(textOf(result)).not.toMatch(/Funders|Licenses|Full-text links|capped/);
  });

  it('keeps a list of exactly 25 whole, with no cut claimed', async () => {
    http.route({
      match: WORKS,
      respond: () => workList([{ DOI: '10.5555/w25', funder: makeFunders(25) }]),
    });

    const result = await runToolContract(searchWorksTool, {
      query: 'q',
      fields: ['funder'],
      rows: 1,
    });

    const work = firstWork(result) as { funders: unknown[]; funderCount: number };
    expect(work.funders).toHaveLength(25);
    expect(work.funderCount).toBe(25);
    expect((result.structuredContent as { notice?: string }).notice).toBeUndefined();
    expect(textOf(result)).toContain('**Funders:**\n- Funder 0');
    expect(textOf(result)).not.toContain('showing');
  });

  /**
   * Each list is a section of its own at the end of its work's block, opened by a blank line, and
   * the block's closing blank line ends it — so the next work's heading is never read into the
   * last bullet, and every bullet stays an item of its own list.
   */
  it('renders each list as its own section, closed before the next work', async () => {
    http.route({
      match: WORKS,
      respond: () =>
        workList([
          { ...RECORD, title: ['First'], abstract: '<jats:p>Text.</jats:p>' },
          { ...RECORD, DOI: '10.5555/second', title: ['Second'] },
        ]),
    });

    const result = await runToolContract(searchWorksTool, {
      query: 'q',
      fields: ['title', 'abstract', 'funder', 'license', 'link'],
      rows: 2,
    });

    const kinds: string[] = [];
    const walker = new Parser().parse(textOf(result)).walker();
    for (let step = walker.next(); step; step = walker.next()) {
      if (step.entering) kinds.push(step.node.type);
    }
    expect(kinds.filter((kind) => kind === 'heading')).toHaveLength(2);
    expect(kinds.filter((kind) => kind === 'list')).toHaveLength(6);
    expect(kinds.filter((kind) => kind === 'item')).toHaveLength(8);
    expect(textOf(result)).toContain('**Abstract:** Text.\n\n**Funders:**');
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
    select: DEFAULT_SELECT,
    worksPath: '/works',
    setup: () => {},
    run: () => runToolContract(searchWorksTool, { query: 'q', rows: RECORDS.length }),
  },
  'crossref_search_works naming every field': {
    select: ACCEPTED,
    worksPath: '/works',
    setup: () => {},
    run: () =>
      runToolContract(searchWorksTool, {
        query: 'q',
        fields: ACCEPTED,
        rows: RECORDS.length,
      } as never),
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
