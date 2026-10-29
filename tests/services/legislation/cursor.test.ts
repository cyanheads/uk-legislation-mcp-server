/**
 * @fileoverview Tests for the opaque continuation cursors: page, in-page
 * offset, walk date, page-search upper page, events-returned mark, the query fingerprint that
 * rejects a cursor replayed against another query, the bounds that reject a position no call over
 * the query produces (page ceiling, offset inside the page, day inside the walk, upper page above
 * the page in a page search only, the mark only as 1 on a Publication Log cursor), and a cursor an
 * earlier release minted.
 * @module tests/services/legislation/cursor.test
 */

import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, fingerprint } from '@/services/legislation/cursor.js';

const key = 'amendments|ukpga/2018/12|affected||all||50';
const plain = { pageSize: 50 };
const walk = (first: string, last: string) => ({ pageSize: 20, days: { first, last } });

function raw(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

describe('cursor', () => {
  it('round-trips a page', () => {
    expect(decodeCursor(encodeCursor(key, { page: 3, offset: 0 }), key, plain)).toEqual({
      page: 3,
      offset: 0,
    });
  });

  it('round-trips an in-page offset and a walk date', () => {
    const cursor = encodeCursor(key, { page: 1, offset: 7, date: '2026-09-23' });
    expect(decodeCursor(cursor, key, walk('2026-09-20', '2026-09-24'))).toEqual({
      page: 1,
      offset: 7,
      date: '2026-09-23',
    });
  });

  it('omits a zero offset from the payload', () => {
    const payload = JSON.parse(
      Buffer.from(encodeCursor(key, { page: 2, offset: 0 }), 'base64url').toString('utf8'),
    );
    expect(payload).toEqual({ k: fingerprint(key), p: 2 });
  });

  it('rejects a cursor minted for a different query', () => {
    const cursor = encodeCursor(key, { page: 2, offset: 0 });
    expect(decodeCursor(cursor, `${key}x`, plain)).toBeUndefined();
  });

  it('rejects garbage and malformed payloads', () => {
    const days = walk('2026-09-20', '2026-09-24');
    expect(decodeCursor('not a cursor!!', key, plain)).toBeUndefined();
    expect(decodeCursor(raw('text'), key, plain)).toBeUndefined();
    expect(decodeCursor(raw(null), key, plain)).toBeUndefined();
    expect(decodeCursor(raw({ k: fingerprint(key), p: 0 }), key, plain)).toBeUndefined();
    expect(decodeCursor(raw({ k: fingerprint(key), p: 1.5 }), key, plain)).toBeUndefined();
    expect(decodeCursor(raw({ k: fingerprint(key), p: 1, o: -1 }), key, plain)).toBeUndefined();
    expect(
      decodeCursor(raw({ k: fingerprint(key), p: 1, d: '24/09/2026' }), key, days),
    ).toBeUndefined();
    expect(decodeCursor(raw({ k: fingerprint(key), p: 1, d: 5 }), key, days)).toBeUndefined();
  });

  it('accepts a page up to 10,000 and rejects one past it', () => {
    const at = (p: number) => decodeCursor(raw({ k: fingerprint(key), p }), key, plain);
    expect(at(10_000)).toEqual({ page: 10_000, offset: 0 });
    expect(at(10_001)).toBeUndefined();
    expect(at(Number.MAX_SAFE_INTEGER)).toBeUndefined();
  });

  it('accepts an offset only inside the page it indexes', () => {
    const at = (o: number) => decodeCursor(raw({ k: fingerprint(key), p: 2, o }), key, plain);
    expect(at(49)).toEqual({ page: 2, offset: 49 });
    expect(at(50)).toBeUndefined();
  });

  it('requires a day walk cursor to name a calendar day inside the walk', () => {
    // 2026-02-30 sorts inside the walk but is not a calendar date.
    const days = walk('2026-02-20', '2026-03-05');
    const at = (d?: string) =>
      decodeCursor(
        raw({ k: fingerprint(key), p: 1, ...(d === undefined ? {} : { d }) }),
        key,
        days,
      );
    expect(at('2026-02-20')).toEqual({ page: 1, offset: 0, date: '2026-02-20' });
    expect(at('2026-03-05')).toEqual({ page: 1, offset: 0, date: '2026-03-05' });
    expect(at('2026-02-19')).toBeUndefined();
    expect(at('2026-03-06')).toBeUndefined();
    expect(at('2026-02-30')).toBeUndefined();
    expect(at()).toBeUndefined();
  });

  it('rejects a day on a cursor over a query that walks no days', () => {
    const cursor = raw({ k: fingerprint(key), p: 1, d: '2026-09-23' });
    expect(decodeCursor(cursor, key, plain)).toBeUndefined();
  });

  // Minted by v0.2.0's encodeCursor for `key` at page 8, before cursors could carry an upper page.
  const RELEASED = 'eyJrIjoiNWI0YjMyNmYiLCJwIjo4fQ';
  const search = { pageSize: 20, pageSearch: true };

  it('decodes a cursor minted by an earlier release, with or without a page search', () => {
    expect(decodeCursor(RELEASED, key, plain)).toEqual({ page: 8, offset: 0 });
    expect(decodeCursor(RELEASED, key, search)).toEqual({ page: 8, offset: 0 });
  });

  it('round-trips an upper page as h, after the payload an earlier release wrote', () => {
    const cursor = encodeCursor(key, { page: 8, offset: 0, upper: 64 });
    expect(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))).toEqual({
      k: fingerprint(key),
      p: 8,
      h: 64,
    });
    expect(decodeCursor(cursor, key, search)).toEqual({ page: 8, offset: 0, upper: 64 });
  });

  it('accepts an upper page only over a page search, above the page, up to 10,000', () => {
    const at = (h: unknown, bounds: Parameters<typeof decodeCursor>[2] = search) =>
      decodeCursor(raw({ k: fingerprint(key), p: 8, h }), key, bounds);
    expect(at(9)).toEqual({ page: 8, offset: 0, upper: 9 });
    expect(at(10_000)).toEqual({ page: 8, offset: 0, upper: 10_000 });
    expect(at(8)).toBeUndefined();
    expect(at(3)).toBeUndefined();
    expect(at(10_001)).toBeUndefined();
    expect(at(12.5)).toBeUndefined();
    expect(at('64')).toBeUndefined();
    expect(at(64, plain)).toBeUndefined();
    expect(at(64, walk('2026-09-20', '2026-09-24'))).toBeUndefined();
  });

  const log = {
    pageSize: 20,
    days: { first: '2026-09-20', last: '2026-09-24' },
    eventsReturned: true,
  };

  it('round-trips the events-returned mark as e: 1, after the payload an earlier release wrote, without changing the fingerprint', () => {
    const position = { page: 1, offset: 3, date: '2026-09-22' };
    const marked = encodeCursor(key, { ...position, returned: true });
    const payload = JSON.parse(Buffer.from(marked, 'base64url').toString('utf8'));
    expect(payload).toEqual({ k: fingerprint(key), p: 1, o: 3, d: '2026-09-22', e: 1 });
    const unmarked = JSON.parse(
      Buffer.from(encodeCursor(key, position), 'base64url').toString('utf8'),
    );
    expect(unmarked).not.toHaveProperty('e');
    expect(payload.k).toBe(unmarked.k);
    expect(decodeCursor(marked, key, log)).toEqual({ ...position, returned: true });
    expect(decodeCursor(encodeCursor(key, position), key, log)).toEqual(position);
  });

  it('accepts the events-returned mark only as the value the server writes, over a query whose cursors carry it', () => {
    const at = (e: unknown, bounds: Parameters<typeof decodeCursor>[2] = log) =>
      decodeCursor(raw({ k: fingerprint(key), p: 1, d: '2026-09-22', e }), key, bounds);
    expect(at(1)).toEqual({ page: 1, offset: 0, date: '2026-09-22', returned: true });
    expect(at(0)).toBeUndefined();
    expect(at(2)).toBeUndefined();
    expect(at(true)).toBeUndefined();
    expect(at('1')).toBeUndefined();
    expect(at(null)).toBeUndefined();
    // An amendments cursor, and a day walk whose bounds do not admit the mark, refuse it.
    expect(decodeCursor(raw({ k: fingerprint(key), p: 1, e: 1 }), key, plain)).toBeUndefined();
    expect(at(1, walk('2026-09-20', '2026-09-24'))).toBeUndefined();
    // Alongside a page search's upper page.
    expect(
      decodeCursor(raw({ k: fingerprint(key), p: 8, h: 64, e: 1 }), key, {
        ...search,
        eventsReturned: true,
      }),
    ).toEqual({ page: 8, offset: 0, upper: 64, returned: true });
  });

  it('decodes a cursor minted by an earlier release, which lacks the mark, over a query whose cursors carry it', () => {
    expect(decodeCursor(RELEASED, key, { ...search, eventsReturned: true })).toEqual({
      page: 8,
      offset: 0,
    });
  });

  it('fingerprint is a stable 8-hex FNV-1a hash', () => {
    expect(fingerprint('')).toBe('811c9dc5');
    expect(fingerprint(key)).toMatch(/^[0-9a-f]{8}$/);
    expect(fingerprint(key)).toBe(fingerprint(key));
    expect(fingerprint('a')).not.toBe(fingerprint('b'));
  });
});
