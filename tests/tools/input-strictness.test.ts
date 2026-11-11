/**
 * @fileoverview The argument contract every tool advertises, and what happens to an argument
 * it never declared. Both are framework behavior rather than anything this server writes, and
 * both are wire-visible: `tools/list` publishes the schema a client validates against, and an
 * undeclared key is refused by name instead of being silently dropped on the way to the handler.
 * A tool that ever needs an open argument set opts out explicitly, and this file is what fails
 * when one is opened by accident. The keys a tool declares as aliases are the exception that
 * proves it: `crossref_search_works` takes Crossref's own parameter names, rewritten to the
 * declared key before strict validation, so they reach the handler without being advertised.
 * @module tests/tools/input-strictness.test
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { blockText } from '../helpers/content.js';
import { type ToolResult, textOf, workList } from '../helpers/crossref-responses.js';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn().mockReturnValue({
    mailto: 'test@example.com',
    baseUrl: 'https://api.crossref.test',
    timeoutMs: 10_000,
  }),
}));

import { allToolDefinitions, searchWorksTool } from '@/mcp-server/tools/definitions/index.js';
import { initCrossrefService } from '@/services/crossref/crossref-service.js';

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
      const error = (
        result.structuredContent as {
          error?: { code?: number; message?: string; data?: { reason?: string } };
        }
      ).error;
      /**
       * `InvalidParams` rather than `ValidationError`: an argument rejection goes through
       * `parseToolArguments`, the same call the production handler factory makes, so this is
       * the code, message, and text a client actually receives. `reason` is what a client
       * branches on — it separates a malformed call from every upstream failure this server
       * declares, which share the envelope but not the caller's next move.
       */
      expect(error?.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error?.data?.reason).toBe('invalid_arguments');
      expect(error?.message).toContain(UNDECLARED_KEY);

      /**
       * content[]: a text-only client reads the same refusal, naming the same key. Asserted
       * by containment — the framework appends a synthesized `Recovery:` line and closes the
       * block with the reason and retryability, so the text is a superset of the refusal
       * rather than a fixed string.
       */
      const text = blockText(result.content?.[0]);
      expect(text).toContain(UNDECLARED_KEY);
      expect(text).toContain('invalid_arguments');
    });
  }

  /**
   * Every count and position these tools take is a whole number upstream: Crossref refuses a
   * fractional `rows` as an unstructured 400. Advertising `integer` puts that on the schema a
   * client validates against, and refuses the value before any request is made.
   */
  it('advertises every numeric argument as an integer', () => {
    for (const definition of allToolDefinitions) {
      const properties = advertisedInputSchema(definition).properties ?? {};
      for (const [name, property] of Object.entries(properties)) {
        expect((property as { type?: string }).type, `${definition.name}.${name}`).not.toBe(
          'number',
        );
      }
    }
  });

  it.each([
    ['crossref_search_works', 'rows'],
    ['crossref_search_works', 'offset'],
    ['crossref_search_journals', 'rows'],
    ['crossref_search_funders', 'rows'],
  ])('%s refuses a fractional %s on both surfaces', async (name, field) => {
    const definition = allToolDefinitions.find((d) => d.name === name);
    if (!definition) throw new Error(`${name} is not registered`);
    const property = advertisedInputSchema(definition).properties?.[field] as
      | { type?: string }
      | undefined;
    expect(property?.type).toBe('integer');

    const result = await runToolContract(definition, {
      ...VALID_INPUT[name],
      [field]: 1.5,
    } as never);

    expect(result.isError).toBe(true);
    const error = (
      result.structuredContent as { error?: { code?: number; data?: { reason?: string } } }
    ).error;
    expect(error?.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error?.data?.reason).toBe('invalid_arguments');
    const text = blockText(result.content?.[0]);
    expect(text).toContain(field);
    expect(text).toContain('invalid_arguments');
  });

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

/**
 * Crossref's REST API names the field selection `select` and the field queries `query.title`
 * and its siblings — the names this server sends upstream. A caller who knows that API sends
 * them, and each reaches the handler as the declared key, through the real service behind a
 * fetch fake so the request that leaves the server is the observable.
 */
describe('crossref_search_works accepts Crossref parameter names', () => {
  const http = createFetchMock();
  const WORKS = /^https:\/\/api\.crossref\.test\/works\?/;

  beforeEach(() => {
    http.reset();
    http.install();
    initCrossrefService();
    http.route({
      match: WORKS,
      respond: () =>
        workList([{ DOI: '10.1038/s41586-020-2649-2', title: ['Array programming with NumPy'] }]),
    });
  });

  afterEach(() => {
    http.restore();
  });

  /** The query string of the one request the call made. */
  function sent(): URLSearchParams {
    expect(http.calls).toHaveLength(1);
    return new URL(http.calls[0]?.request.url ?? '').searchParams;
  }

  /** The failure envelope on structuredContent, and the refusal text on content[]. */
  function refusal(result: ToolResult) {
    expect(result.isError).toBe(true);
    const error = (
      result.structuredContent as {
        error?: { code?: number; message?: string; data?: { reason?: string } };
      }
    ).error;
    expect(error?.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error?.data?.reason).toBe('invalid_arguments');
    expect(http.calls).toHaveLength(0);
    return { structured: JSON.stringify(error), text: textOf(result) };
  }

  it('reaches the handler as fields when the selection is sent as select', async () => {
    const result = await runToolContract(searchWorksTool, {
      query: 'array programming with numpy',
      rows: 2,
      select: ['DOI', 'title', 'container-title'],
    } as never);

    expect(result.isError).toBeFalsy();
    expect(sent().get('select')).toBe('DOI,title,container-title');
    expect((result.structuredContent as { works: { title?: string }[] }).works).toEqual([
      { doi: '10.1038/s41586-020-2649-2', title: 'Array programming with NumPy' },
    ]);
    expect(textOf(result)).toContain('### Array programming with NumPy');
  });

  it.each([
    ['query.bibliographic', 'queryBibliographic'],
    ['query.title', 'queryTitle'],
    ['query.author', 'queryAuthor'],
    ['query.container-title', 'queryContainerTitle'],
  ])('reaches the handler as %s → %s, and is sent upstream under that name', async (alias) => {
    const result = await runToolContract(searchWorksTool, {
      [alias]: 'Array programming with NumPy',
      rows: 1,
    } as never);

    expect(result.isError).toBeFalsy();
    expect(sent().get(alias)).toBe('Array programming with NumPy');
    expect(textOf(result)).toContain('### Array programming with NumPy');
  });

  it.each([
    ['select', 'fields', ['DOI']],
    ['query.title', 'queryTitle', 'NumPy'],
    ['query.container-title', 'queryContainerTitle', 'Nature'],
  ])(
    'refuses %s sent beside %s, naming it an alias on both surfaces',
    async (alias, target, value) => {
      const result = await runToolContract(searchWorksTool, {
        [alias]: value,
        [target]: value,
      } as never);

      const { structured, text } = refusal(result);
      const hint = `${alias} is an alias of ${target}; send one of them, not both.`;
      expect(structured).toContain(hint);
      expect(text).toContain(hint);
    },
  );

  it('reports an invalid select entry at its fields position', async () => {
    const result = await runToolContract(searchWorksTool, {
      query: 'q',
      select: ['DOI', 'doi'],
    } as never);

    const { structured, text } = refusal(result);
    for (const surface of [structured, text]) {
      expect(surface).toContain('fields.1');
      expect(surface).toContain('Validated select as fields.');
    }
  });

  it('refuses a comma-joined select exactly as it refuses the same string sent as fields', async () => {
    const asSelect = refusal(
      await runToolContract(searchWorksTool, { query: 'q', select: 'DOI,title' } as never),
    );
    const asFields = refusal(
      await runToolContract(searchWorksTool, { query: 'q', fields: 'DOI,title' } as never),
    );

    expect(asSelect.text).toContain('fields');
    expect(asSelect.text.replace(' Validated select as fields.', '')).toBe(asFields.text);
  });

  it('advertises the same inputSchema with and without the aliases', () => {
    const { inputAliases, ...definition } = searchWorksTool;
    expect(Object.keys(inputAliases ?? {})).toEqual([
      'select',
      'query.bibliographic',
      'query.title',
      'query.author',
      'query.container-title',
    ]);
    const without = tool(definition.name, definition);

    const advertised = JSON.stringify(advertisedInputSchema(searchWorksTool));
    expect(advertised).toBe(JSON.stringify(advertisedInputSchema(without)));
    for (const alias of Object.keys(inputAliases ?? {})) {
      expect(Object.keys(advertisedInputSchema(searchWorksTool).properties ?? {})).not.toContain(
        alias,
      );
    }
  });
});
