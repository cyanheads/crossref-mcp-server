/**
 * @fileoverview Narrowing helpers for reading rendered text out of a tool's `content[]`.
 * `ContentBlock` is a discriminated union and only its `text` variant carries a `text`
 * field, so a test that asserts on rendered markdown narrows on the discriminant instead
 * of indexing the union. Typed structurally rather than against the SDK's `ContentBlock`
 * so tests need no direct dependency on the MCP SDK.
 * @module tests/helpers/content
 */

/** The subset of a content block these helpers read. */
type TextLikeBlock = { readonly type: string; readonly text?: string };

/** Text of one block — `''` when the block is absent or is not a text block. */
export function blockText(block: TextLikeBlock | undefined): string {
  return block?.type === 'text' ? (block.text ?? '') : '';
}

/** Every text block joined by newline; non-text blocks contribute nothing. */
export function contentText(blocks: readonly TextLikeBlock[]): string {
  return blocks.map(blockText).join('\n');
}
