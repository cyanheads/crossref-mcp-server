/**
 * @fileoverview `mdText` — the escape a deposited string passes through on its way into the
 * Markdown that every tool's `format()` builds, so that a character the deposit carried
 * reaches a `content[]` reader as itself rather than as markup.
 *
 * `structuredContent` and `content[]` are two surfaces over the same values, and a reader of
 * the second must not lose what a reader of the first keeps. Normalization already decides
 * which brackets are markup and which are content; the ones it keeps are kept because deleting
 * them would cost the reader an address, a Miller index, a DOI fragment, or a phrase somebody
 * typed. Interpolated raw into a Markdown line, several of those are read a second time — this
 * time by the client's renderer, which consumes an unknown element as its children alone and
 * resolves a character reference the single-pass decode deliberately left as text. What the
 * strip protected, the render then deletes.
 *
 * The escape belongs here rather than in normalization because normalization decides what the
 * value *is* and `format()` decides how it is *shown*. A backslash written into the value
 * itself would reach `structuredContent`, whose contract is the deposited text; written here it
 * reaches only the surface that needs it, and the two surfaces then agree on every character.
 *
 * Two entry points, because one class of construct depends on where the value is placed rather
 * than on what it contains: `mdText` for a value rendered inside a line, `mdTextAtLineStart` for
 * one rendered at column zero, where a leading `#`, `>`, `-`, or `19.` opens a block and the
 * renderer eats the marker.
 * @module mcp-server/tools/markdown-text
 */

/**
 * The ASCII punctuation CommonMark lets a backslash escape, which is the only company a
 * backslash is consumed in front of. Anywhere else it is already literal, so a TeX control word
 * (`\bot`, `\hbox`) survives untouched and gains nothing.
 */
const ESCAPABLE_PUNCTUATION = '[!-\\/:-@\\[-`{-~]';

/**
 * Every character that would be read as markup rather than as itself, and only where it would.
 * The conditions are what keep the escape off ordinary prose: measured across 12,000 sampled
 * works, 6,565 reference fields carry an ampersand and 60 carry a character reference, and
 * 2,504 carry a `[` while 8 carry the `](` that would make one a link — escaping either
 * character unconditionally would mark up two orders of magnitude more text than it protects.
 *
 * Matching is linear: every alternative is a single character, the lookaheads consume nothing,
 * and each quantifier inside one is bounded, so an adversarially entity-dense or bracket-dense
 * field costs a fixed amount of work per character rather than a growing one.
 */
const MARKDOWN_ACTIVE = new RegExp(
  [
    /** A backslash, in front of the punctuation a Markdown reader would let it escape. */
    String.raw`\\(?=${ESCAPABLE_PUNCTUATION})`,
    /**
     * The emphasis, code, and strikethrough markers this server writes into its own lines. A
     * deposited one pairs with the server's — `format()` wraps a journal title in `*…*`, so an
     * asterisk inside the title closes the emphasis early and is consumed doing it — which is
     * why these are unconditional: `*` opens emphasis even between two word characters, and a
     * code span swallows everything to the next backtick.
     *
     * `_` is deliberately not among them. Nothing this server writes is an underscore, so a
     * deposited one can only pair with another deposited one, and what that costs is the two
     * markers rather than any text between them. Measured across 12,000 sampled works, 76 of
     * 215,933 values carry an underscore that could flank at all and 45 carry the two a pair
     * needs. Escaping it would also cost more than it protects: the linter that checks every
     * `output` field reaches `content[]` probes with an underscore-delimited sentinel, so
     * escaping one blinds that check — which guards the same two-surface invariant, across
     * every tool — to save two characters in 0.02% of values.
     */
    '[*~`]',
    /**
     * `<` in the shapes that begin raw HTML or an autolink — a name, a closing slash, a
     * declaration, a processing instruction. A bracket the strip deliberately kept because it
     * was not tag-shaped (`0.01 < x > 0.8`, `Silicon <100> nanowires`) is not tag-shaped to a
     * renderer either, and is left alone here for the same reason.
     */
    '<(?=[A-Za-z/!?])',
    /**
     * `&` only where it heads a well-formed character reference, which mirrors the decode: the
     * one string that reaches this point still spelled as a reference is the one a publisher
     * escaped twice (`&amp;lt;`), and it must stay the text `&lt;` on both surfaces. A bare
     * ampersand somebody typed — `R&D`, `Taylor & Francis`, `?a=1&lang=en` — is left bare.
     */
    '&(?=(?:[A-Za-z][A-Za-z0-9]{0,31}|#[0-9]{1,7}|#[xX][0-9A-Fa-f]{1,6});)',
    /**
     * `]` in front of the destination or label that would complete a link or an image. Closing
     * the pair is what stops it; the `[` that opened it is far more often a citation marker or
     * a bracketed formula (`[18F]FDG`, `[Ca2+]`) that needs no escaping at all.
     */
    String.raw`\](?=[([])`,
  ].join('|'),
  'gu',
);

/**
 * Escape a deposited string for the Markdown surface `format()` writes.
 *
 * Applies to the values the normalization passes produced — the human-readable free text.
 * Identifiers and machine-format values (DOIs, URLs, ISSNs, prefixes, ORCIDs, reference keys)
 * are projected byte-exact and are interpolated the same way, because they are what a reader
 * copies: a backslash inside a URL breaks the copy and the autolink both, which is a worse
 * outcome than the stray emphasis it would prevent. That is the same line normalization already
 * draws between the two kinds of value.
 *
 * Block constructs are not escaped here, and what decides that is the call site rather than the
 * value. `#`, `>`, `-`, `+`, and a number followed by a dot open a block only at column zero, and
 * almost every value this server renders sits behind a `## `, a `- `, or a `**Label:** `, where
 * the same characters are inert. Escaping them unconditionally would put a backslash in front of
 * the leading hyphen of every title that starts with one and protect nothing: 1,201 of 328,920
 * sampled values open on one of these characters and nearly all of them are rendered mid-line.
 * A value that is the first thing on its line goes through `mdTextAtLineStart` instead.
 */
export function mdText(value: string): string {
  return value.replace(MARKDOWN_ACTIVE, '\\$&');
}

/**
 * The Markdown blocks a value can open when nothing precedes it on the line. Each alternative is
 * the construct's own opening condition rather than its bare marker, which is what keeps the
 * escape off the far commoner value that merely starts with the same character: `2.25Cr1Mo0.25V`
 * and `1.8-MeV` are not ordered lists, because a list marker is followed by a space or by
 * nothing, and `-- no abstract provided by author --` is not a bullet for the same reason.
 *
 * Anchored, and with no allowance for leading spaces: normalization trims, so a value cannot
 * arrive indented and the four-space code-block rule has nothing to catch.
 */
const BLOCK_OPENER = new RegExp(
  `^(?:${[
    /** An ATX heading: one to six `#`, then a space or the end of the line. */
    String.raw`#{1,6}(?=[ \t]|$)`,
    /** A block quote, which opens on the `>` alone. */
    '>',
    /** A bullet list. `*` opens one too and is absent because `mdText` already escaped it. */
    String.raw`[-+](?=[ \t]|$)`,
    /** An ordered list: up to nine digits, then a `.` or `)`. */
    String.raw`\d{1,9}[.)](?=[ \t]|$)`,
    /**
     * A thematic break or a setext underline — a line of nothing but `-` or `=`. This one costs
     * more than a marker: the line is consumed whole, and a setext underline takes the label
     * `format()` wrote above it and turns that into a heading.
     */
    '[-=]+$',
  ].join('|')})`,
);

/**
 * Escape a deposited string for a Markdown line it *begins*, rather than one it sits inside.
 *
 * A marker at column zero is not merely presented differently — the renderer consumes it, so an
 * abstract deposited as `19. yüzyılın ikinci yarısından` reaches the reader as a list item
 * numbered 19 with the century it names gone, and one opening `- ` loses the hyphen and space
 * the publisher wrote. Whether that can happen is a property of the line, not of the value,
 * which is why this is a second entry point rather than a widening of `mdText`.
 *
 * The escape lands on the last character of the marker: the marker itself where it is one
 * character, the `.` or `)` of an ordered-list marker otherwise. Escaping the digits instead
 * would show a backslash, since `\1` is not an escape a reader resolves. The inline pass runs
 * first — reversed, it would escape the backslash this one just wrote.
 */
export function mdTextAtLineStart(value: string): string {
  return mdText(value).replace(
    BLOCK_OPENER,
    (opener) => `${opener.slice(0, -1)}\\${opener.slice(-1)}`,
  );
}
