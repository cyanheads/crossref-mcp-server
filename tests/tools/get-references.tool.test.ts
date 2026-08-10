/**
 * @fileoverview Tests for the crossref_get_references tool.
 * @module tests/tools/get-references.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getReferencesTool } from '@/mcp-server/tools/definitions/get-references.tool.js';

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

beforeEach(() => {
  vi.mocked(getCrossrefService).mockReturnValue({ getWork: mockGetWork } as ReturnType<
    typeof getCrossrefService
  >);
  mockGetWork.mockReset();
});

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
    issn: '1234-5678',
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

    const block = getReferencesTool.format?.(result)[0];
    const rendered = block?.type === 'text' ? block.text : '';
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
    const text = getReferencesTool.format!(result)[0]?.text ?? '';

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
    const text = getReferencesTool.format!(result)[0]?.text ?? '';

    expect(text).toContain(unstructured);
  });

  it('numbers references by absolute position when rendering a later page', () => {
    const result = {
      doi: '10.1038/nature12373',
      referenceCount: 250,
      offset: 100,
      references: [{ key: 'r101', articleTitle: 'Page two opener' }],
    };
    const text = getReferencesTool.format!(result)[0]?.text ?? '';

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

  it('rejects a limit above the 500 page ceiling', () => {
    expect(() => getReferencesTool.input.parse({ doi: '10.1038/x1', limit: 501 })).toThrow();
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
    const text = blocks[0]?.text ?? '';
    expect(text).toContain('10.1038/nature12373');
    expect(text).toContain('10.1000/ref1');
    expect(text).toContain('ref1');
    expect(text).toContain('Smith 2010');
    expect(text).toContain('Jones 2015');
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
    const text = blocks[0]?.text ?? '';
    // Asserted as the composed segment — a bare '5' matches the year on any fixture.
    expect(text).toContain('12:5');
    expect(text).toContain('*Nature*');
  });
});
