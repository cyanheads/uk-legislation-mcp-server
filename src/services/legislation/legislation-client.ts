/**
 * @fileoverview The HTTP boundary to legislation.gov.uk: plain `fetch` with a
 * per-kind status accept-list, identifying User-Agent, the process-wide pacer,
 * the shared response cache with `If-Modified-Since` revalidation, manual
 * redirect following (each hop paced and budgeted, at most two), a per-call
 * request budget and deadline, a response body size cap, and upstream error
 * mapping.
 * @module services/legislation/legislation-client
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  JsonRpcErrorCode,
  McpError,
  rateLimited,
  serviceUnavailable,
  timeout,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { defaultIsTransient, type Pacer, withRetry } from '@cyanheads/mcp-ts-core/utils';
import type { CachedResponse, ResponseCache } from './response-cache.js';
import { ORIGIN } from './urls.js';

/** What a request fetches; decides which statuses are results and how redirects are handled. */
export type RequestKind = 'document' | 'feed' | 'identifier';

/** A classified upstream answer. */
export type UpstreamResult =
  | { kind: 'ok'; body: string; url: string }
  | { kind: 'not_found'; status: number; url: string }
  | { kind: 'redirect'; location: string; status: number }
  | { kind: 'multiple'; body: string }
  | { kind: 'past_end'; url: string };

/** Per-call gap reserved for the response after the last request starts. */
const RESPONSE_MARGIN_MS = 5_000;
const PER_ATTEMPT_TIMEOUT_MS = 30_000;
const MAX_REDIRECT_HOPS = 2;
const MAX_TTL_S = 3_600;
const UPDATE_FEED_TTL_S = 300;
const NOT_FOUND_TTL_S = 600;
const BLOCK_RETRY_AFTER_S = 300;
/** Shortest `Retry-After` passed on to the caller: the pacer's cooldown after a 429 is at least this long. */
const MIN_RETRY_AFTER_S = 60;
/** Longest `Retry-After` passed on to the caller, in seconds. */
const MAX_RETRY_AFTER_S = 3_600;

/** Origins a redirect may name. Only its path and query are kept, fetched from {@link ORIGIN}. */
const REDIRECT_ORIGINS: ReadonlySet<string> = new Set([
  'https://www.legislation.gov.uk',
  'http://www.legislation.gov.uk',
  'https://legislation.gov.uk',
  'http://legislation.gov.uk',
]);

/**
 * Largest response body read, in bytes after decompression. The largest
 * measured fragment (the Companies Act 2006 `body`) decodes to about 13.5 MB.
 */
export const MAX_BODY_BYTES = 24 * 1024 * 1024;

/** Reasons that mean a request could not start (as opposed to failing upstream). */
const CANNOT_START_REASONS = new Set([
  'pacer_shed',
  'request_budget_spent',
  'retry_deadline_exceeded',
]);

/**
 * One tool call's request allowance: at most `maxRequests` upstream requests
 * (redirect hops and retries included) inside a wall-clock deadline.
 */
export class CallBudget {
  private used = 0;

  constructor(
    readonly maxRequests: number,
    readonly deadlineAt: number,
    private readonly now: () => number,
  ) {}

  /** Milliseconds left before the call's deadline. */
  remainingMs(): number {
    return Math.max(0, this.deadlineAt - this.now());
  }

  /** True while another request may start. */
  canStart(): boolean {
    return this.used < this.maxRequests && this.remainingMs() > 0;
  }

  /** Draws one request unit. */
  draw(): void {
    this.used += 1;
  }
}

/**
 * True when an error means a request never started — a pacer shed, the call's
 * request budget or deadline spent. A call holding a partial result degrades
 * on these instead of failing.
 */
export function isCannotStart(error: unknown): boolean {
  return (
    error instanceof McpError &&
    typeof error.data?.reason === 'string' &&
    CANNOT_START_REASONS.has(error.data.reason)
  );
}

/** Constructor dependencies — every boundary is injectable for tests. */
export interface LegislationClientOptions {
  cache: ResponseCache;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  pacer: Pacer;
  userAgent: string;
}

interface RawAnswer {
  body?: string;
  lastModified?: string;
  location?: string;
  maxAgeS?: number;
  status: number;
}

function parseMaxAge(cacheControl: string | null): number | undefined {
  const match = /(?:^|[,\s])max-age=(\d+)/i.exec(cacheControl ?? '');
  return match ? Number(match[1]) : undefined;
}

/**
 * Reads a response body as UTF-8 text, refusing it past `maxBytes`: a declared
 * `Content-Length` over the cap cancels the body unread, and otherwise the
 * streamed bytes are counted and the stream cancelled at the first chunk past
 * it. Undefined when refused. Counting the stream is what enforces the cap:
 * legislation.gov.uk sends chunked gzip with no `Content-Length`.
 */
export async function readTextWithin(
  response: Response,
  maxBytes: number,
): Promise<string | undefined> {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    return;
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      return;
    }
    text += decoder.decode(value, { stream: true });
  }
}

/**
 * Resolves a `Location` header to an origin-relative path; undefined when it
 * does not parse or names any other origin (another host, scheme or port).
 */
function resolveLocation(location: string, from: string): string | undefined {
  const url = URL.parse(location, `${ORIGIN}${from}`);
  if (!url || !REDIRECT_ORIGINS.has(url.origin)) return;
  return `${url.pathname}${url.search}`;
}

/**
 * A `Retry-After` in delay-seconds, clamped to 60 s – 1 h; undefined for any
 * other form (an HTTP date, a negative or fractional value), which the caller
 * treats as absent.
 */
function retryAfterSeconds(header: string | null): number | undefined {
  const value = header?.trim();
  if (!value || !/^\d+$/.test(value)) return;
  return Math.min(Math.max(Number(value), MIN_RETRY_AFTER_S), MAX_RETRY_AFTER_S);
}

/** Paced, cached, budgeted HTTP client for legislation.gov.uk. */
export class LegislationClient {
  private readonly cache: ResponseCache;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly pacer: Pacer;
  private readonly userAgent: string;

  constructor(options: LegislationClientOptions) {
    this.cache = options.cache;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.pacer = options.pacer;
    this.userAgent = options.userAgent;
  }

  /** A fresh request allowance for one tool call. */
  budget(maxRequests: number, deadlineMs = 45_000): CallBudget {
    return new CallBudget(maxRequests, this.now() + deadlineMs, this.now);
  }

  /**
   * Fetches an origin-relative path and classifies the answer by kind.
   * Documents and feeds follow redirects (each hop paced and budgeted); a feed
   * redirected off its `data.feed` path is past its last page. Identifier
   * requests return their 300/301/303/404 as results without following.
   */
  async get(
    path: string,
    kind: RequestKind,
    budget: CallBudget,
    ctx: Context,
  ): Promise<UpstreamResult> {
    let url = path;
    for (let hop = 0; ; hop += 1) {
      const answer = await this.fetchOne(url, budget, ctx);
      const { status } = answer;
      if (status === 200) return { kind: 'ok', body: answer.body ?? '', url };
      if (status === 300 && kind === 'identifier')
        return { kind: 'multiple', body: answer.body ?? '' };
      if (status >= 300 && status < 400) {
        const location = answer.location ? resolveLocation(answer.location, url) : undefined;
        if (!location) {
          throw serviceUnavailable(
            `legislation.gov.uk redirected ${url} without a usable Location header.`,
          );
        }
        if (kind === 'identifier') return { kind: 'redirect', location, status };
        if (kind === 'feed' && !/\/data\.feed(?:\?|$)/.test(location))
          return { kind: 'past_end', url };
        if (hop >= MAX_REDIRECT_HOPS) {
          throw serviceUnavailable(
            `legislation.gov.uk redirected ${path} more than ${MAX_REDIRECT_HOPS} times.`,
          );
        }
        url = location;
        continue;
      }
      if (status === 404 || status === 400) {
        if (kind === 'feed') {
          throw validationError(
            `legislation.gov.uk refused ${url} (HTTP ${status}) — a filter combination it does not accept.`,
            { status, reason: 'filter_refused', ...ctx.recoveryFor('filter_refused') },
          );
        }
        return { kind: 'not_found', status, url };
      }
      throw serviceUnavailable(`legislation.gov.uk answered HTTP ${status} for ${url}.`, {
        status,
      });
    }
  }

  /** One logical request: a fresh cache hit costs nothing; a stale one revalidates. */
  private async fetchOne(url: string, budget: CallBudget, ctx: Context): Promise<CachedResponse> {
    const cached = this.cache.get(url);
    if (cached?.fresh) return cached.entry;

    const stale = cached?.entry;
    const conditional =
      stale?.lastModified && stale.body !== undefined ? stale.lastModified : undefined;
    let answer: RawAnswer;
    try {
      answer = await this.request(url, budget, ctx, conditional);
    } catch (error) {
      if (
        stale?.body !== undefined &&
        error instanceof McpError &&
        error.code === JsonRpcErrorCode.RateLimited
      ) {
        ctx.log.debug('Serving stale cached response; upstream request could not run', { url });
        return stale;
      }
      throw error;
    }

    if (answer.status === 304 && stale) {
      const expiresAt = this.expiry(url, 200, answer.maxAgeS ?? MAX_TTL_S);
      this.cache.renew(url, expiresAt);
      return { ...stale, expiresAt };
    }

    const entry: CachedResponse = {
      status: answer.status,
      expiresAt: this.expiry(url, answer.status, answer.maxAgeS),
      ...(answer.body !== undefined ? { body: answer.body } : {}),
      ...(answer.location ? { location: answer.location } : {}),
      ...(answer.lastModified ? { lastModified: answer.lastModified } : {}),
    };
    if (entry.expiresAt > this.now()) this.cache.set(url, entry);
    return entry;
  }

  private expiry(url: string, status: number, maxAgeS: number | undefined): number {
    if (maxAgeS === undefined) return 0;
    let ttl = Math.min(maxAgeS, MAX_TTL_S);
    if (url.startsWith('/update')) ttl = Math.min(ttl, UPDATE_FEED_TTL_S);
    if (status === 404 || status === 400) ttl = Math.min(ttl, NOT_FOUND_TTL_S);
    return this.now() + ttl * 1000;
  }

  /**
   * Sends one request through the pacer with retry outside it. Each attempt
   * draws a budget unit when it starts and waits in the queue no longer than
   * the call deadline allows.
   */
  private async request(
    url: string,
    budget: CallBudget,
    ctx: Context,
    ifModifiedSince?: string,
  ): Promise<RawAnswer> {
    if (!budget.canStart()) {
      throw serviceUnavailable('This call has spent its upstream request budget.', {
        reason: 'request_budget_spent',
        retryable: false,
      });
    }
    try {
      return await withRetry(
        (attempt) =>
          this.pacer.run(
            (signal) => {
              budget.draw();
              return this.send(
                url,
                signal,
                Math.min(PER_ATTEMPT_TIMEOUT_MS, attempt.remainingMs),
                ctx,
                ifModifiedSince,
              );
            },
            {
              signal: attempt.signal,
              maxWaitMs: Math.max(0, budget.remainingMs() - RESPONSE_MARGIN_MS),
            },
          ),
        {
          operation: 'legislation.gov.uk request',
          context: ctx,
          signal: ctx.signal,
          maxRetries: 1,
          baseDelayMs: 2_000,
          deadlineMs: budget.remainingMs(),
          isTransient: (error) =>
            error instanceof McpError &&
            (error.code === JsonRpcErrorCode.ServiceUnavailable ||
              error.code === JsonRpcErrorCode.Timeout) &&
            defaultIsTransient(error) &&
            budget.canStart(),
        },
      );
    } catch (error) {
      if (error instanceof McpError && error.data?.reason === 'pacer_shed') {
        throw rateLimited(
          error.message,
          { ...error.data, ...ctx.recoveryFor('pacer_shed') },
          { cause: error },
        );
      }
      throw error;
    }
  }

  /** One HTTP exchange, bounded by its own timeout and the caller's signal. */
  private async send(
    url: string,
    signal: AbortSignal,
    timeoutMs: number,
    ctx: Context,
    ifModifiedSince?: string,
  ): Promise<RawAnswer> {
    const timer = new AbortController();
    const handle = setTimeout(() => timer.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(`${ORIGIN}${url}`, {
        headers: {
          'User-Agent': this.userAgent,
          ...(ifModifiedSince ? { 'If-Modified-Since': ifModifiedSince } : {}),
        },
        redirect: 'manual',
        signal: AbortSignal.any([signal, timer.signal]),
      });
      const { status } = response;
      const maxAgeS = parseMaxAge(response.headers.get('cache-control'));
      const lastModified = response.headers.get('last-modified') ?? undefined;
      const meta = {
        status,
        ...(maxAgeS !== undefined ? { maxAgeS } : {}),
        ...(lastModified ? { lastModified } : {}),
      };

      if (status === 403 || status === 429) {
        await response.body?.cancel();
        const retryAfter =
          (status === 429 ? retryAfterSeconds(response.headers.get('retry-after')) : undefined) ??
          BLOCK_RETRY_AFTER_S;
        ctx.log.warning('legislation.gov.uk refused a request; closing the request gate', {
          url,
          status,
        });
        throw rateLimited(
          `legislation.gov.uk refused the request (HTTP ${status}) — the fair use rate limit or a block. Requests are paused for every caller of this server.`,
          { reason: 'upstream_refused', retryAfter, ...ctx.recoveryFor('upstream_refused') },
        );
      }
      if (status >= 500) {
        await response.body?.cancel();
        throw serviceUnavailable(`legislation.gov.uk answered HTTP ${status} for ${url}.`, {
          status,
        });
      }
      if (status === 200 || status === 300) {
        const body = await readTextWithin(response, MAX_BODY_BYTES);
        if (body === undefined) {
          throw serviceUnavailable(
            `legislation.gov.uk returned more than ${MAX_BODY_BYTES / 1024 ** 2} MB for ${url}; the response was refused before parsing.`,
            {
              retryable: false,
              recovery: {
                hint: 'Read a smaller part: pass one provision (a Part, Chapter, section or Schedule) rather than the whole item or a large fragment.',
              },
            },
          );
        }
        if (status === 200 && /<!DOCTYPE|^\s*<html[\s>]/i.test(body)) {
          throw serviceUnavailable(
            `legislation.gov.uk returned an HTML page where XML was expected for ${url}; it was refused before parsing.`,
          );
        }
        return { ...meta, body };
      }
      await response.body?.cancel();
      if (status >= 300 && status < 400) {
        const location = response.headers.get('location') ?? undefined;
        return { ...meta, ...(location ? { location } : {}) };
      }
      return meta;
    } catch (error) {
      if (error instanceof McpError) throw error;
      if (timer.signal.aborted && !signal.aborted) {
        throw timeout(`legislation.gov.uk did not answer ${url} within ${timeoutMs} ms.`);
      }
      if (signal.aborted) throw error;
      throw serviceUnavailable(
        `Network error reaching legislation.gov.uk: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        { cause: error },
      );
    } finally {
      clearTimeout(handle);
    }
  }
}
