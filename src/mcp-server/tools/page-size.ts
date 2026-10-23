/**
 * @fileoverview Page-size inputs above their per-call cap are clamped, not rejected. Every capped
 * page already carries a continuation, so an oversized value has one reading: the largest page
 * allowed. The schema keeps a much higher hard ceiling against absurd input, and each handler
 * clamps once, at its head, so every guard, request, slice, and continuation below it reads the
 * value the page is actually built from.
 * @module mcp-server/tools/page-size
 */

/** Per-call cap on `rows` for the three search tools. */
export const ROWS_CAP = 100;
/** Schema ceiling on `rows` — Crossref's own `rows` maximum. */
export const ROWS_CEILING = 1000;
/** Per-call cap on the entry-list page sizes: `authorLimit`, and `limit` on get_work / get_references. */
export const ENTRY_LIMIT_CAP = 500;
/** Schema ceiling on the entry-list page sizes. */
export const ENTRY_LIMIT_CEILING = 100_000;

/** A page-size input after the per-call cap is applied. */
export interface ClampedPageSize {
  /** Disclosure naming the requested value and the cap. Present only when the cap cut the request. */
  notice?: string;
  /** The page size every downstream read uses. */
  value: number;
}

/** Clamp `requested` to `cap`, naming the input in the disclosure when the cap applies. */
export function clampPageSize(name: string, requested: number, cap: number): ClampedPageSize {
  if (requested <= cap) return { value: requested };
  return {
    value: cap,
    notice: `${name} ${requested} is above the per-call cap of ${cap}, so ${cap} was applied.`,
  };
}
