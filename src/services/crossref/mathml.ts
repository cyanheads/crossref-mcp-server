/**
 * @fileoverview `mathmlText` — what a MathML formula reads as once its markup is gone. A
 * presentation tree encodes most of its operators as structure rather than as characters: a
 * radical is an `<msqrt>`, an exponent is the second child of an `<msup>`, a fraction bar is an
 * `<mfrac>`, and a fence can live in an attribute. Emptying the tree of tags and joining its
 * text deletes every one of them — `√m ∈ ℚ₅` reads `m∈Q5` — so the region is read instead:
 *
 * 1. **A TeX annotation, as deposited.** A deposit that carries its expression a second time as
 *    TeX (`<annotation encoding="application/x-tex">`) has already written the linear form, and
 *    losslessly; it replaces the presentation tree rather than joining it, so the formula still
 *    reaches the reader once.
 * 2. **Otherwise, the tree written out** in a linear notation that keeps the structure: `x_i`,
 *    `A^{−1}`, `∑_{i=1}^N`, `^{33}Si`, `√(m)`, `√[3](x)`, `(Np)/(N−p)`, rows of a table joined
 *    by `; `. Every other copy of the expression — a Content MathML `<annotation-xml>`, a
 *    `<semantics>` wrapper's later children — is dropped for the same reason the TeX replaces
 *    the tree.
 * 3. **Any other element** is spelled `name(child, …)` over its children, so a construct with no
 *    linear form stays visible and intact rather than reading as a different formula.
 *
 * The reading is linear in the region and costs nothing on the call stack: one tag scan builds
 * the tree, one pass over it in reverse document order finishes every node after its children,
 * and each node's text is built by concatenation rather than by copying its children's text, so
 * a region nested thousands of elements deep costs what a flat one does.
 * @module services/crossref/mathml
 */

/** One element of a region, or the region itself (`#region`). */
interface MathNode {
  /**
   * Whether the element's reading needs no grouping where an operand or a script base could
   * otherwise run into its neighbour: one token, one character, or already bracketed.
   */
  atom: boolean;
  /** The opening tag's text after its name: the attributes, unparsed until one is read. */
  readonly attributes: string;
  readonly children: Array<MathNode | string>;
  end: number;
  /**
   * The fence character the element is, when it is nothing but one `<mo>` fence — possibly
   * inside layout wrappers that hold nothing else, as `<mrow><mo>(</mo></mrow>` is deposited.
   */
  fence: string | undefined;
  /** Local name, lower-cased — a namespace prefix names the vocabulary, not the element. */
  readonly name: string;
  /** Offsets in the region of the element's content: after its opening tag, before its closer. */
  readonly start: number;
  /** What the element reads as — filled in once its children have been. */
  text: string;
}

/**
 * Every bracket in a region is a tag by construction. The body stops at the next `<` as well as
 * at `>`, so a stray `<` costs one short scan rather than a scan to the end of the region.
 */
const TAG = /<([^<>]*)>/g;

/** The closing slash and local name at the head of a tag body. Comments and declarations fail it. */
const TAG_NAME = /^(\/?)\s*(?:[A-Za-z][\w.-]*:)?([A-Za-z][\w.-]*)/;

/**
 * One `name="value"` pair, anchored where the last one ended. Sticky rather than global, so a
 * body that stops parsing stops the read instead of restarting it at every later character.
 */
const ATTRIBUTE = /\s*([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+))/y;

/** An annotation encoding naming TeX or LaTeX: `application/x-tex`, `TeX`, `LaTeX`. */
const TEX_ENCODING = /(?:^|[^a-z])(?:la)?tex(?:[^a-z]|$)/i;

/** Elements read as their children in order, like an `<mrow>`. */
const ROWS = new Set(['#region', 'mrow', 'mstyle', 'mpadded', 'mtd']);

/**
 * Over and under scripts that decorate their base rather than qualify it. One of these follows
 * the base as a character — `x¯`, `v→` — where any other script is written as one.
 */
const ACCENTS = new Set([...'¯‾^ˆ˙~˜∼→⃗̂̃̇̄←↔ˇ´`¨']);

/** An opening fence and the one that closes it. The symmetric pairs close on themselves. */
const FENCES = new Map([
  ['(', ')'],
  ['[', ']'],
  ['{', '}'],
  ['⟨', '⟩'],
  ['〈', '〉'],
  ['⌊', '⌋'],
  ['⌈', '⌉'],
  ['|', '|'],
  ['‖', '‖'],
]);

/** Every character that opens or closes a fence. */
const FENCE_CHARACTERS = new Set([...FENCES.keys(), ...FENCES.values()]);

/** The double-struck letters Unicode encodes outside the Mathematical Alphanumeric block. */
const DOUBLE_STRUCK_EXCEPTIONS: Record<string, string> = {
  C: 'ℂ',
  H: 'ℍ',
  N: 'ℕ',
  P: 'ℙ',
  Q: 'ℚ',
  R: 'ℝ',
  Z: 'ℤ',
};

/**
 * Read a MathML region — the content between a `<math>` element's tags — as one line of text.
 * The caller supplies the block boundary the region leaves in the sentence around it.
 */
export function mathmlText(inner: string): string {
  const { root, order } = parse(inner);
  const tex = texAnnotation(inner, order);
  if (tex !== undefined) return tex;
  for (let i = order.length - 1; i >= 0; i--) finish(order[i] as MathNode);
  return root.text;
}

/**
 * Build the region's element tree in one scan, with every element listed in document order.
 * A closer with no open element of its name is ignored, and one that skips over open elements
 * closes them too; an element the region never closes ends with the region. The count of each
 * open name is what lets an unmatched closer be dismissed without searching the open elements.
 */
function parse(inner: string): { root: MathNode; order: MathNode[] } {
  const root = element('#region', '', 0);
  const order: MathNode[] = [root];
  const open: MathNode[] = [root];
  const openCount = new Map<string, number>();
  let last = 0;
  for (const match of inner.matchAll(TAG)) {
    const parent = open[open.length - 1] as MathNode;
    if (match.index > last) parent.children.push(inner.slice(last, match.index));
    last = match.index + match[0].length;
    const body = match[1] as string;
    const tag = TAG_NAME.exec(body);
    if (!tag) continue;
    const name = (tag[2] as string).toLowerCase();
    if (tag[1]) {
      if (!openCount.get(name)) continue;
      for (;;) {
        const closed = open.pop() as MathNode;
        closed.end = match.index;
        openCount.set(closed.name, (openCount.get(closed.name) ?? 1) - 1);
        if (closed.name === name) break;
      }
      continue;
    }
    const child = element(name, body.slice(tag[0].length), last);
    parent.children.push(child);
    order.push(child);
    if (body.trimEnd().endsWith('/')) {
      child.end = last;
    } else {
      open.push(child);
      openCount.set(name, (openCount.get(name) ?? 0) + 1);
    }
  }
  if (last < inner.length) (open[open.length - 1] as MathNode).children.push(inner.slice(last));
  for (const unclosed of open) unclosed.end = inner.length;
  return { root, order };
}

function element(name: string, attributes: string, start: number): MathNode {
  return {
    name,
    attributes,
    children: [],
    start,
    end: start,
    text: '',
    atom: false,
    fence: undefined,
  };
}

/** The value of one attribute, by local name. */
function attribute(node: MathNode, name: string): string | undefined {
  ATTRIBUTE.lastIndex = 0;
  for (let pair = ATTRIBUTE.exec(node.attributes); pair; pair = ATTRIBUTE.exec(node.attributes)) {
    const key = (pair[1] as string).toLowerCase();
    if (key === name || key.endsWith(`:${name}`)) return pair[2] ?? pair[3] ?? pair[4];
  }
  return;
}

/**
 * The first TeX annotation in the region that carries any text, exactly as deposited between
 * its tags. Undefined when there is none, and the tree is read instead.
 */
function texAnnotation(inner: string, order: readonly MathNode[]): string | undefined {
  for (const node of order) {
    if (node.name !== 'annotation') continue;
    if (!TEX_ENCODING.test(attribute(node, 'encoding') ?? '')) continue;
    const tex = trimXmlWhitespace(inner.slice(node.start, node.end));
    if (tex !== '') return tex;
  }
  return;
}

/** Fill in what a node reads as, from its children, which are already finished. */
function finish(node: MathNode): void {
  const kids = node.children.filter((child): child is MathNode => typeof child !== 'string');
  const [first, second, third] = kids;
  switch (node.name) {
    case 'mi':
    case 'mn':
    case 'mo':
    case 'mtext':
    case 'ms':
      node.text = token(node);
      node.atom = true;
      if (node.name === 'mo' && node.text.length <= 2 && FENCE_CHARACTERS.has(node.text)) {
        node.fence = node.text;
      }
      return;
    case 'mspace':
      node.text = ' ';
      node.atom = true;
      return;
    case 'annotation':
    case 'annotation-xml':
      node.text = '';
      node.atom = true;
      return;
    case 'semantics':
    case 'maction':
      node.text = first?.text ?? '';
      node.atom = first?.atom ?? true;
      node.fence = first?.fence;
      return;
    case 'msub':
      node.text = operand(first) + script('_', second);
      return;
    case 'msup':
      node.text = operand(first) + script('^', second);
      return;
    case 'msubsup':
      node.text = operand(first) + script('_', second) + script('^', third);
      return;
    case 'munder':
      node.text = operand(first) + decoration('_', second);
      return;
    case 'mover':
      node.text = operand(first) + decoration('^', second);
      return;
    case 'munderover':
      node.text = operand(first) + decoration('_', second) + decoration('^', third);
      return;
    case 'mmultiscripts':
      node.text = multiscripts(kids);
      return;
    case 'msqrt':
      node.text = `√(${joined(node.children, '')})`;
      return;
    case 'mroot':
      node.text = `√[${second?.text ?? ''}](${first?.text ?? ''})`;
      return;
    case 'mfrac':
      if (Number.parseFloat(attribute(node, 'linethickness') ?? '') === 0) break;
      node.text = `${operand(first)}/${operand(second)}`;
      return;
    case 'mfenced':
      fenced(node, kids);
      return;
    case 'mtable':
      node.text = joined(kids, '; ');
      return;
    case 'mtr':
      node.text = joined(kids, ' ');
      return;
    default:
      if (ROWS.has(node.name)) {
        node.text = joined(node.children, '');
        shapeRow(node);
        return;
      }
  }
  node.text = `${node.name}(${joined(node.children, ', ')})`;
}

/**
 * A token's content, trimmed of XML whitespace at its two ends and nothing else, and mapped to
 * its double-struck letters where `mathvariant` asks for them. Each piece of the token's own text
 * is trimmed and mapped where it sits, rather than the whole after joining, so an element a
 * deposit nests inside a token is never copied again by the token around it.
 */
function token(node: MathNode): string {
  const doubled = attribute(node, 'mathvariant') === 'double-struck';
  const last = node.children.length - 1;
  let text = '';
  node.children.forEach((child, i) => {
    if (typeof child !== 'string') {
      text += child.text;
      return;
    }
    let piece = child;
    if (i === 0) piece = trimXmlWhitespace(piece, 'start');
    if (i === last) piece = trimXmlWhitespace(piece, 'end');
    text += doubled ? doubleStruck(piece) : piece;
  });
  return text;
}

/**
 * Items joined by a separator — an element by its reading, text only where it is not whitespace.
 * Joined by nothing, it is a row: its children in order, the whitespace between its tags dropped.
 */
function joined(items: ReadonlyArray<MathNode | string>, separator: string): string {
  let text = '';
  let any = false;
  for (const item of items) {
    const part = typeof item === 'string' ? trimXmlWhitespace(item) : item.text;
    if (typeof item === 'string' && part === '') continue;
    text += any ? separator + part : part;
    any = true;
  }
  return text;
}

/**
 * Whether a row needs grouping, and whether it is a fence. A row of one item takes both from
 * that item. A longer row needs no grouping when a fence opens it, the matching fence closes it,
 * and the two enclose everything between: `(a+b)` and `|u|` are bracketed, `(a)+(b)` and
 * `|a|+|b|` are not. Each item's fence was settled when the item was, so this reads the row's
 * own items and nothing below them.
 */
function shapeRow(node: MathNode): void {
  const items = node.children.filter(
    (child) => typeof child !== 'string' || trimXmlWhitespace(child) !== '',
  );
  const [head] = items;
  if (items.length === 1 && typeof head !== 'string' && head) {
    node.atom = head.atom;
    node.fence = head.fence;
    return;
  }
  node.atom = node.text === '' || oneCharacter(node.text) || enclosed(items);
}

/** Whether a row's first and last items are a matching pair of fences around all the rest. */
function enclosed(items: ReadonlyArray<MathNode | string>): boolean {
  const [head, tail] = [items[0], items[items.length - 1]];
  if (typeof head !== 'object' || typeof tail !== 'object' || items.length < 2) return false;
  const open = head.fence ?? '';
  const close = FENCES.get(open);
  if (close === undefined || tail.fence !== close) return false;
  let depth = 1;
  for (const item of items.slice(1, -1)) {
    if (typeof item === 'string') continue;
    if (item.fence === close) depth -= 1;
    else if (item.fence === open) depth += 1;
    if (depth <= 0) return false;
  }
  return true;
}

/** A fraction operand or script base, grouped unless it is one token or already bracketed. */
function operand(node: MathNode | undefined): string {
  if (!node) return '';
  return node.atom || node.text === '' ? node.text : `(${node.text})`;
}

/** A script after its mark, braced when it is longer than one character. */
function script(mark: string, node: MathNode | undefined): string {
  if (!node || node.text === '') return '';
  return oneCharacter(node.text) ? mark + node.text : `${mark}{${node.text}}`;
}

/** An under or over script: an accent follows its base as a character; anything else is a script. */
function decoration(mark: string, node: MathNode | undefined): string {
  if (node && oneCharacter(node.text) && ACCENTS.has(node.text)) return node.text;
  return script(mark, node);
}

/**
 * Scripts on either side of a base: the prescripts, after `<mprescripts/>`, come first. Each
 * side is a list of subscript/superscript pairs, where `<none/>` holds an empty place.
 */
function multiscripts(kids: readonly MathNode[]): string {
  const [base, ...scripts] = kids;
  const split = scripts.findIndex((node) => node.name === 'mprescripts');
  const post = split < 0 ? scripts : scripts.slice(0, split);
  const pre = split < 0 ? [] : scripts.slice(split + 1);
  const pairs = (side: readonly MathNode[]) => {
    let text = '';
    for (let i = 0; i < side.length; i += 2) {
      const [sub, sup] = [side[i], side[i + 1]];
      if (sub?.name !== 'none') text += script('_', sub);
      if (sup?.name !== 'none') text += script('^', sup);
    }
    return text;
  };
  return pairs(pre) + operand(base) + pairs(post);
}

/**
 * An `<mfenced>` list: its `open` delimiter, its children separated by `separators` — one per
 * gap, the last repeating once they run out, whitespace in the attribute ignored — and its
 * `close` delimiter. The defaults are `(`, `,`, and `)`.
 */
function fenced(node: MathNode, kids: readonly MathNode[]): void {
  const open = attribute(node, 'open') ?? '(';
  const close = attribute(node, 'close') ?? ')';
  const separators = [...(attribute(node, 'separators') ?? ',').replace(/[ \t\r\n]/g, '')];
  let text = open;
  kids.forEach((kid, i) => {
    if (i > 0) text += separators[Math.min(i - 1, separators.length - 1)] ?? '';
    text += kid.text;
  });
  node.text = text + close;
  node.atom = open !== '' && close !== '';
}

/** Whether a string is exactly one code point. Reads at most two code units. */
function oneCharacter(text: string): boolean {
  if (text.length === 1) return true;
  if (text.length !== 2) return false;
  const high = text.charCodeAt(0);
  return high >= 0xd800 && high <= 0xdbff;
}

/** Whether a code unit is XML whitespace: space, tab, carriage return, line feed. */
function isXmlWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0d || code === 0x0a;
}

/**
 * Trim XML whitespace and nothing else. `String.prototype.trim` also removes U+00A0 and U+2009,
 * which a deposit writes as a character precisely because it wants the space seen. Indexed
 * rather than a regex, whose end-anchored whitespace run backtracks quadratically.
 */
function trimXmlWhitespace(text: string, side: 'both' | 'start' | 'end' = 'both'): string {
  let start = 0;
  let end = text.length;
  if (side !== 'end') while (start < end && isXmlWhitespace(text.charCodeAt(start))) start++;
  if (side !== 'start') while (end > start && isXmlWhitespace(text.charCodeAt(end - 1))) end--;
  return start === 0 && end === text.length ? text : text.slice(start, end);
}

/** A `mathvariant="double-struck"` token: ℝ, ℚ, ℤ, and the rest of the alphabet and digits. */
function doubleStruck(text: string): string {
  let mapped = '';
  for (const character of text) {
    const code = character.charCodeAt(0);
    if (DOUBLE_STRUCK_EXCEPTIONS[character]) mapped += DOUBLE_STRUCK_EXCEPTIONS[character];
    else if (code >= 0x41 && code <= 0x5a) mapped += String.fromCodePoint(0x1d538 + code - 0x41);
    else if (code >= 0x61 && code <= 0x7a) mapped += String.fromCodePoint(0x1d552 + code - 0x61);
    else if (code >= 0x30 && code <= 0x39) mapped += String.fromCodePoint(0x1d7d8 + code - 0x30);
    else mapped += character;
  }
  return mapped;
}
