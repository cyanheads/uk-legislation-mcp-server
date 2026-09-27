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
  forgeCursor,
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
const PAGED = '/changes/unapplied/affected/ukpga/2018/12/data.feed?results-count=20';

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

  it('asks for 20 effects per page when limit is omitted, and caps at 20, on both surfaces', async () => {
    expect(getAmendmentsTool.input.parse({ item: 'ukpga/2018/12' }).limit).toBe(20);
    const path = '/changes/affected/ukpga/2018/12/data.feed?results-count=20';
    const up = createUpstream(routes([path, feed('changes-affected-ukpga-2018-12.feed')]));
    const result = await runToolContract(getAmendmentsTool, { item: 'ukpga/2018/12' });
    expect(up.paths()).toEqual([path]);
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured).toMatchObject({ has_more: true, truncated: true, cap: 20 });
    const text = contentText(result);
    expect(text).toContain('**cap:** 20');
    expect(text).toContain(`next_cursor: \`${structured.next_cursor as string}\``);
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
    // With a counterpart the feed is addressed affected side first, whatever the direction.
    [
      { item: 'ukpga/2025/18', direction: 'affecting', counterpart: 'ukpga/2018/12' },
      '/changes/affected/ukpga/2018/12/affecting/ukpga/2025/18/data.feed?results-count=3',
    ],
    [
      { item: 'ukpga/2025/18', direction: 'affecting', counterpart: 'ukpga/2018' },
      '/changes/affected/ukpga/2018/affecting/ukpga/2025/18/data.feed?results-count=3',
    ],
    [
      {
        item: 'ukpga/2025/18',
        direction: 'affecting',
        counterpart: 'ukpga/2018/12',
        status: 'unapplied',
      },
      '/changes/unapplied/affected/ukpga/2018/12/affecting/ukpga/2025/18/data.feed?results-count=3',
    ],
    [
      { item: 'ukpga/2025', direction: 'affecting', counterpart: 'uksi/2026' },
      '/changes/affected/uksi/2026/affecting/ukpga/2025/data.feed?results-count=3',
    ],
  ] as [Partial<AmendmentsInput>, string][])('%j → %s', async (input, path) => {
    const up = createUpstream(
      routes([path, feed('changes-affected-ukpga-2018-12-affecting-ukpga-2025-18.feed')]),
    );
    const { output } = await amendments({ item: 'ukpga/2018/12', limit: 3, ...input });
    expect(up.paths()).toEqual([path]);
    expect(up.unhandled).toEqual([]);
    expect(output.query).toMatchObject({
      ...(input.counterpart
        ? { counterpart: expect.stringMatching(/^[a-z]+\/\d{4}(\/\d+)?$/) }
        : {}),
    });
  });

  it('direction affecting with a counterpart reads the affected-first feed, pages on it, and echoes the query as given, on both surfaces', async () => {
    const path =
      '/changes/affected/ukpga/2018/12/affecting/ukpga/2025/18/data.feed?results-count=3';
    const up = createUpstream(
      routes(
        [path, feed('changes-affected-ukpga-2018-12-affecting-ukpga-2025-18.feed')],
        [`${path}&page=2`, feed('changes-affected-ukpga-2018-12-affecting-ukpga-2025-18.feed')],
      ),
    );
    const input = {
      item: 'ukpga/2025/18',
      direction: 'affecting',
      counterpart: 'ukpga/2018/12',
      limit: 3,
    } as const;
    const first = await runToolContract(getAmendmentsTool, input);
    expect(first.isError).toBeFalsy();
    const structured = first.structuredContent as z.output<typeof getAmendmentsTool.output>;
    expect(structured).toMatchObject({
      query: {
        item: 'ukpga/2025/18',
        direction: 'affecting',
        counterpart: 'ukpga/2018/12',
        status: 'all',
      },
      total: 414,
      has_more: true,
    });
    expect(structured.effects).toHaveLength(3);
    for (const effect of structured.effects) {
      expect(effect.affecting.item).toBe('ukpga/2025/18');
      expect(effect.affected.item).toBe('ukpga/2018/12');
    }
    const text = contentText(first);
    expect(text).toContain('## Effects made by `ukpga/2025/18`');
    expect(text).toContain(
      '**Query:** direction affecting · status all · counterpart `ukpga/2018/12`',
    );
    expect(text).toContain('**Total:** 414 · shown 3 · has_more: true');

    const second = await runToolContract(getAmendmentsTool, {
      ...input,
      cursor: structured.next_cursor as string,
    });
    expect(second.isError).toBeFalsy();
    expect(up.paths()).toEqual([path, `${path}&page=2`]);
    expect(up.unhandled).toEqual([]);
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
        '/changes/affected/ukpga/2018/12/data.feed?results-count=20',
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
    expect(up.paths()).toEqual(['/changes/affected/ukpga/2018/12/data.feed?results-count=20']);
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

  it('continues the scan from the cursor and reaches the end of the feed without denying earlier matches, on both surfaces', async () => {
    const up = createUpstream(scanRoutes());
    const base = { item: 'ukpga/2018/12', provision: 'section/45', status: 'unapplied' as const };
    const first = await amendments(base);
    expect(first.output.effects).toHaveLength(3);
    const result = await runToolContract(getAmendmentsTool, {
      ...base,
      cursor: first.output.next_cursor as string,
    });
    expect(up.paths().at(-1)).toBe(`${SCAN}&page=4`);
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured).toMatchObject({
      effects: [],
      has_more: false,
      scan: { effects_scanned: 4, pages_scanned: 1 },
    });
    expect(structured).not.toHaveProperty('next_cursor');
    const complete =
      'No further matches: this call scanned the last 4 of 309 effects, so the scan is complete. If earlier pages returned no match either, no effect references this provision by URI.';
    for (const surface of [structured.notice as string, contentText(result)]) {
      expect(surface).toContain(complete);
      expect(surface).toContain(
        "names part/3/chapter/4/crossheading/general-obligations): read the enclosing Part with uklaw_get_document (its item-level outline lists the Parts), or pass the Part's path as provision to uklaw_get_amendments.",
      );
      expect(surface).not.toContain('No effects matched.');
      expect(surface).not.toContain('No effect references this provision by URI.');
      expect(surface).not.toContain('Retry with status');
      expect(surface).not.toContain('1994');
    }
  });

  it('says a continuation that stops early found no further matches, never "Only the first N", through to the end', async () => {
    createUpstream(scanRoutes());
    const base = {
      item: 'ukpga/2018/12',
      provision: 'section/26',
      status: 'unapplied' as const,
      limit: 1,
    };
    const first = await amendments(base);
    expect(first.output.effects.map((e) => e.affected.provisions_label)).toEqual([
      's. 26(2)(h)(i)',
    ]);

    const second = await runToolContract(getAmendmentsTool, {
      ...base,
      cursor: first.output.next_cursor as string,
    });
    const secondStructured = second.structuredContent as Record<string, unknown>;
    expect(secondStructured).toMatchObject({
      effects: [],
      has_more: true,
      scan: { effects_scanned: 23, pages_scanned: 3 },
    });
    const further =
      'No further matches in the 23 effects scanned this call; call again with cursor set to next_cursor to scan further.';
    expect(secondStructured.notice).toBe(further);
    expect(contentText(second)).toContain(further);
    expect(contentText(second)).not.toContain('Only the first');

    const third = await runToolContract(getAmendmentsTool, {
      ...base,
      cursor: secondStructured.next_cursor as string,
    });
    const thirdStructured = third.structuredContent as Record<string, unknown>;
    expect(thirdStructured).toMatchObject({
      effects: [],
      has_more: false,
      scan: { effects_scanned: 4, pages_scanned: 1 },
    });
    for (const surface of [thirdStructured.notice as string, contentText(third)]) {
      expect(surface).toContain(
        'No further matches: this call scanned the last 4 of 309 effects, so the scan is complete.',
      );
      expect(surface).not.toContain('Only the first');
      expect(surface).not.toContain('No effects matched.');
    }
  });

  it('routes a first-call full-scan zero hit to the enclosing Part or cross-heading, on both surfaces', async () => {
    createUpstream(routes([SCAN, feed('changes-unapplied-scan-page-4.feed')]));
    const result = await runToolContract(getAmendmentsTool, {
      item: 'ukpga/2018/12',
      provision: 'section/45',
      status: 'unapplied',
    });
    const structured = result.structuredContent as {
      effects: unknown[];
      has_more: boolean;
      notice: string;
    };
    expect(structured.effects).toEqual([]);
    expect(structured.has_more).toBe(false);
    for (const surface of [structured.notice, contentText(result)]) {
      expect(surface).toContain('No effects matched.');
      expect(surface).toContain('Retry with status "all".');
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
    expect(up.unhandled).toEqual([]);
  });

  it.each([
    ['affected', 'ukpga/2025/18/section/103', 'section/103', 'affecting'],
    [
      'affected',
      'https://www.legislation.gov.uk/id/ukpga/2025/18/section/103',
      'section/103',
      'affecting',
    ],
    ['affecting', 'uksi/2019/419/regulation/5/2', 'regulation/5/2', 'affected'],
  ] as const)(
    'direction %s: counterpart %s carrying a provision fails invalid_item, not a whole-Act query, on both surfaces',
    async (direction, counterpart, provision, side) => {
      const up = createUpstream([]);
      const result = await runToolContract(getAmendmentsTool, {
        item: 'ukpga/2018/12',
        direction,
        counterpart,
        limit: 2,
      });
      expect(up.paths()).toEqual([]);
      expect(up.unhandled).toEqual([]);
      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data?.reason).toBe('invalid_item');
      const item = counterpart.includes('uksi') ? 'uksi/2019/419' : 'ukpga/2025/18';
      const message = `counterpart "${counterpart}" names a provision (${provision}); counterpart takes an item path, and legislation.gov.uk cannot filter effects by the counterpart's provision.`;
      const hint = `Pass counterpart "${item}" and read the counterpart's provisions in each effect's ${side}.provisions; provision filters on item's side only.`;
      expect(error.message).toBe(message);
      expect(error.data?.recovery).toEqual({ hint });
      const text = contentText(result);
      expect(text).toContain(message);
      expect(text).toContain(hint);
    },
  );

  const LPA = 'ukpga/Geo5/15-16/20';
  const BY_CALENDAR_YEAR =
    "legislation.gov.uk's changes feeds index effects by calendar year and chapter number, so they cannot be queried by this path.";
  const PRE_1994 =
    'Effects are normally recorded only from amending legislation of 1994 onwards (uklaw_list_reference topic coverage), so the changes feeds hold few or none made by a pre-1963 Act.';
  const LPA_MESSAGE = `item "${LPA}" addresses a pre-1963 Act by regnal year; ${BY_CALENDAR_YEAR}`;
  const LPA_CALENDAR = `Call uklaw_get_amendments with item ukpga/YYYY/20, where YYYY is the calendar year uklaw_get_document reports as item.year for ${LPA}, and keep the effects whose affected.item is ${LPA}: two sessions sitting in one calendar year can share a chapter number.`;
  const VICT_MESSAGE = `counterpart "ukpga/Vict/24-25/100" addresses a pre-1963 Act by regnal year; ${BY_CALENDAR_YEAR}`;
  const ELIZ_MESSAGE = `counterpart "ukpga/Eliz2/3-4" addresses the Acts of a pre-1963 session by regnal year; ${BY_CALENDAR_YEAR}`;

  it.each([
    ['item, direction affected', { item: LPA, limit: 2 }, LPA_MESSAGE, LPA_CALENDAR],
    [
      'item as its URI',
      { item: `https://www.legislation.gov.uk/id/${LPA}` },
      LPA_MESSAGE,
      LPA_CALENDAR,
    ],
    [
      'item with provision',
      { item: LPA, provision: 'section/1' },
      LPA_MESSAGE,
      `${LPA_CALENDAR} Leave provision out: effects give section/1 as a URI under the regnal path, which the provision filter cannot match on the calendar path; look for it in each effect's affected.provisions.`,
    ],
    [
      'item, direction affecting',
      { item: LPA, direction: 'affecting' },
      LPA_MESSAGE,
      `${PRE_1994} To see what ${LPA} changed, call uklaw_get_amendments on the amended item (direction affected) and keep the effects whose affecting.item is ${LPA}, or read that item's annotations with uklaw_get_document.`,
    ],
    [
      'partial item',
      { item: 'aep/Ann/6' },
      `item "aep/Ann/6" addresses the Acts of a pre-1963 session by regnal year; ${BY_CALENDAR_YEAR}`,
      'Call uklaw_get_amendments with item aep/YYYY for each calendar year the session aep/Ann/6 sat in (uklaw_get_document reports item.year for any Act of it), and keep the effects whose affected.item starts with aep/Ann/6/.',
    ],
    [
      'counterpart, direction affected',
      { item: 'ukpga/2018/12', counterpart: 'ukpga/Vict/24-25/100' },
      VICT_MESSAGE,
      `${PRE_1994} Call again without counterpart and keep the effects whose affecting.item is ukpga/Vict/24-25/100.`,
    ],
    [
      'counterpart, direction affecting',
      { item: 'ukpga/2018/12', direction: 'affecting', counterpart: 'ukpga/Vict/24-25/100' },
      VICT_MESSAGE,
      'Call again without counterpart and keep the effects whose affected.item is ukpga/Vict/24-25/100.',
    ],
    [
      'partial counterpart, direction affected',
      { item: 'ukpga/2018/12', counterpart: 'ukpga/Eliz2/3-4' },
      ELIZ_MESSAGE,
      `${PRE_1994} Call again without counterpart and keep the effects whose affecting.item starts with ukpga/Eliz2/3-4/.`,
    ],
    [
      'partial counterpart, direction affecting',
      { item: 'ukpga/2018/12', direction: 'affecting', counterpart: 'ukpga/Eliz2/3-4' },
      ELIZ_MESSAGE,
      'Call again without counterpart and keep the effects whose affected.item starts with ukpga/Eliz2/3-4/.',
    ],
  ] as [string, AmendmentsInput, string, string][])(
    '%s: a regnal path fails regnal_item before any request, on both surfaces',
    async (_case, input, message, hint) => {
      const up = createUpstream([]);
      const result = await runToolContract(getAmendmentsTool, input);
      expect(up.unhandled).toEqual([]);
      expect(up.paths()).toEqual([]);
      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data?.reason).toBe('regnal_item');
      expect(error.message).toBe(message);
      expect(error.data?.recovery).toEqual({ hint });
      const text = contentText(result);
      expect(text).toContain(message);
      expect(text).toContain(hint);
    },
  );

  it('the calendar-year path a regnal_item recovery names lists the regnal Act’s effects', async () => {
    const path = '/changes/affected/ukpga/1925/20/data.feed?results-count=2';
    const up = createUpstream(routes([path, feed('changes-affected-ukpga-1925-20.feed')]));
    const { output } = await amendments({ item: 'ukpga/1925/20', limit: 2 });
    expect(up.paths()).toEqual([path]);
    expect(output.total).toBe(277);
    expect(output.effects.map((e) => e.affected.item)).toEqual([LPA, LPA]);
  });

  const DRAFT_ITEM_HINT =
    "Once made, an instrument is published under its own path with a calendar year and number: find it by title with uklaw_search_legislation (types secondary) and pass that path as item. uklaw_get_document reads a draft's own text.";

  it.each([
    [{ item: 'ukdsi/2026/9780348287233' }, 'item "ukdsi/2026/9780348287233"', DRAFT_ITEM_HINT],
    [
      { item: 'ukdsi/2026/9780348287233', direction: 'affecting' },
      'item "ukdsi/2026/9780348287233"',
      DRAFT_ITEM_HINT,
    ],
    [{ item: 'sdsi/2026' }, 'item "sdsi/2026"', DRAFT_ITEM_HINT],
    [{ item: 'nidsr' }, 'item "nidsr"', DRAFT_ITEM_HINT],
    [
      { item: 'ukpga/2018/12', counterpart: 'ukdsi/2026/9780348287233' },
      'counterpart "ukdsi/2026/9780348287233"',
      'Call again without counterpart, or once the instrument is made pass its own path as counterpart: find it by title with uklaw_search_legislation (types secondary).',
    ],
  ] as [AmendmentsInput, string, string][])(
    '%j fails draft_item before any request, on both surfaces',
    async (input, subject, hint) => {
      const up = createUpstream([]);
      const result = await runToolContract(getAmendmentsTool, input);
      expect(up.unhandled).toEqual([]);
      expect(up.paths()).toEqual([]);
      const error = errorOf(result);
      const message = `${subject} is draft legislation; legislation.gov.uk's changes feeds do not index drafts: a draft is not amended, and amends nothing, until it is made.`;
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data?.reason).toBe('draft_item');
      expect(error.message).toBe(message);
      expect(error.data?.recovery).toEqual({ hint });
      const text = contentText(result);
      expect(text).toContain(message);
      expect(text).toContain(hint);
    },
  );

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

  it('rejects a cursor holding a position no call over its query produces, before any request', async () => {
    createUpstream([
      ...routes([AFFECTED, feed('changes-affected-ukpga-2018-12.feed')]),
      ...scanRoutes(),
    ]);
    const plain: AmendmentsInput = { item: 'ukpga/2018/12', limit: 3 };
    const scan: AmendmentsInput = {
      item: 'ukpga/2018/12',
      provision: 'section/45',
      status: 'unapplied',
      limit: 2,
    };
    const plainCursor = (await amendments(plain)).output.next_cursor as string;
    const scanCursor = (await amendments(scan)).output.next_cursor as string;
    const forged: [AmendmentsInput, string, Record<string, unknown>][] = [
      [plain, plainCursor, { p: Number.MAX_SAFE_INTEGER }],
      [plain, plainCursor, { p: 10_001 }],
      // A plain page reads `limit` effects; a scan page holds 500.
      [plain, plainCursor, { o: 3 }],
      [scan, scanCursor, { o: 500 }],
      [scan, scanCursor, { p: 10_001 }],
      // Only a Publication Log day walk carries a day.
      [scan, scanCursor, { d: '2026-09-24' }],
    ];
    for (const [input, cursor, change] of forged) {
      const up = createUpstream([]);
      await expect(
        failure({ ...input, cursor: forgeCursor(cursor, change) }),
      ).resolves.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'invalid_cursor' },
      });
      expect(up.paths()).toEqual([]);
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
    const path = '/changes/unapplied/affected/uksi/1980/2049/data.feed?results-count=20';
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
