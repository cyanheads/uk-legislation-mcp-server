/**
 * @fileoverview Tests for the service seams the tools do not reach directly:
 * the init/accessor singleton, the injected clock, and each method's request
 * budget (a redirect chain that outruns it fails as a spent budget, not a
 * rate limit; a provision read's item check runs on a budget of its own).
 * @module tests/services/legislation/legislation-service.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { getDocumentTool } from '@/mcp-server/tools/definitions/get-document.tool.js';
import { searchLegislationTool } from '@/mcp-server/tools/definitions/search-legislation.tool.js';
import { parseItemInput } from '@/services/legislation/provision-path.js';
import type { ItemPath } from '@/services/legislation/types.js';
import {
  clml,
  createUpstream,
  feed,
  notFound,
  redirect,
  routes,
  testClock,
} from '../../helpers/upstream.js';

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
  it.each([
    ['2026-09-26T23:30:00Z', '2026-09-27'],
    ['2026-01-15T23:30:00Z', '2026-01-15'],
  ])('reports today as the UK date from the injected clock (%s → %s)', (now, date) => {
    const up = createUpstream([], { clock: testClock(now), register: false });
    expect(up.service.today()).toBe(date);
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

describe('a provision read’s item check', () => {
  const S29 = (version: string) => `/ukpga/2006/46/section/29/${version}/data.xml`;
  const FEED = '/changes/unapplied/affected/ukpga/2006/46/data.feed?results-count=500';
  const query = (version: string) => ({
    item: parseItemInput('ukpga/2006/46')?.item as ItemPath,
    provision: 'section/29',
    version,
    language: 'en' as const,
    outlineOffset: 0,
  });
  const ctx = () => createMockContext({ errors: getDocumentTool.errors });

  it('adds no request to a provision read that finds no provision', async () => {
    const up = createUpstream(
      routes(
        [S29('2010-01-01'), notFound()],
        ['/id/ukpga/2006/46', redirect(303, '/ukpga/2006/46/contents')],
      ),
      { register: false },
    );
    await expect(up.service.getDocument(query('2010-01-01'), ctx())).resolves.toEqual({
      kind: 'not_found',
      which: 'provision',
      checkRan: true,
    });
    expect(up.paths()).toEqual([S29('2010-01-01'), '/id/ukpga/2006/46']);
    expect(up.unhandled).toEqual([]);
  });

  it('checks the feed on its own budget after a redirected dated read of original text spends all four of the read’s', async () => {
    const up = createUpstream(
      routes(
        [S29('2010-01-01'), redirect(307, S29('2010-01-02'))],
        [S29('2010-01-02'), notFound()],
        ['/id/ukpga/2006/46', redirect(303, '/ukpga/2006/46/contents/enacted')],
        [S29('enacted'), clml('ukpga-2006-46-section-29.xml')],
        [FEED, feed('changes-unapplied-affected-ukpga-2006-46.feed')],
      ),
      { register: false },
    );
    const outcome = await up.service.getDocument(query('2010-01-01'), ctx());
    expect(up.paths()).toEqual([
      S29('2010-01-01'),
      S29('2010-01-02'),
      '/id/ukpga/2006/46',
      S29('enacted'),
      FEED,
    ]);
    if (outcome.kind !== 'found') throw new Error(`expected a document, got ${outcome.kind}`);
    expect(outcome.output.unapplied_effects?.[0]?.affected.provisions_label).toBe('Pt. 3 Ch. 3');
    expect(outcome.notices.join(' ')).not.toContain('were not checked');
  });
});
