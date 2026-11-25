/**
 * @fileoverview Item, provision, and version normalization. Parses item paths
 * and legislation.gov.uk URIs (splitting out any provision, version, and
 * language they carry), normalizes citation shorthand for provisions
 * (`s. 45(2)(f)` → `section/45/2/f`), maps version keywords to the path segment
 * each type uses, and validates calendar dates.
 * @module services/legislation/provision-path
 */

import { PROVISION_KEYWORDS, STANDALONE_PROVISIONS, typeByCode } from './reference-data.js';
import type { ItemPath, ParsedItemInput } from './types.js';

/** `YYYY-MM-DD` shape. */
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a well-shaped date that is also a real calendar date. */
export function isCalendarDate(value: string): boolean {
  if (!DATE_SHAPE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

const VERSION_KEYWORDS = new Set(['enacted', 'made', 'adopted', 'created']);
const EXTENT_SEGMENT = /^=?(england|wales|scotland|ni)(\+(england|wales|scotland|ni))*$/i;
const DATA_SUFFIX = /^data\.[a-z]+$/i;
const CALENDAR_YEAR = /^\d{4}$/;
const MONARCH = /^[A-Z][A-Za-z]*\d*$/;
const SESSION = /^\d[\dA-Za-z-]*$/;
const NUMBER = /^(\d+|[ivxlcdm]+)$/;
const VALUE = /^[0-9A-Za-z][0-9A-Za-z.-]*$/;

/** Strips a legislation.gov.uk origin and `/id`, returning path segments; undefined for a foreign URL. */
function pathSegments(raw: string): string[] | undefined {
  let value = raw.trim();
  const url = /^(?:https?:\/\/)?(?:www\.)?legislation\.gov\.uk(\/[^?#]*)?(?:[?#].*)?$/i.exec(value);
  if (url) value = url[1] ?? '';
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return;
  value = value.replace(/[?#].*$/, '');
  const segments = value.split('/').filter((s) => s.length > 0);
  if (segments[0]?.toLowerCase() === 'id') segments.shift();
  return segments;
}

/**
 * Parses an item path or legislation.gov.uk URI. A partial path (type, or type
 * and year) is returned only when `allowPartial` is set; trailing provision,
 * version, and `welsh` segments are split out. Undefined when the input is not
 * a recognizable item.
 */
export function parseItemInput(
  raw: string,
  { allowPartial = false }: { allowPartial?: boolean } = {},
): ParsedItemInput | undefined {
  const segments = pathSegments(raw)?.filter(
    (s) => s.toLowerCase() !== 'contents' && !DATA_SUFFIX.test(s),
  );
  if (!segments || segments.length === 0) return;
  const type = segments[0]?.toLowerCase() ?? '';
  if (!typeByCode(type)) return;

  let index = 1;
  let year: string | undefined;
  let regnal = false;
  const first = segments[1];
  if (first !== undefined && CALENDAR_YEAR.test(first)) {
    year = first;
    index = 2;
  } else if (first !== undefined && MONARCH.test(first) && SESSION.test(segments[2] ?? '')) {
    year = `${first}/${segments[2]}`;
    regnal = true;
    index = 3;
  }

  let number: string | undefined;
  const candidate = segments[index];
  if (year && candidate !== undefined && NUMBER.test(candidate)) {
    number = candidate;
    index += 1;
  }

  const full = Boolean(year && number);
  if (!full) {
    if (!allowPartial || index < segments.length) return;
    if (!year && segments.length > 1) return;
  }

  let version: string | undefined;
  let language: 'cy' | undefined;
  const provisionSegments: string[] = [];
  for (const segment of segments.slice(index)) {
    const lower = segment.toLowerCase();
    if (lower === 'welsh') language = 'cy';
    else if (VERSION_KEYWORDS.has(lower) || lower === 'prospective') version = lower;
    else if (DATE_SHAPE.test(segment)) version = segment;
    else if (EXTENT_SEGMENT.test(segment)) continue;
    else provisionSegments.push(segment);
  }

  let provision: string | undefined;
  if (provisionSegments.length > 0) {
    provision = validateProvisionPath(provisionSegments);
    if (!provision) return;
  }

  const item: ItemPath = {
    path: [type, year, number].filter(Boolean).join('/'),
    type,
    ...(year ? { year } : {}),
    ...(number ? { number } : {}),
    full,
    regnal,
  };
  return {
    item,
    ...(provision ? { provision } : {}),
    ...(version ? { version } : {}),
    ...(language ? { language } : {}),
  };
}

/** Validates provision path segments; returns the normalized path or undefined. */
function validateProvisionPath(segments: string[]): string | undefined {
  const [head] = segments;
  if (head === undefined) return;
  const keyword = head.toLowerCase();
  if (!PROVISION_KEYWORDS.has(keyword)) return;
  if (STANDALONE_PROVISIONS.has(keyword)) return segments.length === 1 ? keyword : undefined;
  const out: string[] = [];
  let expectValue = false;
  for (const segment of segments) {
    const lower = segment.toLowerCase();
    if (PROVISION_KEYWORDS.has(lower) && !STANDALONE_PROVISIONS.has(lower)) {
      if (expectValue) return;
      out.push(lower);
      expectValue = true;
      continue;
    }
    if (!VALUE.test(segment)) return;
    out.push(segment);
    expectValue = false;
  }
  return expectValue ? undefined : out.join('/');
}

/**
 * Citation shorthand keyword → path keyword. A `Map`, because the key is
 * caller text: an object literal would answer `constructor` from `Object.prototype`.
 */
const SHORTHAND: ReadonlyMap<string, string> = new Map([
  ['s', 'section'],
  ['sec', 'section'],
  ['section', 'section'],
  ['reg', 'regulation'],
  ['regulation', 'regulation'],
  ['art', 'article'],
  ['article', 'article'],
  ['r', 'rule'],
  ['rule', 'rule'],
  ['sch', 'schedule'],
  ['schedule', 'schedule'],
  ['para', 'paragraph'],
  ['paragraph', 'paragraph'],
  ['pt', 'part'],
  ['part', 'part'],
  ['ch', 'chapter'],
  ['chapter', 'chapter'],
]);

/**
 * One shorthand component, read at `lastIndex` (sticky): a keyword, an optional
 * dot, a value, its bracketed sub-levels, and the spaces or commas before the
 * next component (`Sch. 2, para. 3`). A value is digit-led and may be dotted
 * (`45A`, `r. 3.4`, as procedure rules number theirs), one or two capitals then
 * digits and optional capitals (`A6`, `ZA1`, `A1A`), or a roman numeral and
 * optional capitals after it (`IV`, `XA`, `VIIA`). The capital-led form is
 * tried before the roman one, so `C1` is not read as roman `C`. Those two
 * forms take capitals only: legislation.gov.uk serves `section/A6`, not
 * `section/a6`.
 */
const SHORTHAND_PART =
  /\s*([A-Za-z]+)\.?\s*(\d+[A-Za-z]*(?:\.\d+[A-Za-z]*)*|[A-Z]{1,2}\d+[A-Z]*|[IVXLC][A-Z]*)((?:\s*\(\s*[0-9A-Za-z]+\s*\))*)[\s,]*/y;

const SUB_LEVEL = /\(\s*([0-9A-Za-z]+)\s*\)/g;

/**
 * Reads shorthand from `start` to the end of `text`: the provision path, or
 * undefined unless every character from `start` parses. `failed` holds the
 * offsets reads of the same text passed through on their way to a failure; a
 * read reaching one fails there, so a search over many start offsets reads each
 * component once.
 */
function readShorthand(text: string, start: number, failed: Set<number>): string | undefined {
  const out: string[] = [];
  const visited: number[] = [];
  let at = start;
  while (at < text.length) {
    visited.push(at);
    SHORTHAND_PART.lastIndex = at;
    const match = failed.has(at) ? null : SHORTHAND_PART.exec(text);
    const keyword = match ? SHORTHAND.get(match[1]?.toLowerCase() ?? '') : undefined;
    if (!match || !keyword) {
      for (const offset of visited) failed.add(offset);
      return;
    }
    out.push(keyword, match[2] as string);
    for (const sub of (match[3] ?? '').matchAll(SUB_LEVEL)) out.push(sub[1] as string);
    at = SHORTHAND_PART.lastIndex;
  }
  return out.length > 0 ? out.join('/') : undefined;
}

/** Parses a shorthand provision (`s. 45(2)(f)`, `Sch. 2 para. 3`, `r. 3.4`); undefined unless the whole string parses. */
function parseShorthand(raw: string): string | undefined {
  return readShorthand(raw.trim(), 0, new Set());
}

/**
 * Normalizes a provision input: a path (`section/45/2/f`) or citation
 * shorthand (`s. 45(2)(f)`, `Sch. 2 para. 3(1)`, `Pt 3 Ch. 2`). Undefined when
 * neither form parses.
 */
export function normalizeProvision(raw: string): string | undefined {
  // The lookbehind starts the trailing match only where a run of slashes starts, keeping it linear.
  const value = raw.trim().replace(/^\/+|(?<!\/)\/+$/g, '');
  if (value.length === 0) return;
  if (value.includes('/')) return validateProvisionPath(value.split('/').filter(Boolean));
  const single = value.toLowerCase();
  if (STANDALONE_PROVISIONS.has(single)) return single;
  return parseShorthand(value);
}

/**
 * Where a provision tail may start: a shorthand keyword, then a value's first
 * characters (a digit, one or two letters and a digit, or a word starting with
 * a roman numeral's letter). A superset of the values `SHORTHAND_PART` reads;
 * the read from each candidate decides.
 */
const TAIL_START = new RegExp(
  // A roman-led word is matched once, so the scan is linear in its length.
  String.raw`(?:^|[\s,])((?:${[...SHORTHAND.keys()].join('|')})\.?\s*(?:\d|[A-Z]{1,2}\d|[IVXLC][A-Z]*\b))`,
  'gi',
);

// Spaces and commas closing a citation's head; the lookbehind starts a match only where a run starts, keeping it linear.
const TRAILING_SEPARATORS = /(?<![\s,])[\s,]+$/;

/**
 * Finds a provision shorthand tail at the end of a citation: the earliest
 * keyword position from which the rest of the string parses completely.
 * Returns the head (citation without the tail) and the provision path.
 */
export function splitProvisionTail(citation: string): { head: string; provision?: string } {
  const failed = new Set<number>();
  for (const match of citation.matchAll(TAIL_START)) {
    const start = (match.index ?? 0) + match[0].length - (match[1]?.length ?? 0);
    const provision = readShorthand(citation, start, failed);
    if (provision) {
      return { head: citation.slice(0, start).replace(TRAILING_SEPARATORS, ''), provision };
    }
  }
  return { head: citation.trim() };
}

const BEFORE_OF = /^(.+?)\s+of\s+(?:the\s+)?(?=\S)/i;
const BEFORE_TO = /^(.+?)\s+to\s+(?:the\s+)?(?=\S)/i;

/** Splits off shorthand that parses completely before `joiner`'s word; undefined when none does. */
function splitBefore(
  citation: string,
  joiner: RegExp,
): { head: string; provision: string } | undefined {
  const match = joiner.exec(citation);
  const provision = match ? parseShorthand(match[1] as string) : undefined;
  return match && provision ? { head: citation.slice(match[0].length), provision } : undefined;
}

/**
 * Finds a provision written before its citation: shorthand that parses
 * completely, then `of` and an optional `the` (`section 45 of the Data
 * Protection Act 2018`), or a Schedule, then `to` (`Schedule 2 to the Data
 * Protection Act 2018`), as drafting writes them. A provision `of` a Schedule
 * `to` its item nests under the Schedule (`paragraph 3 of Schedule 2 to the …`
 * → `schedule/2/paragraph/3`). Only a Schedule splits before `to`, so a range
 * (`section 1 to 5 of the …`) and a title holding "to" stay whole. Takes the
 * citation with its whitespace collapsed, as `parseCitation` passes it, and
 * returns the citation after the provision as the head.
 */
export function splitLeadingProvision(citation: string): { head: string; provision?: string } {
  const of = splitBefore(citation, BEFORE_OF);
  const to = splitBefore(of?.head ?? citation, BEFORE_TO);
  if (to?.provision.startsWith('schedule/')) {
    return { head: to.head, provision: of ? `${to.provision}/${of.provision}` : to.provision };
  }
  return of ?? { head: citation };
}

/** Maps a version input to the path segment the item's type uses (undefined for current). */
export function versionSegment(version: string, type: string): string | undefined {
  if (version === 'current') return;
  if (VERSION_KEYWORDS.has(version)) return typeByCode(type)?.enactedKeyword ?? 'enacted';
  return version;
}

/** True when a version keyword names the as-enacted text. */
export function isEnactedKeyword(version: string | undefined): boolean {
  return version !== undefined && VERSION_KEYWORDS.has(version);
}

const LABEL_WORDS: Readonly<Record<string, string>> = {
  section: 'Section',
  regulation: 'Regulation',
  article: 'Article',
  rule: 'Rule',
  schedule: 'Schedule',
  paragraph: 'paragraph',
  part: 'Part',
  chapter: 'Chapter',
  crossheading: 'Cross-heading',
};

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Human label for a provision path (`section/45/2/f` → `Section 45(2)(f)`). */
export function provisionLabel(path: string): string {
  const segments = path.split('/');
  const parts: string[] = [];
  let current = '';
  let values = 0;
  for (const segment of segments) {
    if (PROVISION_KEYWORDS.has(segment)) {
      if (current) parts.push(current);
      current = LABEL_WORDS[segment] ?? capitalize(segment);
      values = 0;
      continue;
    }
    current = values === 0 ? `${current} ${segment}` : `${current}(${segment})`;
    values += 1;
  }
  if (current) parts.push(current);
  return parts.join(' ');
}

/** The provision path of a document URI relative to its item, version and language segments removed. */
export function provisionFromUri(uri: string | undefined, item: string): string | undefined {
  if (!uri) return;
  const parsed = parseItemInput(uri);
  if (!parsed || parsed.item.path !== item) return;
  return parsed.provision;
}
