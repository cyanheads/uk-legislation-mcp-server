/**
 * @fileoverview uklaw_get_amendments — effects (amendments, repeals,
 * commencements, modifications) recorded against an item or made by it, from
 * the changes feeds, filterable by counterpart item, applied status, and
 * provision.
 * @module mcp-server/tools/definitions/get-amendments
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { decodeCursor, encodeCursor } from '@/services/legislation/cursor.js';
import { getLegislationService } from '@/services/legislation/legislation-service.js';
import { normalizeProvision, parseItemInput } from '@/services/legislation/provision-path.js';
import { attributionLines, renderEffect } from './_markdown.js';
import {
  AttributionSchema,
  blankAsUnset,
  CursorInput,
  EffectRecordSchema,
  ItemInput,
  ProvisionInput,
} from './_schemas.js';

export const getAmendmentsTool = tool('uklaw_get_amendments', {
  title: 'List amendments to or by legislation',
  description:
    "List the effects — amendments, repeals, revocations, commencements, modifications — recorded against an item (direction affected) or made by an item (direction affecting), from legislation.gov.uk's changes feeds. Filter by the other item (counterpart), by applied status (unapplied = the outstanding work on the revised text), and by provision. item may be partial (ukpga/2018 = all effects on 2018 Acts). Each effect names both sides with provision links, in-force dates, and why it is not applied. For the applied history of one provision in prose, read its annotations with uklaw_get_document.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  auth: ['tool:uklaw_get_amendments:read'],
  input: z.object({
    item: ItemInput.describe(
      'Item path or legislation.gov.uk URI (ukpga/2018/12), or a partial path: a type (uksi) or type and year (ukpga/2018). Get a full path from uklaw_lookup_citation or uklaw_search_legislation.',
    ),
    direction: blankAsUnset(z.enum(['affected', 'affecting']).default('affected')).describe(
      'affected: changes made to item. affecting: changes item makes to other legislation.',
    ),
    counterpart: blankAsUnset(ItemInput.optional()).describe(
      'Restrict to effects involving this other item (full or partial path, e.g. uksi/2019/419 or uksi/2026) — the amending item for direction affected, the amended item for affecting.',
    ),
    status: blankAsUnset(z.enum(['all', 'unapplied', 'applied']).default('all')).describe(
      'unapplied: effects not yet applied to the revised text; applied: already applied; all: both.',
    ),
    provision: blankAsUnset(ProvisionInput.optional()).describe(
      'Keep only effects touching this provision of item (path or shorthand, e.g. section/45 or s. 45), including effects on the whole item. Needs a full item path. legislation.gov.uk cannot filter by provision, so each call scans up to 1,500 effects; continue with next_cursor.',
    ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(50)
      .describe('Effects per page, or with provision the most matches returned (1–100).'),
    cursor: blankAsUnset(CursorInput.optional()).describe(
      'next_cursor from the previous call, passed with the other inputs unchanged; omit for the first page.',
    ),
  }),
  output: z.object({
    effects: z
      .array(EffectRecordSchema)
      .describe('Effects on this page, most recently modified first; empty when none matched.'),
    query: z
      .object({
        item: z.string().describe('Item path queried.'),
        direction: z.string().describe('Direction queried: affected or affecting.'),
        counterpart: z
          .string()
          .optional()
          .describe('Counterpart item path; present only when counterpart was given.'),
        status: z.string().describe('Applied-status filter: all, unapplied, or applied.'),
        provision: z
          .string()
          .optional()
          .describe('Provision path filtered on; present only when provision was given.'),
      })
      .describe('The query as normalized.'),
    total: z
      .number()
      .describe(
        'Total effects legislation.gov.uk holds for this query (before any provision filter).',
      ),
    has_more: z.boolean().describe('True when more effects remain — call again with next_cursor.'),
    next_cursor: z
      .string()
      .optional()
      .describe('Pass as cursor to continue; present only when has_more is true.'),
    scan: z
      .object({
        effects_scanned: z.number().describe('Effects examined by this call.'),
        pages_scanned: z.number().describe('Pages of 500 effects read by this call.'),
        total_effects: z
          .number()
          .describe('Effects legislation.gov.uk holds for the item before the provision filter.'),
      })
      .optional()
      .describe('Coverage of this call; present only when filtering by provision.'),
    attribution: AttributionSchema,
  }),
  enrichment: {
    notice: z.string().optional().describe('Guidance when nothing matched or the list continues.'),
    truncated: z.boolean().optional().describe('True when the list was capped at limit.'),
    shown: z.number().optional().describe('Effects returned.'),
    cap: z.number().optional().describe('The limit applied.'),
  },
  errors: [
    {
      reason: 'invalid_item',
      code: JsonRpcErrorCode.ValidationError,
      severity: 'notice',
      when: 'item or counterpart is not a (partial) item path or legislation.gov.uk URI, or its type code is unknown.',
      recovery:
        'Pass an item path such as ukpga/2018/12, or a type and year such as uksi/2026; uklaw_list_reference topic types lists the codes.',
    },
    {
      reason: 'invalid_provision',
      code: JsonRpcErrorCode.ValidationError,
      severity: 'notice',
      when: 'provision cannot be normalized.',
      recovery:
        'Pass a provision path such as section/45 or schedule/2/paragraph/3; uklaw_list_reference topic provision_paths lists the forms.',
    },
    {
      reason: 'provision_needs_full_item',
      code: JsonRpcErrorCode.ValidationError,
      severity: 'notice',
      when: 'provision is combined with a partial item.',
      recovery:
        'Pass the full item path (type/year/number) together with provision, or drop provision to list effects for the whole range.',
    },
    {
      reason: 'invalid_cursor',
      code: JsonRpcErrorCode.ValidationError,
      severity: 'notice',
      when: 'cursor does not decode or belongs to a different query.',
      recovery: 'Call uklaw_get_amendments again without cursor to start from the first page.',
    },
    {
      reason: 'filter_refused',
      code: JsonRpcErrorCode.ValidationError,
      severity: 'warning',
      when: 'legislation.gov.uk answered the changes feed with 404 or 400: a path or filter combination it does not accept.',
      recovery:
        'Check item and counterpart with uklaw_lookup_citation, then retry with a shorter counterpart path (type or type and year) or without counterpart.',
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
        'Wait the retryAfter seconds in the error data, then call uklaw_get_amendments again.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const parsed = parseItemInput(input.item, { allowPartial: true });
    if (!parsed) {
      throw ctx.fail(
        'invalid_item',
        `"${input.item}" is not a legislation item path or legislation.gov.uk URI.`,
        {
          ...ctx.recoveryFor('invalid_item'),
        },
      );
    }
    const counterpart =
      input.counterpart !== undefined
        ? parseItemInput(input.counterpart, { allowPartial: true })
        : undefined;
    if (input.counterpart !== undefined && !counterpart) {
      throw ctx.fail(
        'invalid_item',
        `counterpart "${input.counterpart}" is not a legislation item path or URI.`,
        {
          ...ctx.recoveryFor('invalid_item'),
        },
      );
    }
    let provision = parsed.provision;
    if (input.provision !== undefined) {
      const normalized = normalizeProvision(input.provision);
      if (!normalized) {
        throw ctx.fail(
          'invalid_provision',
          `"${input.provision}" is not a provision path or citation shorthand.`,
          {
            ...ctx.recoveryFor('invalid_provision'),
          },
        );
      }
      provision = normalized;
    }
    if (provision && !parsed.item.full) {
      throw ctx.fail(
        'provision_needs_full_item',
        `provision needs a full item path; "${parsed.item.path}" is partial.`,
        {
          ...ctx.recoveryFor('provision_needs_full_item'),
        },
      );
    }
    const queryKey = [
      'amendments',
      parsed.item.path,
      input.direction,
      counterpart?.item.path ?? '',
      input.status,
      provision ?? '',
      provision ? '' : input.limit,
    ].join('|');
    const position =
      input.cursor !== undefined ? decodeCursor(input.cursor, queryKey) : { page: 1, offset: 0 };
    if (!position) {
      throw ctx.fail('invalid_cursor', 'cursor does not decode or belongs to a different query.', {
        ...ctx.recoveryFor('invalid_cursor'),
      });
    }

    const outcome = await getLegislationService().getAmendments(
      {
        item: parsed.item,
        direction: input.direction,
        ...(counterpart ? { counterpart: counterpart.item.path } : {}),
        status: input.status,
        ...(provision ? { provision } : {}),
        limit: input.limit,
        position,
      },
      ctx,
    );

    const nextCursor = outcome.next ? encodeCursor(queryKey, outcome.next) : undefined;
    if (outcome.effects.length === 0) {
      const fragments: string[] = ['No effects matched.'];
      if (outcome.total === 0) {
        fragments.push(
          'The changes feed returns an empty list for an item that does not exist as readily as for one with no recorded effects; confirm the item with uklaw_lookup_citation.',
        );
      }
      fragments.push(
        'Effects are normally recorded only from amending legislation of 1994 onwards; uklaw_list_reference topic coverage has the details.',
      );
      if (input.status !== 'all') fragments.push('Retry with status "all".');
      if (provision && outcome.scan) {
        fragments.push(
          outcome.hasMore
            ? `Only the first ${outcome.scan.effects_scanned} of ${outcome.scan.total_effects} effects were scanned; call again with cursor to continue, or read the provision's applied history in the annotations of uklaw_get_document.`
            : `No effect references this provision by URI. An effect on a heading names the enclosing cross-heading or Part instead of the section (e.g. "s. 65 heading" names part/3/chapter/4/crossheading/general-obligations): read the enclosing Part with uklaw_get_document (its item-level outline lists the Parts), or pass the Part's path as provision to uklaw_get_amendments. The provision's applied history is in its annotations in uklaw_get_document.`,
        );
      }
      ctx.enrich.notice(fragments.join(' '));
    } else if (outcome.capped) {
      ctx.enrich.truncated({
        shown: outcome.effects.length,
        cap: input.limit,
        guidance: 'More effects remain: call again with cursor set to next_cursor.',
      });
    } else if (outcome.stoppedEarly && outcome.scan) {
      ctx.enrich.notice(
        `Scanned ${outcome.scan.effects_scanned} of ${outcome.scan.total_effects} effects this call; call again with cursor set to next_cursor to scan further.`,
      );
    }

    return {
      effects: outcome.effects,
      query: {
        item: parsed.item.path,
        direction: input.direction,
        ...(counterpart ? { counterpart: counterpart.item.path } : {}),
        status: input.status,
        ...(provision ? { provision } : {}),
      },
      total: outcome.total,
      has_more: outcome.hasMore,
      ...(nextCursor ? { next_cursor: nextCursor } : {}),
      ...(outcome.scan ? { scan: outcome.scan } : {}),
      attribution: outcome.attribution,
    };
  },

  format: (result) => {
    const q = result.query;
    const lines = [
      `## Effects ${q.direction === 'affected' ? 'on' : 'made by'} \`${q.item}\``,
      `**Query:** direction ${q.direction} · status ${q.status}${q.counterpart ? ` · counterpart \`${q.counterpart}\`` : ''}${q.provision ? ` · provision \`${q.provision}\`` : ''}`,
      `**Total:** ${result.total} · shown ${result.effects.length} · has_more: ${result.has_more}${result.next_cursor ? ` · next_cursor: \`${result.next_cursor}\`` : ''}`,
    ];
    if (result.scan) {
      lines.push(
        `**Scan:** ${result.scan.effects_scanned} effects scanned over ${result.scan.pages_scanned} page(s) of ${result.scan.total_effects} total`,
      );
    }
    lines.push('');
    for (const e of result.effects) lines.push(renderEffect(e));
    lines.push('', attributionLines(result.attribution));
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
