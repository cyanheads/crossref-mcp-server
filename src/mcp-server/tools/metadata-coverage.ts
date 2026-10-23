/**
 * @fileoverview Per-category metadata deposit coverage, shared by the member and journal tools so
 * both project and render Crossref's `coverage` map the same way. Member and journal records carry
 * the same flat `<category>-current` / `<category>-backfile` → 0–1 fraction shape.
 * @module mcp-server/tools/metadata-coverage
 */

import { z } from '@cyanheads/mcp-ts-core';

export const CoverageEntrySchema = z
  .object({
    category: z
      .string()
      .describe(
        'Metadata deposit category, e.g. "references", "abstracts", "orcids", "funders", "licenses", "affiliations"',
      ),
    current: z.number().optional().describe('Coverage fraction (0–1) among current (recent) DOIs'),
    backfile: z.number().optional().describe('Coverage fraction (0–1) among backfile (older) DOIs'),
  })
  .describe('Metadata deposit coverage for one category');

export type CoverageEntry = z.infer<typeof CoverageEntrySchema>;

/**
 * Collapse the flat `coverage` map (`<category>-current` / `<category>-backfile` → fraction)
 * into per-category `{ current, backfile }` entries, sorted by category name. Keys without either
 * suffix are skipped.
 */
export function normalizeCoverage(coverage?: Record<string, number>): CoverageEntry[] | undefined {
  if (!coverage) return;
  const byCategory = new Map<string, { current?: number; backfile?: number }>();
  for (const [key, value] of Object.entries(coverage)) {
    let category: string;
    let bucket: 'current' | 'backfile';
    if (key.endsWith('-current')) {
      category = key.slice(0, -'-current'.length);
      bucket = 'current';
    } else if (key.endsWith('-backfile')) {
      category = key.slice(0, -'-backfile'.length);
      bucket = 'backfile';
    } else {
      continue;
    }
    const entry = byCategory.get(category) ?? {};
    entry[bucket] = value;
    byCategory.set(category, entry);
  }
  return [...byCategory.entries()]
    .map(([category, v]) => ({
      category,
      ...(v.current !== undefined && { current: v.current }),
      ...(v.backfile !== undefined && { backfile: v.backfile }),
    }))
    .sort((a, b) => a.category.localeCompare(b.category));
}

/**
 * Render a 0–1 coverage fraction as a percentage, scaling precision to magnitude so a
 * small nonzero fraction never renders as a flat `0%`. Crossref coverage values run the
 * full range — a category can sit at 0.86 or at 0.0000138, and collapsing the latter to
 * zero would report "this publisher deposits none" when it deposits some.
 */
export function formatCoverage(fraction: number): string {
  const pct = fraction * 100;
  if (pct === 0) return '0%';
  if (pct >= 10) return `${pct.toFixed(0)}%`;
  if (pct >= 1) return `${pct.toFixed(1)}%`;
  return `${pct.toPrecision(2)}%`;
}

/** Markdown lines for a coverage list: a heading line, then one `- category: current / backfile` per entry. */
export function coverageLines(coverage: CoverageEntry[]): string[] {
  return [
    '**Metadata coverage (current / backfile):**',
    ...coverage.map((c) => {
      const cur = c.current !== undefined ? formatCoverage(c.current) : 'n/a';
      const back = c.backfile !== undefined ? formatCoverage(c.backfile) : 'n/a';
      return `- ${c.category}: ${cur} / ${back}`;
    }),
  ];
}
