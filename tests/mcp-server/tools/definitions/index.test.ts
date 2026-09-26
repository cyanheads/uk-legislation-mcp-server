/**
 * @fileoverview Tests for the registered tool surface: the six uklaw_* tools in
 * registration order, their annotations, auth scopes, that every declared
 * error reason carries a recovery, and the log severity of each reason.
 * @module tests/mcp-server/tools/definitions/index.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';

/**
 * Log level each declared reason is expected to carry: upstream refusals and
 * the pacer shed stay at the default `error`; a feed refusal that got past the
 * input edge is a `warning`; every other reason answers the caller's input.
 */
function expectedSeverity(reason: string): string | undefined {
  if (reason === 'upstream_refused' || reason === 'pacer_shed') return;
  return reason === 'filter_refused' ? 'warning' : 'notice';
}

describe('allToolDefinitions', () => {
  it.each(allToolDefinitions.map((t) => [t.name, t] as const))(
    '%s logs each declared reason at its severity',
    (_name, tool) => {
      const errors: readonly { reason: string; severity?: string }[] = tool.errors ?? [];
      expect(errors.map((e) => [e.reason, e.severity])).toEqual(
        errors.map((e) => [e.reason, expectedSeverity(e.reason)]),
      );
    },
  );

  it('registers the six tools in order', () => {
    expect(allToolDefinitions.map((t) => t.name)).toEqual([
      'uklaw_search_legislation',
      'uklaw_get_document',
      'uklaw_get_amendments',
      'uklaw_track_changes',
      'uklaw_lookup_citation',
      'uklaw_list_reference',
    ]);
  });

  it.each(allToolDefinitions.map((t) => [t.name, t] as const))(
    '%s is read-only with its own scope',
    (name, tool) => {
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true });
      expect(tool.annotations?.openWorldHint).toBe(name !== 'uklaw_list_reference');
      expect(tool.annotations).not.toHaveProperty('destructiveHint');
      expect(tool.auth).toEqual([`tool:${name}:read`]);
    },
  );

  it.each(
    allToolDefinitions
      .filter((t) => t.name !== 'uklaw_list_reference')
      .map((t) => [t.name, t] as const),
  )('%s declares upstream_refused and pacer_shed as service-thrown rate limits', (_name, tool) => {
    const errors = tool.errors ?? [];
    for (const reason of ['upstream_refused', 'pacer_shed']) {
      expect(errors.find((e) => e.reason === reason)).toMatchObject({
        code: JsonRpcErrorCode.RateLimited,
        thrownBy: 'service',
      });
    }
    for (const entry of errors)
      expect(entry.recovery.split(/\s+/).length).toBeGreaterThanOrEqual(5);
  });
});
