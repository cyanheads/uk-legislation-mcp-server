/**
 * @fileoverview Shared Atom feed readers: OpenSearch paging fields and the
 * `next` link that signals more pages.
 * @module services/legislation/atom/common
 */

import { attr, child, childrenNamed, textOf, type XmlElement } from '../xml.js';

/** Paging fields common to every legislation.gov.uk feed. */
export interface FeedPaging {
  hasMore: boolean;
  /** `openSearch:totalResults`, when upstream reports it. */
  total?: number;
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
  return {
    hasMore: childrenNamed(feed, 'link').some((l) => attr(l, 'rel') === 'next'),
    ...(total !== undefined ? { total } : {}),
  };
}

/** Feed entries in document order. */
export function entries(feed: XmlElement): XmlElement[] {
  return childrenNamed(feed, 'entry');
}
