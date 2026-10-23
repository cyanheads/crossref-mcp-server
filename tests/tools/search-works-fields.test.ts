/**
 * @fileoverview `crossref_search_works.fields` — the `select=` projection. Every name the input
 * accepts has an output field on both result surfaces, so a selection is never fetched and then
 * discarded; any other name is refused by the schema before a request is made. Driven through
 * the real `CrossrefService` behind a fetch fake, so the `select=` that leaves the server and the
 * projection of what comes back are both the production code.
 * @module tests/tools/search-works-fields.test
 */

import { readFileSync } from 'node:fs';
import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { textOf, workList } from '../helpers/crossref-responses.js';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn().mockReturnValue({
    mailto: 'test@example.com',
    baseUrl: 'https://api.crossref.test',
    timeoutMs: 10_000,
  }),
}));

import { searchWorksTool } from '@/mcp-server/tools/definitions/index.js';
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
});
