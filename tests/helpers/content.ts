/**
 * @fileoverview Narrowing helpers for reading rendered text out of a tool's `content[]`.
 * `ContentBlock` is a discriminated union and only its `text` variant carries a `text`
 * field, so a test that asserts on rendered markdown narrows on the discriminant instead
 * of indexing the union. Typed structurally rather than against the SDK's `ContentBlock`
 * so tests need no direct dependency on the MCP SDK.
 * @module tests/helpers/content
 */

import { Parser } from 'commonmark';

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

/**
 * The text a CommonMark reader sees in `markdown`: backslash escapes resolved, inline markup
 * dropped, code span and code block contents kept verbatim, and one line per paragraph,
 * heading, or line break. Assert on this, not the raw markdown, wherever the framework escapes
 * text it renders into `content[]`.
 */
export function renderedText(markdown: string): string {
  const walker = new Parser().parse(markdown).walker();
  let out = '';
  for (let step = walker.next(); step; step = walker.next()) {
    const { node, entering } = step;
    switch (node.type) {
      case 'text':
      case 'code':
      case 'code_block':
        out += node.literal ?? '';
        break;
      case 'softbreak':
      case 'linebreak':
        out += '\n';
        break;
      case 'paragraph':
      case 'heading':
        if (!entering) out += '\n';
        break;
    }
  }
  return out;
}
