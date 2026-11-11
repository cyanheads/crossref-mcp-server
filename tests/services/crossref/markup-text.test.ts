/**
 * @fileoverview The text normalization passes — the baseline `normalizeText`, the JATS pass
 * (`stripJats`, `normalizeMarkupText`, `normalizeAbstract`), and the reference pass
 * (`stripReferenceMarkup`, `normalizeReferenceText`) — pinned by what a caller sees: the shape
 * test, the regions, the separator classes, the link rule, and the one thing the two markup
 * surfaces disagree on.
 * @module tests/services/crossref/markup-text.test
 */

import { describe, expect, it } from 'vitest';
import {
  ELEMENT_VERDICTS,
  normalizeAbstract,
  normalizeMarkupText,
  normalizeReferenceText,
  normalizeText,
  stripJats,
  stripReferenceMarkup,
} from '@/services/crossref/markup-text.js';
import { expectLinearScaling, nestTo, repeatTo, repeatWhole } from '../../helpers/scaling.js';

describe('stripJats', () => {
  it('removes XML tags from abstract', () => {
    const raw = '<abstract><p>Gene editing was studied.</p></abstract>';
    expect(stripJats(raw)).toBe('Gene editing was studied.');
  });

  it('collapses multiple spaces from tag removal', () => {
    const raw = '<jats:title>Background</jats:title> <jats:p>Body text.</jats:p>';
    const result = stripJats(raw);
    expect(result).not.toMatch(/\s{2,}/);
    expect(result).toContain('Background');
    expect(result).toContain('Body text.');
  });

  it('returns plain text unchanged', () => {
    expect(stripJats('No tags here.')).toBe('No tags here.');
  });

  it('handles self-closing tags', () => {
    expect(stripJats('<br/>Line two')).toBe('Line two');
  });

  /**
   * A lone newline with no adjacent indentation is a single whitespace character, so a
   * collapse keyed on runs of two or more leaves it in place — enough to split a Markdown
   * heading in `content[]` on its own.
   */
  it('collapses a lone newline, not just runs of two or more', () => {
    expect(stripJats('In vivo\nCRISPR biosensing')).toBe('In vivo CRISPR biosensing');
    expect(stripJats('Tab\tseparated')).toBe('Tab separated');
  });
});

describe('normalizeText', () => {
  it('decodes entities and collapses whitespace', () => {
    expect(normalizeText('  Users&apos; guides   to the\n   literature ')).toBe(
      "Users' guides to the literature",
    );
  });

  it('leaves angle-bracketed content in place', () => {
    expect(normalizeText('International <IR> Framework')).toBe('International <IR> Framework');
  });

  it('collapses whitespace an entity decodes into', () => {
    expect(normalizeText('a&#10;b')).toBe('a b');
  });

  /**
   * The named whitespace references fold the same way the numeric ones do, because the decode
   * runs before the collapse. A non-breaking space reaching `content[]` intact renders as an
   * ordinary space a reader cannot select or search for.
   */
  it('collapses whitespace a named reference decodes into', () => {
    expect(normalizeText('Vol.&nbsp;12,&Tab;p.&NewLine;44')).toBe('Vol. 12, p. 44');
  });

  /**
   * Every free-text value a record deposits passes through here — names, places, departments,
   * degrees, group titles — at whatever length the depositor typed, so the cost stays linear in
   * it: one decode pass, then one whitespace collapse.
   */
  it.each([
    ['one long line ending in a break', (size: number) => `${repeatTo('§1 x', size - 2)}\ny`],
    ['breaks throughout', (size: number) => repeatTo('  \r\n', size)],
    ['references to whitespace throughout', (size: number) => repeatWhole('&nbsp;&#10; ', size)],
  ])(
    'stays linear on %s',
    (_name, make) => {
      expectLinearScaling(make, normalizeText);
    },
    60_000,
  );
});

describe('normalizeMarkupText', () => {
  it('strips JATS tags and collapses the newline-plus-indent they leave behind', () => {
    expect(normalizeMarkupText('<i>In vivo</i>\n                    CRISPR biosensing')).toBe(
      'In vivo CRISPR biosensing',
    );
  });

  it('collapses a lone newline in a title with no adjacent indentation', () => {
    expect(normalizeMarkupText('<i>In vivo</i>\nCRISPR biosensing')).toBe(
      'In vivo CRISPR biosensing',
    );
  });

  /**
   * Tags come out before entities are decoded, so a deposited `&lt;i&gt;` stays literal text
   * rather than decoding into a tag the strip pass then eats.
   */
  it('keeps an escaped tag as literal text', () => {
    expect(normalizeMarkupText('Use &lt;i&gt; for italics')).toBe('Use <i> for italics');
    // Same protection through the numeric spelling, and through a double escape.
    expect(normalizeMarkupText('Use &#60;i&#62; for italics')).toBe('Use <i> for italics');
    expect(normalizeMarkupText('Deposited as &amp;lt;i&amp;gt;')).toBe('Deposited as &lt;i&gt;');
  });

  /** A title carries the same named references a citation does. */
  it('decodes a named reference in a title', () => {
    expect(normalizeMarkupText('Kinase isoforms p38&alpha; and p38&beta;')).toBe(
      'Kinase isoforms p38α and p38β',
    );
  });

  /**
   * A subscript or superscript continues the token around it, so removing one must leave no
   * separator behind — a space there splits a chemical formula. Every other tag is a word
   * boundary and still becomes a space.
   */
  it('joins subscripts and superscripts tight while other tags stay word boundaries', () => {
    expect(normalizeMarkupText('CO<sub>2</sub> uptake in <i>E. coli</i> &amp; yeast')).toBe(
      'CO2 uptake in E. coli & yeast',
    );
    expect(normalizeMarkupText('Adsorption of Co<sup>2+</sup> by Oxides')).toBe(
      'Adsorption of Co^{2+} by Oxides',
    );
    expect(normalizeMarkupText('Fe<jats:sub>3</jats:sub>O<jats:sub>4</jats:sub> Core')).toBe(
      'Fe3O4 Core',
    );
  });

  /**
   * The tight join keys on the element name, so it must not catch an unrelated element that
   * merely starts with the same letters, and it must not disturb the space an abstract's
   * paragraph boundary depends on.
   */
  it('keeps the paragraph separator and leaves sub-prefixed element names as boundaries', () => {
    expect(normalizeMarkupText('<jats:p>Para one.</jats:p><jats:p>Para two.</jats:p>')).toBe(
      'Para one. Para two.',
    );
    expect(normalizeMarkupText('end<jats:supplementary-material />next')).toBe('end next');
    expect(normalizeMarkupText('a<subject>b</subject>c')).toBe('a b c');
  });

  /**
   * The deposit behind the divergence: an abstract whose formulas are presentation MathML
   * wrapped in `<inline-formula>`. Every tag inside the region comes out with the whitespace
   * a deposit pretty-prints between them, so the expression reads as one token instead of
   * being shattered into single characters — here the TeX annotation the deposit carries, in
   * place of the presentation tree rather than beside it.
   */
  it('renders a MathML formula in an abstract as one expression', () => {
    const abstract = [
      '<p>If',
      '  <inline-formula content-type="math/mathml">',
      '    <mml:math xmlns:mml="http://www.w3.org/1998/Math/MathML" alttext="script upper H">',
      '      <mml:semantics>',
      '        <mml:mrow class="MJX-TeXAtom-ORD">',
      '          <mml:mi mathvariant="script">H</mml:mi>',
      '        </mml:mrow>',
      '        <mml:annotation encoding="application/x-tex">\\mathcal {H}</mml:annotation>',
      '      </mml:semantics>',
      '    </mml:math>',
      '  </inline-formula>',
      '  is a Hilbert space.</p>',
    ].join('\n');
    expect(normalizeMarkupText(abstract)).toBe('If \\mathcal {H} is a Hilbert space.');
  });

  /**
   * A formula region stands as its own token in the sentence — a MathML deposit carries the
   * whole symbol, and publishers deposit it hard against the prose — so its outer edge is a
   * block boundary even though its inner tags join tight.
   */
  it('separates a MathML region from the prose it abuts', () => {
    const raw =
      'states of neutron-rich<mml:math xmlns:mml="x"><mml:mmultiscripts><mml:mi>Si</mml:mi><mml:mprescripts /><mml:none /><mml:mn>33</mml:mn></mml:mmultiscripts></mml:math>and thin films';
    expect(normalizeMarkupText(raw)).toBe('states of neutron-rich ^{33}Si and thin films');
    expect(normalizeReferenceText(raw)).toBe('states of neutron-rich ^{33}Si and thin films');
  });

  /**
   * Whitespace between a region's tags is the deposit's pretty-printing, not part of the
   * expression — it is insignificant in XML, and keeping it splits one token into two. A formula
   * that needs a visible space writes it as a character reference, which the strip leaves for
   * the decode.
   */
  it('drops the whitespace a MathML deposit pretty-prints between its tags', () => {
    expect(normalizeMarkupText('<math>\n  <mi>Airy</mi>\n  <mn>2</mn>\n</math>')).toBe('Airy2');
    expect(
      normalizeMarkupText('<math>\n  <mi>a</mi>\n  <mo>&nbsp;</mo>\n  <mi>b</mi>\n</math>'),
    ).toBe('a b');
  });

  /**
   * The alternate encoding a MathML deposit carries beside its presentation markup is the same
   * expression a second time. Emitting both renders one formula twice.
   */
  it('drops the alternate encoding a MathML deposit carries', () => {
    expect(
      normalizeMarkupText(
        '<math><msup><mi>A</mi><mn>2</mn></msup><annotation-xml encoding="MathML-Content"><apply><power/><ci>A</ci><cn>2</cn></apply></annotation-xml></math>',
      ),
    ).toBe('A^2');
  });

  /**
   * The tight class is shared with the reference pass, so the spellings only that pass used to
   * know join tight here too rather than shattering the token they sit in.
   */
  it('joins every script and formula-wrapper spelling tight', () => {
    expect(normalizeMarkupText('high T<inf>c</inf>-dc-SQUID gradiometers')).toBe(
      'high Tc-dc-SQUID gradiometers',
    );
    expect(normalizeMarkupText('O<Stack><Subscript>2</Subscript></Stack> uptake')).toBe(
      'O2 uptake',
    );
    expect(
      normalizeMarkupText(
        'Ni/<inline-formula><tex-math>$\\hbox{HfO}_{2}$</tex-math></inline-formula>/TiN',
      ),
    ).toBe('Ni/$\\hbox{HfO}_{2}$/TiN');
    // A displayed formula is still a block boundary, here as there.
    expect(normalizeMarkupText('result<disp-formula>E = mc2</disp-formula>follows')).toBe(
      'result E = mc2 follows',
    );
  });

  /**
   * The link exception holds on this surface too, where it is earned. An `<ext-link>` whose
   * `xlink:href` addresses a trial record its text does not name keeps its tag, because
   * removing the tag deletes the address — the same failure the rule exists to prevent,
   * whichever field it happens in.
   */
  it('leaves a link in an abstract whole when its address is only in the href', () => {
    const raw =
      '<jats:p>Registered at <jats:ext-link ext-link-type="clintrialgov" xlink:href="https://clinicaltrials.gov/ct2/show/NCT01234567">NCT01234567</jats:ext-link>.</jats:p>';
    expect(normalizeMarkupText(raw)).toBe(
      'Registered at <jats:ext-link ext-link-type="clintrialgov" xlink:href="https://clinicaltrials.gov/ct2/show/NCT01234567">NCT01234567</jats:ext-link>.',
    );
  });

  /**
   * And comes out where it is not. A structured abstract deposits its trial registration,
   * accession, or URL as the element's own text and repeats it in the `href`, so the tag
   * protects nothing while putting a namespace-bearing XML tag in the middle of an abstract.
   * The trailing space before the period is the deposit's own line break, not the strip's.
   */
  it('removes a link in an abstract whose text already carries the address', () => {
    expect(
      normalizeMarkupText(
        '<jats:sec><jats:title>Trial registration number</jats:title><jats:p>\n  <jats:ext-link xmlns:xlink="http://www.w3.org/1999/xlink" ext-link-type="clintrialgov" xlink:href="NCT06494904">NCT06494904</jats:ext-link>\n  .\n</jats:p></jats:sec>',
      ),
    ).toBe('Trial registration number NCT06494904 .');
    expect(
      normalizeMarkupText(
        'Visit <jats:uri xmlns:xlink="http://www.w3.org/1999/xlink" xlink:type="simple" xlink:href="http://www.microscopy.com">http://www.microscopy.com</jats:uri> today.',
      ),
    ).toBe('Visit http://www.microscopy.com today.');
  });
});

/**
 * The abstract's own pass: the JATS pass, plus a delimiter after each section heading and no
 * leading "Abstract" label. Every other field keeps `normalizeMarkupText`, whose pins above and
 * in the `differing` table below stay as they are.
 */
describe('normalizeAbstract', () => {
  it.each([
    // A section heading ends with `: ` instead of running into its text.
    ['<sec><title>Background</title><p>Body.</p></sec>', 'Background: Body.'],
    [
      '<jats:sec><jats:title>Objectives</jats:title><jats:p>Reducing SB.</jats:p></jats:sec><jats:sec><jats:title>Design</jats:title><jats:p>A realist review.</jats:p></jats:sec>',
      'Objectives: Reducing SB. Design: A realist review.',
    ],
    // The leading "Abstract" label is dropped, in any letter case, at the root or in a section.
    [
      '<title>Abstract</title><sec><title>Background</title><p>Body.</p></sec>',
      'Background: Body.',
    ],
    ['<jats:title>ABSTRACT</jats:title>\n  <jats:p>Text.</jats:p>', 'Text.'],
    ['<jats:sec><jats:title>abstract</jats:title><jats:p>Text.</jats:p></jats:sec>', 'Text.'],
    // A heading already ending in . : ? or ! takes no second delimiter.
    ['<title>Objective:</title><p>X.</p>', 'Objective: X.'],
    ['<title>Methods.</title><p>X.</p>', 'Methods. X.'],
    ['<title>Why now?</title><p>X.</p>', 'Why now? X.'],
    ['<title>Results!</title><p>X.</p>', 'Results! X.'],
    // Only the last character counts, and only those four: inside the heading, or another mark, no.
    ['<title>Phase 2.5 results</title><p>x</p>', 'Phase 2.5 results: x'],
    ['<title>Results (primary endpoint)</title><p>x</p>', 'Results (primary endpoint): x'],
    // An empty heading adds nothing, self-closing or not, and opens nothing for the next one.
    ['<jats:title/><jats:p>Text.</jats:p>', 'Text.'],
    ['<p>One.</p><title></title><title> </title><p>Two.</p>', 'One. Two.'],
    [
      '<jats:title/><jats:sec><jats:title>Background</jats:title><jats:p>Body.</jats:p></jats:sec>',
      'Background: Body.',
    ],
    // Namespaced, bare, and attribute-bearing headings read alike.
    [
      '<jats:sec><jats:title content-type="abstract-subheading">Results</jats:title><jats:p>R.</jats:p></jats:sec>',
      'Results: R.',
    ],
    [
      '<sec id="s2"><title content-type="abstract-heading">Results</title><p>R.</p></sec>',
      'Results: R.',
    ],
    // The element name is read in any letter case, as every other element verdict reads it.
    ['<TITLE>Background</TITLE><p>x</p>', 'Background: x'],
    // A heading is read as text: markup out, references decoded once, edge whitespace gone.
    ['<title><italic>In vitro</italic> results</title><p>x</p>', 'In vitro results: x'],
    ['<title>Q&amp;A</title><p>x</p>', 'Q&A: x'],
    ['<title>Use of &lt;i&gt;</title><p>x</p>', 'Use of <i>: x'],
    ['<title>\n  Conclusions&#160;\n</title><p>x</p>', 'Conclusions: x'],
    ['<title>Role of <mml:math><mml:mi>x</mml:mi></mml:math></title><p>y</p>', 'Role of x: y'],
    // Only a heading with no text before it labels the field; one after text heads a section.
    [
      '<p>Intro.</p><title>Graphical abstract</title><p>x</p><title>Abstract</title><p>y</p>',
      'Intro. Graphical abstract: x Abstract: y',
    ],
    // A heading kept before it is text before it, though no prose separates the two.
    [
      '<sec><title>Highlights</title></sec><title>Abstract</title><p>x</p>',
      'Highlights: Abstract: x',
    ],
    // Only a heading reading just "Abstract" is the label; one that names more is a heading.
    ['<title>Graphical abstract</title><p>x</p>', 'Graphical abstract: x'],
    // Any other leading label is a heading like the rest.
    [
      '<title>Summary</title><sec><title>Background</title><p>x</p></sec>',
      'Summary: Background: x',
    ],
    ['<jats:title>Zusammenfassung</jats:title><jats:p>Text.</jats:p>', 'Zusammenfassung: Text.'],
    // A label typed into the text is the publisher's text.
    ['<jats:p>Abstract. Text follows.</jats:p>', 'Abstract. Text follows.'],
    ['<jats:p>ABSTRACT Objective: x</jats:p>', 'ABSTRACT Objective: x'],
    // A heading with nothing after it still reads as one.
    ['<p>Body.</p><title>Conclusions</title>', 'Body. Conclusions:'],
    // A title nested in another is part of the outer heading, past the first level.
    ['<title><title>A</title> B</title><p>x</p>', 'A B: x'],
    ['<title><title><title>A</title></title> B</title><p>x</p>', 'A B: x'],
    // A title the deposit never closes is no heading, and reads as the JATS pass reads it.
    ['<title>Background<p>Body.</p>', 'Background Body.'],
    ['<title>Background<p>Body text</p>', 'Background Body text'],
    // A closer with no opener is kept as text, and leaves the next heading's count alone.
    ['<p>Intro.</p></title><title>Methods</title><p>x</p>', 'Intro. </title> Methods: x'],
  ])('reads %j as %j', (raw, expected) => {
    expect(normalizeAbstract(raw)).toBe(expected);
  });

  it.each([
    '<jats:title>Abstract</jats:title><jats:p/>',
    '<title>Abstract</title>',
    '<jats:title/>',
    '<title>Abstract</title><p>&#160;</p>',
    '<p>\n  </p>',
    '',
  ])('returns nothing for %j, which leaves no text', (raw) => {
    expect(normalizeAbstract(raw)).toBeUndefined();
  });

  /**
   * Outside a heading, nothing moves: an abstract with no closed `title` reads exactly as the
   * JATS pass reads it, through every region and class that pass applies.
   */
  it('reads an abstract with no heading exactly as the JATS pass does', () => {
    const untitled = [
      '<jats:p>Para one.</jats:p><jats:p>Para two.</jats:p>',
      'CO<sub>2</sub> uptake in <i>E. coli</i> &amp; yeast at 10<sup>16</sup>',
      'Use &lt;i&gt; for italics, and &amp;lt;b&amp;gt; too',
      'the <alternatives><tex-math>$x$</tex-math><graphic href="e.png" /></alternatives> case',
      'Fractal <math xmlns="x"><semantics><mi>A</mi><annotation encoding="application/x-tex">\\mathrm{A}</annotation></semantics></math> processes',
      'Registered at <ext-link xlink:href="https://clinicaltrials.gov/ct2/show/NCT01234567">NCT01234567</ext-link>.',
      '<citation>Kato T. 1984.</citation> and <mixed-citation><title>Beale</title> 1986</mixed-citation>',
      '<p>x</p></title><p>y</p>',
      'International <IR> Framework',
    ];
    for (const raw of untitled) {
      expect(normalizeAbstract(raw), raw).toBe(normalizeMarkupText(raw));
    }
  });

  describe('on adversarial heading input', () => {
    const shapes: Array<[string, (size: number) => string]> = [
      ['title openers that never close', (size) => repeatTo('<jats:title>a', size)],
      ['nested titles', (size) => nestTo('<title>', 'x', '</title>', size)],
      [
        'closed headings',
        (size) => repeatWhole('<title>Abstract</title><sec><title>H</title><p>b.</p></sec>', size),
      ],
      ['empty headings', (size) => repeatWhole('<jats:title/><title></title>', size)],
      ['title closers with no opener', (size) => repeatWhole('</title>', size)],
      ['overlapping title prefixes', (size) => repeatTo('<title<titl', size)],
      [
        'one long line ending in a break',
        (size) => `<title>H</title>${repeatTo('§1 x', size - 18)}\ny`,
      ],
      ['breaks throughout', (size) => repeatTo('  \r\n', size)],
      ['breaks throughout headings', (size) => repeatTo('<title>  \r\n</title>  \r\n', size)],
    ];

    it.each(shapes)(
      'stays linear on %s',
      (_name, make) => {
        expectLinearScaling(make, normalizeAbstract);
      },
      60_000,
    );
  });
});

describe('stripReferenceMarkup', () => {
  it('removes inline emphasis in its HTML, JATS, and Springer spellings', () => {
    expect(stripReferenceMarkup('<em>Remarks on the breakdown</em>')).toBe(
      'Remarks on the breakdown',
    );
    expect(stripReferenceMarkup('<jats:italic>Escherichia coli</jats:italic>')).toBe(
      'Escherichia coli',
    );
    expect(stripReferenceMarkup('<small>DAUVERGNE, D.</small>')).toBe('DAUVERGNE, D.');
    expect(stripReferenceMarkup('<b>94</b>')).toBe('94');
  });

  /**
   * The whole point of the allow-list: every one of these is text a reader needs, written in
   * the same syntax as a tag. A blanket strip deletes all four.
   */
  it('leaves an angle-bracket span whose name is not a formatting element', () => {
    const cases = [
      'FAOSTAT. <http://faostat.fao.org/site/291/default.aspx>.',
      'Silicon <100> nanowires',
      '10.1002/(SICI)1097-461X(1998)66:2<131::AID-QUA4>3.0.CO;2-W',
      'International <IR> Framework',
      'EPA standards, <www.ecfr.gov>, as of May 27, 2014.',
      'ZnxFe3-xO4 (0.01 < x > 0.8) nanoparticles',
      'Si1−xGex layers (0.3<x<0.4)',
      'The subject <subject>Ecology</subject>',
    ];
    for (const raw of cases) expect(stripReferenceMarkup(raw)).toBe(raw);
  });

  /**
   * A link's URL can live in an attribute, so removing the tag can delete it. `a`, `ext-link`,
   * and `uri` — which takes an `xlink:href` in JATS — are off the name list for that reason,
   * and stay whole wherever the text does not already carry what the `href` holds.
   */
  it('leaves a link tag whole so its href survives', () => {
    const anchor = 'Preprint, <a href="http://arxiv.org/abs/1102.1113v1">arXiv:1102.1113v1</a>.';
    expect(stripReferenceMarkup(anchor)).toBe(anchor);
    const doi =
      'Bagci A.S. <a href="http://dx.doi.org/10.2118/113234-MS">doi: 10.2118/113234-MS.</a>';
    expect(stripReferenceMarkup(doi)).toBe(doi);
  });

  /**
   * And comes out where the deposit put the same address in the element's text — the common
   * shape in a reference list, where a publisher links a citation to the URL it already prints.
   */
  it('removes a link tag whose text already carries the address', () => {
    expect(
      stripReferenceMarkup(
        'WHO. <ext-link xlink:href="http://www.who.int/mediacentre/fs375/en/">http://www.who.int/mediacentre/fs375/en/</ext-link>.',
      ),
    ).toBe('WHO. http://www.who.int/mediacentre/fs375/en/.');
    expect(
      stripReferenceMarkup(
        'Available from <uri>https://www.pcne.org/upload/files/417.pdf</uri>. Accessed.',
      ),
    ).toBe('Available from https://www.pcne.org/upload/files/417.pdf. Accessed.');
  });

  /**
   * A bracketed phrase that opens with an allow-listed name is a citation a reader needs, not
   * a tag. Requiring the attribute tail to be `name="value"` pairs is what tells them apart —
   * every one of these reads as a tag under a looser `<name\b[^>]*>` and loses its whole span.
   */
  it('leaves a bracketed phrase that merely opens with an element name', () => {
    const cases = [
      'See <Stack Overflow, https://stackoverflow.com/q/1234>, retrieved 2020.',
      'SCOGS opinion. <Available from: http://www.fda.gov/Food/GRAS/ucm261485.htm>.',
      'Website <The Internet Movie DataBase, http://www.imdb.com/>, November 2012.',
      'La Sécurité Sociale, entre <<ruptures>> affichées',
      'Miller JH (1992) A Short Course, <Small et al. 1990> reprinted.',
    ];
    for (const raw of cases) expect(stripReferenceMarkup(raw)).toBe(raw);
  });

  /**
   * Where the boundary actually falls: a bare single-letter tag is stripped, because the
   * measured cost of leaving `<i>` and `<b>` in place across the corpus far outweighs the
   * bracketed-letter-as-content case, which the sampled corpus does not contain. The
   * multi-word form above is closed by construction; this one is the residual, pinned so a
   * later change to the shape rule cannot move it silently.
   */
  it('strips a bare single-letter tag even where the letter reads as content', () => {
    expect(normalizeReferenceText('variant <b> allele')).toBe('variant allele');
    expect(stripReferenceMarkup('The <B. subtilis> strain')).toBe('The <B. subtilis> strain');
  });

  /**
   * A reference separator one publisher appends to each packed citation. It is self-closing,
   * carries nothing in an attribute, and has no ordinary-word reading, so it is admitted by
   * name like any other block boundary. Admitting it by *shape* instead — treating a
   * self-closing tag as markup whatever its name — was the tempting alternative and would
   * delete `<www.voith.com/>`, a bare-domain URL bracket that parses the same way.
   */
  it('separates on the refersplit marker in both its self-closing spellings', () => {
    expect(
      normalizeReferenceText(
        'BASILE F. Modeling and Design for the Attitude Control Phase of the LISA Drag-Free Mission[D]. Torino: Politecnico di Torino, 2019<refersplit />',
      ),
    ).toBe(
      'BASILE F. Modeling and Design for the Attitude Control Phase of the LISA Drag-Free Mission[D]. Torino: Politecnico di Torino, 2019',
    );
    expect(normalizeReferenceText('First citation.<refersplit/>Second citation.')).toBe(
      'First citation. Second citation.',
    );
    expect(stripReferenceMarkup('Voith turbo, <www.voith.com/>, accessed 2019.')).toBe(
      'Voith turbo, <www.voith.com/>, accessed 2019.',
    );
  });

  /**
   * A valueless attribute is prose as far as the shape test can tell — admitting one reopens
   * `<Bold statement about X>`, which parses as three of them — so `<span hidden>` is not a
   * tag. Its attribute-free closer matches the shape on its own, which is how the element used
   * to come apart: opener kept, closer removed. A closer is now removed only if the matching
   * opener was, so the pair stands or falls together.
   */
  it('keeps both halves of an element whose opening tag fails the shape test', () => {
    expect(stripReferenceMarkup('a <span hidden>b</span> c')).toBe('a <span hidden>b</span> c');
    expect(stripReferenceMarkup('a <i lang>b</i> c')).toBe('a <i lang>b</i> c');
    expect(stripJats('a <span hidden>b</span> c')).toBe('a <span hidden>b</span> c');
    // A closer with no opener at all has the same standing: nothing to close.
    expect(stripReferenceMarkup('trailing</i> fragment')).toBe('trailing</i> fragment');
    // Improper nesting still resolves each closer against its own opener.
    expect(stripReferenceMarkup('<i><b>x</i></b>')).toBe('x');
    // And a closer resolves against its own name, not against whatever opener is on top:
    // an enclosing `<i>` is not what `</span>` closes.
    expect(stripReferenceMarkup('<i>a <span hidden>b</span> c</i>')).toBe(
      'a <span hidden>b</span> c',
    );
  });

  /**
   * A deeply nested or bracket-heavy field must not send the matcher superlinear. Measured by
   * growth, not against a single budget: t(320k)/t(5k) is 64 for linear work and 4096 for
   * quadratic.
   */
  describe('on adversarial bracket input', () => {
    const shapes: Array<[string, (size: number) => string]> = [
      ['nested inline tags', (size) => nestTo('<i><b><sub>', 'x', '</sub></b></i>', size)],
      /**
       * A tag the deposit never terminated: the attribute tail has to reject it without
       * exploring a parse per attribute. Here and in the href run below, each attribute is long
       * enough that the largest input holds fewer than about 28,000 of them. Past that count
       * JavaScriptCore's regex engine switches to a slower mode for the repeated attribute
       * group. The work stays linear on both sides of the switch, but measured across it the
       * step reads as growth.
       */
      [
        'an unterminated attribute run',
        (size) => `<p class="a" ${repeatWhole('x = "yyyyyyyyyyyyyyyyy" ', size - 13)}`,
      ],
      ['MathML openers', (size) => `${repeatWhole('<math><mi>', size - 1)}z`],
      [
        'closed citation parts',
        (size) => repeatWhole('<mixed-citation><surname>A</surname>', size),
      ],
      ['closers with no opener', (size) => repeatWhole('</i>', size)],
      /**
       * Link elements are the one class that scans forward from a tag for its own closing tag,
       * so a field packed with openers that never close is what makes that scan quadratic if
       * it is written carelessly.
       */
      [
        'link openers that never close',
        (size) => `${repeatWhole('<ext-link xlink:href="https://example.org/a">', size - 1)}x`,
      ],
      ['closed links', (size) => repeatWhole('<a href="https://example.org/a">text</a>', size)],
      /**
       * A link whose href is a long unterminated attribute run: the href matcher has to reject
       * it without exploring a parse per space.
       */
      [
        'an unterminated href run',
        (size) => `<ext-link ${repeatWhole('href = "yyyyyyyyyyyyyy" ', size - 10)}`,
      ],
    ];

    it.each(shapes)(
      'stays linear on %s',
      (_name, make) => {
        expectLinearScaling(make, (raw) => {
          stripReferenceMarkup(raw);
          stripJats(raw);
        });
      },
      60_000,
    );
  });

  /**
   * `<span>` is styling with nothing in an attribute to lose, and the smallcaps role it
   * carries is already admitted as `scp`. The ordinal beside it is the reason the separator
   * is decided against the string as deposited: removing the `<sup>` first would leave
   * `xvii` abutting `e` and the word-boundary rule would split what is one word.
   */
  it('strips a styling span and keeps the ordinal that follows it tight', () => {
    expect(
      stripReferenceMarkup(
        'Les sciences de la vie au <span class="smallcaps">xvii</span><sup>e</sup> et <span class="smallcaps">xviii</span><sup>e</sup> siècles',
      ),
    ).toBe('Les sciences de la vie au xviie et xviiie siècles');
  });

  /** `inf` is the Elsevier and IEEE spelling of a subscript, so it joins tight like `sub`. */
  it('joins the inf spelling of a subscript tight', () => {
    expect(
      stripReferenceMarkup('development of a heart monitoring system with high T<inf>c</inf>-dc'),
    ).toBe('development of a heart monitoring system with high Tc-dc');
  });

  /**
   * A TeX formula wrapper carries nothing its content does not — stripping it leaves the
   * formula in a notation a reader can follow, where leaving it wraps that same formula in
   * XML. The wrapper joins tight for the same reason a script does.
   */
  it('unwraps a TeX formula to the notation it wraps', () => {
    expect(
      stripReferenceMarkup(
        'Correlation of <ref_formula><tex Notation="TeX">$\\hbox{1}/f$</tex></ref_formula> noise',
      ),
    ).toBe('Correlation of $\\hbox{1}/f$ noise');
    expect(
      stripReferenceMarkup(
        'Ni-Silicide/<formula formulatype="inline"><tex Notation="TeX">$\\hbox{HfO}_{2}$</tex></formula>/TiN cells',
      ),
    ).toBe('Ni-Silicide/$\\hbox{HfO}_{2}$/TiN cells');
  });

  /** The JATS citation fields publishers deposit bare into an otherwise typed citation. */
  it('strips bare JATS citation fields', () => {
    expect(
      stripReferenceMarkup('Cartwright EJ, Jackson KA, Silk BJ, <etal>et al</etal>.. (2013)'),
    ).toBe('Cartwright EJ, Jackson KA, Silk BJ, et al.. (2013)');
    expect(stripReferenceMarkup('(<fname lang = "en">Knobil, E., eds</fname>.), pp. 1177')).toBe(
      '(Knobil, E., eds.), pp. 1177',
    );
  });

  /**
   * A name that is also an ordinary word stays off the list even when JATS defines it: a
   * bracketed word is how a person writes a quotation or a note, so admitting `volume` would
   * delete a bracketed phrase opening with it. It comes out inside a citation envelope
   * instead, where nothing was typed by hand.
   */
  it('leaves a bare ordinary-word JATS element alone', () => {
    const raw = 'Cold Spring Harbor, N.Y., <volume>876</volume> pp.';
    expect(stripReferenceMarkup(raw)).toBe(raw);
    const wikipedia = "'I Updated the <ref> ': The Evolution of References";
    expect(stripReferenceMarkup(wikipedia)).toBe(wikipedia);
  });

  /**
   * A structured citation deposited whole into a free-text field is XML end to end, so the
   * name-by-name allow-list has nothing to protect there and the envelope is emptied of tags
   * — ordinary-word names included. A link inside it still keeps its address.
   */
  it('renders a JATS structured citation as the citation it encodes', () => {
    expect(
      normalizeReferenceText(
        '<mixed-citation publication-type="journal"><person-group person-group-type="author"><string-name><surname>Fan</surname> <given-names>Li</given-names></string-name>., <string-name><surname>Whitson</surname> <given-names>C. H.</given-names></string-name></person-group> (<year>2006</year>) <article-title>Understanding Gas Condensate Reservoir</article-title>, <source />Oilfield Review, <comment>Winter, 2005/2006</comment>;</mixed-citation>',
      ),
    ).toBe(
      'Fan Li., Whitson C. H. (2006) Understanding Gas Condensate Reservoir, Oilfield Review, Winter, 2005/2006;',
    );
    expect(
      normalizeReferenceText(
        '<p><mixed-citation publication-type="journal"><h3>References</h3><p>Bagci, A.S. 2008. SAGD. <a href="http://dx.doi.org/10.2118/113234-MS">doi: 10.2118/113234-MS.</a></p><p>Kisman, K.E. 1993. Steam Injection.</p></mixed-citation>',
      ),
    ).toBe(
      'References Bagci, A.S. 2008. SAGD. <a href="http://dx.doi.org/10.2118/113234-MS">doi: 10.2118/113234-MS.</a> Kisman, K.E. 1993. Steam Injection.',
    );
  });

  /** All or nothing, the same way an unclosed MathML span is left whole. */
  it('leaves an unclosed citation envelope untouched', () => {
    const raw = '<mixed-citation publication-type="journal"><surname>Fan</surname> with no end';
    expect(stripReferenceMarkup(raw)).toBe(
      '<mixed-citation publication-type="journal">Fan with no end',
    );
  });

  /** The envelope is recognized under every spelling JATS and NLM define for it. */
  it('empties a citation envelope in each of its spellings', () => {
    expect(
      normalizeReferenceText(
        '<element-citation publication-type="journal"><surname>Fan</surname> <given-names>Li</given-names>. <article-title>A title</article-title>. <year>2006</year>.</element-citation>',
      ),
    ).toBe('Fan Li. A title. 2006.');
    expect(
      normalizeReferenceText(
        '<nlm-citation citation-type="journal"><collab>WHO</collab>. <source>Bulletin</source>. <year>2011</year>.</nlm-citation>',
      ),
    ).toBe('WHO. Bulletin. 2011.');
    expect(
      normalizeReferenceText(
        '<citation><surname>Kato</surname> <given-names>T.</given-names>, <source>Comm. Math. Phys.</source> <volume>94</volume>.</citation>',
      ),
    ).toBe('Kato T., Comm. Math. Phys. 94.');
  });

  /** Each envelope closes at its own end tag, so two in one field stay two citations. */
  it('closes each envelope at its own end tag', () => {
    expect(
      normalizeReferenceText(
        '<citation>Kato T. 1984.</citation> and <citation>Beale J. 1986.</citation>',
      ),
    ).toBe('Kato T. 1984. and Beale J. 1986.');
  });

  /**
   * The link exception holds at any nesting: inside an envelope every other name comes out
   * unconditionally, while a link is still decided against its own text. An envelope settles
   * that nothing inside it was typed by hand; it says nothing about where an address lives.
   */
  it('decides a link inside a citation envelope on its own text', () => {
    expect(
      normalizeReferenceText(
        '<mixed-citation>Available from <uri>https://www.pcne.org/x.pdf</uri>. Accessed.</mixed-citation>',
      ),
    ).toBe('Available from https://www.pcne.org/x.pdf. Accessed.');
    expect(
      normalizeReferenceText(
        '<mixed-citation>WHO. <ext-link xlink:href="http://who.int/a/b">factsheet</ext-link>.</mixed-citation>',
      ),
    ).toBe('WHO. <ext-link xlink:href="http://who.int/a/b">factsheet</ext-link>.');
  });

  /** A displayed formula is a block boundary; an inline one and its TeX body join tight. */
  it('separates a displayed formula and joins an inline one tight', () => {
    expect(
      normalizeReferenceText('the result<disp-formula id="e1">E = mc2</disp-formula>follows'),
    ).toBe('the result E = mc2 follows');
    expect(
      normalizeReferenceText(
        'Ni/<inline-formula><tex-math>$\\hbox{HfO}_{2}$</tex-math></inline-formula>/TiN',
      ),
    ).toBe('Ni/$\\hbox{HfO}_{2}$/TiN');
  });

  /**
   * The name fields a publisher deposits bare, outside any envelope. Each is a markup-only
   * token with no ordinary-word reading, so it is on the allow-list and comes out as a word
   * boundary — the same treatment inline emphasis gets.
   */
  it('strips bare JATS name fields outside an envelope', () => {
    expect(
      normalizeReferenceText('Published by <collab>World Health Organization</collab>, 2011.'),
    ).toBe('Published by World Health Organization, 2011.');
    expect(
      normalizeReferenceText(
        'Cited: <string-name><surname>Fan</surname> <given-names>Li</given-names></string-name>, 2006.',
      ),
    ).toBe('Cited: Fan Li, 2006.');
    expect(
      normalizeReferenceText(
        'Kato T., <article-title>Remarks on the breakdown</article-title>, Comm. Math. Phys.',
      ),
    ).toBe('Kato T., Remarks on the breakdown, Comm. Math. Phys.');
    expect(
      normalizeReferenceText(
        '<person-group person-group-type="author">Kato T., Majda A.</person-group> (1984)',
      ),
    ).toBe('Kato T., Majda A. (1984)');
  });

  /**
   * Inline emphasis is a word boundary, so it leaves a space only where it separates two word
   * characters. A citation's italic journal title is followed by a comma far more often than
   * by a word, and a space before that comma is the artifact a blanket space-for-every-tag
   * rule introduces on nearly every entry it touches.
   */
  it('leaves a separator only between two word characters', () => {
    expect(stripReferenceMarkup('T.Isobe, <i>J. Am. ceram. Soc.</i>, <b>90</b>, 3720')).toBe(
      'T.Isobe, J. Am. ceram. Soc., 90, 3720',
    );
    expect(stripReferenceMarkup('A<i>B</i>C')).toBe('A B C');
  });

  /**
   * A publisher packing several citations into one field separates them with a block tag, and
   * the separator has to survive the word-character test the inline rule applies — the text
   * before it ends in a period, not a word character.
   */
  it('always separates block boundaries', () => {
    expect(
      normalizeReferenceText(
        '<p class="Reference">Barraud, P.J. (1929) A revision.</p><p class="Reference">Smith, J. (1930) Another.</p>',
      ),
    ).toBe('Barraud, P.J. (1929) A revision. Smith, J. (1930) Another.');
  });

  /** Scripts continue the token around them, in every spelling a deposit uses. */
  it('joins scripts tight', () => {
    expect(stripReferenceMarkup('H<sub>2</sub>O<sub>2</sub>')).toBe('H2O2');
    expect(
      stripReferenceMarkup('O<Stack><Subscript>2</Subscript><Superscript>-</Superscript></Stack>'),
    ).toBe('O2^-');
  });

  /**
   * A MathML span is matched end to end and its inner tags come out tight, so the formula
   * reads as one token. Deleting the span would delete the symbol the sentence is about.
   */
  it('renders a MathML formula as its tight-joined content', () => {
    expect(
      stripReferenceMarkup(
        'Fractal geometry of <math xmlns="http://www.w3.org/1998/Math/MathML" id="eq_3"><msub><mrow><mi mathvariant="normal">Airy</mi></mrow><mrow><mn>2</mn></mrow></msub></math> processes',
      ),
    ).toBe('Fractal geometry of Airy_2 processes');
  });

  /** An unclosed formula matches nothing, so it is left whole rather than half-stripped. */
  it('leaves an unclosed MathML span untouched', () => {
    const raw = 'Unclosed <math xmlns="x"><mi>Z</mi> formula with no end tag';
    expect(stripReferenceMarkup(raw)).toBe(raw);
  });

  it('returns plain text unchanged', () => {
    expect(stripReferenceMarkup('Smith J. 2010. A paper. Nature.')).toBe(
      'Smith J. 2010. A paper. Nature.',
    );
  });
});

/**
 * An `<alternatives>` wrapper holds one object encoded several ways and expects a consumer to
 * pick one. It is a region rather than a name on a class list, so what it does is settled by
 * position — the first child carrying text — rather than by ranking one notation above another,
 * and a child element nobody has classified is covered by the same rule.
 */
describe('an <alternatives> wrapper', () => {
  /** The deposit behind the report: TeX first, the same formula as presentation MathML second. */
  const REPRODUCTION =
    'for the anti-<inline-formula><alternatives><tex-math>$$k_{\\bot }$$</tex-math>' +
    '<mml:math xmlns:mml="http://www.w3.org/1998/Math/MathML"><mml:msub><mml:mi>k</mml:mi>' +
    '<mml:mi>⊥</mml:mi></mml:msub></mml:math></alternatives></inline-formula> algorithm';

  it('emits one encoding of a formula deposited twice', () => {
    expect(normalizeMarkupText(REPRODUCTION)).toBe('for the anti- $$k_{\\bot }$$ algorithm');
    expect(normalizeReferenceText(REPRODUCTION)).toBe('for the anti- $$k_{\\bot }$$ algorithm');
  });

  /**
   * The wrapper stands as its own token, so consuming it leaves the boundary its tags used to.
   * Publishers deposit the formula hard against the prose on both sides, and without the
   * boundary the sentence runs into the notation and out of it again.
   */
  it('leaves a word boundary where the deposit packs prose against the formula', () => {
    expect(
      normalizeMarkupText(
        'on a time scale<inline-formula><alternatives><tex-math>$\\mathbb{T}$</tex-math>' +
          '<mml:math><mml:mi>T</mml:mi></mml:math></alternatives></inline-formula>with two',
      ),
    ).toBe('on a time scale $\\mathbb{T}$ with two');

    expect(
      normalizeMarkupText(
        'is 43 μV/cm<inline-formula><alternatives><tex-math>$\\sqrt{\\text{Hz}}$</tex-math>' +
          '<mml:math><mml:msqrt><mml:mtext>Hz</mml:mtext></mml:msqrt></mml:math>' +
          '</alternatives></inline-formula> in the absence',
      ),
    ).toBe('is 43 μV/cm $\\sqrt{\\text{Hz}}$ in the absence');
  });

  /**
   * The boundary is the wrapper's own rather than the selected child's, so the same construct
   * spaces the same way whichever notation a publisher deposited first. Decided by the child it
   * would not: a MathML region carries a boundary and a `<tex-math>` wrapper joins tight.
   */
  it('spaces the same however the encodings are ordered', () => {
    const texFirst =
      'scale<alternatives><tex-math>$T$</tex-math><mml:math><mml:mi>T</mml:mi></mml:math>' +
      '</alternatives>with';
    const mathmlFirst =
      'scale<alternatives><mml:math><mml:mi>T</mml:mi></mml:math><tex-math>$T$</tex-math>' +
      '</alternatives>with';
    expect(normalizeMarkupText(texFirst)).toBe('scale $T$ with');
    expect(normalizeMarkupText(mathmlFirst)).toBe('scale T with');
  });

  /**
   * The selected child is handed back as deposited, so the pass that follows classifies it like
   * any other markup — here a MathML region, read as one token.
   */
  it('classifies the child it selects rather than emitting it raw', () => {
    const graphicFirst =
      'the <alternatives><inline-graphic xlink:href="eq1.gif" />' +
      '<mml:math><mml:msub><mml:mi>Airy</mml:mi><mml:mn>2</mml:mn></mml:msub></mml:math>' +
      '</alternatives> process';
    expect(normalizeMarkupText(graphicFirst)).toBe('the Airy_2 process');
    expect(normalizeReferenceText(graphicFirst)).toBe('the Airy_2 process');
  });

  /** A child carrying no text is passed over on that basis, not by its element name. */
  it('passes over a text-free child whatever it is called', () => {
    expect(
      normalizeMarkupText(
        'a <alternatives><novel-encoding data="x" /><tex-math>$y$</tex-math></alternatives> b',
      ),
    ).toBe('a $y$ b');
    /**
     * A wrapper whose every child is text-free selects nothing and emits nothing. On the JATS
     * surface that is indistinguishable from emitting the children and letting the block
     * default remove them; the reference surface, where an unrecognized name is content, is
     * where the difference between "selected nothing" and "selected the wrapper's contents"
     * is visible at all.
     */
    const allGraphics =
      'a <alternatives><graphic href="e.png" /><inline-graphic href="f.png" /></alternatives> b';
    expect(normalizeMarkupText(allGraphics)).toBe('a b');
    expect(normalizeReferenceText(allGraphics)).toBe('a b');
  });

  /**
   * All or nothing, as every region is. An unclosed wrapper matches nothing and falls to the
   * name rule, which is what keeps the ordinary word `alternatives` from costing a reader a
   * bracketed phrase on the surface where an unrecognized name is content.
   */
  it('is the closed pair, not the word', () => {
    expect(normalizeReferenceText('see <alternatives> to this approach')).toBe(
      'see <alternatives> to this approach',
    );
    expect(normalizeReferenceText('two <alternatives, both untested> remain')).toBe(
      'two <alternatives, both untested> remain',
    );
  });

  /** A wrapper holding no child element keeps its content: nothing in it can be a duplicate. */
  it('keeps content it cannot have selected between', () => {
    expect(normalizeMarkupText('a <alternatives>bare text</alternatives> b')).toBe('a bare text b');
  });

  /** A child's own nested markup travels with it rather than ending it early. */
  it('takes a nested child whole', () => {
    expect(
      normalizeMarkupText(
        'x <alternatives><tex-math><i>a</i>+<i>b</i></tex-math><graphic href="g.png" /></alternatives> y',
      ),
    ).toBe('x a+b y');
  });

  /** Deeply nested children cost work proportional to the input, not exponential in its depth. */
  it('stays linear on an adversarially nested wrapper', () => {
    expectLinearScaling(
      (size) => `<alternatives>${nestTo('<a-child>', 'x', '</a-child>', size - 29)}</alternatives>`,
      normalizeReferenceText,
    );
  }, 60_000);
});

/**
 * The two markup passes run one implementation over one rule and differ in exactly one thing:
 * what an unrecognized element name means. Everything else — the shape test, the regions, the
 * three separator classes, the link exception — is shared, and this file is what keeps it that
 * way. Each surface drifting from the other has been the defect four times running; a case that
 * belongs in the agreeing list and is not there is how the fifth one starts.
 */
describe('the JATS pass and the reference pass', () => {
  /**
   * Everything a recognized element name decides is shared, so both passes answer identically.
   * Half of these are the content survivors the reference rule exists to protect — they are
   * listed here rather than only on the reference surface because the shape test now guards
   * both, and a bracketed URL in a container title is no more disposable than one in a citation.
   */
  it('agrees on every input either surface recognizes', () => {
    const agreeing: Array<[string, string]> = [
      // Scripts and formula wrappers join tight, in every spelling.
      ['Uptake of CO<sub>2</sub> and H<sub>2</sub>O', 'Uptake of CO2 and H2O'],
      ['high T<inf>c</inf>-dc-SQUID gradiometers', 'high Tc-dc-SQUID gradiometers'],
      ['O<Stack><Subscript>2</Subscript><Superscript>-</Superscript></Stack>', 'O2^-'],
      ['Ni/<inline-formula><tex-math>$x$</tex-math></inline-formula>/TiN', 'Ni/$x$/TiN'],
      [
        'Correlation of <ref_formula><tex>$1/f$</tex></ref_formula> noise',
        'Correlation of $1/f$ noise',
      ],
      // A MathML formula is a region on both surfaces, and renders once.
      [
        'Fractal geometry of <math xmlns="x"><semantics><msub><mi>Airy</mi><mn>2</mn></msub><annotation encoding="application/x-tex">\\mathrm{Airy}_2</annotation></semantics></math> processes',
        'Fractal geometry of \\mathrm{Airy}_2 processes',
      ],
      // An alternatives wrapper is a region too, and renders one of its encodings.
      [
        'the <alternatives><tex-math>$x$</tex-math><graphic href="e.png" /></alternatives> case',
        'the $x$ case',
      ],
      // Inline emphasis is a word boundary, not an unconditional space.
      [
        'T.Isobe, <i>J. Am. ceram. Soc.</i>, <b>90</b>, 3720',
        'T.Isobe, J. Am. ceram. Soc., 90, 3720',
      ],
      ['A<i>B</i>C', 'A B C'],
      // A word character is any script's letter or digit, not just ASCII.
      ['Влияние<i>температуры</i>на', 'Влияние температуры на'],
      ['<span class="smallcaps">xvii</span><sup>e</sup> siècles', 'xviie siècles'],
      // A sentence-ending mark counts on the left the way a word character does, so a heading
      // a publisher marks with `<bold>` instead of `<title>` keeps its space.
      [
        'effectiveness of MOC.<bold>Methods</bold>We performed',
        'effectiveness of MOC. Methods We performed',
      ],
      [
        'Nobility or Utility?<i>Zamindars</i>, businessmen',
        'Nobility or Utility? Zamindars, businessmen',
      ],
      // It counts on the left only, or an italic journal title gains back the stray space
      // before the comma that the word-boundary rule exists to remove.
      ['<i>J. Am. Ceram. Soc.</i>, 49', 'J. Am. Ceram. Soc., 49'],
      // And a comma does not end a sentence: a chemical name that italicizes its locants runs
      // through one, and a space there splits the compound.
      [
        'Sodium Bromide in <i>N</i>,<i>N</i>-Dimethylformamide',
        'Sodium Bromide in N,N-Dimethylformamide',
      ],
      // Block elements always separate.
      ['<p>One citation.</p><p>Another.</p>', 'One citation. Another.'],
      ['Torino: Politecnico, 2019<refersplit />', 'Torino: Politecnico, 2019'],
      // A link keeps its tag, because the address lives in an attribute.
      [
        'Preprint, <a href="http://arxiv.org/abs/1102.1113v1">arXiv:1102.1113v1</a>.',
        'Preprint, <a href="http://arxiv.org/abs/1102.1113v1">arXiv:1102.1113v1</a>.',
      ],
      // The content survivors: a bracket that is not shaped like a tag is not markup, anywhere.
      [
        'FAOSTAT. <http://faostat.fao.org/site/291/default.aspx>.',
        'FAOSTAT. <http://faostat.fao.org/site/291/default.aspx>.',
      ],
      ['Silicon <100> nanowires', 'Silicon <100> nanowires'],
      [
        '10.1002/(SICI)1097-461X(1998)66:2<131::AID-QUA4>3.0.CO;2-W',
        '10.1002/(SICI)1097-461X(1998)66:2<131::AID-QUA4>3.0.CO;2-W',
      ],
      ['ZnxFe3-xO4 (0.01 < x > 0.8) nanoparticles', 'ZnxFe3-xO4 (0.01 < x > 0.8) nanoparticles'],
      ['The <B. subtilis> strain', 'The <B. subtilis> strain'],
      [
        'See <Stack Overflow, https://stackoverflow.com/q/1234>, retrieved 2020.',
        'See <Stack Overflow, https://stackoverflow.com/q/1234>, retrieved 2020.',
      ],
      // A citation envelope closes at its own end tag on both surfaces.
      [
        '<citation>Kato T. 1984.</citation> and <citation>Beale J. 1986.</citation>',
        'Kato T. 1984. and Beale J. 1986.',
      ],
      // The ordering both passes depend on: markup out, then entities.
      ['Use &lt;i&gt; for italics', 'Use <i> for italics'],
      ['Deposited as &amp;lt;i&amp;gt;', 'Deposited as &lt;i&gt;'],
      ['Interleukin-1-&beta; and M&uuml;ller', 'Interleukin-1-β and Müller'],
    ];
    for (const [raw, expected] of agreeing) {
      expect(normalizeMarkupText(raw), `JATS pass on ${raw}`).toBe(expected);
      expect(normalizeReferenceText(raw), `reference pass on ${raw}`).toBe(expected);
    }
  });

  /**
   * The one justified difference, and the whole of it. A title or abstract is deposited as JATS,
   * so a raw `<` in it came out of an XML document: an unrecognized name is structure and is
   * removed as a block boundary, which is the only reason `<sec>` and `<list-item>` do not reach
   * a reader. A reference entry is a citation string a publisher typed, where the same syntax
   * carries content, so an unrecognized name stays.
   */
  it('differs only on an element name neither surface classifies', () => {
    const differing: Array<[string, string, string]> = [
      [
        '<sec><title>Background</title><p>Body.</p></sec>',
        'Background Body.',
        '<sec><title>Background</title> Body. </sec>',
      ],
      ['a<subject>b</subject>c', 'a b c', 'a<subject>b</subject>c'],
      ['<list><list-item>One</list-item></list>', 'One', '<list><list-item>One</list-item></list>'],
      [
        'Cold Spring Harbor, <volume>876</volume> pp.',
        'Cold Spring Harbor, 876 pp.',
        'Cold Spring Harbor, <volume>876</volume> pp.',
      ],
      /**
       * An unclosed region matches nothing on either surface — that part is shared. What is
       * left behind then falls to the same one difference, because no MathML element name is
       * on a class list.
       */
      [
        'Unclosed <math xmlns="x"><mi>Z</mi> with no end',
        'Unclosed Z with no end',
        'Unclosed <math xmlns="x"><mi>Z</mi> with no end',
      ],
    ];
    for (const [raw, jats, reference] of differing) {
      expect(normalizeMarkupText(raw), `JATS pass on ${raw}`).toBe(jats);
      expect(normalizeReferenceText(raw), `reference pass on ${raw}`).toBe(reference);
    }
  });

  /**
   * Every admitted name, pinned by what a caller sees rather than by its presence in a list.
   * Two probes separate the four verdicts: one where the tag sits between two word characters,
   * one where it sits between two periods. A name admitted with no case behind it is how the
   * separator classes drifted the first time. The second probe also separates the two halves of
   * the word-boundary rule: an inline tag opening after a period starts a new word and takes the
   * space, while its closer sits before a period and does not.
   */
  it('gives every classified element name the behavior its class promises', () => {
    const joined: Record<string, [string, string]> = {
      tight: ['aXc', 'a.X.c'],
      inline: ['a X c', 'a. X.c'],
      block: ['a X c', 'a. X .c'],
      keep: ['a<n>X</n>c', 'a.<n>X</n>.c'],
    };
    for (const [name, verdict] of ELEMENT_VERDICTS) {
      const [tight, spaced] = joined[verdict] as [string, string];
      /**
       * A `keep` name is a link element, and it keeps its tags only while its `href` holds an
       * address its text does not. The probe hands it one, so what is measured is the verdict
       * rather than the absence of an attribute; the conditional half is pinned on its own.
       */
      const open =
        verdict === 'keep' ? `<${name} href="https://example.org/${name}/deep">` : `<${name}>`;
      const expand = (s: string) => s.replaceAll('<n>', open).replaceAll('</n>', `</${name}>`);
      for (const pass of [normalizeMarkupText, normalizeReferenceText]) {
        expect(pass(`a${open}X</${name}>c`), `${name} (${verdict})`).toBe(expand(tight));
        expect(pass(`a.${open}X</${name}>.c`), `${name} (${verdict})`).toBe(expand(spaced));
      }
    }
  });

  /**
   * The whole of the link rule, driven on both surfaces because both read it. A link element is
   * the one class decided per occurrence rather than per name: its tags come out exactly when
   * removing them cannot cost the reader the address, and stay whenever it can.
   */
  it('removes a link element only where its address survives without the tag', () => {
    /** Cases where nothing is at risk, so the tags come out as a word boundary. */
    const removed: Array<[string, string]> = [
      // The text repeats the href verbatim — an accession, a registration, a bare URL.
      [
        'number <ext-link ext-link-type="clintrialgov" xlink:href="NCT06494904">NCT06494904</ext-link>.',
        'number NCT06494904.',
      ],
      [
        'number <ext-link ext-link-type="clintrialgov" xlink:href="NCT02105844">NCT02105844</ext-link>.',
        'number NCT02105844.',
      ],
      [
        'at <uri xlink:type="simple" xlink:href="http://www.microscopy.com">http://www.microscopy.com</uri>.',
        'at http://www.microscopy.com.',
      ],
      [
        'Data: <ext-link xlink:href="https://osf.io/t5nes/?view_only=07c7590306624eb7a6510d5c69e26c02" ext-link-type="uri">https://osf.io/t5nes/?view_only=07c7590306624eb7a6510d5c69e26c02</ext-link>',
        'Data: https://osf.io/t5nes/?view_only=07c7590306624eb7a6510d5c69e26c02',
      ],
      // Everything but the scheme is in the text: the reader keeps what identifies the resource.
      [
        'See <ext-link xlink:href="http://www.fasebj.org">www.fasebj.org</ext-link>.',
        'See www.fasebj.org.',
      ],
      [
        'See <ext-link xlink:href="http://www.interscience.wiley.com">www.interscience.wiley.com</ext-link>.',
        'See www.interscience.wiley.com.',
      ],
      // A bare fragment names a place inside the publisher's own XML, which the reader does not
      // have, so it resolves to nothing and there is nothing to preserve.
      [
        'as <ext-link xlink:href="#b1">Turner’s (1995</ext-link>) argued',
        'as Turner’s (1995) argued',
      ],
      ['see <a href="#nph15488-sec-0002">Introduction</a>', 'see Introduction'],
      // No attribute at all: nothing of the element's value lives anywhere but its text.
      [
        'Registered at <ext-link>https://osf.io/cxqrz</ext-link>.',
        'Registered at https://osf.io/cxqrz.',
      ],
      ['<a name="fn1">note</a>', 'note'],
      ['an empty <a href="">anchor</a>', 'an empty anchor'],
      // The tags are a word boundary like any other inline element, not an unconditional space.
      ['A<a href="#x">B</a>C', 'A B C'],
      ['J. Am. Ceram. Soc.<a href="#x">49</a>, 1', 'J. Am. Ceram. Soc. 49, 1'],
      ['see<a href="#x">Fig. 1</a>, and', 'see Fig. 1, and'],
    ];

    /** Cases where the href addresses something the text does not name. */
    const kept = [
      // The path behind a bare host is exactly what identifies the record.
      'URL: <ext-link ext-link-type="uri" xlink:href="https://clinicaltrials.gov/ct2/show/NCT02196038">https://clinicaltrials.gov/</ext-link>;',
      // A hyperlinked taxon or gene name: the text names the thing, the href addresses it.
      '<ext-link xlink:href="https://lpsn.dsmz.de/genus/haloactinopolyspora">Haloactinopolyspora</ext-link>',
      '<ext-link xlink:href="http://www.uniprot.org/uniprot/P12643">BMP-2</ext-link>',
      // `www.` is a DNS label and a trailing slash is a path, so neither is a difference the
      // comparison forgives — the text has to carry the host and path it is given.
      'at <ext-link xlink:href="https://www.example.org/a">example.org/a</ext-link>.',
      'at <ext-link xlink:href="https://example.org/a/">example.org/a</ext-link>.',
      // Nor is a resolver host: `doi.org` is part of the address, not a prefix to be assumed.
      'see <a href="https://doi.org/10.1002/cssc.201600243">10.1002/cssc.201600243</a>.',
      // A self-closing link wraps no text, so nothing there can carry the address.
      'Source <ext-link xlink:href="https://example.org/a" />.',
      // An element the deposit never closes: its text cannot be seen, so it is not judged.
      'Source <ext-link xlink:href="https://example.org/a">unterminated',
    ];

    // A link the deposit never closes does not settle the ones before it. Recording the name
    // as unclosed is what keeps the scan for a closing tag from running once per opener, and
    // it is sound only because tags are visited left to right.
    expect(normalizeMarkupText('a <a href="#x">B</a> c <a href="https://e.org/z">d')).toBe(
      'a B c <a href="https://e.org/z">d',
    );

    for (const [raw, expected] of removed) {
      expect(normalizeMarkupText(raw), `JATS pass on ${raw}`).toBe(expected);
      expect(normalizeReferenceText(raw), `reference pass on ${raw}`).toBe(expected);
    }
    for (const raw of kept) {
      expect(normalizeMarkupText(raw), `JATS pass on ${raw}`).toBe(raw);
      expect(normalizeReferenceText(raw), `reference pass on ${raw}`).toBe(raw);
    }
  });

  /**
   * What the block default costs on the JATS surface, and the whole of that too: a bracketed
   * single token that reads as an element name — an acronym, a bare domain, an ordinary word —
   * is removed as though it were structure. It is the counterpart of the bare single-letter tag
   * the reference surface strips, accepted for the same kind of reason: the alternative leaves
   * `<sec>`, `<title>`, and `<list-item>` standing in every structured abstract. Pinned so a
   * later change to the default cannot move it silently.
   */
  it('removes a bracketed single token from a JATS-deposited field', () => {
    const residual = [
      'International <IR> Framework',
      'EPA standards, <www.ecfr.gov>, as of May 27, 2014.',
      'entre <ruptures> affichées',
    ];
    for (const raw of residual) {
      expect(normalizeMarkupText(raw), `JATS pass on ${raw}`).not.toContain('<');
      expect(normalizeReferenceText(raw), `reference pass on ${raw}`).toBe(raw);
    }
    expect(normalizeMarkupText('International <IR> Framework')).toBe('International Framework');
  });
});

describe('normalizeReferenceText', () => {
  it('strips markup, decodes entities, and collapses whitespace in one pass', () => {
    expect(
      normalizeReferenceText('<i>Users&apos; guides</i>   to the\n     medical literature'),
    ).toBe("Users' guides to the medical literature");
  });

  /**
   * Markup comes out before entities are decoded, so a deposited `&lt;i&gt;` stays literal
   * text rather than decoding into a tag the strip pass then eats — the same order
   * `normalizeMarkupText` depends on.
   */
  it('keeps an escaped tag as literal text', () => {
    expect(normalizeReferenceText('Deposited entity &lt;i&gt;stays literal&lt;/i&gt;')).toBe(
      'Deposited entity <i>stays literal</i>',
    );
    expect(normalizeReferenceText('Double-escaped &amp;lt;i&amp;gt; stays escaped')).toBe(
      'Double-escaped &lt;i&gt; stays escaped',
    );
  });

  /**
   * The deposits behind #51, through the whole pass: a guillemet quotation inside a structured
   * citation, and the Greek and accented Latin a reference list carries.
   */
  it('decodes the named references a citation string carries', () => {
    expect(
      normalizeReferenceText(
        '<mixed-citation publication-type="journal">(<year>2006</year>) <article-title>&laquo;Understanding Gas Condensate Reservoir&raquo;</article-title>, <source />Oilfieald Review</mixed-citation>',
      ),
    ).toBe('(2006) «Understanding Gas Condensate Reservoir», Oilfieald Review');
    expect(
      normalizeReferenceText(
        'Interleukin-1-&beta; (IL-1&beta;), interleukin 6 (IL-6) and tumor necrosis factor',
      ),
    ).toBe('Interleukin-1-β (IL-1β), interleukin 6 (IL-6) and tumor necrosis factor');
    expect(
      normalizeReferenceText('McLaren J, Millican SA, M&uuml;ller KH, et al.: 8, 21&ndash;28'),
    ).toBe('McLaren J, Millican SA, Müller KH, et al.: 8, 21–28');
  });

  /**
   * The bracket rule and the entity table have to stay independent. A cited URL carrying a
   * query string is the case where they meet: `&` there is punctuation the address needs.
   */
  it('leaves a cited URL and its query string byte-exact', () => {
    const raw = 'FAOSTAT. <http://faostat.fao.org/site/291/default.aspx?id=1&lang=en>.';
    expect(normalizeReferenceText(raw)).toBe(raw);
  });
});
