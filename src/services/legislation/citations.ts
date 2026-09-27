/**
 * @fileoverview Citation grammar for `uklaw_lookup_citation` — numbered UK,
 * devolved, and EU-origin citations, legislation.gov.uk URIs, and short
 * titles, each with an optional provision tail or leading "section N of" —
 * plus the bounded text scan that reads candidates out of the `/id?title=`
 * 300 (Multiple Choices) page.
 * @module services/legislation/citations
 */

import { parseItemInput, splitLeadingProvision, splitProvisionTail } from './provision-path.js';
import type { ItemPath } from './types.js';

/** A citation as the parser read it. */
export type ParsedCitation =
  | { kind: 'numbered'; number: string; provision?: string; type: string; year: number }
  | { item: ItemPath; kind: 'uri'; provision?: string }
  | {
      /** A trailing `(c. N)`: the UK Act chapter number written after the title. */
      chapter?: string;
      kind: 'title';
      provision?: string;
      title: string;
      year?: number;
    }
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
    pattern: /^(\d{4})\s*c\.?\s*(\d+)\s*\(\s*N\.?\s*I\.?\s*\)$/i,
    build: (m) => ({ type: 'nia', year: m[1] as string, number: m[2] as string }),
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

/** The issuing body written before an EU act ("Council Regulation", "Commission Implementing Regulation"). */
const EU_ISSUER = String.raw`(?:(?:European\s+Parliament\s+and\s+(?:of\s+the\s+)?Council|(?:Council|Commission)(?:\s+(?:Implementing|Delegated))?)\s+)?`;

const EU_CITATION = new RegExp(
  String.raw`^${EU_ISSUER}(Regulation|Directive|Decision)\s*(?:\((?:EU|EC|EEC|Euratom)(?:\s*,\s*Euratom)?\))?\s*(No\.?\s*)?(\d{1,4})\/(\d{1,4})(?:\/(?:EC|EEC|EU|Euratom))?$`,
  'i',
);

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

/**
 * Short names legislation defines for an item, keyed by `normalizeTitle`:
 * `the UK GDPR` is Regulation (EU) 2016/679 as retained in UK law (Data
 * Protection Act 2018 s. 3(10)). A `Map`, because the key is caller text.
 */
const DEFINED_NAMES: ReadonlyMap<string, { type: string; year: number; number: string }> = new Map([
  ['uk gdpr', { type: 'eur', year: 2016, number: '679' }],
]);

/** A title followed by its UK Act chapter number: `Human Rights Act 1998 (c. 42)`. */
const TITLE_CHAPTER = /^(.*?)[\s,]*\(\s*c\.?\s*(\d+)\s*\)$/i;

/** Parses a citation, URI, or short title. */
export function parseCitation(raw: string): ParsedCitation {
  const input = raw.trim().replace(/\s+/g, ' ');
  if (input.length === 0) return { kind: 'unparsed' };

  const leading = splitLeadingProvision(input);
  const { head, provision } = leading.provision ? leading : splitProvisionTail(input);
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
  const defined = DEFINED_NAMES.get(normalizeTitle(cleanHead));
  if (defined) return { kind: 'numbered', ...defined, ...tail };

  if (!/[A-Za-z]/.test(cleanHead)) return { kind: 'unparsed' };
  const withChapter = TITLE_CHAPTER.exec(cleanHead);
  const chapterTitle = withChapter?.[1]?.replace(/[\s,;:.]+$/, '');
  const [title, chapter] =
    chapterTitle && /[A-Za-z]/.test(chapterTitle)
      ? [chapterTitle, String(Number(withChapter?.[2]))]
      : [cleanHead, undefined];
  const yearMatch = /\b(\d{4})\b(?!.*\b\d{4}\b)/.exec(title);
  const year = yearMatch ? Number(yearMatch[1]) : undefined;
  return {
    kind: 'title',
    title,
    ...(year !== undefined && validYear(year) ? { year } : {}),
    ...(chapter ? { chapter } : {}),
    ...tail,
  };
}

/** One candidate from the `/id?title=` Multiple Choices page. */
export interface TitleCandidate {
  item: string;
  title: string;
}

/** HTML named references the 300 page uses. A `Map`, because the key is upstream text. */
const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', ' '],
]);

function decodeHtml(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] === '#') {
      const code =
        ref[1] === 'x' || ref[1] === 'X' ? Number.parseInt(ref.slice(2), 16) : Number(ref.slice(1));
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return NAMED_ENTITIES.get(ref.toLowerCase()) ?? whole;
  });
}

/** Longest stretch of the 300 page read, from its `id="content"` marker. */
const CANDIDATE_REGION_CHARS = 200_000;
/** Longest anchor text read as a candidate title; a longer anchor is skipped. */
const MAX_CANDIDATE_TITLE_CHARS = 2_000;

/**
 * Reads candidate items out of the 300 page by a bounded text scan of
 * `<li><a href="/id/…">title</a>` anchors inside `<div id="content">`. The page
 * is XHTML with a DOCTYPE, so it never reaches the XML parser. The scan is
 * linear in the region: each anchor's title runs to the next `</a>`, the next
 * anchor is sought after it, the first anchor with no `</a>` after it ends the
 * scan, and an anchor text too long to be a title is skipped unread.
 */
export function extractTitleCandidates(html: string, max = 20): TitleCandidate[] {
  const start = html.indexOf('id="content"');
  if (start === -1) return [];
  const footer = html.indexOf('id="footerNav"', start);
  const region = html.slice(
    start,
    Math.min(footer === -1 ? html.length : footer, start + CANDIDATE_REGION_CHARS),
  );
  const out: TitleCandidate[] = [];
  const seen = new Set<string>();
  const anchor = /<li>\s*<a href="\/id\/([^"#?]+)"[^>]*>/g;
  for (let m = anchor.exec(region); m && out.length < max; m = anchor.exec(region)) {
    const titleStart = anchor.lastIndex;
    const titleEnd = region.indexOf('</a>', titleStart);
    if (titleEnd === -1) break;
    anchor.lastIndex = titleEnd + '</a>'.length;
    if (titleEnd - titleStart > MAX_CANDIDATE_TITLE_CHARS) continue;
    const item = (m[1] as string).replace(/\/+$/, '');
    if (seen.has(item) || !parseItemInput(item)?.item.full) continue;
    seen.add(item);
    out.push({
      item,
      title: decodeHtml(region.slice(titleStart, titleEnd).replace(/<[^>]*>/g, ''))
        .replace(/\s+/g, ' ')
        .trim(),
    });
  }
  return out;
}

/**
 * Normalizes a title for exact matching: case, a leading "The", trailing status
 * notes. Whitespace is collapsed first and a note's text holds no parenthesis,
 * so the note match is linear in the title, which can come from upstream.
 */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .replace(/\s*\((?:repealed|revoked)[^()]*\)\s*$/, '')
    .replace(/^the\s+/, '')
    .trim();
}
