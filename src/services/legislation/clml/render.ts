/**
 * @fileoverview CLML → Markdown renderer. Structural divisions become
 * headings, numbered provisions become indented numbered lines, amendments
 * wrap their text as `[F1 …]` labelled by their commentary, and annotations
 * are numbered per type in order of first reference, as legislation.gov.uk
 * displays them.
 * @module services/legislation/clml/render
 */

import { ANNOTATION_TYPE_ORDER, ANNOTATION_TYPES } from '../reference-data.js';
import {
  attr,
  child,
  childrenNamed,
  elements,
  findDescendant,
  findDescendants,
  localName,
  textOf,
  toHttps,
  WHITESPACE_RUN,
  type XmlChild,
  type XmlElement,
} from '../xml.js';

/** One annotation (commentary) referenced by the rendered text. */
export interface Annotation {
  citations: { title?: string; uri: string }[];
  label: string;
  text: string;
  type: string;
  type_label: string;
}

/** Rendered Markdown plus the annotations it references. */
export interface RenderResult {
  annotations: Annotation[];
  /** Rendered size in characters: the text plus each annotation's label, type, type label, text, and citation titles and URIs. */
  chars: number;
  text: string;
}

const HEADING_CONTAINERS = new Set([
  'Part',
  'Chapter',
  'Pblock',
  'PsubBlock',
  'Schedule',
  'EUPart',
  'EUTitle',
  'EUChapter',
  'EUSection',
  'EUSubsection',
  'Division',
  'Group',
  'Appendix',
  'Attachment',
]);

const P_LEVELS = new Set(['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7']);

const INLINE = new Set([
  'Addition',
  'Substitution',
  'Repeal',
  'CommentaryRef',
  'FootnoteRef',
  'InlineAmendment',
  'Character',
  'Emphasis',
  'Strong',
  'Underline',
  'SmallCaps',
  'Superior',
  'Inferior',
  'Uppercase',
  'Expanded',
  'Span',
  'Citation',
  'CitationSubRef',
  'Term',
  'Definition',
  'Abbreviation',
  'Acronym',
  'InternalLink',
  'ExternalLink',
  'Proviso',
  'MarginNoteRef',
  'Strike',
]);

const SKIP = new Set([
  'ukm:Metadata',
  'Commentaries',
  'Footnotes',
  'Resources',
  'MarginNotes',
  'Contents',
  'PrimaryPrelims',
  'SecondaryPrelims',
  'EUPrelims',
  'ExplanatoryNotes',
  'EarlierOrders',
]);

/** `<Character Name>` → text. A `Map`, because the key is upstream text. */
const CHARACTERS: ReadonlyMap<string, string> = new Map([
  ['DotPadding', '…'],
  ['EmDash', '—'],
  ['EnDash', '–'],
  ['Minus', '−'],
  ['NonBreakingSpace', ' '],
  ['ThinSpace', ' '],
  ['LinePadding', ' … '],
  ['Ellipsis', '…'],
]);

/**
 * Escapes Markdown/HTML openers in upstream text placed in the rendered body.
 * Backslashes are escaped in the same pass, so upstream text cannot cancel an
 * escape, including the pipe escape a table cell adds.
 */
function escapeBodyText(value: string): string {
  return value.replace(/[\\*`]/g, (c) => `\\${c}`).replace(/<(?=[A-Za-z/!?])/g, '&lt;');
}

interface Line {
  heading?: boolean;
  indent: number;
  text: string;
}

class Renderer {
  readonly lines: Line[] = [];
  private readonly commentaries = new Map<string, XmlElement>();
  private readonly counters = new Map<string, number>();
  private readonly labels = new Map<string, string>();
  private readonly footnotes = new Map<string, number>();
  private readonly footnoteElements = new Map<string, XmlElement>();
  private readonly resources = new Map<string, string>();
  simplifiedTable = false;

  constructor(root: XmlElement) {
    for (const commentary of childrenNamed(child(root, 'Commentaries'), 'Commentary')) {
      const id = attr(commentary, 'id');
      if (id) this.commentaries.set(id, commentary);
    }
    for (const footnote of findDescendants(root, (el) => el.name === 'Footnote')) {
      const id = attr(footnote, 'id');
      if (id) this.footnoteElements.set(id, footnote);
    }
    for (const resource of childrenNamed(child(root, 'Resources'), 'Resource')) {
      const id = attr(resource, 'id');
      const uri = attr(child(resource, 'ExternalVersion'), 'URI');
      if (id && uri) this.resources.set(id, toHttps(uri));
    }
  }

  /** Assigns (or returns) the display label for a commentary reference. */
  label(ref: string | undefined): string | undefined {
    if (!ref) return;
    const existing = this.labels.get(ref);
    if (existing) return existing;
    const type = attr(this.commentaries.get(ref), 'Type') ?? 'X';
    const n = (this.counters.get(type) ?? 0) + 1;
    this.counters.set(type, n);
    const label = `${type}${n}`;
    this.labels.set(ref, label);
    return label;
  }

  inline(node: XmlChild): string {
    if (typeof node === 'string') return escapeBodyText(node.replace(WHITESPACE_RUN, ' '));
    const inner = () => node.children.map((c) => this.inline(c)).join('');
    switch (node.name) {
      case 'Addition':
      case 'Substitution':
      case 'Repeal': {
        const label = this.label(attr(node, 'CommentaryRef'));
        const content = inner().trim();
        return label ? `[${label}${content ? ` ${content}` : ''}]` : `[${content}]`;
      }
      case 'CommentaryRef': {
        const label = this.label(attr(node, 'Ref'));
        return label ? `[${label}]` : '';
      }
      case 'FootnoteRef': {
        const ref = attr(node, 'Ref');
        if (!ref) return '';
        const n = this.footnotes.get(ref) ?? this.footnotes.size + 1;
        this.footnotes.set(ref, n);
        return `[^${n}]`;
      }
      case 'InlineAmendment':
        return `“${inner().trim()}”`;
      case 'Character':
        return CHARACTERS.get(attr(node, 'Name') ?? '') ?? '';
      case 'Image':
        return this.image(node);
      case 'Formula':
        return this.formula(node);
      default:
        return inner();
    }
  }

  private image(node: XmlElement): string {
    const uri = this.resources.get(attr(node, 'ResourceRef') ?? '');
    return uri ? `[image](${uri})` : '[image]';
  }

  private formula(node: XmlElement): string {
    const math = findDescendant(node, (el) => localName(el.name) === 'math');
    const alt = attr(math, 'alttext') ?? attr(node, 'AltText');
    return alt ? `[formula: ${escapeBodyText(alt)}]` : '[formula]';
  }

  push(indent: number, text: string, heading = false): void {
    const trimmed = text.replace(WHITESPACE_RUN, ' ').trim();
    if (trimmed.length > 0)
      this.lines.push({ indent, text: trimmed, ...(heading ? { heading } : {}) });
  }

  private statusPrefix(node: XmlElement): string {
    const status = attr(node, 'Status');
    if (status === 'Repealed') return '*(repealed)* ';
    if (status === 'Prospective' || attr(node, 'Match') === 'false') {
      return '*(prospective — not in force at this version)* ';
    }
    return '';
  }

  private numberText(pnumber: XmlElement | undefined, level: string): string {
    if (!pnumber) return '';
    const value = this.inline(pnumber).trim();
    if (!value) return '';
    const before = pnumber.attrs.PuncBefore;
    const after = pnumber.attrs.PuncAfter;
    if (level === 'P1') return `**${before ?? ''}${value}${after ?? ''}**`;
    return `${before ?? '('}${value}${after ?? ')'}`;
  }

  /** Renders a block-level node at an indent. */
  block(node: XmlChild, indent: number, depth: number): void {
    if (typeof node === 'string') {
      this.push(indent, this.inline(node));
      return;
    }
    const { name } = node;
    if (SKIP.has(name)) return;
    if (HEADING_CONTAINERS.has(name)) {
      this.container(node, indent, depth);
      return;
    }
    if (P_LEVELS.has(name)) {
      this.provision(node, indent, depth);
      return;
    }
    switch (name) {
      case 'P1group': {
        const title = child(node, 'Title');
        if (title) this.push(indent, `${this.statusPrefix(node)}**${this.inline(title).trim()}**`);
        for (const c of node.children)
          if (typeof c === 'string' || c.name !== 'Title') this.block(c, indent, depth);
        return;
      }
      case 'Text':
        this.push(indent, this.inline(node));
        return;
      case 'Title':
      case 'Number':
      case 'Pnumber':
        this.push(indent, `**${this.inline(node).trim()}**`);
        return;
      case 'UnorderedList':
      case 'OrderedList': {
        let n = 0;
        for (const item of childrenNamed(node, 'ListItem')) {
          n += 1;
          const marker = name === 'OrderedList' ? `${n}.` : '-';
          const start = this.lines.length;
          for (const c of item.children) this.block(c, indent + 1, depth);
          const first = this.lines[start];
          if (first) {
            first.text = `${marker} ${first.text}`;
            first.indent = indent;
          }
        }
        return;
      }
      case 'BlockAmendment': {
        const start = this.lines.length;
        for (const c of node.children) this.block(c, 0, depth + 1);
        for (const line of this.lines.slice(start)) {
          line.text = `> ${'  '.repeat(line.indent)}${line.text}`;
          line.indent = indent;
          delete line.heading;
        }
        return;
      }
      case 'Tabular':
        this.table(node, indent);
        return;
      case 'Figure': {
        const images = findDescendants(node, (el) => el.name === 'Image').map((img) =>
          this.image(img),
        );
        this.push(indent, images.length > 0 ? images.join(' ') : '[image]');
        for (const c of elements(node)) if (c.name !== 'Image') this.block(c, indent, depth);
        return;
      }
      case 'Image':
        this.push(indent, this.image(node));
        return;
      case 'Formula':
        this.push(indent, this.formula(node));
        return;
      default:
        if (INLINE.has(name)) {
          this.push(indent, this.inline(node));
          return;
        }
        for (const c of node.children) this.block(c, indent, depth);
    }
  }

  private container(node: XmlElement, indent: number, depth: number): void {
    const titleBlock = child(node, 'TitleBlock') ?? node;
    const number = child(titleBlock, 'Number') ?? child(node, 'Number');
    const title = child(titleBlock, 'Title') ?? child(node, 'Title');
    const heading = [number, title]
      .filter((x) => x !== undefined)
      .map((x) => this.inline(x).trim())
      .filter(Boolean)
      .join(' — ');
    if (heading)
      this.push(
        indent,
        `${'#'.repeat(Math.min(2 + depth, 6))} ${this.statusPrefix(node)}${heading}`,
        true,
      );
    for (const c of node.children) {
      if (
        typeof c !== 'string' &&
        (c === titleBlock || c === number || c === title || c.name === 'Reference')
      )
        continue;
      this.block(c, indent, depth + 1);
    }
  }

  private provision(node: XmlElement, indent: number, depth: number): void {
    const number = this.numberText(child(node, 'Pnumber'), node.name);
    const prefix = `${this.statusPrefix(node)}${number}`;
    const childIndent = node.name === 'P1' ? indent : indent + 1;
    const start = this.lines.length;
    for (const c of node.children) {
      if (typeof c !== 'string' && c.name === 'Pnumber') continue;
      if (typeof c !== 'string' && /^P\dpara$/.test(c.name)) {
        for (const inner of c.children) {
          this.block(
            inner,
            P_LEVELS.has(typeof inner === 'string' ? '' : inner.name) ? childIndent : indent,
            depth,
          );
        }
        continue;
      }
      this.block(c, indent, depth);
    }
    if (!prefix) return;
    const first = this.lines[start];
    if (first && first.indent === indent && !first.heading) first.text = `${prefix} ${first.text}`;
    else this.lines.splice(start, 0, { indent, text: prefix });
  }

  private table(node: XmlElement, indent: number): void {
    const table = findDescendant(node, (el) => localName(el.name) === 'table');
    if (!table) {
      this.push(indent, this.inline(node));
      return;
    }
    const rows = findDescendants(table, (el) => localName(el.name) === 'tr').map((tr) =>
      elements(tr)
        .filter((cell) => ['td', 'th'].includes(localName(cell.name)))
        .map((cell) => {
          // Upstream writes rowspan="1" colspan="1" on every cell; only a span over 1 merges.
          if (Number(cell.attrs.colspan ?? 1) > 1 || Number(cell.attrs.rowspan ?? 1) > 1) {
            this.simplifiedTable = true;
          }
          return this.inline(cell).replace(WHITESPACE_RUN, ' ').trim().replace(/\|/g, '\\|');
        }),
    );
    const width = Math.max(0, ...rows.map((r) => r.length));
    if (width === 0) return;
    const pad = (r: string[]) => `| ${[...r, ...Array(width - r.length).fill('')].join(' | ')} |`;
    const [head, ...body] = rows;
    this.push(indent, pad(head ?? []));
    this.push(indent, `|${' --- |'.repeat(width)}`);
    for (const row of body) this.push(indent, pad(row));
  }

  /** Footnote lines for every footnote referenced so far. */
  footnoteLines(): string[] {
    return [...this.footnotes].map(([ref, n]) => {
      const footnote = this.footnoteElements.get(ref);
      const text = footnote
        ? elements(footnote)
            .map((c) => this.inline(c))
            .join(' ')
        : '';
      return `[^${n}]: ${text.replace(WHITESPACE_RUN, ' ').trim()}`;
    });
  }

  annotations(): Annotation[] {
    const out: Annotation[] = [];
    for (const [ref, label] of this.labels) {
      const commentary = this.commentaries.get(ref);
      if (!commentary) continue;
      const type = attr(commentary, 'Type') ?? 'X';
      const citations = findDescendants(
        commentary,
        (el) => el.name === 'Citation' || el.name === 'CitationSubRef',
      )
        .map((el) => {
          const uri = attr(el, 'URI');
          const title = attr(el, 'Title') ?? textOf(el);
          return uri ? { uri: toHttps(uri), ...(title ? { title } : {}) } : undefined;
        })
        .filter((c) => c !== undefined);
      out.push({
        label,
        type,
        type_label: ANNOTATION_TYPES.get(type) ?? 'Annotation',
        text: childrenNamed(commentary, 'Para')
          .map((para) => textOf(para))
          .filter(Boolean)
          .join('\n'),
        citations,
      });
    }
    const typeRank = (t: string) => {
      const i = (ANNOTATION_TYPE_ORDER as readonly string[]).indexOf(t);
      return i === -1 ? ANNOTATION_TYPE_ORDER.length : i;
    };
    return out.sort(
      (a, b) =>
        typeRank(a.type) - typeRank(b.type) || Number(a.label.slice(1)) - Number(b.label.slice(1)),
    );
  }
}

/** One annotation's share of `chars`: its label, type, type label, text, and citation titles and URIs. */
function annotationChars(a: Annotation): number {
  return (
    a.label.length +
    a.type.length +
    a.type_label.length +
    a.text.length +
    a.citations.reduce((n, c) => n + (c.title?.length ?? 0) + c.uri.length, 0)
  );
}

/** A commentary label where rendered text opens a bracket: `[F1 …]` or `[F1]`. */
const LABEL_REF = /\[([^\s[\]]+)/g;

function joinLines(lines: Line[]): string {
  const out: string[] = [];
  for (const line of lines) {
    const text = `${'  '.repeat(line.indent)}${line.text}`;
    if (line.heading) {
      if (out.length > 0 && out.at(-1) !== '') out.push('');
      out.push(text, '');
    } else {
      out.push(text);
    }
  }
  while (out.at(-1) === '') out.pop();
  return out.join('\n');
}

/**
 * Renders the given nodes of a parsed CLML document. Commentary labels,
 * footnotes, and annotations are scoped to what these nodes reference.
 */
export function renderNodes(
  root: XmlElement,
  nodes: XmlElement[],
): RenderResult & { simplifiedTable: boolean } {
  const renderer = new Renderer(root);
  for (const node of nodes) {
    /** A requested node renders even when its kind is skipped inside a larger render (prelims for `introduction`). */
    if (SKIP.has(node.name)) for (const c of node.children) renderer.block(c, 0, 0);
    else renderer.block(node, 0, 0);
  }
  const footnotes = renderer.footnoteLines();
  let text = joinLines(renderer.lines);
  if (footnotes.length > 0) text = `${text}\n\n${footnotes.join('\n')}`;
  const annotations = renderer.annotations();
  /** Every annotation field both result surfaces carry counts, citation titles and URIs included. */
  const chars = annotations.reduce((sum, a) => sum + annotationChars(a), text.length);
  return { text, annotations, chars, simplifiedTable: renderer.simplifiedTable };
}

/**
 * Cuts a render to at most `max` characters, measured as `chars` is: the text
 * ends at the last line break that fits, and only the annotations the kept
 * text references are kept. A line too long to fit even on its own (a whole
 * table row or paragraph over `max`) is cut after the last word that fits.
 */
export function cutRendered(result: RenderResult, max: number): RenderResult {
  const byLabel = new Map(result.annotations.map((a) => [a.label, a]));
  const referenced = (piece: string) =>
    new Set(
      [...piece.matchAll(LABEL_REF)]
        .map(([, label]) => byLabel.get(label ?? ''))
        .filter((a) => a !== undefined),
    );
  const kept = new Set<Annotation>();
  let chars = 0;
  let text = '';
  /** Appends `piece` when it and the annotations it references first still fit. */
  const keep = (piece: string): boolean => {
    const added = [...referenced(piece)].filter((a) => !kept.has(a));
    const size = added.reduce((n, a) => n + annotationChars(a), piece.length);
    if (chars + size > max) return false;
    chars += size;
    text += piece;
    for (const a of added) kept.add(a);
    return true;
  };
  for (const [i, line] of result.text.split('\n').entries()) {
    const piece = i === 0 ? line : `\n${line}`;
    if (keep(piece)) continue;
    const alone = [...referenced(line)].reduce((n, a) => n + annotationChars(a), line.length);
    if (alone > max) {
      /** Words past `max - chars` cannot fit, and the one the slice truncates never does. */
      for (const word of piece.slice(0, max - chars + 1).split(/(?<=\s)/)) if (!keep(word)) break;
    }
    break;
  }
  text = text.trimEnd();
  const annotations = result.annotations.filter((a) => kept.has(a));
  return {
    text,
    annotations,
    chars: annotations.reduce((sum, a) => sum + annotationChars(a), text.length),
  };
}
