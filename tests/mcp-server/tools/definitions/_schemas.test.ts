/**
 * @fileoverview Tests for the shared `limit` count field and its clamp: the JSON
 * Schema `tools/list` advertises for the field in clamp and strict mode, the
 * values it accepts and rejects in each, and the clamp — the applied value, the
 * notice sentence, its one log line and one counter increment — with the
 * composition of that sentence into a branch's notice. `createCounter` is
 * wrapped so the increment can be read; nothing else is replaced.
 * @module tests/mcp-server/tools/definitions/_schemas.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { createMockContext, type MockContextLogger } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clampLimit,
  limitField,
  setStrictLimits,
  withClamp,
} from '@/mcp-server/tools/definitions/_schemas.js';

const metric = vi.hoisted(() => ({ add: vi.fn(), created: [] as unknown[][] }));

vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>();
  return {
    ...actual,
    createCounter: (...args: unknown[]) => {
      metric.created.push(args);
      return { add: metric.add };
    },
  };
});

const CAP = 1000;
const input = z.object({ limit: limitField(CAP, 20, 'Results per page') });

/** The `limit` property as `tools/list` carries it: the SDK's conversion, then JSON on the wire. */
const advertised = () =>
  JSON.parse(JSON.stringify(input['~standard'].jsonSchema.input({ target: 'draft-2020-12' })))
    .properties.limit;

/** The issues a `limit` value fails with, as `{ code, message }`; empty when it parses. */
function issuesOf(value: unknown) {
  const parsed = input.safeParse({ limit: value });
  return parsed.success ? [] : parsed.error.issues.map(({ code, message }) => ({ code, message }));
}

const TOO_SMALL = { code: 'too_small', message: 'Too small: expected number to be >=1' };
const NOT_INT = { code: 'invalid_type', message: 'Invalid input: expected int, received number' };
const TOO_BIG = { code: 'too_big', message: 'Too big: expected number to be <=1000' };

afterEach(() => {
  setStrictLimits(false);
  metric.add.mockClear();
});

describe('limitField', () => {
  it('advertises an integer with its default and minimum and no maximum in clamp mode', () => {
    expect(advertised()).toEqual({
      type: 'integer',
      minimum: 1,
      default: 20,
      description: 'Results per page; default 20, at most 1,000.',
    });
  });

  it('advertises maximum at the cap in strict mode, with the same description', () => {
    setStrictLimits(true);
    expect(advertised()).toEqual({
      type: 'integer',
      minimum: 1,
      maximum: CAP,
      default: 20,
      description: 'Results per page; default 20, at most 1,000.',
    });
  });

  it.each([1, 20, CAP, CAP + 1, 5000, 1e20])('accepts %d in clamp mode, unchanged', (value) => {
    expect(input.parse({ limit: value }).limit).toBe(value);
  });

  it('defaults to 20 when omitted', () => {
    expect(input.parse({}).limit).toBe(20);
  });

  it.each([
    [0, [TOO_SMALL]],
    [-1, [TOO_SMALL]],
    [1.5, [NOT_INT]],
    [-1.5, [TOO_SMALL, NOT_INT]],
  ])('rejects %d in clamp mode', (value, issues) => {
    expect(issuesOf(value)).toEqual(issues);
  });

  it.each([
    [1, []],
    [CAP, []],
    [CAP + 1, [TOO_BIG]],
    [1e20, [TOO_BIG]],
    [0, [TOO_SMALL]],
    [1.5, [NOT_INT]],
  ])('in strict mode, %d fails with %j', (value, issues) => {
    setStrictLimits(true);
    expect(issuesOf(value)).toEqual(issues);
  });
});

describe('clampLimit', () => {
  it('creates one counter for clamped calls', () => {
    expect(metric.created).toEqual([
      ['uklaw.limit.clamped', 'Tool calls whose limit was above the cap', '{calls}'],
    ]);
  });

  it.each([1, 20, CAP])('serves %d as asked, with no sentence, log line or count', (value) => {
    const ctx = createMockContext();
    expect(clampLimit('uklaw_search_legislation', value, CAP, ctx)).toEqual({ limit: value });
    expect((ctx.log as MockContextLogger).calls).toEqual([]);
    expect(metric.add).not.toHaveBeenCalled();
  });

  it.each([
    [CAP + 1, 'limit 1001 is above the cap; 1000 applied.'],
    [5000, 'limit 5000 is above the cap; 1000 applied.'],
    [1e20, 'limit 100000000000000000000 is above the cap; 1000 applied.'],
  ])('serves %d at the cap, with the sentence, one log line and one count', (value, sentence) => {
    const ctx = createMockContext();
    expect(clampLimit('uklaw_search_legislation', value, CAP, ctx)).toEqual({
      limit: CAP,
      clamp: sentence,
    });
    expect((ctx.log as MockContextLogger).calls).toEqual([
      {
        level: 'info',
        msg: 'limit above the cap',
        data: { requested: value, applied: CAP },
      },
    ]);
    expect(metric.add).toHaveBeenCalledExactlyOnceWith(1, {
      'mcp.tool.name': 'uklaw_search_legislation',
    });
  });

  it.each(['uklaw_get_amendments', 'uklaw_track_changes'])(
    'counts a clamped call under the tool name it is given: %s',
    (tool) => {
      clampLimit(tool, CAP + 1, CAP, createMockContext());
      expect(metric.add).toHaveBeenCalledExactlyOnceWith(1, { 'mcp.tool.name': tool });
    },
  );
});

describe('withClamp', () => {
  it('puts the clamp sentence in front of the branch notice', () => {
    expect(
      withClamp({ limit: CAP, clamp: 'limit 5000 is above the cap; 1000 applied.' }, 'X.'),
    ).toBe('limit 5000 is above the cap; 1000 applied. X.');
  });

  it('leaves the branch notice alone when nothing was clamped', () => {
    expect(withClamp({ limit: 20 }, 'X.')).toBe('X.');
  });
});
