/**
 * @fileoverview The three markup regions the normalization passes match end to end — a MathML
 * formula, an `<alternatives>` wrapper, a JATS structured citation — as a matcher: which span
 * each one claims, and what that costs. A region is all or nothing and runs from its opener to
 * the first closer after it; an opener no closer follows claims nothing, and finding that out
 * must not cost a rescan of the rest of the field per opener.
 * @module tests/services/crossref/markup-regions.test
 */

import { describe, expect, it } from 'vitest';
import {
  normalizeMarkupText,
  normalizeReferenceText,
} from '@/services/crossref/crossref-service.js';
import { measureScaling, repeatTo } from '../../helpers/scaling.js';

/** Both markup passes over one input, as `[JATS, reference]`. */
function bothPasses(raw: string): [string, string] {
  return [normalizeMarkupText(raw), normalizeReferenceText(raw)];
}

describe('markup region matching', () => {
  it('matches an opener and closer in any case and namespace spelling', () => {
    expect(bothPasses('a <MML:MATH xmlns:mml="x"><mml:mi>x</mml:mi></mml:MATH> b')).toEqual([
      'a x b',
      'a x b',
    ]);
    expect(bothPasses('see <Mixed-Citation><surname>Fan</surname> L.</CITATION> tail')).toEqual([
      'see Fan L. tail',
      'see Fan L. tail',
    ]);
  });

  /** A region runs to the first closer after its opener, so an opener inside it is content. */
  it('runs an unclosed opener to the first closer after it', () => {
    expect(bothPasses('<mixed-citation>a <mixed-citation><i>b</i></mixed-citation> c')).toEqual([
      'a b c',
      'a b c',
    ]);
  });

  it('matches back-to-back regions one at a time', () => {
    expect(
      bothPasses(
        '<alternatives><tex-math>$a$</tex-math></alternatives><alternatives><tex-math>$b$</tex-math></alternatives>',
      ),
    ).toEqual(['$a$ $b$', '$a$ $b$']);
  });

  /**
   * Every region the field closes is matched before the one it leaves open, and the open one
   * falls to the name rule — which on the reference surface keeps an unrecognized name.
   */
  it('matches the closed regions ahead of an opener that is never closed', () => {
    expect(
      bothPasses(
        'x <alternatives><tex-math>$a$</tex-math></alternatives> y <alternatives><tex-math>$b$</tex-math> z',
      ),
    ).toEqual(['x $a$ y $b$ z', 'x $a$ y <alternatives>$b$ z']);
    expect(
      bothPasses(
        'x <mixed-citation><surname>A</surname></mixed-citation> y <mixed-citation><surname>B</surname> z',
      ),
    ).toEqual(['x A y B z', 'x A y <mixed-citation>B z']);
  });

  it('leaves an opener that is never terminated as text', () => {
    expect(bothPasses('a <math b')).toEqual(['a <math b', 'a <math b']);
  });

  /** An opener's attributes may be quoted or bare; either one opens the region. */
  it('opens a region on a bare attribute value', () => {
    expect(bothPasses('<alternatives id=a1><tex-math>$q$</tex-math></alternatives>')).toEqual([
      '$q$',
      '$q$',
    ]);
    expect(bothPasses('a <span class=sc>b</span> c')).toEqual(['a b c', 'a b c']);
  });

  /**
   * A character reference inside a formula is text to the strip and resolves in the decode that
   * follows it — so an escaped `<` is a relation, never a tag.
   */
  it('decodes the character references a formula carries after its tags are gone', () => {
    expect(bothPasses('a <math><mi>a</mi><mo>&lt;</mo><mi>b</mi></math> b')).toEqual([
      'a a<b b',
      'a a<b b',
    ]);
    expect(bothPasses('<math><mi>x</mi><mo>&#x2212;</mo><mn>1</mn></math>')).toEqual([
      'x−1',
      'x−1',
    ]);
  });
});

/**
 * An opener with no closer claims nothing, and a matcher that learns that by scanning to the
 * end of the field from every opener costs time quadratic in the field. Measured by growth, not
 * against a single budget: t(80k)/t(5k) is 16 for linear work and 256 for quadratic.
 */
describe('markup region matching on openers that never close', () => {
  const shapes: Array<[string, string]> = [
    ['MathML openers', '<math><mi>'],
    ['alternatives openers', '<alternatives><tex-math>'],
    ['structured-citation openers', '<mixed-citation>a'],
    ['MathML openers never terminated', '<math'],
    ['alternatives openers on a bare attribute', '<alternatives x=1'],
    ['structured-citation openers on a bare attribute', '<mixed-citation x=1'],
    ['inline tags on a bare attribute', '<i x=1'],
  ];

  it.each(shapes)(
    'stays linear on %s',
    (_name, unit) => {
      const { ms, ratio } = measureScaling(
        (size) => repeatTo(unit, size),
        (raw) => {
          normalizeMarkupText(raw);
          normalizeReferenceText(raw);
        },
      );
      expect(ratio, `t = ${ms.map((t) => t.toFixed(2)).join(' / ')} ms`).toBeLessThan(64);
      expect(ms[2]).toBeLessThan(100);
    },
    60_000,
  );
});

/**
 * A link element's tags come out only where its own text already carries its address, and that
 * text runs from the opener to the first closer of its name, with any markup inside it removed
 * and whitespace collapsed. Every opener before one closer reads a piece of the same text.
 */
describe('the text a link element is checked against', () => {
  it('reads to the first closer of its name, across any opener of the same name inside it', () => {
    expect(
      bothPasses('<a href="https://x.org/B">A <a href="https://y.org/">x.org/B</a> C</a>'),
    ).toEqual([
      'A <a href="https://y.org/">x.org/B C</a>',
      'A <a href="https://y.org/">x.org/B C</a>',
    ]);
    expect(
      bothPasses('<a href="https://y.org/">A <a href="https://x.org/q">B y.org/</a> C</a>'),
    ).toEqual([
      'A <a href="https://x.org/q">B y.org/ C</a>',
      'A <a href="https://x.org/q">B y.org/ C</a>',
    ]);
    expect(bothPasses('<uri href="p1">q <uri href="p2">p1 <uri href="p3">p2</uri> end')).toEqual([
      'q p1 <uri href="p3">p2 end',
      'q p1 <uri href="p3">p2 end',
    ]);
  });

  it('reads from the end of the opening tag, even past a `>` its address carries', () => {
    expect(bothPasses('<a href="http://a.org/?x>1">see a.org/?x>1</a>')).toEqual([
      'see a.org/?x>1',
      'see a.org/?x>1',
    ]);
  });

  it('collapses whitespace across the markup inside it, as the reader sees it', () => {
    expect(
      bothPasses(
        '<ext-link xlink:href="https://a.org/b c">  https://a.org/b <i> </i>  c </ext-link>',
      ),
    ).toEqual(['https://a.org/b c', 'https://a.org/b c']);
    expect(bothPasses('<a href="https://a.org/b c">https://a.org/b \n c</a>')).toEqual([
      'https://a.org/b c',
      'https://a.org/b c',
    ]);
  });

  /** A `<` runs to the next `>` whatever lies between, and one no `>` follows is text. */
  it('treats a bracket inside it as markup only up to the next `>`', () => {
    expect(
      bothPasses('<ext-link xlink:href="https://a.org/x">https://a.org/x <<b> tail</ext-link>'),
    ).toEqual(['https://a.org/x < tail', 'https://a.org/x < tail']);
    expect(
      bothPasses('<ext-link xlink:href="https://a.org/x">https://a.org/x < no close</ext-link>'),
    ).toEqual(['https://a.org/x < no close', 'https://a.org/x < no close']);
  });

  it('forgives the scheme of an address and nothing else', () => {
    expect(
      bothPasses(
        '<a href="https://www.fasebj.org">www.fasebj.org</a> and <a href="https://z.org/p">z.org</a>',
      ),
    ).toEqual([
      'www.fasebj.org and <a href="https://z.org/p">z.org</a>',
      'www.fasebj.org and <a href="https://z.org/p">z.org</a>',
    ]);
  });
});

/**
 * Reading a link's text must cost each part of the field once: not a rescan to the end from
 * every bracket inside it that no `>` follows, and not a fresh read of the whole span for every
 * opener that shares its closer.
 */
describe('the text a link element is checked against, at scale', () => {
  const opener = '<a href="https://a.org/x">';
  const shapes: Array<[string, (size: number) => string]> = [
    [
      'a run of brackets no `>` follows',
      (size) => `<ext-link xlink:href="https://a.org/x">${'<'.repeat(size - 50)}</ext-link>`,
    ],
    [
      'a run of tag openings no `>` follows',
      (size) => `<ext-link xlink:href="https://a.org/x">${repeatTo('<a', size - 50)}</ext-link>`,
    ],
    ['openers sharing one far closer', (size) => `${repeatTo(`${opener}t `, size - 4)}</a>`],
    [
      'openers with distinct addresses sharing one far closer',
      (size) => {
        let raw = '';
        for (let i = 0; raw.length < size - 40; i++) raw += `<a href="https://a.org/${i}">t `;
        return `${raw}</a>`;
      },
    ],
    [
      'links nested inside links',
      (size) => {
        const depth = Math.floor((size - 1) / (opener.length + 4));
        return `${opener.repeat(depth)}t${'</a>'.repeat(depth)}`;
      },
    ],
  ];

  it.each(shapes)(
    'stays linear on %s',
    (_name, make) => {
      const { ms, ratio } = measureScaling(make, (raw) => {
        normalizeMarkupText(raw);
        normalizeReferenceText(raw);
      });
      expect(ratio, `t = ${ms.map((t) => t.toFixed(2)).join(' / ')} ms`).toBeLessThan(64);
      expect(ms[2]).toBeLessThan(100);
    },
    120_000,
  );
});
