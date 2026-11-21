/**
 * @fileoverview Character-reference decoding for deposited Crossref text.
 * @module tests/services/crossref/html-entities.test
 */

import { describe, expect, it } from 'vitest';
import { decodeHtmlEntities, lowerEscapedReferences } from '@/services/crossref/html-entities.js';
import { expectLinearScaling, repeatTo, repeatWhole } from '../../helpers/scaling.js';

describe('decodeHtmlEntities', () => {
  it('decodes &amp;, &lt;, &gt;, &quot;, &apos;', () => {
    expect(decodeHtmlEntities('a &amp; b')).toBe('a & b');
    expect(decodeHtmlEntities('&lt;tag&gt;')).toBe('<tag>');
    expect(decodeHtmlEntities('say &quot;hello&quot;')).toBe('say "hello"');
    expect(decodeHtmlEntities('it&apos;s')).toBe("it's");
  });

  it('decodes decimal numeric entities', () => {
    expect(decodeHtmlEntities('&#65;')).toBe('A');
    expect(decodeHtmlEntities('&#169;')).toBe('©');
  });

  it('decodes hex numeric entities', () => {
    expect(decodeHtmlEntities('&#x41;')).toBe('A');
    expect(decodeHtmlEntities('&#xA9;')).toBe('©');
  });

  /**
   * The names a scientific citation actually carries: Greek letters, accented Latin,
   * guillemets, dashes, typographic quotes. None is XML-reserved, so none was reachable
   * through the five-name table the decode started with.
   */
  it('decodes the named references deposits carry beyond the five XML names', () => {
    expect(decodeHtmlEntities('&laquo;Understanding Gas Condensate&raquo;')).toBe(
      '«Understanding Gas Condensate»',
    );
    expect(decodeHtmlEntities('Interleukin-1-&beta; (IL-1&beta;)')).toBe('Interleukin-1-β (IL-1β)');
    expect(decodeHtmlEntities('M&uuml;ller KH, S&aacute;rk&ouml;zy A')).toBe(
      'Müller KH, Sárközy A',
    );
    expect(decodeHtmlEntities('8, 21&ndash;28, 1991')).toBe('8, 21–28, 1991');
    expect(decodeHtmlEntities('&ldquo;High-Temperature Properties&rdquo;')).toBe(
      '“High-Temperature Properties”',
    );
    expect(decodeHtmlEntities('KUD&Ocirc; A, Wei&szlig;e P, O&prime;Neill M, &middot;')).toBe(
      'KUDÔ A, Weiße P, O′Neill M, ·',
    );
  });

  /** A few names resolve to more than one code point; the table carries the whole value. */
  it('decodes a reference whose value is more than one code point', () => {
    expect(decodeHtmlEntities('e&fjlig;ord')).toBe('efjord');
  });

  /**
   * Names are case-sensitive and the table is closed, so a name the spec does not define
   * stays as deposited. `&Amp;` and `&Eng;` are both real deposits — the second is the
   * journal abbreviation "Nuclear Science & Engineering", not a reference at all.
   */
  it('decodes only the exact names the spec defines', () => {
    expect(decodeHtmlEntities('Civil &AMP; Structural')).toBe('Civil & Structural');
    expect(decodeHtmlEntities('Civil &Amp; Structural')).toBe('Civil &Amp; Structural');
    expect(decodeHtmlEntities('Nuc. Sci. &Eng; 2013')).toBe('Nuc. Sci. &Eng; 2013');
  });

  /**
   * A deposit escaped one level too deep writes a run of `&amp;` in front of a reference, and no
   * sampled deposit means the doubled reference literally: `false discovery rate &amp;lt; 10%`
   * is an inequality. The reference behind the run decodes as that reference at any depth.
   */
  it('decodes a reference behind any run of &amp; as that reference', () => {
    expect(decodeHtmlEntities('&amp;lt;')).toBe('<');
    expect(decodeHtmlEntities('&amp;amp;')).toBe('&');
    expect(decodeHtmlEntities('&amp;#65;')).toBe('A');
    expect(decodeHtmlEntities('&amp;#x41;')).toBe('A');
    expect(decodeHtmlEntities('&amp;beta;')).toBe('β');
    expect(decodeHtmlEntities('CEC&amp;amp;rsquo;17')).toBe('CEC’17');
    expect(decodeHtmlEntities('&amp;amp;amp;')).toBe('&');
    expect(decodeHtmlEntities('false discovery rate &amp;lt; 10%')).toBe(
      'false discovery rate < 10%',
    );
  });

  /**
   * Behind a name the table lacks, or a numeric reference that names no scalar, exactly one level
   * comes off, the one an ordinary decode takes, and the rest stays as deposited.
   */
  it('takes one level off a run whose reference does not resolve', () => {
    expect(decodeHtmlEntities('&amp;Eng;')).toBe('&Eng;');
    expect(decodeHtmlEntities('&amp;amp;Eng;')).toBe('&amp;Eng;');
    expect(decodeHtmlEntities('a&amp;#0;b')).toBe('a&#0;b');
    expect(decodeHtmlEntities('R&amp;amp;D, AT&amp;T, &amp;amp')).toBe('R&D, AT&T, &amp');
  });

  /**
   * One pass that never reads its own output: a chained per-name replace resolves `&amp;` into
   * an `&` the next name then reads. Each run is decoded where it was deposited, so an `&` the
   * decode writes never heads a reference after it.
   */
  it('never reads a reference out of its own output', () => {
    expect(decodeHtmlEntities('&#38;lt;')).toBe('&lt;');
    expect(decodeHtmlEntities('&amp;#38;lt;')).toBe('&lt;');
    expect(decodeHtmlEntities('&amp;&#108;t;')).toBe('&lt;');
    expect(decodeHtmlEntities('&amp;amp;Eng;')).toBe('&amp;Eng;');
  });

  /** The lowering the markup pass reads a field through: one `&amp;` off each one heading a reference. */
  describe('lowerEscapedReferences', () => {
    it('writes each &amp; that heads a reference as &', () => {
      expect(lowerEscapedReferences('&amp;lt;p&amp;gt;x&amp;lt;/p&amp;gt;')).toBe(
        '&lt;p&gt;x&lt;/p&gt;',
      );
      expect(lowerEscapedReferences('p style=&amp;quot;a b&amp;quot;')).toBe(
        'p style=&quot;a b&quot;',
      );
      expect(lowerEscapedReferences('&amp;amp;rsquo; &amp;amp;lt; &amp;#160; &amp;Eng;')).toBe(
        '&amp;rsquo; &amp;lt; &#160; &Eng;',
      );
      expect(lowerEscapedReferences('&amp;amp;x')).toBe('&amp;x');
    });

    it('leaves every other ampersand as deposited', () => {
      for (const raw of [
        '&lt;p&gt;',
        'R&amp;D',
        'AT&T',
        '&amp',
        '&amp;#;',
        '&amp;&amp;',
        'plain',
      ]) {
        expect(lowerEscapedReferences(raw)).toBe(raw);
      }
    });

    /**
     * The decode reads a string and the string lowered alike wherever the reference resolves, and
     * wherever a reference it does not resolve is escaped once. Escaped twice, such a reference
     * reads one level apart, since the decode takes exactly one level off it either way.
     */
    it('reads the same through the decode, lowered or not, but for an unresolved name escaped twice', () => {
      for (const raw of [
        '&amp;lt;i&amp;gt; &amp;amp;rsquo; &amp;#65; &amp;#x41; &amp;nbsp; &amp;amp;amp;',
        'R&amp;amp;D, AT&amp;T, &amp;Eng;, a&amp;#0;b',
      ]) {
        expect(decodeHtmlEntities(lowerEscapedReferences(raw))).toBe(decodeHtmlEntities(raw));
      }
      expect(decodeHtmlEntities('&amp;amp;Eng;')).toBe('&amp;Eng;');
      expect(decodeHtmlEntities(lowerEscapedReferences('&amp;amp;Eng;'))).toBe('&Eng;');
    });
  });

  /**
   * A bare `&` is an ampersand somebody typed. Requiring the terminating semicolon is what
   * keeps it one — the legacy no-semicolon forms HTML still parses (`&copy`, `&times`) are
   * deliberately outside the table.
   */
  it('leaves a bare ampersand and a malformed reference exactly as deposited', () => {
    const cases = [
      'R&D and AT&T',
      'Guyatt & Rennie',
      '&notarealentity;',
      '&#;',
      '&#xZZ;',
      '&#x;',
      '&;',
      '& copy;',
      '&copy 2020, all rights reserved',
      'query?a=1&b=2',
    ];
    for (const raw of cases) expect(decodeHtmlEntities(raw)).toBe(raw);
  });

  /**
   * A numeric reference that names no scalar value — zero, past the last code point, or half
   * of a surrogate pair — is left as source text rather than emitting a character that would
   * be a hazard on the wire. Astral references resolve whole rather than being truncated to
   * sixteen bits.
   */
  it('resolves astral numeric references and passes over the ones naming no scalar', () => {
    expect(decodeHtmlEntities('&#128169;')).toBe('💩');
    expect(decodeHtmlEntities('&#x1F600;')).toBe('😀');
    expect(decodeHtmlEntities('&#0;')).toBe('&#0;');
    expect(decodeHtmlEntities('&#1114112;')).toBe('&#1114112;');
    expect(decodeHtmlEntities('&#55296;')).toBe('&#55296;');
  });

  it('returns plain strings unchanged', () => {
    expect(decodeHtmlEntities('plain text')).toBe('plain text');
  });

  it('handles a string with no entities', () => {
    expect(decodeHtmlEntities('')).toBe('');
  });

  /**
   * An abstract packed with references, and a long run of ampersands that start a name and
   * never terminate it, are both linear for this matcher — no nested quantifier to send it
   * exponential.
   */
  describe('on entity-dense and unterminated-reference input', () => {
    const unit = '&alpha;&beta;&#160;&amp;&notaname;&#x1F600;';
    const dense = (size: number) => repeatWhole(unit, size);
    const unterminated = (size: number) =>
      `${repeatWhole('&amp', size / 2)}&${'a'.repeat(size / 2 - 1)}`;

    it('decodes each reference in a dense run and leaves an unterminated run as written', () => {
      expect(decodeHtmlEntities(dense(80_000))).toBe(
        decodeHtmlEntities(unit).repeat(dense(80_000).length / unit.length),
      );
      expect(decodeHtmlEntities(unterminated(80_000))).toBe(unterminated(80_000));
    });

    it.each([
      ['an entity-dense run', dense],
      ['an unterminated reference run', unterminated],
      /**
       * Each run is held to 80,000 characters, past which the input grows by more runs: a single
       * run past about 60,000 repetitions of its `amp;` group sends JavaScriptCore's regex engine
       * to a slower mode. The work stays linear on both sides of the switch, but measured across
       * it the step reads as growth.
       */
      [
        'a run of &amp; heading no reference',
        (size: number) => repeatWhole(`&${'amp;'.repeat(Math.min(size, 80_000) / 4 - 1)}x`, size),
      ],
      [
        '&amp; before a long letter run with no semicolon',
        (size: number) => `&amp;${'x'.repeat(size - 5)}`,
      ],
      [
        '&amp; before a long digit run with no semicolon',
        (size: number) => `&amp;#${'1'.repeat(size - 6)}`,
      ],
      [
        'runs of &amp; each before a letter run with no semicolon',
        (size: number) => repeatWhole(`&amp;amp;${'x'.repeat(91)}`, size),
      ],
      [
        'one long line ending in a break',
        (size: number) => `&amp;lt;${repeatTo('§1 x', size - 10)}\ny`,
      ],
      ['breaks throughout', (size: number) => `&amp;lt;${repeatTo('  \r\n', size - 8)}`],
    ])(
      'stays linear on %s',
      (_name, make) => {
        expectLinearScaling(make, decodeHtmlEntities);
      },
      0,
    );
  });
});
