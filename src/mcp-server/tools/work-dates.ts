/**
 * @fileoverview The dated facts a work record deposits beside its publication date — the
 * conference event a proceedings paper was presented at, and the date a dissertation or standard
 * was approved — each as an output field, a projection, and a Markdown line. Both
 * crossref_get_work and crossref_search_works return them, and sharing the pieces is what keeps
 * the two tools naming, describing, and rendering each one identically.
 *
 * The approval date is never a publication date. Most dissertations and standards deposit no
 * other date, and reading it as `published` would report when an institution approved a thesis,
 * or a body a standard, as when the work was published; it stays a field of its own, and
 * `published` stays absent on a record that states none.
 * @module mcp-server/tools/work-dates
 */

import { z } from '@cyanheads/mcp-ts-core';
import { mdText } from '@/mcp-server/tools/markdown-text.js';
import { formatDateParts, parseDateParts } from '@/services/crossref/date-parts.js';
import { normalizeNonEmptyText } from '@/services/crossref/markup-text.js';
import type { RawCrossrefWork } from '@/services/crossref/types.js';

/** A deposited date as the work tools return it, each component omitted when unknown. */
export const DatePartsSchema = z.object({
  year: z.number().optional().describe('Year'),
  month: z.number().optional().describe('Month (1–12)'),
  day: z.number().optional().describe('Day of month'),
});

type DateParts = z.infer<typeof DatePartsSchema>;

/** What every date these fields carry omits, in the words the publication date uses. */
const PARTIAL_DATE =
  'A component Crossref records as unknown is omitted, and so is every component below it.';

const EventSchema = z.object({
  name: z.string().optional().describe('Event name as deposited'),
  acronym: z.string().optional().describe('Event acronym, where deposited'),
  location: z.string().optional().describe('Where the event was held, as deposited'),
  start: DatePartsSchema.optional().describe(`First day of the event. ${PARTIAL_DATE}`),
  end: DatePartsSchema.optional().describe(`Last day of the event. ${PARTIAL_DATE}`),
});

type WorkEvent = z.infer<typeof EventSchema>;

/** The event output field, spread into a work's output schema. */
export const eventFields = {
  event: EventSchema.optional().describe(
    'Conference or meeting the work was presented at, as a proceedings record deposits it: name, acronym, location, and dates, each where deposited. Omitted when the record deposits none.',
  ),
};

/**
 * The event a record deposits. Its strings are normalized the way a publisher name is, since
 * deposited names carry character references and runs of whitespace; its dates are read the way
 * the publication date is. A string that normalizes to nothing is dropped. An event carrying none
 * of the subfields projected — only a `number`, `sponsor`, or `theme`, or only blank strings —
 * projects to nothing and is omitted, like one never deposited.
 */
export function projectEvent(raw: Pick<RawCrossrefWork, 'event'>): { event?: WorkEvent } {
  if (raw.event === undefined) return {};
  const name = normalizeNonEmptyText(raw.event.name);
  const acronym = normalizeNonEmptyText(raw.event.acronym);
  const location = normalizeNonEmptyText(raw.event.location);
  const start = parseDateParts(raw.event.start);
  const end = parseDateParts(raw.event.end);
  const event = {
    ...(name !== undefined && { name }),
    ...(acronym !== undefined && { acronym }),
    ...(location !== undefined && { location }),
    ...(start !== undefined && { start }),
    ...(end !== undefined && { end }),
  };
  return Object.keys(event).length > 0 ? { event } : {};
}

/**
 * The event on one Markdown line, read the way a citation gives it — name and acronym, place,
 * dates — or nothing when the record deposits none. An end with no start says so, rather than
 * passing for the day the event began.
 */
export function eventLine(w: { event?: WorkEvent | undefined }): string | undefined {
  if (w.event === undefined) return;
  const { name, acronym, location, start, end } = w.event;
  const head =
    name === undefined
      ? acronym && mdText(acronym)
      : acronym === undefined
        ? mdText(name)
        : `${mdText(name)} (${mdText(acronym)})`;
  const parts = [head, location && mdText(location), dateRange(start, end)];
  return `**Event:** ${parts.filter((part) => part).join(', ')}`;
}

function dateRange(start: DateParts | undefined, end: DateParts | undefined): string | undefined {
  if (start === undefined) return end && `until ${formatDateParts(end)}`;
  return end ? `${formatDateParts(start)} – ${formatDateParts(end)}` : formatDateParts(start);
}

/** The approval-date output field, spread into a work's output schema. */
export const approvedFields = {
  approved: DatePartsSchema.optional().describe(
    `Date the work was approved, as deposited — the only date most dissertations and standards carry, and one some reports carry beside their publication date. Never read into published, which stays absent on a record that deposits no publication date. ${PARTIAL_DATE} Omitted when the record deposits none.`,
  ),
};

/** The approval date a record deposits, read the way the publication date is. */
export function projectApproved(raw: Pick<RawCrossrefWork, 'approved'>): {
  approved?: DateParts;
} {
  const approved = parseDateParts(raw.approved);
  return approved !== undefined ? { approved } : {};
}

/** The approval date's Markdown line, or nothing when the record deposits none. */
export function approvedLine(w: { approved?: DateParts | undefined }): string | undefined {
  return w.approved && `**Approved:** ${formatDateParts(w.approved)}`;
}
