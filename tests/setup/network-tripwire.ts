/**
 * @fileoverview Boundary guard loaded before every test file: the global
 * `fetch` and every outbound socket throw, so no part of the suite can reach
 * legislation.gov.uk (or anything else). Tests reach upstream only through the
 * injected fetch fake (`createFetchMock(...).fetch`).
 * @module tests/setup/network-tripwire
 */

import net from 'node:net';

/** Message prefix every tripwire error carries, asserted by the canary test. */
export const TRIPWIRE = 'Live network access is blocked in the test suite';

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = input instanceof Request ? input.url : String(input);
  throw new Error(`${TRIPWIRE}: fetch ${url}`);
}) as typeof globalThis.fetch;

net.Socket.prototype.connect = function blockedConnect(...args: unknown[]): never {
  throw new Error(`${TRIPWIRE}: socket connect ${JSON.stringify(args[0])}`);
} as typeof net.Socket.prototype.connect;
