/**
 * @fileoverview Canary for the suite's network guard: proves, under the guard,
 * that the global fetch and outbound sockets are blocked in every worker.
 * @module tests/setup/network-tripwire.test
 */

import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { TRIPWIRE } from './network-tripwire.js';

describe('network tripwire', () => {
  it('blocks the global fetch', async () => {
    await expect(fetch('https://www.legislation.gov.uk/robots.txt')).rejects.toThrow(TRIPWIRE);
  });

  it('blocks outbound sockets', () => {
    expect(() => net.connect({ host: 'www.legislation.gov.uk', port: 443 })).toThrow(TRIPWIRE);
  });
});
