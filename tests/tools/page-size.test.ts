/**
 * @fileoverview The page-size clamp: a value above its per-call cap is cut to the cap with a
 * disclosure, and everything at or under the cap passes through untouched. Each input's cap is
 * pinned here, and the schema side of the same contract — every page-size input states its cap,
 * advertises its hard ceiling, and still refuses what lies outside the ceiling — is tabled here
 * once across all six inputs; each tool's own test file proves only that its handler reads the
 * clamped value.
 * @module tests/tools/page-size.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import {
  clampPageSize,
  ENTRY_LIMIT_CEILING,
  GET_REFERENCES_LIMIT_CAP,
  GET_WORK_LIMIT_CAP,
  ROWS_CEILING,
  SEARCH_JOURNALS_ROWS_CAP,
  SEARCH_WORKS_AUTHOR_LIMIT_CAP,
  SEARCH_WORKS_LIGHT_ROWS_CAP,
  SEARCH_WORKS_ROWS_CAP,
} from '@/mcp-server/tools/page-size.js';

describe('page-size caps and ceilings', () => {
  it.each([
    ['crossref_search_works rows', SEARCH_WORKS_ROWS_CAP, 250],
    [
      'crossref_search_works rows naming neither abstract nor author',
      SEARCH_WORKS_LIGHT_ROWS_CAP,
      600,
    ],
    ['crossref_search_journals rows on a title query', SEARCH_JOURNALS_ROWS_CAP, 500],
    ['crossref_search_works authorLimit', SEARCH_WORKS_AUTHOR_LIMIT_CAP, 500],
    ['crossref_get_work limit', GET_WORK_LIMIT_CAP, 10_000],
    ['crossref_get_references limit', GET_REFERENCES_LIMIT_CAP, 2500],
    ['the rows schema ceiling', ROWS_CEILING, 1000],
    ['the entry-list schema ceiling', ENTRY_LIMIT_CEILING, 100_000],
  ])('%s is %d', (_label, actual, expected) => {
    expect(actual).toBe(expected);
  });
});

describe('clampPageSize', () => {
  it.each([
    ['below the cap', 1, 250],
    ['one under the cap', 249, 250],
    ['at the cap', 250, 250],
    ['at the largest cap', 10_000, 10_000],
  ])('passes a value %s through with no notice', (_label, requested, cap) => {
    expect(clampPageSize('rows', requested, cap)).toEqual({ value: requested });
  });

  it.each([
    ['rows', 251, 250],
    ['rows', 1000, 500],
    ['limit', 2501, 2500],
    ['limit', 100_000, 10_000],
    ['authorLimit', 100_000, 500],
  ])('cuts %s %d to the cap of %d and names both values', (name, requested, cap) => {
    expect(clampPageSize(name, requested, cap)).toEqual({
      value: cap,
      notice: `${name} ${requested} is above the per-call cap of ${cap}, so ${cap} was applied.`,
    });
  });
});

/**
 * The six page-size inputs: tool, input, the per-call caps its description states (the first is
 * the one that applies by default), the schema ceiling, and the unchanged default.
 * `crossref_search_works` `rows` takes a higher cap when `fields` names neither abstract nor
 * author; `crossref_search_journals` `rows` caps the title-query journal list alone, its works
 * list taking every value up to the ceiling. `crossref_search_funders` `rows` caps at Crossref's
 * own page maximum, which is also its schema ceiling, so no value it accepts is clamped.
 */
const PAGE_SIZE_INPUTS = [
  { tool: 'crossref_search_works', field: 'rows', caps: [250, 600], ceiling: 1000, fallback: 20 },
  {
    tool: 'crossref_search_journals',
    field: 'rows',
    caps: [500, 1000],
    ceiling: 1000,
    fallback: 10,
  },
  { tool: 'crossref_search_funders', field: 'rows', caps: [1000], ceiling: 1000, fallback: 10 },
  {
    tool: 'crossref_search_works',
    field: 'authorLimit',
    caps: [500],
    ceiling: 100_000,
    fallback: 25,
  },
  { tool: 'crossref_get_work', field: 'limit', caps: [10_000], ceiling: 100_000, fallback: 25 },
  {
    tool: 'crossref_get_references',
    field: 'limit',
    caps: [2500],
    ceiling: 100_000,
    fallback: 100,
  },
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

describe.each(PAGE_SIZE_INPUTS)('$tool $field schema', (input) => {
  const { tool, field, caps, ceiling, fallback } = input;
  const [cap, ...otherCaps] = caps;
  const definition = definitionOf(tool);

  it(`states its per-call caps of ${caps.join(' and ')} in its description`, () => {
    const schema = z.toJSONSchema(definition.input, { io: 'input' }) as {
      properties: Record<string, { description?: string }>;
    };
    const description = schema.properties[field]?.description ?? '';
    expect(description).toContain(`(1–${cap}`);
    for (const other of otherCaps) expect(description).toContain(`1–${other}`);
    // Only an input whose cap sits below its ceiling has a clamp to disclose.
    if (cap < ceiling) {
      expect(description).toContain(`up to ${ceiling}`);
      // A single cap is named as the value returned; two are each named as a range above.
      expect(description).toContain(
        otherCaps.length === 0 ? `${cap} and says so in notice` : 'says so in notice',
      );
    } else {
      expect(description).not.toContain('notice');
    }
  });

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
