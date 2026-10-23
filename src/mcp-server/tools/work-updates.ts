/**
 * @fileoverview The post-publication update links a work record carries — `updated-by` (the
 * notices issued against it) and `update-to` (the works it is itself a notice for) — as one pair
 * of output fields, one projection, and one Markdown list per field. Both crossref_get_work and
 * crossref_search_works return them, and sharing the pieces is what keeps the two tools naming,
 * describing, and rendering an update entry identically.
 * @module mcp-server/tools/work-updates
 */

import { z } from '@cyanheads/mcp-ts-core';
import { mdText } from '@/mcp-server/tools/markdown-text.js';
import { formatDateParts, parseDateParts } from '@/services/crossref/crossref-service.js';
import type { CrossrefUpdate, RawCrossrefWork } from '@/services/crossref/types.js';

const UpdateSchema = z
  .object({
    doi: z
      .string()
      .describe(
        "DOI on the other side of the link: the notice, in updatedBy; the updated work, in updateTo. It is this work's own DOI when the update was made to this record in place.",
      ),
    type: z
      .string()
      .describe(
        'Crossref update type as deposited: correction, erratum, corrigendum, addendum, retraction, withdrawal, expression_of_concern, new_version, new_edition, or another code',
      ),
    source: z
      .string()
      .describe(
        'Who recorded the link: publisher, or retraction-watch for an entry Crossref carries from the Retraction Watch database',
      ),
    recordId: z
      .string()
      .optional()
      .describe('Retraction Watch record ID. Present only on retraction-watch entries.'),
    updated: z
      .object({
        year: z.number().optional().describe('Year'),
        month: z.number().optional().describe('Month (1–12)'),
        day: z.number().optional().describe('Day of month'),
      })
      .optional()
      .describe('Date the update was issued'),
  })
  .describe('Update link');

/** One update link as both tools return it. */
export type Update = z.infer<typeof UpdateSchema>;

/** The update output fields, spread into a work's output schema. */
export const updateFields = {
  updatedBy: z
    .array(UpdateSchema)
    .optional()
    .describe(
      'Update notices Crossref records against this work — corrections, errata, retractions, expressions of concern, withdrawals, new versions — in deposited order. Entries are never merged: the same notice DOI can appear once per source, typed differently by each. Omitted when none is recorded, which does not mean the work was never updated: coverage depends on publisher and Retraction Watch deposits.',
    ),
  updateTo: z
    .array(UpdateSchema)
    .optional()
    .describe(
      'Works this record is an update notice for, in the entry shape updatedBy uses and in deposited order. Omitted when the record is not registered as a notice.',
    ),
};

/**
 * Project one update link. `label` is dropped: it restates `type` in title case on every entry
 * Crossref deposits. The Retraction Watch record ID rides along where Crossref carries one.
 */
function normalizeUpdate(u: CrossrefUpdate): Update {
  const updated = parseDateParts(u.updated);
  return {
    doi: u.DOI,
    type: u.type,
    source: u.source,
    ...(u['record-id'] !== undefined && { recordId: u['record-id'] }),
    ...(updated !== undefined && { updated }),
  };
}

/**
 * Each update list the record deposits, every entry in deposited order. A list deposited as `[]`
 * is no update at all and is omitted, like one never deposited.
 */
export function projectUpdates(raw: Pick<RawCrossrefWork, 'updated-by' | 'update-to'>): {
  updatedBy?: Update[];
  updateTo?: Update[];
} {
  return {
    ...(raw['updated-by']?.length && { updatedBy: raw['updated-by'].map(normalizeUpdate) }),
    ...(raw['update-to']?.length && { updateTo: raw['update-to'].map(normalizeUpdate) }),
  };
}

/** An update link's line: the DOI a reader copies first, then what kind of update and whose. */
function updateLine(u: Update): string {
  const record = u.recordId !== undefined ? `, record ${u.recordId}` : '';
  const date = u.updated ? `, ${formatDateParts(u.updated)}` : '';
  return `- ${u.doi} — ${mdText(u.type)} (${mdText(u.source)}${record})${date}`;
}

/** The labelled Markdown list for each update field the work carries, `updatedBy` first. */
export function updateSections(w: {
  updatedBy?: Update[] | undefined;
  updateTo?: Update[] | undefined;
}): string[][] {
  return [
    w.updatedBy && ['**Updated by:**', ...w.updatedBy.map(updateLine)],
    w.updateTo && ['**Update notice for:**', ...w.updateTo.map(updateLine)],
  ].filter((section) => section !== undefined);
}
