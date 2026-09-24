/**
 * @fileoverview CrossrefService wraps the Crossref REST API with polite-pool User-Agent injection,
 * per-request timeout, retry with exponential backoff, and pagination helpers. Offset paging is
 * honored on the name-search and works sub-resource routes, whose ceilings differ by an order of
 * magnitude — see NAME_SEARCH_OFFSET_CAP and WORKS_OFFSET_CAP. Cursor paging has no ceiling and
 * is available on `/works` and on both works sub-resources.
 *
 * Also home to the text normalization every tool projects free-text values through —
 * `normalizeText` for the baseline pass, `normalizeMarkupText` for the JATS-deposited fields,
 * and `normalizeReferenceText` for the deposited citation strings. The two markup passes are
 * one rule over one implementation (`stripMarkup`): a bracket is removed only when it is
 * recognizable as markup, by its shape, by sitting inside a markup region, or by its element
 * name — and they differ in exactly one thing, what an unrecognized element name means. A link
 * element is the one class settled per occurrence instead of per name, since its tags may come
 * out only where its own text already carries the address its `href` holds; an `<alternatives>`
 * wrapper is the one region that selects rather than strips, keeping the first of the encodings
 * it holds so one expression does not reach the reader twice and leaving the block boundary a
 * formula leaves, whichever encoding it kept; a MathML formula is the one region that is read
 * rather than emptied — see `mathml` — so the operators its tree encodes as structure survive
 * the loss of its tags. Every region is found by a scan linear in the field, however many of
 * its openers the deposit leaves unclosed. All three passes end in the same
 * baseline: character references decoded against the HTML5 named set in `html-entities`, then
 * whitespace collapsed.
 *
 * Home too to the publication date every work-projecting tool resolves through — `resolveWorkDate`
 * for a full record and `resolveWorkSummaryDate` for a work summary. Both take the record rather
 * than a chain of its date fields, so the one thing that could differ between call sites — when
 * the chain falls through to the next source — is settled here for all of them at once.
 *
 * What these passes produce is what `structuredContent` carries. The same values are escaped
 * again on their way into the Markdown of `content[]` — see `mdText` in `mcp-server/tools` —
 * so a bracket kept here is not consumed by the client's renderer instead.
 * @module services/crossref/crossref-service
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Context } from '@cyanheads/mcp-ts-core';
import {
  type ErrorContract,
  JsonRpcErrorCode,
  McpError,
  requestCancelled,
} from '@cyanheads/mcp-ts-core/errors';
import { httpErrorFromResponse, logger, withExtra, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { decodeHtmlEntities } from './html-entities.js';
import { type LinkText, linkTextReader } from './link-text.js';
import { mathmlText } from './mathml.js';
import type {
  CrossrefDateParts,
  CrossrefListMessage,
  CrossrefSingleMessage,
  RawCrossrefFunder,
  RawCrossrefJournal,
  RawCrossrefMember,
  RawCrossrefPrefix,
  RawCrossrefWork,
} from './types.js';
import {
  INVALID_CURSOR,
  INVALID_PARAMETER,
  MALFORMED_RESPONSE,
  REQUEST_TIMEOUT,
  rateLimitHint,
  SORT_CURSOR_CONFLICT,
  UNKNOWN_FILTER,
  UPSTREAM_UNAVAILABLE,
  upstreamEntryForStatus,
  upstreamError,
} from './upstream-errors.js';

/** Resolve package version at init time — avoids hardcoding the version string. */
function readPackageVersion(): string {
  try {
    // dist/services/crossref/ → dist/ → project root
    const pkgPath = fileURLToPath(new URL('../../../package.json', import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string };
    return pkg.version;
  } catch {
    return 'unknown';
  }
}

const _packageVersion = readPackageVersion();

/**
 * Collapse every run of whitespace to a single space and trim. Any run, not runs of two or
 * more: a lone newline inside a deposited string is enough to split a Markdown heading in
 * `content[]` and turn the indented continuation into a code block.
 */
function collapseWhitespace(raw: string): string {
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
const TAG = new RegExp(
  String.raw`<(\/?)(?:[A-Za-z][\w.-]*:)?([A-Za-z][\w.-]*)${TAG_ATTRIBUTES}(\/?)>`,
  'g',
);

/**
 * What removing an element does to the text around it — or, for `keep`, that the bracket does
 * not come out on the element name alone. An unrecognized name is `keep` on the reference
 * surface because it is presumed to be content; a link element is `keep` until its own text is
 * checked for the address its `href` carries.
 */
type Verdict = 'tight' | 'inline' | 'block' | 'keep';

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
 * Classify every well-formed tag in a string and remove the ones this surface recognizes as
 * markup, leaving the separator its class calls for. `unlisted` is the verdict for a name on
 * none of the class lists, and it is the only thing that varies between surfaces.
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
 */
function stripTags(text: string, unlisted: Verdict): string {
  const removed: string[] = [];
  /**
   * Link names whose closing tag is already known to be absent from the rest of the string.
   * The scan for one runs to the end when there is none, and tags are visited left to right,
   * so a name that failed once cannot succeed later — recording it is what keeps a field
   * packed with unterminated openers from costing a full scan apiece.
   */
  const unclosed = new Set<string>();
  const linkText = linkTextReader(text, LINK_CLOSERS);
  return text.replace(
    TAG,
    (
      tag: string,
      close: string,
      rawName: string,
      selfClose: string,
      offset: number,
      whole: string,
    ) => {
      const name = rawName.toLowerCase();
      let verdict = ELEMENT_VERDICTS.get(name) ?? unlisted;
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
      if (verdict === 'tight') return '';
      if (verdict === 'block') return ' ';
      return separateWords(tag, offset, whole);
    },
  );
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
 *    per-surface default. Scripts and inline formula wrappers leave nothing — `O<sub>2</sub>` is
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
 * The surfaces differ in exactly one thing — what an unrecognized element name means — and they
 * differ there because the two fields are not the same kind of string. A title or abstract is
 * deposited as JATS, so a raw `<` in it came out of an XML document and is a tag by
 * construction: an unrecognized name is structure (`<sec>`, `<list-item>`, `<title>`) and is
 * removed as a block boundary. A reference entry is a citation string a publisher typed, where
 * the same syntax carries a cited URL (`<http://faostat.fao.org/…>`), a Miller index
 * (`Silicon <100> nanowires`), a DOI fragment (`<131::AID-QUA4>`), an acronym (`<IR>`), or a
 * guillemet quotation (`<<ruptures>>`) — so an unrecognized name is presumed content and stays.
 * Everything else the two surfaces do is the same rule, so they cannot drift apart again.
 *
 * Every separator is decided against the string the tags sit in: a tag never counts as a word
 * character, so removing one class can never create an adjacency another class then misreads.
 * `<span class="smallcaps">xvii</span><sup>e</sup>` is `xviie`, not `xvii e`.
 */
function stripMarkup(raw: string, unlisted: Verdict): string {
  /**
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
  const selected = replaceRegions(raw, ALTERNATIVES, (inner) => ` ${firstAlternative(inner)} `);
  const read = replaceRegions(selected, MATHML, readMathml);
  const cited = replaceRegions(read, CITATION, (inner) => stripTags(inner, 'inline'));
  return collapseWhitespace(stripTags(cited, unlisted));
}

/**
 * Strip the markup a JATS-deposited field carries — work titles, subtitles, container titles,
 * and abstracts. An element name on none of the shared classes is structure, and comes out as a
 * block boundary.
 */
export function stripJats(raw: string): string {
  return stripMarkup(raw, 'block');
}

/**
 * Strip the markup a reference free-text field carries. An element name on none of the shared
 * classes is presumed to be content a publisher typed, and stays.
 */
export function stripReferenceMarkup(raw: string): string {
  return stripMarkup(raw, 'keep');
}

/**
 * Normalize a field publishers deposit as JATS/XML markup — work titles, subtitles, container
 * titles, and abstracts — by stripping markup before the baseline pass.
 *
 * Order matters: tags come out before entities are decoded, so a deposited `&lt;i&gt;` stays
 * literal text instead of decoding into a tag the strip pass would then eat.
 */
export function normalizeMarkupText(raw: string): string {
  return normalizeText(stripJats(raw));
}

/**
 * Normalize a reference entry's free text: strip markup, then the baseline pass. Same order,
 * same reason — a deposited `&lt;i&gt;` stays literal.
 */
export function normalizeReferenceText(raw: string): string {
  return normalizeText(stripReferenceMarkup(raw));
}

/** Format a year/month/day object as an ISO-style date string (e.g. "2023-04-15" or "2023"). */
export function formatDateParts(d: {
  year?: number | undefined;
  month?: number | undefined;
  day?: number | undefined;
}): string {
  const parts: string[] = [];
  if (d.year !== undefined) parts.push(String(d.year));
  if (d.month !== undefined) parts.push(String(d.month).padStart(2, '0'));
  if (d.day !== undefined) parts.push(String(d.day).padStart(2, '0'));
  return parts.join('-');
}

/**
 * Extract year/month/day from a Crossref date-parts array.
 *
 * A component Crossref does not know is deposited as `null` in the tuple rather than left off it:
 * a dissertation with no registered year arrives as `[[null]]`, and 8% of a random works draw
 * carries one somewhere in `issued`. Absent and null are the same fact for a caller — the
 * component is unknown — so both come back as an omitted field, which is what the output schemas
 * declare each of the three to be.
 *
 * The read stops at the first unknown component rather than skipping past it, because the tuple
 * is positional and the parts below one carry no meaning without it. `[[2020, null, 15]]` is a
 * year and a day-of-a-month nobody named, and rendering it through `formatDateParts` as `2020-15`
 * would state a date the deposit does not.
 */
export function parseDateParts(
  raw: { 'date-parts'?: Array<Array<number | null>> } | undefined,
): { year?: number; month?: number; day?: number } | undefined {
  const [year, month, day] = raw?.['date-parts']?.[0] ?? [];
  if (typeof year !== 'number') return;
  if (typeof month !== 'number') return { year };
  if (typeof day !== 'number') return { year, month };
  return { year, month, day };
}

/**
 * The date fields a work record answers "when was this published?" with, in preference order.
 *
 * `published` leads because it tracks the earliest of the two publication events, though Crossref
 * documents no definition for it; each event then answers for itself. `issued` is the one Crossref
 * does define that way, and it is the one of the four the API marks required — so a record with no
 * publication date at all carries its `[[null]]` placeholder there, with the other three absent.
 */
const WORK_DATE_SOURCES = [
  'published',
  'published-print',
  'published-online',
  'issued',
] as const satisfies ReadonlyArray<keyof RawCrossrefWork>;

/** What a work summary reads. `issued` is `crossref_get_work`'s last resort and no one else's. */
const WORK_SUMMARY_DATE_SOURCES = WORK_DATE_SOURCES.filter((source) => source !== 'issued');

/** The date-bearing part of a work record — every source in the chain, each of them optional. */
type WorkDateSources = Partial<Record<(typeof WORK_DATE_SOURCES)[number], CrossrefDateParts>>;

/**
 * Answer with the first source that names a date.
 *
 * The chain advances on **nothing, never on less**. A source Crossref deposits holding only
 * unknown components states no date — the same fact an absent field states, which is why
 * `parseDateParts` reports both as nothing — so it must not silence a later source that does
 * name one. Selecting the source *object* first and parsing once would do exactly that: it
 * reads presence as an answer, and hands back no publication date for a record that carries
 * one two fields along.
 *
 * It stops at the first date rather than continuing for a more precise one, because the sources
 * answer different questions: `published` tracks the earliest publication event and
 * `published-online` is one particular event, so a coarse `published` beside a precise
 * `published-online` is not a partial answer to be completed — refining across the two would
 * report the online date as the work's publication date. Sampled live, 580 of 6,000 randomly
 * drawn works carry a `published` coarser than a later source in this chain.
 */
function resolveDate(
  raw: WorkDateSources,
  sources: ReadonlyArray<(typeof WORK_DATE_SOURCES)[number]>,
): { year?: number; month?: number; day?: number } | undefined {
  for (const source of sources) {
    const date = parseDateParts(raw[source]);
    if (date !== undefined) return date;
  }
  return;
}

/**
 * The publication date of a full work record, `issued` included. Takes the whole record rather
 * than a chain of fields, so the order is settled here for every caller instead of being spelled
 * out — and re-spelled differently — at each one.
 */
export function resolveWorkDate(raw: WorkDateSources) {
  return resolveDate(raw, WORK_DATE_SOURCES);
}

/** The publication date of a work summary — the same rule over the three published-* sources. */
export function resolveWorkSummaryDate(raw: WorkDateSources) {
  return resolveDate(raw, WORK_SUMMARY_DATE_SOURCES);
}

/**
 * Unwrap a DOI from the resolver it was copied with — `https://doi.org/…`, the older
 * `dx.doi.org` host, or the `doi:` URI scheme — leaving the bare DOI Crossref's paths take.
 *
 * Every one of those forms names exactly one DOI, so the rewrite has a single reading and
 * costs the caller nothing: the argument is answerable as sent instead of being handed back
 * for the caller to edit. It is prefix removal and nothing more — a host that merely contains
 * `doi.org`, and any string that carries no recognized wrapper, comes back byte-exact, so the
 * tool schemas still reject what is not a DOI rather than hunting for one inside the argument.
 *
 * Shared by the DOI tools and the funder path, where the same wrappers arrive around a Funder
 * Registry DOI (`10.13039/100000001`) and a bare registry ID passes straight through.
 */
export function normalizeDoi(raw: string): string {
  return raw.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:/i, '');
}

/** Crossref works search options. */
export type WorksSearchOptions = {
  query?: string;
  queryBibliographic?: string;
  queryTitle?: string;
  queryAuthor?: string;
  queryContainerTitle?: string;
  filter?: Record<string, string>;
  fields?: string[];
  rows?: number;
  offset?: number;
  cursor?: string;
  sort?: string;
  order?: string;
};

/** Crossref journals search options. `offset` applies to the title-query path only. */
export type JournalsSearchOptions = {
  query?: string;
  issn?: string;
  rows?: number;
  offset?: number;
};

/** Crossref funders search options. `offset` applies to the name-query path only. */
export type FundersSearchOptions = {
  query?: string;
  funderDoi?: string;
  rows?: number;
  offset?: number;
};

/**
 * Paging options for the `/journals/{issn}/works` and `/funders/{id}/works` sub-resources.
 * `cursor` and `offset` are alternatives, not a pair — Crossref rejects the combination with
 * `cursor-with-offset-or-sample`, so `cursor` wins here and callers validate ahead of the call.
 * The two modes also order the list differently: an offset page is newest-published first, a
 * cursor walk newest-registered first — see `subResourcePageParams`.
 */
export type SubResourceWorksOptions = {
  rows: number;
  offset?: number;
  cursor?: string;
};

/** Result of a works search, including pagination metadata. */
export type WorksSearchResult = {
  totalResults: number;
  itemsPerPage: number;
  nextCursor?: string | undefined;
  items: RawCrossrefWork[];
};

/** Result of a journal/funder name search, carrying the upstream total so callers can page. */
export type ListSearchResult<T> = {
  totalResults: number;
  items: T[];
};

/**
 * Crossref caps offset paging on the `/journals` and `/funders` name-search routes at
 * `offset + rows <= 100000`; past that it answers HTTP 400 `integer-not-valid`.
 */
export const NAME_SEARCH_OFFSET_CAP = 100_000;

/**
 * The `/journals/{issn}/works` and `/funders/{id}/works` sub-resources cap ten times lower —
 * `offset + rows <= 10000` — and their rejection body directs callers to cursor paging. It is a
 * ceiling on the `offset` input alone: both routes accept `cursor=*` and return a `next-cursor`
 * token, which the tools thread as `works_cursor` / `nextWorksCursor` to read past it.
 */
export const WORKS_OFFSET_CAP = 10_000;

/**
 * Where the page after this one lives. `end` means the list is exhausted; `ceiling` means further
 * records exist upstream but the route's offset ceiling puts them out of reach through this input.
 * Those are different facts for a caller, so they are separate variants rather than one absent
 * offset — a page that stops at the ceiling has to say so or it reads as the end of the list.
 */
export type PageContinuation =
  | { kind: 'next'; offset: number }
  | { kind: 'end' }
  | { kind: 'ceiling' };

/** Classify the continuation for a page against its route's offset ceiling. */
export function nextPageOffset(args: {
  offset: number;
  returned: number;
  total: number;
  rows: number;
  cap: number;
}): PageContinuation {
  const next = args.offset + args.returned;
  if (next >= args.total) return { kind: 'end' };
  if (next + args.rows > args.cap) return { kind: 'ceiling' };
  return { kind: 'next', offset: next };
}

export class CrossrefService {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  constructor() {
    const cfg = getServerConfig();
    this.baseUrl = cfg.baseUrl;
    this.timeoutMs = cfg.timeoutMs;
    this.userAgent = cfg.mailto
      ? `crossref-mcp-server/${_packageVersion} (mailto:${cfg.mailto})`
      : `crossref-mcp-server/${_packageVersion}`;
  }

  /**
   * Retry boundary for a Crossref call. The default transient predicate is left in
   * place deliberately — the fix for "retries burned on a failure that can never
   * succeed" belongs one layer down, in `attempt()`, which returns every failure as an
   * `McpError` so the predicate classifies by error code. A custom predicate would only
   * re-sort the same unclassified exceptions by shape at the wrong layer. The same holds
   * for retry *cost*: the deadline-expiry opt-out sets `retryable: false` at its throw
   * site, which the stock predicate honors, so no budget arithmetic lives here.
   *
   * It is also where the request URL is recorded, which is why the whole retried call is
   * wrapped rather than returned straight through. The URL is both the field a Crossref
   * failure cannot be debugged without and the field that must not reach the caller:
   * `error.data` is forwarded as `structuredContent.error.data`, and `CROSSREF_BASE_URL`
   * is operator-configurable, so a deployment pointed at a private mirror would hand that
   * hostname — plus every query string this server builds — to every caller on every
   * failure. `ctx.log` is no refuge either, being dual-sink: a line written there ships to
   * the client as `notifications/message`. Only the Pino-only `logger` keeps the URL where
   * an operator can read it and a caller cannot.
   *
   * One line per failed call, after the retries rather than inside them, and none at all
   * for a caller cancellation — the caller hung up, which is nobody's upstream fault.
   */
  private async request<T>(path: string, ctx: Context): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    try {
      return await withRetry(() => this.attempt<T>(url, ctx), {
        operation: 'CrossrefService.request',
        baseDelayMs: 1_000,
        signal: ctx.signal,
      });
    } catch (err) {
      if (!(err instanceof McpError && err.code === JsonRpcErrorCode.RequestCancelled)) {
        logger.warning('Crossref request failed', withExtra(ctx, { url, cause: causeOf(err) }));
      }
      throw err;
    }
  }

  /**
   * One attempt at a Crossref request. Every failure leaves here as an `McpError` with a
   * classified code and a recovery hint. `withRetry`'s default predicate treats any
   * non-`McpError` throw as transient and the framework's classifier reads the outer
   * error's constructor name, so an unwrapped throw is wrong twice over: a `SyntaxError`
   * from `JSON.parse` is retried to exhaustion and then surfaces as a caller
   * `ValidationError`, and a `TypeError` from `fetch` surfaces as an `InternalError`
   * — an upstream outage reported as a bug in this server.
   */
  private async attempt<T>(url: string, ctx: Context): Promise<T> {
    /**
     * An `AbortController` aborted with a `TimeoutError` DOMException rather than
     * `AbortSignal.timeout()`: the reason is then recognizable by identity below,
     * instead of by matching "timed out" in a message the runtime owns.
     */
    const controller = new AbortController();
    const timeoutReason = new DOMException(
      `Crossref request timed out after ${this.timeoutMs}ms.`,
      'TimeoutError',
    );
    const timer = setTimeout(() => controller.abort(timeoutReason), this.timeoutMs);
    const signal = AbortSignal.any([ctx.signal, controller.signal]);

    try {
      let response: Response;
      try {
        response = await fetch(url, { signal, headers: { 'User-Agent': this.userAgent } });
      } catch (err) {
        throw this.transportError(err, controller.signal.reason === timeoutReason, ctx);
      }

      if (!response.ok) throw await this.responseError(response);

      let text: string;
      try {
        // The timeout still covers the body read — a stalled stream is a timeout too.
        text = await response.text();
      } catch (err) {
        throw this.transportError(err, controller.signal.reason === timeoutReason, ctx);
      }

      if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
        throw upstreamError(
          UPSTREAM_UNAVAILABLE,
          'Crossref returned HTML instead of JSON — likely rate-limited or under maintenance.',
        );
      }

      // A 200 with nothing in it is a truncated or dropped response, not a corrupt
      // serialization: retrying can succeed, and `malformed_response`'s advice to ask
      // for a smaller record has nothing to act on. Tested with a scan rather than
      // `trim()`, which copies the whole body on every successful request to answer.
      if (!/\S/.test(text)) {
        throw upstreamError(UPSTREAM_UNAVAILABLE, 'Crossref returned HTTP 200 with an empty body.');
      }

      try {
        return JSON.parse(text) as T;
      } catch (err) {
        throw upstreamError(
          MALFORMED_RESPONSE,
          'Crossref returned HTTP 200 with a body that is not valid JSON.',
          { cause: err },
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Classify a raw transport rejection. `timedOut` is decided by which signal fired, not
   * by the rejection value: `fetch` rejects with the abort *reason*, which may be any
   * value. The network path rejects with a `TypeError` whose message ("fetch failed")
   * says nothing — the real reason sits on `.cause`, which the framework's classifier
   * never reads.
   */
  private transportError(err: unknown, timedOut: boolean, ctx: Context): unknown {
    if (timedOut) {
      /**
       * Opted out of retry at the throw site rather than on the contract entry. A deadline
       * expiry is the one transient failure whose cost is set by this server's own clock
       * instead of by how fast the upstream answers, so each retry spends the full
       * `CROSSREF_TIMEOUT_MS` — four attempts plus backoff is ~47s of silence at the
       * default, past what an MCP client's own request budget usually allows, and the
       * recovery hint is then never read. 408 and 504 keep the full budget: they carry the
       * same reason but arrive at upstream speed, so retrying one costs nothing near the
       * deadline. The quantity that decides is which clock bounded the failure, not the code.
       */
      return upstreamError(
        REQUEST_TIMEOUT,
        `Crossref did not respond within ${this.timeoutMs}ms.`,
        {
          data: { timeoutMs: this.timeoutMs },
          retryable: false,
          cause: err,
        },
      );
    }
    // Caller cancellation, not an upstream failure — withRetry exits on an aborted signal.
    if (ctx.signal.aborted)
      return requestCancelled('Crossref request cancelled by caller.', undefined, { cause: err });
    return upstreamError(UPSTREAM_UNAVAILABLE, `Crossref could not be reached: ${causeOf(err)}`, {
      cause: err,
    });
  }

  /**
   * Convert a non-2xx response into a classified error carrying recovery.
   *
   * Crossref rejecting the request is the caller's to fix, and becomes a declared rejection
   * reason keyed on Crossref's own `type`: every 400, and the one 404 that is a rejection
   * rather than a missing record — a `cursor-invalid` body. Any other 404 passes through as
   * `httpErrorFromResponse` classified it, for the tool handlers to turn into their own typed
   * not-found reasons; the upstream statuses are re-classified onto the upstream contract.
   */
  private async responseError(response: Response): Promise<McpError> {
    if (response.status === 400) return crossrefRejection(await readRejected(response));
    if (response.status === 404) {
      const rejected = await readRejected(response);
      if (rejected?.some((entry) => entry.type === 'cursor-invalid')) {
        return crossrefRejection(rejected);
      }
    }

    const retryAfter = response.headers.get('retry-after');
    /**
     * Neither the URL nor the body reaches `error.data`, which is forwarded to the caller.
     * `includeUrl` is left at its default: the framework stopped putting `response.url` there
     * in 0.13.4, and this server's base URL is operator-set. `captureBody` is turned off: a
     * Crossref 5xx body is a Java exception with a stack excerpt, which tells the caller
     * nothing to do, and the status and message already say what failed. `request()` logs the
     * URL on the sink an operator reads.
     */
    const error = await httpErrorFromResponse(response, {
      service: 'Crossref',
      captureBody: false,
    });
    const entry = upstreamEntryForStatus(response.status);
    if (!entry) return error;

    return upstreamError(entry, error.message, {
      data: error.data,
      // The concrete wait is only reachable from content[] through the hint —
      // error.data.retryAfter never reaches a content-only client.
      hint:
        entry.code === JsonRpcErrorCode.RateLimited && retryAfter
          ? rateLimitHint(retryAfter)
          : undefined,
    });
  }

  /**
   * Fetch a single work by DOI. Returns null when the DOI is not found (404).
   * Lets the caller (tool handler) throw the appropriate typed error.
   */
  async getWork(doi: string, ctx: Context): Promise<RawCrossrefWork | null> {
    try {
      const envelope = await this.request<CrossrefSingleMessage<RawCrossrefWork>>(
        `/works/${encodeURIComponent(doi)}`,
        ctx,
      );
      return envelope.message;
    } catch (err) {
      // httpErrorFromResponse maps 404 → McpError(NotFound); the upstream contract
      // deliberately leaves 404 alone so it arrives here unmodified.
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) return null;
      throw err;
    }
  }

  /**
   * Fetch a Crossref member (publisher/organization) by numeric ID. Returns null on 404,
   * letting the caller throw the appropriate typed error. Mirrors getWork()'s 404→null pattern.
   */
  async getMember(id: number, ctx: Context): Promise<RawCrossrefMember | null> {
    try {
      const envelope = await this.request<CrossrefSingleMessage<RawCrossrefMember>>(
        `/members/${encodeURIComponent(String(id))}`,
        ctx,
      );
      return envelope.message;
    } catch (err) {
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) return null;
      throw err;
    }
  }

  /**
   * Resolve a DOI prefix (e.g. "10.1038") to its owning member. Returns null on 404.
   * Same 404→null pattern as getWork()/getMember().
   */
  async getPrefix(prefix: string, ctx: Context): Promise<RawCrossrefPrefix | null> {
    try {
      const envelope = await this.request<CrossrefSingleMessage<RawCrossrefPrefix>>(
        `/prefixes/${encodeURIComponent(prefix)}`,
        ctx,
      );
      return envelope.message;
    } catch (err) {
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) return null;
      throw err;
    }
  }

  /** Search works with filter, field selection, and cursor/offset pagination. */
  async searchWorks(opts: WorksSearchOptions, ctx: Context): Promise<WorksSearchResult> {
    const params = new URLSearchParams();
    if (opts.query) params.set('query', opts.query);
    // Field-specific query.* params scope matching to one indexed field and combine
    // with each other and with the generic query. Keys are hyphenated per Crossref.
    if (opts.queryBibliographic) params.set('query.bibliographic', opts.queryBibliographic);
    if (opts.queryTitle) params.set('query.title', opts.queryTitle);
    if (opts.queryAuthor) params.set('query.author', opts.queryAuthor);
    if (opts.queryContainerTitle) params.set('query.container-title', opts.queryContainerTitle);
    if (opts.rows != null) params.set('rows', String(opts.rows));

    if (opts.cursor) {
      params.set('cursor', opts.cursor);
    } else if (opts.offset != null && opts.offset > 0) {
      params.set('offset', String(opts.offset));
    }

    if (opts.sort) params.set('sort', opts.sort);
    if (opts.order) params.set('order', opts.order);

    if (opts.filter && Object.keys(opts.filter).length > 0) {
      const filterStr = Object.entries(opts.filter)
        .map(([k, v]) => `${k}:${v}`)
        .join(',');
      assertIssnFilters(filterStr);
      params.set('filter', filterStr);
    }

    /**
     * select= only on /works (search), never on /works/{doi}.
     *
     * DOI is force-included in every projection: it is the work summary's only
     * identifier and the sole key that chains into /works/{doi}, so a projection
     * that drops it yields records nothing downstream can resolve. Crossref's
     * select names are case-sensitive ("DOI" is valid, "doi" is rejected as
     * select-not-available), so the dedupe matches exactly. crossref_search_works
     * admits only the names its summary projects, so a miscased or unprojected
     * name is refused by the tool schema before it reaches here.
     */
    if (opts.fields && opts.fields.length > 0) {
      const fields = opts.fields.includes('DOI') ? opts.fields : ['DOI', ...opts.fields];
      params.set('select', fields.join(','));
    }

    const qs = params.toString();
    const envelope = await this.request<CrossrefListMessage<RawCrossrefWork>>(
      `/works${qs ? `?${qs}` : ''}`,
      ctx,
    );
    return toWorksSearchResult(envelope.message);
  }

  /**
   * Search journals by query, or fetch one by ISSN. The ISSN path is a single-record lookup,
   * so it reports a total of 1 and ignores `offset`.
   */
  async searchJournals(
    opts: JournalsSearchOptions,
    ctx: Context,
  ): Promise<ListSearchResult<RawCrossrefJournal>> {
    if (opts.issn) {
      const envelope = await this.request<CrossrefSingleMessage<RawCrossrefJournal>>(
        `/journals/${encodeURIComponent(opts.issn)}`,
        ctx,
      );
      return { totalResults: 1, items: [envelope.message] };
    }
    const params = new URLSearchParams();
    if (opts.query) params.set('query', opts.query);
    if (opts.rows != null) params.set('rows', String(opts.rows));
    if (opts.offset != null && opts.offset > 0) params.set('offset', String(opts.offset));
    const qs = params.toString();
    const envelope = await this.request<CrossrefListMessage<RawCrossrefJournal>>(
      `/journals${qs ? `?${qs}` : ''}`,
      ctx,
    );
    return { totalResults: envelope.message['total-results'], items: envelope.message.items };
  }

  /**
   * Fetch a page of works for a specific journal by ISSN, most recent first — by publication
   * date on an offset page, by registration date on a cursor walk.
   */
  async getJournalWorks(
    issn: string,
    opts: SubResourceWorksOptions,
    ctx: Context,
  ): Promise<WorksSearchResult> {
    const envelope = await this.request<CrossrefListMessage<RawCrossrefWork>>(
      `/journals/${encodeURIComponent(issn)}/works?${subResourcePageParams(opts)}`,
      ctx,
    );
    return toWorksSearchResult(envelope.message);
  }

  /**
   * Search funders by query, or fetch one by funder DOI. The DOI path is a single-record
   * lookup, so it reports a total of 1 and ignores `offset`.
   */
  async searchFunders(
    opts: FundersSearchOptions,
    ctx: Context,
  ): Promise<ListSearchResult<RawCrossrefFunder>> {
    if (opts.funderDoi) {
      const envelope = await this.request<CrossrefSingleMessage<RawCrossrefFunder>>(
        `/funders/${encodeURIComponent(normalizeDoi(opts.funderDoi))}`,
        ctx,
      );
      return { totalResults: 1, items: [envelope.message] };
    }
    const params = new URLSearchParams();
    if (opts.query) params.set('query', opts.query);
    if (opts.rows != null) params.set('rows', String(opts.rows));
    if (opts.offset != null && opts.offset > 0) params.set('offset', String(opts.offset));
    const qs = params.toString();
    const envelope = await this.request<CrossrefListMessage<RawCrossrefFunder>>(
      `/funders${qs ? `?${qs}` : ''}`,
      ctx,
    );
    return { totalResults: envelope.message['total-results'], items: envelope.message.items };
  }

  /**
   * Fetch a page of works for a specific funder by funder DOI/ID, most recent first — by
   * publication date on an offset page, by registration date on a cursor walk. Ordered the
   * same way as `getJournalWorks`, so the two works lists agree.
   */
  async getFunderWorks(
    funderId: string,
    opts: SubResourceWorksOptions,
    ctx: Context,
  ): Promise<WorksSearchResult> {
    const id = normalizeDoi(funderId);
    const envelope = await this.request<CrossrefListMessage<RawCrossrefWork>>(
      `/funders/${encodeURIComponent(id)}/works?${subResourcePageParams(opts)}`,
      ctx,
    );
    return toWorksSearchResult(envelope.message);
  }
}

/**
 * The most specific message available for a transport rejection. `fetch` wraps the real
 * failure — ECONNRESET, ENOTFOUND — in a `TypeError` whose own message is the useless
 * "fetch failed", so the cause is what a caller can act on.
 */
function causeOf(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  return err.cause instanceof Error ? err.cause.message : err.message;
}

/** One input Crossref named in a rejection: its own `type` for the failure, and the value. */
type RejectedInput = { type: string; value: string; message: string };

/**
 * The entries of a Crossref rejection body — `{"message": [{type, value, message}, …]}`, the
 * shape both the 400 `validation-failure` and the 404 `resource-failure` bodies take — or
 * `undefined` when the body is anything else. Consumes the response body. `value` is the
 * rejected input as sent, or a parameter name (`"sort"`) when the rejection is about a
 * combination; the offset rejections carry it as a number.
 */
async function readRejected(response: Response): Promise<RejectedInput[] | undefined> {
  let body: unknown;
  try {
    body = JSON.parse(await response.text());
  } catch {
    return;
  }
  const entries = (body as { message?: unknown } | null)?.message;
  if (!Array.isArray(entries)) return;
  return entries.map((entry: { type?: unknown; value?: unknown; message?: unknown }) => ({
    type: String(entry?.type ?? ''),
    value: entry?.value == null ? '' : String(entry.value),
    message: typeof entry?.message === 'string' ? entry.message : '',
  }));
}

/** The reason each Crossref rejection `type` is declared under; anything else is `invalid_parameter`. */
const REJECTION_REASONS: Record<string, ErrorContract> = {
  'filter-not-available': UNKNOWN_FILTER,
  'sort-criteria-incompatible-with-cursor': SORT_CURSOR_CONFLICT,
  'cursor-invalid': INVALID_CURSOR,
};

/**
 * The hyphenated spelling of an underscored filter key, when Crossref lists it as a valid
 * filter for the route. The list rides the `filter-not-available` message; a key that only
 * hyphenates into another unknown key (`is_open_access`) gets no suggestion, since offering
 * one would send the caller to a second rejection.
 */
function filterSuggestion(rejected: RejectedInput): string | undefined {
  if (!rejected.value.includes('_')) return;
  const candidate = rejected.value.replace(/_/g, '-');
  const listed = /Valid filters for this route are:(.*)$/s.exec(rejected.message)?.[1];
  const valid = listed?.split(',').map((key) => key.trim());
  return valid?.includes(candidate) ? candidate : undefined;
}

/**
 * One rejected input, as a phrase: the value quoted, then Crossref's own statement of the form it
 * takes. An unknown filter drops Crossref's sentence, which is ninety-odd valid keys long, for the
 * suggestion that matters. No rejection here quotes a blank filter value — `crossref_search_works`
 * drops a blank value before the request is built.
 */
function describeRejected(rejected: RejectedInput): string {
  if (rejected.type === 'filter-not-available') {
    const suggestion = filterSuggestion(rejected);
    return `filter key "${rejected.value}" is not a Crossref filter${suggestion ? ` — did you mean "${suggestion}"?` : ''}`;
  }
  const subject = `"${rejected.value}"`;
  const detail = collapseWhitespace(rejected.message);
  return detail ? `${subject} — ${detail}` : subject;
}

/**
 * Crossref's rejection of the request as a declared reason. The reason follows the first
 * entry, `data.rejected` lists every one as `{type, value}`, and the message renders each in
 * turn. Nothing of the upstream response — body, status, URL — goes on `data`: the parsed
 * entries are the part a caller can act on. A body that did not parse is still the caller's
 * rejection, and lands on `invalid_parameter` with an empty `rejected`.
 */
function crossrefRejection(rejected: RejectedInput[] | undefined): McpError {
  const first = rejected?.[0];
  if (!first) {
    return upstreamError(
      INVALID_PARAMETER,
      'Crossref rejected the request with HTTP 400 and no reason it could parse. Check that filter keys are hyphenated and that each filter value has the form its key takes.',
      { data: { rejected: [] } },
    );
  }
  const entry = REJECTION_REASONS[first.type] ?? INVALID_PARAMETER;
  const suggestion = first.type === 'filter-not-available' ? filterSuggestion(first) : undefined;
  return upstreamError(
    entry,
    `Crossref rejected the request: ${rejected.map(describeRejected).join('; ')}`,
    {
      data: {
        rejected: rejected.map(({ type, value }) => ({ type, value })),
        ...(suggestion !== undefined && { suggestion }),
      },
    },
  );
}

/**
 * How Crossref reads an `issn` filter value: it keeps only the digits and `X`s, then takes the
 * first run of seven digits and a check character. So it is lenient about separators —
 * `0028–0836`, `0028 0836`, and `ISSN 0028-0836` all resolve to the same journal — and reads
 * `0028-08361` as `0028-0836`. A value with no such run is the one it cannot read.
 */
const NOT_ISSN_CHARACTER = /[^\dX]/gi;
const ISSN_RUN = /\d{7}[\dX]/i;

/**
 * Refuse an `issn` filter value Crossref cannot read, before the request. Crossref answers one
 * with HTTP 500 and a Java exception rather than a validation failure, which would classify as
 * an outage, be retried, and tell the caller to resend the query unchanged — the one move that
 * cannot work. Everything Crossref does read goes through as written.
 *
 * The check walks the serialized filter string the way Crossref splits it, one `key:value` pair
 * per comma, so it sees what Crossref sees: an `issn:` pair written inside another value
 * (`0028-0836,issn:1476-4687`, which Crossref reads as two ISSNs) is checked on its own.
 */
function assertIssnFilters(filterStr: string): void {
  for (const pair of filterStr.split(',')) {
    if (!pair.startsWith('issn:')) continue;
    const value = pair.slice('issn:'.length);
    if (ISSN_RUN.test(value.replace(NOT_ISSN_CHARACTER, ''))) continue;
    const subject =
      value.trim() === '' ? 'filter "issn" was sent blank' : `filter "issn" value "${value}"`;
    throw upstreamError(
      INVALID_PARAMETER,
      `${subject} is not an ISSN — the issn filter takes NNNN-NNNX: four digits, three digits, then a check digit or X, the hyphen optional.`,
      {
        data: { rejected: [{ type: 'issn-not-valid', value }] },
        hint: 'Pass the issn filter one ISSN in NNNN-NNNX form, for example {"issn":"0028-0836"}; crossref_search_journals lists the ISSNs a journal is registered under.',
      },
    );
  }
}

/**
 * The query string for one page of a works sub-resource. Cursor and offset are mutually
 * exclusive upstream, so only one is ever written — the same precedence `searchWorks` uses on
 * `/works` — and an offset of 0 is the start of the list, left off the query string entirely.
 *
 * Both modes read newest first, by different dates. An offset page sorts by publication date.
 * A cursor walk cannot: Crossref refuses every publication-date sort alongside a cursor
 * (`sort-criteria-incompatible-with-cursor`), and a walk with no sort runs oldest-registered
 * first, which would put decades-old works at the head of a "most recent" list. So a walk sorts
 * by `created` — the date the DOI was first registered — which Crossref walks by cursor and
 * which never changes under a record, so a walk cannot reorder mid-way.
 */
function subResourcePageParams(opts: SubResourceWorksOptions): URLSearchParams {
  const params = new URLSearchParams({ rows: String(opts.rows) });
  if (opts.cursor) {
    params.set('cursor', opts.cursor);
    params.set('sort', 'created');
  } else {
    if (opts.offset != null && opts.offset > 0) params.set('offset', String(opts.offset));
    params.set('sort', 'published');
  }
  params.set('order', 'desc');
  return params;
}

function toWorksSearchResult(
  msg: CrossrefListMessage<RawCrossrefWork>['message'],
): WorksSearchResult {
  return {
    totalResults: msg['total-results'],
    itemsPerPage: msg['items-per-page'],
    items: msg.items,
    ...(msg['next-cursor'] !== undefined && { nextCursor: msg['next-cursor'] }),
  };
}

// --- Init/accessor pattern ---

let _service: CrossrefService | undefined;

export function initCrossrefService(): void {
  _service = new CrossrefService();
  const cfg = getServerConfig();
  if (!cfg.mailto) {
    logger.warning(
      '[crossref-mcp-server] CROSSREF_MAILTO is not set — using the anonymous Crossref pool with stricter rate limits. ' +
        'Set CROSSREF_MAILTO to your contact email to enable polite-pool priority access.',
    );
  }
}

export function getCrossrefService(): CrossrefService {
  if (!_service) {
    throw new Error('CrossrefService not initialized — call initCrossrefService() in setup()');
  }
  return _service;
}
