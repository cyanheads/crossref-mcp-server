/**
 * @fileoverview Numeric JATS scripts across both shared normalization paths.
 * @module tests/services/crossref/numeric-superscripts.test
 */
import { describe, expect, it } from 'vitest';
import {
  normalizeMarkupText,
  normalizeReferenceText,
} from '@/services/crossref/crossref-service.js';
import { expectLinearScaling, nestTo, repeatTo } from '../../helpers/scaling.js';

const passes = [normalizeMarkupText, normalizeReferenceText];

describe('numeric superscripts', () => {
  describe.each(passes)('%s', (normalize) => {
    it.each([
      ['10<sup>16</sup> Tesla', '10^{16} Tesla'],
      ['GeV <sup>2</sup>', 'GeV^2'],
      ['Ca<sup>2+</sup> m<sup>-1</sup>', 'Ca^{2+} m^{-1}'],
      ['x<jats:superscript><i>2</i>&#x2212;</jats:superscript>', 'x^{2−}'],
      ['waves<sup>1</sup><sup>2</sup>', 'waves^1^2'],
      ['x<sup>+</sup>y<sup>.</sup>', 'x^+y^.'],
      ['<mixed-citation>x<sup>2</sup></mixed-citation>', 'x^2'],
      ['<alternatives><tex>x<sup>2</sup></tex><tex>other</tex></alternatives>', 'x^2'],
      ['x<sup><sup>2</sup></sup>', 'x^2'],
    ])('preserves numeric script meaning in %s', (raw, expected) => {
      expect(normalize(raw)).toBe(expected);
    });

    it.each([
      ['xvii<sup>e</sup>', 'xviie'],
      ['x<sup>st</sup><sup>®</sup><sup>†</sup>', 'xst®†'],
      ['H<sub>2</sub>O T<inf>c</inf>', 'H2O Tc'],
      ['x<sup>1,2</sup>', 'x1,2'],
      ['x<sup>2', 'x2'],
      ['x<sup hidden>2</sup>', 'x<sup hidden>2</sup>'],
    ])('preserves the existing reading of %s', (raw, expected) => {
      expect(normalize(raw)).toBe(expected);
    });
  });
  it.each([
    ['adjacent scripts', (size: number) => repeatTo('x<sup>2</sup>', size)],
    ['unclosed scripts', (size: number) => repeatTo('<sup>2', size)],
    ['nested scripts', (size: number) => nestTo('<sup>', '2', '</sup>', size)],
    ['nested emphasis', (size: number) => `<sup>${nestTo('<i>', '2', '</i>', size - 11)}</sup>`],
    ['overlapping openers', (size: number) => repeatTo('<sup x=1', size)],
    ['line ending', (size: number) => `${'2'.repeat(size - 13)}<sup>2</sup>\n`],
    ['line breaks throughout', (size: number) => repeatTo('x\n<sup>2</sup>\n', size)],
    ['plain text', (size: number) => 'x'.repeat(size)],
  ])('stays linear on %s', (_name, make) => {
    expectLinearScaling(make, normalizeMarkupText);
  });
});
