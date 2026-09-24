/**
 * @fileoverview `crossref_search_works.fields` — the `select=` projection. Every name the input
 * accepts has an output field on both result surfaces, so a selection is never fetched and then
 * discarded; any other name is refused by the schema before a request is made. Driven through
 * the real `CrossrefService` behind a fetch fake, so the `select=` that leaves the server and the
 * projection of what comes back are both the production code.
 * @module tests/tools/search-works-fields.test
 */

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
