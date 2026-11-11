/**
 * @fileoverview The publication date every work-projecting tool resolves through —
 * `resolveWorkDate` for a full record and `resolveWorkSummaryDate` for a work summary — and the
 * date-parts reading and formatting every date field goes through (`parseDateParts`,
 * `formatDateParts`). Both resolvers take the record rather than a chain of its date fields, so
 * the one thing that could differ between call sites — when the chain falls through to the next
 * source — is settled here for all of them at once.
 * @module services/crossref/date-parts
 */

import type { CrossrefDateParts, RawCrossrefWork } from './types.js';

/** Format a year/month/day object as an ISO-style date string (e.g. "2023-04-15" or "2023"). */
export function formatDateParts(d: {
  year?: number | undefined;
  month?: number | undefined;
  day?: number | undefined;
}): string {
  const parts: string[] = [];
  if (d.year !== undefined) parts.push(String(d.year));
  if (d.month !== undefined) parts.push(String(d.month).padStart(2, '0'));
  if (d.day !== undefined) parts.push(String(d.day).padStart(2, '0'));
  return parts.join('-');
}

/**
 * Extract year/month/day from a Crossref date-parts array.
 *
 * A component Crossref does not know is deposited as `null` in the tuple rather than left off it:
 * a dissertation with no registered year arrives as `[[null]]`, and 8% of a random works draw
 * carries one somewhere in `issued`. Absent and null are the same fact for a caller — the
 * component is unknown — so both come back as an omitted field, which is what the output schemas
 * declare each of the three to be.
 *
 * The read stops at the first unknown component rather than skipping past it, because the tuple
 * is positional and the parts below one carry no meaning without it. `[[2020, null, 15]]` is a
 * year and a day-of-a-month nobody named, and rendering it through `formatDateParts` as `2020-15`
 * would state a date the deposit does not.
 */
export function parseDateParts(
  raw: { 'date-parts'?: Array<Array<number | null>> } | undefined,
): { year?: number; month?: number; day?: number } | undefined {
  const [year, month, day] = raw?.['date-parts']?.[0] ?? [];
  if (typeof year !== 'number') return;
  if (typeof month !== 'number') return { year };
  if (typeof day !== 'number') return { year, month };
  return { year, month, day };
}

/**
 * The date fields a work record answers "when was this published?" with, in preference order.
 *
 * `published` leads because it tracks the earliest of the two publication events, though Crossref
 * documents no definition for it; each event then answers for itself. `issued` is the one Crossref
 * does define that way, and it is the one of the four the API marks required — so a record with no
 * publication date at all carries its `[[null]]` placeholder there, with the other three absent.
 */
const WORK_DATE_SOURCES = [
  'published',
  'published-print',
  'published-online',
  'issued',
] as const satisfies ReadonlyArray<keyof RawCrossrefWork>;

/** What a work summary reads. `issued` is `crossref_get_work`'s last resort and no one else's. */
const WORK_SUMMARY_DATE_SOURCES = WORK_DATE_SOURCES.filter((source) => source !== 'issued');

/** The date-bearing part of a work record — every source in the chain, each of them optional. */
type WorkDateSources = Partial<Record<(typeof WORK_DATE_SOURCES)[number], CrossrefDateParts>>;

/**
 * Answer with the first source that names a date.
 *
 * The chain advances on **nothing, never on less**. A source Crossref deposits holding only
 * unknown components states no date — the same fact an absent field states, which is why
 * `parseDateParts` reports both as nothing — so it must not silence a later source that does
 * name one. Selecting the source *object* first and parsing once would do exactly that: it
 * reads presence as an answer, and hands back no publication date for a record that carries
 * one two fields along.
 *
 * It stops at the first date rather than continuing for a more precise one, because the sources
 * answer different questions: `published` tracks the earliest publication event and
 * `published-online` is one particular event, so a coarse `published` beside a precise
 * `published-online` is not a partial answer to be completed — refining across the two would
 * report the online date as the work's publication date. Sampled live, 580 of 6,000 randomly
 * drawn works carry a `published` coarser than a later source in this chain.
 */
function resolveDate(
  raw: WorkDateSources,
  sources: ReadonlyArray<(typeof WORK_DATE_SOURCES)[number]>,
): { year?: number; month?: number; day?: number } | undefined {
  for (const source of sources) {
    const date = parseDateParts(raw[source]);
    if (date !== undefined) return date;
  }
  return;
}

/**
 * The publication date of a full work record, `issued` included. Takes the whole record rather
 * than a chain of fields, so the order is settled here for every caller instead of being spelled
 * out — and re-spelled differently — at each one.
 */
export function resolveWorkDate(raw: WorkDateSources) {
  return resolveDate(raw, WORK_DATE_SOURCES);
}

/** The publication date of a work summary — the same rule over the three published-* sources. */
export function resolveWorkSummaryDate(raw: WorkDateSources) {
  return resolveDate(raw, WORK_SUMMARY_DATE_SOURCES);
}
