/**
 * @fileoverview Opaque continuation cursors: base64url JSON carrying a
 * position and a fingerprint of the query that produced it, so a cursor
 * replayed against a different query is rejected rather than misread.
 * @module services/legislation/cursor
 */

/** A decoded cursor position. */
export interface CursorPosition {
  /** Day being walked (Publication Log day walk). */
  date?: string;
  /** Entries to skip on `page` (a page left part-way through). */
  offset: number;
  page: number;
}

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

/** Decodes a cursor; undefined when it does not decode or belongs to another query. */
export function decodeCursor(cursor: string, queryKey: string): CursorPosition | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return;
  }
  if (typeof payload !== 'object' || payload === null) return;
  const { k, p, o, d } = payload as Record<string, unknown>;
  if (k !== fingerprint(queryKey) || !Number.isInteger(p) || (p as number) < 1) return;
  if (o !== undefined && (!Number.isInteger(o) || (o as number) < 0)) return;
  if (d !== undefined && (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d))) return;
  return {
    page: p as number,
    offset: (o as number | undefined) ?? 0,
    ...(d ? { date: d as string } : {}),
  };
}
