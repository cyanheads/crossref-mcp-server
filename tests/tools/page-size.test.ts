/**
 * @fileoverview The page-size clamp: a value above its per-call cap is cut to the cap with a
 * disclosure, and everything at or under the cap passes through untouched. The schema side of
 * the same contract — every page-size input advertises its hard ceiling and still refuses what
 * lies outside it — is tabled here once across all six inputs; each tool's own test file proves
 * only that its handler reads the clamped value.
 * @module tests/tools/page-size.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import { clampPageSize } from '@/mcp-server/tools/page-size.js';

describe('clampPageSize', () => {
  it.each([
    ['below the cap', 1, 100],
    ['one under the cap', 99, 100],
    ['at the cap', 100, 100],
    ['at the entry cap', 500, 500],
  ])('passes a value %s through with no notice', (_label, requested, cap) => {
    expect(clampPageSize('rows', requested, cap)).toEqual({ value: requested });
  });

  it.each([
    ['rows', 101, 100],
    ['rows', 250, 100],
    ['rows', 1000, 100],
    ['limit', 501, 500],
    ['authorLimit', 100_000, 500],
  ])('cuts %s %d to the cap of %d and names both values', (name, requested, cap) => {
    expect(clampPageSize(name, requested, cap)).toEqual({
      value: cap,
      notice: `${name} ${requested} is above the per-call cap of ${cap}, so ${cap} was applied.`,
    });
  });
});

/** The six page-size inputs: tool, input, the schema ceiling, and the unchanged default. */
const PAGE_SIZE_INPUTS = [
  { tool: 'crossref_search_works', field: 'rows', ceiling: 1000, fallback: 20 },
  { tool: 'crossref_search_journals', field: 'rows', ceiling: 1000, fallback: 10 },
  { tool: 'crossref_search_funders', field: 'rows', ceiling: 1000, fallback: 10 },
  { tool: 'crossref_search_works', field: 'authorLimit', ceiling: 100_000, fallback: 25 },
  { tool: 'crossref_get_work', field: 'limit', ceiling: 100_000, fallback: 25 },
  { tool: 'crossref_get_references', field: 'limit', ceiling: 100_000, fallback: 100 },
] as const;

const REQUIRED: Record<string, Record<string, unknown>> = {
  crossref_search_works: { query: 'CRISPR' },
  crossref_search_journals: { query: 'Nature' },
  crossref_search_funders: { query: 'National Science Foundation' },
  crossref_get_work: { doi: '10.1038/nature12373' },
  crossref_get_references: { doi: '10.1038/nature12373' },
};

function definitionOf(name: string) {
  const definition = allToolDefinitions.find((d) => d.name === name);
  if (!definition) throw new Error(`${name} is not registered`);
  return definition;
}

describe.each(PAGE_SIZE_INPUTS)('$tool $field schema', ({ tool, field, ceiling, fallback }) => {
  const definition = definitionOf(tool);

  it(`advertises an integer from 1 to ${ceiling} with its default unchanged`, () => {
    const schema = z.toJSONSchema(definition.input, { io: 'input' }) as {
      properties: Record<string, Record<string, unknown>>;
      required?: string[];
    };
    expect(schema.properties[field]).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: ceiling,
      default: fallback,
    });
    expect(schema.required ?? []).not.toContain(field);
  });

  it.each([0, -5, 2.5, ceiling + 1])(`refuses ${field} %s`, (value) => {
    expect(definition.input.safeParse({ ...REQUIRED[tool], [field]: value }).success).toBe(false);
  });

  it(`accepts ${field} at the ceiling, leaving the cap to the handler`, () => {
    const parsed = definition.input.safeParse({ ...REQUIRED[tool], [field]: ceiling });
    expect(parsed.success).toBe(true);
    expect((parsed.data as Record<string, unknown>)[field]).toBe(ceiling);
  });
});
