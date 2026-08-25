/**
 * @fileoverview The argument contract every tool advertises, and what happens to an argument
 * it never declared. Both are framework behavior rather than anything this server writes, and
 * both are wire-visible: `tools/list` publishes the schema a client validates against, and an
 * undeclared key is refused by name instead of being silently dropped on the way to the handler.
 * A tool that ever needs an open argument set opts out explicitly, and this file is what fails
 * when one is opened by accident.
 * @module tests/tools/input-strictness.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import { blockText } from '../helpers/content.js';

/** The advertised bytes: what a client reads out of `tools/list` for one tool. */
function advertisedInputSchema(definition: (typeof allToolDefinitions)[number]) {
  return z.toJSONSchema(definition.input, { io: 'input' }) as {
    $schema?: string;
    type?: string;
    additionalProperties?: boolean;
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

/** A key no tool declares, distinctive enough to find in whichever surface reports it. */
const UNDECLARED_KEY = 'crossrefUndeclaredProbe';

/**
 * One set of arguments per tool that satisfies its required fields, so the only thing left
 * to fail on is the probe key. A tool whose required set grows fails here, loudly, rather
 * than passing on an input error it was never meant to raise.
 */
const VALID_INPUT: Record<string, Record<string, unknown>> = {
  crossref_get_work: { doi: '10.1038/nature12373' },
  crossref_get_references: { doi: '10.1038/nature12373' },
  crossref_get_member: { member_id: 297 },
  crossref_get_prefix: { prefix: '10.1038' },
  crossref_search_works: { query: 'CRISPR' },
  crossref_search_journals: { query: 'Nature' },
  crossref_search_funders: { query: 'National Science Foundation' },
};

describe('the argument contract every tool advertises', () => {
  it('covers every registered tool, so a new one cannot skip this file', () => {
    expect(Object.keys(VALID_INPUT).sort()).toEqual(allToolDefinitions.map((d) => d.name).sort());
  });

  for (const definition of allToolDefinitions) {
    it(`${definition.name} advertises a closed 2020-12 object`, () => {
      const schema = advertisedInputSchema(definition);

      expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
      expect(schema.type).toBe('object');
      // The half a client acts on: any key outside `properties` is not accepted.
      expect(schema.additionalProperties).toBe(false);
      expect(Object.keys(schema.properties ?? {}).length).toBeGreaterThan(0);
    });

    it(`${definition.name} refuses an undeclared argument on both surfaces`, async () => {
      const result = await runToolContract(definition, {
        ...VALID_INPUT[definition.name],
        [UNDECLARED_KEY]: 'ignored',
      } as never);

      expect(result.isError).toBe(true);

      // structuredContent: the failure envelope, classified as caller input rather than
      // an upstream or internal fault, and naming the key it refused.
      const error = (result.structuredContent as { error?: { code?: number; message?: string } })
        .error;
      expect(error?.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error?.message).toContain(UNDECLARED_KEY);

      // content[]: a text-only client reads the same refusal, naming the same key.
      expect(blockText(result.content?.[0])).toContain(UNDECLARED_KEY);
    });
  }

  /**
   * The other half of strictness: it bounds only what was never declared. An optional field
   * left out is still a valid call, and no upstream request is needed to prove it — a schema
   * rejection never reaches the handler, so this asserts the absence of that rejection.
   */
  it('accepts a call that omits every optional argument', () => {
    for (const definition of allToolDefinitions) {
      const parsed = definition.input.safeParse(VALID_INPUT[definition.name]);
      expect(parsed.success, definition.name).toBe(true);
    }
  });
});
