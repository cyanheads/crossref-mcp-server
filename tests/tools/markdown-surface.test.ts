/**
 * @fileoverview `structuredContent` and `content[]` are two surfaces over the same values, and
 * a reader of the second must not lose what a reader of the first keeps. The escape that keeps
 * them in agreement is one rule at one boundary, so this file drives it over all seven tools at
 * once: a tool that renders a deposited value without it fails here rather than in a client.
 * @module tests/tools/markdown-surface.test
 */

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { blockText } from '../helpers/content.js';

vi.mock('@/services/crossref/crossref-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/crossref/crossref-service.js')>();
  return { ...actual, getCrossrefService: vi.fn() };
});

import { getMemberTool } from '@/mcp-server/tools/definitions/get-member.tool.js';
import { getPrefixTool } from '@/mcp-server/tools/definitions/get-prefix.tool.js';
import { getReferencesTool } from '@/mcp-server/tools/definitions/get-references.tool.js';
import { getWorkTool } from '@/mcp-server/tools/definitions/get-work.tool.js';
import { searchFundersTool } from '@/mcp-server/tools/definitions/search-funders.tool.js';
import { searchJournalsTool } from '@/mcp-server/tools/definitions/search-journals.tool.js';
import { searchWorksTool } from '@/mcp-server/tools/definitions/search-works.tool.js';
import { getCrossrefService } from '@/services/crossref/crossref-service.js';

/**
 * One probe, deposited the way a publisher deposits each of its parts, chosen so that both
 * normalization passes hand back the identical string: an escaped tag survives as literal text,
 * a doubly-escaped reference survives spelled as a reference, and an asterisk is prose. It leads
 * with an ordered-list marker, which is inert everywhere but column zero — the one placement
 * where a renderer consumes it rather than showing it.
 */
const DEPOSITED = '19. Wafers &lt;p&gt; at &amp;lt; *starred*';
/** What both surfaces are about: the value normalization produced. */
const NORMALIZED = '19. Wafers <p> at &lt; *starred*';
/** The same value, with every character a renderer would take for markup made inert. */
const ESCAPED = '19. Wafers \\<p> at \\&lt; \\*starred\\*';
/**
 * The same again for a value that begins its line. A tool that renders one at column zero
 * through the inline escape alone emits a line starting with `ESCAPED` instead — which is what
 * the guard below fails on, whichever tool grows that line.
 */
const ESCAPED_AT_LINE_START = '19\\. Wafers \\<p> at \\&lt; \\*starred\\*';

const service = {
  getWork: vi.fn(),
  getMember: vi.fn(),
  getPrefix: vi.fn(),
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

/** A work record with the probe in every free-text field a tool projects out of one. */
function probeWork() {
  return {
    DOI: '10.1000/probe',
    type: 'journal-article',
    title: [DEPOSITED],
    subtitle: [DEPOSITED],
    'container-title': [DEPOSITED],
    publisher: DEPOSITED,
    abstract: DEPOSITED,
    subject: [DEPOSITED],
    published: { 'date-parts': [[2024, 1, 1]] },
    author: [{ given: DEPOSITED, family: DEPOSITED, affiliation: [{ name: DEPOSITED }] }],
    funder: [{ name: DEPOSITED }],
    reference: [
      {
        key: 'ref1',
        unstructured: DEPOSITED,
        author: DEPOSITED,
        'journal-title': DEPOSITED,
        'article-title': DEPOSITED,
      },
    ],
  };
}

const worksPage = { totalResults: 1, itemsPerPage: 1, items: [probeWork()] };

/** The `CallToolResult` every surface's `run()` resolves to — both wire surfaces in one object. */
type ToolRunResult = Awaited<ReturnType<typeof runToolContract>>;

/**
 * Every tool, with whatever upstream shape it reads, and the input that makes it render its
 * free-text fields. The journal and funder searches resolve a single record by identifier so
 * the works list is reachable without tripping the ambiguity guard.
 */
const SURFACES: Array<{ name: string; arrange: () => void; run: () => Promise<ToolRunResult> }> = [
  {
    name: 'crossref_get_work',
    arrange: () => service.getWork.mockResolvedValue(probeWork()),
    run: () => runToolContract(getWorkTool, { doi: '10.1000/probe' }),
  },
  {
    name: 'crossref_get_references',
    arrange: () => service.getWork.mockResolvedValue(probeWork()),
    run: () => runToolContract(getReferencesTool, { doi: '10.1000/probe' }),
  },
  {
    name: 'crossref_search_works',
    arrange: () => service.searchWorks.mockResolvedValue(worksPage),
    run: () => runToolContract(searchWorksTool, { query: 'probe' }),
  },
  {
    name: 'crossref_search_journals',
    arrange: () => {
      service.searchJournals.mockResolvedValue({
        totalResults: 1,
        items: [
          {
            title: DEPOSITED,
            'ISSN-L': '1234-5678',
            ISSN: ['1234-5678'],
            publisher: DEPOSITED,
            subjects: [{ name: DEPOSITED }],
            counts: { 'total-dois': 7 },
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
        items: [
          {
            id: '100000001',
            name: DEPOSITED,
            'alt-names': [DEPOSITED],
            location: DEPOSITED,
            uri: 'http://dx.doi.org/10.13039/100000001',
            'work-count': 3,
          },
        ],
      });
      service.getFunderWorks.mockResolvedValue(worksPage);
    },
    run: () => runToolContract(searchFundersTool, { funder_doi: '100000001', include_works: true }),
  },
  {
    name: 'crossref_get_member',
    arrange: () =>
      service.getMember.mockResolvedValue({
        id: 297,
        'primary-name': DEPOSITED,
        names: [DEPOSITED, `${DEPOSITED} Press`],
        location: DEPOSITED,
        prefixes: ['10.1000'],
      }),
    run: () => runToolContract(getMemberTool, { member_id: 297 }),
  },
  {
    name: 'crossref_get_prefix',
    arrange: () =>
      service.getPrefix.mockResolvedValue({
        prefix: 'http://id.crossref.org/prefix/10.1000',
        name: DEPOSITED,
        member: 'http://id.crossref.org/member/297',
      }),
    run: () => runToolContract(getPrefixTool, { prefix: '10.1000' }),
  },
];

describe('the Markdown surface of every tool', () => {
  /**
   * The structured surface carries the deposit as normalization produced it, and the Markdown
   * surface carries the same characters made inert. A single field rendered without the escape
   * puts the raw form back into `content[]` and fails the second assertion.
   */
  for (const surface of SURFACES) {
    it(`${surface.name} escapes every deposited value it renders`, async () => {
      surface.arrange();
      const result = await surface.run();
      const text = result.content.map(blockText).join('\n');

      expect(JSON.stringify(result.structuredContent)).toContain(NORMALIZED);
      expect(text).toContain(ESCAPED);
      expect(text).not.toContain(NORMALIZED);
    });
  }

  /**
   * A deposited value placed at column zero is read as a block construct, and the renderer eats
   * the marker that opened it — a heading, a quote, or a list item where the deposit held a
   * hyphen or the number of a century. Only one line on the whole surface places one there
   * today; this is what fails when the next one is written with the inline escape alone.
   */
  it('never puts a deposited value at column zero without the block escape', async () => {
    for (const surface of SURFACES) {
      surface.arrange();
      const result = await surface.run();
      const lines = result.content.flatMap((block) => blockText(block).split('\n'));
      expect(
        lines.filter((line) => line.startsWith(ESCAPED)),
        surface.name,
      ).toEqual([]);
    }
  });

  /** The one line that does place one there renders it with the marker made inert. */
  it('escapes the block marker on the abstract crossref_get_work renders at column zero', async () => {
    service.getWork.mockResolvedValue(probeWork());
    const result = await runToolContract(getWorkTool, { doi: '10.1000/probe' });
    const lines = result.content.flatMap((block) => blockText(block).split('\n'));

    expect(lines).toContain(ESCAPED_AT_LINE_START);
  });

  /**
   * The other half of the contract: the escape adds backslashes and never anything else, so
   * the two surfaces still hold the same characters.
   */
  it('adds nothing to content[] but the escapes', async () => {
    for (const surface of SURFACES) {
      surface.arrange();
      const result = await surface.run();
      const text = result.content.map(blockText).join('\n');
      expect(text.replaceAll('\\', ''), surface.name).toContain(NORMALIZED);
    }
  });
});
