/**
 * @fileoverview Tests for the service seams the tools do not reach directly:
 * the init/accessor singleton, the injected clock, and each method's request
 * budget (a redirect chain that outruns it fails as a spent budget, not a
 * rate limit).
 * @module tests/services/legislation/legislation-service.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { searchLegislationTool } from '@/mcp-server/tools/definitions/search-legislation.tool.js';
import { createUpstream, feed, redirect, routes, testClock } from '../../helpers/upstream.js';

describe('service accessor', () => {
  it('throws until a service is registered, then returns it', async () => {
    vi.resetModules();
    const mod = await import('@/services/legislation/legislation-service.js');
    expect(() => mod.getLegislationService()).toThrow(/not initialized/);
    const up = createUpstream([], { register: false });
    mod.initLegislationService(up.service);
    expect(mod.getLegislationService()).toBe(up.service);
  });
});

describe('LegislationService', () => {
  it('reports today from the injected clock (UTC date)', () => {
    const up = createUpstream([], { clock: testClock('2026-09-26T23:30:00Z'), register: false });
    expect(up.service.today()).toBe('2026-09-26');
  });

  it('spends at most two requests on a search, redirect hops included', async () => {
    const up = createUpstream(
      routes(
        ['/all/data.feed?results-count=20', redirect(301, '/all/data.feed?results-count=20&x=1')],
        [
          '/all/data.feed?results-count=20&x=1',
          redirect(301, '/all/data.feed?results-count=20&x=2'),
        ],
        ['/all/data.feed?results-count=20&x=2', feed('search-zero-hits.feed')],
      ),
      { register: false },
    );
    const ctx = createMockContext({ errors: searchLegislationTool.errors });
    await expect(
      up.service.search({ types: ['all'], extentMatch: 'applicable', limit: 20, page: 1 }, ctx),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'request_budget_spent' },
    });
    expect(up.paths()).toHaveLength(2);
  });
});
