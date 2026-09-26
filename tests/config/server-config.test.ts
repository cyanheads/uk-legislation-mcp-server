/**
 * @fileoverview Tests for the server config: defaults, the request-gap floor,
 * the cache-size range, and a blank contact read as unset. Each case loads a
 * fresh module so the lazily cached config does not leak between cases.
 * @module tests/config/server-config.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

async function load() {
  vi.resetModules();
  return (await import('@/config/server-config.js')).getServerConfig();
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getServerConfig', () => {
  it('applies the defaults', async () => {
    vi.stubEnv('UK_LEGISLATION_CONTACT', undefined);
    vi.stubEnv('UK_LEGISLATION_MIN_REQUEST_GAP_MS', undefined);
    vi.stubEnv('UK_LEGISLATION_CACHE_MAX_MB', undefined);
    await expect(load()).resolves.toEqual({ minRequestGapMs: 1000, cacheMaxMb: 64 });
  });

  it('reads the contact, gap, and cache size', async () => {
    vi.stubEnv('UK_LEGISLATION_CONTACT', '  ops@example.org ');
    vi.stubEnv('UK_LEGISLATION_MIN_REQUEST_GAP_MS', '250');
    vi.stubEnv('UK_LEGISLATION_CACHE_MAX_MB', '1024');
    await expect(load()).resolves.toEqual({
      contact: 'ops@example.org',
      minRequestGapMs: 250,
      cacheMaxMb: 1024,
    });
  });

  it.each(['', '   '])('treats a blank contact %j as unset', async (value) => {
    vi.stubEnv('UK_LEGISLATION_CONTACT', value);
    const config = await load();
    expect(config.contact).toBeUndefined();
  });

  it.each([
    ['UK_LEGISLATION_MIN_REQUEST_GAP_MS', '249'],
    ['UK_LEGISLATION_MIN_REQUEST_GAP_MS', 'fast'],
    ['UK_LEGISLATION_CACHE_MAX_MB', '7'],
    ['UK_LEGISLATION_CACHE_MAX_MB', '1025'],
  ])('refuses %s=%s at startup, naming the variable', async (name, value) => {
    vi.stubEnv(name, value);
    await expect(load()).rejects.toThrow(name);
  });

  it('parses once and caches the result', async () => {
    vi.stubEnv('UK_LEGISLATION_MIN_REQUEST_GAP_MS', '500');
    vi.resetModules();
    const { getServerConfig } = await import('@/config/server-config.js');
    const first = getServerConfig();
    vi.stubEnv('UK_LEGISLATION_MIN_REQUEST_GAP_MS', '900');
    expect(getServerConfig()).toBe(first);
    expect(first.minRequestGapMs).toBe(500);
  });
});
