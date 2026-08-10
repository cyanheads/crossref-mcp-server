/**
 * @fileoverview crossref_get_member — resolves a Crossref member ID to its publisher metadata record.
 * @module mcp-server/tools/definitions/get-member.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { mdText } from '@/mcp-server/tools/markdown-text.js';
import { getCrossrefService, normalizeText } from '@/services/crossref/crossref-service.js';
import type { RawCrossrefMember } from '@/services/crossref/types.js';
import { UPSTREAM_ERROR_CONTRACT } from '@/services/crossref/upstream-errors.js';

const CountsSchema = z
  .object({
    totalDois: z
      .number()
      .optional()
      .describe('Total DOIs registered by this member (current + backfile)'),
    currentDois: z.number().optional().describe('DOIs registered in the current (recent) window'),
    backfileDois: z.number().optional().describe('DOIs registered in the backfile (older) window'),
  })
  .describe('Registered DOI counts');

const WorkTypeCountSchema = z
  .object({
    type: z
      .string()
      .describe('Crossref work type, e.g. "journal-article", "book-chapter", "posted-content"'),
    count: z.number().describe('Number of DOIs of this type registered by the member'),
  })
  .describe('DOI count for one work type');

const CoverageEntrySchema = z
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

export const getMemberTool = tool('crossref_get_member', {
  title: 'Get Member by ID',
  description:
    'Resolves a Crossref member ID to its publisher/organization record: primary name, alternate imprint names, owned DOI prefixes, registered DOI counts, a per-work-type breakdown, and per-category metadata deposit coverage. Members are the organizations that register DOIs with Crossref, so this answers "what does this publisher publish, and how completely do they deposit metadata?" Resolve a DOI prefix (e.g. "10.1038") to its member ID with crossref_get_prefix, then pass that ID here.',
  annotations: { readOnlyHint: true, idempotentHint: true },

  input: z.object({
    member_id: z
      .number()
      .int()
      .positive()
      .describe(
        'Crossref member ID — a positive integer, e.g. 297 (Springer) or 340 (PLOS). Resolve a DOI prefix to a member ID first with crossref_get_prefix.',
      ),
  }),

  output: z.object({
    id: z.number().describe('Crossref member ID'),
    primaryName: z.string().optional().describe('Primary publisher/organization name'),
    names: z
      .array(z.string())
      .optional()
      .describe('Alternate and imprint names registered under this member'),
    location: z.string().optional().describe('Publisher location (city, region, country)'),
    prefixes: z
      .array(z.string())
      .optional()
      .describe('DOI prefixes owned by this member, e.g. "10.1038"'),
    counts: CountsSchema.optional(),
    worksByType: z
      .array(WorkTypeCountSchema)
      .optional()
      .describe('DOI counts broken down by work type (all DOIs), sorted by count descending'),
    coverage: z
      .array(CoverageEntrySchema)
      .optional()
      .describe(
        'Per-category metadata deposit coverage — each a 0–1 fraction split into current (recent) and backfile (older) DOIs. Signals how completely this publisher deposits references, abstracts, ORCIDs, funders, licenses, and similar metadata.',
      ),
    deposits: z
      .boolean()
      .optional()
      .describe('Whether the member deposits any metadata with Crossref'),
    depositsArticles: z
      .boolean()
      .optional()
      .describe('Whether the member deposits journal-article metadata'),
  }),

  errors: [
    ...UPSTREAM_ERROR_CONTRACT,
    {
      reason: 'member_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No Crossref member exists for the given ID.',
      recovery:
        'Verify the member ID, or resolve a DOI prefix to its owning member ID with crossref_get_prefix first.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Resolving Crossref member', { memberId: input.member_id });
    const svc = getCrossrefService();
    const raw = await svc.getMember(input.member_id, ctx);
    if (!raw) {
      throw ctx.fail('member_not_found', `No Crossref member for ID: ${input.member_id}`, {
        memberId: input.member_id,
        ...ctx.recoveryFor('member_not_found'),
      });
    }
    return projectMember(raw, input.member_id);
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`## ${result.primaryName ? mdText(result.primaryName) : `Member ${result.id}`}`);
    lines.push(`**Member ID:** ${result.id}`);
    if (result.location) lines.push(`**Location:** ${mdText(result.location)}`);

    if (result.counts) {
      const c = result.counts;
      const parts: string[] = [];
      if (c.totalDois !== undefined) parts.push(`${c.totalDois} total`);
      if (c.currentDois !== undefined) parts.push(`${c.currentDois} current`);
      if (c.backfileDois !== undefined) parts.push(`${c.backfileDois} backfile`);
      if (parts.length) lines.push(`**DOIs:** ${parts.join(' · ')}`);
    }

    if (result.deposits !== undefined) {
      lines.push(`**Deposits metadata:** ${result.deposits ? 'Yes' : 'No'}`);
    }
    if (result.depositsArticles !== undefined) {
      lines.push(`**Deposits articles:** ${result.depositsArticles ? 'Yes' : 'No'}`);
    }

    if (result.prefixes?.length) lines.push(`**Prefixes:** ${result.prefixes.join(', ')}`);
    if (result.names?.length) lines.push(`**Other names:** ${result.names.map(mdText).join('; ')}`);

    if (result.worksByType?.length) {
      lines.push('');
      lines.push('**Works by type:**');
      for (const w of result.worksByType) {
        lines.push(`- ${w.type}: ${w.count}`);
      }
    }

    if (result.coverage?.length) {
      lines.push('');
      lines.push('**Metadata coverage (current / backfile):**');
      for (const c of result.coverage) {
        const cur = c.current !== undefined ? formatCoverage(c.current) : 'n/a';
        const back = c.backfile !== undefined ? formatCoverage(c.backfile) : 'n/a';
        lines.push(`- ${c.category}: ${cur} / ${back}`);
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});

// --- Helpers ---

/**
 * Render a 0–1 coverage fraction as a percentage, scaling precision to magnitude so a
 * small nonzero fraction never renders as a flat `0%`. Crossref coverage values run the
 * full range — a category can sit at 0.86 or at 0.0000138, and collapsing the latter to
 * zero would report "this publisher deposits none" when it deposits some.
 */
function formatCoverage(fraction: number): string {
  const pct = fraction * 100;
  if (pct === 0) return '0%';
  if (pct >= 10) return `${pct.toFixed(0)}%`;
  if (pct >= 1) return `${pct.toFixed(1)}%`;
  return `${pct.toPrecision(2)}%`;
}

/** Project the raw member record into the curated output shape. */
function projectMember(raw: RawCrossrefMember, requestedId: number) {
  /**
   * Normalize before the primary-name dedupe, not after. Crossref members carry the same
   * imprint name twice — once escaped, once not — so comparing raw strings passes the escaped
   * copy through as an "alternate" name that decodes to exactly the primary name.
   */
  const primaryName =
    raw['primary-name'] !== undefined ? normalizeText(raw['primary-name']) : undefined;
  const names = [...new Set((raw.names ?? []).filter(Boolean).map(normalizeText))].filter(
    (n) => n !== primaryName,
  );
  const prefixes = raw.prefixes ?? [];

  const counts = raw.counts
    ? {
        ...(raw.counts['total-dois'] !== undefined && { totalDois: raw.counts['total-dois'] }),
        ...(raw.counts['current-dois'] !== undefined && {
          currentDois: raw.counts['current-dois'],
        }),
        ...(raw.counts['backfile-dois'] !== undefined && {
          backfileDois: raw.counts['backfile-dois'],
        }),
      }
    : undefined;

  const worksByType = normalizeWorksByType(raw['counts-type']?.all);
  const coverage = normalizeCoverage(raw.coverage);

  return {
    id: raw.id ?? requestedId,
    ...(primaryName !== undefined && { primaryName }),
    ...(names.length > 0 && { names }),
    ...(raw.location !== undefined && { location: normalizeText(raw.location) }),
    ...(prefixes.length > 0 && { prefixes }),
    ...(counts && Object.keys(counts).length > 0 && { counts }),
    ...(worksByType && worksByType.length > 0 && { worksByType }),
    ...(coverage && coverage.length > 0 && { coverage }),
    ...(raw.flags?.deposits !== undefined && { deposits: raw.flags.deposits }),
    ...(raw.flags?.['deposits-articles'] !== undefined && {
      depositsArticles: raw.flags['deposits-articles'],
    }),
  };
}

/** Turn the `counts-type.all` map into a work-type/count list, dropping zeros, sorted by count. */
function normalizeWorksByType(all?: Record<string, number>) {
  if (!all) return;
  return Object.entries(all)
    .filter(([, count]) => count > 0)
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Collapse the flat `coverage` map (`<category>-current` / `<category>-backfile` → fraction)
 * into per-category `{ current, backfile }` entries, sorted by category name.
 */
function normalizeCoverage(coverage?: Record<string, number>) {
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
