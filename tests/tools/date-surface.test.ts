/**
 * @fileoverview One publication date, four tools. Each of them resolves it from the same record
 * through the same chain, and the one shape that separates the two possible orders — a source
 * Crossref deposited holding only unknown components, in front of one that names a date — is
 * driven here over every tool that carries a date, on both result surfaces. A tool that reads
 * the chain its own way fails here rather than answering a different date than its neighbour.
 *
 * The last case is what makes that hold for a tool nobody has written yet: every definition
 * whose output declares a publication date has to be driven by this file.
 * @module tests/tools/date-surface.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/crossref/crossref-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/crossref/crossref-service.js')>();
  return { ...actual, getCrossrefService: vi.fn() };
});

import { getWorkTool } from '@/mcp-server/tools/definitions/get-work.tool.js';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import { searchFundersTool } from '@/mcp-server/tools/definitions/search-funders.tool.js';
import { searchJournalsTool } from '@/mcp-server/tools/definitions/search-journals.tool.js';
import { searchWorksTool } from '@/mcp-server/tools/definitions/search-works.tool.js';
import { getCrossrefService } from '@/services/crossref/crossref-service.js';

/**
 * A record deposited the way the divergence needs: the preferred source present but holding
 * only a component Crossref does not know, a real date in the source behind it, and further
 * sources behind that one carrying different dates — so a tool that stops in the wrong place
 * reports a date this file can name, not merely a missing one.
 */
function divergentWork() {
  return {
    DOI: '10.1000/divergent',
    type: 'journal-article',
    title: ['A work whose preferred date names nothing'],
    published: { 'date-parts': [[null]] },
    'published-print': { 'date-parts': [[2020, 5]] },
    'published-online': { 'date-parts': [[2021, 1, 9]] },
    issued: { 'date-parts': [[1999]] },
  };
}

/** What every surface has to answer with: the first source in the chain that names a date. */
const RESOLVED = { year: 2020, month: 5 };
/** The same date as `formatDateParts` renders it into a Markdown line. */
const RENDERED = '2020-05';
/** Dates reachable from the record that no tool may answer with. */
const WRONG = ['2021-01-09', '1999'];

const service = {
  getWork: vi.fn(),
  searchWorks: vi.fn(),
  searchJournals: vi.fn(),
  searchFunders: vi.fn(),
  getJournalWorks: vi.fn(),
  getFunderWorks: vi.fn(),
};

beforeEach(() => {
  for (const fn of Object.values(service)) fn.mockReset();
  vi.mocked(getCrossrefService).mockReturnValue(
    service as unknown as ReturnType<typeof getCrossrefService>,
  );
});

const worksPage = { totalResults: 1, itemsPerPage: 1, items: [divergentWork()] };

/** Every tool that resolves a publication date, with the upstream shape each one reads. */
const SURFACES: Array<{ name: string; arrange: () => void; run: () => Promise<unknown> }> = [
  {
    name: 'crossref_get_work',
    arrange: () => service.getWork.mockResolvedValue(divergentWork()),
    run: () => runToolContract(getWorkTool, { doi: '10.1000/divergent' }),
  },
  {
    name: 'crossref_search_works',
    arrange: () => service.searchWorks.mockResolvedValue(worksPage),
    run: () => runToolContract(searchWorksTool, { query: 'divergent' }),
  },
  {
    name: 'crossref_search_journals',
    arrange: () => {
      service.searchJournals.mockResolvedValue({
        totalResults: 1,
        items: [
          {
            title: 'Journal of Unknown Components',
            'ISSN-L': '1234-5678',
            ISSN: ['1234-5678'],
            counts: { 'total-dois': 1 },
          },
        ],
      });
      service.getJournalWorks.mockResolvedValue(worksPage);
    },
    run: () => runToolContract(searchJournalsTool, { issn: '1234-5678', include_works: true }),
  },
  {
    name: 'crossref_search_funders',
    arrange: () => {
      service.searchFunders.mockResolvedValue({
        totalResults: 1,
        items: [{ id: '100000001', name: 'A Funder', 'work-count': 1 }],
      });
      service.getFunderWorks.mockResolvedValue(worksPage);
    },
    run: () => runToolContract(searchFundersTool, { funder_doi: '100000001', include_works: true }),
  },
];

/** Every `published` object anywhere in a result payload, however deeply a tool nests it. */
function publishedValues(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(publishedValues);
  if (value === null || typeof value !== 'object') return [];
  const found: unknown[] = [];
  for (const [key, child] of Object.entries(value)) {
    if (key === 'published') found.push(child);
    else found.push(...publishedValues(child));
  }
  return found;
}

describe('the publication date every tool resolves', () => {
  for (const surface of SURFACES) {
    /**
     * The preferred source is present and states nothing, which is the same fact an absent
     * field states. Reading its presence as an answer — selecting the source object and
     * parsing once — reports no date at all for this record.
     */
    it(`${surface.name} falls through a source with only unknown components`, async () => {
      surface.arrange();
      const result = (await surface.run()) as {
        content: Array<{ text?: string }>;
        structuredContent: unknown;
      };
      const text = result.content.map((block) => block.text ?? '').join('\n');
      const dates = publishedValues(result.structuredContent);

      expect(dates.length).toBeGreaterThan(0);
      for (const date of dates) expect(date).toMatchObject(RESOLVED);
      expect(text).toContain(RENDERED);
    });

    /**
     * The other half of the rule: the chain advances on nothing, never on less. The record's
     * later sources each name a date of their own, and none of them is this work's.
     */
    it(`${surface.name} stops at the first source that names a date`, async () => {
      surface.arrange();
      const result = (await surface.run()) as {
        content: Array<{ text?: string }>;
        structuredContent: unknown;
      };
      const text = result.content.map((block) => block.text ?? '').join('\n');

      for (const wrong of WRONG) expect(text, surface.name).not.toContain(wrong);
      for (const date of publishedValues(result.structuredContent)) {
        expect(date).not.toMatchObject({ year: 2021 });
        expect(date).not.toMatchObject({ year: 1999 });
      }
    });
  }

  /**
   * The cases above pin the four tools that carry a date today. This is what pins the fifth:
   * a definition whose output declares one and that nothing here drives would resolve it
   * unwatched, which is how the two orders came to disagree in the first place.
   */
  it('drives every tool whose output declares a publication date', () => {
    const declaring = allToolDefinitions
      .filter((definition) =>
        JSON.stringify(z.toJSONSchema(definition.output, { io: 'output' })).includes('"published"'),
      )
      .map((definition) => definition.name);

    expect(new Set(declaring)).toEqual(new Set(SURFACES.map((surface) => surface.name)));
  });
});
