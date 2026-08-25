/**
 * @fileoverview Tests for the crossref_get_work tool.
 * @module tests/tools/get-work.tool.test
 */

import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getWorkTool } from '@/mcp-server/tools/definitions/get-work.tool.js';
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

beforeEach(() => {
  vi.mocked(getCrossrefService).mockReturnValue({ getWork: mockGetWork } as unknown as ReturnType<
    typeof getCrossrefService
  >);
  mockGetWork.mockReset();
});

/** Minimal raw Crossref work record. */
function makeRawWork(overrides: Record<string, unknown> = {}) {
  return {
    DOI: '10.1038/nature12373',
    type: 'journal-article',
    title: ['Cas9 in mammals'],
    'container-title': ['Nature'],
    publisher: 'Springer Nature',
    'is-referenced-by-count': 1500,
    'references-count': 42,
    published: { 'date-parts': [[2013, 8, 22]] },
    author: [
      {
        given: 'Le',
        family: 'Cong',
        ORCID: 'https://orcid.org/0000-0001-1234-5678',
        sequence: 'first',
      },
    ],
    abstract: 'Abstract text here.',
    ...overrides,
  };
}

/** Distinct, order-checkable author entries — `G0 F0`, `G1 F1`, … */
function makeAuthors(count: number) {
  return Array.from({ length: count }, (_, i) => ({ given: `G${i}`, family: `F${i}` }));
}

/**
 * The schema clients actually receive: domain output merged with enrichment. A key missing
 * from either is stripped here rather than at the accumulator getEnrichment reads.
 */
const wireSchema = getWorkTool.output.extend(getWorkTool.enrichment!);

describe('getWorkTool', () => {
  it('returns full metadata for a valid DOI', async () => {
    const ctx = createMockContext({ errors: getWorkTool.errors });
    mockGetWork.mockResolvedValue(makeRawWork());

    const input = getWorkTool.input.parse({ doi: '10.1038/nature12373' });
    const result = await getWorkTool.handler(input, ctx);

    expect(result.doi).toBe('10.1038/nature12373');
    expect(result.type).toBe('journal-article');
    expect(result.title).toBe('Cas9 in mammals');
    expect(result.containerTitle).toBe('Nature');
    expect(result.isReferencedByCount).toBe(1500);
    expect(result.referencesCount).toBe(42);
    expect(result.published?.year).toBe(2013);
    expect(result.published?.month).toBe(8);
    expect(result.published?.day).toBe(22);
    expect(result.authors?.[0]?.given).toBe('Le');
    expect(result.authors?.[0]?.family).toBe('Cong');
  });

  it('handles sparse upstream record — no abstract, no authors', async () => {
    const ctx = createMockContext({ errors: getWorkTool.errors });
    mockGetWork.mockResolvedValue(makeRawWork({ abstract: undefined, author: undefined }));

    const input = getWorkTool.input.parse({ doi: '10.1038/nature12373' });
    const result = await getWorkTool.handler(input, ctx);

    expect(result.abstract).toBeUndefined();
    expect(result.authors).toBeUndefined();
    // format should still work without fabricating values
    const blocks = getWorkTool.format!(result);
    expect(blockText(blocks[0])).toContain('*Not deposited*');
  });

  it('handles sparse record — no container title, no publisher, no date', async () => {
    const ctx = createMockContext({ errors: getWorkTool.errors });
    mockGetWork.mockResolvedValue(
      makeRawWork({
        'container-title': undefined,
        publisher: undefined,
        published: undefined,
        'published-print': undefined,
        'published-online': undefined,
        issued: undefined,
      }),
    );

    const input = getWorkTool.input.parse({ doi: '10.1038/nature12373' });
    const result = await getWorkTool.handler(input, ctx);

    expect(result.containerTitle).toBeUndefined();
    expect(result.publisher).toBeUndefined();
    expect(result.published).toBeUndefined();
  });

  it('normalizes funders, licenses, and links fields', async () => {
    const ctx = createMockContext({ errors: getWorkTool.errors });
    mockGetWork.mockResolvedValue(
      makeRawWork({
        funder: [{ name: 'NSF', DOI: '10.13039/100000001', award: ['DMR-0123'] }],
        license: [
          {
            URL: 'https://creativecommons.org/licenses/by/4.0/',
            'content-version': 'vor',
            'delay-in-days': 0,
          },
        ],
        link: [
          {
            URL: 'https://example.com/fulltext.pdf',
            'content-type': 'application/pdf',
            'intended-application': 'text-mining',
          },
        ],
      }),
    );

    const input = getWorkTool.input.parse({ doi: '10.1038/nature12373' });
    const result = await getWorkTool.handler(input, ctx);

    expect(result.funders?.[0]?.name).toBe('NSF');
    expect(result.funders?.[0]?.doi).toBe('10.13039/100000001');
    expect(result.funders?.[0]?.award).toEqual(['DMR-0123']);
    expect(result.licenses?.[0]?.url).toBe('https://creativecommons.org/licenses/by/4.0/');
    expect(result.licenses?.[0]?.contentVersion).toBe('vor');
    expect(result.licenses?.[0]?.delayInDays).toBe(0);
    expect(result.links?.[0]?.url).toBe('https://example.com/fulltext.pdf');
    expect(result.links?.[0]?.contentType).toBe('application/pdf');
    expect(result.links?.[0]?.intendedApplication).toBe('text-mining');
  });

  /**
   * A publisher may assert a funder through the ROR registry instead of spelling out its name,
   * and Crossref deposits exactly what it was given: an `id` array, an award number, no `name`.
   * The record has to come back, and the assertion has to stay identifiable — an entry stripped
   * to its award number names no funder at all.
   */
  it('keeps a record whose funder is asserted by ROR instead of by name', async () => {
    mockGetWork.mockResolvedValue(
      makeRawWork({
        funder: [
          {
            award: ['EP/S020527/1'],
            id: [{ id: 'https://ror.org/0439y7842', 'id-type': 'ROR', 'asserted-by': 'publisher' }],
          },
          {
            award: ['PHY-2309135'],
            id: [{ id: 'https://ror.org/021nxhr62', 'id-type': 'ROR', 'asserted-by': 'publisher' }],
          },
        ],
      }),
    );

    const result = await runToolContract(getWorkTool, { doi: '10.21468/scipostphys.19.6.157' });
    const text = result.content.map(blockText).join('\n');

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      funders: [
        { ror: 'https://ror.org/0439y7842', award: ['EP/S020527/1'] },
        { ror: 'https://ror.org/021nxhr62', award: ['PHY-2309135'] },
      ],
      // The rest of the record is projected as it always was.
      title: 'Cas9 in mammals',
      containerTitle: 'Nature',
      isReferencedByCount: 1500,
    });
    expect((result.structuredContent as { funders: unknown[] }).funders[0]).not.toHaveProperty(
      'name',
    );
    expect(text).toContain('- https://ror.org/0439y7842 (EP/S020527/1)');
    expect(text).toContain('- https://ror.org/021nxhr62 (PHY-2309135)');
  });

  /**
   * The commoner deposit: the same funder twice, once matched to a Funder Registry DOI and once
   * asserted by the publisher's ROR. Both entries reach both surfaces with what identifies them.
   */
  it('carries every identifier a funder deposits, named or not', async () => {
    mockGetWork.mockResolvedValue(
      makeRawWork({
        funder: [
          {
            DOI: '10.13039/501100001809',
            name: 'National Natural Science Foundation of China',
            award: ['41801279'],
            id: [{ id: '10.13039/501100001809', 'id-type': 'DOI', 'asserted-by': 'crossref' }],
          },
          {
            award: ['41801279'],
            id: [{ id: 'https://ror.org/01h0zpd94', 'id-type': 'ROR', 'asserted-by': 'publisher' }],
          },
        ],
      }),
    );

    const result = await runToolContract(getWorkTool, { doi: '10.3390/rs18091431' });
    const text = result.content.map(blockText).join('\n');

    expect(result.structuredContent).toMatchObject({
      funders: [
        {
          name: 'National Natural Science Foundation of China',
          doi: '10.13039/501100001809',
          award: ['41801279'],
        },
        { ror: 'https://ror.org/01h0zpd94', award: ['41801279'] },
      ],
    });
    // A DOI-typed id is the funder DOI restated, so it is not read as a ROR.
    expect(
      (result.structuredContent as { funders: Array<{ ror?: string }> }).funders[0]?.ror,
    ).toBeUndefined();
    expect(text).toContain(
      '- National Natural Science Foundation of China — 10.13039/501100001809 (41801279)',
    );
    expect(text).toContain('- https://ror.org/01h0zpd94 (41801279)');
  });

  /** The same absence one level down, on the organization an author belongs to. */
  it('keeps a record whose affiliations are asserted by ROR instead of by name', async () => {
    mockGetWork.mockResolvedValue(
      makeRawWork({
        author: [
          {
            given: 'Ann M.',
            family: 'Lanari',
            sequence: 'first',
            affiliation: [
              {
                id: [
                  { id: 'https://ror.org/01ryk1543', 'id-type': 'ROR', 'asserted-by': 'publisher' },
                ],
              },
            ],
          },
        ],
      }),
    );

    const result = await runToolContract(getWorkTool, { doi: '10.1364/oe.503620' });
    const text = result.content.map(blockText).join('\n');

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      authors: [
        {
          given: 'Ann M.',
          family: 'Lanari',
          sequence: 'first',
          affiliation: [{ ror: 'https://ror.org/01ryk1543' }],
        },
      ],
      authorCount: 1,
      title: 'Cas9 in mammals',
    });
    expect(text).toContain('- Ann M. Lanari (first) — https://ror.org/01ryk1543');
  });

  /**
   * The commoner affiliation deposit by an order of magnitude: a name *and* the ROR that resolves
   * it. A ROR reaches `structuredContent` on 7% of sampled affiliations, so a render that showed
   * the name alone would leave a `content[]` reader unable to resolve what the other surface
   * identifies — on far more entries than the nameless case above.
   */
  it('carries both a name and the ROR that resolves it onto content[]', async () => {
    mockGetWork.mockResolvedValue(
      makeRawWork({
        author: [
          {
            given: 'Belén',
            family: 'Otero Carrasco',
            sequence: 'first',
            affiliation: [
              {
                name: 'Universidad Politécnica de Madrid',
                id: [
                  { id: 'https://ror.org/03n6nwv02', 'id-type': 'ROR', 'asserted-by': 'publisher' },
                ],
              },
            ],
          },
        ],
        funder: [
          {
            name: 'Agencia Estatal de Investigación',
            DOI: '10.13039/501100011033',
            award: ['PID2020-01'],
            id: [
              { id: '10.13039/501100011033', 'id-type': 'DOI', 'asserted-by': 'crossref' },
              { id: 'https://ror.org/003x0zc53', 'id-type': 'ROR', 'asserted-by': 'publisher' },
            ],
          },
        ],
      }),
    );

    const result = await runToolContract(getWorkTool, { doi: '10.20868/upm.thesis.83874' });
    const text = result.content.map(blockText).join('\n');

    expect(result.structuredContent).toMatchObject({
      authors: [
        {
          affiliation: [
            { name: 'Universidad Politécnica de Madrid', ror: 'https://ror.org/03n6nwv02' },
          ],
        },
      ],
      funders: [
        {
          name: 'Agencia Estatal de Investigación',
          doi: '10.13039/501100011033',
          ror: 'https://ror.org/003x0zc53',
          award: ['PID2020-01'],
        },
      ],
    });
    expect(text).toContain(
      '- Belén Otero Carrasco (first) — Universidad Politécnica de Madrid (https://ror.org/03n6nwv02)',
    );
    expect(text).toContain(
      '- Agencia Estatal de Investigación — 10.13039/501100011033 https://ror.org/003x0zc53 (PID2020-01)',
    );
  });

  /**
   * The residual: an entry carrying neither a name nor an identifier this server reads. It is
   * rare — one affiliation in a 22,763-entry draw — and the render still has to say which of the
   * two it is looking at.
   */
  it('names an organization the deposit identifies in no way it reads', async () => {
    mockGetWork.mockResolvedValue(
      makeRawWork({
        author: [{ given: 'Jane', family: 'Doe', affiliation: [{ department: ['Physics'] }] }],
        funder: [{ award: ['X-1'] }],
      }),
    );

    const result = await runToolContract(getWorkTool, { doi: '10.1000/unnamed' });
    const text = result.content.map(blockText).join('\n');

    expect(result.isError).toBeFalsy();
    expect(text).toContain('- Jane Doe — (no name deposited)');
    expect(text).toContain('- (no name deposited) (X-1)');
  });

  /**
   * Crossref writes an unknown date component as `null` inside the tuple rather than leaving it
   * off, and a dissertation with no registered year deposits nothing but that. The record comes
   * back with no publication date, which is what an unknown year already means on this surface.
   */
  it('returns a record whose publication year Crossref does not know', async () => {
    mockGetWork.mockResolvedValue(
      makeRawWork({
        type: 'dissertation',
        published: undefined,
        'published-print': undefined,
        'published-online': undefined,
        issued: { 'date-parts': [[null]] },
      }),
    );

    const result = await runToolContract(getWorkTool, { doi: '10.20868/upm.thesis.83874' });
    const text = result.content.map(blockText).join('\n');

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      doi: '10.1038/nature12373',
      type: 'dissertation',
      title: 'Cas9 in mammals',
    });
    expect(result.structuredContent).not.toHaveProperty('published');
    expect(text).not.toContain('**Published:**');
  });

  it('reports a year whose month Crossref does not know, and no month', async () => {
    const ctx = createMockContext({ errors: getWorkTool.errors });
    mockGetWork.mockResolvedValue(makeRawWork({ published: { 'date-parts': [[2020, null, 15]] } }));

    const input = getWorkTool.input.parse({ doi: '10.1038/nature12373' });
    const result = await getWorkTool.handler(input, ctx);

    expect(result.published).toEqual({ year: 2020 });
    expect(blockText(getWorkTool.format!(result)[0])).toContain('**Published:** 2020');
  });

  it('returns subject and language fields', async () => {
    const ctx = createMockContext({ errors: getWorkTool.errors });
    mockGetWork.mockResolvedValue(
      makeRawWork({
        subject: ['Genetics', 'Biochemistry'],
        language: 'en',
        URL: 'https://doi.org/10.1038/nature12373',
      }),
    );

    const input = getWorkTool.input.parse({ doi: '10.1038/nature12373' });
    const result = await getWorkTool.handler(input, ctx);

    expect(result.subject).toEqual(['Genetics', 'Biochemistry']);
    expect(result.language).toBe('en');
    expect(result.url).toBe('https://doi.org/10.1038/nature12373');
  });

  it('decodes HTML entities in title and abstract', async () => {
    const ctx = createMockContext({ errors: getWorkTool.errors });
    mockGetWork.mockResolvedValue(
      makeRawWork({
        title: ['Proteins &amp; Lipids &lt;3&gt;'],
        abstract: 'Rate &gt; 50% &amp; efficiency &lt;100%.',
      }),
    );

    const input = getWorkTool.input.parse({ doi: '10.1038/nature12373' });
    const result = await getWorkTool.handler(input, ctx);

    expect(result.title).toBe('Proteins & Lipids <3>');
    expect(result.abstract).toBe('Rate > 50% & efficiency <100%.');
  });

  it('strips JATS XML tags from abstract', async () => {
    const ctx = createMockContext({ errors: getWorkTool.errors });
    mockGetWork.mockResolvedValue(
      makeRawWork({
        abstract: '<abstract><title>Background</title><p>Gene editing was studied.</p></abstract>',
      }),
    );

    const input = getWorkTool.input.parse({ doi: '10.1038/nature12373' });
    const result = await getWorkTool.handler(input, ctx);

    expect(result.abstract).not.toContain('<');
    expect(result.abstract).not.toContain('>');
    expect(result.abstract).toContain('Gene editing was studied');
  });

  it('strips JATS markup and embedded newlines from title, subtitle, and container title', async () => {
    const ctx = createMockContext({ errors: getWorkTool.errors });
    mockGetWork.mockResolvedValue(
      makeRawWork({
        title: ['<i>In vivo</i>\n                    CRISPR biosensing'],
        subtitle: ['a <scp>Review</scp>\nof methods'],
        'container-title': ['<i>Chem.</i> Soc. Rev.'],
      }),
    );

    const input = getWorkTool.input.parse({ doi: '10.1039/d5cs00921a' });
    const result = await getWorkTool.handler(input, ctx);

    expect(result.title).toBe('In vivo CRISPR biosensing');
    expect(result.subtitle).toBe('a Review of methods');
    expect(result.containerTitle).toBe('Chem. Soc. Rev.');
    // The Markdown heading in content[] has to stay on one line.
    const text = blockText(getWorkTool.format!(result)[0]);
    expect(text.split('\n')[0]).toBe('## In vivo CRISPR biosensing');
  });

  /**
   * The deposit behind the `<alternatives>` report — a formula's TeX beside the same formula's
   * presentation MathML — reaches the reader once, on both surfaces.
   */
  it('renders a formula deposited in two notations once', async () => {
    mockGetWork.mockResolvedValue(
      makeRawWork({
        abstract:
          '<jats:p>values for the anti-<jats:inline-formula><jats:alternatives>' +
          '<jats:tex-math>$$k_{\\bot }$$</jats:tex-math><mml:math xmlns:mml="http://www.w3.org/1998/Math/MathML">' +
          '<mml:msub><mml:mi>k</mml:mi><mml:mi>⊥</mml:mi></mml:msub></mml:math>' +
          '</jats:alternatives></jats:inline-formula> algorithm</jats:p>',
      }),
    );

    const result = await runToolContract(getWorkTool, { doi: '10.1140/epjc/s10052-020-8172-7' });
    const text = result.content.map(blockText).join('\n');

    expect(result.structuredContent).toMatchObject({
      abstract: 'values for the anti- $$k_{\\bot }$$ algorithm',
    });
    expect(text).toContain('values for the anti- $$k_{\\bot }$$ algorithm');
    expect(text).not.toContain('k⊥');
  });

  /**
   * The wrapper's own boundary, on the deposits that pack the prose hard against the formula.
   * Without it the sentence runs into the notation and out of it again, on both surfaces.
   */
  it('separates a formula the deposit packs against the prose', async () => {
    mockGetWork.mockResolvedValue(
      makeRawWork({
        abstract:
          '<jats:p>partially linear on a time scale<jats:inline-formula><jats:alternatives>' +
          '<jats:tex-math>$\\mathbb{T}$</jats:tex-math>' +
          '<mml:math xmlns:mml="http://www.w3.org/1998/Math/MathML"><mml:mi>T</mml:mi></mml:math>' +
          '</jats:alternatives></jats:inline-formula>with two independent variables.</jats:p>',
      }),
    );

    const result = await runToolContract(getWorkTool, { doi: '10.1186/s13660-020-02475-w' });
    const text = result.content.map(blockText).join('\n');

    expect(result.structuredContent).toMatchObject({
      abstract: 'partially linear on a time scale $\\mathbb{T}$ with two independent variables.',
    });
    expect(text).toContain('on a time scale $\\mathbb{T}$ with two independent variables.');
  });

  it('separates a formula the deposit packs against a unit', async () => {
    mockGetWork.mockResolvedValue(
      makeRawWork({
        abstract:
          '<jats:p>the sensitivity is 43 μV/cm<jats:inline-formula><jats:alternatives>' +
          '<jats:tex-math>$\\sqrt{\\text{Hz}}$</jats:tex-math>' +
          '<mml:math xmlns:mml="http://www.w3.org/1998/Math/MathML"><mml:msqrt>' +
          '<mml:mtext>Hz</mml:mtext></mml:msqrt></mml:math>' +
          '</jats:alternatives></jats:inline-formula> in the absence of the resonator.</jats:p>',
      }),
    );

    const result = await runToolContract(getWorkTool, { doi: '10.1140/epjqt/s40507-023-00179-w' });
    const text = result.content.map(blockText).join('\n');

    expect(result.structuredContent).toMatchObject({
      abstract: 'the sensitivity is 43 μV/cm $\\sqrt{\\text{Hz}}$ in the absence of the resonator.',
    });
    expect(text).toContain('43 μV/cm $\\sqrt{\\text{Hz}}$ in the absence');
  });

  /**
   * A graphic-first wrapper and one whose selected encoding already sits between spaces: the
   * boundary is idempotent against the whitespace a deposit already carries, so neither gains a
   * stray space.
   */
  it('adds no space where the deposit already separates the formula', async () => {
    mockGetWork.mockResolvedValue(
      makeRawWork({
        abstract:
          '<jats:p>Optimal <jats:inline-formula><jats:alternatives>' +
          '<jats:tex-math>$$[n,2]_4$$</jats:tex-math>' +
          '<mml:math xmlns:mml="http://www.w3.org/1998/Math/MathML"><mml:mn>4</mml:mn></mml:math>' +
          '</jats:alternatives></jats:inline-formula> codes are constructed. ' +
          '<jats:italic>P</jats:italic>\n<jats:inline-formula>\n<jats:alternatives>\n' +
          '<jats:inline-graphic mime-subtype="gif" xlink:href="inline1"/>\n' +
          `<jats:tex-math>\${\\bar 3}$</jats:tex-math>\n</jats:alternatives>\n` +
          '</jats:inline-formula>\n<jats:italic>m</jats:italic> 1</jats:p>',
      }),
    );

    const result = await runToolContract(getWorkTool, { doi: '10.1007/s40065-020-00303-z' });
    const text = result.content.map(blockText).join('\n');
    const rendered = `Optimal $$[n,2]_4$$ codes are constructed. P \${\\bar 3}$ m 1`;

    expect(result.structuredContent).toMatchObject({ abstract: rendered });
    expect(text).toContain(rendered);
  });

  /**
   * A Markdown block marker at the head of an abstract — the one line on this surface that puts
   * a deposited value at column zero. Left unescaped the renderer consumes the marker, so the
   * `19.` that names the century and the `- ` a publisher deposited are gone from `content[]`
   * while `structuredContent` still holds them. Both surfaces have to carry the same characters.
   */
  it('keeps a block marker at the head of an abstract visible on both surfaces', async () => {
    mockGetWork.mockResolvedValue(
      makeRawWork({
        abstract:
          '<jats:p xml:lang="tr">19. yüzyılın ikinci yarısından itibaren büyük savaşlar</jats:p>',
      }),
    );

    const result = await runToolContract(getWorkTool, { doi: '10.18603/sanatvetasarim.1707711' });
    const lines = result.content.flatMap((b) => blockText(b).split('\n'));

    expect(result.structuredContent).toMatchObject({
      abstract: '19. yüzyılın ikinci yarısından itibaren büyük savaşlar',
    });
    expect(lines).toContain('19\\. yüzyılın ikinci yarısından itibaren büyük savaşlar');
  });

  it('keeps a bullet marker at the head of an abstract visible on both surfaces', async () => {
    mockGetWork.mockResolvedValue(
      makeRawWork({
        abstract: '<jats:p>-\nAbstract: Lung cancer is a major health problem</jats:p>',
      }),
    );

    const result = await runToolContract(getWorkTool, { doi: '10.5455/nnj.2020.9.1.7-10' });
    const lines = result.content.flatMap((b) => blockText(b).split('\n'));

    expect(result.structuredContent).toMatchObject({
      abstract: '- Abstract: Lung cancer is a major health problem',
    });
    expect(lines).toContain('\\- Abstract: Lung cancer is a major health problem');
  });

  /**
   * A publisher who deposits an escaped tag wants the reader to see the tag. The strip-before-
   * decode order keeps it as literal text on the structured surface, and the escape is what
   * stops a renderer taking it back on the Markdown one — along with the doubly-escaped
   * reference beside it, which has to stay spelled as a reference.
   */
  it('keeps an escaped tag and a doubly-escaped reference visible on both surfaces', async () => {
    mockGetWork.mockResolvedValue(
      makeRawWork({ abstract: '<jats:p>&lt;p&gt;wafers of 1μs &amp;lt;τ&amp;lt;1.2μs</jats:p>' }),
    );

    const result = await runToolContract(getWorkTool, { doi: '10.18686/esta.v7i4.163' });
    const text = result.content.map(blockText).join('\n');

    expect(result.structuredContent).toMatchObject({
      abstract: '<p>wafers of 1μs &lt;τ&lt;1.2μs',
    });
    expect(text).toContain('\\<p>wafers of 1μs \\&lt;τ\\&lt;1.2μs');
  });

  /**
   * A link the rule keeps — its `href` addresses more than its text names — reaches a Markdown
   * reader as the tag it is, address included, rather than as the element name alone.
   */
  it('carries a kept link tag onto content[] with its address', async () => {
    mockGetWork.mockResolvedValue(
      makeRawWork({
        abstract:
          '<jats:p>Registration URL: <jats:ext-link xlink:href="https://clinicaltrials.gov/ct2/show/NCT02196038">https://clinicaltrials.gov/</jats:ext-link></jats:p>',
      }),
    );

    const result = await runToolContract(getWorkTool, { doi: '10.1161/jaha.121.024246' });
    const text = result.content.map(blockText).join('\n');

    expect(text).toContain(
      '\\<jats:ext-link xlink:href="https://clinicaltrials.gov/ct2/show/NCT02196038">',
    );
    expect(text).toContain('https://clinicaltrials.gov/\\</jats:ext-link>');
  });

  it('collapses a lone newline in a title with no adjacent indentation', async () => {
    const ctx = createMockContext({ errors: getWorkTool.errors });
    mockGetWork.mockResolvedValue(makeRawWork({ title: ['<i>In vivo</i>\nCRISPR biosensing'] }));

    const input = getWorkTool.input.parse({ doi: '10.1039/d5cs00921a' });
    const result = await getWorkTool.handler(input, ctx);

    expect(result.title).toBe('In vivo CRISPR biosensing');
  });

  it('decodes entities in publisher, funder names, subjects, and affiliations', async () => {
    const ctx = createMockContext({ errors: getWorkTool.errors });
    mockGetWork.mockResolvedValue(
      makeRawWork({
        publisher: 'Taylor &amp; Francis',
        funder: [{ name: 'Bill &amp; Melinda Gates Foundation', DOI: '10.13039/100000865' }],
        subject: ['Ecology, Evolution, Behavior &amp; Systematics'],
        author: [
          {
            given: 'Jane',
            family: 'Doe',
            affiliation: [{ name: 'Dept. of Ecology &amp; Evolution' }],
          },
        ],
      }),
    );

    const input = getWorkTool.input.parse({ doi: '10.1038/nature12373' });
    const result = await getWorkTool.handler(input, ctx);

    expect(result.publisher).toBe('Taylor & Francis');
    expect(result.funders?.[0]?.name).toBe('Bill & Melinda Gates Foundation');
    expect(result.subject?.[0]).toBe('Ecology, Evolution, Behavior & Systematics');
    expect(result.authors?.[0]?.affiliation?.[0]?.name).toBe('Dept. of Ecology & Evolution');
  });

  it('uses subtitle/short-title as subtitle when present', async () => {
    const ctx = createMockContext({ errors: getWorkTool.errors });
    mockGetWork.mockResolvedValue(makeRawWork({ subtitle: ['A systematic review'] }));

    const input = getWorkTool.input.parse({ doi: '10.1038/nature12373' });
    const result = await getWorkTool.handler(input, ctx);

    expect(result.subtitle).toBe('A systematic review');
  });

  it('normalizes author ORCID and affiliation', async () => {
    const ctx = createMockContext({ errors: getWorkTool.errors });
    mockGetWork.mockResolvedValue(
      makeRawWork({
        author: [
          {
            given: 'Jane',
            family: 'Doe',
            ORCID: 'https://orcid.org/0000-0002-1234-5678',
            affiliation: [{ name: 'MIT' }],
            sequence: 'first',
          },
          {
            name: 'The ENCODE Consortium',
          },
        ],
      }),
    );

    const input = getWorkTool.input.parse({ doi: '10.1038/nature12373' });
    const result = await getWorkTool.handler(input, ctx);

    expect(result.authors?.[0]?.orcid).toBe('https://orcid.org/0000-0002-1234-5678');
    expect(result.authors?.[0]?.affiliation?.[0]?.name).toBe('MIT');
    expect(result.authors?.[0]?.sequence).toBe('first');
    expect(result.authors?.[1]?.name).toBe('The ENCODE Consortium');
    expect(result.authors?.[1]?.given).toBeUndefined();
    expect(result.authors?.[1]?.family).toBeUndefined();
  });

  it('uses published-print date when published is absent', async () => {
    const ctx = createMockContext({ errors: getWorkTool.errors });
    mockGetWork.mockResolvedValue(
      makeRawWork({
        published: undefined,
        'published-print': { 'date-parts': [[2019, 3]] },
      }),
    );

    const input = getWorkTool.input.parse({ doi: '10.1038/nature12373' });
    const result = await getWorkTool.handler(input, ctx);

    expect(result.published?.year).toBe(2019);
    expect(result.published?.month).toBe(3);
    expect(result.published?.day).toBeUndefined();
  });

  it('returns an ordinary author list whole, with no paging disclosure', async () => {
    const ctx = createMockContext({ errors: getWorkTool.errors });
    mockGetWork.mockResolvedValue(makeRawWork({ author: makeAuthors(11) }));

    // 11 sits under the default limit of 25 — the typical record, returned intact.
    const input = getWorkTool.input.parse({ doi: '10.1073/pnas.0506580102' });
    const result = await getWorkTool.handler(input, ctx);

    expect(result.authors).toHaveLength(11);
    expect(result.authorCount).toBe(11);
    expect(result.offset).toBe(0);

    const wire = wireSchema.parse({ ...result, ...getEnrichment(ctx) });
    expect(wire.nextOffset).toBeUndefined();
    expect(wire.truncated).toBeUndefined();
    expect(wire.notice).toBeUndefined();
    expect(blockText(getWorkTool.format!(result)[0])).toContain('showing 11 of 11');
  });

  it('pages a consortium author list and discloses nextOffset on both surfaces', async () => {
    const ctx = createMockContext({ errors: getWorkTool.errors });
    mockGetWork.mockResolvedValue(makeRawWork({ author: makeAuthors(2932) }));

    const input = getWorkTool.input.parse({ doi: '10.1016/j.physletb.2012.08.020' });
    const result = await getWorkTool.handler(input, ctx);

    expect(result.authors).toHaveLength(25);
    expect(result.authorCount).toBe(2932);
    expect(result.authors?.at(-1)).toMatchObject({ given: 'G24', family: 'F24' });

    const wire = wireSchema.parse({ ...result, ...getEnrichment(ctx) });
    expect(wire).toMatchObject({ nextOffset: 25, truncated: true, shown: 25, cap: 25 });
    expect(wire.notice).toMatch(/offset=25/);
    // The omitted authors are absent from the payload, not merely from the render.
    expect(JSON.stringify(result)).not.toContain('G25');

    const text = blockText(getWorkTool.format!(result)[0]);
    expect(text).toContain('showing 25 of 2932, starting at index 0');
    expect(text).not.toContain('G25 F25');
  });

  it('returns the requested page and omits nextOffset on the last one', async () => {
    const ctx = createMockContext({ errors: getWorkTool.errors });
    mockGetWork.mockResolvedValue(makeRawWork({ author: makeAuthors(30) }));

    const input = getWorkTool.input.parse({
      doi: '10.1038/nature12373',
      offset: 25,
      limit: 25,
    });
    const result = await getWorkTool.handler(input, ctx);

    expect(result.offset).toBe(25);
    expect(result.authors).toHaveLength(5);
    expect(result.authors?.[0]).toMatchObject({ given: 'G25', family: 'F25' });
    expect(getEnrichment(ctx).nextOffset).toBeUndefined();
    expect(getEnrichment(ctx).truncated).toBeUndefined();
    expect(blockText(getWorkTool.format!(result)[0])).toContain(
      'showing 5 of 30, starting at index 25',
    );
  });

  it('explains an offset past the end of the author list', async () => {
    const ctx = createMockContext({ errors: getWorkTool.errors });
    mockGetWork.mockResolvedValue(makeRawWork({ author: makeAuthors(11) }));

    const input = getWorkTool.input.parse({ doi: '10.1038/nature12373', offset: 500 });
    const result = await getWorkTool.handler(input, ctx);

    expect(result.authors).toHaveLength(0);
    expect(result.authorCount).toBe(11);
    expect(result.offset).toBe(500);
    const wire = wireSchema.parse({ ...result, ...getEnrichment(ctx) });
    expect(wire.notice).toMatch(/past the end/);
    expect(wire.notice).toContain('11');
    expect(wire.nextOffset).toBeUndefined();
    // The rest of the record still comes back — only the author list is paged.
    expect(result.title).toBe('Cas9 in mammals');
  });

  it('omits authorCount and offset when the record deposits no author field', async () => {
    const ctx = createMockContext({ errors: getWorkTool.errors });
    mockGetWork.mockResolvedValue(makeRawWork({ author: undefined }));

    const input = getWorkTool.input.parse({ doi: '10.1038/nature12373' });
    const result = await getWorkTool.handler(input, ctx);

    // A record with no deposited authors is a different fact from a page holding none.
    expect(result.authors).toBeUndefined();
    expect(result.authorCount).toBeUndefined();
    expect(result.offset).toBeUndefined();
    expect(getEnrichment(ctx).truncated).toBeUndefined();
    expect(blockText(getWorkTool.format!(result)[0])).not.toContain('**Authors:**');
  });

  it('carries the author paging disclosure onto content[] for a text-only client', async () => {
    mockGetWork.mockResolvedValue(makeRawWork({ author: makeAuthors(400) }));

    const result = await runToolContract(getWorkTool, {
      doi: '10.1016/j.physletb.2012.08.020',
      limit: 10,
    });

    const text = result.content.map(blockText).join('\n');
    expect(text).toContain('showing 10 of 400, starting at index 0');
    expect(text).toMatch(/offset=10/);
    expect(text).not.toContain('G10 F10');
    expect(result.structuredContent).toMatchObject({ authorCount: 400, nextOffset: 10 });
  });

  it('rejects offset and limit outside their declared ranges', () => {
    expect(() => getWorkTool.input.parse({ doi: '10.1038/x1', offset: -1 })).toThrow();
    expect(() => getWorkTool.input.parse({ doi: '10.1038/x1', limit: 0 })).toThrow();
    expect(() => getWorkTool.input.parse({ doi: '10.1038/x1', limit: 501 })).toThrow();
    expect(() => getWorkTool.input.parse({ doi: '10.1038/x1', limit: 2.5 })).toThrow();
  });

  it('throws doi_not_found when service returns null', async () => {
    const ctx = createMockContext({ errors: getWorkTool.errors });
    mockGetWork.mockResolvedValue(null);

    const input = getWorkTool.input.parse({ doi: '10.9999/nonexistent' });
    await expect(getWorkTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'doi_not_found' },
    });
  });

  it('rejects DOI with invalid format via Zod schema', () => {
    expect(() => getWorkTool.input.parse({ doi: 'not-a-doi' })).toThrow();
    expect(() => getWorkTool.input.parse({ doi: '10.x/suffix' })).toThrow();
    expect(() => getWorkTool.input.parse({ doi: 'https://doi.org/10.1038/nature' })).toThrow();
  });

  it('accepts minimum-length DOI registrant (4 digits)', () => {
    const parsed = getWorkTool.input.parse({ doi: '10.1234/suffix' });
    expect(parsed.doi).toBe('10.1234/suffix');
  });

  it('formats output with title, doi, and authors', () => {
    const result = {
      doi: '10.1038/nature12373',
      type: 'journal-article',
      title: 'Cas9 in mammals',
      authors: [{ given: 'Le', family: 'Cong' }],
      abstract: 'Some abstract.',
      isReferencedByCount: 1500,
    };
    const blocks = getWorkTool.format!(result);
    expect(blocks[0]?.type).toBe('text');
    const text = blockText(blocks[0]);
    expect(text).toContain('10.1038/nature12373');
    expect(text).toContain('Le');
    expect(text).toContain('Cong');
    expect(text).toContain('Some abstract.');
    expect(text).toContain('1500');
  });

  it('formats funders, licenses, and links in output', () => {
    const result = {
      doi: '10.1038/nature12373',
      title: 'Test',
      isReferencedByCount: 0,
      funders: [{ name: 'NIH', doi: '10.13039/100000002', award: ['R01-GM123'] }],
      licenses: [
        {
          url: 'https://creativecommons.org/licenses/by/4.0/',
          contentVersion: 'vor',
          delayInDays: 0,
        },
      ],
      links: [
        {
          url: 'https://example.com/full.pdf',
          contentType: 'application/pdf',
          intendedApplication: 'text-mining',
        },
      ],
    };
    const blocks = getWorkTool.format!(result);
    const text = blockText(blocks[0]);
    expect(text).toContain('NIH');
    expect(text).toContain('R01-GM123');
    expect(text).toContain('creativecommons.org');
    expect(text).toContain('vor');
    expect(text).toContain('example.com/full.pdf');
    expect(text).toContain('text-mining');
  });

  it('security: output does not leak CROSSREF_MAILTO env value', async () => {
    const originalMailto = process.env.CROSSREF_MAILTO;
    process.env.CROSSREF_MAILTO = 'secret@internal.example.com';
    try {
      const ctx = createMockContext({ errors: getWorkTool.errors });
      mockGetWork.mockResolvedValue(makeRawWork());

      const input = getWorkTool.input.parse({ doi: '10.1038/nature12373' });
      const result = await getWorkTool.handler(input, ctx);
      const blocks = getWorkTool.format!(result);
      const outputText = JSON.stringify(result) + blockText(blocks[0]);

      expect(outputText).not.toContain('secret@internal.example.com');
    } finally {
      if (originalMailto === undefined) delete process.env.CROSSREF_MAILTO;
      else process.env.CROSSREF_MAILTO = originalMailto;
    }
  });
});
