/**
 * @fileoverview Date-parts reading and formatting, and the publication-date chain a full work
 * record and a work summary resolve through.
 * @module tests/services/crossref/date-parts.test
 */

import { describe, expect, it } from 'vitest';
import {
  formatDateParts,
  parseDateParts,
  resolveWorkDate,
  resolveWorkSummaryDate,
} from '@/services/crossref/date-parts.js';

describe('formatDateParts', () => {
  it('formats year only', () => {
    expect(formatDateParts({ year: 2023 })).toBe('2023');
  });

  it('formats year and month with zero-padding', () => {
    expect(formatDateParts({ year: 2023, month: 4 })).toBe('2023-04');
  });

  it('formats full date with zero-padding', () => {
    expect(formatDateParts({ year: 2023, month: 4, day: 5 })).toBe('2023-04-05');
  });

  it('returns empty string for no parts', () => {
    expect(formatDateParts({})).toBe('');
  });

  it('formats month and day without year', () => {
    expect(formatDateParts({ month: 3, day: 15 })).toBe('03-15');
  });
});

describe('parseDateParts', () => {
  it('parses full date parts array', () => {
    const result = parseDateParts({ 'date-parts': [[2023, 4, 5]] });
    expect(result).toEqual({ year: 2023, month: 4, day: 5 });
  });

  it('parses year and month only', () => {
    const result = parseDateParts({ 'date-parts': [[2023, 8]] });
    expect(result).toEqual({ year: 2023, month: 8 });
  });

  it('parses year only', () => {
    const result = parseDateParts({ 'date-parts': [[2019]] });
    expect(result).toEqual({ year: 2019 });
  });

  it('returns undefined for undefined input', () => {
    expect(parseDateParts(undefined)).toBeUndefined();
  });

  it('returns undefined for empty date-parts array', () => {
    expect(parseDateParts({ 'date-parts': [[]] })).toBeUndefined();
  });

  it('returns undefined for missing date-parts key', () => {
    expect(parseDateParts({})).toBeUndefined();
  });

  it('handles nested empty array', () => {
    const result = parseDateParts({ 'date-parts': [[] as number[]] });
    expect(result).toBeUndefined();
  });

  /**
   * Crossref deposits an unknown component as `null` in the tuple rather than leaving it off, so
   * a record with no registered year arrives as `[[null]]`. That is the same fact as no date at
   * all, and each component is declared a number on every output schema that carries one —
   * passing the null through fails the whole call on a record whose every other field parsed.
   */
  it('returns undefined for a year Crossref does not know', () => {
    expect(parseDateParts({ 'date-parts': [[null]] })).toBeUndefined();
    expect(parseDateParts({ 'date-parts': [[null, 4, 5]] })).toBeUndefined();
  });

  /**
   * The tuple is positional, so the components below an unknown one carry no meaning on their
   * own: a day belonging to a month nobody named renders through formatDateParts as `2020-15`,
   * a date the deposit never made.
   */
  it('stops at the first component Crossref does not know', () => {
    expect(parseDateParts({ 'date-parts': [[2020, null]] })).toEqual({ year: 2020 });
    expect(parseDateParts({ 'date-parts': [[2020, null, 15]] })).toEqual({ year: 2020 });
    expect(parseDateParts({ 'date-parts': [[2020, 3, null]] })).toEqual({ year: 2020, month: 3 });
  });
});

describe('resolveWorkDate / resolveWorkSummaryDate', () => {
  it('answers with the preferred source when it names a date', () => {
    const raw = {
      published: { 'date-parts': [[2021, 6, 2]] },
      'published-print': { 'date-parts': [[2021, 7]] },
      issued: { 'date-parts': [[2021, 6, 2]] },
    };
    expect(resolveWorkDate(raw)).toEqual({ year: 2021, month: 6, day: 2 });
    expect(resolveWorkSummaryDate(raw)).toEqual({ year: 2021, month: 6, day: 2 });
  });

  /**
   * The whole point of the chain, and the one shape the two possible orders disagree on.
   * Crossref writes a component it does not know as `null` inside the tuple, so a source
   * deposited holding only unknowns states no date — the same fact an absent field states.
   * Selecting the source object first and parsing once would read its presence as an answer
   * and report no publication date for a record that names one two fields along.
   */
  it('falls through a source deposited with only unknown components', () => {
    const raw = {
      published: { 'date-parts': [[null]] },
      'published-print': { 'date-parts': [[2020, 5]] },
    };
    expect(resolveWorkDate(raw)).toEqual({ year: 2020, month: 5 });
    expect(resolveWorkSummaryDate(raw)).toEqual({ year: 2020, month: 5 });
  });

  it('falls through every unknown source in turn', () => {
    const raw = {
      published: { 'date-parts': [[null]] },
      'published-print': { 'date-parts': [[null, 4]] },
      'published-online': { 'date-parts': [[2018, 11, 30]] },
    };
    expect(resolveWorkDate(raw)).toEqual({ year: 2018, month: 11, day: 30 });
    expect(resolveWorkSummaryDate(raw)).toEqual({ year: 2018, month: 11, day: 30 });
  });

  /**
   * It advances on nothing, never on less. `published` is the earliest of the two publication
   * events and `published-online` is one particular event, so completing a coarse `published`
   * from a precise `published-online` would answer with the online date instead of the
   * publication date — on the ~10% of works whose sources differ in precision.
   */
  it('keeps a coarse date rather than refining it from a later source', () => {
    const raw = {
      published: { 'date-parts': [[2024]] },
      'published-print': { 'date-parts': [[2024]] },
      'published-online': { 'date-parts': [[2024, 1, 5]] },
    };
    expect(resolveWorkDate(raw)).toEqual({ year: 2024 });
    expect(resolveWorkSummaryDate(raw)).toEqual({ year: 2024 });
  });

  /** `issued` is the full record's last resort, and a work summary reads none of it. */
  it('reads issued for a record and never for a summary', () => {
    const raw = { issued: { 'date-parts': [[1997, 2]] } };
    expect(resolveWorkDate(raw)).toEqual({ year: 1997, month: 2 });
    expect(resolveWorkSummaryDate(raw)).toBeUndefined();
  });

  it('answers with nothing when no source names a date', () => {
    expect(resolveWorkDate({})).toBeUndefined();
    expect(resolveWorkDate({ issued: { 'date-parts': [[null]] } })).toBeUndefined();
    expect(resolveWorkSummaryDate({ published: { 'date-parts': [[null]] } })).toBeUndefined();
  });

  /**
   * A dissertation deposits its date only as `approved`, beside an `issued` of `[[null]]`. That is
   * an approval date, not a publication date, and the chain never reads it: the record states no
   * publication date, and a report carrying both keeps the date it was published.
   */
  it('never answers with an approval date', () => {
    const dissertation = {
      approved: { 'date-parts': [[2015, 9, 22]] },
      issued: { 'date-parts': [[null]] },
    };
    expect(resolveWorkDate(dissertation)).toBeUndefined();
    expect(resolveWorkSummaryDate(dissertation)).toBeUndefined();

    const report = {
      approved: { 'date-parts': [[1994, 3, 1]] },
      published: { 'date-parts': [[1995, 7]] },
    };
    expect(resolveWorkDate(report)).toEqual({ year: 1995, month: 7 });
    expect(resolveWorkSummaryDate(report)).toEqual({ year: 1995, month: 7 });
  });
});
