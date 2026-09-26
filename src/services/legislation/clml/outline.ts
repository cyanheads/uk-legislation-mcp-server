/**
 * @fileoverview Outlines: the item-level outline read from a table of contents
 * (top-level Parts, Chapters, Schedules and loose provisions, or every
 * `MatchText` hit), and the outline of an oversized fragment's child
 * provisions with their measured rendered size.
 * @module services/legislation/clml/outline
 */

import { provisionFromUri, provisionLabel } from '../provision-path.js';
import { attr, child, elements, textOf, type XmlElement } from '../xml.js';
import { renderNodes } from './render.js';

/** One outline entry. */
export interface OutlineEntry {
  chars?: number;
  heading?: string;
  label: string;
  level: number;
  matches_text?: boolean;
  provision: string;
  status?: string;
}

/** Table-of-contents containers listed at item level; cross-headings are walked through, not listed. */
const TOC_CONTAINERS = new Set([
  'ContentsPart',
  'ContentsChapter',
  'ContentsSchedule',
  'ContentsEUPart',
  'ContentsEUTitle',
  'ContentsEUChapter',
  'ContentsEUSection',
  'ContentsEUSubsection',
  'ContentsGroup',
  'ContentsAppendix',
  'ContentsDivision',
  'ContentsAttachment',
]);

const TOC_TEXT = new Set(['ContentsTitle', 'ContentsNumber']);

/** Item-level outline plus the table of contents' leaf-provision count. */
export interface TocOutline {
  entries: OutlineEntry[];
  /** `ContentsItem` count — leaf provisions. */
  leafCount: number;
  /** Entries found before the cap was applied. */
  total: number;
}

function tocEntry(node: XmlElement, item: string, level: number): OutlineEntry | undefined {
  const provision = provisionFromUri(attr(node, 'DocumentURI') ?? attr(node, 'IdURI'), item);
  if (!provision) return;
  const heading = textOf(child(node, 'ContentsTitle'));
  const status = attr(node, 'Status');
  return {
    provision,
    label: provisionLabel(provision),
    level,
    ...(heading ? { heading } : {}),
    ...(status ? { status } : {}),
    ...(attr(node, 'MatchText') === 'true' ? { matches_text: true } : {}),
  };
}

/**
 * Builds the item-level outline from `Contents`. Default mode lists containers
 * (Parts, Chapters, Schedules, EU divisions) and provisions outside any listed
 * container; `matchesOnly` lists every entry upstream marked `MatchText`.
 */
export function tocOutline(
  contents: XmlElement,
  item: string,
  max: number,
  matchesOnly: boolean,
): TocOutline {
  const entries: OutlineEntry[] = [];
  let leafCount = 0;
  let total = 0;
  const walk = (node: XmlElement, level: number): void => {
    for (const el of elements(node)) {
      if (TOC_TEXT.has(el.name)) continue;
      if (el.name === 'ContentsItem') leafCount += 1;
      const listed = matchesOnly
        ? attr(el, 'MatchText') === 'true'
        : TOC_CONTAINERS.has(el.name) || (el.name === 'ContentsItem' && level === 1);
      let nextLevel = level;
      if (listed) {
        const entry = tocEntry(el, item, level);
        if (entry) {
          total += 1;
          if (entries.length < max) entries.push(entry);
          if (TOC_CONTAINERS.has(el.name) || matchesOnly) nextLevel = level + 1;
        }
      }
      walk(el, nextLevel);
    }
  };
  walk(contents, 1);
  return { entries, leafCount, total };
}

/**
 * The nearest descendants of `target` carrying a `DocumentURI` — the
 * fragment's child provisions. A numbered provision wrapped in its heading
 * group is returned with the group so its heading renders with it.
 */
function childProvisions(target: XmlElement): { node: XmlElement; renderAs: XmlElement }[] {
  const out: { node: XmlElement; renderAs: XmlElement }[] = [];
  const walk = (node: XmlElement): void => {
    for (const el of elements(node)) {
      if (attr(el, 'DocumentURI')) {
        out.push({ node: el, renderAs: el });
        continue;
      }
      if (el.name === 'P1group') {
        const p1s = elements(el).filter((c) => attr(c, 'DocumentURI'));
        if (p1s.length === 1 && p1s[0]) {
          out.push({ node: p1s[0], renderAs: el });
          continue;
        }
      }
      walk(el);
    }
  };
  walk(target);
  return out;
}

/** Outline of an oversized fragment's child provisions, each measured by rendering it alone. */
export function fragmentOutline(
  root: XmlElement,
  target: XmlElement,
  item: string,
  max: number,
): OutlineEntry[] {
  return childProvisions(target)
    .slice(0, max)
    .map(({ node, renderAs }) => {
      const provision = provisionFromUri(attr(node, 'DocumentURI'), item) ?? '';
      const titleSource = renderAs === node ? child(node, 'Title') : child(renderAs, 'Title');
      const heading = textOf(titleSource) || textOf(child(child(node, 'TitleBlock'), 'Title'));
      const status = attr(node, 'Status') ?? attr(renderAs, 'Status');
      return {
        provision,
        label: provisionLabel(provision),
        level: 1,
        ...(heading ? { heading } : {}),
        ...(status ? { status } : {}),
        chars: renderNodes(root, [renderAs]).chars,
      };
    })
    .filter((entry) => entry.provision.length > 0);
}
