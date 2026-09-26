/**
 * @fileoverview Schema-driven fuzzing of every uklaw_* tool against a fake
 * upstream that answers any request with a recorded empty feed or not-found
 * page: no crash past the framework, no stack or path leak, no prototype
 * pollution, whatever the input.
 * @module tests/fuzz/tools.fuzz.test
 */

import { fuzzTool } from '@cyanheads/mcp-ts-core/testing/fuzz';
import { beforeEach, describe, expect, it } from 'vitest';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import { createUpstream, feed, notFound, ORIGIN } from '../helpers/upstream.js';

beforeEach(() => {
  const up = createUpstream([]);
  up.harness.route({
    match: (request) => new URL(request.url).origin === ORIGIN,
    respond: (request) => {
      const { pathname } = new URL(request.url);
      if (pathname.startsWith('/changes/')) return feed('changes-empty.feed');
      if (pathname.startsWith('/update/'))
        return feed('update-2026-09-24-changes-primary-empty.feed');
      if (pathname.endsWith('/data.feed')) return feed('search-zero-hits.feed');
      return notFound();
    },
  });
});

describe('fuzz', () => {
  it.each(allToolDefinitions.map((t) => [t.name, t] as const))(
    '%s survives valid and adversarial input',
    async (_name, tool) => {
      const report = await fuzzTool(tool, { numRuns: 60, numAdversarial: 40, seed: 20260926 });
      expect(report.crashes).toEqual([]);
      expect(report.leaks).toEqual([]);
      expect(report.prototypePollution).toBe(false);
    },
  );
});
