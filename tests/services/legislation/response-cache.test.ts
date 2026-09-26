/**
 * @fileoverview Tests for the process-level response cache: freshness by the
 * injected clock, LRU eviction by stored bytes, renewal after a 304, clearing.
 * @module tests/services/legislation/response-cache.test
 */

import { describe, expect, it } from 'vitest';
import { type CachedResponse, ResponseCache } from '@/services/legislation/response-cache.js';
import { testClock } from '../../helpers/upstream.js';

const entry = (body: string, expiresAt: number): CachedResponse => ({
  status: 200,
  body,
  expiresAt,
});

describe('ResponseCache', () => {
  it('reports freshness against the injected clock', () => {
    const clock = testClock();
    const cache = new ResponseCache({ maxBytes: 10_000, now: clock.now });
    cache.set('/a', entry('A', clock.t + 1000));
    expect(cache.get('/a')).toEqual({ entry: entry('A', clock.t + 1000), fresh: true });
    clock.t += 1000;
    expect(cache.get('/a')?.fresh).toBe(false);
    expect(cache.get('/a')?.entry.body).toBe('A');
  });

  it('returns undefined for a missing key', () => {
    expect(new ResponseCache({ maxBytes: 1000 }).get('/nope')).toBeUndefined();
  });

  it('evicts least-recently-used entries past the byte bound', () => {
    const clock = testClock();
    // Each entry costs 256 bytes of overhead plus its URL and body.
    const cache = new ResponseCache({ maxBytes: 3 * (256 + 2 + 100), now: clock.now });
    const body = 'x'.repeat(100);
    cache.set('/a', entry(body, clock.t + 1));
    cache.set('/b', entry(body, clock.t + 1));
    cache.set('/c', entry(body, clock.t + 1));
    cache.get('/a');
    cache.set('/d', entry(body, clock.t + 1));
    expect(cache.get('/b')).toBeUndefined();
    expect(cache.get('/a')).toBeDefined();
    expect(cache.get('/c')).toBeDefined();
    expect(cache.get('/d')).toBeDefined();
  });

  it('never stores an entry larger than the whole bound', () => {
    const cache = new ResponseCache({ maxBytes: 300 });
    cache.set('/big', entry('x'.repeat(500), Number.MAX_SAFE_INTEGER));
    expect(cache.get('/big')).toBeUndefined();
  });

  it('replacing an entry does not double-count its bytes', () => {
    const cache = new ResponseCache({ maxBytes: 2 * (256 + 2 + 50) });
    cache.set('/a', entry('x'.repeat(50), Number.MAX_SAFE_INTEGER));
    cache.set('/a', entry('y'.repeat(50), Number.MAX_SAFE_INTEGER));
    cache.set('/b', entry('z'.repeat(50), Number.MAX_SAFE_INTEGER));
    expect(cache.get('/a')?.entry.body).toBe('y'.repeat(50));
    expect(cache.get('/b')).toBeDefined();
  });

  it('counts Location bytes for redirect entries', () => {
    const cache = new ResponseCache({ maxBytes: 256 + 2 + 10 });
    cache.set('/r', { status: 303, location: 'x'.repeat(20), expiresAt: Number.MAX_SAFE_INTEGER });
    expect(cache.get('/r')).toBeUndefined();
  });

  it('renews an entry after revalidation and ignores unknown keys', () => {
    const clock = testClock();
    const cache = new ResponseCache({ maxBytes: 10_000, now: clock.now });
    cache.set('/a', entry('A', clock.t - 1));
    expect(cache.get('/a')?.fresh).toBe(false);
    cache.renew('/a', clock.t + 60_000);
    expect(cache.get('/a')?.fresh).toBe(true);
    expect(() => cache.renew('/missing', 1)).not.toThrow();
  });

  it('clear drops every entry', () => {
    const cache = new ResponseCache({ maxBytes: 10_000 });
    cache.set('/a', entry('A', Number.MAX_SAFE_INTEGER));
    cache.clear();
    expect(cache.get('/a')).toBeUndefined();
  });
});
