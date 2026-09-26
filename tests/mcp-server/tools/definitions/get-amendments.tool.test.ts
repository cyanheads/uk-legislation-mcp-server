/**
 * @fileoverview Tests for uklaw_get_amendments over recorded changes feeds:
 * the path-segment filters (status, direction, counterpart, partial item),
 * cursor paging to the final page, the bounded provision scan (segment-boundary
 * matching, in-page offset cursors resumed from the cache, three-page stop,
 * degraded answers when a later page cannot start), every declared error
 * reason, blank inputs, and both result surfaces through the enrichment parse.
 * @module tests/mcp-server/tools/definitions/get-amendments.tool.test
 */

import type { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { getAmendmentsTool } from '@/mcp-server/tools/definitions/get-amendments.tool.js';
import { ATTRIBUTION_LINES } from '@/services/legislation/reference-data.js';
import {
  contentText,
  createUpstream,
  errorOf,
  feed,
  fixture,
  gatedPacer,
  ok,
  type Route,
  routes,
  status,
  thrown,
} from '../../../helpers/upstream.js';

type AmendmentsInput = z.input<typeof getAmendmentsTool.input>;

async function amendments(input: AmendmentsInput) {
  const ctx = createMockContext({ errors: getAmendmentsTool.errors });
  const output = await getAmendmentsTool.handler(getAmendmentsTool.input.parse(input), ctx);
  return { output, enrichment: getEnrichment(ctx) };
}

function failure(input: AmendmentsInput) {
  const ctx = createMockContext({ errors: getAmendmentsTool.errors });
  return thrown(() => getAmendmentsTool.handler(getAmendmentsTool.input.parse(input), ctx));
}

const AFFECTED = '/changes/affected/ukpga/2018/12/data.feed?results-count=3';
const SCAN = '/changes/unapplied/affected/ukpga/2018/12/data.feed?results-count=500';
const scanRoutes = (): Route[] =>
  routes(
    [SCAN, feed('changes-unapplied-scan-page-1.feed')],
    [`${SCAN}&page=2`, feed('changes-unapplied-scan-page-2.feed')],
    [`${SCAN}&page=3`, feed('changes-unapplied-scan-page-3.feed')],
    [`${SCAN}&page=4`, feed('changes-unapplied-scan-page-4.feed')],
  );
const PAGED = '/changes/unapplied/affected/ukpga/2018/12/data.feed?results-count=50';

describe('listing effects', () => {
  it('lists one page of effects with total, has_more and a cursor', async () => {
    const up = createUpstream(routes([AFFECTED, feed('changes-affected-ukpga-2018-12.feed')]));
    const { output, enrichment } = await amendments({ item: 'ukpga/2018/12', limit: 3 });
    expect(up.paths()).toEqual([AFFECTED]);
    expect(output).toMatchObject({
      query: { item: 'ukpga/2018/12', direction: 'affected', status: 'all' },
      total: 2271,
      has_more: true,
      next_cursor: expect.any(String),
      attribution: [ATTRIBUTION_LINES.ogl],
    });
    expect(output.effects).toHaveLength(3);
    expect(output.effects[0]).toMatchObject({
      type: 'word substituted',
      outstanding: true,
      extent: 'same as affected',
    });
    expect(output).not.toHaveProperty('scan');
    expect(enrichment).toMatchObject({ truncated: true, shown: 3, cap: 3 });
  });

  it('follows next_cursor page by page to the final page, which carries no cursor', async () => {
    const up = createUpstream(
      routes(
        [PAGED, feed('changes-unapplied-scan-page-1.feed')],
        [`${PAGED}&page=2`, feed('changes-unapplied-scan-page-2.feed')],
        [`${PAGED}&page=3`, feed('changes-unapplied-scan-page-3.feed')],
        [`${PAGED}&page=4`, feed('changes-unapplied-scan-page-4.feed')],
      ),
    );
    const base = { item: 'ukpga/2018/12', status: 'unapplied' as const };
    let cursor: string | undefined;
    const sizes: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const { output } = await amendments({ ...base, ...(cursor ? { cursor } : {}) });
      sizes.push(output.effects.length);
      cursor = output.next_cursor;
      expect(output.has_more).toBe(i < 3);
    }
    expect(sizes).toEqual([12, 6, 6, 4]);
    expect(cursor).toBeUndefined();
    expect(up.paths()).toEqual([PAGED, `${PAGED}&page=2`, `${PAGED}&page=3`, `${PAGED}&page=4`]);
  });

  it.each([
    [
      { status: 'unapplied' },
      '/changes/unapplied/affected/ukpga/2018/12/data.feed?results-count=3',
    ],
    [{ status: 'applied' }, '/changes/applied/affected/ukpga/2018/12/data.feed?results-count=3'],
    [
      { counterpart: 'https://www.legislation.gov.uk/id/ukpga/2025/18' },
      '/changes/affected/ukpga/2018/12/affecting/ukpga/2025/18/data.feed?results-count=3',
    ],
    [
      { counterpart: 'uksi/2026' },
      '/changes/affected/ukpga/2018/12/affecting/uksi/2026/data.feed?results-count=3',
    ],
    [{ item: 'ukpga/2018' }, '/changes/affected/ukpga/2018/data.feed?results-count=3'],
    [{ item: 'uksi', direction: 'affecting' }, '/changes/affecting/uksi/data.feed?results-count=3'],
    [
      { item: 'ukpga/2025/18', direction: 'affecting', counterpart: 'ukpga/2018/12' },
      '/changes/affecting/ukpga/2025/18/affected/ukpga/2018/12/data.feed?results-count=3',
    ],
  ] as [Partial<AmendmentsInput>, string][])('%j → %s', async (input, path) => {
    const up = createUpstream(
      routes([path, feed('changes-affected-ukpga-2018-12-affecting-ukpga-2025-18.feed')]),
    );
    const { output } = await amendments({ item: 'ukpga/2018/12', limit: 3, ...input });
    expect(up.paths()).toEqual([path]);
    expect(output.query).toMatchObject({
      ...(input.counterpart
        ? { counterpart: expect.stringMatching(/^[a-z]+\/\d{4}(\/\d+)?$/) }
        : {}),
    });
  });

  it('keeps a whole-item effect from a partial-item feed with an empty provision list', async () => {
    const path = '/changes/affecting/uksi/2026/data.feed?results-count=2';
    createUpstream(routes([path, feed('changes-affecting-uksi-2026.feed')]));
    const { output } = await amendments({ item: 'uksi/2026', direction: 'affecting', limit: 2 });
    expect(output.effects[0]?.affected.provisions).toEqual([]);
  });

  it('treats blank optional strings as unset', async () => {
    const up = createUpstream(
      routes([
        '/changes/affected/ukpga/2018/12/data.feed?results-count=50',
        feed('changes-affected-ukpga-2018-12.feed'),
      ]),
    );
    const { output } = await amendments({
      item: 'ukpga/2018/12',
      direction: '',
      counterpart: '',
      status: ' ',
      provision: '',
      cursor: '',
    } as AmendmentsInput);
    expect(up.paths()).toEqual(['/changes/affected/ukpga/2018/12/data.feed?results-count=50']);
    expect(output.query).toEqual({ item: 'ukpga/2018/12', direction: 'affected', status: 'all' });
  });

  it('throws when a changes feed lacks its total', async () => {
    const body = fixture('feeds/changes-affected-ukpga-2018-12.feed').replace(
      /<openSearch:totalResults>\d+<\/openSearch:totalResults>/,
      '',
    );
    createUpstream([{ path: AFFECTED, respond: ok(body) }]);
    await expect(failure({ item: 'ukpga/2018/12', limit: 3 })).resolves.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
    });
  });
});

describe('provision scan', () => {
  it('keeps effects touching the provision at a segment boundary and stops after three pages', async () => {
    const up = createUpstream(scanRoutes());
    const { output, enrichment } = await amendments({
      item: 'ukpga/2018/12',
      provision: 's. 45',
      status: 'unapplied',
    });
    expect(up.paths()).toEqual([SCAN, `${SCAN}&page=2`, `${SCAN}&page=3`]);
    const labels = output.effects.map((e) => e.affected.provisions_label);
    expect(labels.slice(0, 3)).toEqual(['s. 45(2)(f)', 's. 45(5)(c)(d)', 's. 45(7)(b)']);
    expect(labels).not.toContain('s. 45A(2)(c)(d)');
    expect(labels).not.toContain('s. 45A(4)(b)');
    expect(output.scan).toEqual({ effects_scanned: 24, pages_scanned: 3, total_effects: 309 });
    expect(output).toMatchObject({
      has_more: true,
      total: 309,
      query: { provision: 'section/45' },
    });
    expect(enrichment.notice).toMatch(/Scanned 24 of 309 effects this call/);
    expect(enrichment).not.toHaveProperty('truncated');
  });

  it('attributes a recorded section-range effect only to its range', async () => {
    createUpstream(scanRoutes());
    const { output } = await amendments({
      item: 'ukpga/2018/12',
      provision: 'section/45',
      status: 'unapplied',
    });
    expect(output.effects.map((e) => e.affected.provisions_label)).toEqual([
      's. 45(2)(f)',
      's. 45(5)(c)(d)',
      's. 45(7)(b)',
    ]);
  });

  it('keeps a range effect for a provision inside the range, on both surfaces', async () => {
    createUpstream(scanRoutes());
    const result = await runToolContract(getAmendmentsTool, {
      item: 'ukpga/2018/12',
      provision: 'section/65/3',
      status: 'unapplied',
    });
    const structured = result.structuredContent as {
      effects: { affected: { provisions: unknown[]; provisions_label?: string } }[];
    };
    expect(structured.effects.map((e) => e.affected.provisions_label)).toEqual(['s. 65(2)-(4)']);
    expect(structured.effects[0]?.affected.provisions).toEqual([
      {
        label: 's. 65(2)-(4)',
        uri: 'https://www.legislation.gov.uk/id/ukpga/2018/12/section/65/2',
        up_to: 'https://www.legislation.gov.uk/id/ukpga/2018/12/section/65/4',
      },
    ]);
    expect(contentText(result)).toContain(
      'provisions: s. 65(2)-(4) (https://www.legislation.gov.uk/id/ukpga/2018/12/section/65/2 to https://www.legislation.gov.uk/id/ukpga/2018/12/section/65/4)',
    );
  });

  it('keeps an effect on an ancestor of the provision', async () => {
    createUpstream(scanRoutes());
    const { output } = await amendments({
      item: 'ukpga/2018/12',
      provision: 's. 51(2)',
      status: 'unapplied',
    });
    expect(output.effects.map((e) => e.affected.provisions_label)).toEqual(['s. 51']);
  });

  it('continues the scan from the cursor and reaches the end of the feed', async () => {
    const up = createUpstream(scanRoutes());
    const first = await amendments({
      item: 'ukpga/2018/12',
      provision: 'section/45',
      status: 'unapplied',
    });
    const { output, enrichment } = await amendments({
      item: 'ukpga/2018/12',
      provision: 'section/45',
      status: 'unapplied',
      cursor: first.output.next_cursor as string,
    });
    expect(up.paths().at(-1)).toBe(`${SCAN}&page=4`);
    expect(output).toMatchObject({
      effects: [],
      has_more: false,
      scan: { effects_scanned: 4, pages_scanned: 1 },
    });
    expect(output.next_cursor).toBeUndefined();
    expect(enrichment.notice).toContain('No effect references this provision by URI');
    expect(enrichment.notice).toContain('Retry with status "all".');
    expect(enrichment.notice).not.toContain('does not exist');
  });

  it('routes a full-scan zero hit to the enclosing Part or cross-heading, on both surfaces', async () => {
    createUpstream(scanRoutes());
    const base = { item: 'ukpga/2018/12', provision: 'section/45', status: 'unapplied' as const };
    const first = await amendments(base);
    const result = await runToolContract(getAmendmentsTool, {
      ...base,
      cursor: first.output.next_cursor as string,
    });
    const structured = result.structuredContent as { effects: unknown[]; notice: string };
    expect(structured.effects).toEqual([]);
    for (const surface of [structured.notice, contentText(result)]) {
      expect(surface).toContain('No effect references this provision by URI.');
      expect(surface).toContain(
        "names part/3/chapter/4/crossheading/general-obligations): read the enclosing Part with uklaw_get_document (its item-level outline lists the Parts), or pass the Part's path as provision to uklaw_get_amendments.",
      );
      expect(surface).toContain(
        "The provision's applied history is in its annotations in uklaw_get_document.",
      );
    }
  });

  it('carries an in-page offset when limit fills part-way through a page, resuming from the cache', async () => {
    const up = createUpstream(scanRoutes());
    const base = { item: 'ukpga/2018/12', provision: 'section/45', status: 'unapplied' as const };
    const first = await amendments({ ...base, limit: 2 });
    expect(first.output.effects.map((e) => e.affected.provisions_label)).toEqual([
      's. 45(2)(f)',
      's. 45(5)(c)(d)',
    ]);
    expect(first.output).toMatchObject({
      has_more: true,
      scan: { effects_scanned: 8, pages_scanned: 1 },
    });
    expect(first.enrichment).toMatchObject({ truncated: true, shown: 2, cap: 2 });
    const cursor = JSON.parse(
      Buffer.from(first.output.next_cursor as string, 'base64url').toString(),
    );
    expect(cursor).toMatchObject({ p: 1, o: 8 });

    const second = await amendments({
      ...base,
      limit: 2,
      cursor: first.output.next_cursor as string,
    });
    // Resumed at entry 8 of page 1 (from the cache): the two effects already returned are not repeated.
    expect(second.output.effects[0]?.affected.provisions_label).toBe('s. 45(7)(b)');
    expect(up.paths()).toEqual([SCAN, `${SCAN}&page=2`, `${SCAN}&page=3`]);
  });

  it('moves the cursor to the next page when limit fills on a page’s last entry', async () => {
    createUpstream(scanRoutes());
    const { output } = await amendments({
      item: 'ukpga/2018/12',
      provision: 'section/62',
      status: 'unapplied',
      limit: 1,
    });
    expect(output.effects.map((e) => e.affected.provisions_label)).toEqual(['s. 62(5)']);
    const cursor = JSON.parse(Buffer.from(output.next_cursor as string, 'base64url').toString());
    expect(cursor).toEqual({ k: expect.any(String), p: 3 });
  });

  it('never matches a sibling section sharing a prefix', async () => {
    createUpstream(scanRoutes());
    const { output } = await amendments({
      item: 'ukpga/2018/12',
      provision: 'section/45A',
      status: 'unapplied',
    });
    const labels = output.effects.map((e) => e.affected.provisions_label);
    expect(labels).toContain('s. 45A(2)(c)(d)');
    expect(labels).toContain('s. 45A(4)(b)');
    expect(labels.filter((l) => /^s\. 45\(/.test(l ?? ''))).toEqual([]);
  });

  it('a final page that holds exactly the remaining matches carries no truncation', async () => {
    createUpstream(scanRoutes());
    const base = {
      item: 'ukpga/2018/12',
      provision: 'section/71',
      status: 'unapplied' as const,
      limit: 5,
    };
    const first = await amendments(base);
    const { output, enrichment } = await amendments({
      ...base,
      cursor: first.output.next_cursor as string,
    });
    expect(output.effects.map((e) => e.affected.provisions_label)).toEqual(['s. 71(1)(c)(d)']);
    expect(output.has_more).toBe(false);
    expect(enrichment).not.toHaveProperty('truncated');
  });

  it('a scan that fills limit on the feed’s very last entry is not reported as truncated', async () => {
    createUpstream(scanRoutes());
    const base = {
      item: 'ukpga/2018/12',
      provision: 'section/71A',
      status: 'unapplied' as const,
      limit: 1,
    };
    const first = await amendments(base);
    const result = await runToolContract(getAmendmentsTool, {
      ...base,
      cursor: first.output.next_cursor as string,
    });
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.has_more).toBe(false);
    expect(structured).not.toHaveProperty('truncated');
    expect(structured).not.toHaveProperty('next_cursor');
    const text = contentText(result);
    expect(text).toContain('has_more: false');
    expect(text).not.toContain('More effects remain');
  });

  it('returns what it scanned, with a cursor, when a later page cannot start', async () => {
    const up = createUpstream(scanRoutes(), { pacer: await gatedPacer(1) });
    const { output, enrichment } = await amendments({
      item: 'ukpga/2018/12',
      provision: 'section/45',
      status: 'unapplied',
    });
    expect(up.paths()).toEqual([SCAN]);
    expect(output).toMatchObject({
      has_more: true,
      scan: { effects_scanned: 12, pages_scanned: 1 },
    });
    expect(output.effects).toHaveLength(3);
    const cursor = JSON.parse(Buffer.from(output.next_cursor as string, 'base64url').toString());
    expect(cursor).toMatchObject({ p: 2 });
    expect(enrichment.notice).toMatch(/Scanned 12 of 309 effects this call/);
  });

  it('with nothing found yet, still answers with a cursor rather than pacer_shed', async () => {
    createUpstream(scanRoutes(), { pacer: await gatedPacer(1) });
    const { output, enrichment } = await amendments({
      item: 'ukpga/2018/12',
      provision: 'section/71',
      status: 'unapplied',
    });
    expect(output).toMatchObject({ effects: [], has_more: true });
    expect(output.next_cursor).toEqual(expect.any(String));
    expect(enrichment.notice).toContain('Only the first 12 of 309 effects were scanned');
  });

  it('takes the provision from an item URI', async () => {
    const up = createUpstream(scanRoutes());
    const { output } = await amendments({
      item: 'https://www.legislation.gov.uk/ukpga/2018/12/section/45',
      status: 'unapplied',
    });
    expect(output.query.provision).toBe('section/45');
    expect(up.paths()[0]).toBe(SCAN);
  });
});

describe('errors', () => {
  it.each([
    [{ item: 'xyz/2018/12' }, 'invalid_item'],
    [{ item: 'ukpga/2018/12/foo' }, 'invalid_item'],
    [{ item: 'ukpga/2018/12', counterpart: 'foo/bar' }, 'invalid_item'],
    [{ item: 'ukpga/2018/12', provision: 'foo 3' }, 'invalid_provision'],
    [{ item: 'ukpga/2018', provision: 's. 45' }, 'provision_needs_full_item'],
    [{ item: 'ukpga/2018/12', cursor: 'bm90LWpzb24' }, 'invalid_cursor'],
  ] as [AmendmentsInput, string][])('%j fails %s before any request', async (input, reason) => {
    const up = createUpstream([]);
    await expect(failure(input)).resolves.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason },
    });
    expect(up.paths()).toEqual([]);
  });

  it('a changes-feed 404 fails filter_refused with its recovery, not an empty list', async () => {
    createUpstream(routes([AFFECTED, status(404)]));
    await expect(failure({ item: 'ukpga/2018/12', limit: 3 })).resolves.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'filter_refused',
        status: 404,
        recovery: {
          hint: getAmendmentsTool.errors?.find((e) => e.reason === 'filter_refused')?.recovery,
        },
      },
    });
  });

  it('rejects a cursor minted for a different query (status, limit or provision changed)', async () => {
    createUpstream(routes([AFFECTED, feed('changes-affected-ukpga-2018-12.feed')]));
    const { output } = await amendments({ item: 'ukpga/2018/12', limit: 3 });
    const cursor = output.next_cursor as string;
    for (const changed of [
      { item: 'ukpga/2018/12', limit: 3, status: 'unapplied' },
      { item: 'ukpga/2018/12', limit: 4 },
      { item: 'ukpga/2018/12', limit: 3, provision: 'section/45' },
      { item: 'ukpga/2018/12', limit: 3, direction: 'affecting' },
    ] as AmendmentsInput[]) {
      await expect(failure({ ...changed, cursor })).resolves.toMatchObject({
        data: { reason: 'invalid_cursor' },
      });
    }
  });

  it('maps a 403 to upstream_refused', async () => {
    createUpstream(routes([AFFECTED, status(403)]));
    await expect(failure({ item: 'ukpga/2018/12', limit: 3 })).resolves.toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'upstream_refused' },
    });
  });

  it.each([
    [{ item: 'ukpga/2018/12', limit: 3 }],
    [{ item: 'ukpga/2018/12', provision: 'section/45', status: 'unapplied' }],
  ] as [AmendmentsInput][])(
    'fails pacer_shed when the first request of %j cannot start',
    async (input) => {
      createUpstream(
        [...routes([AFFECTED, feed('changes-affected-ukpga-2018-12.feed')]), ...scanRoutes()],
        {
          pacer: await gatedPacer(0),
        },
      );
      await expect(failure(input)).resolves.toMatchObject({
        code: JsonRpcErrorCode.RateLimited,
        data: { reason: 'pacer_shed' },
      });
    },
  );

  it.each([
    { item: 'Data Protection Act 2018' },
    { item: '' },
    { item: 'ukpga/2018/12', counterpart: 'Data Protection Act' },
    { item: 'ukpga/2018/12', provision: '§ 45' },
    { item: 'ukpga/2018/12', provision: 's. 45, 46' },
    { item: 'ukpga/2018/12', cursor: 'abc+def=' },
    { item: 'ukpga/2018/12', direction: 'both' },
    { item: 'ukpga/2018/12', status: 'pending' },
    { item: 'ukpga/2018/12', limit: 0 },
    { item: 'ukpga/2018/12', limit: 101 },
  ])('rejects %j at the schema', async (input) => {
    createUpstream([]);
    const error = errorOf(await runToolContract(getAmendmentsTool, input as AmendmentsInput));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.reason).toBe('invalid_arguments');
  });
});

describe('both surfaces and enrichment', () => {
  it('the zero-result page (total 0) carries the notice and passes the enrichment parse', async () => {
    const path = '/changes/unapplied/affected/uksi/1980/2049/data.feed?results-count=50';
    createUpstream(routes([path, feed('changes-empty.feed')]));
    const result = await runToolContract(getAmendmentsTool, {
      item: 'uksi/1980/2049',
      status: 'unapplied',
    });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured).toMatchObject({ effects: [], total: 0, has_more: false });
    expect(structured).not.toHaveProperty('truncated');
    expect(structured).not.toHaveProperty('next_cursor');
    const notice = structured.notice as string;
    expect(notice).toContain('No effects matched.');
    expect(notice).toContain('confirm the item with uklaw_lookup_citation');
    expect(notice).toContain('from amending legislation of 1994 onwards');
    expect(notice).toContain('Retry with status "all".');
    const text = contentText(result);
    expect(text).toContain('## Effects on `uksi/1980/2049`');
    expect(text).toContain('**Total:** 0 · shown 0 · has_more: false');
    expect(text).toContain('No effects matched.');
  });

  it('an under-cap final page carries no truncation fields', async () => {
    createUpstream(
      routes(
        [PAGED, feed('changes-unapplied-scan-page-1.feed')],
        [`${PAGED}&page=2`, feed('changes-unapplied-scan-page-2.feed')],
        [`${PAGED}&page=3`, feed('changes-unapplied-scan-page-3.feed')],
        [`${PAGED}&page=4`, feed('changes-unapplied-scan-page-4.feed')],
      ),
    );
    const base = { item: 'ukpga/2018/12', status: 'unapplied' } as AmendmentsInput;
    let cursor = (await amendments(base)).output.next_cursor as string;
    cursor = (await amendments({ ...base, cursor })).output.next_cursor as string;
    cursor = (await amendments({ ...base, cursor })).output.next_cursor as string;
    const result = await runToolContract(getAmendmentsTool, { ...base, cursor });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured).toMatchObject({ total: 309, has_more: false });
    expect((structured.effects as unknown[]).length).toBe(4);
    for (const key of ['truncated', 'shown', 'cap', 'notice', 'next_cursor']) {
      expect(structured).not.toHaveProperty(key);
    }
  });

  it('a capped page renders every effect field and the cursor on the text surface', async () => {
    createUpstream(routes([AFFECTED, feed('changes-affected-ukpga-2018-12.feed')]));
    const result = await runToolContract(getAmendmentsTool, { item: 'ukpga/2018/12', limit: 3 });
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured).toMatchObject({
      truncated: true,
      shown: 3,
      cap: 3,
      notice: 'More effects remain: call again with cursor set to next_cursor.',
    });
    const text = contentText(result);
    expect(text).toContain('**Query:** direction affected · status all');
    expect(text).toContain(`next_cursor: \`${structured.next_cursor as string}\``);
    expect(text).toContain(
      '- **word substituted** — **outstanding** · applied: false · requires_applied: true',
    );
    expect(text).toContain(
      '  - Affected: Data Protection Act 2018 `ukpga/2018/12` <https://www.legislation.gov.uk/id/ukpga/2018/12> — s. 65 heading',
    );
    expect(text).toContain('  - In force: 2026-09-30, wholly in force, applied: false');
    expect(text).toContain(
      '  - Commencement authority: reg. 1(2) (https://www.legislation.gov.uk/id/uksi/2026/386/regulation/1/2)',
    );
    expect(text).toContain('  - Extent: same as affected');
    expect(text).toContain(ATTRIBUTION_LINES.ogl);
  });

  it('renders the scan coverage line', async () => {
    createUpstream(scanRoutes());
    const text = contentText(
      await runToolContract(getAmendmentsTool, {
        item: 'ukpga/2018/12',
        provision: 'section/45',
        status: 'unapplied',
      }),
    );
    expect(text).toContain('provision `section/45`');
    expect(text).toContain('**Scan:** 24 effects scanned over 3 page(s) of 309 total');
  });

  it('returns a declared reason in the error envelope', async () => {
    createUpstream([]);
    const result = await runToolContract(getAmendmentsTool, {
      item: 'ukpga/2018',
      provision: 's. 45',
    });
    expect(errorOf(result).data?.reason).toBe('provision_needs_full_item');
  });
});
