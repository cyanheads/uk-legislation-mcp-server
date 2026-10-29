/**
 * @fileoverview Tests for uklaw_track_changes over recorded Publication Log
 * pages: the day walk (pages within a day, days newest-first, the four-request
 * budget, in-page offset cursors resumed from the cache, degraded answers when
 * a later request cannot start, no day after today's UK date read), item-log mode (window filtering, the stop
 * at the first older event, events not dated by a calendar date skipped, and read_back_to taken only from
 * calendar dates), path segment order, every declared error reason (cursors holding a position no call over
 * their window produces included), blank inputs, and both result surfaces through the enrichment parse.
 * @module tests/mcp-server/tools/definitions/track-changes.tool.test
 */

import type { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import MarkdownIt from 'markdown-it';
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
  forgeCursor,
  gatedPacer,
  ok,
  type Route,
  routes,
  status,
  testClock,
  thrown,
  type Upstream,
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

/** A cursor's decoded JSON payload. */
const payloadOf = (cursor: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));

/** The notice of a continuation that finds no further events in its window (issue #23). */
const WINDOW_END =
  'No further Publication Log events: this call read to the end of the window, so the calls before this one returned every event it holds.';
/** The quiet-window notice, with its filter advice, for a filtered window no call returned events from. */
const QUIET_FILTERED =
  'No Publication Log events in this window. Filters narrow an otherwise busy log: drop new_only, category, event, or item to widen.';
/** The quiet-window fragments an end-of-window continuation never carries. */
const FIRST_CALL_ONLY = [
  'No Publication Log events in this window.',
  'Filters narrow',
  'Confirm the item',
];

/** The plain text of every paragraph in `text`, from a CommonMark parse. */
const paragraphs = (text: string): string[] =>
  new MarkdownIt('commonmark')
    .parse(text, {})
    .filter((t) => t.type === 'inline')
    .map((t) =>
      (t.children ?? []).map((c) => (c.type === 'softbreak' ? '\n' : c.content)).join(''),
    );

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

  describe('a continuation that returns no events', () => {
    const base = { content_type: 'legislation', new_only: true, limit: 7 } as const;

    it('ends the window with the end-of-window notice and no filter advice, on both surfaces', async () => {
      createUpstream(
        routes(
          [NEW('2026-09-24'), feed('update-2026-09-24-legislation-new.feed')],
          [NEW('2026-09-23'), feed(EMPTY)],
        ),
      );
      const window = { ...base, start_date: '2026-09-23', end_date: '2026-09-24' };
      const first = await track(window);
      expect(first.output.events).toHaveLength(7);
      expect(payloadOf(first.output.next_cursor as string)).toMatchObject({
        d: '2026-09-23',
        e: 1,
      });
      const result = await runToolContract(trackChangesTool, {
        ...window,
        cursor: first.output.next_cursor as string,
      });
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured).toMatchObject({ events: [], has_more: false });
      expect(structured).not.toHaveProperty('next_cursor');
      expect(structured.notice).toBe(WINDOW_END);
      const text = contentText(result);
      expect(paragraphs(text)).toContain(WINDOW_END);
      for (const fragment of FIRST_CALL_ONLY) expect(text).not.toContain(fragment);
    });

    it('keeps the today fragment when the window reaches today', async () => {
      createUpstream(
        routes(
          [NEW('2026-09-26'), feed('update-2026-09-24-legislation-new.feed')],
          [NEW('2026-09-25'), feed(EMPTY)],
        ),
        { clock: testClock() },
      );
      const window = { ...base, start_date: '2026-09-25', end_date: '2026-09-26' };
      const first = await track(window);
      const { output, enrichment } = await track({
        ...window,
        cursor: first.output.next_cursor as string,
      });
      expect(output).toMatchObject({ events: [], has_more: false });
      expect(enrichment.notice).toBe(
        `${WINDOW_END} The window reaches today: the log for today fills during the UK working day.`,
      );
    });

    it('with the window not yet read to its end, keeps the continue notice and its filter advice, and carries the mark to the call that ends it', async () => {
      createUpstream(
        routes(
          [NEW('2026-09-24'), feed('update-2026-09-24-legislation-new.feed')],
          ...['23', '22', '21', '20', '19', '18', '17', '16', '15'].map(
            (day) => [NEW(`2026-09-${day}`), feed(EMPTY)] as [string, Route['respond']],
          ),
        ),
      );
      const window = { ...base, start_date: '2026-09-15', end_date: '2026-09-24' };
      const first = await track(window);
      const { output, enrichment } = await track({
        ...window,
        cursor: first.output.next_cursor as string,
      });
      expect(output).toMatchObject({ events: [], has_more: true });
      // This call returned nothing, but the first did: the mark rides on.
      expect(payloadOf(output.next_cursor as string)).toMatchObject({
        p: 1,
        d: '2026-09-19',
        e: 1,
      });
      expect(enrichment.notice).toBe(
        'No events in the part of the window read so far; call again with cursor set to next_cursor to continue. Filters narrow an otherwise busy log: drop new_only, category, event, or item to widen.',
      );
      const third = await track({ ...window, cursor: output.next_cursor as string });
      expect(third.output).toMatchObject({ events: [], has_more: true });
      expect(payloadOf(third.output.next_cursor as string)).toMatchObject({
        d: '2026-09-15',
        e: 1,
      });
      const last = await track({ ...window, cursor: third.output.next_cursor as string });
      expect(last.output).toMatchObject({ events: [], has_more: false });
      expect(last.enrichment.notice).toBe(WINDOW_END);
    });

    it('ends a window with the quiet-window notice when resumed from a cursor an earlier release minted, which carries no mark', async () => {
      createUpstream(
        routes(
          [NEW('2026-09-24'), feed('update-2026-09-24-legislation-new.feed')],
          [NEW('2026-09-23'), feed(EMPTY)],
        ),
      );
      const window = { ...base, start_date: '2026-09-23', end_date: '2026-09-24' };
      const minted = (await track(window)).output.next_cursor as string;
      const { output, enrichment } = await track({
        ...window,
        cursor: forgeCursor(minted, { e: undefined }),
      });
      expect(output).toMatchObject({ events: [], has_more: false });
      expect(enrichment.notice).toBe(QUIET_FILTERED);
    });

    it('leaves a first call that finds nothing with the quiet-window notice', async () => {
      createUpstream(routes([NEW('2026-09-23'), feed(EMPTY)]));
      const { enrichment } = await track({ ...base, start_date: '2026-09-23' });
      expect(enrichment.notice).toBe(QUIET_FILTERED);
    });

    it('ends a window no call returned events from with the quiet-window notice and its filter advice, on both surfaces', async () => {
      // All six days are empty: the first call reads four under its request budget, the second the last two.
      const up = createUpstream(
        routes(
          ...['24', '23', '22', '21', '20', '19'].map(
            (day) => [NEW(`2026-09-${day}`), feed(EMPTY)] as [string, Route['respond']],
          ),
        ),
      );
      const window = { ...base, start_date: '2026-09-19', end_date: '2026-09-24' };
      const first = await track(window);
      expect(first.output).toMatchObject({ events: [], has_more: true });
      expect(payloadOf(first.output.next_cursor as string)).toEqual({
        k: expect.any(String),
        p: 1,
        d: '2026-09-20',
      });
      const result = await runToolContract(trackChangesTool, {
        ...window,
        cursor: first.output.next_cursor as string,
      });
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured).toMatchObject({ events: [], has_more: false });
      expect(structured).not.toHaveProperty('next_cursor');
      expect(structured.notice).toBe(QUIET_FILTERED);
      const text = contentText(result);
      expect(paragraphs(text)).toContain(QUIET_FILTERED);
      expect(text).not.toContain('No further Publication Log events');
      expect(up.unhandled).toEqual([]);
    });
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

  it('starts the walk at today when end_date is later', async () => {
    const up = createUpstream(
      routes(
        [NEW('2026-09-26'), feed(EMPTY)],
        [NEW('2026-09-25'), feed(EMPTY)],
        [NEW('2026-09-24'), feed('update-2026-09-24-legislation-new.feed')],
        [NEW('2026-09-23'), feed(EMPTY)],
      ),
      { clock: testClock() },
    );
    const result = await runToolContract(trackChangesTool, {
      start_date: '2026-09-15',
      end_date: '2026-09-30',
      content_type: 'legislation',
      new_only: true,
    });
    expect(up.paths()).toEqual([
      NEW('2026-09-26'),
      NEW('2026-09-25'),
      NEW('2026-09-24'),
      NEW('2026-09-23'),
    ]);
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured).toMatchObject({
      window: { start_date: '2026-09-15', end_date: '2026-09-30' },
      has_more: true,
    });
    expect(structured.events).toHaveLength(7);
    expect((structured.days as { date: string }[]).map((d) => d.date)).toEqual([
      '2026-09-26',
      '2026-09-25',
      '2026-09-24',
      '2026-09-23',
    ]);
    const cursor = JSON.parse(
      Buffer.from(structured.next_cursor as string, 'base64url').toString(),
    );
    expect(cursor).toMatchObject({ p: 1, d: '2026-09-22' });
    expect(structured.notice).toContain("This call's request budget ended before the window did");
    const text = contentText(result);
    expect(text).toContain(
      '**Days read:** 2026-09-26 (0 events, 1 page(s)), 2026-09-25 (0 events, 1 page(s)), 2026-09-24 (7 events, 1 page(s)), 2026-09-23 (0 events, 1 page(s))',
    );
    expect(text).toContain("This call's request budget ended before the window did");
  });

  const FUTURE_NOTICE =
    'The window starts after today (2026-09-26, UK date): the Publication Log holds no events for future dates, so nothing was requested. Pass a start_date on or before 2026-09-26.';

  it.each([
    ['day_walk', { content_type: 'legislation', category: 'primary' }],
    ['item_log', itemLogBase],
  ] as [string, Partial<TrackInput>][])(
    'a window wholly after today answers without a request (%s)',
    async (mode, input) => {
      const up = createUpstream([], { clock: testClock() });
      const result = await runToolContract(trackChangesTool, {
        start_date: '2026-10-01',
        end_date: '2026-10-31',
        ...input,
      });
      expect(up.paths()).toEqual([]);
      expect(up.unhandled).toEqual([]);
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured).toMatchObject({ mode, events: [], days: [], has_more: false });
      for (const key of ['next_cursor', 'item_log_total', 'read_back_to', 'truncated']) {
        expect(structured).not.toHaveProperty(key);
      }
      expect(structured.notice).toBe(FUTURE_NOTICE);
      expect(contentText(result)).toContain(FUTURE_NOTICE);
    },
  );

  it.each([
    // 23:30 UTC is 00:30 BST the next day: the UK date is already 2026-09-27.
    [
      '2026-09-26T23:30:00Z',
      '2026-09-27',
      ['/update/2026-09-27/data.feed'],
      '2026-09-27 (0 events, 1 page(s))',
    ],
    // In winter the UK is on UTC: the UK date is still 2026-01-15.
    [
      '2026-01-15T23:30:00Z',
      '2026-01-16',
      [],
      'The window starts after today (2026-01-15, UK date)',
    ],
  ])('at %s, a window starting %s reads %j', async (now, start, paths, text) => {
    const up = createUpstream(routes(['/update/2026-09-27/data.feed', feed(EMPTY)]), {
      clock: testClock(now),
    });
    const result = await runToolContract(trackChangesTool, { start_date: start });
    expect(up.paths()).toEqual(paths);
    expect(up.unhandled).toEqual([]);
    expect(result.isError).toBeFalsy();
    expect(contentText(result)).toContain(text);
  });

  it('names the unread days after today when a quiet window runs past it', async () => {
    const up = createUpstream(
      routes(
        ['/update/2026-09-26/legislation/primary/data.feed', feed(EMPTY)],
        ['/update/2026-09-25/legislation/primary/data.feed', feed(EMPTY)],
      ),
      { clock: testClock() },
    );
    const result = await runToolContract(trackChangesTool, {
      start_date: '2026-09-25',
      end_date: '2026-09-30',
      content_type: 'legislation',
      category: 'primary',
    });
    expect(up.paths()).toEqual([
      '/update/2026-09-26/legislation/primary/data.feed',
      '/update/2026-09-25/legislation/primary/data.feed',
    ]);
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured).toMatchObject({ events: [], has_more: false });
    for (const surface of [structured.notice as string, contentText(result)]) {
      expect(surface).toContain(
        "Days after today (2026-09-26, UK date) were not read: the log holds no events for them yet, and today's fills during the UK working day.",
      );
      expect(surface).not.toContain('The window reaches today');
    }
  });

  it('a feed 404 fails filter_refused with its recovery, not a quiet window', async () => {
    createUpstream(routes([DAY, status(404)]));
    const result = await runToolContract(trackChangesTool, { start_date: '2026-09-24' });
    expect(errorOf(result)).toMatchObject({
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

  /** The recorded item-log page with every event year moved back by `years`: a deeper page of the log. */
  const olderLogPage = (years: number) =>
    ok(
      fixture('feeds/update-changes-affected-ukpga-2018-12.feed').replace(
        /<updated>(\d{4})/g,
        (_, year: string) => `<updated>${Number(year) - years}`,
      ),
      { contentType: 'application/atom+xml;charset=utf-8' },
    );

  it('names how far back the read has passed when the window lies deeper, then finds it by page search, on both surfaces', async () => {
    // Pages 1, 2, 4, 6 and 7 are all newer than the window; page 8 holds it.
    const up = createUpstream(
      routes(
        [ITEM_LOG, olderLogPage(0)],
        [`${ITEM_LOG}?page=2`, olderLogPage(3)],
        [`${ITEM_LOG}?page=4`, olderLogPage(9)],
        [`${ITEM_LOG}?page=8`, olderLogPage(15)],
        [`${ITEM_LOG}?page=6`, olderLogPage(12)],
        [`${ITEM_LOG}?page=7`, olderLogPage(13)],
      ),
    );
    const window = { ...itemLogBase, start_date: '2010-06-01', end_date: '2010-06-30' };
    const first = await runToolContract(trackChangesTool, window);
    expect(first.isError).toBeFalsy();
    const structured = first.structuredContent as Record<string, unknown>;
    expect(structured).toMatchObject({
      mode: 'item_log',
      events: [],
      days: [],
      has_more: true,
      read_back_to: '2015-01-16',
    });
    const progress =
      "No events yet: the log of ukpga/2018/12 is read newest first, and this call reached 2015-01-16, after the window's end (2010-06-30); call again with cursor set to next_cursor to read further back toward 2010-06-01.";
    expect(structured.notice).toBe(progress);
    const text = contentText(first);
    expect(text).toContain('**Events:** 0 · has_more: true');
    expect(text).toContain('read back to 2015-01-16');
    expect(text).toContain(progress);
    for (const surface of [structured.notice as string, text]) {
      expect(surface).not.toContain('Confirm the item');
      expect(surface).not.toContain('drop new_only');
    }
    // Page 8 holds the window, so the search resumes between pages 4 and 8.
    expect(payloadOf(structured.next_cursor as string)).toMatchObject({ p: 4, h: 8 });

    const second = await runToolContract(trackChangesTool, {
      ...window,
      cursor: structured.next_cursor as string,
    });
    const rest = second.structuredContent as Record<string, unknown>;
    expect(rest).toMatchObject({ has_more: false, read_back_to: '2010-04-17' });
    expect((rest.events as { updated: string }[]).map((e) => e.updated.slice(0, 10))).toEqual([
      '2010-06-26',
      '2010-06-26',
    ]);
    expect(contentText(second)).toContain('read back to 2010-04-17');
    expect(up.paths()).toEqual([
      ITEM_LOG,
      `${ITEM_LOG}?page=2`,
      `${ITEM_LOG}?page=4`,
      `${ITEM_LOG}?page=8`,
      `${ITEM_LOG}?page=6`,
      `${ITEM_LOG}?page=7`,
    ]);
    expect(up.unhandled).toEqual([]);
  });

  it('names the oldest event read: the one that ended the window, or the last one returned when limit filled', async () => {
    createUpstream(routes([ITEM_LOG, feed('update-changes-affected-ukpga-2018-12.feed')]));
    const window = { ...itemLogBase, start_date: '2026-01-20', end_date: '2026-02-19' };
    const whole = await runToolContract(trackChangesTool, window);
    expect(whole.structuredContent).toMatchObject({ has_more: false, read_back_to: '2026-01-06' });
    expect(contentText(whole)).toContain('read back to 2026-01-06');

    const capped = await runToolContract(trackChangesTool, { ...window, limit: 2 });
    const cappedOut = capped.structuredContent as Record<string, unknown>;
    expect(cappedOut).toMatchObject({ has_more: true, read_back_to: '2026-02-06' });
    expect(contentText(capped)).toContain('read back to 2026-02-06');
    const rest = await runToolContract(trackChangesTool, {
      ...window,
      limit: 2,
      cursor: cappedOut.next_cursor as string,
    });
    expect(rest.structuredContent).toMatchObject({ has_more: false, read_back_to: '2026-01-06' });
  });

  it.each([
    [
      'an item log holding no event',
      { ...itemLogBase, start_date: '2026-01-01', end_date: '2026-01-31' },
    ],
    ['a day walk', { start_date: '2026-09-24' }],
  ] as [string, TrackInput][])('leaves read_back_to out for %s', async (_, input) => {
    const up = createUpstream([...dayRoutes(), ...routes([ITEM_LOG, feed(EMPTY)])]);
    const result = await runToolContract(trackChangesTool, input);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).not.toHaveProperty('read_back_to');
    expect(contentText(result)).not.toContain('read back to');
    expect(up.unhandled).toEqual([]);
  });

  /**
   * A recorded item-log page (by default the changes log) with entry `i`'s `<updated>` replaced by
   * `updated(i)`, as written into the XML. The feed's own `<updated>` precedes the first entry and is kept.
   */
  const withEntryDates = (
    updated: (i: number) => string,
    xml = fixture('feeds/update-changes-affected-ukpga-2018-12.feed'),
  ) => {
    const first = xml.indexOf('<entry>');
    let i = 0;
    return `${xml.slice(0, first)}${xml
      .slice(first)
      .replace(/<updated>[^<]*<\/updated>/g, () => `<updated>${updated(i++)}</updated>`)}`;
  };
  const atomOk = (body: string) => () =>
    ok(body, { contentType: 'application/atom+xml;charset=utf-8' });

  it('takes read_back_to only from an event dated by a calendar date, on both surfaces', async () => {
    // The second event's date sorts before any calendar date; the third, older than the window, ends it.
    const page = withEntryDates((i) =>
      i === 0 ? '2026-02-06T16:26:43Z' : i === 1 ? '**&lt;img src' : '2026-01-06T10:35:32Z',
    );
    createUpstream(routes([ITEM_LOG, atomOk(page)]));
    const result = await runToolContract(trackChangesTool, {
      ...itemLogBase,
      start_date: '2026-01-20',
      end_date: '2026-02-19',
    });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { events: unknown[]; read_back_to?: string };
    expect(structured.events).toHaveLength(1);
    expect(structured.read_back_to).toBe('2026-01-06');
    const text = contentText(result);
    expect(text).toContain('read back to 2026-01-06');
    expect(text).not.toContain('**<img');
  });

  const recordedDates = () =>
    parsePublicationLog(fixture('feeds/update-changes-affected-ukpga-2018-12.feed')).events.map(
      (e) => e.updated,
    );

  it('skips an event not dated by a calendar date rather than ending the window on it', async () => {
    const dates = recordedDates();
    // Events 5–7 fall inside the window and event 8 precedes it; event 6's date sorts before any calendar date.
    const page = withEntryDates((i) => (i === 6 ? '**&lt;img src' : (dates[i] as string)));
    const up = createUpstream(routes([ITEM_LOG, atomOk(page)]));
    const { output } = await track({
      ...itemLogBase,
      start_date: '2026-01-20',
      end_date: '2026-02-19',
    });
    expect(output.events.map((e) => e.updated.slice(0, 10))).toEqual(['2026-02-06', '2026-02-04']);
    expect(output).toMatchObject({ has_more: false, read_back_to: '2026-01-06' });
    expect(up.paths()).toEqual([ITEM_LOG]);
  });

  it('leaves out an event not dated by a calendar date that sorts inside the window, and does not count it as more to read', async () => {
    const dates = recordedDates();
    const page = withEntryDates((i) => (i === 7 ? '2026-02-0x' : (dates[i] as string)));
    createUpstream(routes([ITEM_LOG, atomOk(page)]));
    const window = { ...itemLogBase, start_date: '2026-01-20', end_date: '2026-02-19' };
    const whole = await track(window);
    expect(whole.output.events.map((e) => e.updated)).toEqual([dates[5], dates[6]]);
    // limit fills on event 6; only the malformed event 7 is left on the page inside the window.
    const capped = await track({ ...window, limit: 2 });
    expect(capped.output).toMatchObject({ has_more: false });
    expect(capped.output.next_cursor).toBeUndefined();
    expect(capped.enrichment).not.toHaveProperty('truncated');
  });

  it('quotes no event date that is not a calendar date in the progress notice, on both surfaces', async () => {
    const page = withEntryDates(() => '9999&lt;b&gt;x');
    const up = createUpstream(
      routes(
        [ITEM_LOG, atomOk(page)],
        [`${ITEM_LOG}?page=2`, atomOk(page)],
        [`${ITEM_LOG}?page=3`, atomOk(page)],
        [`${ITEM_LOG}?page=4`, atomOk(page)],
      ),
    );
    const result = await runToolContract(trackChangesTool, {
      ...itemLogBase,
      start_date: '2026-01-20',
      end_date: '2026-02-19',
    });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured).toMatchObject({ mode: 'item_log', events: [], has_more: true });
    expect(structured).not.toHaveProperty('read_back_to');
    expect(structured.notice).toEqual(expect.any(String));
    expect(structured.notice).not.toContain('<b>');
    expect(contentText(result)).not.toContain('<b>');
    expect(up.paths()).toEqual([
      ITEM_LOG,
      `${ITEM_LOG}?page=2`,
      `${ITEM_LOG}?page=3`,
      `${ITEM_LOG}?page=4`,
    ]);
  });

  it('format() renders read_back_to through the inline escaper', () => {
    const output: z.infer<typeof trackChangesTool.output> = {
      events: [],
      window: { start_date: '2026-01-20', end_date: '2026-02-19' },
      filters: { new_only: false },
      mode: 'item_log',
      days: [],
      read_back_to: '**<img src',
      has_more: false,
      attribution: [ATTRIBUTION_LINES.ogl],
    };
    const text = (trackChangesTool.format?.(output) ?? [])
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n');
    expect(text).toContain('read back to \\*\\*\\<img src');
    expect(text).not.toContain('**<img');
  });

  describe('page search', () => {
    const LOG = '/update/ukpga/2018/12/data.feed';
    const at = (page: number) => (page === 1 ? LOG : `${LOG}?page=${page}`);
    const pageOf = (path: string) =>
      Number(new URLSearchParams(path.split('?')[1]).get('page') ?? 1);
    const TOTAL = /<openSearch:totalResults>\d+<\/openSearch:totalResults>/;
    /** A recorded page of the ukpga/2018/12 log: 1,431 events over 72 pages, captured 2026-10-29. */
    const recorded = (page: number) => fixture(`feeds/update-ukpga-2018-12-page-${page}.feed`);
    /**
     * Pages the capture did not record, as recorded page 52 with every entry dated by the oldest
     * date the live log's page held (the read_back_to of a live call that read it last).
     */
    const STAND_IN: Record<number, string> = {
      2: '2026-09-29',
      4: '2026-09-29',
      8: '2026-06-22',
      16: '2026-04-01',
      32: '2025-12-31',
      48: '2025-07-11',
      // Probed 2026-10-29, the log still at 1,431 events.
      58: '2024-12-16',
      60: '2024-05-18',
    };
    const log = (): Record<number, string> => ({
      ...Object.fromEntries(
        Object.entries(STAND_IN).map(([page, date]) => [
          page,
          withEntryDates(() => `${date}T12:00:00+01:00`, recorded(52)),
        ]),
      ),
      ...Object.fromEntries([1, 52, 53, 54, 55, 56, 57, 64, 72].map((p) => [p, recorded(p)])),
    });
    /** Routes serving each page body, optionally with its openSearch:totalResults removed. */
    const logRoutes = (pages: Record<number, string>, withTotal = true): Route[] =>
      Object.entries(pages).map(([page, xml]) => ({
        path: at(Number(page)),
        respond: atomOk(withTotal ? xml : xml.replace(TOTAL, '')),
      }));

    /** Calls until has_more is false, recording each call's upstream pages, structured result, and text. */
    async function readAll(up: Upstream, input: TrackInput, cursor?: string) {
      const calls: { pages: number[]; out: Record<string, unknown>; text: string }[] = [];
      let next = cursor;
      do {
        const seen = up.paths().length;
        const result = await runToolContract(trackChangesTool, {
          ...input,
          ...(next ? { cursor: next } : {}),
        });
        expect(result.isError).toBeFalsy();
        const out = result.structuredContent as Record<string, unknown>;
        calls.push({ pages: up.paths().slice(seen).map(pageOf), out, text: contentText(result) });
        next = out.next_cursor as string | undefined;
      } while (next && calls.length < 10);
      return calls;
    }
    const june: TrackInput = {
      item: 'ukpga/2018/12',
      start_date: '2025-06-01',
      end_date: '2025-06-30',
    };
    const progress = (reached: unknown) =>
      `No events yet: the log of ukpga/2018/12 is read newest first, and this call reached ${reached}, after the window's end (2025-06-30); call again with cursor set to next_cursor to read further back toward 2025-06-01.`;

    it('reaches a window on page 53 of 72 in 12 requests and returns every window event once, in log order, on both surfaces', async () => {
      const up = createUpstream(logRoutes(log()));
      const calls = await readAll(up, june);
      expect(calls.map((c) => c.pages)).toEqual([
        [1, 2, 4, 8],
        [16, 32, 64],
        [48, 56, 52],
        [54, 53, 55],
        [57],
      ]);
      // 2⌈log2 53⌉ = 12 requests read page 53; reading every page in order took 53.
      expect(calls.flatMap((c) => c.pages).indexOf(53) + 1).toBe(12);
      expect(up.unhandled).toEqual([]);
      expect(
        calls.map((c) => [(c.out.events as unknown[]).length, c.out.read_back_to, c.out.has_more]),
      ).toEqual([
        [0, '2026-06-22', true],
        // Pages 64 and 56 were probed past the window's first page and do not move read_back_to.
        [0, '2025-12-31', true],
        [0, '2025-07-01', true],
        [40, '2025-06-26', true],
        [35, '2025-04-17', false],
      ]);
      expect(calls.map((c) => c.out.next_cursor && payloadOf(c.out.next_cursor as string))).toEqual(
        [
          { k: expect.any(String), p: 8 },
          { k: expect.any(String), p: 32, h: 64 },
          { k: expect.any(String), p: 52, h: 56 },
          // The fourth call returned events, so its cursor carries the mark.
          { k: expect.any(String), p: 55, o: 5, e: 1 },
          undefined,
        ],
      );
      for (const call of calls.slice(0, 3)) {
        expect(call.out.notice).toBe(progress(call.out.read_back_to));
        expect(call.text).toContain(progress(call.out.read_back_to));
        expect(call.text).toContain(`read back to ${call.out.read_back_to}`);
      }
      expect(calls.every((c) => c.out.item_log_total === 1431)).toBe(true);
      const window = [53, 54, 55, 56]
        .flatMap((p) => parsePublicationLog(recorded(p)).events)
        .filter((e) => e.updated.startsWith('2025-06'));
      expect(window).toHaveLength(75);
      expect(calls.flatMap((c) => c.out.events as unknown[])).toEqual(window);
    });

    it('when limit fills on the last event of the window’s last page, ends the window on the next call with the end-of-window notice, on both surfaces', async () => {
      // June's 75 events end on page 56's last entry, the 25th of the third call; page 57 opens on 2025-04-17.
      const up = createUpstream(logRoutes(log()));
      const calls = await readAll(up, { ...june, limit: 25 });
      expect(
        calls.map((c) => [(c.out.events as unknown[]).length, c.out.read_back_to, c.out.has_more]),
      ).toEqual([
        [0, '2026-06-22', true],
        [0, '2025-12-31', true],
        [0, '2025-07-01', true],
        [25, '2025-06-26', true],
        [25, '2025-06-26', true],
        [25, '2025-06-26', true],
        [0, '2025-04-17', false],
      ]);
      // The mark that events were returned rides every cursor from the fourth call on.
      expect(
        calls.map((c) => c.out.next_cursor && payloadOf(c.out.next_cursor as string).e),
      ).toEqual([undefined, undefined, undefined, 1, 1, 1, undefined]);
      expect(payloadOf(calls[5]?.out.next_cursor as string)).toEqual({
        k: expect.any(String),
        p: 57,
        e: 1,
      });
      expect(calls[5]?.out).toMatchObject({ truncated: true, shown: 25, cap: 25 });
      const window = [53, 54, 55, 56]
        .flatMap((p) => parsePublicationLog(recorded(p)).events)
        .filter((e) => e.updated.startsWith('2025-06'));
      expect(calls.flatMap((c) => c.out.events as unknown[])).toEqual(window);
      const last = calls[6] as (typeof calls)[number];
      expect(last.pages).toEqual([57]);
      expect(last.out).not.toHaveProperty('next_cursor');
      expect(last.out.notice).toBe(WINDOW_END);
      expect(paragraphs(last.text)).toContain(WINDOW_END);
      for (const fragment of FIRST_CALL_ONLY) expect(last.text).not.toContain(fragment);
    });

    it('ends a window the log skips with the quiet-window notice, its filter advice and the item check, on both surfaces', async () => {
      // The log holds no May 2025 event: page 56 ends on 2025-06-26 and page 57 opens on 2025-04-17.
      const up = createUpstream(logRoutes(log()));
      const calls = await readAll(up, {
        ...june,
        start_date: '2025-05-01',
        end_date: '2025-05-31',
      });
      expect(up.unhandled).toEqual([]);
      expect(calls.map((c) => c.pages)).toEqual([
        [1, 2, 4, 8],
        [16, 32, 64],
        [48, 56, 60],
        [58, 57],
      ]);
      expect(calls.map((c) => [(c.out.events as unknown[]).length, c.out.has_more])).toEqual([
        [0, true],
        [0, true],
        [0, true],
        [0, false],
      ]);
      for (const call of calls.slice(0, 3)) {
        expect(payloadOf(call.out.next_cursor as string)).not.toHaveProperty('e');
        expect(call.out.notice).toMatch(/^No events yet: the log of ukpga\/2018\/12/);
      }
      const last = calls[3] as (typeof calls)[number];
      const quiet = `${QUIET_FILTERED} Confirm the item with uklaw_lookup_citation.`;
      expect(last.out).not.toHaveProperty('next_cursor');
      expect(last.out.notice).toBe(quiet);
      expect(paragraphs(last.text)).toContain(quiet);
      expect(last.text).not.toContain('No further Publication Log events');
    });

    it('ends a window older than the whole log with no events and no cursor, probing the last page the total names', async () => {
      const up = createUpstream(logRoutes(log()));
      const calls = await readAll(up, {
        ...june,
        start_date: '2023-01-01',
        end_date: '2023-01-31',
      });
      expect(calls.map((c) => c.pages)).toEqual([[1, 2, 4, 8], [16, 32, 64], [72]]);
      const last = calls[calls.length - 1]?.out;
      expect(last).toMatchObject({ events: [], has_more: false, read_back_to: '2023-08-07' });
      expect(last).not.toHaveProperty('next_cursor');
      expect(last?.notice).toContain('No Publication Log events in this window.');
    });

    it('treats a probe past the last page like a page older than the window when no total is reported', async () => {
      // Upstream answers any page past the last as it answers page 73: a 200 with no entries and no next link.
      const past = recorded(73);
      const up = createUpstream(logRoutes({ ...log(), 128: past, 96: past, 80: past }, false));
      const calls = await readAll(up, {
        ...june,
        start_date: '2023-01-01',
        end_date: '2023-01-31',
      });
      expect(calls.map((c) => c.pages)).toEqual([[1, 2, 4, 8], [16, 32, 64], [128, 96, 80], [72]]);
      expect(payloadOf(calls[2]?.out.next_cursor as string)).toMatchObject({ p: 64, h: 80 });
      expect(calls[3]?.out).toMatchObject({ events: [], has_more: false });
      expect(calls[3]?.out).not.toHaveProperty('item_log_total');
    });

    it('resumes a cursor minted by an earlier release, with no upper page, by searching from its page', async () => {
      // v0.2.0 cursors for the June window: page 8, and page 55 at offset 5.
      const up = createUpstream(logRoutes(log()));
      const [fromPage] = await readAll(up, june, 'eyJrIjoiZjIwZWJlMDEiLCJwIjo4fQ');
      expect(fromPage?.pages).toEqual([8, 16, 32, 64]);
      expect(fromPage?.out).toMatchObject({
        events: [],
        read_back_to: '2025-12-31',
        has_more: true,
      });
      expect(payloadOf(fromPage?.out.next_cursor as string)).toMatchObject({ p: 32, h: 64 });

      const resumed = await readAll(
        createUpstream(logRoutes(log())),
        june,
        'eyJrIjoiZjIwZWJlMDEiLCJwIjo1NSwibyI6NX0',
      );
      expect(
        resumed.map((c) => [c.pages, (c.out.events as unknown[]).length, c.out.has_more]),
      ).toEqual([[[55, 56, 57], 35, false]]);
    });

    /** The recorded changes-log page with every event year moved back by `years`, as an Atom body. */
    const shifted = (years: number) =>
      withEntryDates(
        (i) => recordedDates()[i]?.replace(/^\d{4}/, (y) => String(Number(y) - years)) ?? '',
      );

    it.each([
      ['page 2', '2022-06', [1, 2]],
      ['page 3', '2019-06', [1, 2, 4, 3]],
      ['page 4', '2016-06', [1, 2, 4, 3]],
    ] as const)(
      'finds a window on %s in one call, as the linear walk did',
      async (_, month, pages) => {
        const up = createUpstream(
          [0, 3, 6, 9].map((years, i) => ({
            path: i === 0 ? ITEM_LOG : `${ITEM_LOG}?page=${i + 1}`,
            respond: atomOk(shifted(years)),
          })),
        );
        const { output } = await track({
          ...itemLogBase,
          start_date: `${month}-01`,
          end_date: `${month}-30`,
        });
        expect(up.paths()).toEqual(
          pages.map((p) => (p === 1 ? ITEM_LOG : `${ITEM_LOG}?page=${p}`)),
        );
        expect(output.events.map((e) => e.updated.slice(0, 10))).toEqual([
          `${month}-26`,
          `${month}-26`,
        ]);
        expect(output.has_more).toBe(false);
      },
    );

    it('reads on from a probe page with no calendar-dated event rather than searching past it', async () => {
      const up = createUpstream(
        routes(
          [ITEM_LOG, atomOk(shifted(0))],
          [`${ITEM_LOG}?page=2`, atomOk(withEntryDates(() => '9999&lt;b&gt;x'))],
          [`${ITEM_LOG}?page=3`, atomOk(shifted(6))],
        ),
      );
      const { output } = await track({
        ...itemLogBase,
        start_date: '2019-06-01',
        end_date: '2019-06-30',
      });
      expect(up.paths()).toEqual([ITEM_LOG, `${ITEM_LOG}?page=2`, `${ITEM_LOG}?page=3`]);
      expect(output.events.map((e) => e.updated.slice(0, 10))).toEqual([
        '2019-06-26',
        '2019-06-26',
      ]);
      expect(output.has_more).toBe(false);
    });

    it('probes no page past 10,000 and reads on from there', async () => {
      createUpstream(
        routes(
          [ITEM_LOG, atomOk(shifted(0))],
          [`${ITEM_LOG}?page=2`, atomOk(shifted(3))],
          [`${ITEM_LOG}?page=4`, atomOk(shifted(6))],
          [`${ITEM_LOG}?page=8`, atomOk(shifted(9))],
        ),
      );
      const window: TrackInput = {
        ...itemLogBase,
        start_date: '2000-01-01',
        end_date: '2000-01-31',
      };
      const minted = (await track(window)).output.next_cursor as string;
      expect(payloadOf(minted)).toMatchObject({ p: 8 });
      const up = createUpstream(
        routes(
          [`${ITEM_LOG}?page=5000`, atomOk(shifted(12))],
          [`${ITEM_LOG}?page=10000`, atomOk(shifted(15))],
          [`${ITEM_LOG}?page=10001`, feed(EMPTY)],
        ),
      );
      const { output } = await track({ ...window, cursor: forgeCursor(minted, { p: 5000 }) });
      expect(up.paths()).toEqual([
        `${ITEM_LOG}?page=5000`,
        `${ITEM_LOG}?page=10000`,
        `${ITEM_LOG}?page=10001`,
      ]);
      expect(output).toMatchObject({ events: [], has_more: false });
    });
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
    expect(up.unhandled).toEqual([]);
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

  /** Expects `invalid_cursor` for each forged cursor, with no upstream request. */
  async function expectRefused(
    input: TrackInput,
    minted: string,
    changes: Record<string, unknown>[],
    clock = testClock(),
  ) {
    for (const change of changes) {
      const up = createUpstream([], { clock });
      await expect(
        failure({ ...input, cursor: forgeCursor(minted, change) }),
      ).resolves.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'invalid_cursor' },
      });
      expect(up.paths()).toEqual([]);
    }
  }

  it('rejects a day walk cursor holding a position no walk over its window produces, before any request', async () => {
    createUpstream(dayRoutes(), { clock: testClock() });
    const window: TrackInput = { start_date: '2026-09-23', end_date: '2026-09-24', limit: 5 };
    const minted = (await track(window)).output.next_cursor as string;
    expect(JSON.parse(Buffer.from(minted, 'base64url').toString())).toMatchObject({
      p: 1,
      o: 5,
      d: '2026-09-24',
      e: 1,
    });
    await expectRefused(window, minted, [
      // Upstream answers an impossible date with the whole log (Design Decision 20).
      { d: '2026-13-45' },
      { d: '2026-09-25' },
      { d: '2026-09-22' },
      { d: undefined },
      { p: 10_001 },
      // Publication Log pages hold 20 events.
      { o: 20 },
      // Only an item-log page search carries an upper page.
      { h: 2 },
      // The events-returned mark is only ever written as 1.
      { e: 0 },
      { e: true },
      { e: '1' },
    ]);
  });

  it('rejects a day walk cursor on a day after today, which the walk never reads', async () => {
    const clock = testClock('2026-09-24T12:00:00Z');
    createUpstream(dayRoutes(), { clock });
    const window: TrackInput = { start_date: '2026-09-23', end_date: '2026-09-30', limit: 5 };
    const minted = (await track(window)).output.next_cursor as string;
    expect(JSON.parse(Buffer.from(minted, 'base64url').toString())).toMatchObject({
      d: '2026-09-24',
    });
    await expectRefused(window, minted, [{ d: '2026-09-25' }], clock);
  });

  it('rejects an item-log cursor holding a day, a page past 10,000, an offset past the page, an upper page not above its page or past 10,000, or an events-returned mark other than 1, before any request', async () => {
    createUpstream(routes([ITEM_LOG, feed('update-changes-affected-ukpga-2018-12.feed')]));
    const window: TrackInput = {
      ...itemLogBase,
      start_date: '2026-01-20',
      end_date: '2026-02-19',
      limit: 2,
    };
    const minted = (await track(window)).output.next_cursor as string;
    expect(payloadOf(minted)).toMatchObject({ p: 1, e: 1 });
    await expectRefused(window, minted, [
      { d: '2026-02-01' },
      { o: 20 },
      { p: 10_001 },
      { h: 1 },
      { h: 10_001 },
      { h: 2.5 },
      { e: 2 },
      { e: null },
    ]);
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
