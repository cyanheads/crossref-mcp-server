/**
 * @fileoverview `linkTextReader` — the text each link element in one field wraps, as a reader is
 * left holding it once the element's tags come out: everything from the end of its opening tag
 * to the first closing tag of its name, with any markup inside removed and whitespace
 * collapsed. The strip pass asks it one question per link, whether that text contains an
 * address, and reads the answer off this rather than off a string of its own.
 *
 * Every opener before one closer reads a piece of the same text — a link nested in a link, or a
 * run of openers a deposit never closes, all end at the first closer after them — so the text
 * up to each closer is read once, with the offset each opener's piece starts at, and every
 * opener asks its question against that one reading. The markup inside it is removed by a scan
 * that finds each `<` and the next `>` once, so a run of brackets no `>` follows is read once
 * rather than once per bracket. What results is exactly what reading each opener's text on its
 * own would give: a piece starts right after its opener's `>`, where the scan of the whole span
 * is between tags too.
 * @module services/crossref/link-text
 */

/** The text a link element wraps, reduced to the one question asked of it. */
export interface LinkText {
  /** Whether the text contains `search` verbatim. */
  includes(search: string): boolean;
}

/** The text from the first opener that reached one closer, up to that closer. */
interface Span {
  /** Offset of the closing tag in the field. */
  readonly close: number;
  /** Built once a second opener reads this span — see `substringIndex`. */
  index: ((pattern: string, from: number) => boolean) | undefined;
  /** Offset in `text` of each field position from `start` to `close`. */
  readonly offsets: Int32Array;
  /** Whether more than one opener reads this span. */
  shared: boolean;
  /** Offset in the field where the span's text begins. */
  readonly start: number;
  /** The span's text: markup removed, each whitespace run one space, no trailing space. */
  readonly text: string;
}

/**
 * A reader over one field: given where an opener's tag ends and the element's name, the text
 * that element wraps, or undefined when no closer of its name follows. `closers` holds each
 * link element's closing-tag pattern, global so a search can start where the opener ends.
 *
 * The closer found for a name is kept, and any later opener that ends before it shares it: the
 * first closer after an earlier position that lies past a later one is the first after that
 * one too. Only an opener past the kept closer searches again, so no part of the field is
 * searched or read twice.
 */
export function linkTextReader(
  whole: string,
  closers: ReadonlyMap<string, RegExp>,
): (from: number, name: string) => LinkText | undefined {
  const spans = new Map<string, Span>();
  return (from, name) => {
    let span = spans.get(name);
    if (span && from <= span.close) {
      span.shared = true;
    } else {
      const closer = closers.get(name);
      if (!closer) return;
      closer.lastIndex = from;
      const close = closer.exec(whole);
      if (!close) return;
      span = readSpan(whole, from, close.index);
      spans.set(name, span);
    }
    const reading = span;
    return { includes: (search) => spanIncludes(reading, search, from) };
  };
}

/**
 * Read `whole` from `start` to `close` the way the text of one link is read. A `<` begins
 * markup that runs to the next `>`, whatever lies between; a `<` no `>` follows before `close`
 * is text, and so is everything after it, since no later `<` can have one either. Whitespace
 * runs collapse to one space across the markup removed from between them.
 */
function readSpan(whole: string, start: number, close: number): Span {
  const offsets = new Int32Array(close - start + 1);
  const parts: string[] = [];
  let length = 0;
  let spaced = false;
  let pos = start;
  while (pos < close) {
    const open = whole.indexOf('<', pos);
    const end = open >= 0 && open < close ? whole.indexOf('>', open + 1) : -1;
    const tagged = end >= 0 && end < close;
    const textEnd = tagged ? open : close;
    let run = pos;
    for (let i = pos; i < textEnd; i++) {
      if (isWhitespace(whole.charCodeAt(i))) {
        if (!spaced) {
          if (run < i) parts.push(whole.slice(run, i));
          parts.push(' ');
          length += 1;
          spaced = true;
        }
        offsets[i - start] = length - 1;
        run = i + 1;
      } else {
        offsets[i - start] = length;
        length += 1;
        spaced = false;
      }
    }
    if (run < textEnd) parts.push(whole.slice(run, textEnd));
    if (!tagged) break;
    offsets.fill(length, open - start, end - start + 1);
    pos = end + 1;
  }
  offsets[close - start] = length;
  const text = parts.join('');
  return {
    close,
    index: undefined,
    offsets,
    shared: false,
    start,
    text: spaced ? text.slice(0, -1) : text,
  };
}

/**
 * Whether the piece of a span that begins at `from` contains `search` — the span's text from
 * that offset on, less the one space a whitespace run there collapses to. The first opener's
 * questions are a plain search; once a second opener shares the span, every question goes to
 * an index of the span, so openers asking about different addresses do not each search the
 * rest of the text.
 */
function spanIncludes(span: Span, search: string, from: number): boolean {
  let at = span.offsets[from - span.start] as number;
  if (span.text.charCodeAt(at) === 0x20) at += 1;
  if (!span.shared) return span.text.includes(search, at);
  span.index ??= substringIndex(span.text);
  return span.index(search, at);
}

/**
 * An index over `text` answering whether a pattern occurs at or after an offset, in time
 * proportional to the pattern: a suffix automaton, built in time linear in `text`, with each
 * state holding the last position an occurrence of its strings ends at. A pattern occurs at or
 * after `from` exactly when its state's last occurrence starts there or later.
 */
function substringIndex(text: string): (pattern: string, from: number) => boolean {
  const lengths = [0];
  const links = [-1];
  const edges: Array<Map<number, number>> = [new Map()];
  const lastEnd = [-1];
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const state = lengths.length;
    lengths.push((lengths[last] as number) + 1);
    links.push(0);
    edges.push(new Map());
    lastEnd.push(i);
    let p = last;
    while (p >= 0 && !(edges[p] as Map<number, number>).has(code)) {
      (edges[p] as Map<number, number>).set(code, state);
      p = links[p] as number;
    }
    if (p >= 0) {
      const q = (edges[p] as Map<number, number>).get(code) as number;
      if ((lengths[p] as number) + 1 === lengths[q]) {
        links[state] = q;
      } else {
        const clone = lengths.length;
        lengths.push((lengths[p] as number) + 1);
        links.push(links[q] as number);
        edges.push(new Map(edges[q]));
        lastEnd.push(-1);
        while (p >= 0 && (edges[p] as Map<number, number>).get(code) === q) {
          (edges[p] as Map<number, number>).set(code, clone);
          p = links[p] as number;
        }
        links[q] = clone;
        links[state] = clone;
      }
    }
    last = state;
  }
  /**
   * A state's occurrences are those of every state whose suffix link leads to it, and a longer
   * state is never an ancestor of a shorter one, so visiting states longest first carries each
   * last end up to every state it belongs to. The visit order is a counting sort on length.
   */
  const byLength: number[][] = Array.from({ length: text.length + 1 }, () => []);
  lengths.forEach((length, state) => {
    (byLength[length] as number[]).push(state);
  });
  for (let length = text.length; length > 0; length--) {
    for (const state of byLength[length] as number[]) {
      const parent = links[state] as number;
      lastEnd[parent] = Math.max(lastEnd[parent] as number, lastEnd[state] as number);
    }
  }
  return (pattern, from) => {
    let state = 0;
    for (let i = 0; i < pattern.length; i++) {
      const target = (edges[state] as Map<number, number>).get(pattern.charCodeAt(i));
      if (target === undefined) return false;
      state = target;
    }
    return (lastEnd[state] as number) - pattern.length + 1 >= from;
  };
}

/** Whether a code unit is one the `\s` class matches — the whitespace the collapse folds. */
function isWhitespace(code: number): boolean {
  return (
    (code >= 0x09 && code <= 0x0d) ||
    code === 0x20 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}
