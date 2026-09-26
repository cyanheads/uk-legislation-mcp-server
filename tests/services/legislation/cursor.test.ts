/**
 * @fileoverview Tests for the opaque continuation cursors: page, in-page
 * offset, walk date, and the query fingerprint that rejects a cursor replayed
 * against another query.
 * @module tests/services/legislation/cursor.test
 */

import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, fingerprint } from '@/services/legislation/cursor.js';

const key = 'amendments|ukpga/2018/12|affected||all||50';

function raw(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

describe('cursor', () => {
  it('round-trips a page', () => {
    expect(decodeCursor(encodeCursor(key, { page: 3, offset: 0 }), key)).toEqual({
      page: 3,
      offset: 0,
    });
  });

  it('round-trips an in-page offset and a walk date', () => {
    const cursor = encodeCursor(key, { page: 1, offset: 7, date: '2026-09-23' });
    expect(decodeCursor(cursor, key)).toEqual({ page: 1, offset: 7, date: '2026-09-23' });
  });

  it('omits a zero offset from the payload', () => {
    const payload = JSON.parse(
      Buffer.from(encodeCursor(key, { page: 2, offset: 0 }), 'base64url').toString('utf8'),
    );
    expect(payload).toEqual({ k: fingerprint(key), p: 2 });
  });

  it('rejects a cursor minted for a different query', () => {
    const cursor = encodeCursor(key, { page: 2, offset: 0 });
    expect(decodeCursor(cursor, `${key}x`)).toBeUndefined();
  });

  it('rejects garbage and malformed payloads', () => {
    expect(decodeCursor('not a cursor!!', key)).toBeUndefined();
    expect(decodeCursor(raw('text'), key)).toBeUndefined();
    expect(decodeCursor(raw(null), key)).toBeUndefined();
    expect(decodeCursor(raw({ k: fingerprint(key), p: 0 }), key)).toBeUndefined();
    expect(decodeCursor(raw({ k: fingerprint(key), p: 1.5 }), key)).toBeUndefined();
    expect(decodeCursor(raw({ k: fingerprint(key), p: 1, o: -1 }), key)).toBeUndefined();
    expect(decodeCursor(raw({ k: fingerprint(key), p: 1, d: '24/09/2026' }), key)).toBeUndefined();
    expect(decodeCursor(raw({ k: fingerprint(key), p: 1, d: 5 }), key)).toBeUndefined();
  });

  it('fingerprint is a stable 8-hex FNV-1a hash', () => {
    expect(fingerprint('')).toBe('811c9dc5');
    expect(fingerprint(key)).toMatch(/^[0-9a-f]{8}$/);
    expect(fingerprint(key)).toBe(fingerprint(key));
    expect(fingerprint('a')).not.toBe(fingerprint('b'));
  });
});
