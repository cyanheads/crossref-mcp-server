/**
 * @fileoverview Tests for `mdText`, the escape every deposited value passes through on its way
 * into the Markdown `format()` builds.
 * @module tests/tools/markdown-text.test
 */

import { describe, expect, it } from 'vitest';
import { mdText, mdTextAtLineStart } from '@/mcp-server/tools/markdown-text.js';

describe('mdText', () => {
  /**
   * The brackets normalization keeps on purpose are exactly the ones a renderer would consume
   * next: an element name it does not know is rendered as its children alone, so the address,
   * the accession, or the phrase inside the tag is what the reader loses.
   */
  it('escapes a bracket only in the shapes a renderer reads as markup', () => {
    expect(
      mdText('<jats:ext-link xlink:href="https://x.org/a">https://x.org/</jats:ext-link>'),
    ).toBe('\\<jats:ext-link xlink:href="https://x.org/a">https://x.org/\\</jats:ext-link>');
    expect(mdText('International <IR> Framework')).toBe('International \\<IR> Framework');
    expect(mdText('Zement-Kalk-Gips. <Go to ISI>://WOS:A1991')).toBe(
      'Zement-Kalk-Gips. \\<Go to ISI>://WOS:A1991',
    );
    expect(mdText('deposited as <p> by the publisher')).toBe('deposited as \\<p> by the publisher');
  });

  /**
   * A bracketed URL is the case the whole rule was written around, and it is escaped for the
   * same reason a tag is: a renderer reads it as an autolink and keeps the address while eating
   * the two brackets the publisher typed around it. The reader is meant to see what was
   * deposited, which here includes the brackets.
   */
  it('escapes a bracketed URL, which a renderer reads as an autolink', () => {
    expect(mdText('FAOSTAT. <http://faostat.fao.org/site/291/default.aspx>.')).toBe(
      'FAOSTAT. \\<http://faostat.fao.org/site/291/default.aspx>.',
    );
    expect(mdText('online at <www.voith.com>')).toBe('online at \\<www.voith.com>');
  });

  /**
   * A bracket the strip kept because it is not tag-shaped is not tag-shaped to a renderer
   * either — those survivors reach `content[]` byte-exact, with nothing added.
   */
  it('leaves a bracket no renderer would read as markup', () => {
    for (const survivor of [
      'Silicon <100> nanowires',
      '10.1002/(SICI)1097-461X(1998)66:2<131::AID-QUA4>3.0.CO;2-W',
      'ZnxFe3-xO4 (0.01 < x > 0.8) nanoparticles',
      'binding affinity was < 10 nM',
    ]) {
      expect(mdText(survivor)).toBe(survivor);
    }
  });

  /**
   * The escape mirrors the decode. The one string that reaches this point still spelled as a
   * character reference is the one a publisher escaped twice, and it has to stay text on both
   * surfaces; a bare ampersand somebody typed is left bare, which is the common case by two
   * orders of magnitude.
   */
  it('escapes an ampersand only where it heads a character reference', () => {
    expect(mdText('Double-escaped &lt;i&gt; stays escaped')).toBe(
      'Double-escaped \\&lt;i\\&gt; stays escaped',
    );
    expect(mdText('a&#10;b and a&#x41;b')).toBe('a\\&#10;b and a\\&#x41;b');
    expect(mdText('Taylor & Francis, R&D, ?a=1&lang=en')).toBe(
      'Taylor & Francis, R&D, ?a=1&lang=en',
    );
    expect(mdText('Nuc. Sci. &Eng 2013')).toBe('Nuc. Sci. &Eng 2013');
  });

  /** Emphasis, code, and strikethrough markers are consumed wherever they pair. */
  it('escapes the emphasis, code, and strikethrough markers', () => {
    expect(mdText('A*STAR, Singapore')).toBe('A\\*STAR, Singapore');
    expect(mdText('Protocols `awk` and ~~struck~~')).toBe(
      'Protocols \\`awk\\` and \\~\\~struck\\~\\~',
    );
    expect(mdText('*Journal of Physics*')).toBe('\\*Journal of Physics\\*');
  });

  /**
   * An underscore is left alone. This server writes none of its own, so a deposited one can
   * only pair with another deposited one, and what a pair costs is the two markers rather than
   * the text between them — against a backslash in every identifier, URL, and TeX subscript
   * that carries one.
   */
  it('leaves an underscore alone', () => {
    expect(mdText('the TP53_HUMAN entry')).toBe('the TP53_HUMAN entry');
    expect(mdText('a _title_ and $$k_{\\bot }$$')).toBe('a _title_ and $$k_{\\bot }$$');
  });

  /**
   * A `[` is a citation marker or a bracketed formula far more often than a link opener, so the
   * escape lands on the `]` that would complete the pair instead.
   */
  it('escapes a bracket pair only where a link would form', () => {
    expect(mdText('uptake of [18F]FDG in [Ca2+] buffer [1,2]')).toBe(
      'uptake of [18F]FDG in [Ca2+] buffer [1,2]',
    );
    expect(mdText('see [the report](http://evil.example/x)')).toBe(
      'see [the report\\](http://evil.example/x)',
    );
    expect(mdText('see [the report][ref]')).toBe('see [the report\\][ref]');
  });

  /**
   * A backslash is consumed only in front of the punctuation it can escape, so a TeX control
   * word survives untouched while a TeX escape keeps the backslash the deposit carried.
   */
  it('escapes a backslash only where a reader would let it escape something', () => {
    expect(mdText('$$k_{\\bot }$$ and \\hbox')).toBe('$$k_{\\bot }$$ and \\hbox');
    expect(mdText('50\\% of \\$5')).toBe('50\\\\% of \\\\$5');
  });

  /**
   * The escape only ever inserts a backslash. Nothing a deposit carried is removed, reordered,
   * or replaced — which is the whole point of doing this at the render boundary rather than in
   * the value.
   */
  it('never costs the deposit a character', () => {
    for (const value of [
      '<jats:ext-link xlink:href="NCT06494904">NCT06494904</jats:ext-link>',
      'Silicon <100> nanowires & <IR> and ~1.5 μs',
      'Deposited as &amp;lt;i&amp;gt; with *stars* and `ticks`',
      'A*STAR [18F]FDG TP53_HUMAN $$k_{\\bot }$$ 50\\%',
    ]) {
      expect(mdText(value).replaceAll('\\', '')).toBe(value.replaceAll('\\', ''));
      expect(mdText(value).length).toBeGreaterThanOrEqual(value.length);
    }
  });

  it('leaves a value carrying nothing active byte-exact', () => {
    const plain = 'Intruder negative-parity states of neutron-rich Si33';
    expect(mdText(plain)).toBe(plain);
  });

  /**
   * A block marker is inert anywhere but column zero, and nearly every value this server renders
   * sits behind a heading, a bullet, or a bold label. Escaping one here would be a backslash in
   * front of the leading hyphen of every title that starts with one.
   */
  it('leaves a block marker alone, because a value it escapes is rendered mid-line', () => {
    for (const value of [
      '- Abstract: Lung cancer is a major health problem',
      '19. yüzyılın ikinci yarısından itibaren',
      '# 1 in a series of case reports',
      '> 90% of samples',
    ]) {
      expect(mdText(value)).toBe(value);
    }
  });

  /**
   * Every alternative is a single character and every quantifier inside a lookahead is bounded,
   * so an entity-dense or bracket-dense deposit costs a fixed amount of work per character. Two
   * performance defects of exactly this shape have shipped in this module before.
   */
  it('stays linear on adversarial input', () => {
    const adversarial = [
      `&${'a'.repeat(100_000)}`,
      '&'.repeat(50_000) + 'a'.repeat(50_000),
      `<${'a'.repeat(100_000)}`,
      '\\'.repeat(100_000),
      ']'.repeat(100_000),
    ];
    for (const value of adversarial) {
      const started = performance.now();
      mdText(value);
      expect(performance.now() - started, value.slice(0, 12)).toBeLessThan(500);
    }
  });
});

/**
 * The same escape for a value that *begins* a line, where a marker is not presented differently
 * but consumed: the reader loses the `19.` that names a century and the `- ` a publisher typed.
 */
describe('mdTextAtLineStart', () => {
  it('escapes the marker a block construct opens on', () => {
    expect(mdTextAtLineStart('- Abstract: Lung cancer is a major health problem')).toBe(
      '\\- Abstract: Lung cancer is a major health problem',
    );
    expect(mdTextAtLineStart('19. yüzyılın ikinci yarısından')).toBe(
      '19\\. yüzyılın ikinci yarısından',
    );
    expect(mdTextAtLineStart('1) Introduction. A Markov Renewal Process')).toBe(
      '1\\) Introduction. A Markov Renewal Process',
    );
    expect(mdTextAtLineStart('# 1 in a series')).toBe('\\# 1 in a series');
    expect(mdTextAtLineStart('> 90% of samples')).toBe('\\> 90% of samples');
    expect(mdTextAtLineStart('+ supplementary data')).toBe('\\+ supplementary data');
  });

  /**
   * A line of nothing but `-` or `=` is a thematic break or a setext underline: the line is
   * consumed whole, and a setext underline turns the `**Abstract:**` label above it into a
   * heading. Escaping one of the marks is what leaves both lines as they were deposited.
   */
  it('escapes a value that is nothing but break marks', () => {
    expect(mdTextAtLineStart('-')).toBe('\\-');
    expect(mdTextAtLineStart('---')).toBe('--\\-');
    expect(mdTextAtLineStart('===')).toBe('==\\=');
  });

  /**
   * The digits are what the reader came for, so the escape lands on the delimiter. A backslash
   * in front of a digit is not an escape a renderer resolves — it would show as `\19.`.
   */
  it('escapes the delimiter of an ordered-list marker, never the number', () => {
    expect(mdTextAtLineStart('100. rocznica plebiscytu')).toBe('100\\. rocznica plebiscytu');
    expect(mdTextAtLineStart('1. Cerebral RNA of adult rats')).toBe(
      '1\\. Cerebral RNA of adult rats',
    );
  });

  /**
   * Only where a block construct actually opens. A marker further along the line is inert, and
   * so is a leading character that no space follows — which is the far commoner value and the
   * reason the escape tests the construct rather than the character.
   */
  it('escapes nothing where no block construct can open', () => {
    for (const value of [
      'Intruder negative-parity states of neutron-rich Si33',
      'Results. - No significant difference was found',
      '2.25Cr1Mo0.25V steel has better high temperature strength',
      '1.8-MeV proton irradiation to a fluence of 1014/cm2',
      '-- no abstract provided by author --',
      '#1 ranked framework',
    ]) {
      expect(mdTextAtLineStart(value)).toBe(value);
    }
  });

  /**
   * The inline pass runs first, so a leading character it already escaped is behind a backslash
   * and no longer opens anything, and the two passes never escape each other's output.
   */
  it('composes with the inline escape rather than doubling it', () => {
    expect(mdTextAtLineStart('*Not* an emphasis the server wrote')).toBe(
      '\\*Not\\* an emphasis the server wrote',
    );
    expect(mdTextAtLineStart('<p> deposited by the publisher')).toBe(
      '\\<p> deposited by the publisher',
    );
    expect(mdTextAtLineStart('- see [the report](http://x.example/a)')).toBe(
      '\\- see [the report\\](http://x.example/a)',
    );
  });

  /** The escape only ever inserts a backslash — no deposit loses a character to it. */
  it('never costs the deposit a character', () => {
    for (const value of [
      '- Abstract: Lung cancer',
      '19. yüzyılın *ikinci* yarısından &lt; sonra',
      '#1 ranked <IR> framework',
    ]) {
      expect(mdTextAtLineStart(value).replaceAll('\\', '')).toBe(value.replaceAll('\\', ''));
    }
  });

  /** Anchored and bounded: the marker match costs the same whatever follows it. */
  it('stays linear on adversarial input', () => {
    for (const value of ['9'.repeat(100_000), '-'.repeat(100_000), `#${'>'.repeat(100_000)}`]) {
      const started = performance.now();
      mdTextAtLineStart(value);
      expect(performance.now() - started, value.slice(0, 12)).toBeLessThan(500);
    }
  });
});
