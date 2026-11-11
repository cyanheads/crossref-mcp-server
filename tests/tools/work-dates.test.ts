/**
 * @fileoverview The dated facts a work record deposits beside its publication date, tabled once
 * at their shared seam: the projection crossref_get_work and crossref_search_works both return and
 * the Markdown line both render. Each case reads one deposit through both, so a shape the line
 * renders differently from the structured value fails here rather than on one tool alone.
 * @module tests/tools/work-dates.test
 */

import { describe, expect, it } from 'vitest';
import {
  approvedLine,
  eventLine,
  projectApproved,
  projectEvent,
} from '@/mcp-server/tools/work-dates.js';

/** A record's event as both surfaces carry it. */
function both(event: unknown) {
  const projected = projectEvent({ event } as Parameters<typeof projectEvent>[0]);
  return { structured: projected.event, line: eventLine(projected) };
}

describe('event', () => {
  it.each([
    {
      shape: 'a full deposit',
      deposited: {
        name: '2025 11th International Conference on Control, Automation and Robotics (ICCAR)',
        location: 'Kyoto, Japan',
        start: { 'date-parts': [[2025, 4, 18]] },
        end: { 'date-parts': [[2025, 4, 20]] },
      },
      structured: {
        name: '2025 11th International Conference on Control, Automation and Robotics (ICCAR)',
        location: 'Kyoto, Japan',
        start: { year: 2025, month: 4, day: 18 },
        end: { year: 2025, month: 4, day: 20 },
      },
      line: '**Event:** 2025 11th International Conference on Control, Automation and Robotics (ICCAR), Kyoto, Japan, 2025-04-18 – 2025-04-20',
    },
    {
      shape: 'an acronym, beside dates deposited to the month and the year',
      deposited: {
        name: 'International Technology, Education and Development Conference',
        acronym: 'ICERI2016',
        location: 'Seville, Spain',
        start: { 'date-parts': [[2016, 11]] },
        end: { 'date-parts': [[2016]] },
      },
      structured: {
        name: 'International Technology, Education and Development Conference',
        acronym: 'ICERI2016',
        location: 'Seville, Spain',
        start: { year: 2016, month: 11 },
        end: { year: 2016 },
      },
      line: '**Event:** International Technology, Education and Development Conference (ICERI2016), Seville, Spain, 2016-11 – 2016',
    },
    {
      shape: 'a start and no end',
      deposited: { name: 'Meeting', start: { 'date-parts': [[2011]] } },
      structured: { name: 'Meeting', start: { year: 2011 } },
      line: '**Event:** Meeting, 2011',
    },
    {
      shape: 'an end and no start',
      deposited: { name: 'Meeting', end: { 'date-parts': [[2011, 6, 3]] } },
      structured: { name: 'Meeting', end: { year: 2011, month: 6, day: 3 } },
      line: '**Event:** Meeting, until 2011-06-03',
    },
    {
      shape: 'dates Crossref records as unknown',
      deposited: {
        name: 'Meeting',
        location: 'Lushan',
        start: { 'date-parts': [[null]] },
        end: { 'date-parts': [[2011, null, 24]] },
      },
      structured: { name: 'Meeting', location: 'Lushan', end: { year: 2011 } },
      line: '**Event:** Meeting, Lushan, until 2011',
    },
    {
      shape: 'a name alone',
      deposited: { name: 'Meeting' },
      structured: { name: 'Meeting' },
      line: '**Event:** Meeting',
    },
    {
      shape: 'no name',
      deposited: { acronym: 'ICERI2016', location: 'Seville, Spain' },
      structured: { acronym: 'ICERI2016', location: 'Seville, Spain' },
      line: '**Event:** ICERI2016, Seville, Spain',
    },
    {
      shape: 'the subfields left out of the projection, beside a name',
      deposited: { name: 'Meeting', number: '9', sponsor: ['IEEE'], theme: 'Energy' },
      structured: { name: 'Meeting' },
      line: '**Event:** Meeting',
    },
  ])('projects and renders $shape', ({ deposited, structured, line }) => {
    expect(both(deposited)).toEqual({ structured, line });
  });

  /**
   * Deposited names carry character references and runs of whitespace. Both are normalized the
   * way a publisher name is, and the normalized value is what the line escapes.
   */
  it('normalizes each string, and the line escapes the normalized value', () => {
    expect(
      both({
        name: '2005 Pacific Rim Conference on Lasers &amp; Electro-Optics  *CLEO/PR*',
        acronym: 'CLEO/PR\n 2005',
        location: 'Tokyo,   Japan',
      }),
    ).toEqual({
      structured: {
        name: '2005 Pacific Rim Conference on Lasers & Electro-Optics *CLEO/PR*',
        acronym: 'CLEO/PR 2005',
        location: 'Tokyo, Japan',
      },
      line: '**Event:** 2005 Pacific Rim Conference on Lasers & Electro-Optics \\*CLEO/PR\\* (CLEO/PR 2005), Tokyo, Japan',
    });
  });

  it.each([
    ['a record depositing none', undefined],
    ['an event carrying only the subfields left out', { number: '9', sponsor: ['IEEE'] }],
    ['an event whose only date is unknown', { start: { 'date-parts': [[null]] } }],
    ['an event whose only string normalizes to nothing', { name: ' \n ', acronym: '' }],
  ])('omits the field and the line for %s', (_, deposited) => {
    expect(both(deposited)).toEqual({ structured: undefined, line: undefined });
  });

  it('drops a string that normalizes to nothing and keeps the rest', () => {
    expect(both({ name: '&#32; ', location: 'Kyoto, Japan' })).toEqual({
      structured: { location: 'Kyoto, Japan' },
      line: '**Event:** Kyoto, Japan',
    });
  });
});

/**
 * The date a dissertation or standard deposits in place of a publication date. It is read the
 * way the publication date is — a component Crossref does not know ends the date there — and it
 * is its own field, never a publication date.
 */
describe('approved', () => {
  function approvedOf(approved: unknown) {
    const projected = projectApproved({ approved } as Parameters<typeof projectApproved>[0]);
    return { structured: projected.approved, line: approvedLine(projected) };
  }

  it.each([
    [[[2015, 9, 22]], { year: 2015, month: 9, day: 22 }, '**Approved:** 2015-09-22'],
    [[[2016, 11]], { year: 2016, month: 11 }, '**Approved:** 2016-11'],
    [[[1978]], { year: 1978 }, '**Approved:** 1978'],
    [[[2020, null, 15]], { year: 2020 }, '**Approved:** 2020'],
    [[[2020, 3, null]], { year: 2020, month: 3 }, '**Approved:** 2020-03'],
  ])('projects and renders date-parts %j', (dateParts, structured, line) => {
    expect(approvedOf({ 'date-parts': dateParts })).toEqual({ structured, line });
  });

  it.each([
    ['a record depositing none', undefined],
    ['a year Crossref does not know', { 'date-parts': [[null]] }],
    ['no date-parts at all', {}],
  ])('omits the field and the line for %s', (_, deposited) => {
    expect(approvedOf(deposited)).toEqual({ structured: undefined, line: undefined });
  });
});
