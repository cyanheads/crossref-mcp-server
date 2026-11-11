/**
 * @fileoverview Character-reference decoding for deposited Crossref text.
 * @module tests/services/crossref/html-entities.test
 */

import { describe, expect, it } from 'vitest';
import { decodeHtmlEntities } from '@/services/crossref/html-entities.js';
import { expectLinearScaling, repeatWhole } from '../../helpers/scaling.js';

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
   * One pass, so a reference is resolved exactly once. `&amp;lt;` is the escaped text
   * `&lt;` and must stay that — a chained per-name replace resolves it twice and
   * manufactures a tag out of text a publisher escaped so it would not be one.
   */
  it('decodes each reference once, never the result of a previous decode', () => {
    expect(decodeHtmlEntities('&amp;lt;')).toBe('&lt;');
    expect(decodeHtmlEntities('&amp;amp;')).toBe('&amp;');
    expect(decodeHtmlEntities('&amp;#65;')).toBe('&#65;');
    expect(decodeHtmlEntities('&amp;beta;')).toBe('&beta;');
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
    ])(
      'stays linear on %s',
      (_name, make) => {
        expectLinearScaling(make, decodeHtmlEntities);
      },
      60_000,
    );
  });
});
