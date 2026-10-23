/**
 * @fileoverview Tests for the crossref_get_references tool.
 * @module tests/tools/get-references.tool.test
 */

import { JsonRpcErrorCode, requestCancelled } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { HtmlRenderer, Parser } from 'commonmark';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getReferencesTool } from '@/mcp-server/tools/definitions/get-references.tool.js';
import { blockText } from '../helpers/content.js';

// Mock the service module so tests never hit the network
vi.mock('@/services/crossref/crossref-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/crossref/crossref-service.js')>();
  return {
    ...actual,
    getCrossrefService: vi.fn(),
  };
});

import { getCrossrefService } from '@/services/crossref/crossref-service.js';

const mockGetWork = vi.fn();
const mockLookup = vi.fn();

beforeEach(() => {
  vi.mocked(getCrossrefService).mockReturnValue({
    getWork: mockGetWork,
    getRegistrationAgency: mockLookup,
  } as unknown as ReturnType<typeof getCrossrefService>);
  mockGetWork.mockReset();
  mockLookup.mockReset();
  mockLookup.mockResolvedValue({ kind: 'unknown' });
});

/** What a CommonMark reader shows for a Markdown document, as HTML. */
function commonmark(markdown: string): string {
  return new HtmlRenderer().render(new Parser().parse(markdown));
}

const REF_LIST = [
  {
    key: 'ref1',
    DOI: '10.1000/ref1',
    unstructured: 'Smith J. 2010. A paper. Nature.',
    author: 'Smith',
    year: '2010',
    'article-title': 'A paper',
    'journal-title': 'Nature',
    volume: '42',
    'first-page': '100',
    ISSN: 'https://id.crossref.org/issn/1234-5678',
    'issn-type': 'print',
  },
  { key: 'ref2', unstructured: 'Jones B. 2015. Another paper.' },
];

describe('getReferencesTool', () => {
  it('returns the reference list for a valid DOI', async () => {
    const ctx = createMockContext({ errors: getReferencesTool.errors });
    mockGetWork.mockResolvedValue({
      DOI: '10.1038/nature12373',
      type: 'journal-article',
      reference: REF_LIST,
    });

    const input = getReferencesTool.input.parse({ doi: '10.1038/nature12373' });
    const result = await getReferencesTool.handler(input, ctx);

    expect(result.doi).toBe('10.1038/nature12373');
    expect(result.referenceCount).toBe(2);
    expect(result.references[0]?.doi).toBe('10.1000/ref1');
    expect(result.references[0]?.key).toBe('ref1');
    expect(result.references[0]?.author).toBe('Smith');
    expect(result.references[1]?.unstructured).toBe('Jones B. 2015. Another paper.');
  });

  it('projects every reference field — journalTitle, articleTitle, volume, firstPage, issn', async () => {
    const ctx = createMockContext({ errors: getReferencesTool.errors });
    mockGetWork.mockResolvedValue({
      DOI: '10.1038/nature12373',
      type: 'journal-article',
      reference: [REF_LIST[0]],
    });

    const input = getReferencesTool.input.parse({ doi: '10.1038/nature12373' });
    const result = await getReferencesTool.handler(input, ctx);

    const ref = result.references[0];
    expect(ref?.journalTitle).toBe('Nature');
    expect(ref?.articleTitle).toBe('A paper');
    expect(ref?.volume).toBe('42');
    expect(ref?.firstPage).toBe('100');
    expect(ref?.issn).toBe('1234-5678');
    expect(ref?.year).toBe('2010');
  });

  it('decodes entities and collapses whitespace in reference free text', async () => {
    const ctx = createMockContext({ errors: getReferencesTool.errors });
    mockGetWork.mockResolvedValue({
      DOI: '10.1038/nature12373',
      type: 'journal-article',
      reference: [
        {
          key: 'r1',
          unstructured: 'Users&apos; guides to the\n     medical literature',
          author: 'Guyatt &amp; Rennie',
          'article-title': 'Protocols &amp; work in progress',
          'journal-title': 'J. Clin.\nEpidemiol.',
        },
      ],
    });

    const input = getReferencesTool.input.parse({ doi: '10.1038/nature12373' });
    const result = await getReferencesTool.handler(input, ctx);

    const ref = result.references[0];
    expect(ref?.unstructured).toBe("Users' guides to the medical literature");
    expect(ref?.author).toBe('Guyatt & Rennie');
    expect(ref?.articleTitle).toBe('Protocols & work in progress');
    expect(ref?.journalTitle).toBe('J. Clin. Epidemiol.');
  });

  /**
   * The deposits behind #51: guillemets around a cited title, Greek letters in a cytokine
   * name, an umlaut in an author name. All three reach `content[]` as well as
   * `structuredContent`, since the decode happens in the handler rather than in `format()`.
   */
  it('decodes the named references a publisher deposits, on both surfaces', async () => {
    const ctx = createMockContext({ errors: getReferencesTool.errors });
    mockGetWork.mockResolvedValue({
      DOI: '10.2118/198370-ru',
      type: 'journal-article',
      reference: [
        {
          key: 'r1',
          unstructured:
            'Fan Li, Whitson C. H. (2006) &laquo;Understanding Gas Condensate Reservoir&raquo;, Oilfieald Review',
        },
        {
          key: 'r2',
          'article-title': 'Interleukin-1-&beta; (IL-1&beta;) and tumor necrosis factor',
          author: 'M&uuml;ller KH',
          'journal-title': 'Br J Cancer 8, 21&ndash;28',
        },
      ],
    });

    const input = getReferencesTool.input.parse({ doi: '10.2118/198370-ru' });
    const result = await getReferencesTool.handler(input, ctx);

    expect(result.references[0]?.unstructured).toBe(
      'Fan Li, Whitson C. H. (2006) «Understanding Gas Condensate Reservoir», Oilfieald Review',
    );
    expect(result.references[1]?.articleTitle).toBe(
      'Interleukin-1-β (IL-1β) and tumor necrosis factor',
    );
    expect(result.references[1]?.author).toBe('Müller KH');
    expect(result.references[1]?.journalTitle).toBe('Br J Cancer 8, 21–28');

    const rendered = blockText(getReferencesTool.format?.(result)[0]);
    expect(rendered).toContain('«Understanding Gas Condensate Reservoir»');
    expect(rendered).toContain('Interleukin-1-β (IL-1β)');
    expect(rendered).toContain('Müller KH');
    expect(rendered).not.toContain('&laquo;');
    expect(rendered).not.toContain('&beta;');
  });

  it('strips inline formatting markup from every free-text field', async () => {
    const ctx = createMockContext({ errors: getReferencesTool.errors });
    mockGetWork.mockResolvedValue({
      DOI: '10.1038/nature12373',
      type: 'journal-article',
      reference: [
        {
          key: 'r1',
          unstructured:
            'J. T. Beale, <em>Remarks on the breakdown of smooth solutions</em>, Comm. Math. Phys., <strong>94</strong> (1984), 61-66.',
          author: '<small>DAUVERGNE, D.</small>',
          'article-title':
            'Growth of <jats:italic>Escherichia coli</jats:italic> in H<sub>2</sub>O',
          'journal-title': '<i>Ann. Probab.</i>',
        },
      ],
    });

    const input = getReferencesTool.input.parse({ doi: '10.1038/nature12373' });
    const result = await getReferencesTool.handler(input, ctx);

    const ref = result.references[0];
    expect(ref?.unstructured).toBe(
      'J. T. Beale, Remarks on the breakdown of smooth solutions, Comm. Math. Phys., 94 (1984), 61-66.',
    );
    expect(ref?.author).toBe('DAUVERGNE, D.');
    expect(ref?.articleTitle).toBe('Growth of Escherichia coli in H2O');
    expect(ref?.journalTitle).toBe('Ann. Probab.');
  });

  /**
   * The strip is bounded by an element-name allow-list precisely so these survive. Each is
   * text a reader needs, written in the syntax a blanket strip would read as a tag — and a
   * deleted citation URL is a worse failure than an unrecognized tag left in place.
   */
  it('leaves a bracketed URL, a link, and a bare-name bracket in place', async () => {
    const ctx = createMockContext({ errors: getReferencesTool.errors });
    mockGetWork.mockResolvedValue({
      DOI: '10.1038/nature12373',
      type: 'journal-article',
      reference: [
        {
          key: 'r1',
          unstructured:
            'FAOSTAT, (verified December 2008). <http://faostat.fao.org/site/291/default.aspx>.',
        },
        {
          key: 'r2',
          unstructured:
            'Preprint, <a href="http://arxiv.org/abs/1102.1113v1" target="_blank">arXiv:1102.1113v1</a>.',
        },
        { key: 'r3', unstructured: 'EPA standards, <www.ecfr.gov>, as of May 27, 2014.' },
        {
          key: 'r4',
          unstructured:
            'PCNE classification. Available from <uri>https://www.pcne.org/upload/417.pdf</uri>.',
        },
        {
          key: 'r5',
          unstructured: 'Website <The Internet Movie DataBase, http://www.imdb.com/>, Nov 2012.',
        },
      ],
    });

    const input = getReferencesTool.input.parse({ doi: '10.1038/nature12373' });
    const result = await getReferencesTool.handler(input, ctx);

    expect(result.references[0]?.unstructured).toContain(
      '<http://faostat.fao.org/site/291/default.aspx>',
    );
    expect(result.references[1]?.unstructured).toContain(
      '<a href="http://arxiv.org/abs/1102.1113v1" target="_blank">',
    );
    expect(result.references[2]?.unstructured).toContain('<www.ecfr.gov>');
    // A `<uri>` with no attribute holds nothing a reader can lose, so its tags come out and
    // the URL it wraps is left standing on its own.
    expect(result.references[3]?.unstructured).toBe(
      'PCNE classification. Available from https://www.pcne.org/upload/417.pdf.',
    );
    expect(result.references[4]?.unstructured).toContain(
      '<The Internet Movie DataBase, http://www.imdb.com/>',
    );
  });

  /**
   * Three deposits the allow-list did not name at first: a styling span, the Elsevier and IEEE
   * spelling of a subscript, and a whole JATS citation deposited into a free-text field. None
   * carries anything in an attribute, so the constraint that keeps a link's tag in place does
   * not argue for keeping these. Values as deposited on 10.1016/j.crvi.2009.11.007 ref[8],
   * 10.1109/77.621808 ref[3], and 10.2118/198370-ru ref[0].
   */
  it('strips styling spans, the inf subscript, and a structured citation envelope', async () => {
    const ctx = createMockContext({ errors: getReferencesTool.errors });
    mockGetWork.mockResolvedValue({
      DOI: '10.1038/nature12373',
      type: 'journal-article',
      reference: [
        {
          key: 'r1',
          'journal-title':
            'Les sciences de la vie au <span class="smallcaps">xvii</span><sup>e</sup> et <span class="smallcaps">xviii</span><sup>e</sup> siècles',
        },
        {
          key: 'r2',
          'article-title':
            'development of a heart monitoring system with high T<inf>c</inf>-dc-SQUID gradiometers',
        },
        {
          key: 'r3',
          unstructured:
            '<mixed-citation publication-type="journal"><person-group person-group-type="author"><string-name><surname>Fan</surname> <given-names>Li</given-names></string-name>., <string-name><surname>Whitson</surname> <given-names>C. H.</given-names></string-name></person-group> (<year>2006</year>) <article-title>Understanding Gas Condensate Reservoir</article-title>, <source />Oilfield Review, <comment>Winter, 2005/2006</comment>;</mixed-citation>',
        },
      ],
    });

    const input = getReferencesTool.input.parse({ doi: '10.1038/nature12373' });
    const result = await getReferencesTool.handler(input, ctx);

    expect(result.references[0]?.journalTitle).toBe(
      'Les sciences de la vie au xviie et xviiie siècles',
    );
    expect(result.references[1]?.articleTitle).toBe(
      'development of a heart monitoring system with high Tc-dc-SQUID gradiometers',
    );
    expect(result.references[2]?.unstructured).toBe(
      'Fan Li., Whitson C. H. (2006) Understanding Gas Condensate Reservoir, Oilfield Review, Winter, 2005/2006;',
    );
  });

  /**
   * Reference strings are publisher-deposited citations, not a JATS surface. The angle
   * brackets that appear there are content — a Miller index, a DOI fragment, a bracketed
   * acronym — so the blanket strip the title fields get must not reach this one; the
   * element-name allow-list is what keeps all three of these out of its reach.
   */
  it('leaves angle-bracketed content in reference text intact', async () => {
    const ctx = createMockContext({ errors: getReferencesTool.errors });
    mockGetWork.mockResolvedValue({
      DOI: '10.1038/nature12373',
      type: 'journal-article',
      reference: [
        { key: 'r1', unstructured: 'International <IR> Framework. Value Reporting Foundation.' },
        { key: 'r2', unstructured: 'Silicon <100> nanowires. Phys. Rev. Lett. 94, 26805 (2005)' },
        { key: 'r3', unstructured: '10.1002/(SICI)1097-461X(1998)66:2<131::AID-QUA4>3.0.CO;2-W' },
      ],
    });

    const input = getReferencesTool.input.parse({ doi: '10.1038/nature12373' });
    const result = await getReferencesTool.handler(input, ctx);

    expect(result.references[0]?.unstructured).toContain('<IR>');
    expect(result.references[1]?.unstructured).toContain('<100>');
    expect(result.references[2]?.unstructured).toContain('<131::AID-QUA4>');

    /**
     * Those three survive the strip and then meet a renderer. `<IR>` is an element name and
     * would be consumed as an unknown tag, so it is escaped; the other two are no more
     * tag-shaped to a renderer than they were to the strip, so they reach `content[]`
     * byte-exact.
     */
    const text = blockText(getReferencesTool.format!(result)[0]);
    expect(text).toContain('International \\<IR> Framework');
    expect(text).toContain('Silicon <100> nanowires');
    expect(text).toContain('66:2<131::AID-QUA4>3.0.CO;2-W');
  });

  /**
   * What a deliberately-kept bracket looks like to a Markdown reader: the whole tag, address
   * included. Left raw, a renderer consumes `<a …>` and shows `arXiv:1102.1113v1` alone — the
   * address the keep exists to protect, lost on exactly the occurrences the rule works hardest
   * to preserve.
   */
  it('carries a kept link and a bracketed URL onto content[] whole', async () => {
    const ctx = createMockContext({ errors: getReferencesTool.errors });
    mockGetWork.mockResolvedValue({
      DOI: '10.3934/dcds.2013.33.2211',
      reference: [
        {
          key: 'r1',
          unstructured:
            'Preprint, <a href="http://arxiv.org/abs/1102.1113v1">arXiv:1102.1113v1</a>.',
        },
        { key: 'r2', unstructured: 'FAOSTAT. <http://faostat.fao.org/site/291/default.aspx>.' },
      ],
    });

    const input = getReferencesTool.input.parse({ doi: '10.3934/dcds.2013.33.2211' });
    const result = await getReferencesTool.handler(input, ctx);
    const text = blockText(getReferencesTool.format!(result)[0]);

    expect(result.references[0]?.unstructured).toContain(
      '<a href="http://arxiv.org/abs/1102.1113v1">',
    );
    expect(text).toContain('\\<a href="http://arxiv.org/abs/1102.1113v1">arXiv:1102.1113v1\\</a>');
    expect(text).toContain('\\<http://faostat.fao.org/site/291/default.aspx>');
  });

  /**
   * The other half of the same boundary: `format()` wraps a journal title in `*…*`, so a title
   * carrying an asterisk of its own used to close the emphasis early and take the marker with
   * it. Every deposited field on the line is escaped, so the server's own markup is the only
   * markup on it.
   */
  it('keeps a metacharacter in a rendered field from closing the markup around it', async () => {
    const ctx = createMockContext({ errors: getReferencesTool.errors });
    mockGetWork.mockResolvedValue({
      DOI: '10.1000/probe',
      reference: [
        {
          key: 'r1',
          'journal-title': 'Proc. SPIE 9*',
          'article-title': 'Imaging `at` scale',
          author: 'A*STAR consortium',
        },
      ],
    });

    const input = getReferencesTool.input.parse({ doi: '10.1000/probe' });
    const result = await getReferencesTool.handler(input, ctx);
    const text = blockText(getReferencesTool.format!(result)[0]);

    expect(result.references[0]?.journalTitle).toBe('Proc. SPIE 9*');
    expect(text).toContain('*Proc. SPIE 9\\**');
    expect(text).toContain('Imaging \\`at\\` scale');
    expect(text).toContain('A\\*STAR consortium');
  });

  /**
   * A reference's volume and first page are strings the publisher typed, rendered on the same
   * line as the escaped citation fields around them, and they take the same escape.
   */
  it('escapes a deposited volume and first page on content[]', async () => {
    mockGetWork.mockResolvedValue({
      DOI: '10.1000/probe',
      reference: [{ key: 'r1', volume: '3 *Suppl*', 'first-page': '<i>e1</i>' }],
    });

    const result = await runToolContract(getReferencesTool, { doi: '10.1000/probe' });
    const html = result.content.map((block) => commonmark(blockText(block))).join('');

    expect(result.structuredContent).toMatchObject({
      references: [{ key: 'r1', volume: '3 *Suppl*', firstPage: '<i>e1</i>' }],
    });
    expect(html).toContain('3 *Suppl*:&lt;i&gt;e1&lt;/i&gt;');
    expect(html).not.toContain('<em>');
  });

  it('handles reference with only unstructured field', async () => {
    const ctx = createMockContext({ errors: getReferencesTool.errors });
    mockGetWork.mockResolvedValue({
      DOI: '10.1038/nature12373',
      type: 'journal-article',
      reference: [{ unstructured: 'Minimal citation string only.' }],
    });

    const input = getReferencesTool.input.parse({ doi: '10.1038/nature12373' });
    const result = await getReferencesTool.handler(input, ctx);

    expect(result.referenceCount).toBe(1);
    expect(result.references[0]?.unstructured).toBe('Minimal citation string only.');
    expect(result.references[0]?.doi).toBeUndefined();
    expect(result.references[0]?.key).toBeUndefined();
  });

  it('throws doi_not_found when service returns null', async () => {
    const ctx = createMockContext({ errors: getReferencesTool.errors });
    mockGetWork.mockResolvedValue(null);

    const input = getReferencesTool.input.parse({ doi: '10.9999/nonexistent' });
    await expect(getReferencesTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'doi_not_found' },
    });
  });

  /**
   * The message, hint, and agency for each registry answer are tabled once in
   * registration-agency.test.ts; these pin that this tool's not-found branch asks, with the
   * unwrapped DOI, and keeps its own declared recovery when the answer is unreadable.
   */
  describe('not-found answer, by registration agency', () => {
    const RECOVERY =
      'Verify the DOI is correct or use crossref_search_works to find the work by title or author.';

    async function notFound(doi: string) {
      mockGetWork.mockResolvedValue(null);
      const result = await runToolContract(getReferencesTool, { doi });
      const { error } = result.structuredContent as {
        error: { code: number; message: string; data: Record<string, unknown> };
      };
      return { error, text: result.content.map(blockText).join('\n') };
    }

    it('keeps the message and recovery exactly as before when the registry gives no readable answer', async () => {
      const { error, text } = await notFound('10.9999/nonexistent');

      expect(error.message).toBe('No Crossref record for DOI: 10.9999/nonexistent');
      expect(error.data).toMatchObject({
        reason: 'doi_not_found',
        doi: '10.9999/nonexistent',
        recovery: { hint: RECOVERY },
      });
      expect(error.data).not.toHaveProperty('registrationAgency');
      expect(text).toContain(
        `Error: No Crossref record for DOI: 10.9999/nonexistent\n\nRecovery: ${RECOVERY}`,
      );
    });

    it('names the agency that holds a DOI Crossref does not, looking up the unwrapped DOI', async () => {
      mockLookup.mockResolvedValue({ kind: 'registered', agency: 'DataCite' });
      const { error, text } = await notFound('doi:10.5281/zenodo.3242074');

      const message =
        'No Crossref record for DOI: 10.5281/zenodo.3242074 — it is registered with DataCite, not Crossref.';
      const hint =
        "No Crossref tool can return a DOI registered with DataCite; query DataCite's metadata service for it.";
      expect(mockLookup).toHaveBeenCalledWith('10.5281/zenodo.3242074', expect.anything());
      expect(error.message).toBe(message);
      expect(error.data).toMatchObject({
        reason: 'doi_not_found',
        doi: '10.5281/zenodo.3242074',
        registrationAgency: 'DataCite',
        recovery: { hint },
      });
      expect(text).toContain(`Error: ${message}\n\nRecovery: ${hint}`);
    });

    it('keeps its own declared advice ahead of the Funder Registry pointer for a Crossref DOI', async () => {
      mockLookup.mockResolvedValue({ kind: 'registered', agency: 'Crossref' });
      const { error } = await notFound('10.13039/100000001');

      expect(error.data).toMatchObject({
        registrationAgency: 'Crossref',
        recovery: {
          hint: `${RECOVERY} A Funder Registry DOI (10.13039/…) is looked up with crossref_search_funders funder_doi.`,
        },
      });
    });

    it('propagates caller cancellation during the lookup instead of the not-found answer', async () => {
      mockGetWork.mockResolvedValue(null);
      mockLookup.mockRejectedValue(requestCancelled('DOI registry lookup cancelled by caller.'));
      const ctx = createMockContext({ errors: getReferencesTool.errors });

      await expect(
        getReferencesTool.handler(
          getReferencesTool.input.parse({ doi: '10.5281/zenodo.3242074' }),
          ctx,
        ),
      ).rejects.toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
    });

    it('asks the registry nothing when Crossref returns the work', async () => {
      mockGetWork.mockResolvedValue({ DOI: '10.1038/nature12373', reference: REF_LIST });

      await runToolContract(getReferencesTool, { doi: '10.1038/nature12373' });

      expect(mockLookup).not.toHaveBeenCalled();
    });
  });

  it('returns empty reference list and notice when record has empty reference array', async () => {
    const ctx = createMockContext({ errors: getReferencesTool.errors });
    mockGetWork.mockResolvedValue({
      DOI: '10.1038/nature12373',
      type: 'journal-article',
      reference: [],
    });

    const input = getReferencesTool.input.parse({ doi: '10.1038/nature12373' });
    const result = await getReferencesTool.handler(input, ctx);

    expect(result.doi).toBe('10.1038/nature12373');
    expect(result.referenceCount).toBe(0);
    expect(result.references).toHaveLength(0);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toBeDefined();
    expect(enrichment.notice).toMatch(/OpenAlex/);
  });

  it('returns empty reference list and notice when reference field is absent', async () => {
    const ctx = createMockContext({ errors: getReferencesTool.errors });
    mockGetWork.mockResolvedValue({ DOI: '10.1038/nature12373', type: 'journal-article' });

    const input = getReferencesTool.input.parse({ doi: '10.1038/nature12373' });
    const result = await getReferencesTool.handler(input, ctx);

    expect(result.doi).toBe('10.1038/nature12373');
    expect(result.referenceCount).toBe(0);
    expect(result.references).toHaveLength(0);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toBeDefined();
  });

  it('rejects DOI with invalid format via Zod schema', () => {
    expect(() => getReferencesTool.input.parse({ doi: 'not-a-doi' })).toThrow();
    expect(() => getReferencesTool.input.parse({ doi: '10./suffix' })).toThrow();
  });

  it('renders every reference on the page — content[] matches structuredContent', () => {
    const refs = Array.from({ length: 60 }, (_, i) => ({
      key: `ref${i}`,
      doi: `10.1000/r${i}`,
      unstructured: `Citation ${i}`,
      articleTitle: `Title ${i}`,
      year: '2020',
    }));
    const result = { doi: '10.1038/nature12373', referenceCount: 60, offset: 0, references: refs };
    const text = blockText(getReferencesTool.format!(result)[0]);

    expect(text).toContain('10.1038/nature12373');
    for (const r of refs) {
      expect(text).toContain(r.doi);
      expect(text).toContain(r.articleTitle);
      expect(text).toContain(r.unstructured);
    }
    expect(text).not.toContain('more references');
    expect(text).not.toContain('structuredContent');
  });

  it('renders long raw citation strings in full', () => {
    const unstructured = `Author A. 2020. ${'w'.repeat(400)}. Journal of Long Titles.`;
    const result = {
      doi: '10.1038/nature12373',
      referenceCount: 1,
      offset: 0,
      references: [{ key: 'r1', unstructured }],
    };
    const text = blockText(getReferencesTool.format!(result)[0]);

    expect(text).toContain(unstructured);
  });

  it('numbers references by absolute position when rendering a later page', () => {
    const result = {
      doi: '10.1038/nature12373',
      referenceCount: 250,
      offset: 100,
      references: [{ key: 'r101', articleTitle: 'Page two opener' }],
    };
    const text = blockText(getReferencesTool.format!(result)[0]);

    expect(text).toContain('101. Page two opener');
    expect(text).toContain('showing 1 of 250');
  });

  it('pages a long reference list and discloses nextOffset', async () => {
    const ctx = createMockContext({ errors: getReferencesTool.errors });
    const reference = Array.from({ length: 250 }, (_, i) => ({
      key: `ref${i}`,
      unstructured: `Citation ${i}`,
    }));
    mockGetWork.mockResolvedValue({ DOI: '10.1038/big', type: 'journal-article', reference });

    const input = getReferencesTool.input.parse({ doi: '10.1038/big' });
    const result = await getReferencesTool.handler(input, ctx);

    expect(result.referenceCount).toBe(250);
    expect(result.offset).toBe(0);
    expect(result.references).toHaveLength(100);
    expect(getEnrichment(ctx)).toMatchObject({
      nextOffset: 100,
      truncated: true,
      shown: 100,
      cap: 100,
    });
    expect(getEnrichment(ctx).notice).toMatch(/offset=100/);

    /**
     * The wire payload is `output.extend(enrichment).parse({ ...result, ...enrichment })` —
     * a key missing from either schema is stripped there, not at the accumulator getEnrichment
     * reads. Parsing through the effective schema is what pins offset and the paging disclosure
     * to what a client actually receives.
     */
    const wire = getReferencesTool.output
      .extend(getReferencesTool.enrichment!)
      .parse({ ...result, ...getEnrichment(ctx) });
    expect(wire).toMatchObject({
      offset: 0,
      referenceCount: 250,
      nextOffset: 100,
      truncated: true,
      shown: 100,
      cap: 100,
    });
  });

  it('returns the requested page and omits nextOffset on the final page', async () => {
    const ctx = createMockContext({ errors: getReferencesTool.errors });
    const reference = Array.from({ length: 250 }, (_, i) => ({
      key: `ref${i}`,
      unstructured: `Citation ${i}`,
    }));
    mockGetWork.mockResolvedValue({ DOI: '10.1038/big', type: 'journal-article', reference });

    const input = getReferencesTool.input.parse({ doi: '10.1038/big', offset: 200, limit: 100 });
    const result = await getReferencesTool.handler(input, ctx);

    expect(result.offset).toBe(200);
    expect(result.references).toHaveLength(50);
    expect(result.references[0]?.key).toBe('ref200');
    expect(getEnrichment(ctx).nextOffset).toBeUndefined();
    expect(getEnrichment(ctx).truncated).toBeUndefined();
  });

  it('returns every reference in one page when the list fits under the limit', async () => {
    const ctx = createMockContext({ errors: getReferencesTool.errors });
    const reference = Array.from({ length: 60 }, (_, i) => ({ key: `ref${i}` }));
    mockGetWork.mockResolvedValue({ DOI: '10.1038/mid', type: 'journal-article', reference });

    const input = getReferencesTool.input.parse({ doi: '10.1038/mid' });
    const result = await getReferencesTool.handler(input, ctx);

    expect(result.references).toHaveLength(60);
    expect(result.referenceCount).toBe(60);
    expect(getEnrichment(ctx).nextOffset).toBeUndefined();
  });

  it('explains an offset past the end of the reference list', async () => {
    const ctx = createMockContext({ errors: getReferencesTool.errors });
    mockGetWork.mockResolvedValue({
      DOI: '10.1038/nature12373',
      type: 'journal-article',
      reference: REF_LIST,
    });

    const input = getReferencesTool.input.parse({ doi: '10.1038/nature12373', offset: 500 });
    const result = await getReferencesTool.handler(input, ctx);

    expect(result.referenceCount).toBe(2);
    expect(result.references).toHaveLength(0);
    expect(getEnrichment(ctx).notice).toMatch(/past the end/);
  });

  it('rejects a negative offset', () => {
    expect(() => getReferencesTool.input.parse({ doi: '10.1038/x1', offset: -1 })).toThrow();
  });

  it('formats output including doi, key, and raw citation', () => {
    const result = {
      doi: '10.1038/nature12373',
      referenceCount: 2,
      offset: 0,
      references: [
        {
          doi: '10.1000/ref1',
          key: 'ref1',
          unstructured: 'Smith 2010',
          articleTitle: 'A paper',
          year: '2010',
        },
        { unstructured: 'Jones 2015' },
      ],
    };
    const blocks = getReferencesTool.format!(result);
    expect(blocks[0]?.type).toBe('text');
    const text = blockText(blocks[0]);
    expect(text).toContain('10.1038/nature12373');
    expect(text).toContain('10.1000/ref1');
    expect(text).toContain('ref1');
    expect(text).toContain('Smith 2010');
    expect(text).toContain('Jones 2015');
  });

  /**
   * The same unwrapping `crossref_get_work` applies, checked here because each tool declares
   * its own `doi` field: a resolver-wrapped DOI is one DOI, so the argument is answerable as
   * sent rather than something to hand back for the caller to edit.
   */
  it('accepts a resolver-wrapped DOI and fetches the bare one', async () => {
    const ctx = createMockContext({ errors: getReferencesTool.errors });
    mockGetWork.mockResolvedValue({
      DOI: '10.1038/nature12373',
      type: 'journal-article',
      reference: REF_LIST,
    });

    const input = getReferencesTool.input.parse({ doi: 'https://doi.org/10.1038/nature12373' });
    const result = await getReferencesTool.handler(input, ctx);

    expect(mockGetWork).toHaveBeenCalledWith('10.1038/nature12373', ctx);
    expect(result.doi).toBe('10.1038/nature12373');
  });

  it('formats volume and firstPage in output', () => {
    const result = {
      doi: '10.1038/nature12373',
      referenceCount: 1,
      offset: 0,
      references: [
        {
          key: 'r1',
          articleTitle: 'Deep Learning',
          year: '2015',
          journalTitle: 'Nature',
          volume: '12',
          firstPage: '5',
        },
      ],
    };
    const blocks = getReferencesTool.format!(result);
    const text = blockText(blocks[0]);
    // Asserted as the composed segment — a bare '5' matches the year on any fixture.
    expect(text).toContain('12:5');
    expect(text).toContain('*Nature*');
  });
});

describe('getReferencesTool book, series, issue, edition, and DOI-provenance fields', () => {
  /** The content[] line for the single reference on a one-entry page. */
  async function referenceLine(reference: Record<string, unknown>[], offset = 0) {
    mockGetWork.mockResolvedValue({ DOI: '10.1000/citing', reference });
    const result = await runToolContract(getReferencesTool, { doi: '10.1000/citing', offset });
    const lines = result.content
      .map((block) => blockText(block))
      .join('\n')
      .split('\n');
    return { result, line: lines.find((l) => /^\d+\./.test(l)) };
  }

  it('renders an entry carrying none of the new keys exactly as before', async () => {
    const { result, line } = await referenceLine([
      {
        key: 'ref1',
        DOI: '10.1000/ref1',
        unstructured: 'Smith J. 2010. A paper. Nature.',
        author: 'Smith',
        year: '2010',
        'article-title': 'A paper',
        'journal-title': 'Nature',
        volume: '42',
        'first-page': '100',
      },
    ]);
    expect(line).toBe(
      '1. Smith A paper (2010) *Nature* 42:100 — DOI: 10.1000/ref1 key:ref1 | Smith J. 2010. A paper. Nature.',
    );
    expect(result.structuredContent).toMatchObject({
      references: [
        {
          key: 'ref1',
          doi: '10.1000/ref1',
          unstructured: 'Smith J. 2010. A paper. Nature.',
          author: 'Smith',
          year: '2010',
          articleTitle: 'A paper',
          journalTitle: 'Nature',
          volume: '42',
          firstPage: '100',
        },
      ],
    });
  });

  it('fills the title slot from volume-title when article-title is absent, and an empty author renders nothing', async () => {
    const { result, line } = await referenceLine(
      [
        {
          key: '2024010422244115800_oxfordhb-9780190064570-e-1-bibItem-214',
          'volume-title': 'Beyond boredom and anxiety: Experiencing flow in work and play.',
          author: '',
          year: '2000',
        },
      ],
      0,
    );
    expect(result.structuredContent).toMatchObject({
      references: [
        { volumeTitle: 'Beyond boredom and anxiety: Experiencing flow in work and play.' },
      ],
    });
    expect(line).toBe(
      '1. Beyond boredom and anxiety: Experiencing flow in work and play. (2000) key:2024010422244115800_oxfordhb-9780190064570-e-1-bibItem-214',
    );
  });

  it('falls back to volume-title when the deposited article-title is empty', async () => {
    const { line } = await referenceLine([
      { key: 'r1', 'article-title': '', 'volume-title': 'Handbook of Flow', year: '2001' },
    ]);
    expect(line).toBe('1. Handbook of Flow (2001) key:r1');
  });

  it('keeps article-title as the title and follows it with the volume title', async () => {
    const { result, line } = await referenceLine([
      {
        key: 'r1',
        author: 'Doe',
        'article-title': 'A chapter',
        'volume-title': 'The <i>Big</i> Book',
        year: '2005',
      },
    ]);
    expect(result.structuredContent).toMatchObject({
      references: [{ articleTitle: 'A chapter', volumeTitle: 'The Big Book' }],
    });
    expect(line).toBe('1. Doe A chapter In: *The Big Book* (2005) key:r1');
  });

  it('fills issn from the deposited ISSN URI and carries doi-asserted-by on both surfaces', async () => {
    const { result, line } = await referenceLine(
      [
        { key: 'skip0' },
        { key: 'skip1' },
        { key: 'skip2' },
        {
          key: '10.1149/1.2083227_r4',
          'doi-asserted-by': 'crossref',
          'first-page': '123',
          DOI: '10.1016/0165-1633(82)90014-4',
          volume: '6',
          author: 'Elwell',
          year: '1982',
          'journal-title': 'Sol. Energy Mater.',
          ISSN: 'https://id.crossref.org/issn/0165-1633',
          'issn-type': 'print',
        },
      ],
      3,
    );
    expect(result.structuredContent).toMatchObject({
      references: [{ issn: '0165-1633', doiAssertedBy: 'crossref' }],
    });
    expect(line).toBe(
      '4. Elwell [4] (1982) *Sol. Energy Mater.* 6:123 ISSN:0165-1633 — DOI: 10.1016/0165-1633(82)90014-4 (asserted by crossref) key:10.1149/1.2083227_r4',
    );
  });

  it('strips the http resolver form of the ISSN URI and keeps a bare deposited ISSN as written', async () => {
    mockGetWork.mockResolvedValue({
      DOI: '10.1000/citing',
      reference: [
        { key: 'a', ISSN: 'http://id.crossref.org/issn/1234-5679' },
        { key: 'b', ISSN: '2049-3630' },
      ],
    });
    const result = await runToolContract(getReferencesTool, { doi: '10.1000/citing' });
    expect(result.structuredContent).toMatchObject({
      references: [
        { key: 'a', issn: '1234-5679' },
        { key: 'b', issn: '2049-3630' },
      ],
    });
  });

  it('strips the ISSN URI in any letter case and trims the surrounding whitespace', async () => {
    const { result, line } = await referenceLine([
      { key: 'a', ISSN: 'HTTPS://ID.CROSSREF.ORG/ISSN/0165-1633 ' },
      { key: 'b', ISSN: ' 2049-3630\n' },
      { key: 'c', ISSN: '   ' },
    ]);
    const references = (result.structuredContent as { references: Array<Record<string, unknown>> })
      .references;
    expect(references).toEqual([
      { key: 'a', issn: '0165-1633' },
      { key: 'b', issn: '2049-3630' },
      { key: 'c' },
    ]);
    expect(line).toBe('1. [1] ISSN:0165-1633 key:a');
  });

  it('renders issue, series, and edition beside the volume and first page', async () => {
    const { result, line } = await referenceLine([
      {
        key: 'r1',
        'volume-title': 'Quantum Fields',
        'series-title': 'Lecture Notes in <i>Physics</i>',
        volume: '12',
        issue: '3',
        'first-page': '45',
        edition: '2nd',
        year: '1999',
      },
    ]);
    expect(result.structuredContent).toMatchObject({
      references: [
        {
          volumeTitle: 'Quantum Fields',
          seriesTitle: 'Lecture Notes in Physics',
          volume: '12',
          issue: '3',
          firstPage: '45',
          edition: '2nd',
        },
      ],
    });
    expect(line).toBe(
      '1. Quantum Fields (1999) 12(3):45 series:Lecture Notes in Physics edition:2nd key:r1',
    );
  });

  it('renders an issue deposited without a volume', async () => {
    const { line } = await referenceLine([{ key: 'r1', issue: 'S1', 'first-page': '9' }]);
    expect(line).toBe('1. [1] (S1):9 key:r1');
  });

  it('escapes deposited metacharacters in the new fields on content[] only', async () => {
    const { result, line } = await referenceLine([
      {
        key: 'r1',
        'article-title': 'Main',
        'volume-title': 'Book *one*',
        'series-title': 'Series_',
        issue: '2*',
        edition: '`3`',
        DOI: '10.1000/x',
        'doi-asserted-by': 'pub*lisher',
      },
    ]);
    expect(result.structuredContent).toMatchObject({
      references: [
        {
          volumeTitle: 'Book *one*',
          seriesTitle: 'Series_',
          issue: '2*',
          edition: '`3`',
          doiAssertedBy: 'pub*lisher',
        },
      ],
    });
    expect(line).toBe(
      '1. Main In: *Book \\*one\\** (2\\*) series:Series\\_ edition:\\`3\\` — DOI: 10.1000/x (asserted by pub\\*lisher) key:r1',
    );
    // A CommonMark reader sees every deposited character, and only the volume title emphasized.
    expect(commonmark(line ?? '')).toBe(
      '<ol>\n<li>Main In: <em>Book *one*</em> (2*) series:Series_ edition:`3` — DOI: 10.1000/x (asserted by pub*lisher) key:r1</li>\n</ol>\n',
    );
  });

  it('adds no isbn, component, or issn-type field', async () => {
    mockGetWork.mockResolvedValue({
      DOI: '10.1000/citing',
      reference: [
        {
          key: 'r1',
          ISBN: 'http://id.crossref.org/isbn/9780000000002',
          'isbn-type': 'print',
          component: 'c1',
          ISSN: 'https://id.crossref.org/issn/1234-5679',
          'issn-type': 'electronic',
        },
      ],
    });
    const result = await runToolContract(getReferencesTool, { doi: '10.1000/citing' });
    expect((result.structuredContent as { references: unknown[] }).references).toEqual([
      { key: 'r1', issn: '1234-5679' },
    ]);
  });
});

describe('getReferencesTool page-size clamp', () => {
  const CLAMP = 'limit 1000 is above the per-call cap of 500, so 500 was applied.';
  const refs = (count: number) =>
    Array.from({ length: count }, (_, i) => ({ key: `r${i}`, unstructured: `Ref ${i}.` }));

  it('clamps limit above 500: pages 500 references, reports cap 500, and advances nextOffset by the page', async () => {
    mockGetWork.mockResolvedValue({ DOI: '10.1038/nature12373', reference: refs(1200) });

    const result = await runToolContract(getReferencesTool, {
      doi: '10.1038/nature12373',
      offset: 500,
      limit: 1000,
    });

    const structured = result.structuredContent as {
      references: Array<{ key?: string }>;
      notice?: string;
    };
    expect(structured.references).toHaveLength(500);
    expect(structured.references[0]?.key).toBe('r500');
    expect(structured.references.at(-1)?.key).toBe('r999');
    expect(result.structuredContent).toMatchObject({
      truncated: true,
      shown: 500,
      cap: 500,
      nextOffset: 1000,
    });
    expect(structured.notice).toBe(
      `${CLAMP} Showing references 501–1000 of 1200. Call again with offset=1000 for the next page.`,
    );
    expect(result.content.map(blockText).join('\n')).toContain(CLAMP);
  });

  it('discloses the clamp alone on a page that holds the rest of the list', async () => {
    mockGetWork.mockResolvedValue({ DOI: '10.1038/nature12373', reference: refs(300) });

    const result = await runToolContract(getReferencesTool, {
      doi: '10.1038/nature12373',
      limit: 1000,
    });

    expect((result.structuredContent as { references: unknown[] }).references).toHaveLength(300);
    expect(result.structuredContent).not.toHaveProperty('nextOffset');
    expect((result.structuredContent as { notice?: string }).notice).toBe(CLAMP);
  });

  it('leads the empty-list and past-the-end notices with the clamp', async () => {
    mockGetWork.mockResolvedValue({ DOI: '10.1038/nature12373', reference: [] });
    const empty = await runToolContract(getReferencesTool, {
      doi: '10.1038/nature12373',
      limit: 1000,
    });
    expect((empty.structuredContent as { notice?: string }).notice).toBe(
      `${CLAMP} No reference list indexed for this work. Coverage varies by publisher and era; pre-2000 works and non-participating publishers often have no indexed references. Try OpenAlex for alternative reference data.`,
    );

    mockGetWork.mockResolvedValue({ DOI: '10.1038/nature12373', reference: refs(10) });
    const past = await runToolContract(getReferencesTool, {
      doi: '10.1038/nature12373',
      offset: 50,
      limit: 1000,
    });
    expect((past.structuredContent as { notice?: string }).notice).toBe(
      `${CLAMP} Offset 50 is past the end of this reference list (10 references). Request an offset below 10.`,
    );
  });

  it('leaves limit 500 untouched and notice-free', async () => {
    mockGetWork.mockResolvedValue({ DOI: '10.1038/nature12373', reference: refs(400) });

    const result = await runToolContract(getReferencesTool, {
      doi: '10.1038/nature12373',
      limit: 500,
    });

    expect((result.structuredContent as { references: unknown[] }).references).toHaveLength(400);
    expect((result.structuredContent as { notice?: string }).notice).toBeUndefined();
  });
});
