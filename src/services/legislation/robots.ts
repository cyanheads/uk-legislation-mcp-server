/**
 * @fileoverview Reads legislation.gov.uk's robots.txt once at startup and
 * returns a `Crawl-delay` set for this server's own user agent. The `*` group
 * governs crawling, which this server never does, so its delay is ignored.
 * @module services/legislation/robots
 */

import { readTextWithin } from './legislation-client.js';
import { ORIGIN } from './urls.js';

/** Largest robots.txt read, in bytes. */
export const ROBOTS_MAX_BYTES = 512 * 1024;

/** Longest crawl delay applied, in seconds; `setup()` caps a longer one here and warns. */
export const MAX_CRAWL_DELAY_S = 60;

/** Inputs for {@link readUserAgentCrawlDelay}. */
export interface RobotsReadOptions {
  fetch: typeof globalThis.fetch;
  /** Abort the read after this long. */
  timeoutMs?: number;
  /** Full User-Agent; its product token (before the first `/`) selects the group. */
  userAgent: string;
}

/**
 * Parses robots.txt and returns the crawl delay in seconds from a group whose
 * `User-agent` names the product token; undefined when no such group sets one.
 */
export function crawlDelayFor(robotsTxt: string, productToken: string): number | undefined {
  const token = productToken.toLowerCase();
  let groupAgents: string[] = [];
  let inRules = false;
  let delay: number | undefined;
  for (const rawLine of robotsTxt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === 'user-agent') {
      if (inRules) {
        groupAgents = [];
        inRules = false;
      }
      groupAgents.push(value.toLowerCase());
      continue;
    }
    inRules = true;
    if (key !== 'crawl-delay') continue;
    const matches = groupAgents.some(
      (agent) => agent !== '*' && agent.length > 0 && token.includes(agent),
    );
    const seconds = Number(value);
    if (matches && Number.isFinite(seconds) && seconds > 0) delay = Math.max(delay ?? 0, seconds);
  }
  return delay;
}

/**
 * Fetches robots.txt with one request through the injected `fetch` and returns
 * the crawl delay (seconds) set for this user agent. Throws on a network or
 * HTTP failure or a file over {@link ROBOTS_MAX_BYTES}; the caller keeps the
 * configured gap.
 */
export async function readUserAgentCrawlDelay(
  options: RobotsReadOptions,
): Promise<number | undefined> {
  const response = await options.fetch(`${ORIGIN}/robots.txt`, {
    headers: { 'User-Agent': options.userAgent },
    signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
  });
  if (!response.ok) throw new Error(`robots.txt answered HTTP ${response.status}`);
  const robotsTxt = await readTextWithin(response, ROBOTS_MAX_BYTES);
  if (robotsTxt === undefined) {
    throw new Error(`robots.txt is over ${ROBOTS_MAX_BYTES / 1024} KiB; it was not read.`);
  }
  const productToken = options.userAgent.split('/')[0] ?? options.userAgent;
  return crawlDelayFor(robotsTxt, productToken);
}
