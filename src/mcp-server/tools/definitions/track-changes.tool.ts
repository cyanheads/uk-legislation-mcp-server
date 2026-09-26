/**
 * @fileoverview uklaw_track_changes — reads the legislation.gov.uk Publication
 * Log for a date window: new items, new revised versions, recorded effects,
 * withdrawals. Walks days newest-first, or one item's undated log when a full
 * item is given.
 * @module mcp-server/tools/definitions/track-changes
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { decodeCursor, encodeCursor } from '@/services/legislation/cursor.js';
import { getLegislationService } from '@/services/legislation/legislation-service.js';
import { isCalendarDate, parseItemInput } from '@/services/legislation/provision-path.js';
import { attributionLines, inline, uri } from './_markdown.js';
import { AttributionSchema, blankAsUnset, CursorInput, DateInput, ItemInput } from './_schemas.js';

const CONTENT_TYPES = ['legislation', 'changes', 'draft', 'associated-documents'] as const;
const MAX_WINDOW_DAYS = 31;

function daysBetween(start: string, end: string): number {
  return Math.round(
    (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000,
  );
}

export const trackChangesTool = tool('uklaw_track_changes', {
  title: 'Track legislation.gov.uk publications',
  description:
    'Read the legislation.gov.uk Publication Log for a date window of up to 31 days: new items, new revised versions, newly recorded effects, and withdrawals, newest first — the compliance-monitoring view of "what changed". Filter by content type, effect direction, category, an item or type/year, first-time items only, or event. With a full item path it reads that item\'s own log, usually in one call; otherwise it walks the window day by day, newest first, so a broad window may need several calls. A changes event carries no effect detail — uklaw_get_amendments with that item has it. Continue with next_cursor.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  auth: ['tool:uklaw_track_changes:read'],
  input: z.object({
    start_date: DateInput.describe('First event date of the window, YYYY-MM-DD (UK local time).'),
    end_date: blankAsUnset(DateInput.optional()).describe(
      'Last event date, YYYY-MM-DD; defaults to start_date. The window is at most 31 days.',
    ),
    content_type: blankAsUnset(z.enum(CONTENT_TYPES).optional()).describe(
      'legislation (documents published), changes (effects recorded), draft, or associated-documents. Omit for all.',
    ),
    direction: blankAsUnset(z.enum(['affected', 'affecting']).optional()).describe(
      'With content_type changes only: effects recorded against (affected) or made by (affecting) the item.',
    ),
    category: blankAsUnset(z.enum(['primary', 'secondary', 'eu-origin']).optional()).describe(
      'Item category: primary, secondary, or eu-origin. With content_type legislation or associated-documents only.',
    ),
    item: blankAsUnset(ItemInput.optional()).describe(
      "A full item path (ukpga/2018/12) or legislation.gov.uk URI reads that item's own log; a type (uksi) or type and year (uksi/2026) narrows the day walk. Get a full path from uklaw_lookup_citation or uklaw_search_legislation.",
    ),
    new_only: z
      .boolean()
      .default(false)
      .describe('true: only events for items appearing on legislation.gov.uk for the first time.'),
    event: blankAsUnset(z.enum(['published', 'withdrawn']).optional()).describe(
      'Only published or only withdrawn events. Omit for both.',
    ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(80)
      .default(40)
      .describe('Most events returned by this call (1–80).'),
    cursor: blankAsUnset(CursorInput.optional()).describe(
      'next_cursor from the previous call, passed with the other inputs unchanged; omit to start from end_date.',
    ),
  }),
  output: z.object({
    events: z
      .array(
        z
          .object({
            updated: z
              .string()
              .describe(
                'Event time as legislation.gov.uk writes it (UK local time with offset, ISO 8601).',
              ),
            item: z
              .object({
                path: z.string().describe('Item path.'),
                id_uri: z.string().describe('Identifier URI.'),
                title: z.string().describe('Title.'),
                title_cy: z.string().optional().describe('Welsh title, for bilingual items.'),
              })
              .describe('The item the event concerns.'),
            content_type: z
              .string()
              .describe('Content type: legislation, changes, draft, or associated-documents.'),
            event: z.string().describe('Event: published or withdrawn.'),
            category: z
              .string()
              .optional()
              .describe(
                'Item category as legislation.gov.uk reports it; absent when not reported.',
              ),
            type: z.string().describe('Type code of the item, e.g. uksi.'),
            year: z
              .number()
              .optional()
              .describe('Calendar year of the item; absent when not reported.'),
            number: z.string().optional().describe('Item number; absent when not reported.'),
            document_uri: z
              .string()
              .optional()
              .describe('URI of the document version published; absent when the event names none.'),
            resource_uri: z
              .string()
              .describe('The published resource (a document format, or the changes feed).'),
            format: z
              .string()
              .optional()
              .describe('Format published, e.g. xml or pdf; each format is its own event.'),
            language: z.string().optional().describe('Language of the published resource.'),
            new: z
              .boolean()
              .optional()
              .describe(
                'True when the item is new to legislation.gov.uk; absent when not reported.',
              ),
            newly_issued: z
              .boolean()
              .optional()
              .describe('True for a newly issued item; absent when not reported.'),
            republished: z
              .boolean()
              .optional()
              .describe('True when a document was published again; absent when not reported.'),
            direction: z
              .string()
              .optional()
              .describe('Changes events only: affected or affecting.'),
            publisher: z
              .string()
              .describe('Who published the event, as legislation.gov.uk names them.'),
          })
          .describe('One Publication Log event.'),
      )
      .describe('Events, newest first.'),
    window: z
      .object({
        start_date: z.string().describe('Window start (YYYY-MM-DD).'),
        end_date: z.string().describe('Window end (YYYY-MM-DD), start_date when none was given.'),
      })
      .describe('The window read.'),
    filters: z
      .object({
        content_type: z.string().optional().describe('Content type filter.'),
        direction: z.string().optional().describe('Direction filter.'),
        category: z.string().optional().describe('Category filter.'),
        item: z.string().optional().describe('Item or type/year filter.'),
        new_only: z.boolean().describe('New-items filter.'),
        event: z.string().optional().describe('Event filter.'),
      })
      .describe('Filters applied.'),
    mode: z
      .enum(['day_walk', 'item_log'])
      .describe("day_walk: per-day pages; item_log: one item's undated log."),
    days: z
      .array(
        z
          .object({
            date: z.string().describe('Day read (YYYY-MM-DD).'),
            total: z
              .number()
              .optional()
              .describe(
                'Events legislation.gov.uk holds for that day and filter set; absent when not reported.',
              ),
            pages_read: z.number().describe('Pages of 20 events read for that day by this call.'),
          })
          .describe('One day read.'),
      )
      .describe('Days touched by a day walk (empty in item-log mode).'),
    item_log_total: z
      .number()
      .optional()
      .describe(
        "Events in the item's whole log, all dates; present in item-log mode when reported.",
      ),
    has_more: z
      .boolean()
      .describe('True when more events remain in the window — call again with next_cursor.'),
    next_cursor: z
      .string()
      .optional()
      .describe('Pass as cursor to continue; present only when has_more is true.'),
    attribution: AttributionSchema,
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe('Guidance when the window is quiet or the list continues.'),
    truncated: z.boolean().optional().describe('True when the list was capped at limit.'),
    shown: z.number().optional().describe('Events returned.'),
    cap: z.number().optional().describe('The limit applied.'),
  },
  errors: [
    {
      reason: 'invalid_date',
      code: JsonRpcErrorCode.ValidationError,
      severity: 'notice',
      when: 'start_date or end_date is shaped YYYY-MM-DD but is not a real calendar date.',
      recovery: 'Pass dates as real calendar dates such as 2026-09-24.',
    },
    {
      reason: 'invalid_window',
      code: JsonRpcErrorCode.ValidationError,
      severity: 'notice',
      when: 'end_date is before start_date, or the window is over 31 days.',
      recovery:
        'Pass an end_date on or after start_date within 31 days, and page longer periods with separate calls.',
    },
    {
      reason: 'direction_needs_changes',
      code: JsonRpcErrorCode.ValidationError,
      severity: 'notice',
      when: 'direction is set without content_type changes.',
      recovery: 'Set content_type to changes when filtering by direction, or drop direction.',
    },
    {
      reason: 'category_needs_content_type',
      code: JsonRpcErrorCode.ValidationError,
      severity: 'notice',
      when: 'category is set without content_type legislation or associated-documents.',
      recovery:
        'Set content_type to legislation or associated-documents when filtering by category, or drop category.',
    },
    {
      reason: 'invalid_item',
      code: JsonRpcErrorCode.ValidationError,
      severity: 'notice',
      when: 'item is not a (partial) item path or legislation.gov.uk URI, its type code is unknown, or it carries a provision.',
      recovery:
        'Pass an item path such as ukpga/2018/12, with no provision, or a type and year such as uksi/2026; uklaw_list_reference topic types lists the codes.',
    },
    {
      reason: 'invalid_cursor',
      code: JsonRpcErrorCode.ValidationError,
      severity: 'notice',
      when: 'cursor does not decode or belongs to a different window.',
      recovery: 'Call uklaw_track_changes again without cursor to start from end_date.',
    },
    {
      reason: 'filter_refused',
      code: JsonRpcErrorCode.ValidationError,
      severity: 'warning',
      when: 'legislation.gov.uk answered the Publication Log feed with 404 or 400: a filter combination it does not accept.',
      recovery:
        'Drop one filter at a time (item, category, direction, content_type) and call uklaw_track_changes again.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_refused',
      code: JsonRpcErrorCode.RateLimited,
      when: 'legislation.gov.uk answered 403 or 429 (its fair use rate limit or a block).',
      recovery:
        'Wait the retryAfter seconds in the error data (five minutes after a block) before calling again; cached searches and documents keep working meanwhile.',
      thrownBy: 'service',
    },
    {
      reason: 'pacer_shed',
      code: JsonRpcErrorCode.RateLimited,
      when: 'The shared request queue cannot start this call within its deadline.',
      recovery:
        'Wait the retryAfter seconds in the error data, then call uklaw_track_changes again.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const endDate = input.end_date ?? input.start_date;
    for (const date of [input.start_date, endDate]) {
      if (!isCalendarDate(date)) {
        throw ctx.fail('invalid_date', `${date} is not a real calendar date.`, {
          ...ctx.recoveryFor('invalid_date'),
        });
      }
    }
    const span = daysBetween(input.start_date, endDate);
    if (span < 0 || span >= MAX_WINDOW_DAYS) {
      throw ctx.fail(
        'invalid_window',
        span < 0
          ? `end_date ${endDate} is before start_date ${input.start_date}.`
          : `The window ${input.start_date} to ${endDate} spans ${span + 1} days; the limit is ${MAX_WINDOW_DAYS}.`,
        { ...ctx.recoveryFor('invalid_window') },
      );
    }
    if (input.direction && input.content_type !== 'changes') {
      throw ctx.fail('direction_needs_changes', 'direction filters changes events only.', {
        ...ctx.recoveryFor('direction_needs_changes'),
      });
    }
    if (
      input.category &&
      input.content_type !== 'legislation' &&
      input.content_type !== 'associated-documents'
    ) {
      throw ctx.fail(
        'category_needs_content_type',
        'category applies only after content_type legislation or associated-documents; elsewhere legislation.gov.uk answers zero events.',
        { ...ctx.recoveryFor('category_needs_content_type') },
      );
    }
    const parsedItem =
      input.item !== undefined ? parseItemInput(input.item, { allowPartial: true }) : undefined;
    if (input.item !== undefined && (!parsedItem || parsedItem.provision)) {
      throw ctx.fail(
        'invalid_item',
        `"${input.item}" is not a legislation item path, type, or type and year.`,
        {
          ...ctx.recoveryFor('invalid_item'),
        },
      );
    }
    const item = parsedItem?.item;
    const mode = item?.full ? 'item_log' : 'day_walk';
    const queryKey = [
      'track',
      mode,
      input.start_date,
      endDate,
      input.content_type ?? '',
      input.direction ?? '',
      input.category ?? '',
      item?.path ?? '',
      input.new_only,
      input.event ?? '',
      input.limit,
    ].join('|');
    const position = input.cursor !== undefined ? decodeCursor(input.cursor, queryKey) : undefined;
    if (input.cursor !== undefined && !position) {
      throw ctx.fail('invalid_cursor', 'cursor does not decode or belongs to a different window.', {
        ...ctx.recoveryFor('invalid_cursor'),
      });
    }

    const service = getLegislationService();
    const outcome = await service.trackChanges(
      {
        startDate: input.start_date,
        endDate,
        ...(input.content_type ? { contentType: input.content_type } : {}),
        ...(input.direction ? { direction: input.direction } : {}),
        ...(input.category ? { category: input.category } : {}),
        ...(item ? { item } : {}),
        newOnly: input.new_only,
        ...(input.event ? { event: input.event } : {}),
        limit: input.limit,
        ...(position ? { position } : {}),
      },
      ctx,
    );

    const nextCursor = outcome.next ? encodeCursor(queryKey, outcome.next) : undefined;
    if (outcome.events.length === 0) {
      const fragments: string[] = [
        outcome.hasMore
          ? 'No events in the part of the window read so far; call again with cursor set to next_cursor to continue.'
          : 'No Publication Log events in this window.',
      ];
      if (input.new_only || input.category || item || input.event) {
        fragments.push(
          'Filters narrow an otherwise busy log: drop new_only, category, event, or item to widen.',
        );
      }
      if (endDate >= service.today()) {
        fragments.push(
          'The window reaches today or later: the log for today fills during the UK working day.',
        );
      }
      if (item) fragments.push('Confirm the item with uklaw_lookup_citation.');
      ctx.enrich.notice(fragments.join(' '));
    } else if (outcome.capped) {
      ctx.enrich.truncated({
        shown: outcome.events.length,
        cap: input.limit,
        guidance: 'More events remain in the window: call again with cursor set to next_cursor.',
      });
    } else if (outcome.hasMore) {
      ctx.enrich.notice(
        "This call's request budget ended before the window did: call again with cursor set to next_cursor.",
      );
    }

    return {
      events: outcome.events,
      window: { start_date: input.start_date, end_date: endDate },
      filters: {
        ...(input.content_type ? { content_type: input.content_type } : {}),
        ...(input.direction ? { direction: input.direction } : {}),
        ...(input.category ? { category: input.category } : {}),
        ...(item ? { item: item.path } : {}),
        new_only: input.new_only,
        ...(input.event ? { event: input.event } : {}),
      },
      mode: outcome.mode,
      days: outcome.days,
      ...(outcome.itemLogTotal !== undefined ? { item_log_total: outcome.itemLogTotal } : {}),
      has_more: outcome.hasMore,
      ...(nextCursor ? { next_cursor: nextCursor } : {}),
      attribution: outcome.attribution,
    };
  },

  format: (result) => {
    const f = result.filters;
    const filters = [
      f.content_type ? `content_type ${f.content_type}` : undefined,
      f.direction ? `direction ${f.direction}` : undefined,
      f.category ? `category ${f.category}` : undefined,
      f.item ? `item \`${f.item}\`` : undefined,
      `new_only ${f.new_only}`,
      f.event ? `event ${f.event}` : undefined,
    ].filter(Boolean);
    const lines = [
      `## Publication Log ${result.window.start_date} to ${result.window.end_date} (${result.mode})`,
      `**Filters:** ${filters.join(' · ')}`,
      `**Events:** ${result.events.length} · has_more: ${result.has_more}${result.next_cursor ? ` · next_cursor: \`${result.next_cursor}\`` : ''}${result.item_log_total !== undefined ? ` · item log total ${result.item_log_total}` : ''}`,
    ];
    if (result.days.length > 0) {
      lines.push(
        `**Days read:** ${result.days.map((d) => `${d.date} (${d.total ?? 'total not reported'} events, ${d.pages_read} page(s))`).join(', ')}`,
      );
    }
    lines.push('');
    for (const e of result.events) {
      const flags = [
        e.new !== undefined ? `new: ${e.new}` : undefined,
        e.newly_issued !== undefined ? `newly issued: ${e.newly_issued}` : undefined,
        e.republished !== undefined ? `republished: ${e.republished}` : undefined,
        e.direction ? `direction ${inline(e.direction)}` : undefined,
        e.format ? `format ${inline(e.format)}` : undefined,
        e.language ? `language ${inline(e.language)}` : undefined,
        e.category ? `category ${inline(e.category)}` : undefined,
      ].filter(Boolean);
      lines.push(
        `- ${inline(e.updated)} · **${inline(e.content_type)} ${inline(e.event)}** · ${inline(e.item.title)}${e.item.title_cy ? ` / ${inline(e.item.title_cy)}` : ''} (\`${uri(e.item.path)}\`, type ${inline(e.type)} · year ${e.year ?? 'not reported'} · number ${inline(e.number ?? 'not reported')})`,
        `  - ${flags.join(' · ') || 'no flags'} · publisher ${inline(e.publisher)}`,
        `  - Resource: ${uri(e.resource_uri)}${e.document_uri ? ` · Document: ${uri(e.document_uri)}` : ''} · Item: ${uri(e.item.id_uri)}`,
      );
    }
    lines.push('', attributionLines(result.attribution));
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
