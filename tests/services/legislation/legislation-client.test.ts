/**
 * @fileoverview Tests for the HTTP boundary to legislation.gov.uk, driven
 * through the injected fetch fake and real pacers: per-kind accept-lists,
 * manual redirects (paced and budgeted), the response cache with TTL caps and
 * `If-Modified-Since` revalidation, stale bodies served when revalidation is
 * refused, 403/429 mapping inside the paced task, retries, budget and deadline.
 * @module tests/services/legislation/legislation-client.test
 */

import { JsonRpcErrorCode, McpError, rateLimited } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { createPacer } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchLegislationTool } from '@/mcp-server/tools/definitions/search-legislation.tool.js';
import { isCannotStart } from '@/services/legislation/legislation-client.js';
import { ResponseCache } from '@/services/legislation/response-cache.js';
import {
  clml,
  createUpstream,
  feed,
  gatedPacer,
  multipleChoices,
  notFound,
  ok,
  openPacer,
  recordingPacer,
  redirect,
  routes,
  status,
  testClock,
  USER_AGENT,
} from '../../helpers/upstream.js';

const ctx = () => createMockContext({ errors: searchLegislationTool.errors });
const S45 = '/ukpga/2018/12/section/45/data.xml';
const LAST_MODIFIED = 'Mon, 14 Sep 2026 16:04:15 GMT';

afterEach(() => {
  vi.useRealTimers();
});

describe('LegislationClient — answers by kind', () => {
  it('returns a 200 document with the identifying User-Agent and manual redirects', async () => {
    const up = createUpstream(routes([S45, clml('ukpga-2018-12-section-45.xml')]));
    const result = await up.client.get(S45, 'document', up.client.budget(4), ctx());
    expect(result).toMatchObject({ kind: 'ok', url: S45 });
    expect(result.kind === 'ok' && result.body).toContain('<dc:identifier>');
    const [request] = up.requests();
    expect(request?.url).toBe(`https://www.legislation.gov.uk${S45}`);
    expect(request?.headers.get('user-agent')).toBe(USER_AGENT);
    expect(request?.redirect).toBe('manual');
  });

  it.each([404, 400] as const)('a document %i is a not-found result', async (code) => {
    const up = createUpstream(routes([S45, notFound(code)]));
    await expect(up.client.get(S45, 'document', up.client.budget(4), ctx())).resolves.toEqual({
      kind: 'not_found',
      status: code,
      url: S45,
    });
  });

  it.each([404, 400] as const)('a feed %i is a validation error, not zero hits', async (code) => {
    const path = '/ukpga/2018/scotland/2020-01-01/data.feed?results-count=20';
    const up = createUpstream(routes([path, notFound(code)]));
    await expect(up.client.get(path, 'feed', up.client.budget(2), ctx())).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { status: code },
    });
  });

  it('identifier answers are results and are never followed', async () => {
    const up = createUpstream(
      routes(
        ['/id/ukpga/2018/12', redirect(303, '/ukpga/2018/12/contents')],
        ['/id?title=Data%20Protection%20Act', multipleChoices('id-title-300')],
        ['/id/ukpga/2018/99999', notFound()],
        ['/id/uksi/2002/808', redirect(301, 'http://www.legislation.gov.uk/id/wsi/2002/808')],
      ),
    );
    const b = up.client.budget(4);
    await expect(up.client.get('/id/ukpga/2018/12', 'identifier', b, ctx())).resolves.toEqual({
      kind: 'redirect',
      location: '/ukpga/2018/12/contents',
      status: 303,
    });
    const multiple = await up.client.get(
      '/id?title=Data%20Protection%20Act',
      'identifier',
      b,
      ctx(),
    );
    expect(multiple.kind).toBe('multiple');
    expect(multiple.kind === 'multiple' && multiple.body).toContain('20 items found');
    await expect(
      up.client.get('/id/ukpga/2018/99999', 'identifier', b, ctx()),
    ).resolves.toMatchObject({
      kind: 'not_found',
      status: 404,
    });
    await expect(up.client.get('/id/uksi/2002/808', 'identifier', b, ctx())).resolves.toEqual({
      kind: 'redirect',
      location: '/id/wsi/2002/808',
      status: 301,
    });
    expect(up.paths()).toHaveLength(4);
  });

  it('refuses an HTML page served as a 200 before parsing', async () => {
    const up = createUpstream([
      { path: S45, respond: ok('<!DOCTYPE html><html><body>maintenance</body></html>') },
    ]);
    await expect(up.client.get(S45, 'document', up.client.budget(1), ctx())).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: expect.stringMatching(/HTML page where XML was expected/),
    });
  });

  it('refuses a 200 XML body carrying a DOCTYPE', async () => {
    const up = createUpstream([
      {
        path: S45,
        respond: ok('<?xml version="1.0"?><!DOCTYPE x SYSTEM "file:///etc/passwd"><x/>'),
      },
    ]);
    await expect(up.client.get(S45, 'document', up.client.budget(1), ctx())).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
    });
  });
});

describe('LegislationClient — redirects', () => {
  it('follows an unrevised item’s 307 to /made, pacing and budgeting the hop', async () => {
    const pacer = recordingPacer(openPacer());
    const up = createUpstream(
      routes(
        [
          '/uksi/1985/2081/contents/data.xml',
          redirect(307, '/uksi/1985/2081/contents/made/data.xml'),
        ],
        ['/uksi/1985/2081/contents/made/data.xml', clml('uksi-1985-2081-contents-made.xml')],
      ),
      { pacer, clock: testClock() },
    );
    const result = await up.client.get(
      '/uksi/1985/2081/contents/data.xml',
      'document',
      up.client.budget(4),
      ctx(),
    );
    expect(result).toMatchObject({ kind: 'ok', url: '/uksi/1985/2081/contents/made/data.xml' });
    expect(up.paths()).toEqual([
      '/uksi/1985/2081/contents/data.xml',
      '/uksi/1985/2081/contents/made/data.xml',
    ]);
    expect(pacer.starts).toEqual([{ maxWaitMs: 40_000 }, { maxWaitMs: 40_000 }]);
  });

  it('resolves an absolute legislation.gov.uk Location to a path', async () => {
    const up = createUpstream(
      routes(
        [
          '/eur/2016/679/article/28/enacted/data.xml',
          redirect(301, 'https://www.legislation.gov.uk/eur/2016/679/article/28/adopted/data.xml'),
        ],
        ['/eur/2016/679/article/28/adopted/data.xml', clml('eur-2016-679-article-28.xml')],
      ),
    );
    await expect(
      up.client.get(
        '/eur/2016/679/article/28/enacted/data.xml',
        'document',
        up.client.budget(4),
        ctx(),
      ),
    ).resolves.toMatchObject({ kind: 'ok', url: '/eur/2016/679/article/28/adopted/data.xml' });
  });

  it('follows at most two hops', async () => {
    const up = createUpstream(
      routes(
        ['/a/data.xml', redirect(307, '/b/data.xml')],
        ['/b/data.xml', redirect(307, '/c/data.xml')],
        ['/c/data.xml', redirect(307, '/d/data.xml')],
      ),
    );
    await expect(
      up.client.get('/a/data.xml', 'document', up.client.budget(4), ctx()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: expect.stringMatching(/more than 2 times/),
    });
    expect(up.paths()).toEqual(['/a/data.xml', '/b/data.xml', '/c/data.xml']);
  });

  it('refuses a redirect to another host or without a Location', async () => {
    const up = createUpstream(
      routes(
        ['/a/data.xml', redirect(302, 'https://evil.example/ukpga/2018/12/data.xml')],
        ['/b/data.xml', redirect(307)],
      ),
    );
    for (const path of ['/a/data.xml', '/b/data.xml']) {
      await expect(
        up.client.get(path, 'document', up.client.budget(4), ctx()),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        message: expect.stringMatching(/without a usable Location/),
      });
    }
  });

  it('a feed redirected off its data.feed path is past its last page', async () => {
    const path = '/ukpga/data.feed?title=data%20protection&results-count=20&page=9';
    const up = createUpstream(
      routes([path, redirect(307, '/search?type=ukpga&title=data%20protection')]),
    );
    await expect(up.client.get(path, 'feed', up.client.budget(2), ctx())).resolves.toEqual({
      kind: 'past_end',
      url: path,
    });
    expect(up.paths()).toHaveLength(1);
  });

  it('a feed redirected to another data.feed path is followed', async () => {
    const up = createUpstream(
      routes(
        ['/search/data.feed?text=processor', redirect(301, '/all/data.feed?text=processor')],
        ['/all/data.feed?text=processor', feed('search-text-processor.feed')],
      ),
    );
    await expect(
      up.client.get('/search/data.feed?text=processor', 'feed', up.client.budget(2), ctx()),
    ).resolves.toMatchObject({ kind: 'ok', url: '/all/data.feed?text=processor' });
  });
});

describe('LegislationClient — cache', () => {
  it('serves a fresh hit without a request', async () => {
    const up = createUpstream(routes([S45, clml('ukpga-2018-12-section-45.xml')]));
    await up.client.get(S45, 'document', up.client.budget(4), ctx());
    await up.client.get(S45, 'document', up.client.budget(4), ctx());
    expect(up.paths()).toHaveLength(1);
  });

  it('caps an upstream max-age at one hour', async () => {
    const clock = testClock();
    const up = createUpstream(
      [{ path: S45, respond: clml('ukpga-2018-12-section-45.xml', { maxAge: 604_800 }) }],
      { clock },
    );
    await up.client.get(S45, 'document', up.client.budget(4), ctx());
    clock.t += 3_599_000;
    await up.client.get(S45, 'document', up.client.budget(4), ctx());
    expect(up.paths()).toHaveLength(1);
    clock.t += 2_000;
    await up.client.get(S45, 'document', up.client.budget(4), ctx());
    expect(up.paths()).toHaveLength(2);
  });

  it('caps the Publication Log at five minutes', async () => {
    const clock = testClock();
    const path = '/update/2026-09-24/data.feed';
    const up = createUpstream(
      [{ path, respond: feed('update-2026-09-24.feed', { maxAge: 3600 }) }],
      {
        clock,
      },
    );
    await up.client.get(path, 'feed', up.client.budget(4), ctx());
    clock.t += 299_000;
    await up.client.get(path, 'feed', up.client.budget(4), ctx());
    expect(up.paths()).toHaveLength(1);
    clock.t += 2_000;
    await up.client.get(path, 'feed', up.client.budget(4), ctx());
    expect(up.paths()).toHaveLength(2);
  });

  it('caps a not-found answer at ten minutes', async () => {
    const clock = testClock();
    const up = createUpstream([{ path: S45, respond: notFound() }], { clock });
    await up.client.get(S45, 'document', up.client.budget(4), ctx());
    clock.t += 599_000;
    await up.client.get(S45, 'document', up.client.budget(4), ctx());
    expect(up.paths()).toHaveLength(1);
    clock.t += 2_000;
    await up.client.get(S45, 'document', up.client.budget(4), ctx());
    expect(up.paths()).toHaveLength(2);
  });

  it('does not cache an answer without max-age', async () => {
    const up = createUpstream([
      {
        path: '/id?title=x',
        respond: new Response(null, {
          status: 301,
          headers: { location: '/id/ukpga/2018/12', 'cache-control': 'public, no-transform' },
        }),
      },
    ]);
    await up.client.get('/id?title=x', 'identifier', up.client.budget(4), ctx());
    await up.client.get('/id?title=x', 'identifier', up.client.budget(4), ctx());
    expect(up.paths()).toHaveLength(2);
  });

  it('caches each redirect hop by its own URL', async () => {
    const up = createUpstream(
      routes(
        [
          '/uksi/1985/2081/contents/data.xml',
          redirect(307, '/uksi/1985/2081/contents/made/data.xml'),
        ],
        ['/uksi/1985/2081/contents/made/data.xml', clml('uksi-1985-2081-contents-made.xml')],
      ),
    );
    const path = '/uksi/1985/2081/contents/data.xml';
    await up.client.get(path, 'document', up.client.budget(4), ctx());
    const again = await up.client.get(path, 'document', up.client.budget(4), ctx());
    expect(again).toMatchObject({ kind: 'ok', url: '/uksi/1985/2081/contents/made/data.xml' });
    expect(up.paths()).toHaveLength(2);
  });

  it('revalidates an expired entry with If-Modified-Since and renews it on 304', async () => {
    const clock = testClock();
    const up = createUpstream(
      [
        {
          path: S45,
          once: true,
          respond: clml('ukpga-2018-12-section-45.xml', { lastModified: LAST_MODIFIED }),
        },
        { path: S45, once: true, respond: status(304, { 'cache-control': 'max-age=3600' }) },
      ],
      { clock },
    );
    const first = await up.client.get(S45, 'document', up.client.budget(4), ctx());
    clock.t += 3_601_000;
    const second = await up.client.get(S45, 'document', up.client.budget(4), ctx());
    expect(second).toEqual(first);
    expect(up.requests()[1]?.headers.get('if-modified-since')).toBe(LAST_MODIFIED);
    clock.t += 3_000_000;
    await up.client.get(S45, 'document', up.client.budget(4), ctx());
    expect(up.paths()).toHaveLength(2);
  });

  it('refetches an expired entry without Last-Modified unconditionally', async () => {
    const clock = testClock();
    const up = createUpstream([{ path: S45, respond: clml('ukpga-2018-12-section-45.xml') }], {
      clock,
    });
    await up.client.get(S45, 'document', up.client.budget(4), ctx());
    clock.t += 3_601_000;
    await up.client.get(S45, 'document', up.client.budget(4), ctx());
    expect(up.requests()[1]?.headers.get('if-modified-since')).toBeNull();
  });

  it('serves the expired body when the revalidation is shed by the pacer', async () => {
    const clock = testClock();
    const cache = new ResponseCache({ maxBytes: 64 * 1024 * 1024, now: clock.now });
    const warm = createUpstream(
      [
        {
          path: S45,
          respond: clml('ukpga-2018-12-section-45.xml', { lastModified: LAST_MODIFIED }),
        },
      ],
      { clock, cache },
    );
    const fresh = await warm.client.get(S45, 'document', warm.client.budget(4), ctx());
    clock.t += 3_601_000;
    const shed = createUpstream([], { clock, cache, pacer: await gatedPacer(0) });
    await expect(shed.client.get(S45, 'document', shed.client.budget(4), ctx())).resolves.toEqual(
      fresh,
    );
    expect(shed.paths()).toEqual([]);
  });

  it.each([
    [403, {}],
    [429, { 'retry-after': '120' }],
  ] as const)(
    'serves the expired body when revalidation is refused with %i',
    async (code, headers) => {
      const clock = testClock();
      const up = createUpstream(
        [
          {
            path: S45,
            once: true,
            respond: clml('ukpga-2018-12-section-45.xml', { lastModified: LAST_MODIFIED }),
          },
          { path: S45, once: true, respond: status(code, headers) },
        ],
        { clock },
      );
      const fresh = await up.client.get(S45, 'document', up.client.budget(4), ctx());
      clock.t += 3_601_000;
      await expect(up.client.get(S45, 'document', up.client.budget(4), ctx())).resolves.toEqual(
        fresh,
      );
      expect(up.paths()).toHaveLength(2);
    },
  );

  it('does not serve an expired not-found answer when its refetch is shed', async () => {
    const clock = testClock();
    const cache = new ResponseCache({ maxBytes: 1024 * 1024, now: clock.now });
    const warm = createUpstream([{ path: S45, respond: notFound() }], { clock, cache });
    await warm.client.get(S45, 'document', warm.client.budget(4), ctx());
    clock.t += 601_000;
    const shed = createUpstream([], { clock, cache, pacer: await gatedPacer(0) });
    await expect(
      shed.client.get(S45, 'document', shed.client.budget(4), ctx()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'pacer_shed' },
    });
  });
});

describe('LegislationClient — refusals, retries, budget', () => {
  it('maps a 403 to upstream_refused with a five-minute retryAfter, without retrying', async () => {
    const up = createUpstream(routes([S45, status(403)]));
    const error = await up.client.get(S45, 'document', up.client.budget(4), ctx()).catch((e) => e);
    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'upstream_refused', retryAfter: 300, recovery: { hint: expect.any(String) } },
    });
    expect(up.paths()).toHaveLength(1);
  });

  it('maps a 429 to upstream_refused honouring Retry-After', async () => {
    const up = createUpstream(routes([S45, status(429, { 'retry-after': '120' })]));
    await expect(up.client.get(S45, 'document', up.client.budget(4), ctx())).rejects.toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'upstream_refused', retryAfter: 120 },
    });
    const noHeader = createUpstream(routes([S45, status(429)]));
    await expect(
      noHeader.client.get(S45, 'document', noHeader.client.budget(4), ctx()),
    ).rejects.toMatchObject({ data: { retryAfter: 300 } });
  });

  it.each([403, 429])(
    'a %i closes the shared pacer gate for the next request (mapped inside the paced task)',
    async (code) => {
      const pacer = createPacer({
        name: 'test-cooldown',
        cooldown: { baseMs: 60_000, maxMs: 300_000 },
      });
      const up = createUpstream(
        routes(
          [S45, status(code)],
          ['/ukpga/2018/12/section/46/data.xml', clml('ukpga-2018-12-section-45.xml')],
        ),
        { pacer },
      );
      await expect(
        up.client.get(S45, 'document', up.client.budget(4), ctx()),
      ).rejects.toMatchObject({
        data: { reason: 'upstream_refused' },
      });
      await expect(
        up.client.get('/ukpga/2018/12/section/46/data.xml', 'document', up.client.budget(4), ctx()),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.RateLimited,
        data: { reason: 'pacer_shed', retryAfter: expect.any(Number) },
      });
      expect(up.paths()).toEqual([S45]);
    },
  );

  it('sheds a request that cannot start within the call deadline as pacer_shed with a recovery', async () => {
    const up = createUpstream(routes([S45, clml('ukpga-2018-12-section-45.xml')]), {
      pacer: await gatedPacer(0),
    });
    const error = await up.client.get(S45, 'document', up.client.budget(4), ctx()).catch((e) => e);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: {
        reason: 'pacer_shed',
        retryAfter: expect.any(Number),
        recovery: { hint: expect.any(String) },
      },
    });
    expect(error.data.retryAfter).toBeGreaterThan(0);
    expect(isCannotStart(error)).toBe(true);
    expect(up.paths()).toEqual([]);
  });

  it('retries a 5xx once and succeeds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const up = createUpstream([
      { path: S45, once: true, respond: status(500) },
      { path: S45, respond: clml('ukpga-2018-12-section-45.xml') },
    ]);
    const pending = up.client.get(S45, 'document', up.client.budget(4), ctx());
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(pending).resolves.toMatchObject({ kind: 'ok' });
    expect(up.paths()).toHaveLength(2);
  });

  it('gives up after one retry with ServiceUnavailable', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const up = createUpstream([{ path: S45, respond: status(503) }]);
    const pending = up.client.get(S45, 'document', up.client.budget(4), ctx()).catch((e) => e);
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(pending).resolves.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: expect.objectContaining({ status: 503 }),
    });
    expect(up.paths()).toHaveLength(2);
  });

  it('maps a network failure to ServiceUnavailable', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const up = createUpstream([
      {
        path: S45,
        respond: () => {
          throw new TypeError('fetch failed');
        },
      },
    ]);
    const pending = up.client.get(S45, 'document', up.client.budget(4), ctx()).catch((e) => e);
    await vi.advanceTimersByTimeAsync(3_000);
    const error = await pending;
    expect(error).toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
    expect(error.message).toMatch(/Network error reaching legislation\.gov\.uk/);
  });

  it('does not retry when the budget has no request left', async () => {
    const up = createUpstream([{ path: S45, respond: status(500) }]);
    await expect(up.client.get(S45, 'document', up.client.budget(1), ctx())).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
    });
    expect(up.paths()).toHaveLength(1);
  });

  it('fails an unexpected status outside the accept-list without retrying', async () => {
    const up = createUpstream([{ path: S45, respond: status(410) }]);
    await expect(up.client.get(S45, 'document', up.client.budget(4), ctx())).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { status: 410 },
    });
    expect(up.paths()).toHaveLength(1);
  });

  it('times out one attempt after 30 s, retries once, and fails within the call deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const up = createUpstream([
      {
        path: S45,
        respond: (request) =>
          new Promise<Response>((_resolve, reject) => {
            request.signal.addEventListener('abort', () => reject(request.signal.reason));
          }),
      },
    ]);
    const pending = up.client.get(S45, 'document', up.client.budget(4), ctx()).catch((e) => e);
    await vi.advanceTimersByTimeAsync(50_000);
    await expect(pending).resolves.toMatchObject({ code: JsonRpcErrorCode.Timeout });
    expect(up.paths()).toHaveLength(2);
  });

  it('refuses a request once the budget is spent', async () => {
    const up = createUpstream(
      routes([S45, clml('ukpga-2018-12-section-45.xml')], ['/x/data.xml', notFound()]),
    );
    const budget = up.client.budget(1);
    await up.client.get('/x/data.xml', 'document', budget, ctx());
    const error = await up.client.get(S45, 'document', budget, ctx()).catch((e) => e);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'request_budget_spent' },
    });
    expect(isCannotStart(error)).toBe(true);
  });

  it('counts a redirect hop against the budget', async () => {
    const up = createUpstream(
      routes([
        '/uksi/1985/2081/contents/data.xml',
        redirect(307, '/uksi/1985/2081/contents/made/data.xml'),
      ]),
    );
    await expect(
      up.client.get('/uksi/1985/2081/contents/data.xml', 'document', up.client.budget(1), ctx()),
    ).rejects.toMatchObject({ data: { reason: 'request_budget_spent' } });
  });

  it('refuses a request once the call deadline has passed', async () => {
    const clock = testClock();
    const up = createUpstream(routes([S45, clml('ukpga-2018-12-section-45.xml')]), { clock });
    const budget = up.client.budget(4);
    clock.t += 45_001;
    await expect(up.client.get(S45, 'document', budget, ctx())).rejects.toMatchObject({
      data: { reason: 'request_budget_spent' },
    });
    expect(budget.remainingMs()).toBe(0);
  });

  it('times out a request that outlasts the call deadline', async () => {
    const up = createUpstream([
      {
        path: S45,
        respond: (request) =>
          new Promise<Response>((_resolve, reject) => {
            request.signal.addEventListener('abort', () => reject(request.signal.reason));
          }),
      },
    ]);
    await expect(
      up.client.get(S45, 'document', up.client.budget(1, 150), ctx()),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.Timeout });
  });
});

describe('isCannotStart', () => {
  it('is true only for a request that never started', () => {
    expect(isCannotStart(rateLimited('shed', { reason: 'pacer_shed' }))).toBe(true);
    expect(isCannotStart(rateLimited('x', { reason: 'upstream_refused' }))).toBe(false);
    expect(
      isCannotStart(
        new McpError(JsonRpcErrorCode.Timeout, 'x', { reason: 'retry_deadline_exceeded' }),
      ),
    ).toBe(true);
    expect(isCannotStart(new Error('pacer_shed'))).toBe(false);
    expect(isCannotStart(new McpError(JsonRpcErrorCode.ServiceUnavailable, 'x'))).toBe(false);
  });
});
