/**
 * @fileoverview XML boundary: one `fast-xml-parser` instance (document order
 * preserved, bounded entity expansion, no DTD resolution) behind a DOCTYPE
 * refusal, converted to a small element tree with lookup helpers. CLML
 * documents and Atom feeds both parse through it.
 * @module services/legislation/xml
 */

import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { XMLParser } from 'fast-xml-parser';

/** One element: qualified name as written (`ukm:Effect`), attributes, children in document order. */
export interface XmlElement {
  attrs: Record<string, string>;
  children: XmlChild[];
  name: string;
}

/** An element or a text run. */
export type XmlChild = XmlElement | string;

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  maxNestedTags: 200,
  processEntities: {
    enabled: true,
    maxEntityCount: 20,
    maxTotalExpansions: 100_000,
    maxExpandedLength: 1_000_000,
  },
});

type OrderedNode = Record<string, unknown> & { ':@'?: Record<string, unknown> };

/**
 * Decodes numeric character references (`&#8217;`, `&#x2014;`). The parser
 * resolves the five XML entities itself; numeric references are left literal
 * unless its deprecated HTML-entity mode is on, so they are decoded here.
 */
function decodeNumericRefs(value: string): string {
  if (!value.includes('&#')) return value;
  return value.replace(/&#(x[0-9a-f]+|\d+);/gi, (whole, ref: string) => {
    const code = ref[0] === 'x' || ref[0] === 'X' ? Number.parseInt(ref.slice(1), 16) : Number(ref);
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff
      ? String.fromCodePoint(code)
      : whole;
  });
}

function convert(nodes: OrderedNode[]): XmlChild[] {
  const out: XmlChild[] = [];
  for (const node of nodes) {
    for (const key of Object.keys(node)) {
      if (key === ':@') continue;
      const value = node[key];
      if (key === '#text') {
        out.push(decodeNumericRefs(String(value)));
        continue;
      }
      if (key.startsWith('?')) continue;
      const attrs: Record<string, string> = {};
      for (const [attrName, attrValue] of Object.entries(node[':@'] ?? {})) {
        attrs[attrName] = decodeNumericRefs(String(attrValue));
      }
      out.push({
        name: key,
        attrs,
        children: Array.isArray(value) ? convert(value as OrderedNode[]) : [],
      });
    }
  }
  return out;
}

/**
 * Parses an XML payload (CLML or Atom) into its root element. Refuses any
 * payload carrying a DOCTYPE before the parser sees it — legislation.gov.uk's
 * XML never declares one, and the only bodies that do are HTML pages. A parser
 * error is replaced by a fixed message: the parser's own quotes the body.
 */
export function parseXml(body: string, what: string): XmlElement {
  if (/<!DOCTYPE/i.test(body)) {
    throw serviceUnavailable(
      `legislation.gov.uk returned ${what} carrying a DOCTYPE declaration; it was refused before parsing. Retry shortly — an HTML page in place of XML usually means a transient upstream fault.`,
    );
  }
  let nodes: OrderedNode[];
  try {
    nodes = parser.parse(body) as OrderedNode[];
  } catch (cause) {
    throw serviceUnavailable(
      `legislation.gov.uk returned ${what} that could not be parsed as XML; it was refused.`,
      undefined,
      { cause },
    );
  }
  const root = convert(nodes).find((child) => typeof child !== 'string');
  if (!root) {
    throw serviceUnavailable(`legislation.gov.uk returned ${what} with no XML root element.`);
  }
  return root;
}

/** Local part of a qualified name (`ukm:Effect` → `Effect`). */
export function localName(name: string): string {
  const colon = name.indexOf(':');
  return colon === -1 ? name : name.slice(colon + 1);
}

/** Element children only. */
export function elements(node: XmlElement): XmlElement[] {
  return node.children.filter((c) => typeof c !== 'string');
}

/** First child element with the given qualified name. */
export function child(node: XmlElement | undefined, name: string): XmlElement | undefined {
  if (!node) return;
  for (const c of node.children) if (typeof c !== 'string' && c.name === name) return c;
  return;
}

/** Every child element with the given qualified name. */
export function childrenNamed(node: XmlElement | undefined, name: string): XmlElement[] {
  if (!node) return [];
  return node.children.filter((c): c is XmlElement => typeof c !== 'string' && c.name === name);
}

/** Depth-first search for the first descendant matching a predicate. */
export function findDescendant(
  node: XmlElement,
  predicate: (el: XmlElement) => boolean,
): XmlElement | undefined {
  for (const c of node.children) {
    if (typeof c === 'string') continue;
    if (predicate(c)) return c;
    const found = findDescendant(c, predicate);
    if (found) return found;
  }
  return;
}

/**
 * Path from `node` down to the first descendant matching a predicate — the
 * ancestors followed by the match — or undefined when nothing matches.
 */
export function findPath(
  node: XmlElement,
  predicate: (el: XmlElement) => boolean,
): XmlElement[] | undefined {
  for (const c of node.children) {
    if (typeof c === 'string') continue;
    if (predicate(c)) return [c];
    const below = findPath(c, predicate);
    if (below) return [c, ...below];
  }
  return;
}

/** Every descendant matching a predicate, in document order. */
export function findDescendants(
  node: XmlElement,
  predicate: (el: XmlElement) => boolean,
  out: XmlElement[] = [],
): XmlElement[] {
  for (const c of node.children) {
    if (typeof c === 'string') continue;
    if (predicate(c)) out.push(c);
    findDescendants(c, predicate, out);
  }
  return out;
}

/**
 * A run of whitespace, NEL (U+0085) included: the regex `\s` class omits NEL,
 * which Unicode counts as a line break, and a decoded `&#133;` is a real one.
 */
export const WHITESPACE_RUN = /[\s\u0085]+/g;

/** Concatenated text content of a node, whitespace collapsed and trimmed. */
export function textOf(node: XmlChild | undefined): string {
  if (node === undefined) return '';
  return rawText(node).replace(WHITESPACE_RUN, ' ').trim();
}

/** Concatenated text content with whitespace kept as written. */
function rawText(node: XmlChild): string {
  if (typeof node === 'string') return node;
  let out = '';
  for (const c of node.children) out += rawText(c);
  return out;
}

/** Attribute value, or undefined when absent or blank. */
export function attr(node: XmlElement | undefined, name: string): string | undefined {
  const value = node?.attrs[name];
  return value === undefined || value.trim() === '' ? undefined : value;
}

/** Boolean attribute: `true`/`false` strings; undefined when absent. */
export function boolAttr(node: XmlElement | undefined, name: string): boolean | undefined {
  const value = attr(node, name);
  if (value === undefined) return;
  return value.toLowerCase() === 'true';
}

/**
 * Reads an Atom/CLML text element that may be plain or bilingual XHTML
 * (`<span xml:lang="en">…</span> / <span xml:lang="cy">…</span>`, or `<p>`
 * blocks for summaries). Returns the English text and, when present, Welsh.
 */
export function bilingualText(node: XmlElement | undefined): { cy?: string; en: string } {
  if (!node) return { en: '' };
  const langNodes = findDescendants(node, (el) => el.attrs['xml:lang'] !== undefined);
  if (langNodes.length === 0) return { en: textOf(node) };
  const en = langNodes
    .filter((el) => el.attrs['xml:lang'] === 'en')
    .map(textOf)
    .join('\n');
  const cy = langNodes
    .filter((el) => el.attrs['xml:lang'] === 'cy')
    .map(textOf)
    .join('\n');
  return { en: en || textOf(node), ...(cy ? { cy } : {}) };
}

/** Rewrites a legislation.gov.uk `http://` URL to `https://`. */
export function toHttps(url: string): string {
  return url.replace(/^http:\/\/(www\.)?legislation\.gov\.uk/i, 'https://www.legislation.gov.uk');
}

/**
 * Path after the legislation.gov.uk origin, `/id` prefix removed, no leading
 * or trailing slash (`http://www.legislation.gov.uk/id/ukpga/2018/12` →
 * `ukpga/2018/12`). Undefined for a URL on another host.
 */
export function legislationPath(uri: string | undefined): string | undefined {
  if (!uri) return;
  const match = /^https?:\/\/(?:www\.)?legislation\.gov\.uk(?:\/id)?\/([^?#]*)/i.exec(uri.trim());
  return match?.[1]?.replace(/\/+$/, '');
}
