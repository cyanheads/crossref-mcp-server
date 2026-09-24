/**
 * @fileoverview A MathML region as the reader receives it: the deposited TeX annotation when
 * the deposit carries one, otherwise the presentation tree written out in a linear notation
 * that keeps every operator the tree encodes as structure — radicals, scripts, fractions,
 * fences — and any element with no linear form spelled `name(child, …)`. Driven at the two
 * normalization passes, the seam every field that can carry MathML goes through, and pinned on
 * three deposits taken from the live API.
 * @module tests/services/crossref/mathml.test
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  normalizeMarkupText,
  normalizeReferenceText,
} from '@/services/crossref/crossref-service.js';
import { measureScaling, nestTo, repeatTo } from '../../helpers/scaling.js';

/** A work's abstract as Crossref deposits it, from a captured `/works/{doi}` response. */
function depositedAbstract(doi: string): string {
  const file = new URL(`../../fixtures/mathml/${doi.replace('/', '-')}.json`, import.meta.url);
  return (JSON.parse(readFileSync(file, 'utf8')) as { message: { abstract: string } }).message
    .abstract;
}

/** What a formula reads as on both passes, which must agree. */
function formula(inner: string): string {
  const raw = `<math xmlns="http://www.w3.org/1998/Math/MathML">${inner}</math>`;
  const jats = normalizeMarkupText(raw);
  expect(normalizeReferenceText(raw), `reference pass on ${inner}`).toBe(jats);
  return jats;
}

describe('a MathML region with a TeX annotation', () => {
  /** Two AMS deposits: every region carries `application/x-tex`, and each is emitted as deposited. */
  it('reads as the TeX the deposit carries, on both passes', () => {
    const cases: Array<[string, string]> = [
      [
        '10.1090/s0025-5718-00-01296-5',
        'The present paper is a continuation of an earlier work by the author. We propose some new definitions of p -adic continued fractions. At the end of the paper we give numerical examples illustrating these definitions. It turns out that for every m, 1>m>5000,\\ 5\\nmid m if \\sqrt {m}\\in \\mathbb {Q} _{5}\\setminus \\mathbb {Q}, then \\sqrt {m} has a periodic continued fraction expansion. The same is not true in \\mathbb {Q}_{p} for some larger values of p.',
      ],
      [
        '10.1090/s0002-9939-05-08007-x',
        'If \\mathcal {H} is a Hilbert space, A is a positive bounded linear operator on \\mathcal {H} and \\mathcal {S} is a closed subspace of \\mathcal {H} , the relative position between \\mathcal {S} and A^{-1}(\\mathcal {S}^\\perp ) establishes a notion of compatibility. We show that the compatibility of (A,\\mathcal {S}) is equivalent to the existence of a convenient orthogonal projection in the operator range R(A^{1/2}) with its canonical Hilbertian structure.',
      ],
    ];
    for (const [doi, expected] of cases) {
      const abstract = depositedAbstract(doi);
      expect(normalizeMarkupText(abstract), doi).toBe(expected);
      expect(normalizeReferenceText(abstract), doi).toBe(expected);
    }
  });

  /** One expression per region: the annotation replaces the presentation tree, never joins it. */
  it('emits the annotation alone', () => {
    expect(
      formula(
        '<semantics><msqrt><mi>m</mi></msqrt><annotation encoding="application/x-tex">\\sqrt{m}</annotation></semantics>',
      ),
    ).toBe('\\sqrt{m}');
  });

  it('recognizes a TeX or LaTeX encoding in any spelling, and only those', () => {
    for (const encoding of ['application/x-tex', 'TeX', 'LaTeX', 'application/x-latex']) {
      expect(
        formula(
          `<semantics><msup><mi>x</mi><mn>2</mn></msup><annotation encoding="${encoding}">x^2</annotation></semantics>`,
        ),
        encoding,
      ).toBe('x^2');
    }
    // `text/plain` contains the letters `tex` and names no TeX.
    expect(
      formula(
        '<semantics><msup><mi>x</mi><mn>3</mn></msup><annotation encoding="text/plain">x cubed</annotation></semantics>',
      ),
    ).toBe('x^3');
  });

  /** An annotation carrying no text is no encoding at all, and the tree is read instead. */
  it('reads the tree when the TeX annotation is empty', () => {
    expect(
      formula(
        '<semantics><msub><mi>x</mi><mi>i</mi></msub><annotation encoding="application/x-tex">  </annotation></semantics>',
      ),
    ).toBe('x_i');
  });

  /** A second encoding that is not TeX is the same expression again, and is dropped. */
  it('drops a Content MathML annotation wherever it sits', () => {
    expect(
      formula(
        '<msup><mi>A</mi><mn>2</mn></msup><annotation-xml encoding="MathML-Content"><apply><power/><ci>A</ci><cn>2</cn></apply></annotation-xml>',
      ),
    ).toBe('A^2');
  });
});

describe('a MathML region without a TeX annotation', () => {
  /** A Springer deposit with presentation MathML only — no annotation, no alternatives. */
  it('keeps every operator the tree encodes as structure', () => {
    const abstract = depositedAbstract('10.1186/s13661-014-0236-x');
    const expected =
      'Abstract In this paper we prove the existence of a nontrivial solution in D^{1,p}(R^N)∩D^{1,q}(R^N) for the following (p,q) -Laplacian problem: {−Δ_pu−Δ_qu=λg(x)|u|^{r−1}u+|u|^{p^⋆−2}u,; u(x)≥0, x∈R^N, where 1<q≤p<r+1<p^⋆:=(Np)/(N−p) , p<N , λ>0 is a parameter, Δ_mu:=div(|∇u|^{m−2}∇u) is the m-Laplacian operator and g∈L^{(p^⋆)/(p^⋆−r−1)}(R^N) is positive in an open set. MSC: 35J92, 47J30.';
    expect(normalizeMarkupText(abstract)).toBe(expected);
    // The reference pass keeps the unrecognized `<jats:title>` around the heading; its regions
    // read the same.
    for (const region of ['D^{1,p}(R^N)∩D^{1,q}(R^N)', 'p^⋆:=(Np)/(N−p)', '|u|^{r−1}u']) {
      expect(normalizeReferenceText(abstract)).toContain(region);
    }
  });

  it('writes a script after its base, braced when longer than one character', () => {
    expect(formula('<msub><mi>x</mi><mi>i</mi></msub>')).toBe('x_i');
    expect(formula('<msup><mi>A</mi><mrow><mo>−</mo><mn>1</mn></mrow></msup>')).toBe('A^{−1}');
    expect(formula('<msubsup><mi>x</mi><mi>i</mi><mn>2</mn></msubsup>')).toBe('x_i^2');
    expect(formula('<msub><mi>Airy</mi><mn>2</mn></msub>')).toBe('Airy_2');
  });

  it('writes an under or over script as a script, and a one-character accent after its base', () => {
    expect(
      formula(
        '<munderover><mo>∑</mo><mrow><mi>i</mi><mo>=</mo><mn>1</mn></mrow><mi>N</mi></munderover>',
      ),
    ).toBe('∑_{i=1}^N');
    expect(
      formula('<munder><mo>lim</mo><mrow><mi>n</mi><mo>→</mo><mi>∞</mi></mrow></munder>'),
    ).toBe('lim_{n→∞}');
    expect(formula('<mover><mo>=</mo><mi>d</mi></mover>')).toBe('=^d');
    expect(formula('<mover accent="true"><mi>x</mi><mo>¯</mo></mover>')).toBe('x¯');
    expect(formula('<mover><mi>v</mi><mo>→</mo></mover>')).toBe('v→');
    expect(formula('<munder><mi>x</mi><mo>˜</mo></munder>')).toBe('x˜');
  });

  it('writes prescripts ahead of the base and postscripts after it', () => {
    expect(
      formula('<mmultiscripts><mi>Si</mi><mprescripts/><none/><mn>33</mn></mmultiscripts>'),
    ).toBe('^{33}Si');
    expect(
      formula('<mmultiscripts><mi>R</mi><mi>i</mi><none/><none/><mi>j</mi></mmultiscripts>'),
    ).toBe('R_i^j');
    expect(
      formula(
        '<mmultiscripts><mi>X</mi><mi>a</mi><mi>b</mi><mprescripts/><mi>c</mi><mi>d</mi></mmultiscripts>',
      ),
    ).toBe('_c^dX_a^b');
  });

  it('writes a radical with its radicand, and its index when it has one', () => {
    expect(formula('<msqrt><mi>m</mi></msqrt>')).toBe('√(m)');
    expect(formula('<msqrt><mi>x</mi><mo>+</mo><mn>1</mn></msqrt>')).toBe('√(x+1)');
    expect(formula('<mroot><mi>x</mi><mn>3</mn></mroot>')).toBe('√[3](x)');
  });

  /**
   * An operand is grouped unless it is one token or already bracketed — and the same rule
   * decides whether a script base needs grouping.
   */
  it('groups a fraction operand or script base that is neither one token nor bracketed', () => {
    expect(
      formula(
        '<mfrac><mrow><mi>N</mi><mi>p</mi></mrow><mrow><mi>N</mi><mo>−</mo><mi>p</mi></mrow></mfrac>',
      ),
    ).toBe('(Np)/(N−p)');
    expect(formula('<mfrac><mi>a</mi><mn>2</mn></mfrac>')).toBe('a/2');
    expect(formula('<mfrac><mrow><mi>a</mi></mrow><mrow><mn>2</mn></mrow></mfrac>')).toBe('a/2');
    expect(formula('<msup><mrow><mi>x</mi><mo>+</mo><mi>y</mi></mrow><mn>2</mn></msup>')).toBe(
      '(x+y)^2',
    );
    // Bracketed already: by fence tokens that enclose the whole operand, or by an mfenced.
    expect(
      formula(
        '<mfrac><mrow><mo>(</mo><mi>a</mi><mo>+</mo><mi>b</mi><mo>)</mo></mrow><mn>2</mn></mfrac>',
      ),
    ).toBe('(a+b)/2');
    expect(formula('<msup><mrow><mo>|</mo><mi>u</mi><mo>|</mo></mrow><mn>2</mn></msup>')).toBe(
      '|u|^2',
    );
    expect(formula('<msup><mfenced><mi>a</mi><mi>b</mi></mfenced><mn>2</mn></msup>')).toBe(
      '(a,b)^2',
    );
    // A fence token deposited inside a wrapper of its own is still a fence.
    expect(
      formula(
        '<msup><mrow><mrow><mrow><mo>(</mo></mrow><mrow><msup><mi>f</mi><mo>″</mo></msup></mrow><mo>)</mo></mrow></mrow><mi>m</mi></msup>',
      ),
    ).toBe('(f^″)^m');
    // Fences at both ends that do not enclose the whole operand are not a bracket around it.
    expect(
      formula(
        '<mfrac><mrow><mo>(</mo><mi>a</mi><mo>)</mo><mo>+</mo><mo>(</mo><mi>b</mi><mo>)</mo></mrow><mn>2</mn></mfrac>',
      ),
    ).toBe('((a)+(b))/2');
    expect(
      formula(
        '<msup><mrow><mo>|</mo><mi>a</mi><mo>|</mo><mo>+</mo><mo>|</mo><mi>b</mi><mo>|</mo></mrow><mn>2</mn></msup>',
      ),
    ).toBe('(|a|+|b|)^2');
  });

  it('writes a fenced list with its own delimiters and separators', () => {
    expect(formula('<mfenced><mi>x</mi><mi>y</mi></mfenced>')).toBe('(x,y)');
    expect(
      formula('<mfenced open="[" close=")" separators=";"><mi>a</mi><mi>b</mi></mfenced>'),
    ).toBe('[a;b)');
    // One separator per gap, the last one repeating once they run out.
    expect(
      formula(
        '<mfenced open="{" close="}" separators=", ;"><mi>a</mi><mi>b</mi><mi>c</mi><mi>d</mi></mfenced>',
      ),
    ).toBe('{a,b;c;d}');
    expect(formula('<mfenced separators=""><mi>a</mi><mi>b</mi></mfenced>')).toBe('(ab)');
  });

  it('writes a table as rows joined by semicolons and cells by spaces', () => {
    expect(
      formula(
        '<mtable><mtr><mtd><mi>a</mi></mtd><mtd><mi>b</mi></mtd></mtr><mtr><mtd><mi>c</mi></mtd><mtd><mi>d</mi></mtd></mtr></mtable>',
      ),
    ).toBe('a b; c d');
  });

  /**
   * A token is trimmed of XML whitespace only, so a space the deposit writes as a character
   * survives; the pretty-printing between tags is XML whitespace and goes.
   */
  it('keeps a space a token deposits as a character', () => {
    expect(formula('<mn>5000</mn><mo>,</mo><mtext> </mtext><mn>5</mn>')).toBe('5000, 5');
    expect(formula('<mi>a</mi><mtext> </mtext><mi>b</mi>')).toBe('a b');
    expect(formula('\n  <mi> x </mi>\n  <mo>\n    ∈\n  </mo>\n  <mi>S</mi>\n')).toBe('x∈S');
    expect(formula('<mtext>for all</mtext>')).toBe('for all');
  });

  it('maps a double-struck token to its letters', () => {
    expect(
      formula(
        '<mi mathvariant="double-struck">R</mi><mi mathvariant="double-struck">Q</mi><mi mathvariant="double-struck">Z</mi><mi mathvariant="double-struck">N</mi><mi mathvariant="double-struck">C</mi>',
      ),
    ).toBe('ℝℚℤℕℂ');
    expect(formula('<mi mathvariant="double-struck">A</mi>')).toBe('𝔸');
    expect(formula('<mi mathvariant="normal">R</mi>')).toBe('R');
  });

  it('writes a space for mspace and reads a layout wrapper as its children', () => {
    expect(formula('<mi>a</mi><mspace width="1em"/><mi>b</mi>')).toBe('a b');
    expect(
      formula(
        '<mstyle displaystyle="true"><mpadded><mrow><mi>a</mi><mo>+</mo><mi>b</mi></mrow></mpadded></mstyle>',
      ),
    ).toBe('a+b');
    expect(formula('<maction actiontype="toggle"><mi>a</mi><mi>b</mi></maction>')).toBe('a');
    expect(
      formula(
        '<semantics><mi>a</mi><annotation encoding="text/plain">alpha</annotation></semantics>',
      ),
    ).toBe('a');
  });

  /** An element with no linear form stays visible, with its children, rather than vanishing. */
  it('spells any other element as its name over its children', () => {
    expect(formula('<mfrac linethickness="0"><mi>n</mi><mi>k</mi></mfrac>')).toBe('mfrac(n, k)');
    expect(formula('<mfrac linethickness="0px"><mi>n</mi><mi>k</mi></mfrac>')).toBe('mfrac(n, k)');
    expect(formula('<mfrac linethickness="2"><mi>n</mi><mi>k</mi></mfrac>')).toBe('n/k');
    expect(formula('<menclose notation="box"><mi>x</mi><mi>y</mi></menclose>')).toBe(
      'menclose(x, y)',
    );
    expect(formula('<mi>a</mi><mo>+</mo><mphantom><mi>b</mi></mphantom>')).toBe('a+mphantom(b)');
    expect(
      formula('<msup><mi>x</mi><mfrac linethickness="0"><mi>n</mi><mi>k</mi></mfrac></msup>'),
    ).toBe('x^{mfrac(n, k)}');
  });

  /** Structure inside structure, past the first level. */
  it('keeps nested structure at every depth', () => {
    expect(
      formula(
        '<msqrt><mfrac><msup><mi>x</mi><mn>2</mn></msup><msub><mi>y</mi><mrow><mi>i</mi><mo>+</mo><mn>1</mn></mrow></msub></mfrac></msqrt>',
      ),
    ).toBe('√((x^2)/(y_{i+1}))');
    expect(
      formula(
        '<msup><mrow><mo>(</mo><mfrac><mi>a</mi><mrow><mn>1</mn><mo>+</mo><msqrt><mfrac><mi>b</mi><msub><mi>c</mi><mi>k</mi></msub></mfrac></msqrt></mrow></mfrac><mo>)</mo></mrow><mrow><mi>n</mi><mo>−</mo><mn>1</mn></mrow></msup>',
      ),
    ).toBe('(a/(1+√(b/(c_k))))^{n−1}');
    expect(
      formula(
        '<mtable><mtr><mtd><mfrac><mi>a</mi><mi>b</mi></mfrac></mtd><mtd><mfrac><msup><mi>x</mi><mn>2</mn></msup><mn>2</mn></mfrac></mtd></mtr><mtr><mtd><mroot><mfrac><mn>1</mn><mi>n</mi></mfrac><mn>3</mn></mroot></mtd><mtd><mn>0</mn></mtd></mtr></mtable>',
      ),
    ).toBe('a/b (x^2)/2; √[3](1/n) 0');
  });
});

describe('a MathML region in the sentence around it', () => {
  /** One expression per region, standing as its own token — whichever reading produced it. */
  it('stands as its own token against the prose it abuts', () => {
    const raw =
      'states of neutron-rich<mml:math xmlns:mml="x"><mml:mmultiscripts><mml:mi>Si</mml:mi><mml:mprescripts /><mml:none /><mml:mn>33</mml:mn></mml:mmultiscripts></mml:math>and thin films';
    expect(normalizeMarkupText(raw)).toBe('states of neutron-rich ^{33}Si and thin films');
    expect(normalizeReferenceText(raw)).toBe('states of neutron-rich ^{33}Si and thin films');
  });

  /**
   * An `<alternatives>` wrapper still selects by position, and a MathML child it selects is read
   * like any other region — so the two orders differ in notation and in nothing else.
   */
  it('reads the MathML an alternatives wrapper selects, in either child order', () => {
    const mathml = '<mml:math><mml:msup><mml:mi>x</mml:mi><mml:mn>2</mml:mn></mml:msup></mml:math>';
    const tex = '<tex-math>$x^2$</tex-math>';
    const mathmlFirst = `scale<alternatives>${mathml}${tex}</alternatives>with`;
    const texFirst = `scale<alternatives>${tex}${mathml}</alternatives>with`;
    expect(normalizeMarkupText(mathmlFirst)).toBe('scale x^2 with');
    expect(normalizeReferenceText(mathmlFirst)).toBe('scale x^2 with');
    expect(normalizeMarkupText(texFirst)).toBe('scale $x^2$ with');
    expect(normalizeReferenceText(texFirst)).toBe('scale $x^2$ with');
  });
});

/**
 * The conversion walks a tree the deposit shapes, so its cost has to be linear in the region
 * and its depth has to cost nothing on the call stack: a region nested deep enough overflows a
 * recursive walk under Node long before it slows one down. t(80k)/t(5k) is 16 for linear work
 * and 256 for quadratic.
 */
describe('MathML conversion on large regions', () => {
  const inMath = (inner: (size: number) => string) => (size: number) =>
    `<math>${inner(size - 13)}</math>`;
  const shapes: Array<[string, (size: number) => string]> = [
    ['nested rows', inMath((size) => nestTo('<mrow>', '<mi>x</mi>', '</mrow>', size))],
    ['nested radicals', inMath((size) => nestTo('<msqrt><mrow>', 'x', '</mrow></msqrt>', size))],
    [
      'scripts inside fractions inside radicals',
      inMath((size) =>
        nestTo(
          '<msqrt><mfrac><msup><mrow>',
          '<mi>x</mi>',
          '</mrow><mn>2</mn></msup><mi>y</mi></mfrac></msqrt>',
          size,
        ),
      ),
    ],
    [
      'nested scripts',
      inMath((size) => nestTo('<msup><mi>x</mi><mrow>', '<mn>2</mn>', '</mrow></msup>', size)),
    ],
    [
      'tokens a deposit nests inside tokens',
      inMath((size) => nestTo('<mi mathvariant="double-struck">a', 'R', '</mi>', size)),
    ],
    [
      'back-to-back regions',
      (size) => repeatTo('<math><msup><mi>x</mi><mn>2</mn></msup></math> ', size),
    ],
    ['one wide region', inMath((size) => repeatTo('<mi>x</mi><mo>+</mo>', size))],
    [
      'one wide table',
      inMath((size) =>
        repeatTo(
          '<mtr><mtd><mfrac><mi>a</mi><mi>b</mi></mfrac></mtd><mtd><mn>1</mn></mtd></mtr>',
          size,
        ),
      ),
    ],
    [
      'a wide TeX-annotated region',
      inMath((size) =>
        `<semantics>${repeatTo('<mi>x</mi>', size - 90)}<annotation encoding="application/x-tex">x</annotation></semantics>`.slice(
          0,
          size,
        ),
      ),
    ],
  ];

  it.each(shapes)(
    'stays linear and stack-safe on %s',
    (_name, make) => {
      const { ms, ratio } = measureScaling(make, (raw) => {
        normalizeMarkupText(raw);
        normalizeReferenceText(raw);
      });
      expect(ratio, `t = ${ms.map((t) => t.toFixed(2)).join(' / ')} ms`).toBeLessThan(64);
      expect(ms[2]).toBeLessThan(100);
    },
    60_000,
  );

  it('returns a deeply nested region whole', () => {
    const depth = 6_000;
    const raw = `<math>${'<mrow>'.repeat(depth)}<msup><mi>x</mi><mn>2</mn></msup>${'</mrow>'.repeat(depth)}</math>`;
    expect(normalizeMarkupText(raw)).toBe('x^2');
    const radicals = `<math>${'<msqrt>'.repeat(depth)}<mi>x</mi>${'</msqrt>'.repeat(depth)}</math>`;
    expect(normalizeMarkupText(radicals)).toBe(`${'√('.repeat(depth)}x${')'.repeat(depth)}`);
  });
});
