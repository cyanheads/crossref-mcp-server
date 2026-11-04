/**
 * @fileoverview Page-size inputs above their per-call cap are clamped, not rejected. Every capped
 * page already carries a continuation, so an oversized value has one reading: the largest page
 * allowed. The schema keeps a much higher hard ceiling against absurd input, and each handler
 * clamps once, at its head, so every guard, request, slice, and continuation below it reads the
 * value the page is actually built from.
 *
 * Each input has its own cap: Crossref's page maximum (1000 rows, or the whole deposited list),
 * lowered only where the heaviest page measured at that size runs to megabytes of caller output
 * (`structuredContent` plus `content[]` text), to the largest round size whose heaviest page stays
 * under one. `rows` on crossref_search_funders needs no cap of its own: a 1000-row page of funders
 * or of funded works measures under half a megabyte, so it is bounded by `ROWS_CEILING` alone.
 * @module mcp-server/tools/page-size
 */

/** Schema ceiling on `rows` — Crossref's own `rows` maximum. */
export const ROWS_CEILING = 1000;
/** Schema ceiling on the entry-list page sizes. */
export const ENTRY_LIMIT_CEILING = 100_000;

/** Cap on crossref_search_works `rows`: 250 abstract-bearing works, default fields, measure ~1 MB. */
export const SEARCH_WORKS_ROWS_CAP = 250;
/** Cap on crossref_search_journals `rows`: 500 journals with their coverage measure ~0.9 MB. */
export const SEARCH_JOURNALS_ROWS_CAP = 500;
/** Cap on crossref_search_works `authorLimit`, per work: ten whole consortium lists pass 1 MB. */
export const SEARCH_WORKS_AUTHOR_LIMIT_CAP = 500;
/** Cap on crossref_get_work `limit`: the longest author list sampled (5,156) is ~0.5 MB whole. */
export const GET_WORK_LIMIT_CAP = 10_000;
/** Cap on crossref_get_references `limit`: 2,500 references measure ~1 MB, 25,814 run to 10 MB. */
export const GET_REFERENCES_LIMIT_CAP = 2500;

/** A page-size input after the per-call cap is applied. */
export interface ClampedPageSize {
  /** Disclosure naming the requested value and the cap. Present only when the cap cut the request. */
  notice?: string;
  /** The page size every downstream read uses. */
  value: number;
}

/**
 * A list's page inside its route's offset window: the rows that fit below `ceiling` at `offset`
 * (which the caller has checked is below it), and when that cut the page, the sentence saying so
 * without its closing punctuation. `limit` completes "would pass the …" in that sentence. The
 * per-call cap folds into it when it also cut the request, so the rows requested and the rows
 * applied are each named once.
 */
export function fitWindow(
  offsetName: 'offset' | 'works_offset',
  offset: number,
  ceiling: number,
  limit: string,
  requested: number,
  capped: ClampedPageSize,
): { rows: number; cut?: string } {
  const rows = Math.min(capped.value, ceiling - offset);
  if (rows === capped.value) return { rows };
  const over = capped.notice
    ? `rows ${requested} is above the per-call cap of ${capped.value}, and ${offsetName} ${offset} + ${capped.value}`
    : `${offsetName} ${offset} + rows ${requested}`;
  return { rows, cut: `${over} would pass the ${limit}, so ${rows} was applied` };
}

/** Clamp `requested` to `cap`, naming the input in the disclosure when the cap applies. */
export function clampPageSize(name: string, requested: number, cap: number): ClampedPageSize {
  if (requested <= cap) return { value: requested };
  return {
    value: cap,
    notice: `${name} ${requested} is above the per-call cap of ${cap}, so ${cap} was applied.`,
  };
}
