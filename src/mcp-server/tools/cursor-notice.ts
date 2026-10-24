/**
 * @fileoverview Advisory plausibility check for successful Crossref cursor responses.
 * @module mcp-server/tools/cursor-notice
 */

/** A warning only: opaque tokens always reach Crossref through the existing request path. */
export function cursorNotice(cursor: string | undefined): string | undefined {
  if (cursor === undefined || cursor === '*') return;
  try {
    const decoded = atob(cursor);
    const comma = decoded.indexOf(',');
    if (
      comma > 0 &&
      decoded.slice(0, comma).trim() &&
      /^10\.\d{4,9}\/\S+$/i.test(decodeURIComponent(decoded.slice(comma + 1)))
    )
      return;
  } catch (error) {
    if (
      !(error instanceof URIError) &&
      !(error instanceof DOMException && error.name === 'InvalidCharacterError')
    )
      throw error;
  }
  return 'The supplied cursor does not resemble a Crossref continuation token. Crossref may have restarted the walk at the first page; compare these records with the previous page and continue with the returned token, or restart explicitly with "*".';
}
