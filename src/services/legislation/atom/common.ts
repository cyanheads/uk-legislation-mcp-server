/**
 * @fileoverview Shared Atom feed readers: OpenSearch paging fields and the
 * `next` link that signals more pages.
 * @module services/legislation/atom/common
 */

import { attr, child, childrenNamed, textOf, type XmlElement } from '../xml.js';

/** Paging fields common to every legislation.gov.uk feed. */
export interface FeedPaging {
  hasMore: boolean;
  page: number;
  /** `openSearch:totalResults`, when upstream reports it. */
  total?: number;
  totalPages?: number;
}

function intOf(node: XmlElement | undefined): number | undefined {
  const text = textOf(node);
  if (!text) return;
  const value = Number(text);
  return Number.isInteger(value) ? value : undefined;
}

/** Reads paging from a feed root. `hasMore` comes from the presence of a `next` link. */
export function readPaging(feed: XmlElement): FeedPaging {
  const total = intOf(child(feed, 'openSearch:totalResults'));
  const totalPages = intOf(child(feed, 'leg:totalPages'));
  return {
    page: intOf(child(feed, 'leg:page')) ?? 1,
    hasMore: childrenNamed(feed, 'link').some((l) => attr(l, 'rel') === 'next'),
    ...(total !== undefined ? { total } : {}),
    ...(totalPages !== undefined ? { totalPages } : {}),
  };
}

/** Feed entries in document order. */
export function entries(feed: XmlElement): XmlElement[] {
  return childrenNamed(feed, 'entry');
}
