/**
 * @fileoverview Tests for the server entry point: the options `src/index.ts`
 * passes to `createApp()`, and its `setup()`/`teardown()` lifecycle — the
 * startup robots.txt read, the request gap the pacer is built with, the
 * identifying User-Agent, service registration, and release of the pacer and
 * response cache. `createApp` is replaced with a capture and `createPacer` is
 * wrapped in a pass-through spy; the robots.txt parser, pacer, cache, client
 * and service are real. `setup()` hands the global `fetch` to both the
 * robots.txt read and the client, so the strict fetch fake is stubbed over it.
 * @module tests/index.test
 */

import type { createApp } from '@cyanheads/mcp-ts-core';
import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { contentText, errorOf, feed, fixture, ORIGIN, ok, status } from './helpers/upstream.js';

type AppOptions = NonNullable<Parameters<typeof createApp>[0]>;
type Core = Parameters<NonNullable<AppOptions['setup']>>[0];

const captured = vi.hoisted(() => ({ options: undefined as AppOptions | undefined }));

vi.mock('@cyanheads/mcp-ts-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cyanheads/mcp-ts-core')>()),
  createApp: async (options: AppOptions) => {
    captured.options = options;
  },
}));

vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>();
  return { ...actual, createPacer: vi.fn(actual.createPacer) };
});

const ROBOTS = `${ORIGIN}/robots.txt`;
const NUMBER_DPA = `${ORIGIN}/ukpga/2018/data.feed?number=12`;
const REPO = 'https://github.com/cyanheads/uk-legislation-mcp-server';
const USER_AGENT = `uk-legislation-mcp-server/9.9.9 (+${REPO}; ops@example.org)`;

/** The recorded robots.txt: only a `*` group, with `Crawl-delay: 5`. */
const recordedRobots = () => ok(fixture('robots/robots.txt'), { contentType: 'text/plain' });

/** A robots.txt that adds a group for this server's product token. */
function robotsWithGroup(crawlDelayS: number): Response {
  return ok(
    `User-agent: *\nCrawl-delay: 5\n\nUser-agent: uk-legislation-mcp-server\nCrawl-delay: ${crawlDelayS}\n`,
    { contentType: 'text/plain' },
  );
}

/** The pacer options `setup()` is expected to build, at a given gap. */
function pacerOptions(minStartGapMs: number) {
  return {
    name: 'legislation-gov-uk',
    minStartGapMs,
    maxConcurrent: 4,
    maxQueueDepth: 50,
    cooldown: { baseMs: 60_000, maxMs: 300_000 },
  };
}

let running: { core: Core; options: AppOptions } | undefined;

beforeEach(() => {
  vi.stubEnv('UK_LEGISLATION_CONTACT', 'ops@example.org');
  vi.stubEnv('UK_LEGISLATION_MIN_REQUEST_GAP_MS', undefined);
  vi.stubEnv('UK_LEGISLATION_CACHE_MAX_MB', undefined);
});

afterEach(async () => {
  await running?.options.teardown?.(running.core);
  running = undefined;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/**
 * Evaluates `src/index.ts` in a fresh module registry, over a strict fetch
 * fake serving `robots` and the Data Protection Act 2018 number feed, and
 * returns what it registered plus the modules it shares that registry with.
 */
async function boot(robots: Response) {
  const http = createFetchMock([
    { match: ROBOTS, respond: robots },
    { match: NUMBER_DPA, respond: feed('number-ukpga-2018-12.feed') },
  ]);
  vi.stubGlobal('fetch', http.fetch);

  vi.resetModules();
  captured.options = undefined;
  await import('@/index.js');
  const options = captured.options as AppOptions | undefined;
  if (!options) throw new Error('src/index.ts did not call createApp()');

  const [{ allToolDefinitions }, { getLegislationService }, { lookupCitationTool }, utils] =
    await Promise.all([
      import('@/mcp-server/tools/definitions/index.js'),
      import('@/services/legislation/legislation-service.js'),
      import('@/mcp-server/tools/definitions/lookup-citation.tool.js'),
      import('@cyanheads/mcp-ts-core/utils'),
    ]);

  const logger = { notice: vi.fn(), warning: vi.fn() };
  const core = { config: { mcpServerVersion: '9.9.9' }, logger } as unknown as Core;

  return {
    allToolDefinitions,
    core,
    createPacer: vi.mocked(utils.createPacer),
    getLegislationService,
    http,
    logger,
    lookup: () => runToolContract(lookupCitationTool, { citation: '2018 c. 12' }),
    options,
    /** Runs `setup(core)`; a started server is torn down after the test. */
    async setup() {
      await options.setup!(core);
      running = { core, options };
    },
    teardown: () => options.teardown!(core),
  };
}

describe('createApp options', () => {
  it('registers the six tools, no resources or prompts, under the repo name', async () => {
    const { options, allToolDefinitions } = await boot(recordedRobots());
    expect(Object.keys(options).sort()).toEqual([
      'instructions',
      'name',
      'prompts',
      'resources',
      'setup',
      'teardown',
      'title',
      'tools',
    ]);
    expect(options.name).toBe('uk-legislation-mcp-server');
    expect(options.title).toBe('uk-legislation-mcp-server');
    expect(options.tools).toBe(allToolDefinitions);
    expect(options.tools).toHaveLength(6);
    expect(options.resources).toEqual([]);
    expect(options.prompts).toEqual([]);
  });

  it('names every registered tool in the instructions, and no other', async () => {
    const { options, allToolDefinitions } = await boot(recordedRobots());
    const named = new Set(options.instructions?.match(/\buklaw_[a-z_]+/g));
    expect([...named].sort()).toEqual(allToolDefinitions.map((t) => t.name).sort());
  });
});

describe('setup', () => {
  it('reads robots.txt under the identifying User-Agent, then registers the service', async () => {
    const app = await boot(recordedRobots());
    expect(() => app.getLegislationService()).toThrow('LegislationService not initialized');
    expect(app.createPacer).not.toHaveBeenCalled();

    await app.setup();

    expect(app.http.calls.map((c) => c.request.url)).toEqual([ROBOTS]);
    expect(app.http.calls[0]?.request.headers.get('user-agent')).toBe(USER_AGENT);
    expect(() => app.getLegislationService()).not.toThrow();

    const result = await app.lookup();
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ found: true, item: 'ukpga/2018/12' });
    expect(contentText(result)).toContain('ukpga/2018/12');
    expect(app.http.calls.map((c) => c.request.url)).toEqual([ROBOTS, NUMBER_DPA]);
    expect(app.http.calls[1]?.request.headers.get('user-agent')).toBe(USER_AGENT);
  });

  it('builds the pacer at the configured gap, ignoring the * group crawl delay', async () => {
    const app = await boot(recordedRobots());
    await app.setup();
    expect(app.createPacer).toHaveBeenCalledExactlyOnceWith(pacerOptions(1000));
    expect(app.logger.notice).not.toHaveBeenCalled();
    expect(app.logger.warning).not.toHaveBeenCalled();
  });

  it('raises the gap to a crawl delay robots.txt sets for this user agent', async () => {
    const app = await boot(robotsWithGroup(2));
    await app.setup();
    expect(app.createPacer).toHaveBeenCalledExactlyOnceWith(pacerOptions(2000));
    expect(app.logger.notice).toHaveBeenCalledExactlyOnceWith(
      'robots.txt sets a crawl delay for this user agent; raising the request gap',
      expect.objectContaining({ operation: 'setup', extra: { gapMs: 2000 } }),
    );
    expect(app.logger.warning).not.toHaveBeenCalled();
  });

  it('keeps a configured gap longer than the crawl delay', async () => {
    vi.stubEnv('UK_LEGISLATION_MIN_REQUEST_GAP_MS', '3000');
    const app = await boot(robotsWithGroup(2));
    await app.setup();
    expect(app.createPacer).toHaveBeenCalledExactlyOnceWith(pacerOptions(3000));
    expect(app.logger.notice).not.toHaveBeenCalled();
  });

  it('keeps the configured gap and still starts when robots.txt cannot be read', async () => {
    const app = await boot(status(500));
    await app.setup();
    expect(app.logger.warning).toHaveBeenCalledExactlyOnceWith(
      'robots.txt could not be read; keeping the configured request gap',
      expect.objectContaining({
        operation: 'setup',
        extra: { gapMs: 1000, error: 'robots.txt answered HTTP 500' },
      }),
    );
    expect(app.createPacer).toHaveBeenCalledExactlyOnceWith(pacerOptions(1000));
    expect(await app.lookup()).toMatchObject({ structuredContent: { found: true } });
  });

  it('leaves the contact out of the User-Agent when none is configured', async () => {
    vi.stubEnv('UK_LEGISLATION_CONTACT', undefined);
    const app = await boot(recordedRobots());
    await app.setup();
    expect(app.http.calls[0]?.request.headers.get('user-agent')).toBe(
      `uk-legislation-mcp-server/9.9.9 (+${REPO})`,
    );
  });

  it('fails startup on an invalid gap before any request, and the rollback teardown runs', async () => {
    vi.stubEnv('UK_LEGISLATION_MIN_REQUEST_GAP_MS', '100');
    const app = await boot(recordedRobots());
    await expect(app.options.setup!(app.core)).rejects.toThrow('UK_LEGISLATION_MIN_REQUEST_GAP_MS');
    expect(app.http.calls).toHaveLength(0);
    expect(app.createPacer).not.toHaveBeenCalled();
    expect(() => app.getLegislationService()).toThrow('LegislationService not initialized');
    expect(() => app.teardown()).not.toThrow();
  });
});

describe('teardown', () => {
  it('disposes the pacer and clears the cache, so a cached answer is no longer served', async () => {
    const app = await boot(recordedRobots());
    await app.setup();
    expect(await app.lookup()).toMatchObject({ structuredContent: { found: true } });
    expect(await app.lookup()).toMatchObject({ structuredContent: { found: true } });
    expect(app.http.calls).toHaveLength(2);

    await app.teardown();

    const after = await app.lookup();
    expect(errorOf(after).message).toContain('The legislation-gov-uk pacer has been disposed');
    expect(app.http.calls).toHaveLength(2);
  });
});
