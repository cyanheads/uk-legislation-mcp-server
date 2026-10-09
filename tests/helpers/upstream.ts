/**
 * @fileoverview legislation.gov.uk test boundary: loads recorded fixtures,
 * builds responses shaped like upstream's (status, `Cache-Control`,
 * `Last-Modified`, `Location`), and wires a real `LegislationClient` +
 * `LegislationService` over a strict `createFetchMock` harness routed on
 * origin + path + query. Pacers are real `createPacer` instances.
 * @module tests/helpers/upstream
 */

import { readFileSync } from 'node:fs';
import type { McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  type FetchMockHarness,
  type runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { createPacer, type Pacer, type PacerRunOptions } from '@cyanheads/mcp-ts-core/utils';
import { LegislationClient } from '@/services/legislation/legislation-client.js';
import {
  initLegislationService,
  LegislationService,
} from '@/services/legislation/legislation-service.js';
import { ResponseCache } from '@/services/legislation/response-cache.js';

export const ORIGIN = 'https://www.legislation.gov.uk';
export const USER_AGENT =
  'uk-legislation-mcp-server/0.1.0 (+https://github.com/cyanheads/uk-legislation-mcp-server; test@example.org)';

const FIXTURES = new URL('../fixtures/', import.meta.url);

/** Reads a recorded fixture under `tests/fixtures/`. */
export function fixture(path: string): string {
  return readFileSync(new URL(path, FIXTURES), 'utf8');
}

interface OkOptions {
  contentType?: string;
  lastModified?: string;
  /** `max-age` in seconds; `null` sends no `Cache-Control` max-age at all. */
  maxAge?: number | null;
}

/** A 200 answer with upstream's caching headers. */
export function ok(body: string, options: OkOptions = {}): Response {
  const maxAge = options.maxAge === undefined ? 3600 : options.maxAge;
  const headers: Record<string, string> = {
    'content-type': options.contentType ?? 'application/xml;charset=utf-8',
    'cache-control':
      maxAge === null ? 'public, no-transform' : `max-age=${maxAge}, s-maxage=${maxAge}, public`,
  };
  if (options.lastModified) headers['last-modified'] = options.lastModified;
  return new Response(body, { status: 200, headers });
}

/** A recorded CLML document (`tests/fixtures/clml/…`) as a 200. */
export function clml(name: string, options: OkOptions = {}): Response {
  return ok(fixture(`clml/${name}`), options);
}

/** A recorded Atom feed (`tests/fixtures/feeds/…`) as a 200. */
export function feed(name: string, options: OkOptions = {}): Response {
  return ok(fixture(`feeds/${name}`), {
    contentType: 'application/atom+xml;charset=utf-8',
    ...options,
  });
}

/** A redirect with upstream's HTML stub body and a `Location` header. */
export function redirect(status: 300 | 301 | 302 | 303 | 307 | 308, location?: string): Response {
  const headers: Record<string, string> = {
    'content-type': 'text/html;charset=utf-8',
    'cache-control': 'max-age=3600, s-maxage=3600, public, no-transform',
  };
  if (location !== undefined) headers.location = location;
  return new Response(fixture('html/redirect-307.html.txt'), { status, headers });
}

/** The generic HTML not-found page upstream answers a missing document with. */
export function notFound(status: 400 | 404 = 404): Response {
  return new Response(fixture('html/not-found.html.txt'), {
    status,
    headers: {
      'content-type': 'text/html;charset=utf-8',
      'cache-control': 'max-age=604800, s-maxage=604800, public, no-transform',
    },
  });
}

/** The `/id?title=` or `/id/{item}` 300 (Multiple Choices) XHTML page, by capture name. */
export function multipleChoices(name: 'id-title-300' | 'id-ukpga-1955-19-300'): Response {
  return new Response(fixture(`html/${name}.html.txt`), {
    status: 300,
    headers: {
      'content-type': 'text/html;charset=utf-8',
      'cache-control': 'max-age=604800, s-maxage=604800, public, no-transform',
    },
  });
}

/** A bare status answer (403, 429, 500, 304, …) with optional headers. */
export function status(code: number, headers: Record<string, string> = {}): Response {
  const nullBody = code === 304 || code === 204;
  return new Response(nullBody ? null : `<html><body>${code}</body></html>`, {
    status: code,
    headers: { 'content-type': 'text/html;charset=utf-8', ...headers },
  });
}

/** A streamed body and what its reader did to it. */
export interface StreamedBody {
  state: { cancelled: boolean; pulled: number };
  stream: ReadableStream<Uint8Array>;
}

/**
 * A body of `total` bytes of `x`, produced 1 MiB per pull only as the reader
 * asks, recording the bytes pulled and whether the reader cancelled it.
 */
export function streamedBody(total: number): StreamedBody {
  const chunkBytes = 1024 * 1024;
  const chunk = new Uint8Array(chunkBytes).fill(0x78);
  const state = { cancelled: false, pulled: 0 };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const size = Math.min(chunkBytes, total - state.pulled);
        if (size === 0) {
          controller.close();
          return;
        }
        state.pulled += size;
        controller.enqueue(chunk.slice(0, size));
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, state };
}

/** A pacer that starts every request immediately. */
export function openPacer(): Pacer {
  return createPacer({ name: 'test', minStartGapMs: 0 });
}

/**
 * A real pacer that lets `freeStarts` requests start and sheds every later
 * one: the next slot sits an hour out, far past any call's wait budget.
 */
export async function gatedPacer(freeStarts: number): Promise<Pacer> {
  const pacer = createPacer({
    name: 'test-gated',
    limits: [{ requests: Math.max(1, freeStarts), perMs: 3_600_000 }],
  });
  if (freeStarts === 0) await pacer.run(async () => undefined);
  return pacer;
}

/** One recorded `pacer.run` call. */
export interface PacerStart {
  maxWaitMs: number | undefined;
}

/** Wraps a pacer, recording each run's options, and forwarding to it. */
export function recordingPacer(inner: Pacer): Pacer & { starts: PacerStart[] } {
  const starts: PacerStart[] = [];
  return {
    starts,
    get cooldown() {
      return inner.cooldown;
    },
    run<T>(task: (signal: AbortSignal) => Promise<T>, options?: PacerRunOptions): Promise<T> {
      starts.push({ maxWaitMs: options?.maxWaitMs });
      return inner.run(task, options);
    },
    dispose: () => inner.dispose(),
    [Symbol.dispose]: () => inner.dispose(),
  };
}

/** A route answer: a static response or a factory. */
export type Responder = Response | ((request: Request) => Response | Promise<Response>);

/** One upstream route, matched on origin + path + query exactly. */
export interface Route {
  once?: boolean;
  path: string;
  respond: Responder;
}

/** A controllable clock shared by the cache, client, and service. */
export interface TestClock {
  now: () => number;
  t: number;
}

/** A clock fixed at 2026-09-26 12:00 UTC unless advanced by the test. */
export function testClock(iso = '2026-09-26T12:00:00Z'): TestClock {
  const clock: TestClock = { t: Date.parse(iso), now: () => clock.t };
  return clock;
}

/** The wired client, service, and fake behind them. */
export interface Upstream {
  cache: ResponseCache;
  client: LegislationClient;
  harness: FetchMockHarness;
  /** Origin-relative path + query of every request, in order. */
  paths(): string[];
  /** Captured requests, in order. */
  requests(): Request[];
  service: LegislationService;
  /** Requests no route matched. */
  unhandled: string[];
}

function relative(url: string): string {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

/** Wires a client and service over a strict fetch fake serving `routes`. */
export function createUpstream(
  routes: Route[],
  options: { cache?: ResponseCache; clock?: TestClock; pacer?: Pacer; register?: boolean } = {},
): Upstream {
  const unhandled: string[] = [];
  const harness = createFetchMock(
    routes.map((route) => ({
      match: (request: Request) => {
        const url = new URL(request.url);
        return url.origin === ORIGIN && `${url.pathname}${url.search}` === route.path;
      },
      respond: route.respond,
      ...(route.once ? { once: true } : {}),
    })),
    {
      onUnhandled: (request) => {
        unhandled.push(request.url);
        throw new Error(`Unrouted upstream request: ${request.url}`);
      },
    },
  );
  const now = options.clock?.now;
  const cache =
    options.cache ?? new ResponseCache({ maxBytes: 64 * 1024 * 1024, ...(now ? { now } : {}) });
  const client = new LegislationClient({
    fetch: harness.fetch,
    pacer: options.pacer ?? openPacer(),
    cache,
    userAgent: USER_AGENT,
    ...(now ? { now } : {}),
  });
  const service = new LegislationService({ client, ...(now ? { now } : {}) });
  if (options.register !== false) initLegislationService(service);
  return {
    harness,
    client,
    service,
    cache,
    unhandled,
    paths: () => harness.calls.map((call) => relative(call.request.url)),
    requests: () => harness.calls.map((call) => call.request),
  };
}

/** Shorthand for a route list from `[path, responder]` pairs. */
export function routes(...pairs: [string, Responder][]): Route[] {
  return pairs.map(([path, respond]) => ({ path, respond }));
}

/** Runs a call expected to throw and returns what it threw; fails when it returns instead. */
export async function thrown(run: () => unknown): Promise<McpError> {
  try {
    await run();
  } catch (error) {
    return error as McpError;
  }
  throw new Error('Expected the call to throw');
}

/**
 * A minted cursor with fields of its payload replaced, keeping its query
 * fingerprint; a field set to `undefined` is removed.
 */
export function forgeCursor(cursor: string, change: Record<string, unknown>): string {
  const payload = { ...JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')), ...change };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

/** A tool result as `runToolContract` returns it. */
export type ToolResult = Awaited<ReturnType<typeof runToolContract>>;

/** The concatenated text of a tool result's `content[]`. */
export function contentText(result: ToolResult): string {
  return result.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/** The structured error envelope of a failed tool result. */
export function errorOf(result: ToolResult): {
  code: number;
  data?: Record<string, unknown>;
  message: string;
} {
  const error = (result.structuredContent as { error?: unknown } | undefined)?.error;
  if (!result.isError || !error) throw new Error('Expected an error result');
  return error as { code: number; data?: Record<string, unknown>; message: string };
}
