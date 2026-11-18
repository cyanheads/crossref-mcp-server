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
  SEARCH_WORKS_AUTHOR_LIMIT_CAP,
  SEARCH_WORKS_OPT_IN_ROWS_CAP,
  SEARCH_WORKS_ROWS_CAP,
} from '@/mcp-server/tools/page-size.js';

/**
 * Each cap is sized on one caller surface — `structuredContent`, the heavier on every page
 * measured — at Crossref's page maximum where the heaviest page measured there stays near 1 MB,
 * otherwise at the largest round size where it does. An input with no cap below its schema
 * ceiling has no constant here.
 */
describe('page-size caps and ceilings', () => {
  it.each([
    ['crossref_search_works rows with abstract or author selected', SEARCH_WORKS_ROWS_CAP, 500],
    [
      'crossref_search_works rows with funder, license, or link selected',
      SEARCH_WORKS_OPT_IN_ROWS_CAP,
      200,
    ],
    ['crossref_search_works authorLimit', SEARCH_WORKS_AUTHOR_LIMIT_CAP, 500],
    ['crossref_get_work limit', GET_WORK_LIMIT_CAP, 10_000],
    ['crossref_get_references limit', GET_REFERENCES_LIMIT_CAP, 4000],
    ['the rows schema ceiling', ROWS_CEILING, 1000],
    ['the entry-list schema ceiling', ENTRY_LIMIT_CEILING, 100_000],
  ])('%s is %d', (_label, actual, expected) => {
    expect(actual).toBe(expected);
  });
});

describe('clampPageSize', () => {
  it.each([
    ['below the cap', 1, 500],
    ['one under the cap', 499, 500],
    ['at the cap', 500, 500],
    ['at the largest cap', 10_000, 10_000],
  ])('passes a value %s through with no notice', (_label, requested, cap) => {
    expect(clampPageSize('rows', requested, cap)).toEqual({ value: requested });
  });

  it.each([
    ['rows', 501, 500],
    ['rows', 1000, 500],
    ['limit', 4001, 4000],
    ['limit', 100_000, 4000],
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
 * The six page-size inputs: tool, input, the smallest value the schema takes, the per-call caps
 * its description states (the first is the one that applies by default), the schema ceiling, and
 * the unchanged default. `crossref_search_works` `rows` takes up to 200 when `fields` names
 * funder, license, or link, every value up to the ceiling when it names none of those nor abstract
 * or author, and 0 for a count-only page.
 * `crossref_search_journals` and `crossref_search_funders` `rows` cap at Crossref's own page
 * maximum, which is also their schema ceiling, so no value either accepts is clamped.
 */
const PAGE_SIZE_INPUTS = [
  {
    tool: 'crossref_search_works',
    field: 'rows',
    floor: 0,
    caps: [500, 200, 1000],
    ceiling: 1000,
    fallback: 20,
  },
  {
    tool: 'crossref_search_journals',
    field: 'rows',
    floor: 1,
    caps: [1000],
    ceiling: 1000,
    fallback: 10,
  },
  {
    tool: 'crossref_search_funders',
    field: 'rows',
    floor: 1,
    caps: [1000],
    ceiling: 1000,
    fallback: 10,
  },
  {
    tool: 'crossref_search_works',
    field: 'authorLimit',
    floor: 1,
    caps: [500],
    ceiling: 100_000,
    fallback: 25,
  },
  {
    tool: 'crossref_get_work',
    field: 'limit',
    floor: 1,
    caps: [10_000],
    ceiling: 100_000,
    fallback: 25,
  },
  {
    tool: 'crossref_get_references',
    field: 'limit',
    floor: 1,
    caps: [4000],
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
  const { tool, field, floor, caps, ceiling, fallback } = input;
  const [cap, ...otherCaps] = caps;
  const definition = definitionOf(tool);

  it(`states its per-call caps of ${caps.join(' and ')} in its description`, () => {
    const schema = z.toJSONSchema(definition.input, { io: 'input' }) as {
      properties: Record<string, { description?: string }>;
    };
    const description = schema.properties[field]?.description ?? '';
    for (const each of caps) expect(description).toContain(`${floor}–${each}`);
    // Only an input whose default cap sits below its ceiling has a clamp to disclose.
    if (cap < ceiling) {
      // The ceiling is named — as the most accepted, or as the range a lighter selection takes.
      if (!otherCaps.some((other) => other === ceiling)) {
        expect(description).toContain(`up to ${ceiling}`);
      }
      expect(description).toContain(`${cap} and says so in notice`);
    } else {
      expect(description).not.toContain('notice');
    }
  });

  it(`advertises an integer from ${floor} to ${ceiling} with its default unchanged`, () => {
    const schema = z.toJSONSchema(definition.input, { io: 'input' }) as {
      properties: Record<string, Record<string, unknown>>;
      required?: string[];
    };
    expect(schema.properties[field]).toMatchObject({
      type: 'integer',
      minimum: floor,
      maximum: ceiling,
      default: fallback,
    });
    expect(schema.required ?? []).not.toContain(field);
  });

  it.each([floor - 1, -5, 2.5, ceiling + 1])(`refuses ${field} %s`, (value) => {
    expect(definition.input.safeParse({ ...REQUIRED[tool], [field]: value }).success).toBe(false);
  });

  it(`accepts ${field} at the ceiling, leaving the cap to the handler`, () => {
    const parsed = definition.input.safeParse({ ...REQUIRED[tool], [field]: ceiling });
    expect(parsed.success).toBe(true);
    expect((parsed.data as Record<string, unknown>)[field]).toBe(ceiling);
  });
});
