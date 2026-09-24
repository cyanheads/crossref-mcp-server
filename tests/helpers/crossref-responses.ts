/**
 * @fileoverview Crossref response bodies for tests that drive the real `CrossrefService` through
 * a fetch fake — the envelope shapes `/works`, `/journals`, `/funders`, and their single-record
 * routes answer with — plus readers for what a call put on the wire and what came back on
 * `content[]`.
 * @module tests/helpers/crossref-responses
 */

import type { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { blockText } from './content.js';

/** The SDK's `CallToolResult`, reached through the runner so the SDK stays a transitive dep. */
export type ToolResult = Awaited<ReturnType<typeof runToolContract>>;

/** A `/works`-shaped list: `items`, `total-results`, and a `next-cursor` when one is given. */
export function workList(items: unknown[], total = items.length, nextCursor?: string): Response {
  return Response.json({
    status: 'ok',
    'message-type': 'work-list',
    message: {
      'total-results': total,
      'items-per-page': items.length,
      items,
      ...(nextCursor !== undefined && { 'next-cursor': nextCursor }),
    },
  });
}

/** A `/journals` or `/funders` name-search list. */
export function entityList(items: unknown[], total = items.length): Response {
  return Response.json({
    status: 'ok',
    'message-type': 'entity-list',
    message: { 'total-results': total, 'items-per-page': items.length, items },
  });
}

/** A single-record response — `/journals/{issn}` or `/funders/{id}`. */
export function singleRecord(message: unknown): Response {
  return Response.json({ status: 'ok', 'message-type': 'record', message });
}

/** Every text block of a result, joined by newline. */
export function textOf(result: ToolResult): string {
  return result.content.map(blockText).join('\n');
}

/** Text blocks carrying nothing but whitespace — what a client that renders only `content[0]` shows as blank. */
export function blankTextBlocks(result: ToolResult): unknown[] {
  return result.content.filter((block) => block.type === 'text' && blockText(block).trim() === '');
}

/** How many times `needle` occurs across `content[]`. */
export function occurrences(result: ToolResult, needle: string): number {
  return textOf(result).split(needle).length - 1;
}
