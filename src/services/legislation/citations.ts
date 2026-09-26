/**
 * @fileoverview Citation grammar for `uklaw_lookup_citation` — numbered UK,
 * devolved, and EU-origin citations, legislation.gov.uk URIs, and short
 * titles, each with an optional provision tail — plus the bounded text scan
 * that reads candidates out of the `/id?title=` 300 (Multiple Choices) page.
 * @module services/legislation/citations
 */

import { parseItemInput, splitProvisionTail } from './provision-path.js';
import type { ItemPath } from './types.js';

/** A citation as the parser read it. */
export type ParsedCitation =
  | { kind: 'numbered'; number: string; provision?: string; type: string; year: number }
  | { item: ItemPath; kind: 'uri'; provision?: string }
  | { kind: 'title'; provision?: string; title: string; year?: number }
  | { kind: 'unparsed' };

const MIN_YEAR = 1267;
const MAX_YEAR = 2100;

function validYear(year: number): boolean {
  return year >= MIN_YEAR && year <= MAX_YEAR;
}

/** Two-digit EU years: 50–99 → 19xx, else 20xx. */
function expandYear(raw: string): number {
  const value = Number(raw);
  if (raw.length === 4) return value;
  return value >= 50 ? 1900 + value : 2000 + value;
}

const SERIES = String.raw`(?:\s*\([^)]*\))*`;
const SLASH_OR_NO = String.raw`\s*(?:/|No\.?)\s*`;

const NUMBERED: readonly {
  pattern: RegExp;
  build: (m: RegExpExecArray) => { type: string; year: string; number: string };
}[] = [
  {
    pattern: /^(\d{4})\s*c\.?\s*(\d+)$/i,
    build: (m) => ({ type: 'ukpga', year: m[1] as string, number: m[2] as string }),
  },
  {
    pattern: new RegExp(
      String.raw`^S\.?\s*S\.?\s*I\.?\s*(\d{4})${SLASH_OR_NO}(\d+)${SERIES}$`,
      'i',
    ),
    build: (m) => ({ type: 'ssi', year: m[1] as string, number: m[2] as string }),
  },
  {
    pattern: new RegExp(String.raw`^S\.?\s*I\.?\s*(\d{4})${SLASH_OR_NO}(\d+)${SERIES}$`, 'i'),
    build: (m) => ({ type: 'uksi', year: m[1] as string, number: m[2] as string }),
  },
  {
    pattern: new RegExp(String.raw`^S\.?\s*R\.?\s*(\d{4})${SLASH_OR_NO}(\d+)${SERIES}$`, 'i'),
    build: (m) => ({ type: 'nisr', year: m[1] as string, number: m[2] as string }),
  },
  {
    pattern: /^(\d{4})\s+(asp|anaw|asc|nawm)\s+(\d+)$/i,
    build: (m) => ({
      type: (m[2] as string).toLowerCase() === 'nawm' ? 'mwa' : (m[2] as string).toLowerCase(),
      year: m[1] as string,
      number: m[3] as string,
    }),
  },
  {
    pattern: /^(asp|anaw|asc)\s+(\d{4})\s*\/\s*(\d+)$/i,
    build: (m) => ({
      type: (m[1] as string).toLowerCase(),
      year: m[2] as string,
      number: m[3] as string,
    }),
  },
];

const EU_KINDS: Readonly<Record<string, string>> = {
  regulation: 'eur',
  directive: 'eudr',
  decision: 'eudn',
};

const EU_CITATION =
  /^(Regulation|Directive|Decision)\s*(?:\((?:EU|EC|EEC|Euratom)(?:\s*,\s*Euratom)?\))?\s*(No\.?\s*)?(\d{1,4})\/(\d{1,4})(?:\/(?:EC|EEC|EU|Euratom))?$/i;

function parseEu(head: string): { type: string; year: number; number: string } | undefined {
  const m = EU_CITATION.exec(head);
  if (!m) return;
  const type = EU_KINDS[(m[1] as string).toLowerCase()] as string;
  const [a, b] = [m[3] as string, m[4] as string];
  const hasNo = Boolean(m[2]);
  /**
   * Post-2015 numbering is year/number (`2016/679`); earlier numbering is
   * number/year (`No 1535/2003`). `No` marks the older form outright; without
   * it, a four-digit second part in the 1952–2014 range reads as the year.
   */
  const numberFirst =
    hasNo || (/^\d{4}$/.test(b) && Number(b) >= 1952 && Number(b) <= 2014 && !(Number(a) >= 2015));
  const year = expandYear(numberFirst ? b : a);
  const number = String(Number(numberFirst ? a : b));
  return validYear(year) ? { type, year, number } : undefined;
}

/** Parses a citation, URI, or short title. */
export function parseCitation(raw: string): ParsedCitation {
  const input = raw.trim().replace(/\s+/g, ' ');
  if (input.length === 0) return { kind: 'unparsed' };

  const { head, provision } = splitProvisionTail(input);
  const cleanHead = head.replace(/[\s,;:.]+$/, '');

  const isUrl = /^(?:https?:\/\/)?(?:www\.)?legislation\.gov\.uk\//i.test(cleanHead);
  if (isUrl || /^[a-z]+\/\S+$/.test(cleanHead)) {
    const parsed = parseItemInput(cleanHead);
    if (parsed?.item.full) {
      const path = parsed.provision ?? provision;
      return { kind: 'uri', item: parsed.item, ...(path ? { provision: path } : {}) };
    }
    if (isUrl) return { kind: 'unparsed' };
  }

  const tail = provision ? { provision } : {};

  for (const { pattern, build } of NUMBERED) {
    const m = pattern.exec(cleanHead);
    if (!m) continue;
    const { type, year, number } = build(m);
    const y = Number(year);
    if (!validYear(y)) continue;
    return { kind: 'numbered', type, year: y, number: String(Number(number)), ...tail };
  }
  const eu = parseEu(cleanHead);
  if (eu) return { kind: 'numbered', ...eu, ...tail };

  if (!/[A-Za-z]/.test(cleanHead)) return { kind: 'unparsed' };
  const yearMatch = /\b(\d{4})\b(?!.*\b\d{4}\b)/.exec(cleanHead);
  const year = yearMatch ? Number(yearMatch[1]) : undefined;
  return {
    kind: 'title',
    title: cleanHead,
    ...(year !== undefined && validYear(year) ? { year } : {}),
    ...tail,
  };
}

/** One candidate from the `/id?title=` Multiple Choices page. */
export interface TitleCandidate {
  item: string;
  title: string;
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeHtml(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] === '#') {
      const code =
        ref[1] === 'x' || ref[1] === 'X' ? Number.parseInt(ref.slice(2), 16) : Number(ref.slice(1));
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return NAMED_ENTITIES[ref.toLowerCase()] ?? whole;
  });
}

/**
 * Reads candidate items out of the 300 page by a bounded text scan of
 * `<li><a href="/id/…">title</a>` anchors inside `<div id="content">`. The page
 * is XHTML with a DOCTYPE, so it never reaches the XML parser.
 */
export function extractTitleCandidates(html: string, max = 20): TitleCandidate[] {
  const start = html.indexOf('id="content"');
  if (start === -1) return [];
  const end = html.indexOf('id="footerNav"', start);
  const region = html.slice(start, end === -1 ? start + 200_000 : end);
  const out: TitleCandidate[] = [];
  const seen = new Set<string>();
  for (const m of region.matchAll(/<li>\s*<a href="\/id\/([^"#?]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const item = (m[1] as string).replace(/\/+$/, '');
    if (seen.has(item) || !parseItemInput(item)?.item.full) continue;
    seen.add(item);
    out.push({
      item,
      title: decodeHtml((m[2] as string).replace(/<[^>]*>/g, ''))
        .replace(/\s+/g, ' ')
        .trim(),
    });
    if (out.length >= max) break;
  }
  return out;
}

/** Normalizes a title for exact matching: case, a leading "The", trailing status notes. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/\s*\((?:repealed|revoked)[^)]*\)\s*$/g, '')
    .replace(/^the\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}
