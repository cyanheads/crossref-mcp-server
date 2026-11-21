/**
 * @fileoverview The text normalization passes — the baseline `normalizeText`, the JATS pass
 * (`stripJats`, `normalizeMarkupText`, `normalizeAbstract`), and the reference pass
 * (`stripReferenceMarkup`, `normalizeReferenceText`) — pinned by what a caller sees: the shape
 * test, the regions, the separator classes, the link rule, and the one thing the two markup
 * surfaces disagree on.
 * @module tests/services/crossref/markup-text.test
 */

import { readFileSync } from 'node:fs';
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
    0,
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
   * An escaped tag that names an element rather than marking one up stays as written: an opener
   * no later escaped closer of its name closes, and that follows no escaped closer of its name,
   * is prose about the element. A field holding nothing else reads as it always has. The
   * escaped-markup cases are under `escaped markup on the JATS surface` below.
   */
  it('keeps an escaped tag that names an element as literal text', () => {
    expect(normalizeMarkupText('Use &lt;i&gt; for italics')).toBe('Use <i> for italics');
    // Same protection through the numeric spelling, and through a double escape, which the
    // decode reads through to the tag it names.
    expect(normalizeMarkupText('Use &#60;i&#62; for italics')).toBe('Use <i> for italics');
    expect(normalizeMarkupText('Deposited as &amp;lt;i&amp;gt;')).toBe('Deposited as <i>');
    expect(normalizeMarkupText('e.g. when &amp;lt;choice&amp;gt; appears')).toBe(
      'e.g. when <choice> appears',
    );
    expect(normalizeMarkupText('the &lt;meta&gt; tag')).toBe('the <meta> tag');
    expect(normalizeMarkupText('a&lt;b&gt;c')).toBe('a<b>c');
    expect(normalizeMarkupText('the TEI &lt;gap&gt; element')).toBe('the TEI <gap> element');
    // A reference escaped twice beside one reads as its character, as it does anywhere.
    expect(normalizeMarkupText('the &lt;gap&gt; element&amp;nbsp;')).toBe('the <gap> element');
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
 * The abstract's own pass: the JATS pass, plus a delimiter after each section heading, no
 * leading "Abstract" label, no heading whose section holds no text, and a delimiter between the
 * items of one list. Every other field keeps `normalizeMarkupText`, whose pins above and in the
 * `differing` table below stay as they are.
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
      '<sec><title>Highlights</title><p>h</p></sec><title>Abstract</title><p>x</p>',
      'Highlights: h Abstract: x',
    ],
    ['<title>Summary</title><title>Abstract</title><p>x</p>', 'Summary: Abstract: x'],
    // A heading dropped before it is not: the label is then the first thing left.
    ['<sec><title>Highlights</title></sec><title>Abstract</title><p>x</p>', 'x'],
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
    // A heading at the root with nothing after it before the abstract ends heads nothing.
    ['<p>Body.</p><title>Conclusions</title>', 'Body.'],
    ['<p>Body.</p><title>Conclusions</title><p/>&#160;\n', 'Body.'],
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
    '<sec><title>Graphical Abstract</title></sec>',
    '<jats:title>Abstract</jats:title><jats:sec><jats:title>Visual Abstract:</jats:title><jats:fig><jats:graphic xlink:href="f1"/></jats:fig></jats:sec>',
    '<sec><title>P</title><sec><title>C</title><p/></sec></sec>',
    '<list><list-item></list-item><list-item><p/></list-item></list>',
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
      '&amp;lt;p&amp;gt;HTML &amp;lt;i&amp;gt;escaped&amp;lt;/i&amp;gt; twice&amp;amp;nbsp;&amp;lt;/p&amp;gt;',
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

  /**
   * A heading heads the text after it up to the end of its `sec`, or, outside any `sec`, up to
   * the end of the abstract. One with no text there — a section holding only a figure, an empty
   * paragraph, or nothing — heads nothing and is dropped. Text in a nested section is text of
   * the section around it, so a parent heading over subsections keeps its title, at any depth.
   */
  it.each([
    // A trailing section with no text, in each shape deposits leave one.
    ['<sec><title>A</title><p>x.</p></sec><sec><title>Graphical Abstract</title></sec>', 'A: x.'],
    ['<sec><title>A</title><p>x.</p></sec><sec><title>CLINICALTRIAL</title><p/></sec>', 'A: x.'],
    [
      '<sec><title>A</title><p>x.</p></sec><sec><title>Figure 1</title>\n  <p>&#160;</p>\n</sec>',
      'A: x.',
    ],
    [
      '<jats:sec><jats:title>A</jats:title><jats:p>x.</jats:p></jats:sec><jats:sec><jats:title>Visual Abstract:</jats:title><jats:fig id="f"><jats:graphic xlink:href="g"/></jats:fig></jats:sec>',
      'A: x.',
    ],
    // One in the middle goes the same way, and leaves its neighbours alone.
    [
      '<sec><title>A</title><p>x.</p></sec><sec><title>B</title></sec><sec><title>C</title><p>y.</p></sec>',
      'A: x. C: y.',
    ],
    // A heading after the last text of its own section heads nothing, though text follows it.
    ['<sec><title>A</title><p>x.</p><title>B</title></sec><p>y.</p>', 'A: x. y.'],
    // Text after a later heading of the same section is text after the earlier one too.
    ['<sec><title>A</title><title>B</title><p>x.</p></sec>', 'A: B: x.'],
    // A parent whose text sits only in nested sections keeps its title, past the first level.
    ['<sec><title>P</title><sec><title>C</title><p>x.</p></sec></sec>', 'P: C: x.'],
    [
      '<sec><title>P</title><sec><title>Q</title><sec><title>R</title><p>x.</p></sec></sec></sec>',
      'P: Q: R: x.',
    ],
    // A parent whose subsections hold no text heads nothing either, at any depth.
    ['<p>y.</p><sec><title>P</title><sec><title>C</title></sec></sec>', 'y.'],
    [
      '<p>y.</p><sec><title>P</title><sec><title>Q</title><sec><title>R</title></sec></sec></sec>',
      'y.',
    ],
    // A nested empty section is dropped and its parent keeps the text after it.
    ['<sec><title>P</title><sec><title>C</title></sec><p>x.</p></sec>', 'P: x.'],
    // A section the deposit never closes runs to the end of the abstract.
    ['<p>x.</p><sec><title>A</title>', 'x.'],
    ['<sec><title>A</title><p>x.</p>', 'A: x.'],
    ['<sec><sec><title>A</title></sec><p>x.</p>', 'x.'],
    // A closing tag with no opener closes no section, and is text the heading heads.
    ['<title>A</title></sec>', 'A: </sec>'],
    // End tags with whitespace before the bracket close like any other.
    ['<jats:sec ><jats:title>A</jats:title ></jats:sec ><jats:p>x.</jats:p>', 'x.'],
  ])('drops a heading with no text in its section: %j as %j', (raw, expected) => {
    expect(normalizeAbstract(raw)).toBe(expected);
  });

  /**
   * Consecutive items of one list are joined by `; `, unless the earlier item already ends in
   * `.`, `,`, `;`, `:`, `?`, or `!` — the last character only, as a heading is read. The end of
   * a list stays a plain block boundary, like a paragraph's, and an item with no text is not an
   * item the delimiter separates.
   */
  it.each([
    [
      '<jats:list list-type="bullet"><jats:list-item><jats:p>a</jats:p></jats:list-item><jats:list-item><jats:p>b</jats:p></jats:list-item><jats:list-item><jats:p>c</jats:p></jats:list-item></jats:list>',
      'a; b; c',
    ],
    // Every closing mark the earlier item carries already separates it.
    ['<list><list-item>a.</list-item><list-item>b</list-item></list>', 'a. b'],
    ['<list><list-item>a,</list-item><list-item>b</list-item></list>', 'a, b'],
    ['<list><list-item>a;</list-item><list-item>b</list-item></list>', 'a; b'],
    ['<list><list-item>a:</list-item><list-item>b</list-item></list>', 'a: b'],
    ['<list><list-item>a?</list-item><list-item>b</list-item></list>', 'a? b'],
    ['<list><list-item>a!</list-item><list-item>b</list-item></list>', 'a! b'],
    // Only the last character counts, and only those six.
    ['<list><list-item>a.b</list-item><list-item>c</list-item></list>', 'a.b; c'],
    ['<list><list-item>a (b.)</list-item><list-item>c</list-item></list>', 'a (b.); c'],
    [
      '<list><list-item>rated "good" quality</list-item><list-item>c</list-item></list>',
      'rated "good" quality; c',
    ],
    // Whitespace and markup at the item's edge are not its last character.
    [
      '<list>\n  <list-item>\n    <p>a <italic>b</italic></p>\n  </list-item>\n  <list-item><p>c</p></list-item>\n</list>',
      'a b; c',
    ],
    ['<list><list-item>a&#160;</list-item><list-item>b</list-item></list>', 'a; b'],
    // A list's end is a block boundary: nothing joins its last item to what follows.
    ['<list><list-item>a</list-item><list-item>b</list-item></list><p>c</p>', 'a; b c'],
    ['<list><list-item>a</list-item></list><list><list-item>b</list-item></list>', 'a b'],
    ['<p>x</p><list><list-item>a</list-item></list>', 'x a'],
    // An item with no text separates nothing — first, last, or between two that do.
    ['<list><list-item>a</list-item><list-item></list-item></list><p>b</p>', 'a b'],
    ['<list><list-item><p/></list-item><list-item>b</list-item></list>', 'b'],
    ['<list><list-item>a</list-item><list-item/><list-item>c</list-item></list>', 'a; c'],
    [
      '<list><list-item>a</list-item><list-item> </list-item><list-item>c</list-item></list>',
      'a; c',
    ],
    // An item holding several paragraphs is still one item.
    ['<list><list-item><p>a</p><p>b</p></list-item><list-item>c</list-item></list>', 'a b; c'],
    // A nested list separates its own items, and the outer item around it is one item.
    [
      '<list><list-item>a<list><list-item>b</list-item><list-item>c</list-item></list></list-item><list-item>d</list-item></list>',
      'a b; c; d',
    ],
    [
      '<list><list-item>a<list><list-item>b<list><list-item>c</list-item><list-item>d</list-item></list></list-item><list-item>e</list-item></list></list-item><list-item>f</list-item></list>',
      'a b c; d; e; f',
    ],
    // Text between two items of one list is not an item, and nothing joins it to them.
    ['<list><list-item>a</list-item> x <list-item>b</list-item></list>', 'a x b'],
    // Items with no list around them are still consecutive items.
    ['<list-item>a</list-item><list-item>b</list-item>', 'a; b'],
    // A list title is a heading, and a heading in an item follows the delimiter.
    [
      '<list><title>Key points</title><list-item>a</list-item><list-item>b</list-item></list>',
      'Key points: a; b',
    ],
    ['<list><list-item>a</list-item><list-item><title>H</title>b</list-item></list>', 'a; H: b'],
    // An item holding only a heading carries no text, so the next item owes nothing.
    ['<list><list-item><title>H</title></list-item><list-item>b</list-item></list>', 'H: b'],
    // End tags with whitespace before the bracket close like any other.
    ['<jats:list-item >a</jats:list-item ><jats:list-item>b</jats:list-item >', 'a; b'],
    // An item opener the deposit never closes leaves its item open, so no item follows it.
    ['<list><list-item>a<list-item>b</list>', 'a b'],
    // A CDATA section or a comment is text to the JATS pass, and ends the item as text.
    [
      '<list><list-item><![CDATA[x]]></list-item><list-item>b</list-item></list>',
      '<![CDATA[x]]>; b',
    ],
    ['<list><list-item>a<!-- c --></list-item><list-item>b</list-item></list>', 'a<!-- c -->; b'],
  ])('joins the items of one list: %j as %j', (raw, expected) => {
    expect(normalizeAbstract(raw)).toBe(expected);
  });

  /** The validator's captured abstracts, as deposited. */
  describe('on captured deposits', () => {
    function depositedAbstract(name: string): string {
      const file = new URL(`../../fixtures/works/${name}.json`, import.meta.url);
      const { message } = JSON.parse(readFileSync(file, 'utf8')) as {
        message: { abstract: string };
      };
      return message.abstract;
    }

    it('joins unpunctuated highlights and drops the figure-only section after them', () => {
      const abstract = normalizeAbstract(depositedAbstract('10.1101_2025.10.16.25338155')) ?? '';
      const highlights =
        ' Highlights: This systematic review investigated whether greenspace protects against respiratory health harms from air pollution; We identified 12 eligible cohort studies, all rated "good" quality; Results mixed but generally suggested greenspace is protective; More consistent findings for mediated pathways, suggesting greenspace reduces pollution in local environment';
      expect(abstract.slice(-highlights.length)).toBe(highlights);
      expect(abstract.startsWith('Exposure to greenspace is associated with improved')).toBe(true);
      expect(abstract).not.toContain('Visual Abstract');
    });

    it('reads highlights that already end in periods as before', () => {
      const abstract = normalizeAbstract(depositedAbstract('10.1002_alz.70069')) ?? '';
      const highlights =
        ' high risk of bias in most studies. Highlights: Numerous models have been developed to predict the likelihood of conversion to dementia in individuals with MCI. Prediction models seem to have a reasonably good performance in predicting conversion to dementia, however, external validation and generalizability is often lacking. There is no prediction model available with a low risk for bias and that has been externally validated to accurately predict the risk of MCI to dementia conversion. For MCI to dementia conversion prediction models, more emphasis should be directed towards external validation, generalizability, and clinical applicability.';
      expect(abstract.slice(-highlights.length)).toBe(highlights);
      expect(abstract.startsWith('Prediction models have been developed')).toBe(true);
    });

    it('keeps a parent heading over subsections and reads lists inside paragraphs as before', () => {
      const abstract = normalizeAbstract(depositedAbstract('10.1111_1460-6984.13007')) ?? '';
      expect(abstract).toContain(
        'for standardisation for clinical and research purposes. WHAT THIS PAPER ADDS: What is already known on the subject: Inducible laryngeal obstruction causes narrowing',
      );
      expect(abstract).toContain(
        'interventions in inducible laryngeal obstruction (ILO). What this paper adds to existing knowledge: Assessment of health',
      );
      const tail =
        ' develop future health outcomes. What are the potential or actual clinical implications of this work? The review will document evidence of health outcomes measured in inducible laryngeal obstruction, identifying measurement characteristics and potential utility. Collating studies may identify gaps in coverage, the need for novel tools and for standardisation for clinical and research purposes.';
      expect(abstract.slice(-tail.length)).toBe(tail);
      expect(abstract).not.toContain(';  ');
    });

    it.each([
      [
        '10.1186_s13071-025-06765-4',
        'Graphical Abstract',
        ' Therefore, we recommend using Aquatain in mosquito control programs as a complementary malaria vector control tool.',
      ],
      [
        '10.1093_esj_aakag023.1154',
        'Figure 1',
        ' Conflict of interest: Talia Bergaglio: nothing to disclose. Lukas Otto: nothing to disclose. Simone Huber: nothing to disclose. Hannah-Lea Handelsmann: nothing to disclose. Hakim Baazaoui: nothing to disclose. Peter Nirmalraj: nothing to disclose. Susanne Wegener: nothing to disclose.',
      ],
    ])('drops the trailing section of %s that holds no text (%s)', (name, dropped, tail) => {
      const abstract = normalizeAbstract(depositedAbstract(name)) ?? '';
      expect(abstract.slice(-tail.length)).toBe(tail);
      expect(abstract).not.toContain(dropped);
    });

    /** The other passes read the same deposits exactly as they did. */
    it('leaves the title and reference passes as they were on the same deposits', () => {
      const raw = depositedAbstract('10.1101_2025.10.16.25338155');
      expect(normalizeMarkupText(raw)).toContain(
        'Highlights This systematic review investigated whether greenspace protects against respiratory health harms from air pollution We identified 12 eligible cohort studies, all rated "good" quality Results mixed but generally suggested greenspace is protective More consistent findings for mediated pathways, suggesting greenspace reduces pollution in local environment Visual Abstract:',
      );
      expect(normalizeReferenceText(raw)).toContain(
        '<jats:list-item> This systematic review investigated whether greenspace protects against respiratory health harms from air pollution </jats:list-item>',
      );
    });
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
      /**
       * The section and list bookkeeping: a heading waits for text until its section closes, and
       * an item waits for text before it owes a delimiter, so openers that never close, sections
       * that close in a burst, and deep nesting are where that waiting could grow quadratic.
       */
      ['list-item openers that never close', (size) => repeatTo('<jats:list-item>a', size)],
      ['sec openers that never close', (size) => repeatTo('<jats:sec>a', size)],
      [
        'headed sec openers that never close',
        (size) => repeatTo('<jats:sec><jats:title>H</jats:title>', size),
      ],
      [
        'headed sec openers that never close, each with text',
        (size) => repeatTo('<jats:sec><jats:title>H</jats:title>a', size),
      ],
      ['nested sections', (size) => nestTo('<sec><title>H</title>', 'x', '</sec>', size)],
      ['nested empty sections', (size) => nestTo('<sec><title>H</title>', '', '</sec>', size)],
      [
        'nested lists',
        (size) =>
          nestTo('<list><list-item>a', 'x', '</list-item><list-item>b</list-item></list>', size),
      ],
      ['closed list items', (size) => repeatWhole('<list-item><p>a</p></list-item>', size)],
      ['empty list items', (size) => `a${repeatWhole('<list-item></list-item>', size - 1)}`],
      ['empty sections', (size) => repeatWhole('<sec><title>H</title></sec>', size)],
      [
        'root headings before a run of section closes',
        (size) =>
          `${repeatWhole('<title>H</title>', size / 2)}${repeatWhole('<sec></sec>', size / 2)}`,
      ],
      [
        'one long list item ending in a break',
        (size) =>
          `<list><list-item>a</list-item><list-item>${repeatTo('§1 x', size - 62)}\ny</list-item></list>`,
      ],
      [
        'list items across breaks',
        (size) => repeatTo('<list-item>\r\n  a\r\n</list-item>\r\n', size),
      ],
      [
        'sections across breaks',
        (size) => repeatTo('<sec>\r\n<title>H</title>\r\n<p>a</p>\r\n</sec>\r\n', size),
      ],
    ];

    it.each(shapes)(
      'stays linear on %s',
      (_name, make) => {
        expectLinearScaling(make, normalizeAbstract);
      },
      0,
    );
  });
});

/** Both JATS-surface entry points, which have to agree on a field with no heading. */
function jats(raw: string): [string, string | undefined] {
  return [normalizeMarkupText(raw), normalizeAbstract(raw)];
}

/**
 * HTML a deposit escaped into its JATS text — `<jats:p>&lt;p&gt;…&lt;/p&gt;</jats:p>`. An escaped
 * tag is markup unless it is an opener other than `br` that no later escaped closer of its name
 * closes and that does not directly follow, whitespace aside, an escaped closer of its name; that
 * one is prose naming an element and stays as written (pinned above under `normalizeMarkupText`).
 * Escaped markup comes out the way the same tags would deposited unescaped, pairs only with
 * escaped tags, and lowers a reference escaped with it by one level. JATS surface only.
 */
describe('escaped markup on the JATS surface', () => {
  /** The deposits behind #111, as Crossref returns them, trimmed to the sentences at issue. */
  it.each([
    [
      '10.2139/ssrn.4908528 abstract',
      '<jats:p>&lt;p&gt;&lt;span&gt;International law is becoming increasingly more specialized and diversified. When you adopt it, importantly, the proliferation of special regimes does not have the disintegrating effect that many scholars believe it to have.&amp;nbsp;&lt;/span&gt;&lt;/p&gt;</jats:p>',
      'International law is becoming increasingly more specialized and diversified. When you adopt it, importantly, the proliferation of special regimes does not have the disintegrating effect that many scholars believe it to have.',
    ],
    [
      '10.2139/ssrn.6511319 title',
      '&lt;p&gt;IP Law, Fast Fashion, and Innovation: A Comparative Empirical&amp;nbsp;&lt;span&gt;Intervention in the Piracy Paradox Debate&lt;/span&gt;&lt;/p&gt;',
      'IP Law, Fast Fashion, and Innovation: A Comparative Empirical Intervention in the Piracy Paradox Debate',
    ],
    [
      '10.7146/brics.v8i9.20464 abstract',
      '<jats:p>&lt;p&gt;We describe a static analysis of &lt;bigwig&gt; programs that efficiently&lt;br /&gt;decides if all dynamically computed XHTML documents presented&lt;br /&gt;to the client will validate according to the official DTD.&lt;/p&gt;</jats:p>',
      'We describe a static analysis of <bigwig> programs that efficiently decides if all dynamically computed XHTML documents presented to the client will validate according to the official DTD.',
    ],
    /**
     * #51 kept this deposit's escaped `<p>` as a literal tag. Paired, it is markup, and the
     * references escaped with it read as the characters they name.
     */
    [
      '10.18686/esta.v7i4.163 abstract',
      '<jats:p>&lt;p&gt;The results clearly showed that the ultimate efficiency of the solar cells made by wafers of 1μs &amp;lt;τ&amp;lt;1.2μs is much higher than that of solar cells made by wafers of τ&amp;lt;1μs.&lt;/p&gt;</jats:p>',
      'The results clearly showed that the ultimate efficiency of the solar cells made by wafers of 1μs <τ<1.2μs is much higher than that of solar cells made by wafers of τ<1μs.',
    ],
  ])('reads %s as the text it marks up', (_name, raw, expected) => {
    expect(jats(raw)).toEqual([expected, expected]);
  });

  it.each([
    [
      '10.2196/preprints.51216',
      '<sec>\n  <title>RESULTS</title>\n  <p>No significant changes were found in self-reported total PA (&lt;i&gt;dz&lt;/i&gt;&lt;0.28, &lt;i&gt;P&lt;/i&gt;=.40 for the self-monitoring group, &lt;i&gt;P&lt;/i&gt;=.58 for the goal setting group).</p>\n</sec>',
      'RESULTS: No significant changes were found in self-reported total PA (dz<0.28, P=.40 for the self-monitoring group, P=.58 for the goal setting group).',
    ],
    [
      '10.2196/preprints.47187',
      '<sec>\n  <title>RESULTS</title>\n  <p>Both groups increased their weekly MVPA minutes significantly at 12 weeks (&lt;i&gt;P&lt;/i&gt;&amp;lt;.001) and maintained the increases at 24 weeks (&lt;i&gt;P&lt;/i&gt;&amp;lt;.001), relative to baseline, with no between-group differences (&lt;i&gt;P&lt;/i&gt;=.87).</p>\n</sec>',
      'RESULTS: Both groups increased their weekly MVPA minutes significantly at 12 weeks (P<.001) and maintained the increases at 24 weeks (P<.001), relative to baseline, with no between-group differences (P=.87).',
    ],
  ])(
    'reads the structured abstract of %s with its escaped italics removed',
    (_name, raw, expected) => {
      expect(normalizeAbstract(raw)).toBe(expected);
    },
  );

  /** Each class of the deposited table, reached through its escaped spelling. */
  it.each([
    // Block elements, and an unlisted name, always leave a boundary; so does a lone `br`.
    ['a&lt;p&gt;b&lt;/p&gt;c', 'a b c'],
    ['a.&lt;p&gt;b&lt;/p&gt;.c', 'a. b .c'],
    [
      '&lt;div class="htmlview paragraph"&gt;One.&lt;/div&gt;&lt;div&gt;Two.&lt;/div&gt;',
      'One. Two.',
    ],
    ['a&lt;section&gt;b&lt;/section&gt;c', 'a b c'],
    ['One.&lt;br&gt;Two.', 'One. Two.'],
    ['One.&lt;BR&gt;Two.', 'One. Two.'],
    ['One.&lt;br /&gt;Two.', 'One. Two.'],
    // Inline emphasis is a word boundary, not an unconditional space.
    ['A&lt;i&gt;B&lt;/i&gt;C', 'A B C'],
    ['&lt;i&gt;J. Am. Ceram. Soc.&lt;/i&gt;, 49', 'J. Am. Ceram. Soc., 49'],
    [
      'Sodium Bromide in &lt;i&gt;N&lt;/i&gt;,&lt;i&gt;N&lt;/i&gt;-Dimethylformamide',
      'Sodium Bromide in N,N-Dimethylformamide',
    ],
    ['&lt;span lang="EN-US"&gt;x&lt;/span&gt;&lt;sup&gt;e&lt;/sup&gt; siècles', 'xe siècles'],
    // A numeric superscript keeps its caret; other scripts join tight.
    ['CD4&lt;sup&gt;+&lt;/sup&gt; T cells', 'CD4^+ T cells'],
    ['10&lt;sup&gt;16&lt;/sup&gt; cm', '10^{16} cm'],
    ['H&lt;sub&gt;2&lt;/sub&gt;O', 'H2O'],
    ['T&lt;inf&gt;c&lt;/inf&gt;-SQUID', 'Tc-SQUID'],
    // A namespace prefix and attributes in either quote style, or unquoted, read as they would
    // deposited.
    ["&lt;jats:italic toggle='yes'&gt;in vivo&lt;/jats:italic&gt; work", 'in vivo work'],
    ['&lt;font size=2&gt;y&lt;/font&gt; z', 'y z'],
    // Quotes escaped with the brackets, as HTML escaped twice reads one level down.
    ['&lt;p style=&quot;text-align: justify;&quot;&gt;x&lt;/p&gt;', 'x'],
    [
      '&lt;span data-ccp-props=&quot;{&amp;quot;201341983&amp;quot;:2}&quot;&gt;y&lt;/span&gt; z',
      'y z',
    ],
  ])('reads %j as %j', (raw, expected) => {
    expect(jats(raw)).toEqual([expected, expected]);
  });

  /** The link rule, reached through an escaped `<a>`: decided per occurrence, as deposited. */
  it.each([
    [
      'see &lt;a href="https://osf.io/t5nes"&gt;https://osf.io/t5nes&lt;/a&gt;.',
      'see https://osf.io/t5nes.',
    ],
    ['See &lt;a href="http://www.fasebj.org"&gt;www.fasebj.org&lt;/a&gt;.', 'See www.fasebj.org.'],
    ['see &lt;a href="#s2"&gt;Methods&lt;/a&gt;', 'see Methods'],
    // The href addresses more than the text names, so the tags stay, closer and all.
    [
      'on &lt;a href="http://www.zoom.us/"&gt;Zoom&lt;/a&gt; and &lt;i&gt;x&lt;/i&gt;',
      'on <a href="http://www.zoom.us/">Zoom</a> and x',
    ],
    // A kept link's closer stays with it; an unpaired escaped closer of a link name comes out.
    [
      '&lt;/a&gt;&lt;a href="https://e.org/z"&gt;d&lt;/a&gt; then &lt;a href="#x"&gt;e&lt;/a&gt;',
      '<a href="https://e.org/z">d</a> then e',
    ],
    // Upper case is the same link, its closer found in either letter case.
    [
      'see &lt;A HREF="http://x.org/"&gt;site&lt;/A&gt; and &lt;i&gt;y&lt;/i&gt;',
      'see <A HREF="http://x.org/">site</A> and y',
    ],
    [
      'see &lt;A HREF="https://osf.io/t5nes"&gt;https://osf.io/t5nes&lt;/A&gt; and &lt;i&gt;y&lt;/i&gt;',
      'see https://osf.io/t5nes and y',
    ],
  ])('reads %j as %j', (raw, expected) => {
    expect(jats(raw)).toEqual([expected, expected]);
  });

  /**
   * Unpaired escaped markup comes out, and an escaped tag never pairs with a deposited one in
   * either direction: an escaped closer never closes a deposited element, and a deposited closer
   * never closes an escaped one.
   */
  it.each([
    ['<jats:p>x &lt;/p&gt;</jats:p>', 'x'],
    ['agents. &lt;/P&gt;&lt;P&gt; Methods: y', 'agents. Methods: y'],
    ['for &lt;/i&gt;in silico&lt;/i&gt; screening', 'for in silico screening'],
    ['<jats:italic>a&lt;/italic&gt;b</jats:italic>', 'a b'],
    ['&lt;i&gt;a</i>b&lt;/i&gt;', 'a</i>b'],
    ['&lt;p&gt;a</p>b&lt;/p&gt;', 'a</p>b'],
    // Nor on a superscript, where a pair would read as a numeric caret.
    ['<jats:p>x<sup>2&lt;/sup&gt; y</jats:p>', 'x2 y'],
    ['x&lt;sup&gt;2</sup> y', 'x<sup>2</sup> y'],
    // Escaped tags pair by name, past the first level, and an outer opener left open stays prose.
    ['&lt;b&gt;&lt;i&gt;&lt;sub&gt;x&lt;/sub&gt;&lt;/i&gt;&lt;/b&gt;', 'x'],
    ['&lt;i&gt;a&lt;b&gt;c&lt;/i&gt;d&lt;/b&gt;', 'a c d'],
    ['&lt;i&gt;a&lt;i&gt;b&lt;/i&gt;', '<i>a b'],
    // An opener after its own closer is markup only directly after it, whitespace aside.
    ['a&lt;/p&gt; \n\t &lt;p&gt;b', 'a b'],
    ['&lt;/p&gt;x&lt;p&gt;b', 'x<p>b'],
    ['&lt;/p&gt;<jats:p>&lt;p&gt;b</jats:p>', '<p>b'],
    ['&lt;/i&gt;&lt;b&gt;x', '<b>x'],
    // A deposited closer of its name is not its own closer.
    ['<jats:p>Use</jats:p>&lt;p&gt; b', 'Use <p> b'],
  ])('reads %j as %j', (raw, expected) => {
    expect(jats(raw)).toEqual([expected, expected]);
  });

  /**
   * In a field holding escaped markup, a reference escaped with it loses that one extra level:
   * the HTML it escaped wrote `&nbsp;` and `&lt;`. A reference the decode resolves reads as its
   * character at any depth anyway; the level is what a name the table lacks, or a numeric
   * reference naming no scalar, loses beside markup and nowhere else. The lowered reference is
   * never read as a tag.
   */
  it.each([
    ['&lt;p&gt;have.&amp;nbsp;&lt;/p&gt;', 'have.'],
    ['&lt;b&gt;R&amp;amp;D&lt;/b&gt; costs', 'R&D costs'],
    ['&lt;br&gt;x &amp;amp;lt; y', 'x < y'],
    ['&lt;br&gt;x &amp;Eng; y', 'x &Eng; y'],
    ['&lt;br&gt;x &amp;amp;Eng; y', 'x &Eng; y'],
    ['&lt;br&gt;a&amp;amp;#0;b', 'a&#0;b'],
    ['&lt;br&gt;R&amp;D', 'R&D'],
    ['&lt;br&gt;Deposited as &amp;lt;i&amp;gt;x&amp;lt;/i&amp;gt;', 'Deposited as <i>x</i>'],
    [
      '<jats:p>We analyze &lt;bigwig&gt; programs&lt;br /&gt;and &lt;i&gt;P&lt;/i&gt;&amp;lt;.001.</jats:p>',
      'We analyze <bigwig> programs and P<.001.',
    ],
  ])('lowers a reference escaped with markup: %j as %j', (raw, expected) => {
    expect(jats(raw)).toEqual([expected, expected]);
  });

  /**
   * An escaped run sits inside one text span: an attribute of a deposited tag is not text, and a
   * run with a deposited tag inside it is not one tag.
   */
  it.each([
    ['<p title="&lt;i&gt;x&lt;/i&gt;">y</p>', 'y'],
    [
      '<a href="https://e.org/z" title="&lt;/b&gt;">d</a> &lt;/b&gt;',
      '<a href="https://e.org/z" title="</b>">d</a>',
    ],
    ['&lt;span <b>x</b>&gt;y&lt;/span&gt;', '<span x>y'],
    ['&lt;span title="a<jats:i>b</jats:i>c"&gt;y&lt;/span&gt;', '<span title="a b c">y'],
    ["&lt;span title='a<jats:i>b</jats:i>c'&gt;y&lt;/span&gt;", "<span title='a b c'>y"],
  ])('reads %j as %j', (raw, expected) => {
    expect(jats(raw)).toEqual([expected, expected]);
  });

  /**
   * A structured abstract's headings and items are read from its deposited structure, with the
   * escaped markup inside them removed, and the outline's offsets stay true across the runs the
   * escaped pass removes. Escaped structure — an escaped `<title>` — is a block boundary like
   * any other escaped element, not a heading.
   */
  it.each([
    [
      '<sec><title>Background</title><p>&lt;p&gt;Body&amp;nbsp;&lt;/p&gt;</p></sec><sec><title>Methods</title><p>&lt;i&gt;In vivo&lt;/i&gt; work.</p></sec>',
      'Background: Body Methods: In vivo work.',
    ],
    ['<title>Use of &lt;i&gt;</title><p>&lt;b&gt;x&lt;/b&gt;</p>', 'Use of <i>: x'],
    ['<list><list-item>&lt;i&gt;a&lt;/i&gt;</list-item><list-item>b</list-item></list>', 'a; b'],
    ['<p>&lt;title&gt;Background&lt;/title&gt;Body.</p>', 'Background Body.'],
  ])('reads %j as %j', (raw, expected) => {
    expect(normalizeAbstract(raw)).toBe(expected);
  });

  /**
   * Every escaped tag is decided in one pass over the field and removed in another, so the cost
   * stays linear in the field however its escaped tags pair: openers no closer reaches, closers
   * no opener reaches, siblings each closing the last, links, superscripts, and references.
   */
  describe('on adversarial escaped input', () => {
    const shapes: Array<[string, (size: number) => string]> = [
      ['unclosed escaped openers', (size) => repeatTo('&lt;i&gt;a', size)],
      [
        'unclosed escaped openers in a field holding markup',
        (size) => `&lt;br&gt;${repeatTo('&lt;i&gt;a', size - 10)}`,
      ],
      ['unpaired escaped closers', (size) => repeatWhole('&lt;/i&gt;', size)],
      ['alternating escaped siblings', (size) => repeatWhole('&lt;/p&gt;&lt;p&gt;', size)],
      [
        'nested escaped elements',
        (size) => nestTo('&lt;i&gt;&lt;b&gt;', 'x', '&lt;/b&gt;&lt;/i&gt;', size),
      ],
      ['nested escaped superscripts', (size) => nestTo('&lt;sup&gt;', '2', '&lt;/sup&gt;', size)],
      [
        'closed escaped links',
        (size) => repeatWhole('&lt;a href="https://example.org/a"&gt;text&lt;/a&gt;', size),
      ],
      [
        'escaped link siblings',
        (size) => repeatWhole('&lt;/a&gt;&lt;a href="https://example.org/a"&gt;', size),
      ],
      /**
       * Each attribute is long enough that the largest input holds fewer than about 8,000 of
       * them. Past about 10,000, JavaScriptCore's regex engine switches to a slower mode for the
       * repeated escaped-attribute group when it reads captures. The work stays linear on both
       * sides of the switch, but measured across it the step reads as growth.
       */
      [
        'an unterminated escaped attribute run',
        (size) => `&lt;br&gt;&lt;p class="a" ${repeatWhole(`x = "${'y'.repeat(33)}" `, size - 26)}`,
      ],
      ['escaped attribute openers that never terminate', (size) => repeatTo('&lt;i x=1', size)],
      [
        'escaped references in a field holding markup',
        (size) => `&lt;br&gt;${repeatWhole('&amp;nbsp;', size - 10)}`,
      ],
      [
        'one long line ending in a break',
        (size) => `&lt;i&gt;${repeatTo('§1 x', size - 21)}\ny&lt;/i&gt;`,
      ],
      ['breaks throughout', (size) => `&lt;br&gt;${repeatTo('  \r\n', size - 10)}`],
      ['escaped siblings across breaks', (size) => repeatWhole('&lt;/p&gt;  \r\n&lt;p&gt;', size)],
      ['escaped openers with breaks in the tail', (size) => repeatTo('&lt;p  \r\n', size)],
    ];

    it.each(shapes)(
      'stays linear on %s',
      (_name, make) => {
        expectLinearScaling(make, (raw) => {
          normalizeMarkupText(raw);
          normalizeAbstract(raw);
        });
      },
      0,
    );
  });
});

/**
 * HTML a deposit escaped into its JATS text and then escaped again — `&amp;lt;p&amp;gt;…`. A field
 * holding no escaped markup as deposited is read once more with each `&amp;` that heads a
 * reference written `&`, and where that reading finds escaped markup the field reads exactly as
 * it would escaped once, by the rule above. A field holding escaped markup as deposited keeps
 * that reading, and a doubly escaped tag beside it is the HTML's own text. JATS surface only.
 */
describe('markup escaped twice on the JATS surface', () => {
  /** The deposits behind #118, as Crossref returns them, trimmed to the sentences at issue. */
  it.each([
    [
      '10.5194/egusphere-egu22-2991 abstract',
      '<jats:p>&amp;lt;p&amp;gt;&amp;lt;span&amp;gt;In recent decades, West Africa has experienced some of the most extreme rainfall variability anywhere in the world. Climate projections for the 21&amp;lt;/span&amp;gt;&amp;lt;sup&amp;gt;&amp;lt;span&amp;gt;st&amp;lt;/span&amp;gt;&amp;lt;/sup&amp;gt;&amp;lt;span&amp;gt; century tend to show that the future could be even worse.&amp;lt;/span&amp;gt;&amp;lt;/p&amp;gt;</jats:p>',
      'In recent decades, West Africa has experienced some of the most extreme rainfall variability anywhere in the world. Climate projections for the 21st century tend to show that the future could be even worse.',
    ],
    [
      '10.65641/afmnai-2026-114 abstract',
      '<jats:p>&amp;lt;p style=&amp;quot;text-align: justify;&amp;quot;&amp;gt;&amp;lt;span class=&amp;quot;a_GcMg font-feature-liga-off&amp;quot;&amp;gt;Dysautonomia, reflecting autonomic nervous system dysfunction, is frequently observed in patients with syncope. &amp;lt;/span&amp;gt;&amp;lt;em&amp;gt;&amp;lt;span class=&amp;quot;a_GcMg&amp;quot;&amp;gt;Thymus serpyllum &amp;lt;/span&amp;gt;&amp;lt;/em&amp;gt;&amp;lt;span class=&amp;quot;a_GcMg&amp;quot;&amp;gt;L. (wild thyme) has demonstrated antioxidant activity.&amp;lt;/span&amp;gt;&amp;lt;/p&amp;gt;</jats:p>',
      'Dysautonomia, reflecting autonomic nervous system dysfunction, is frequently observed in patients with syncope. Thymus serpyllum L. (wild thyme) has demonstrated antioxidant activity.',
    ],
    [
      '10.5114/pjr.2019.84829 title',
      'Endovascular treatment of small (&amp;lt; 5 mm) unruptured middle cerebral artery aneurysms',
      'Endovascular treatment of small (< 5 mm) unruptured middle cerebral artery aneurysms',
    ],
    [
      '10.1158/1538-7445.am2014-2360 abstract',
      '<jats:p>(fold-change ≥ 1.2 and false discovery rate &amp;lt; 10%) comparing all</jats:p>',
      '(fold-change ≥ 1.2 and false discovery rate < 10%) comparing all',
    ],
  ])('reads %s as the text it marks up', (_name, raw, expected) => {
    expect(jats(raw)).toEqual([expected, expected]);
  });

  /** Each class, the link rule, and the pairing rule, reached through the double escape. */
  it.each([
    [
      '<jats:p>We used &amp;lt;i&amp;gt;P&amp;lt;/i&amp;gt; &amp;lt; 0.05</jats:p>',
      'We used P < 0.05',
    ],
    ['&amp;lt;p style=&amp;quot;a&amp;quot;&amp;gt;x&amp;lt;/p&amp;gt;', 'x'],
    ['&amp;lt;p&amp;gt;have.&amp;amp;nbsp;&amp;lt;/p&amp;gt;', 'have.'],
    ['&amp;lt;p&amp;gt;x &amp;amp;Eng; y&amp;lt;/p&amp;gt;', 'x &Eng; y'],
    ['One.&amp;lt;br&amp;gt;Two.', 'One. Two.'],
    ['A&amp;lt;i&amp;gt;B&amp;lt;/i&amp;gt;C', 'A B C'],
    ['CD4&amp;lt;sup&amp;gt;+&amp;lt;/sup&amp;gt; T cells', 'CD4^+ T cells'],
    ['H&amp;lt;sub&amp;gt;2&amp;lt;/sub&amp;gt;O', 'H2O'],
    [
      'see &amp;lt;a href=&amp;quot;https://osf.io/t5nes&amp;quot;&amp;gt;https://osf.io/t5nes&amp;lt;/a&amp;gt;.',
      'see https://osf.io/t5nes.',
    ],
    [
      'on &amp;lt;a href=&amp;quot;http://www.zoom.us/&amp;quot;&amp;gt;Zoom&amp;lt;/a&amp;gt; and &amp;lt;i&amp;gt;x&amp;lt;/i&amp;gt;',
      'on <a href="http://www.zoom.us/">Zoom</a> and x',
    ],
    ['agents. &amp;lt;/P&amp;gt;&amp;lt;P&amp;gt; Methods: y', 'agents. Methods: y'],
    ['&amp;lt;i&amp;gt;a</i>b&amp;lt;/i&amp;gt;', 'a</i>b'],
    ['&amp;lt;i&amp;gt;a&amp;lt;i&amp;gt;b&amp;lt;/i&amp;gt;', '<i>a b'],
  ])('reads %j as %j', (raw, expected) => {
    expect(jats(raw)).toEqual([expected, expected]);
  });

  /**
   * A field holding escaped markup as deposited keeps that reading: a tag escaped twice beside it
   * is the HTML's own text, and stays as the text it names.
   */
  it.each([
    ['&lt;br&gt;Deposited as &amp;lt;i&amp;gt;x&amp;lt;/i&amp;gt;', 'Deposited as <i>x</i>'],
    ['&lt;b&gt;x&lt;/b&gt; and &amp;lt;i&amp;gt;y&amp;lt;/i&amp;gt;', 'x and <i>y</i>'],
  ])('keeps the reading of a field holding escaped markup: %j as %j', (raw, expected) => {
    expect(jats(raw)).toEqual([expected, expected]);
  });

  /**
   * Prose naming an element stays, as it does escaped once. Prose that names both an element's
   * start tag and its end tag reads as the pair it writes, escaped once or twice — the accepted
   * residual of the escaped-tag rule, whose premise is that prose about an element does not
   * write its end tag.
   */
  it.each([
    ['e.g. when &amp;lt;choice&amp;gt; appears', 'e.g. when <choice> appears'],
    ['&lt;p&gt;wafers of 1μs &amp;lt;τ&amp;lt;1.2μs', '<p>wafers of 1μs <τ<1.2μs'],
    ['the &amp;lt;head&amp;gt; and &amp;lt;/head&amp;gt; tags', 'the and tags'],
    ['the &lt;head&gt; and &lt;/head&gt; tags', 'the and tags'],
  ])('reads %j as %j', (raw, expected) => {
    expect(jats(raw)).toEqual([expected, expected]);
  });

  /** Headings and items come from deposited tags only, as they do beside markup escaped once. */
  it.each([
    [
      '<sec><title>Background</title><p>&amp;lt;p&amp;gt;Body&amp;amp;nbsp;&amp;lt;/p&amp;gt;</p></sec><sec><title>Methods</title><p>&amp;lt;i&amp;gt;In vivo&amp;lt;/i&amp;gt; work.</p></sec>',
      'Background: Body Methods: In vivo work.',
    ],
    ['<p>&amp;lt;title&amp;gt;Background&amp;lt;/title&amp;gt;Body.</p>', 'Background Body.'],
  ])('reads %j as %j', (raw, expected) => {
    expect(normalizeAbstract(raw)).toBe(expected);
  });

  /**
   * A field with no escaped markup as deposited reads exactly as the same field with every
   * `&amp;` that heads a reference written `&` — a field escaped one level too deep reads as the
   * field escaped correctly. The one reference outside it is a name the table lacks escaped
   * three deep, which the decode takes one level off either way (`html-entities.test.ts`).
   */
  it('reads a field with no escaped markup as the same field escaped one level less', () => {
    const lowerOneLevel = (raw: string) =>
      raw.replace(/&amp;(?=(?:#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);)/g, '&');
    const fields = [
      '<jats:p>&amp;lt;p&amp;gt;&amp;lt;span&amp;gt;West Africa, 21&amp;lt;/span&amp;gt;&amp;lt;sup&amp;gt;st&amp;lt;/sup&amp;gt; century&amp;lt;/p&amp;gt;</jats:p>',
      '&amp;lt;p style=&amp;quot;text-align: justify;&amp;quot;&amp;gt;x&amp;amp;nbsp;y&amp;lt;/p&amp;gt;',
      '<title>Results</title><p>&amp;lt;i&amp;gt;P&amp;lt;/i&amp;gt; &amp;lt; .05</p>',
      'false discovery rate &amp;lt; 10%, CEC&amp;amp;rsquo;17, Kontakte &amp;ndash; Konflikte',
      'Deposited as &amp;lt;i&amp;gt;, the &amp;lt;head&amp;gt; and &amp;lt;/head&amp;gt; tags',
      'R&amp;amp;D, AT&amp;T, &amp;Eng;, a&amp;#0;b, Tecnolog&amp;#x00ED;a',
      '<jats:p>&lt;p&gt;wafers of 1μs &amp;lt;τ&amp;lt;1.2μs</jats:p>',
      'see &amp;lt;a href=&amp;quot;https://osf.io/t5nes&amp;quot;&amp;gt;https://osf.io/t5nes&amp;lt;/a&amp;gt;.',
      '<ext-link xlink:href="https://e.org/?a=1&amp;amp;b=2">https://e.org/?a=1&amp;amp;b=2</ext-link>',
      'x<sup>&amp;#50;</sup> and <i>In vivo</i>&amp;nbsp;work',
    ];
    for (const raw of fields) {
      expect(normalizeMarkupText(raw), raw).toBe(normalizeMarkupText(lowerOneLevel(raw)));
      expect(normalizeAbstract(raw), raw).toBe(normalizeAbstract(lowerOneLevel(raw)));
    }
  });

  /**
   * The second reading is one more decision scan and one more strip, so the cost stays linear in
   * the field however its doubly escaped tags pair, and a `&quot;`-quoted attribute value has one
   * parse however many pairs an unterminated tag holds.
   */
  describe('on adversarial input escaped twice', () => {
    const shapes: Array<[string, (size: number) => string]> = [
      ['unclosed openers escaped twice', (size) => repeatTo('&amp;lt;p&amp;gt;a', size)],
      [
        'alternating siblings escaped twice',
        (size) => repeatWhole('&amp;lt;/p&amp;gt;&amp;lt;p&amp;gt;', size),
      ],
      [
        'openers whose quoted value never closes',
        (size) => repeatTo('&amp;lt;p x=&amp;quot;y ', size),
      ],
      [
        'one opener with an unterminated run of quoted values',
        (size) => `&amp;lt;p ${repeatWhole('x=&amp;quot;y ', size - 10)}`,
      ],
      /** Sized as `an unterminated escaped attribute run` is, and for the same reason. */
      [
        'an unterminated run of quoted attributes beside markup',
        (size) =>
          `&lt;br&gt;&lt;p class=&quot;a&quot; ${repeatWhole(`x = &quot;${'y'.repeat(29)}&quot; `, size - 36)}`,
      ],
      [
        'references escaped three deep beside markup escaped twice',
        (size) => `&amp;lt;br&amp;gt;${repeatWhole('&amp;amp;nbsp;', size - 18)}`,
      ],
      [
        'one long line ending in a break',
        (size) => `&amp;lt;i&amp;gt;${repeatTo('§1 x', size - 37)}\ny&amp;lt;/i&amp;gt;`,
      ],
      ['breaks throughout', (size) => `&amp;lt;br&amp;gt;${repeatTo('  \r\n', size - 18)}`],
    ];

    it.each(shapes)(
      'stays linear on %s',
      (_name, make) => {
        expectLinearScaling(make, (raw) => {
          normalizeMarkupText(raw);
          normalizeAbstract(raw);
        });
      },
      0,
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
      0,
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
  }, 0);
});

/**
 * The two markup passes run one implementation over one rule and differ in two things: what an
 * unrecognized element name means, and whether an escaped tag can be markup. Everything else —
 * the shape test, the regions, the three separator classes, the link exception — is shared, and
 * this file is what keeps it that way. Each surface drifting from the other has been the defect four times running; a case that
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
      ['Deposited as &amp;lt;i&amp;gt;', 'Deposited as <i>'],
      ['Interleukin-1-&beta; and M&uuml;ller', 'Interleukin-1-β and Müller'],
      // A reference escaped twice reads as its character on both surfaces.
      [
        'CEC&amp;amp;rsquo;17, 018&amp;lt;1126:CSOEAP&amp;gt;2.3.CO;2',
        'CEC’17, 018<1126:CSOEAP>2.3.CO;2',
      ],
    ];
    for (const [raw, expected] of agreeing) {
      expect(normalizeMarkupText(raw), `JATS pass on ${raw}`).toBe(expected);
      expect(normalizeReferenceText(raw), `reference pass on ${raw}`).toBe(expected);
    }
  });

  /**
   * The first of the two justified differences. A title or abstract is deposited as JATS, so a
   * raw `<` in it came out of an XML document: an unrecognized name is structure and is removed
   * as a block boundary, which is the only reason `<sec>` and `<list-item>` do not reach a reader.
   * A reference entry is a citation string a publisher typed, where the same syntax carries
   * content, so an unrecognized name stays.
   */
  it('differs on an element name neither surface classifies', () => {
    const differing: Array<[string, string, string]> = [
      [
        '<sec><title>Background</title><p>Body.</p></sec>',
        'Background Body.',
        '<sec><title>Background</title> Body. </sec>',
      ],
      ['a<subject>b</subject>c', 'a b c', 'a<subject>b</subject>c'],
      ['<list><list-item>One</list-item></list>', 'One', '<list><list-item>One</list-item></list>'],
      // The abstract's item delimiter and empty-section rule are the abstract's alone.
      [
        '<list><list-item>a</list-item><list-item>b</list-item></list>',
        'a b',
        '<list><list-item>a</list-item><list-item>b</list-item></list>',
      ],
      [
        '<p>x</p><sec><title>Graphical Abstract</title></sec>',
        'x Graphical Abstract',
        'x <sec><title>Graphical Abstract</title></sec>',
      ],
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
   * The second, and the last. A JATS field is XML, so markup a deposit escaped into its text is
   * HTML the publisher meant as markup and comes out, escaped once or twice; a reference entry
   * is typed text, where an escaped tag is the publisher's characters and stays.
   */
  it('differs on escaped markup, which only a JATS field reads as markup', () => {
    const differing: Array<[string, string, string]> = [
      ['&lt;p&gt;x&amp;nbsp;&lt;/p&gt;', 'x', '<p>x </p>'],
      ['&amp;lt;p&amp;gt;x&amp;lt;/p&amp;gt;', 'x', '<p>x</p>'],
      ['CD4&lt;sup&gt;+&lt;/sup&gt; cells', 'CD4^+ cells', 'CD4<sup>+</sup> cells'],
      ['<jats:p>x &lt;/p&gt;</jats:p>', 'x', 'x </p>'],
      [
        'for &lt;/i&gt;in silico&lt;/i&gt; screening',
        'for in silico screening',
        'for </i>in silico</i> screening',
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
   * A citation string is typed text, so an escaped tag in one is the publisher's characters
   * even where it pairs, escaped once or twice. Markup comes out before entities are decoded,
   * so none decodes into a tag the strip pass then eats; a reference escaped twice beside one
   * reads as its character, as it does anywhere.
   */
  it('keeps an escaped tag as literal text', () => {
    expect(normalizeReferenceText('Deposited entity &lt;i&gt;stays literal&lt;/i&gt;')).toBe(
      'Deposited entity <i>stays literal</i>',
    );
    expect(normalizeReferenceText('Double-escaped &amp;lt;i&amp;gt; stays text')).toBe(
      'Double-escaped <i> stays text',
    );
    expect(normalizeReferenceText('3 Suppl:&lt;i&gt;e1&lt;/i&gt;&amp;nbsp;x')).toBe(
      '3 Suppl:<i>e1</i> x',
    );
    // The deposit behind #118 on this surface: 10.5194/ejm-35-25-2023, `ref13` and `ref58`.
    expect(
      normalizeReferenceText(
        'older (&amp;gt; 40 ka) ignimbrites, https://doi.org/10.1130/0091-7613(1990)018&amp;lt;1126:CSOEAP&amp;gt;2.3.CO;2, 1990.',
      ),
    ).toBe(
      'older (> 40 ka) ignimbrites, https://doi.org/10.1130/0091-7613(1990)018<1126:CSOEAP>2.3.CO;2, 1990.',
    );
    // Inside a citation envelope too, where the deposited tags around it all come out.
    expect(
      normalizeReferenceText(
        '<mixed-citation>Smith, &lt;i&gt;Title&lt;/i&gt; 2001</mixed-citation>',
      ),
    ).toBe('Smith, <i>Title</i> 2001');
    expect(
      normalizeReferenceText(
        '<mixed-citation publication-type="journal"><person-group><name><surname>Smith</surname></name></person-group>, <article-title>&lt;i&gt;Title&lt;/i&gt;</article-title> <year>2001</year></mixed-citation>',
      ),
    ).toBe('Smith, <i>Title</i> 2001');
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
