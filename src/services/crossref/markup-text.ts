/**
 * @fileoverview The text normalization every tool projects free-text values through —
 * `normalizeText` for the baseline pass, `normalizeMarkupText` for the JATS-deposited fields
 * (with `normalizeAbstract` keeping an abstract's section headings and list items apart from the
 * text around them),
 * and `normalizeReferenceText` for the deposited citation strings. The two markup passes are
 * one rule over one implementation (`stripMarkup`): a bracket is removed only when it is
 * recognizable as markup, by its shape, by sitting inside a markup region, or by its element
 * name — and they differ in two things: what an unrecognized element name means, and whether a
 * tag escaped into the text (`&lt;p&gt;`) can be markup, which only the JATS pass allows. A link
 * element is the one class settled per occurrence instead of per name, since its tags may come
 * out only where its own text already carries the address its `href` holds; an `<alternatives>`
 * wrapper is the one region that selects rather than strips, keeping the first of the encodings
 * it holds so one expression does not reach the reader twice and leaving the block boundary a
 * formula leaves, whichever encoding it kept; a MathML formula is the one region that is read
 * rather than emptied — see `mathml` — so the operators its tree encodes as structure survive
 * the loss of its tags. Every region is found by a scan linear in the field, however many of
 * its openers the deposit leaves unclosed, and every escaped tag is decided in one linear scan.
 * All three passes end in the same baseline: character references decoded against the HTML5
 * named set in `html-entities`, then whitespace collapsed — in a JATS field holding escaped
 * markup, after every reference escaped with it is lowered one level.
 *
 * What these passes produce is what `structuredContent` carries. The same values are escaped
 * again on their way into the Markdown of `content[]` — see `mdText` in `mcp-server/tools` —
 * so a bracket kept here is not consumed by the client's renderer instead.
 * @module services/crossref/markup-text
 */

import { decodeHtmlEntities } from './html-entities.js';
import { type LinkText, linkTextReader } from './link-text.js';
import { mathmlText } from './mathml.js';

/**
 * Collapse every run of whitespace to a single space and trim. Any run, not runs of two or
 * more: a lone newline inside a deposited string is enough to split a Markdown heading in
 * `content[]` and turn the indented continuation into a code block.
 */
export function collapseWhitespace(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/**
 * Normalize a human-readable upstream string for output: decode character references,
 * collapse whitespace, trim.
 *
 * This is the baseline every free-text value this server projects from a Crossref record
 * passes through — work and journal titles, publisher and funder and member names,
 * affiliations, subjects, reference text. Identifiers and machine-format values (DOIs, URIs,
 * ISSNs, prefixes, dates, work types, coverage categories) are projected byte-exact and never
 * come through here.
 *
 * The decode runs before the collapse, so a reference naming a whitespace character —
 * `&#10;`, `&nbsp;` — folds into the surrounding run rather than reaching `content[]` as a
 * line break that splits the Markdown around it.
 */
export function normalizeText(raw: string): string {
  return collapseWhitespace(decodeHtmlEntities(raw));
}

/**
 * `normalizeText`, with a value that normalizes to nothing read as no value: a field deposited
 * as whitespace or a lone space reference, projected, renders a label with nothing after it.
 */
export function normalizeNonEmptyText(raw: string | undefined): string | undefined {
  return (raw !== undefined && normalizeText(raw)) || undefined;
}

/**
 * Each string of a deposited list through `normalizeText`, dropping those that normalize to
 * nothing; `undefined` when none remain, so a list of blanks is omitted like one never deposited.
 */
export function normalizeNonEmptyTexts(raw: readonly string[] | undefined): string[] | undefined {
  const texts = raw?.map(normalizeText).filter((text) => text !== '');
  return texts?.length ? texts : undefined;
}

/**
 * The attribute tail of a well-formed tag: zero or more `name="value"` pairs, quoted or bare.
 * Requiring the `=` is what separates a tag from a bracketed phrase that merely opens with an
 * element name. `<Stack Overflow, https://…>`, `<Available from: http://…>`, and `<The Internet
 * Movie DataBase, http://…>` are all text a reader needs, and all three read as a tag under a
 * looser `<name\b[^>]*>`.
 *
 * The bare-value form excludes quotes so that each value has exactly one parse. Letting it also
 * match `"y"` gives every attribute two readings and the whole tail 2^n of them, which a tag
 * left unterminated by its deposit backtracks through: `<p class="a" x = "y" x = "y" …` costs
 * seconds at fifty pairs and does not improve with fewer. A bare value containing a quote is not
 * well formed in any case. It excludes `<` for the same kind of reason: a tag cannot hold one
 * unquoted, and admitting it lets the value of a tag the deposit never terminated run on through
 * every tag after it — `<i x=1<i x=1…` — so each one is rescanned to the end of the field.
 */
const TAG_ATTRIBUTES = String.raw`(?:\s+[A-Za-z_:][\w.:-]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s<>"']+))*\s*`;

/**
 * A well-formed tag. The name follows `<` with no space — so an inequality written
 * `0.01 < x > 0.8` can never read as one — may carry a namespace prefix (`<jats:italic>`),
 * and is followed by an attribute tail and nothing else. Captures the closing slash, the
 * local name, and the self-closing slash, which is everything the classifier needs.
 */
const TAG_SOURCE = String.raw`<(\/?)(?:[A-Za-z][\w.-]*:)?([A-Za-z][\w.-]*)${TAG_ATTRIBUTES}(\/?)>`;

const TAG = new RegExp(TAG_SOURCE, 'g');

/**
 * `TAG_ATTRIBUTES` as it reads with its brackets escaped. A quoted value holds no `<`, so an
 * escaped tag never reaches across a deposited one, and a bare value ends at the `&lt;` or
 * `&gt;` that would open or close another tag, for the reason the deposited tail excludes `<`.
 */
const ESCAPED_TAG_ATTRIBUTES = String.raw`(?:\s+[A-Za-z_:][\w.:-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'|(?:[^\s<>"'&]|&(?!lt;|gt;))+))*\s*`;

/**
 * A tag a deposit escaped into its text — `&lt;p class="x"&gt;` — in the shape of `TAG` with its
 * brackets written as references, and the same three captures. Deposits that escape HTML into
 * JATS write the brackets `&lt;` and `&gt;` and leave the quotes bare.
 */
const ESCAPED_TAG_SOURCE = String.raw`&lt;(\/?)(?:[A-Za-z][\w.-]*:)?([A-Za-z][\w.-]*)${ESCAPED_TAG_ATTRIBUTES}(\/?)&gt;`;

/**
 * A deposited tag (captures 1–3) or an escaped one (captures 4–6), in document order. The two
 * alternatives begin with different characters and an escaped tag holds no `<`, so every
 * deposited tag is matched exactly where `TAG` alone would match it.
 */
const ANY_TAG = new RegExp(`${TAG_SOURCE}|${ESCAPED_TAG_SOURCE}`, 'g');

/** `ANY_TAG`, or the `&amp;` of a reference escaped one level past the text around it. */
const ANY_TAG_OR_AMPERSAND = new RegExp(`${TAG_SOURCE}|${ESCAPED_TAG_SOURCE}|&amp;`, 'g');

/** One tag as the classifier reads it, however the deposit wrote it. */
interface Tag {
  readonly close: boolean;
  /** Whether the deposit escaped it into its text. */
  readonly escaped: boolean;
  /** The local name, in lower case. */
  readonly name: string;
  readonly selfClose: boolean;
}

/**
 * The tag a match holds, from its capture groups — the three of `TAG`, or the six of `ANY_TAG` —
 * or undefined for the `&amp;` of `ANY_TAG_OR_AMPERSAND`, which captures nothing.
 */
function tagOf(groups: ReadonlyArray<string | undefined>): Tag | undefined {
  const [close, name, selfClose, escapedClose, escapedName, escapedSelfClose] = groups;
  if (name !== undefined) {
    return {
      close: Boolean(close),
      escaped: false,
      name: name.toLowerCase(),
      selfClose: Boolean(selfClose),
    };
  }
  if (escapedName === undefined) return;
  return {
    close: Boolean(escapedClose),
    escaped: true,
    name: escapedName.toLowerCase(),
    selfClose: Boolean(escapedSelfClose),
  };
}

/**
 * What removing an element does to the text around it — or, for `keep`, that the bracket does
 * not come out on the element name alone. An unrecognized name is `keep` on the reference
 * surface because it is presumed to be content; a link element is `keep` until its own text is
 * checked for the address its `href` carries.
 */
type Verdict = 'tight' | 'inline' | 'block' | 'keep';

/**
 * What a surface decides that no shared rule does: the verdict for an element name on none of
 * the class lists, and whether a tag escaped into the text can be markup at all.
 */
interface Surface {
  readonly escapedMarkup: boolean;
  readonly unlisted: Verdict;
}

/**
 * A title or abstract is deposited as JATS, an XML document: an unlisted name is structure, and
 * HTML escaped into its text is markup the publisher meant as markup — see `settleEscapedTags`.
 */
const JATS_SURFACE: Surface = { escapedMarkup: true, unlisted: 'block' };

/**
 * A reference entry is a citation string a publisher typed: an unlisted name is content, and so
 * is an escaped tag, whatever pairs with it.
 */
const REFERENCE_SURFACE: Surface = { escapedMarkup: false, unlisted: 'keep' };

/** A structured citation's content, where every tag is markup by construction — see `CITATION`. */
const CITATION_CONTENT: Surface = { escapedMarkup: false, unlisted: 'inline' };

/**
 * Elements that can carry an address in an attribute. Their tags come out only when the
 * element's own text already carries that address — see `linkAddressSurvives`.
 */
const LINK_ELEMENTS = ['ext-link', 'uri', 'a'];

/**
 * Inline emphasis in the HTML, JATS, and Springer spellings, plus the JATS citation fields
 * publishers deposit bare into an otherwise typed citation string.
 */
const INLINE_ELEMENTS = [
  'article-title',
  'given-names',
  'person-group',
  'string-name',
  'surname',
  'italic',
  'strong',
  'collab',
  'small',
  'bold',
  'fname',
  'span',
  'etal',
  'scp',
  'em',
  'sc',
  'i',
  'b',
  'u',
];

/**
 * Block boundaries. A publisher packing several citations into one field separates them here —
 * `refersplit` is the separator one publisher appends to each packed citation, self-closing and
 * carrying nothing, and the text before it ends in a period rather than a word character.
 */
const BLOCK_ELEMENTS = ['disp-formula', 'refersplit', 'br', 'p'];

/**
 * Scripts and inline formula wrappers: their content continues the token around them, and the
 * wrapper itself carries nothing the text does not — `<tex Notation="TeX">$\hbox{1}/f$</tex>`
 * reads as the TeX it wraps.
 */
const TIGHT_ELEMENTS = [
  'inline-formula',
  'ref_formula',
  'superscript',
  'subscript',
  'tex-math',
  'formula',
  'stack',
  'sub',
  'sup',
  'inf',
  'tex',
];

/**
 * Every element name this server classifies, and what removing it does to the text around it.
 * Both markup passes read this one map, which is what keeps them from drifting apart; it is
 * exported so a test can drive the caller-visible outcome of every name in it, rather than
 * asserting that a name is present and leaving the behavior unpinned.
 */
export const ELEMENT_VERDICTS = new Map<string, Verdict>([
  ...LINK_ELEMENTS.map((name) => [name, 'keep'] as const),
  ...TIGHT_ELEMENTS.map((name) => [name, 'tight'] as const),
  ...INLINE_ELEMENTS.map((name) => [name, 'inline'] as const),
  ...BLOCK_ELEMENTS.map((name) => [name, 'block'] as const),
]);

/**
 * A construct matched end to end — from its opening tag to the first closing tag after it — so
 * a strip can never half-consume one. The two tags are matched separately rather than as one
 * lazy `<open>[\s\S]*?</close>` pattern: that pattern learns an opener has no closer by scanning
 * to the end of the field, and does so again from every later opener, which is quadratic in a
 * field packed with unclosed ones. Found separately, the first opener with no closer after it
 * ends the search, since no later opener can have one either — see `replaceRegions`.
 */
interface Region {
  /** The closing tag, global. */
  readonly closer: RegExp;
  /** The opening tag, global. */
  readonly opener: RegExp;
}

/** A region whose elements are named by `names` (a regex alternation), opened by `openerTail`. */
function region(names: string, openerTail: string): Region {
  const prefix = '(?:[A-Za-z][\\w.-]*:)?';
  return {
    opener: new RegExp(String.raw`<${prefix}(?:${names})\b${openerTail}>`, 'gi'),
    closer: new RegExp(String.raw`</${prefix}(?:${names})\s*>`, 'gi'),
  };
}

/**
 * A whole MathML formula. Removing the region outright would delete the symbol the sentence is
 * about, and emptying it of tags deletes every operator its tree encodes as structure — so it is
 * read instead, by `mathmlText`. The opener's attributes stop at the next `<`, which no
 * attribute can hold unquoted, so an opener the deposit never terminated costs one short scan.
 */
const MATHML = region('math', '[^<>]*');

/**
 * A JATS `<alternatives>` wrapper. It holds several encodings of one object and expects a
 * consumer to pick one — a formula's TeX beside the same formula's presentation MathML, or a
 * graphic beside the TeX that reproduces it. Emitting every child that carries text renders one
 * expression twice.
 *
 * `alternatives` is an ordinary English word, which on the reference surface would ordinarily
 * keep its brackets. Matching it as a region is what settles that: a reader who writes the
 * word in angle brackets does not also write a closing tag for it, so the pair is what
 * identifies the construct, and an unclosed one matches nothing and is left whole.
 */
const ALTERNATIVES = region('alternatives', TAG_ATTRIBUTES);

/**
 * A JATS structured citation deposited whole into a free-text field. Inside one, every bracket
 * is a tag by construction — nobody types a Miller index inside `<mixed-citation>` — so the
 * name-by-name allow-list does not apply there and the whole vocabulary comes out, however it
 * is spelled.
 */
const CITATION = region('mixed-citation|element-citation|nlm-citation|citation', TAG_ATTRIBUTES);

/**
 * Replace every region in a string with what `read` makes of its content — the text between
 * its opening and closing tags — and leave everything outside the regions as it was.
 *
 * Each region runs from an opener to the first closer after it, and the next search resumes
 * past that closer. An opener with no closer after it claims nothing, and it ends the search:
 * every later opener sits after it, so a closer following one would have followed this one
 * too. That is what keeps the scan linear — the one search for a closer that comes back empty
 * reads the rest of the field once, rather than once per unclosed opener.
 */
function replaceRegions(
  text: string,
  { opener, closer }: Region,
  read: (inner: string) => string,
): string {
  let result = '';
  let resume = 0;
  opener.lastIndex = 0;
  for (let open = opener.exec(text); open; open = opener.exec(text)) {
    closer.lastIndex = opener.lastIndex;
    const close = closer.exec(text);
    if (!close) break;
    result += text.slice(resume, open.index) + read(text.slice(opener.lastIndex, close.index));
    resume = closer.lastIndex;
    opener.lastIndex = resume;
  }
  return result + text.slice(resume);
}

/** Letters and digits in any script — Latin, CJK, Greek — not just ASCII `\w`. */
const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * The marks a sentence ends on. Text resumes after one rather than continuing through it, so a
 * word that follows one is a new word however tightly the deposit packs it.
 */
const SENTENCE_END = /[.:?!]/;

/**
 * A word boundary leaves a space only where the text would otherwise run together: between two
 * word characters, or where a sentence ends and the next word begins.
 *
 * The first case is why an italic journal title followed by a comma closes up instead of gaining
 * a stray space before it. The second is why a heading a publisher marks with `<bold>` rather
 * than `<title>` keeps the space that separates it from the sentence before —
 * `…effectiveness of MOC.<bold>Methods</bold>` is two sentences, not one word. Only a following
 * word character earns the space, so a tag between a period and a bracket still closes up.
 */
function separateWords(run: string, offset: number, whole: string): string {
  const before = whole[offset - 1];
  const after = whole[offset + run.length];
  if (!before || !after || !WORD_CHAR.test(after)) return '';
  return WORD_CHAR.test(before) || SENTENCE_END.test(before) ? ' ' : '';
}

/**
 * The address a link element carries: `href`, or the `xlink:href` a JATS deposit spells it as.
 * Any namespace prefix is admitted; a longer attribute name that merely ends in `href` is not,
 * since the leading `\s` and the optional prefix leave nothing for the rest of it to match.
 */
const HREF_ATTRIBUTE = /\s(?:[A-Za-z][\w.-]*:)?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/i;

/**
 * The transport prefix of an address — `https://`, `ftp://`, `mailto:`, `doi:`. It says how to
 * fetch the resource; everything after it is what gets fetched.
 */
const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:(?:\/\/)?/;

/**
 * The closing tag of each link element, in any namespace spelling. Global rather than plain so
 * the search can start at the opening tag through `lastIndex` and read the rest of the string
 * in place — the alternative copies everything after every link element just to find its end.
 * `linkTextReader` reads each link's text up to the first of these after it.
 */
const LINK_CLOSERS: ReadonlyMap<string, RegExp> = new Map(
  LINK_ELEMENTS.map(
    (name) => [name, new RegExp(String.raw`</(?:[A-Za-z][\w.-]*:)?${name}\s*>`, 'gi')] as const,
  ),
);

/**
 * `LINK_CLOSERS` escaped, for the text of an escaped link. The name is matched in any letter
 * case by class rather than by the `i` flag, which would also admit `&LT;`, a spelling
 * `ESCAPED_TAG_SOURCE` does not read as a tag.
 */
const ESCAPED_LINK_CLOSERS: ReadonlyMap<string, RegExp> = new Map(
  LINK_ELEMENTS.map((name) => {
    const anyCase = name.replace(/[a-z]/g, (letter) => `[${letter}${letter.toUpperCase()}]`);
    return [
      name,
      new RegExp(String.raw`&lt;/(?:[A-Za-z][\w.-]*:)?${anyCase}\s*&gt;`, 'g'),
    ] as const;
  }),
);

/**
 * Whether a link element's tags can come out without costing the reader its address.
 *
 * A link is kept because its address lives in an attribute, where removing the tag deletes it.
 * That premise has to be checked rather than assumed: a structured abstract deposits a URL, an
 * accession, or a trial registration as the element's *text* and repeats it in the `href`, and
 * there the tag protects nothing while putting a namespace-bearing XML tag in the middle of an
 * abstract. Three ways the address is safe:
 *
 * 1. **No attribute.** Nothing of the element's value lives in one, so nothing can be lost —
 *    a `<uri>` deposited around a bare URL, or an `<a>` carrying only a `name`.
 * 2. **Nothing outside the deposit is addressed.** An empty `href`, or one that is a bare
 *    fragment (`#b1`), names a place inside the publisher's own XML. That document is not
 *    something the reader has, so the fragment resolves to nothing and preserves nothing.
 * 3. **The text already carries it.** The element's own text contains the `href`, either
 *    verbatim or less its scheme.
 *
 * The scheme is the only difference the comparison forgives, and the line is deliberate. Losing
 * `http://` in front of `www.fasebj.org` costs the reader nothing they cannot supply; losing the
 * `/ct2/show/NCT02196038` behind `https://clinicaltrials.gov/` costs them the thing being
 * addressed, which is the failure the rule exists to prevent. Every looser comparison — treating
 * `www.` as optional, ignoring a trailing slash, decoding percent-escapes, resolving a DOI
 * through its resolver host — asserts that two different strings name the same resource, and
 * each such assertion is a way for the identifying part of an address to go missing. Every
 * tighter one (equality rather than containment) keeps the tag whenever the deposit wraps a
 * sentence around the URL, which protects nothing.
 */
function linkAddressSurvives(openTag: string, text: LinkText): boolean {
  const attribute = HREF_ATTRIBUTE.exec(openTag);
  const href = (attribute?.[1] ?? attribute?.[2] ?? attribute?.[3] ?? '').trim();
  if (href === '' || href.startsWith('#')) return true;
  if (text.includes(href)) return true;
  const target = href.replace(URI_SCHEME, '');
  return target !== '' && target !== href && text.includes(target);
}

/**
 * The elements a region holds directly, in deposit order. Depth is counted off the same
 * well-formed-tag match the strip uses, so a child's own nested markup travels with it and a
 * closing tag with no opener inside the region is ignored rather than closing the region's
 * first child early.
 */
function* topLevelElements(inner: string): Generator<string> {
  let depth = 0;
  let start = -1;
  for (const match of inner.matchAll(TAG)) {
    const [tag, close, , selfClose] = match as unknown as [string, string, string, string];
    if (close) {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && start >= 0) {
        yield inner.slice(start, match.index + tag.length);
        start = -1;
      }
    } else if (selfClose) {
      if (depth === 0) yield tag;
    } else {
      if (depth === 0) start = match.index;
      depth += 1;
    }
  }
}

/**
 * Pick the one encoding an `<alternatives>` wrapper's consumer is meant to read: its first
 * child that carries any text at all.
 *
 * Position rather than notation is what decides. The children are siblings with no marked
 * primary — unlike a MathML `<annotation>`, which the vocabulary itself defines as the second
 * copy — so preferring TeX over presentation MathML or the reverse would be this server
 * ranking notations it has no standing to rank, and would need extending every time the
 * vocabulary admits another encoding. Taking the first text-bearing child needs no such list:
 * an `<inline-graphic>` carries no text and is passed over on that basis, and a child element
 * nobody has seen before is handled by the same rule. What is selected is returned as it was
 * deposited, so the pass that follows classifies it like any other markup.
 *
 * A wrapper holding no child elements at all keeps its content whole. Nothing in it can be a
 * duplicate encoding, and dropping it would cost the reader text.
 *
 * What is selected is returned without a separator of its own; the wrapper's boundary is applied
 * around it by the caller, so the same construct spaces the same way whichever encoding a
 * publisher happened to deposit first.
 */
function firstAlternative(inner: string): string {
  let sawChild = false;
  for (const child of topLevelElements(inner)) {
    sawChild = true;
    if (/\S/.test(child.replace(/<[^>]*>/g, ''))) return child;
  }
  return sawChild ? '' : inner;
}

/**
 * A MathML formula as one expression in the sentence around it. Inside, the region is read by
 * `mathmlText` — its TeX annotation where it deposits one, otherwise its tree written out — with
 * no separator of its own and none of the whitespace a deposit pretty-prints between its tags,
 * which is insignificant in XML. A character reference in a token is text to that reading and
 * resolves in the decode afterwards, so an escaped `<` is a relation, never a tag.
 *
 * Outside is the opposite of inside: the region stands as its own token in the sentence and is
 * never a continuation of the word beside it, so it leaves a block boundary. A MathML deposit
 * carries the whole token — `<mmultiscripts><mi>Si</mi>…<mn>33</mn>` is all of `³³Si` — and
 * publishers routinely deposit no space against the prose, so a tight join there would read
 * `thin films of^{33}Siand partially filled`.
 */
function readMathml(inner: string): string {
  return ` ${mathmlText(inner)} `;
}

/**
 * Read closed numeric superscripts before stripping tags. A single token scan counts text
 * incompatible with a numeric script; nested scripts invalidate their parent, so accepted
 * spans never overlap and no nested body is rescanned or recursively rendered. With `escaped`,
 * an escaped script is read the same way, and closes only an escaped opener: the `&` that keys
 * its stack is in no element name, so the two kinds never share one.
 */
function readNumericSuperscripts(text: string, escaped: boolean): string {
  if (!text.includes('<') && !(escaped && text.includes('&lt;'))) return text;
  const openers = new Map<string, Array<{ start: number; content: number; invalid: number }>>();
  const edits: Array<{ start: number; end: number; from: number; to: number }> = [];
  const parts: string[] = [];
  let length = 0;
  let invalid = 0;
  let previous = 0;
  for (const match of text.matchAll(escaped ? ANY_TAG : TAG)) {
    const [tag] = match;
    const { close, escaped: isEscaped, name, selfClose } = tagOf(match.slice(1)) as Tag;
    const offset = match.index;
    const plain = decodeHtmlEntities(text.slice(previous, offset));
    parts.push(plain);
    length += plain.length;
    if (/[^0-9+.−-]/.test(plain)) invalid++;
    if (name === 'sup' || name === 'superscript') {
      const key = isEscaped ? `&${name}` : name;
      const stack = openers.get(key) ?? [];
      if (close) {
        const opener = stack.pop();
        if (opener && opener.invalid === invalid && length > opener.content) {
          let start = opener.start;
          while (start > 0 && /\s/.test(text.charAt(start - 1))) start--;
          edits.push({ start, end: offset + tag.length, from: opener.content, to: length });
        }
      } else if (!selfClose) {
        stack.push({ start: offset, content: length, invalid: invalid + 1 });
        openers.set(key, stack);
      }
      invalid++;
    } else if (!INLINE_ELEMENTS.includes(name)) {
      invalid++;
    }
    previous = offset + tag.length;
  }
  if (!edits.length) return text;
  const content = parts.join('');
  const output: string[] = [];
  previous = 0;
  for (const edit of edits) {
    const value = content.slice(edit.from, edit.to);
    output.push(text.slice(previous, edit.start), value.length === 1 ? `^${value}` : `^{${value}}`);
    previous = edit.end;
  }
  output.push(text.slice(previous));
  return output.join('');
}

/**
 * Where a structured abstract's structure sits in the text the strip pass returns, as offsets
 * into that text: each outermost heading's content, each section's end, and each list item's
 * two ends. Sections, lists, and items carry ids from one counter, so a later-opened one always
 * has the larger id, and a heading names the innermost section open where it starts (-1 at the
 * root), an item the innermost list (-1 outside any list).
 */
type OutlineMark =
  | { kind: 'title'; start: number; end: number; section: number }
  | { kind: 'section-end'; at: number; section: number }
  | { kind: 'item-start' | 'item-end'; at: number; item: number; list: number };

/**
 * Decide which of a field's escaped tags are markup, and respell every other `&lt;` in the field
 * as `&#60;` — which decodes to the same `<` but opens no escaped tag — so the decision travels in
 * the text through the passes after it, and nothing they do can make an escaped tag of text that
 * was not one. Undefined when no escaped tag is markup, and the field then reads exactly as it
 * would with no escaped tag in it.
 *
 * An escaped tag is markup unless it is an opener other than `br` that no later escaped closer of
 * its name closes and that does not directly follow, whitespace aside, an escaped closer of its
 * name. That opener is prose naming an element — `the TEI &lt;gap&gt; element`, `Use of
 * &lt;i&gt;` — and stays as written. Every other one is HTML the deposit escaped into its JATS: a
 * closer comes out whether or not an opener precedes it, since prose about an element does not
 * write its end tag, and an opener right after its own closer (`&lt;/P&gt;&lt;P&gt;`) begins the
 * next of a run of elements the deposit never closed.
 *
 * One scan decides every tag. Deposited tags are tokens in it too, so an escaped tag never reaches
 * across one, and one with a deposited tag between it and a closer does not directly follow that
 * closer. Each name keeps its own stack of escaped openers and a closer closes the last one open
 * of its name, so whatever is left on a stack when the scan ends is an opener nothing closes.
 */
function settleEscapedTags(text: string): string | undefined {
  if (!text.includes('&lt;')) return;
  const runs: Array<{ start: number; end: number; markup: boolean }> = [];
  const open = new Map<string, Array<{ markup: boolean }>>();
  let previousEnd = 0;
  /** The name of the escaped closer the last token was, when it was one. */
  let previousCloser: string | undefined;
  for (const match of text.matchAll(ANY_TAG)) {
    const { close, escaped, name, selfClose } = tagOf(match.slice(1)) as Tag;
    const end = match.index + match[0].length;
    if (escaped) {
      const run = { start: match.index, end, markup: true };
      runs.push(run);
      if (close) {
        const opener = open.get(name)?.pop();
        if (opener) opener.markup = true;
      } else if (!selfClose) {
        run.markup =
          name === 'br' ||
          (previousCloser === name && !/\S/.test(text.slice(previousEnd, match.index)));
        const stack = open.get(name);
        if (stack) stack.push(run);
        else open.set(name, [run]);
      }
    }
    previousCloser = escaped && close ? name : undefined;
    previousEnd = end;
  }
  const parts: string[] = [];
  let resume = 0;
  for (const run of runs) {
    if (!run.markup) continue;
    parts.push(
      text.slice(resume, run.start).replaceAll('&lt;', '&#60;'),
      text.slice(run.start, run.end),
    );
    resume = run.end;
  }
  if (parts.length === 0) return;
  parts.push(text.slice(resume).replaceAll('&lt;', '&#60;'));
  return parts.join('');
}

/** The separator removing an element of a class leaves — see `stripMarkup`. */
function separatorFor(
  verdict: Exclude<Verdict, 'keep'>,
  tag: string,
  offset: number,
  whole: string,
): string {
  if (verdict === 'tight') return '';
  if (verdict === 'block') return ' ';
  return separateWords(tag, offset, whole);
}

/**
 * Classify every well-formed tag in a string and remove the ones this surface recognizes as
 * markup, leaving the separator its class calls for. `surface` says what a name on none of the
 * class lists means, and whether an escaped tag can be markup; nothing else varies between
 * surfaces.
 *
 * An opening tag is removed on its own evidence; a closing tag is removed only if the matching
 * opener was itself removed. That asymmetry is what keeps an element from coming apart: a
 * `<span hidden>` fails the shape test — a valueless attribute is prose as far as the shape
 * rule can tell, and admitting one would reopen `<Bold statement about X>` — while its
 * attribute-free `</span>` matches the shape on its own. A lone closer has no claim to being a
 * tag beyond an opener that this pass already declined to treat as one.
 *
 * A link element is the one class decided per occurrence rather than per name: its opening tag
 * comes out, as a word boundary, only where its own text already carries the address, and its
 * closing tag follows the opener on the same bookkeeping as every other element. A self-closing
 * link wraps no text at all, so nothing there can carry the address.
 *
 * Given `outline`, the pass also records, in document order, where the structure it removed sits
 * in what it returns — see `OutlineMark`. A `title` nested in another belongs to the outer one's
 * content, and one the deposit never closes keeps an `end` of -1. Each closing tag is paired with
 * the opener the strip itself paired it with, the last unclosed one of its name, so the outline
 * never disagrees with which tags came out. The offsets are counted as the tags are replaced, so
 * finding them costs nothing beyond the pass.
 *
 * Where the surface reads escaped markup and the field holds some, every escaped tag left after
 * `settleEscapedTags` is markup and comes out with its class's separator, closed or not, pairing
 * only with escaped tags: the deposited bookkeeping — which openers came out, which links have no
 * closer, the outline — never sees one, so neither kind of tag can close the other. Each `&amp;`
 * in the text becomes `&`: the HTML the deposit escaped wrote `&nbsp;`, and the decode that
 * follows the strip resolves it.
 */
function stripTags(text: string, surface: Surface, outline?: OutlineMark[]): string {
  const settled = surface.escapedMarkup ? settleEscapedTags(text) : undefined;
  const escaped = settled !== undefined;
  text = readNumericSuperscripts(settled ?? text, escaped);
  const removed: string[] = [];
  /**
   * Link names whose closing tag is already known to be absent from the rest of the string.
   * The scan for one runs to the end when there is none, and tags are visited left to right,
   * so a name that failed once cannot succeed later — recording it is what keeps a field
   * packed with unterminated openers from costing a full scan apiece. The escaped set is the
   * same record for escaped links.
   */
  const unclosed = new Set<string>();
  const escapedUnclosed = new Set<string>();
  const linkText = linkTextReader(text, LINK_CLOSERS);
  const escapedLinkText = linkTextReader(text, ESCAPED_LINK_CLOSERS);
  /** Per escaped link name, whether each escaped opener still open kept its tags. */
  const escapedLinks = new Map<string, boolean[]>();
  const stripEscaped = (
    tag: string,
    { close, name, selfClose }: Tag,
    offset: number,
    whole: string,
  ): string => {
    let verdict = ELEMENT_VERDICTS.get(name) ?? surface.unlisted;
    if (verdict === 'keep') {
      const open = escapedLinks.get(name) ?? [];
      escapedLinks.set(name, open);
      if (close) {
        if (open.pop()) return tag;
      } else if (selfClose || escapedUnclosed.has(name)) {
        return tag;
      } else {
        const inner = escapedLinkText(offset + tag.length, name);
        if (inner === undefined) {
          escapedUnclosed.add(name);
          return tag;
        }
        const kept = !linkAddressSurvives(`<${tag.slice(4, -4)}>`, inner);
        open.push(kept);
        if (kept) return tag;
      }
      verdict = 'inline';
    }
    return separatorFor(verdict, tag, offset, whole);
  };
  const strip = (
    tag: string,
    { close, name, selfClose }: Tag,
    offset: number,
    whole: string,
  ): string => {
    let verdict = ELEMENT_VERDICTS.get(name) ?? surface.unlisted;
    if (verdict === 'keep') {
      if (close) {
        if (!removed.includes(name)) return tag;
      } else if (selfClose || unclosed.has(name)) {
        return tag;
      } else {
        const inner = linkText(offset + tag.length, name);
        if (inner === undefined) {
          unclosed.add(name);
          return tag;
        }
        if (!linkAddressSurvives(tag, inner)) return tag;
      }
      verdict = 'inline';
    }
    if (close) {
      const opener = removed.lastIndexOf(name);
      if (opener < 0) return tag;
      removed.splice(opener, 1);
    } else if (!selfClose) {
      removed.push(name);
    }
    return separatorFor(verdict, tag, offset, whole);
  };
  const pattern = escaped ? ANY_TAG_OR_AMPERSAND : TAG;
  /** A match's replacement, and the tag it was, if it was one rather than an `&amp;`. */
  const replace = (
    match: string,
    rest: Array<string | number | undefined>,
  ): { out: string; tag: Tag | undefined; offset: number } => {
    const whole = rest.at(-1) as string;
    const offset = rest.at(-2) as number;
    const tag = tagOf(rest.slice(0, -2) as Array<string | undefined>);
    if (!tag) return { out: '&', tag, offset };
    const out = (tag.escaped ? stripEscaped : strip)(match, tag, offset, whole);
    return { out, tag, offset };
  };
  if (!outline) return text.replace(pattern, (match: string, ...rest) => replace(match, rest).out);
  // How much longer the output is than the input, up to the tag being replaced.
  let shift = 0;
  let ids = 0;
  let titleDepth = 0;
  // Replaced at every outermost opener, before the closer that ends it can be reached.
  let heading: Extract<OutlineMark, { kind: 'title' }> = {
    kind: 'title',
    start: 0,
    end: -1,
    section: -1,
  };
  const sections: number[] = [];
  const lists: number[] = [];
  const items: Array<{ item: number; list: number }> = [];
  /** Record a removed opener or closer of one of the outlined elements, `at` its offset. */
  const record = (close: boolean, name: string, at: number, replaced: number): void => {
    switch (name) {
      case 'title':
        if (!close && titleDepth++ === 0) {
          heading = {
            kind: 'title',
            start: at + replaced,
            end: -1,
            section: sections.at(-1) ?? -1,
          };
          outline.push(heading);
        } else if (close && --titleDepth === 0) {
          heading.end = at;
        }
        break;
      case 'sec':
        if (close) outline.push({ kind: 'section-end', at, section: sections.pop() as number });
        else sections.push(ids++);
        break;
      case 'list':
        if (close) lists.pop();
        else lists.push(ids++);
        break;
      case 'list-item':
        if (close) {
          outline.push({ kind: 'item-end', at, ...(items.pop() as (typeof items)[number]) });
        } else {
          const opened = { item: ids++, list: lists.at(-1) ?? -1 };
          items.push(opened);
          outline.push({ kind: 'item-start', at, ...opened });
        }
        break;
    }
  };
  return text.replace(pattern, (match: string, ...rest) => {
    const { out, tag, offset } = replace(match, rest);
    // A tag returned whole was not removed; a closer is removed only beside its opener.
    if (tag && !tag.escaped && out !== match && !tag.selfClose) {
      record(tag.close, tag.name, offset + shift, out.length);
    }
    shift += out.length - match.length;
    return out;
  });
}

/**
 * Strip the markup a deposited string carries, and nothing else.
 *
 * One rule, two surfaces. A bracket is removed only when it is recognizable as markup, on three
 * tests applied in order:
 *
 * 1. **Shape.** The name follows `<` with no space, and the attribute tail is `name="value"`
 *    pairs rather than prose. This is what separates `<span class="smallcaps">` from
 *    `<Stack Overflow, https://…>`, `<Available from: http://…>`, and `<B. subtilis>` — all text
 *    a reader needs, and all of them read as a tag under a looser `<name\b[^>]*>`.
 * 2. **Region.** A MathML formula, a JATS structured citation, and an `<alternatives>` wrapper
 *    are matched end to end, because inside one there is no typed bracket to protect. A formula
 *    is read as one expression, keeping the operators its tree encodes as structure; a citation
 *    is emptied of tags; a wrapper holds one object encoded several ways and is reduced to its
 *    first text-bearing child, or the same expression reaches the reader twice. All or nothing:
 *    an unclosed region matches nothing and is left whole rather than half-consumed. The two
 *    formula-bearing regions leave a block boundary on their outer edge, because a formula
 *    stands as its own token in the sentence rather than continuing the word beside it.
 * 3. **Name.** Everywhere else the element name decides, on three shared classes plus a
 *    per-surface default. Numeric superscripts retain a caret marker; other scripts and inline
 *    formula wrappers leave nothing — `O<sub>2</sub>` is
 *    one formula and a space there splits it, `T<inf>c</inf>` is one symbol. Inline emphasis and
 *    the bare JATS citation fields are a word boundary and leave a space only where the text
 *    would otherwise run together — between two word characters, or where a sentence ends and
 *    the next word begins — so `<i>Ann. Probab.</i>, 49` closes up while
 *    `MOC.<bold>Methods</bold>` does not. Block elements always leave a space,
 *    because the text before one ends in a period rather than a word character and two citations
 *    packed into one field must not run together. Link elements are the one class decided per
 *    occurrence rather than per name, because what a removed `<a href>` costs depends on where
 *    its address is: see `linkAddressSurvives`.
 *
 * The surfaces differ in two things — what an unrecognized element name means, and whether a tag
 * escaped into the text can be markup — and they differ there because the two fields are not the
 * same kind of string. A title or abstract is deposited as JATS, so a raw `<` in it came out of
 * an XML document and is a tag by construction: an unrecognized name is structure (`<sec>`,
 * `<list-item>`, `<title>`) and is removed as a block boundary. HTML a publisher escaped into that
 * XML (`<jats:p>&lt;p&gt;…`) is markup too, read by the same three tests and removed the way the
 * same tags would be deposited unescaped, except that the regions and a structured abstract's
 * headings and items are read from deposited tags alone; an escaped tag that names an element
 * instead (`Use of &lt;i&gt;`) stays — see `settleEscapedTags`. A reference entry is a citation
 * string a publisher typed, where the same syntax carries a cited URL
 * (`<http://faostat.fao.org/…>`), a Miller index (`Silicon <100> nanowires`), a DOI fragment
 * (`<131::AID-QUA4>`), an acronym (`<IR>`), or a guillemet quotation (`<<ruptures>>`) — so an
 * unrecognized name is presumed content and stays, and an escaped tag is the publisher's text.
 * Everything else the two surfaces do is the same rule, so they cannot drift apart again.
 *
 * Every separator is decided against the string the tags sit in, escaped tags included: a tag
 * never counts as a word character, so removing one class can never create an adjacency another
 * class then misreads. `<span class="smallcaps">xvii</span><sup>e</sup>` is `xviie`, not
 * `xvii e`.
 */
function stripMarkup(raw: string, surface: Surface): string {
  return collapseWhitespace(stripTags(readRegions(raw), surface));
}

/**
 * The region half of `stripMarkup`, which both surfaces share: each region read or emptied, and
 * everything outside them left for the name-by-name pass.
 *
 * The `<alternatives>` selection runs before the others: it hands back one of its children as
 * deposited, and that child is a MathML formula as often as not.
 *
 * The block boundary is the wrapper's own, not the selected child's. A wrapper holds a formula,
 * and a formula stands as its own token in the sentence rather than continuing the word beside
 * it — the same reading that gives a MathML region its outer edge. It has to be the wrapper's,
 * because publishers deposit the encodings in either order: decided by the child, the same
 * construct would separate where the MathML came first and close up where the TeX did, and
 * `time scale<inline-formula>…` would read `time scale$\mathbb{T}$with`.
 */
function readRegions(raw: string): string {
  const selected = replaceRegions(raw, ALTERNATIVES, (inner) => ` ${firstAlternative(inner)} `);
  const read = replaceRegions(selected, MATHML, readMathml);
  return replaceRegions(read, CITATION, (inner) => stripTags(inner, CITATION_CONTENT));
}

/**
 * Strip the markup a JATS-deposited field carries — work titles, subtitles, container titles,
 * and abstracts. An element name on none of the shared classes is structure, and comes out as a
 * block boundary; escaped markup comes out too, with every reference escaped beside it one level
 * lower.
 */
export function stripJats(raw: string): string {
  return stripMarkup(raw, JATS_SURFACE);
}

/**
 * Strip the markup a reference free-text field carries. An element name on none of the shared
 * classes is presumed to be content a publisher typed, and stays, as does every escaped tag.
 */
export function stripReferenceMarkup(raw: string): string {
  return stripMarkup(raw, REFERENCE_SURFACE);
}

/**
 * Normalize a field publishers deposit as JATS/XML markup — work titles, subtitles, container
 * titles, and abstracts — by stripping markup before the baseline pass.
 *
 * Order matters: tags come out before entities are decoded, so an escaped tag reaches the strip
 * still escaped and is decided there — removed where it is markup the deposit escaped
 * (`&lt;p&gt;…&lt;/p&gt;`), kept as literal text where it names an element (`Use of &lt;i&gt;`).
 * Decoding first would turn both into tags.
 */
export function normalizeMarkupText(raw: string): string {
  return normalizeText(stripJats(raw));
}

/** The marks that already separate a list item from the one after it. */
const ITEM_END = /[.,;:?!]/;

/**
 * Normalize an abstract: the pass `normalizeMarkupText` applies, plus what a structured
 * abstract's headings and lists need to read apart from the text around them. `undefined` when
 * no text is left, so an abstract with none reads like one never deposited.
 *
 * A JATS deposit marks each heading as a `title`, which the JATS pass removes as a block boundary
 * like any other structure, so the heading runs straight into the first sentence of its section —
 * "Design A realist review" reads as prose. Here each heading ends with `: ` instead, unless its
 * text already ends in `.`, `:`, `?`, or `!`, and an empty one adds nothing. A heading heads the
 * text after it up to the end of its `sec`, or, outside any `sec`, up to the end of the abstract;
 * one with no text there — a section holding only a figure, an empty paragraph, or nothing — is
 * dropped, while text in a nested section counts for every section around it, so a parent heading
 * over subsections stays. A heading with no text kept before it that reads just "Abstract", in any
 * letter case, is dropped too: it labels the field it sits in. A label typed into the text itself,
 * and a leading "Summary", are the publisher's text and stay.
 *
 * The JATS pass likewise leaves a `list-item` boundary a bare space, so items that carry no
 * closing punctuation run together as one sentence. Here consecutive items of one list are joined
 * by `; ` unless the earlier one already ends in `.`, `,`, `;`, `:`, `?`, or `!` — its last
 * character only, as a heading's is read. An item with no text separates nothing, text between
 * two items is not an item, and a list's end stays a plain block boundary, like a paragraph's.
 *
 * The structure is located by the strip pass itself, and each piece of text between two marks is
 * normalized on its own. Every outlined tag is a block boundary and no character reference spans
 * a tag, so the pieces joined by a space read exactly as the whole would: nothing changes but the
 * headings and the item delimiters, and nothing is decoded twice. A heading is held until text
 * reaches its section or the section ends, so each is decided once, in one walk of the marks.
 */
export function normalizeAbstract(raw: string): string | undefined {
  const outline: OutlineMark[] = [];
  const stripped = stripTags(readRegions(raw), JATS_SURFACE, outline);
  const parts: string[] = [];
  /** Headings still waiting for text in their section, the innermost section's last. */
  const pending: Array<{ heading: string; section: number }> = [];
  /** Per open item, how many text pieces had been kept when it started. */
  const itemStart = new Map<number, number>();
  /** Per list, the value of `recorded` when its last item that carried text ended. */
  const itemEnd = new Map<number, number>();
  /** The item that owes its list's delimiter before its first text, if one does. */
  let owed: number | undefined;
  /** Text pieces kept and headings recorded so far: nothing came between two equal readings. */
  let recorded = 0;
  let texts = 0;
  let cursor = 0;

  /** Keep the text up to `end`, and decide everything waiting on whether there is any. */
  const flush = (end: number): void => {
    if (end <= cursor) return;
    const text = normalizeText(stripped.slice(cursor, end));
    cursor = end;
    if (text === '') return;
    if (owed !== undefined) {
      const last = parts.length - 1;
      const earlier = parts[last] as string;
      if (!ITEM_END.test(earlier.charAt(earlier.length - 1))) parts[last] = `${earlier};`;
      owed = undefined;
    }
    for (const { heading } of pending) {
      if (parts.length === 0 && /^abstract$/i.test(heading)) continue;
      parts.push(/[.:?!]$/.test(heading) ? heading : `${heading}:`);
    }
    pending.length = 0;
    parts.push(text);
    recorded++;
    texts++;
  };

  for (const mark of outline) {
    switch (mark.kind) {
      case 'title': {
        if (mark.end < 0) break;
        flush(mark.start);
        const heading = normalizeText(stripped.slice(mark.start, mark.end));
        cursor = mark.end;
        if (heading === '') break;
        pending.push({ heading, section: mark.section });
        recorded++;
        break;
      }
      case 'section-end':
        flush(mark.at);
        // A section opened after this one, still waiting here, is nested inside it.
        while ((pending.at(-1)?.section ?? -1) >= mark.section) pending.pop();
        break;
      case 'item-start':
        flush(mark.at);
        itemStart.set(mark.item, texts);
        if (itemEnd.get(mark.list) === recorded) owed = mark.item;
        break;
      case 'item-end':
        flush(mark.at);
        if (texts > (itemStart.get(mark.item) as number)) itemEnd.set(mark.list, recorded);
        itemStart.delete(mark.item);
        if (owed === mark.item) owed = undefined;
        break;
    }
  }
  flush(stripped.length);
  return parts.length > 0 ? parts.join(' ') : undefined;
}

/**
 * Normalize a reference entry's free text: strip markup, then the baseline pass. Same order;
 * an escaped tag here is the publisher's text however it pairs, so `&lt;i&gt;` stays literal.
 */
export function normalizeReferenceText(raw: string): string {
  return normalizeText(stripReferenceMarkup(raw));
}
