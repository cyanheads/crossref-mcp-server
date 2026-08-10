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
 * out only where its own text already carries the address its `href` holds. All three passes
 * end in the same baseline: character references decoded against the HTML5 named set in
 * `html-entities`, then whitespace collapsed.
 * @module services/crossref/crossref-service
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError, validationError } from '@cyanheads/mcp-ts-core/errors';
import { httpErrorFromResponse, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { decodeHtmlEntities } from './html-entities.js';
import type {
  CrossrefListMessage,
  CrossrefSingleMessage,
  RawCrossrefFunder,
  RawCrossrefJournal,
  RawCrossrefMember,
  RawCrossrefPrefix,
  RawCrossrefWork,
} from './types.js';
import {
  MALFORMED_RESPONSE,
  REQUEST_TIMEOUT,
  rateLimitHint,
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
 * well formed in any case.
 */
const TAG_ATTRIBUTES = String.raw`(?:\s+[A-Za-z_:][\w.:-]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"']+))*\s*`;

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
 * A whole MathML formula, matched end to end so a strip can never half-consume one. Removing
 * the region outright would delete the symbol the sentence is about.
 */
const MATHML_SPAN =
  /<(?:[A-Za-z][\w.-]*:)?math\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z][\w.-]*:)?math\s*>/gi;

/**
 * The alternate encoding a MathML deposit carries beside its presentation markup — the same
 * expression a second time, in TeX or in Content MathML. Emitting both renders one formula
 * twice, so the annotation and its payload come out with the region's tags.
 */
const MATHML_ANNOTATION =
  /<(?:[A-Za-z][\w.-]*:)?annotation(?:-xml)?\b[^>]*>[\s\S]*?<\/(?:[A-Za-z][\w.-]*:)?annotation(?:-xml)?\s*>/gi;

/**
 * A JATS structured citation deposited whole into a free-text field, matched end to end the
 * way a MathML formula is. Inside one, every bracket is a tag by construction — nobody types
 * a Miller index inside `<mixed-citation>` — so the name-by-name allow-list does not apply
 * there and the whole vocabulary comes out, however it is spelled.
 */
const CITATION_ELEMENTS = ['mixed-citation', 'element-citation', 'nlm-citation', 'citation'];
const CITATION_SPAN = new RegExp(
  String.raw`<(?:[A-Za-z][\w.-]*:)?(?:${CITATION_ELEMENTS.join('|')})\b${TAG_ATTRIBUTES}>([\s\S]*?)<\/(?:[A-Za-z][\w.-]*:)?(?:${CITATION_ELEMENTS.join('|')})\s*>`,
  'gi',
);

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
 */
const LINK_CLOSERS = new Map(
  LINK_ELEMENTS.map(
    (name) => [name, new RegExp(String.raw`</(?:[A-Za-z][\w.-]*:)?${name}\s*>`, 'gi')] as const,
  ),
);

/**
 * The text a link element wraps, with any markup inside it removed and whitespace collapsed —
 * what a reader is left holding if the element's own tags come out. Undefined when the deposit
 * never closes the element, the one case where the text cannot be seen at all.
 */
function linkText(whole: string, from: number, name: string): string | undefined {
  const closer = LINK_CLOSERS.get(name);
  if (!closer) return;
  closer.lastIndex = from;
  const close = closer.exec(whole);
  if (!close) return;
  return collapseWhitespace(whole.slice(from, close.index).replace(/<[^>]*>/g, ''));
}

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
function linkAddressSurvives(openTag: string, text: string): boolean {
  const attribute = HREF_ATTRIBUTE.exec(openTag);
  const href = (attribute?.[1] ?? attribute?.[2] ?? attribute?.[3] ?? '').trim();
  if (href === '' || href.startsWith('#')) return true;
  if (text.includes(href)) return true;
  const target = href.replace(URI_SCHEME, '');
  return target !== '' && target !== href && text.includes(target);
}

/**
 * Empty a MathML formula of its markup, so the expression reads as one token —
 * `<msub><mi>Airy</mi><mn>2</mn></msub>` is `Airy2`. Inside a region every bracket is a tag by
 * construction, so neither the shape test nor the allow-list has anything to protect: the tags
 * come out with no separator, and the whitespace a deposit pretty-prints between them comes out
 * with them, since it is insignificant in XML. A formula that needs a visible space writes it as
 * a character reference, which the strip does not touch and the decode resolves afterwards.
 *
 * Outside is the opposite of inside: the region stands as its own token in the sentence and is
 * never a continuation of the word beside it, so it leaves a block boundary. A MathML deposit
 * carries the whole token — `<mmultiscripts><mi>Si</mi>…<mn>33</mn>` is all of `³³Si` — and
 * publishers routinely deposit no space against the prose, so a tight join there would read
 * `thin films ofSi33and partially filled`.
 */
function stripMathml(inner: string): string {
  const formula = inner
    .replace(MATHML_ANNOTATION, '')
    .split(/<[^>]*>/)
    .map((run) => run.trim())
    .join('');
  return ` ${formula} `;
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
          const inner = linkText(whole, offset + tag.length, name);
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
 * 2. **Region.** A MathML formula and a JATS structured citation are matched end to end and
 *    emptied of tags, because inside one there is no typed bracket to protect. All or nothing:
 *    an unclosed region matches nothing and is left whole rather than half-consumed.
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
  return collapseWhitespace(
    stripTags(
      raw
        .replace(MATHML_SPAN, (_, inner: string) => stripMathml(inner))
        .replace(CITATION_SPAN, (_, inner: string) => stripTags(inner, 'inline')),
      unlisted,
    ),
  );
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

/** Extract year/month/day from a Crossref date-parts array. Returns undefined when no parts exist. */
export function parseDateParts(
  raw: { 'date-parts'?: Array<Array<number>> } | undefined,
): { year?: number; month?: number; day?: number } | undefined {
  const parts = raw?.['date-parts']?.[0];
  if (!parts?.length) return;
  return {
    ...(parts[0] !== undefined && { year: parts[0] }),
    ...(parts[1] !== undefined && { month: parts[1] }),
    ...(parts[2] !== undefined && { day: parts[2] }),
  };
}

/** Strip URL/doi: prefix from a funder DOI, yielding a bare registry ID for the Crossref path. */
export function normalizeFunderId(raw: string): string {
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
   */
  private request<T>(path: string, ctx: Context): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    return withRetry(() => this.attempt<T>(url, ctx), {
      operation: 'CrossrefService.request',
      baseDelayMs: 1_000,
      signal: ctx.signal,
    });
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
        throw this.transportError(err, url, controller.signal.reason === timeoutReason, ctx);
      }

      if (!response.ok) throw await this.responseError(response, url);

      let text: string;
      try {
        // The timeout still covers the body read — a stalled stream is a timeout too.
        text = await response.text();
      } catch (err) {
        throw this.transportError(err, url, controller.signal.reason === timeoutReason, ctx);
      }

      if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
        throw upstreamError(
          UPSTREAM_UNAVAILABLE,
          'Crossref returned HTML instead of JSON — likely rate-limited or under maintenance.',
          { data: { url } },
        );
      }

      // A 200 with nothing in it is a truncated or dropped response, not a corrupt
      // serialization: retrying can succeed, and `malformed_response`'s advice to ask
      // for a smaller record has nothing to act on. Tested with a scan rather than
      // `trim()`, which copies the whole body on every successful request to answer.
      if (!/\S/.test(text)) {
        throw upstreamError(
          UPSTREAM_UNAVAILABLE,
          'Crossref returned HTTP 200 with an empty body.',
          { data: { url } },
        );
      }

      try {
        return JSON.parse(text) as T;
      } catch (err) {
        throw upstreamError(
          MALFORMED_RESPONSE,
          'Crossref returned HTTP 200 with a body that is not valid JSON.',
          { data: { url }, cause: err },
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
  private transportError(err: unknown, url: string, timedOut: boolean, ctx: Context): unknown {
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
          data: { url, timeoutMs: this.timeoutMs },
          retryable: false,
          cause: err,
        },
      );
    }
    // Caller cancellation, not an upstream failure — withRetry exits on an aborted signal.
    if (ctx.signal.aborted) return err;
    return upstreamError(UPSTREAM_UNAVAILABLE, `Crossref could not be reached: ${causeOf(err)}`, {
      data: { url },
      cause: err,
    });
  }

  /**
   * Convert a non-2xx response into a classified error carrying recovery. Statuses the
   * caller owns keep their existing treatment: 400 surfaces Crossref's own
   * validation-failure detail, and everything else outside the upstream set (404 above
   * all) passes through as `httpErrorFromResponse` classified it, for the tool handlers
   * to turn into their own typed reasons.
   */
  private async responseError(response: Response, url: string): Promise<McpError> {
    if (response.status === 400) return crossrefValidationError(response);

    const retryAfter = response.headers.get('retry-after');
    const error = await httpErrorFromResponse(response, { service: 'Crossref', data: { url } });
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
      params.set('filter', filterStr);
    }

    /**
     * select= only on /works (search), never on /works/{doi}.
     *
     * DOI is force-included in every projection: it is the work summary's only
     * identifier and the sole key that chains into /works/{doi}, so a projection
     * that drops it yields records nothing downstream can resolve. Crossref's
     * select names are case-sensitive ("DOI" is valid, "doi" is rejected as
     * select-not-available), so the dedupe matches exactly — a caller who
     * miscases the name still gets the upstream validation error naming it.
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

  /** Fetch a page of works for a specific journal by ISSN, most recent first. */
  async getJournalWorks(
    issn: string,
    opts: SubResourceWorksOptions,
    ctx: Context,
  ): Promise<WorksSearchResult> {
    // Sort by publication date descending so "most recent works" is accurate — the
    // /works endpoint's default ordering is not chronological. `published` (chosen)
    // reflects publication date; `deposited` would reflect Crossref registration date.
    const params = new URLSearchParams({
      rows: String(opts.rows),
      sort: 'published',
      order: 'desc',
    });
    setSubResourcePage(params, opts);
    const envelope = await this.request<CrossrefListMessage<RawCrossrefWork>>(
      `/journals/${encodeURIComponent(issn)}/works?${params}`,
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
        `/funders/${encodeURIComponent(normalizeFunderId(opts.funderDoi))}`,
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

  /** Fetch a page of works for a specific funder by funder DOI/ID, most recent first. */
  async getFunderWorks(
    funderId: string,
    opts: SubResourceWorksOptions,
    ctx: Context,
  ): Promise<WorksSearchResult> {
    const id = normalizeFunderId(funderId);
    // Sort by publication date descending for predictable, most-recent-first ordering —
    // the /works endpoint's default ordering is not chronological. Matches
    // getJournalWorks so both funded-works and journal-works surfaces agree.
    const params = new URLSearchParams({
      rows: String(opts.rows),
      sort: 'published',
      order: 'desc',
    });
    setSubResourcePage(params, opts);
    const envelope = await this.request<CrossrefListMessage<RawCrossrefWork>>(
      `/funders/${encodeURIComponent(id)}/works?${params}`,
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

/**
 * Crossref returns a structured validation-failure body on 400. Parse it and surface an
 * actionable message instead of leaking the raw body. Consumes the response body.
 */
async function crossrefValidationError(response: Response): Promise<McpError> {
  let detail = '';
  try {
    const json = (await response.json()) as {
      'message-type'?: string;
      message?: Array<{ type?: string; value?: string; message?: string }>;
    };
    if (json['message-type'] === 'validation-failure' && Array.isArray(json.message)) {
      detail = json.message
        .map((m) => {
          const badKey = m.value ? `"${m.value}"` : '';
          const hint =
            m.type === 'filter-not-available'
              ? ` — Crossref filter keys use hyphens (e.g. "${(m.value ?? '').replace(/_/g, '-')}")`
              : m.message
                ? ` — ${m.message}`
                : '';
          return `${badKey}${hint}`;
        })
        .filter(Boolean)
        .join('; ');
    }
  } catch {
    // Body was not the documented JSON shape — fall through to the generic message.
  }
  return validationError(
    detail
      ? `Crossref rejected the request: ${detail}`
      : 'Crossref returned HTTP 400 Bad Request — check filter key names (use hyphens, not underscores) and field names.',
  );
}

/**
 * Apply the page selector for a works sub-resource. Cursor and offset are mutually exclusive
 * upstream, so only one is ever written — the same precedence `searchWorks` uses on `/works`.
 * An offset of 0 is the start of the list and is left off the query string entirely.
 */
function setSubResourcePage(params: URLSearchParams, opts: SubResourceWorksOptions): void {
  if (opts.cursor) {
    params.set('cursor', opts.cursor);
  } else if (opts.offset != null && opts.offset > 0) {
    params.set('offset', String(opts.offset));
  }
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
    // Logger is not yet initialized when setup() runs, so use console.warn directly.
    console.warn(
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
