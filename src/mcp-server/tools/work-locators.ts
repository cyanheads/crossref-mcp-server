/**
 * @fileoverview The citation locators a work record deposits — volume, issue, page range, and
 * article number — as one set of output fields, one projection, and one Markdown line. Both
 * crossref_get_work and crossref_search_works return them, and sharing the three pieces is what
 * keeps the two tools naming, describing, and rendering a locator identically.
 * @module mcp-server/tools/work-locators
 */

import { z } from '@cyanheads/mcp-ts-core';
import { mdText } from '@/mcp-server/tools/markdown-text.js';
import type { RawCrossrefWork } from '@/services/crossref/types.js';

/** The locator output fields, spread into a work's output schema. */
export const locatorFields = {
  volume: z.string().optional().describe('Volume of the container the work appears in'),
  issue: z.string().optional().describe('Issue of the container the work appears in'),
  page: z.string().optional().describe('Page range as deposited, e.g. "357-362"'),
  articleNumber: z
    .string()
    .optional()
    .describe('Article number, deposited by journals that number articles instead of paging them'),
};

type Locators = {
  volume?: string | undefined;
  issue?: string | undefined;
  page?: string | undefined;
  articleNumber?: string | undefined;
};

/**
 * Each locator the record deposits, as deposited. A page and an article number are relayed
 * independently: some publishers deposit the same value in both, and neither is derived from
 * the other.
 */
export function projectLocators(
  raw: Pick<RawCrossrefWork, 'volume' | 'issue' | 'page' | 'article-number'>,
): Locators {
  return {
    ...(raw.volume !== undefined && { volume: raw.volume }),
    ...(raw.issue !== undefined && { issue: raw.issue }),
    ...(raw.page !== undefined && { page: raw.page }),
    ...(raw['article-number'] !== undefined && { articleNumber: raw['article-number'] }),
  };
}

/**
 * The locators on one Markdown line, in citation order, or nothing when the record deposits
 * none. A locator is a string the publisher typed rather than a registry identifier — `N° 3`,
 * `4_Supplement`, `157-158` — so it takes the same escape as the rest of the deposited text.
 */
export function locatorLine(w: Locators): string | undefined {
  const parts = [
    w.volume !== undefined && `**Volume:** ${mdText(w.volume)}`,
    w.issue !== undefined && `**Issue:** ${mdText(w.issue)}`,
    w.page !== undefined && `**Pages:** ${mdText(w.page)}`,
    w.articleNumber !== undefined && `**Article number:** ${mdText(w.articleNumber)}`,
  ].filter((part) => part !== false);
  return parts.length > 0 ? parts.join(' | ') : undefined;
}
