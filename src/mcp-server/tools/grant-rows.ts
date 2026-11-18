/**
 * @fileoverview Notice for a works-list page carrying a grant row with no title.
 * @module mcp-server/tools/grant-rows
 */

/**
 * A grant deposits no `title`: its project titles, award, and investigators sit under `project`
 * and `award`, which Crossref's `select` refuses on every works-list route, so a grant row on a
 * works list can carry neither. The notice names the one call that returns them; nothing infers a
 * title for the row.
 */
export const GRANT_TITLE_NOTICE =
  'A grant record on this page has no title: Crossref keeps a grant’s project titles, award, and investigators in fields a works list cannot select. crossref_get_work with the grant’s DOI returns them.';

/** True when a row of type `grant` lacks a title. Callers apply it only where `title` was requested. */
export function hasUntitledGrant(
  rows: readonly { type?: string | undefined; title?: string | undefined }[],
): boolean {
  return rows.some((row) => row.type === 'grant' && !row.title);
}
