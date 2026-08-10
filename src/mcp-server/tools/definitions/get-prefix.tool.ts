/**
 * @fileoverview crossref_get_prefix — resolves a DOI prefix to its owning Crossref member (publisher).
 * @module mcp-server/tools/definitions/get-prefix.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { mdText } from '@/mcp-server/tools/markdown-text.js';
import { getCrossrefService, normalizeText } from '@/services/crossref/crossref-service.js';
import { UPSTREAM_ERROR_CONTRACT } from '@/services/crossref/upstream-errors.js';

export const getPrefixTool = tool('crossref_get_prefix', {
  title: 'Get Prefix Owner',
  description:
    'Resolves a DOI prefix — the registrant portion of a DOI, e.g. "10.1038" — to its owning Crossref member: the publisher name and numeric member ID. Answers "who publishes DOIs starting with 10.1038?" The Crossref prefix record carries only these three facts (no counts, coverage, or flags); the returned memberId chains directly into crossref_get_member for the full publisher record.',
  annotations: { readOnlyHint: true, idempotentHint: true },

  input: z.object({
    prefix: z
      .string()
      .regex(/^10\.\d+$/, {
        message:
          'DOI prefix must be "10." followed by digits, e.g. "10.1038". Pass the registrant prefix only — no "/suffix".',
      })
      .describe(
        'DOI prefix in the format "10.NNNN" — the registrant portion of a DOI with no "/suffix", e.g. "10.1038" or "10.1371".',
      ),
  }),

  output: z.object({
    prefix: z.string().describe('The DOI prefix that was resolved, e.g. "10.1038"'),
    ownerName: z
      .string()
      .optional()
      .describe('Name of the member (publisher) that owns this prefix'),
    memberId: z
      .number()
      .optional()
      .describe(
        'Numeric Crossref member ID that owns this prefix — pass to crossref_get_member for the full publisher record',
      ),
  }),

  errors: [
    ...UPSTREAM_ERROR_CONTRACT,
    {
      reason: 'prefix_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The DOI prefix is not registered with Crossref.',
      recovery:
        'Verify the prefix (the "10.NNNN" portion of a DOI), or use crossref_search_works to find the work and its publisher.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Resolving DOI prefix', { prefix: input.prefix });
    const svc = getCrossrefService();
    const raw = await svc.getPrefix(input.prefix, ctx);
    if (!raw) {
      throw ctx.fail('prefix_not_found', `No Crossref member owns prefix: ${input.prefix}`, {
        prefix: input.prefix,
        ...ctx.recoveryFor('prefix_not_found'),
      });
    }

    const memberId = extractTrailingId(raw.member);
    const prefix = extractTrailingSegment(raw.prefix) ?? input.prefix;

    return {
      prefix,
      ...(raw.name !== undefined && { ownerName: normalizeText(raw.name) }),
      ...(memberId !== undefined && { memberId }),
    };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`**Prefix:** ${result.prefix}`);
    lines.push(`**Owner:** ${result.ownerName ? mdText(result.ownerName) : 'Unknown'}`);
    if (result.memberId !== undefined) lines.push(`**Member ID:** ${result.memberId}`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

// --- Helpers ---

/** Extract the trailing numeric ID from a Crossref member URI (…/member/297 → 297). */
function extractTrailingId(uri: string | undefined): number | undefined {
  if (!uri) return;
  const match = uri.match(/(\d+)\/?$/);
  if (!match?.[1]) return;
  const n = Number.parseInt(match[1], 10);
  return Number.isNaN(n) ? undefined : n;
}

/** Extract the trailing path segment from a Crossref prefix URI (…/prefix/10.1038 → 10.1038). */
function extractTrailingSegment(uri: string | undefined): string | undefined {
  if (!uri) return;
  const trimmed = uri.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}
