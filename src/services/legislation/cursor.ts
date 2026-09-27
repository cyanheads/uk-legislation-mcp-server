/**
 * @fileoverview Opaque continuation cursors: base64url JSON carrying a
 * position and a fingerprint of the query that produced it, so a cursor
 * replayed against a different query is rejected rather than misread. The
 * fingerprint is unsigned, so a decoded position is also held to bounds a call
 * over the query can produce: a page ceiling, an offset inside the page, and a
 * walk day inside the window (Design Decision 75).
 * @module services/legislation/cursor
 */

import { isCalendarDate } from './provision-path.js';

/** A decoded cursor position. */
export interface CursorPosition {
  /** Day being walked (Publication Log day walk). */
  date?: string;
  /** Entries to skip on `page` (a page left part-way through). */
  offset: number;
  page: number;
}

/** The positions a call over one query can produce. */
export interface CursorBounds {
  /** Days a day walk can stand on, inclusive; absent for a query that walks no days. */
  days?: { first: string; last: string };
  /** Entries per upstream page: an offset always lies below it. */
  pageSize: number;
}

/**
 * Highest upstream page any call reaches: a cursor naming a later page is
 * refused (Design Decision 75), and `uklaw_search_legislation` `page` stops
 * here (Design Decision 77).
 */
export const MAX_PAGE = 10_000;

/** FNV-1a 32-bit hash, hex — a short, stable query fingerprint. */
export function fingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Encodes a position for a query fingerprint. */
export function encodeCursor(queryKey: string, position: CursorPosition): string {
  const payload = {
    k: fingerprint(queryKey),
    p: position.page,
    ...(position.offset > 0 ? { o: position.offset } : {}),
    ...(position.date ? { d: position.date } : {}),
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

/**
 * Decodes a cursor; undefined when it does not decode, belongs to another
 * query, or holds a position outside `bounds`.
 */
export function decodeCursor(
  cursor: string,
  queryKey: string,
  bounds: CursorBounds,
): CursorPosition | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return;
  }
  if (typeof payload !== 'object' || payload === null) return;
  const { k, p, o, d } = payload as Record<string, unknown>;
  if (k !== fingerprint(queryKey)) return;
  if (!Number.isInteger(p) || (p as number) < 1 || (p as number) > MAX_PAGE) return;
  if (
    o !== undefined &&
    !(Number.isInteger(o) && (o as number) >= 0 && (o as number) < bounds.pageSize)
  )
    return;
  if (bounds.days) {
    const { first, last } = bounds.days;
    if (typeof d !== 'string' || !isCalendarDate(d) || d < first || d > last) return;
  } else if (d !== undefined) return;
  return {
    page: p as number,
    offset: (o as number | undefined) ?? 0,
    ...(d ? { date: d as string } : {}),
  };
}
