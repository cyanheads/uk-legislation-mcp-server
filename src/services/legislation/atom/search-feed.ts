/**
 * @fileoverview Parses search and listing feeds: result entries (bilingual
 * titles, alternative numbers, subjects), paging, and the type and year facets
 * that title and type/year listings carry.
 * @module services/legislation/atom/search-feed
 */

import { typeLabel } from '../reference-data.js';
import {
  attr,
  bilingualText,
  child,
  childrenNamed,
  legislationPath,
  parseXml,
  textOf,
  toHttps,
  type XmlElement,
} from '../xml.js';
import { entries, type FeedPaging, readPaging } from './common.js';

/** One search result. */
export interface SearchResult {
  alternative_numbers: { series: string; value: string }[];
  document_uri?: string;
  id_uri: string;
  item: string;
  made_date?: string;
  number?: string;
  subjects: string[];
  summary?: string;
  title: string;
  title_cy?: string;
  type: string;
  type_label: string;
  updated?: string;
  year?: number;
}

/** Type and year facets of a listing. */
export interface SearchFacets {
  types: { count: number; label: string; type: string }[];
  years: { count: number; year: number }[];
  years_omitted: number;
}

/** A parsed search feed. */
export interface SearchFeed extends FeedPaging {
  facets: SearchFacets;
  results: SearchResult[];
}

const MAX_FACET_YEARS = 25;

/** Parses one search/listing entry. */
export function parseSearchEntry(entry: XmlElement): SearchResult | undefined {
  const idUri = textOf(child(entry, 'id'));
  const item = legislationPath(idUri);
  if (!item) return;
  const type = item.split('/')[0] ?? '';
  const title = bilingualText(child(entry, 'title'));
  const summary = bilingualText(child(entry, 'summary')).en;
  const year = Number(attr(child(entry, 'ukm:Year'), 'Value'));
  const number = attr(child(entry, 'ukm:Number'), 'Value') ?? item.split('/').at(-1);
  const madeDate = attr(child(entry, 'ukm:CreationDate'), 'Date');
  const updated = textOf(child(entry, 'updated'));
  const documentHref = attr(
    childrenNamed(entry, 'link').find((l) => attr(l, 'rel') === undefined && attr(l, 'href')),
    'href',
  );
  const subjects = [
    ...new Set(
      childrenNamed(entry, 'category')
        .map((c) => attr(c, 'term'))
        .filter((t) => t !== undefined),
    ),
  ];
  return {
    item,
    id_uri: toHttps(idUri),
    title: title.en,
    ...(title.cy ? { title_cy: title.cy } : {}),
    type,
    type_label: typeLabel(type),
    ...(Number.isInteger(year) && year > 0 ? { year } : {}),
    ...(number ? { number } : {}),
    alternative_numbers: childrenNamed(entry, 'ukm:AlternativeNumber').flatMap((n) => {
      const series = attr(n, 'Category');
      const value = attr(n, 'Value');
      return series && value ? [{ series, value }] : [];
    }),
    ...(madeDate ? { made_date: madeDate } : {}),
    ...(summary ? { summary } : {}),
    subjects,
    ...(updated ? { updated } : {}),
    ...(documentHref ? { document_uri: toHttps(documentHref) } : {}),
  };
}

/**
 * Type code a facet link points at: the `type=` parameter or the first path
 * segment. A `type=` value is read only in a type code's shape (lowercase
 * letters), so nothing upstream sends is percent-decoded, which a malformed
 * escape would make throw.
 */
function facetTypeCode(href: string | undefined): string | undefined {
  if (!href) return;
  const param = /[?&]type=([a-z]+)(?=&|$)/.exec(href)?.[1];
  if (param) return param;
  const path = legislationPath(href);
  const first = path?.split('/')[0];
  return first && first !== 'search' ? first : undefined;
}

function parseFacets(feed: XmlElement): SearchFacets {
  const facets = child(feed, 'leg:facets');
  const types = childrenNamed(child(facets, 'leg:facetTypes'), 'leg:facetType').flatMap((facet) => {
    const mainType = attr(facet, 'type') ?? '';
    if (mainType.includes('|')) return [];
    const code = facetTypeCode(attr(facet, 'href'));
    const count = Number(attr(facet, 'value'));
    return code && Number.isInteger(count) ? [{ type: code, label: typeLabel(code), count }] : [];
  });
  const allYears = childrenNamed(child(facets, 'leg:facetYears'), 'leg:facetYear')
    .map((facet) => ({ year: Number(attr(facet, 'year')), count: Number(attr(facet, 'total')) }))
    .filter((f) => Number.isInteger(f.year) && Number.isInteger(f.count))
    .sort((a, b) => b.year - a.year);
  return {
    types,
    years: allYears.slice(0, MAX_FACET_YEARS),
    years_omitted: Math.max(0, allYears.length - MAX_FACET_YEARS),
  };
}

/** Parses a search or listing feed body. */
export function parseSearchFeed(body: string): SearchFeed {
  const feed = parseXml(body, 'a search feed');
  return {
    ...readPaging(feed),
    results: entries(feed)
      .map(parseSearchEntry)
      .filter((r) => r !== undefined),
    facets: parseFacets(feed),
  };
}
