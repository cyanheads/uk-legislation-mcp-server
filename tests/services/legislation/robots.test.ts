/**
 * @fileoverview Tests for the startup robots.txt read: only a group naming this
 * server's product token sets a crawl delay; the `*` group is ignored.
 * @module tests/services/legislation/robots.test
 */

import { createFetchMock } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { crawlDelayFor, readUserAgentCrawlDelay } from '@/services/legislation/robots.js';
import { fixture, ORIGIN, USER_AGENT } from '../../helpers/upstream.js';

const recorded = fixture('robots/robots.txt');
/** The recorded robots.txt with a group added for this server's product token. */
const withOwnGroup = `${recorded}\nUser-agent: uk-legislation-mcp-server\nCrawl-delay: 2\nDisallow: /defralex\n`;

function robotsFetch(body: string, status = 200) {
  return createFetchMock([
    {
      match: `${ORIGIN}/robots.txt`,
      respond: new Response(body, { status, headers: { 'content-type': 'text/plain' } }),
    },
  ]);
}

describe('crawlDelayFor', () => {
  it('ignores the * group of the recorded robots.txt', () => {
    expect(recorded).toContain('Crawl-delay: 5');
    expect(crawlDelayFor(recorded, 'uk-legislation-mcp-server')).toBeUndefined();
  });

  it('reads a delay from a group naming the product token', () => {
    expect(crawlDelayFor(withOwnGroup, 'uk-legislation-mcp-server')).toBe(2);
  });

  it('matches agent names case-insensitively and as a token substring', () => {
    const robots = 'User-agent: UK-Legislation\nCrawl-delay: 3\n';
    expect(crawlDelayFor(robots, 'uk-legislation-mcp-server')).toBe(3);
  });

  it('handles a group with several agents, comments and CRLF lines', () => {
    const robots =
      'User-agent: otherbot\r\nUser-agent: uk-legislation-mcp-server # us\r\nCrawl-delay: 1.5\r\n';
    expect(crawlDelayFor(robots, 'uk-legislation-mcp-server')).toBe(1.5);
  });

  it('keeps the longest delay across matching groups and skips invalid values', () => {
    const robots = [
      'User-agent: uk-legislation-mcp-server',
      'Crawl-delay: 2',
      '',
      'User-agent: uk-legislation-mcp-server',
      'Crawl-delay: 7',
      '',
      'User-agent: uk-legislation-mcp-server',
      'Crawl-delay: soon',
      'Crawl-delay: -1',
    ].join('\n');
    expect(crawlDelayFor(robots, 'uk-legislation-mcp-server')).toBe(7);
  });

  it('starts a new group after rules so a later group’s agents do not inherit', () => {
    const robots = [
      'User-agent: uk-legislation-mcp-server',
      'Disallow: /x',
      'User-agent: otherbot',
      'Crawl-delay: 9',
    ].join('\n');
    expect(crawlDelayFor(robots, 'uk-legislation-mcp-server')).toBeUndefined();
  });
});

describe('readUserAgentCrawlDelay', () => {
  it('fetches robots.txt once with the identifying User-Agent', async () => {
    const http = robotsFetch(withOwnGroup);
    await expect(
      readUserAgentCrawlDelay({ fetch: http.fetch, userAgent: USER_AGENT }),
    ).resolves.toBe(2);
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]?.request.headers.get('user-agent')).toBe(USER_AGENT);
  });

  it('returns undefined for the recorded robots.txt', async () => {
    const http = robotsFetch(recorded);
    await expect(
      readUserAgentCrawlDelay({ fetch: http.fetch, userAgent: USER_AGENT }),
    ).resolves.toBeUndefined();
  });

  it('throws on an HTTP failure so the caller keeps its configured gap', async () => {
    const http = robotsFetch('oops', 503);
    await expect(
      readUserAgentCrawlDelay({ fetch: http.fetch, userAgent: USER_AGENT }),
    ).rejects.toThrow(/HTTP 503/);
  });

  it('aborts a read that outlasts its timeout', async () => {
    const hanging = (async (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as typeof globalThis.fetch;
    await expect(
      readUserAgentCrawlDelay({ fetch: hanging, userAgent: USER_AGENT, timeoutMs: 20 }),
    ).rejects.toThrow();
  });
});
