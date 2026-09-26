/**
 * @fileoverview Tests for uklaw_track_changes over recorded Publication Log
 * pages: the day walk (pages within a day, days newest-first, the four-request
 * budget, in-page offset cursors resumed from the cache, degraded answers when
 * a later request cannot start), item-log mode (window filtering and the stop
 * at the first older event), path segment order, every declared error reason,
 * blank inputs, and both result surfaces through the enrichment parse.
 * @module tests/mcp-server/tools/definitions/track-changes.tool.test
 */

import type { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { trackChangesTool } from '@/mcp-server/tools/definitions/track-changes.tool.js';
import { parsePublicationLog } from '@/services/legislation/atom/publication-log.js';
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
  testClock,
  thrown,
} from '../../../helpers/upstream.js';

type TrackInput = z.input<typeof trackChangesTool.input>;

async function track(input: TrackInput) {
  const ctx = createMockContext({ errors: trackChangesTool.errors });
  const output = await trackChangesTool.handler(trackChangesTool.input.parse(input), ctx);
  return { output, enrichment: getEnrichment(ctx) };
}

function failure(input: TrackInput) {
  const ctx = createMockContext({ errors: trackChangesTool.errors });
  return thrown(() => trackChangesTool.handler(trackChangesTool.input.parse(input), ctx));
}

const DAY = '/update/2026-09-24/data.feed';
const dayRoutes = (): Route[] =>
  routes(
    [DAY, feed('update-2026-09-24.feed')],
    [`${DAY}?page=2`, feed('update-2026-09-24-page-2.feed')],
  );
const EMPTY = 'update-2026-09-24-changes-primary-empty.feed';
const NEW = (date: string) => `/update/${date}/legislation/data.feed?new=true`;
const ITEM_LOG = '/update/changes/affected/ukpga/2018/12/data.feed';
const itemLogBase = {
  item: 'ukpga/2018/12',
  content_type: 'changes',
  direction: 'affected',
} as const;

describe('day walk', () => {
  it('pages within a day until limit, then hands back a cursor', async () => {
    const up = createUpstream(dayRoutes());
    const { output, enrichment } = await track({ start_date: '2026-09-24' });
    expect(up.paths()).toEqual([DAY, `${DAY}?page=2`]);
    expect(output).toMatchObject({
      mode: 'day_walk',
      window: { start_date: '2026-09-24', end_date: '2026-09-24' },
      filters: { new_only: false },
      days: [{ date: '2026-09-24', pages_read: 2, total: 1232 }],
      has_more: true,
      attribution: [ATTRIBUTION_LINES.ogl],
    });
    expect(output.events).toHaveLength(40);
    expect(output).not.toHaveProperty('item_log_total');
    const cursor = JSON.parse(Buffer.from(output.next_cursor as string, 'base64url').toString());
    expect(cursor).toMatchObject({ p: 3, d: '2026-09-24' });
    expect(enrichment).toMatchObject({ truncated: true, shown: 40, cap: 40 });
  });

  it('carries an in-page offset and resumes from the cached page without a request', async () => {
    const up = createUpstream(dayRoutes());
    const first = await track({ start_date: '2026-09-24', limit: 5 });
    const cursor = JSON.parse(
      Buffer.from(first.output.next_cursor as string, 'base64url').toString(),
    );
    expect(cursor).toMatchObject({ p: 1, o: 5, d: '2026-09-24' });

    const second = await track({
      start_date: '2026-09-24',
      limit: 5,
      cursor: first.output.next_cursor as string,
    });
    expect(up.paths()).toEqual([DAY]);
    const page = parsePublicationLog(fixture('feeds/update-2026-09-24.feed'));
    expect(first.output.events).toEqual(page.events.slice(0, 5));
    expect(second.output.events).toEqual(page.events.slice(5, 10));
  });

  it('walks days newest-first and ends the window without a cursor', async () => {
    const up = createUpstream(
      routes(
        [NEW('2026-09-24'), feed('update-2026-09-24-legislation-new.feed')],
        [NEW('2026-09-23'), feed(EMPTY)],
        [NEW('2026-09-22'), feed(EMPTY)],
      ),
    );
    const { output, enrichment } = await track({
      start_date: '2026-09-22',
      end_date: '2026-09-24',
      content_type: 'legislation',
      new_only: true,
    });
    expect(up.paths()).toEqual([NEW('2026-09-24'), NEW('2026-09-23'), NEW('2026-09-22')]);
    expect(output.events).toHaveLength(7);
    expect(output.days).toEqual([
      { date: '2026-09-24', pages_read: 1, total: 7 },
      { date: '2026-09-23', pages_read: 1, total: 0 },
      { date: '2026-09-22', pages_read: 1, total: 0 },
    ]);
    expect(output.has_more).toBe(false);
    expect(output.next_cursor).toBeUndefined();
    expect(enrichment).toEqual({});
  });

  it('when limit fills on a day’s last event, continues from the previous day or ends at the window', async () => {
    createUpstream(routes([NEW('2026-09-24'), feed('update-2026-09-24-legislation-new.feed')]));
    const base = { content_type: 'legislation', new_only: true, limit: 7 } as const;
    const inWindow = await track({ ...base, start_date: '2026-09-23', end_date: '2026-09-24' });
    expect(inWindow.output.events).toHaveLength(7);
    const cursor = JSON.parse(
      Buffer.from(inWindow.output.next_cursor as string, 'base64url').toString(),
    );
    expect(cursor).toMatchObject({ p: 1, d: '2026-09-23' });
    expect(inWindow.enrichment).toMatchObject({ truncated: true, shown: 7, cap: 7 });

    const atEdge = await track({ ...base, start_date: '2026-09-24' });
    expect(atEdge.output).toMatchObject({ has_more: false });
    expect(atEdge.output.next_cursor).toBeUndefined();
    expect(atEdge.enrichment).not.toHaveProperty('truncated');
  });

  it('stops at the four-request budget with a cursor on the next day', async () => {
    createUpstream(
      routes(
        [NEW('2026-09-24'), feed('update-2026-09-24-legislation-new.feed')],
        [NEW('2026-09-23'), feed(EMPTY)],
        [NEW('2026-09-22'), feed(EMPTY)],
        [NEW('2026-09-21'), feed(EMPTY)],
      ),
    );
    const { output, enrichment } = await track({
      start_date: '2026-09-15',
      end_date: '2026-09-24',
      content_type: 'legislation',
      new_only: true,
    });
    expect(output.days.map((d) => d.date)).toEqual([
      '2026-09-24',
      '2026-09-23',
      '2026-09-22',
      '2026-09-21',
    ]);
    expect(output.has_more).toBe(true);
    const cursor = JSON.parse(Buffer.from(output.next_cursor as string, 'base64url').toString());
    expect(cursor).toMatchObject({ p: 1, d: '2026-09-20' });
    expect(enrichment.notice).toContain("This call's request budget ended before the window did");
    expect(enrichment).not.toHaveProperty('truncated');
  });

  it('returns what it read, with a cursor, when a later request cannot start', async () => {
    const up = createUpstream(
      routes(
        [NEW('2026-09-24'), feed('update-2026-09-24-legislation-new.feed')],
        [NEW('2026-09-23'), feed(EMPTY)],
      ),
      { pacer: await gatedPacer(1) },
    );
    const { output, enrichment } = await track({
      start_date: '2026-09-22',
      end_date: '2026-09-24',
      content_type: 'legislation',
      new_only: true,
    });
    expect(up.paths()).toEqual([NEW('2026-09-24')]);
    expect(output.events).toHaveLength(7);
    expect(output.has_more).toBe(true);
    const cursor = JSON.parse(Buffer.from(output.next_cursor as string, 'base64url').toString());
    expect(cursor).toMatchObject({ p: 1, d: '2026-09-23' });
    expect(enrichment.notice).toContain('call again with cursor');
  });

  it('with no events yet, answers empty with a cursor rather than pacer_shed', async () => {
    createUpstream(routes([NEW('2026-09-24'), feed(EMPTY)], [NEW('2026-09-23'), feed(EMPTY)]), {
      pacer: await gatedPacer(1),
    });
    const { output, enrichment } = await track({
      start_date: '2026-09-22',
      end_date: '2026-09-24',
      content_type: 'legislation',
      new_only: true,
    });
    expect(output).toMatchObject({ events: [], has_more: true });
    expect(enrichment.notice).toContain('No events in the part of the window read so far');
  });

  it.each([
    [
      { content_type: 'legislation', category: 'primary' },
      '/update/2026-09-24/legislation/primary/data.feed',
    ],
    [
      { content_type: 'associated-documents', category: 'eu-origin' },
      '/update/2026-09-24/associated-documents/eu-origin/data.feed',
    ],
    [
      { content_type: 'changes', direction: 'affecting' },
      '/update/2026-09-24/changes/affecting/data.feed',
    ],
    [{ item: 'uksi/2026' }, '/update/2026-09-24/uksi/2026/data.feed'],
    [{ item: 'uksi' }, '/update/2026-09-24/uksi/data.feed'],
    [
      { content_type: 'legislation', new_only: true, event: 'withdrawn' },
      '/update/2026-09-24/legislation/data.feed?new=true&event=withdrawn',
    ],
  ] as [Partial<TrackInput>, string][])('%j → %s', async (input, path) => {
    const up = createUpstream(routes([path, feed(EMPTY)]));
    const { output } = await track({ start_date: '2026-09-24', ...input });
    expect(up.paths()).toEqual([path]);
    expect(output.mode).toBe('day_walk');
  });

  it('treats blank optional strings as unset', async () => {
    const up = createUpstream(routes([DAY, feed(EMPTY)]));
    const { output } = await track({
      start_date: '2026-09-24',
      end_date: '',
      content_type: '',
      direction: '',
      category: ' ',
      item: '',
      event: '',
      cursor: '',
    } as TrackInput);
    expect(up.paths()).toEqual([DAY]);
    expect(output.filters).toEqual({ new_only: false });
    expect(output.window.end_date).toBe('2026-09-24');
  });

  it('adds the today notice when the window reaches today', async () => {
    const clock = testClock('2026-09-26T09:00:00Z');
    createUpstream(routes(['/update/2026-09-26/data.feed', feed(EMPTY)]), { clock });
    const { enrichment } = await track({ start_date: '2026-09-26' });
    expect(enrichment.notice).toContain('No Publication Log events in this window.');
    expect(enrichment.notice).toContain('the log for today fills during the UK working day');
  });

  it('a feed 404 fails filter_refused with its recovery, not a quiet window', async () => {
    createUpstream(routes([DAY, status(404)]));
    await expect(failure({ start_date: '2026-09-24' })).resolves.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'filter_refused',
        status: 404,
        recovery: {
          hint: trackChangesTool.errors?.find((e) => e.reason === 'filter_refused')?.recovery,
        },
      },
    });
  });
});

describe('item log', () => {
  it('reads one item’s undated log, keeping events inside the window and stopping at the first older one', async () => {
    const up = createUpstream(
      routes([ITEM_LOG, feed('update-changes-affected-ukpga-2018-12.feed')]),
    );
    const { output, enrichment } = await track({
      ...itemLogBase,
      start_date: '2026-01-20',
      end_date: '2026-02-19',
    });
    expect(up.paths()).toEqual([ITEM_LOG]);
    expect(output).toMatchObject({
      mode: 'item_log',
      days: [],
      item_log_total: 22,
      has_more: false,
    });
    expect(output.events.map((e) => e.updated.slice(0, 10))).toEqual([
      '2026-02-06',
      '2026-02-06',
      '2026-02-04',
    ]);
    expect(output.events[0]).toMatchObject({
      content_type: 'changes',
      direction: 'affected',
      item: { path: 'ukpga/2018/12', title: 'Data Protection Act 2018' },
    });
    expect(output.filters).toMatchObject({ item: 'ukpga/2018/12', content_type: 'changes' });
    expect(enrichment).toEqual({});
  });

  it('carries an in-page offset when limit fills while in-window events remain on the page', async () => {
    const up = createUpstream(
      routes([ITEM_LOG, feed('update-changes-affected-ukpga-2018-12.feed')]),
    );
    const window = { ...itemLogBase, start_date: '2026-01-20', end_date: '2026-02-19', limit: 2 };
    const first = await track(window);
    expect(first.output.events.map((e) => e.updated.slice(0, 10))).toEqual([
      '2026-02-06',
      '2026-02-06',
    ]);
    expect(first.enrichment).toMatchObject({ truncated: true, shown: 2, cap: 2 });
    const cursor = JSON.parse(
      Buffer.from(first.output.next_cursor as string, 'base64url').toString(),
    );
    expect(cursor).toMatchObject({ p: 1, o: 7 });

    const second = await track({ ...window, cursor: first.output.next_cursor as string });
    expect(second.output.events.map((e) => e.updated.slice(0, 10))).toEqual(['2026-02-04']);
    expect(second.output).toMatchObject({ has_more: false });
    expect(second.output.next_cursor).toBeUndefined();
    expect(up.paths()).toEqual([ITEM_LOG]);
  });

  it('reports no more events when limit fills and the rest of the page precedes the window', async () => {
    const up = createUpstream(
      routes([ITEM_LOG, feed('update-changes-affected-ukpga-2018-12.feed')]),
    );
    const window = { ...itemLogBase, start_date: '2026-01-20', end_date: '2026-02-19', limit: 3 };
    const { output, enrichment } = await track(window);
    expect(output.events).toHaveLength(3);
    expect(output.has_more).toBe(false);
    expect(output.next_cursor).toBeUndefined();
    expect(enrichment).not.toHaveProperty('truncated');

    const result = await runToolContract(trackChangesTool, window);
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured).toMatchObject({ has_more: false });
    expect(structured).not.toHaveProperty('next_cursor');
    expect(structured).not.toHaveProperty('truncated');
    const text = contentText(result);
    expect(text).toContain('**Events:** 3 · has_more: false');
    expect(text).not.toContain('More events remain');
    expect(up.paths()).toEqual([ITEM_LOG]);
  });

  it('points at the next page when limit fills on the last event of a page', async () => {
    let seen = 0;
    const cut = fixture('feeds/update-changes-affected-ukpga-2018-12.feed').replace(
      /<entry>[\s\S]*?<\/entry>\s*/g,
      (entry) => (++seen <= 8 ? entry : ''),
    );
    createUpstream([{ path: ITEM_LOG, respond: ok(cut) }]);
    const { output, enrichment } = await track({
      ...itemLogBase,
      start_date: '2026-01-20',
      end_date: '2026-02-19',
      limit: 3,
    });
    expect(output.events.map((e) => e.updated.slice(0, 10))).toEqual([
      '2026-02-06',
      '2026-02-06',
      '2026-02-04',
    ]);
    expect(output.has_more).toBe(true);
    expect(enrichment).toMatchObject({ truncated: true, shown: 3, cap: 3 });
    const cursor = JSON.parse(Buffer.from(output.next_cursor as string, 'base64url').toString());
    expect(cursor).toMatchObject({ p: 2 });
    expect(cursor).not.toHaveProperty('o');
  });

  it('reads the next page of the log when the window runs past the first', async () => {
    const up = createUpstream(
      routes(
        [ITEM_LOG, feed('update-changes-affected-ukpga-2018-12.feed')],
        [`${ITEM_LOG}?page=2`, feed(EMPTY)],
      ),
    );
    const { output } = await track({
      ...itemLogBase,
      start_date: '2024-01-01',
      end_date: '2024-01-31',
    });
    expect(up.paths()).toEqual([ITEM_LOG, `${ITEM_LOG}?page=2`]);
    expect(output.events.map((e) => e.updated.slice(0, 10))).toEqual(['2024-01-16']);
    expect(output.has_more).toBe(false);
  });

  it('returns the first page with a cursor when the next page cannot start', async () => {
    createUpstream(routes([ITEM_LOG, feed('update-changes-affected-ukpga-2018-12.feed')]), {
      pacer: await gatedPacer(1),
    });
    const { output, enrichment } = await track({
      ...itemLogBase,
      start_date: '2024-01-01',
      end_date: '2024-01-31',
    });
    expect(output.events).toHaveLength(1);
    expect(output.has_more).toBe(true);
    const cursor = JSON.parse(Buffer.from(output.next_cursor as string, 'base64url').toString());
    expect(cursor).toMatchObject({ p: 2 });
    expect(enrichment.notice).toContain("This call's request budget ended");
  });

  it('adds item guidance to an empty window', async () => {
    createUpstream(routes([ITEM_LOG, feed('update-changes-affected-ukpga-2018-12.feed')]));
    const { output, enrichment } = await track({
      ...itemLogBase,
      start_date: '2026-07-01',
      end_date: '2026-07-31',
    });
    expect(output.events).toEqual([]);
    expect(enrichment.notice).toContain('Confirm the item with uklaw_lookup_citation.');
    expect(enrichment.notice).toContain('drop new_only, category, event, or item');
  });
});

describe('errors', () => {
  it.each([
    [{ start_date: '2026-02-30' }, 'invalid_date'],
    [{ start_date: '2026-09-24', end_date: '2026-09-31' }, 'invalid_date'],
    [{ start_date: '2026-09-24', end_date: '2026-09-23' }, 'invalid_window'],
    [{ start_date: '2026-08-24', end_date: '2026-09-24' }, 'invalid_window'],
    [{ start_date: '2026-09-24', direction: 'affected' }, 'direction_needs_changes'],
    [
      { start_date: '2026-09-24', content_type: 'legislation', direction: 'affected' },
      'direction_needs_changes',
    ],
    [{ start_date: '2026-09-24', category: 'primary' }, 'category_needs_content_type'],
    [
      { start_date: '2026-09-24', content_type: 'changes', category: 'primary' },
      'category_needs_content_type',
    ],
    [{ start_date: '2026-09-24', item: 'foo' }, 'invalid_item'],
    [{ start_date: '2026-09-24', item: 'ukpga/2018/12/section/1' }, 'invalid_item'],
    [{ start_date: '2026-09-24', cursor: 'bm90LWpzb24' }, 'invalid_cursor'],
  ] as [TrackInput, string][])('%j fails %s before any request', async (input, reason) => {
    const up = createUpstream([]);
    await expect(failure(input)).resolves.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason },
    });
    expect(up.paths()).toEqual([]);
  });

  it('accepts a 31-day window', async () => {
    const up = createUpstream(
      routes(['/update/2026-09-24/data.feed', feed('update-2026-09-24.feed')]),
    );
    await track({ start_date: '2026-08-25', end_date: '2026-09-24', limit: 5 });
    expect(up.paths()).toHaveLength(1);
  });

  it('rejects a cursor minted for another window or limit', async () => {
    createUpstream(dayRoutes());
    const { output } = await track({ start_date: '2026-09-24', limit: 5 });
    for (const changed of [
      { start_date: '2026-09-23', end_date: '2026-09-24', limit: 5 },
      { start_date: '2026-09-24', limit: 6 },
      { start_date: '2026-09-24', limit: 5, new_only: true },
    ] as TrackInput[]) {
      await expect(
        failure({ ...changed, cursor: output.next_cursor as string }),
      ).resolves.toMatchObject({
        data: { reason: 'invalid_cursor' },
      });
    }
  });

  it('maps a 403 to upstream_refused', async () => {
    createUpstream(routes([DAY, status(403)]));
    await expect(failure({ start_date: '2026-09-24' })).resolves.toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'upstream_refused' },
    });
  });

  it.each([[{ start_date: '2026-09-24' }], [{ ...itemLogBase, start_date: '2026-02-01' }]] as [
    TrackInput,
  ][])('fails pacer_shed when the first request of %j cannot start', async (input) => {
    createUpstream(
      [...dayRoutes(), ...routes([ITEM_LOG, feed('update-changes-affected-ukpga-2018-12.feed')])],
      {
        pacer: await gatedPacer(0),
      },
    );
    await expect(failure(input)).resolves.toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'pacer_shed' },
    });
  });

  it.each([
    { start_date: '2026/09/24' },
    { start_date: '' },
    { start_date: '2026-09-24', end_date: 'yesterday' },
    { start_date: '2026-09-24', content_type: 'bills' },
    { start_date: '2026-09-24', item: 'Data Protection Act 2018' },
    { start_date: '2026-09-24', cursor: 'abc=' },
    { start_date: '2026-09-24', limit: 0 },
    { start_date: '2026-09-24', limit: 81 },
    { start_date: '2026-09-24', new_only: 'yes' },
    { start_date: '2026-09-24', event: 'amended' },
  ])('rejects %j at the schema', async (input) => {
    createUpstream([]);
    const error = errorOf(await runToolContract(trackChangesTool, input as TrackInput));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.reason).toBe('invalid_arguments');
  });
});

describe('both surfaces and enrichment', () => {
  it('the zero-result page carries a notice and passes the enrichment parse', async () => {
    createUpstream(routes(['/update/2026-09-24/changes/data.feed', feed(EMPTY)]));
    const result = await runToolContract(trackChangesTool, {
      start_date: '2026-09-24',
      content_type: 'changes',
    });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured).toMatchObject({
      events: [],
      has_more: false,
      days: [{ date: '2026-09-24', pages_read: 1, total: 0 }],
    });
    expect(structured.notice).toContain('No Publication Log events in this window.');
    expect(structured).not.toHaveProperty('truncated');
    const text = contentText(result);
    expect(text).toContain('## Publication Log 2026-09-24 to 2026-09-24 (day_walk)');
    expect(text).toContain('**Filters:** content_type changes · new_only false');
    expect(text).toContain('2026-09-24 (0 events, 1 page(s))');
    expect(text).toContain('No Publication Log events in this window.');
  });

  it('an under-cap final page carries no truncation or notice', async () => {
    createUpstream(routes([NEW('2026-09-24'), feed('update-2026-09-24-legislation-new.feed')]));
    const result = await runToolContract(trackChangesTool, {
      start_date: '2026-09-24',
      content_type: 'legislation',
      new_only: true,
    });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Record<string, unknown>;
    expect((structured.events as unknown[]).length).toBe(7);
    for (const key of ['truncated', 'shown', 'cap', 'notice', 'next_cursor']) {
      expect(structured).not.toHaveProperty(key);
    }
    const text = contentText(result);
    expect(text).toContain('**legislation published**');
    expect(text).toContain('new: true');
    expect(text).toMatch(/Resource: https:\/\/www\.legislation\.gov\.uk\/\S+/);
    expect(text).toContain(ATTRIBUTION_LINES.ogl);
  });

  it('keeps injected HTML and code-span breakers in upstream paths and URIs inside their slot', async () => {
    const injected = fixture('feeds/update-2026-09-24-legislation-new.feed')
      .replace(
        '<dc:identifier>http://www.legislation.gov.uk/id/uksi/2026/1050</dc:identifier>',
        '<dc:identifier>http://www.legislation.gov.uk/id/uksi/2026/1050`&lt;img src=x&gt;</dc:identifier>',
      )
      .replace(
        '<pbl:Document>http://www.legislation.gov.uk/uksi/2026/1050/made</pbl:Document>',
        '<pbl:Document>http://www.legislation.gov.uk/uksi/2026/1050/made&#10;## Doc &lt;b&gt;</pbl:Document>',
      )
      .replace(
        '<pbl:Item_Published>http://www.legislation.gov.uk/uksi/2026/1050/pdfs/uksi_20261050_en.pdf</pbl:Item_Published>',
        '<pbl:Item_Published>http://www.legislation.gov.uk/uksi/2026/1050/pdfs/uksi_20261050_en.pdf [x](javascript:y)</pbl:Item_Published>',
      );
    createUpstream([{ path: NEW('2026-09-24'), respond: ok(injected) }]);
    const result = await runToolContract(trackChangesTool, {
      start_date: '2026-09-24',
      content_type: 'legislation',
      new_only: true,
    });
    const structured = result.structuredContent as { events: { item: { path: string } }[] };
    expect(structured.events[0]?.item.path).toBe('uksi/2026/1050`<img src=x>');
    const text = contentText(result);
    expect(text).not.toMatch(/<(b|img)\b/);
    expect(text).not.toContain('[x](javascript:y)');
    expect(text).toContain('(`uksi/2026/1050%60%3Cimg%20src=x%3E`, type uksi');
    expect(text).toContain(
      '  - Resource: https://www.legislation.gov.uk/uksi/2026/1050/pdfs/uksi_20261050_en.pdf%20%5Bx%5D(javascript:y) · Document: https://www.legislation.gov.uk/uksi/2026/1050/made%20##%20Doc%20%3Cb%3E · Item: https://www.legislation.gov.uk/id/uksi/2026/1050%60%3Cimg%20src=x%3E',
    );
  });

  it('a capped page renders the cursor and the truncation notice', async () => {
    createUpstream(dayRoutes());
    const result = await runToolContract(trackChangesTool, { start_date: '2026-09-24', limit: 5 });
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured).toMatchObject({
      truncated: true,
      shown: 5,
      cap: 5,
      notice: 'More events remain in the window: call again with cursor set to next_cursor.',
    });
    const text = contentText(result);
    expect(text).toContain(`next_cursor: \`${structured.next_cursor as string}\``);
    expect(text).toContain(
      '**changes published** · The Tuberculosis (England and Wales) (Amendment) Order 1990 (`uksi/1990/1869`',
    );
    expect(text).toContain('direction affecting');
    expect(text).toContain('publisher editorial.legislation.gov.uk');
  });

  it('renders item-log mode with its total', async () => {
    createUpstream(routes([ITEM_LOG, feed('update-changes-affected-ukpga-2018-12.feed')]));
    const text = contentText(
      await runToolContract(trackChangesTool, {
        ...itemLogBase,
        start_date: '2026-01-20',
        end_date: '2026-02-19',
      }),
    );
    expect(text).toContain('(item_log)');
    expect(text).toContain('item log total 22');
    expect(text).not.toContain('**Days read:**');
  });

  it('returns a declared reason in the error envelope', async () => {
    createUpstream([]);
    const error = errorOf(
      await runToolContract(trackChangesTool, { start_date: '2026-09-24', category: 'primary' }),
    );
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data?.reason).toBe('category_needs_content_type');
  });
});
