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
import {
  getLegislationService,
  SCAN_PAGE_SIZE,
} from '@/services/legislation/legislation-service.js';
import { normalizeProvision, parseItemInput } from '@/services/legislation/provision-path.js';
import { codesIn } from '@/services/legislation/reference-data.js';
import type { ItemPath } from '@/services/legislation/types.js';
import { attributionLines, renderEffect } from './_markdown.js';
import {
  AttributionSchema,
  blankAsUnset,
  CursorInput,
  EffectRecordSchema,
  ItemInput,
  ProvisionInput,
} from './_schemas.js';

/** Where a provision scan's misses usually are: effects that name the enclosing heading (Design Decision 49). */
const HEADING_ROUTE = `An effect on a heading names the enclosing cross-heading or Part instead of the section (e.g. "s. 65 heading" names part/3/chapter/4/crossheading/general-obligations): read the enclosing Part with uklaw_get_document (its item-level outline lists the Parts), or pass the Part's path as provision to uklaw_get_amendments. The provision's applied history is in its annotations in uklaw_get_document.`;

/** Draft type codes, numbered by ISBN: the changes feeds index none of them (Design Decision 66). */
const DRAFT_TYPES = codesIn('draft');

const DRAFTS_UNINDEXED =
  "legislation.gov.uk's changes feeds do not index drafts: a draft is not amended, and amends nothing, until it is made.";

const PRE_1994 =
  'Effects are normally recorded only from amending legislation of 1994 onwards (uklaw_list_reference topic coverage), so the changes feeds hold few or none made by a pre-1963 Act.';

/**
 * Message and recovery for a regnal item or counterpart (Design Decision 64).
 * An item on the affected side is indexed under its calendar year. On the
 * affecting side the feeds hold effects made from 1994 on, so a pre-1963 Act
 * there is reached through the other item's feed. A counterpart is dropped and
 * filtered by its effect side.
 */
function regnalRefusal(
  field: 'item' | 'counterpart',
  item: ItemPath,
  side: 'affected' | 'affecting',
  provision?: string,
): { hint: string; message: string } {
  const message = `${field} "${item.path}" addresses ${item.full ? 'a pre-1963 Act' : 'the Acts of a pre-1963 session'} by regnal year; legislation.gov.uk's changes feeds index effects by calendar year and chapter number, so they cannot be queried by this path.`;
  const keep = `keep the effects whose ${side}.item ${item.full ? `is ${item.path}` : `starts with ${item.path}/`}`;
  if (field === 'counterpart') {
    const route = `Call again without counterpart and ${keep}.`;
    return { message, hint: side === 'affecting' ? `${PRE_1994} ${route}` : route };
  }
  if (side === 'affecting') {
    return {
      message,
      hint: `${PRE_1994} To see what ${item.path} changed, call uklaw_get_amendments on the amended item (direction affected) and ${keep}, or read that item's annotations with uklaw_get_document.`,
    };
  }
  const route = item.full
    ? `Call uklaw_get_amendments with item ${item.type}/YYYY/${item.number}, where YYYY is the calendar year uklaw_get_document reports as item.year for ${item.path}, and ${keep}: two sessions sitting in one calendar year can share a chapter number.`
    : `Call uklaw_get_amendments with item ${item.type}/YYYY for each calendar year the session ${item.path} sat in (uklaw_get_document reports item.year for any Act of it), and ${keep}.`;
  const hint = provision
    ? `${route} Leave provision out: effects give ${provision} as a URI under the regnal path, which the provision filter cannot match on the calendar path; look for it in each effect's ${side}.provisions.`
    : route;
  return { message, hint };
}

export const getAmendmentsTool = tool('uklaw_get_amendments', {
  title: 'List amendments to or by legislation',
  description:
    "List the effects — amendments, repeals, revocations, commencements, modifications — recorded against an item (direction affected) or made by an item (direction affecting), from legislation.gov.uk's changes feeds. Filter by the other item (counterpart), by applied status (unapplied = the outstanding work on the revised text), and by provision. item may be partial (ukpga/2018 = all effects on 2018 Acts). Each effect names both sides with provision links, in-force dates, and why it is not applied. For the applied history of one provision in prose, read its annotations with uklaw_get_document.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  auth: ['tool:uklaw_get_amendments:read'],
  input: z.object({
    item: ItemInput.describe(
      `Item path or legislation.gov.uk URI (ukpga/2018/12), or a partial path: a type (uksi) or type and year (ukpga/2018). Get a full path from uklaw_lookup_citation or uklaw_search_legislation. A pre-1963 Act takes its calendar year (ukpga/1925/20, not ukpga/Geo5/15-16/20); its effects name the regnal path, and two sessions in one year can share a number. Drafts (${DRAFT_TYPES.join(', ')}) are not in the changes feeds.`,
    ),
    direction: blankAsUnset(z.enum(['affected', 'affecting']).default('affected')).describe(
      'affected: changes made to item. affecting: changes item makes to other legislation.',
    ),
    counterpart: blankAsUnset(ItemInput.optional()).describe(
      'Restrict to effects involving this other item (full or partial item path, without a provision, e.g. uksi/2019/419 or uksi/2026) — the amending item for direction affected, the amended item for affecting. A pre-1963 Act takes its calendar year, not its regnal path; drafts are not in the changes feeds.',
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
      .default(20)
      .describe(
        'Effects per page, or with provision the most matches returned (1–100, default 20).',
      ),
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
      when: 'item or counterpart is not a (partial) item path or legislation.gov.uk URI, or its type code is unknown, or counterpart carries a provision.',
      recovery:
        'Pass an item path such as ukpga/2018/12, or a type and year such as uksi/2026; uklaw_list_reference topic types lists the codes.',
    },
    {
      reason: 'regnal_item',
      code: JsonRpcErrorCode.ValidationError,
      severity: 'notice',
      when: 'item or counterpart is a pre-1963 regnal path (ukpga/Geo5/15-16/20, aep/Ann/6): the changes feeds index effects by calendar year and chapter number only.',
      recovery:
        'Query the Act by its calendar-year path (ukpga/1925/20 for ukpga/Geo5/15-16/20; uklaw_get_document reports item.year) and keep the effects that name the regnal item.',
    },
    {
      reason: 'draft_item',
      code: JsonRpcErrorCode.ValidationError,
      severity: 'notice',
      when: `item or counterpart is draft legislation (${DRAFT_TYPES.join(', ')}), which the changes feeds do not index.`,
      recovery:
        "Once made, an instrument is published under its own path with a calendar year and number: find it by title with uklaw_search_legislation (types secondary) and pass that path as item. uklaw_get_document reads a draft's own text.",
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
      when: 'cursor does not decode, belongs to a different query, or holds a position no call over that query reaches (a page past 10,000, or an offset past the end of its page).',
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
      );
    }
    const counterpartSide = input.direction === 'affected' ? 'affecting' : 'affected';
    if (counterpart?.provision) {
      throw ctx.fail(
        'invalid_item',
        `counterpart "${input.counterpart}" names a provision (${counterpart.provision}); counterpart takes an item path, and legislation.gov.uk cannot filter effects by the counterpart's provision.`,
        {
          recovery: {
            hint: `Pass counterpart "${counterpart.item.path}" and read the counterpart's provisions in each effect's ${counterpartSide}.provisions; provision filters on item's side only.`,
          },
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
        );
      }
      provision = normalized;
    }
    if (parsed.item.regnal) {
      const { message, hint } = regnalRefusal('item', parsed.item, input.direction, provision);
      throw ctx.fail('regnal_item', message, { recovery: { hint } });
    }
    if (DRAFT_TYPES.includes(parsed.item.type)) {
      throw ctx.fail(
        'draft_item',
        `item "${parsed.item.path}" is draft legislation; ${DRAFTS_UNINDEXED}`,
      );
    }
    if (counterpart?.item.regnal) {
      const { message, hint } = regnalRefusal('counterpart', counterpart.item, counterpartSide);
      throw ctx.fail('regnal_item', message, { recovery: { hint } });
    }
    if (counterpart && DRAFT_TYPES.includes(counterpart.item.type)) {
      throw ctx.fail(
        'draft_item',
        `counterpart "${counterpart.item.path}" is draft legislation; ${DRAFTS_UNINDEXED}`,
        {
          recovery: {
            hint: 'Call again without counterpart, or once the instrument is made pass its own path as counterpart: find it by title with uklaw_search_legislation (types secondary).',
          },
        },
      );
    }
    if (provision && !parsed.item.full) {
      throw ctx.fail(
        'provision_needs_full_item',
        `provision needs a full item path; "${parsed.item.path}" is partial.`,
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
    // A scan resumes inside a 500-effect page; a plain page reads `limit` effects (Design Decision 75).
    const position =
      input.cursor !== undefined
        ? decodeCursor(input.cursor, queryKey, {
            pageSize: provision ? SCAN_PAGE_SIZE : input.limit,
          })
        : { page: 1, offset: 0 };
    if (!position) {
      throw ctx.fail(
        'invalid_cursor',
        'cursor does not decode, belongs to a different query, or holds a position no call over this query reaches.',
      );
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
    if (outcome.effects.length === 0 && input.cursor !== undefined && outcome.scan) {
      ctx.enrich.notice(
        outcome.hasMore
          ? `No further matches in the ${outcome.scan.effects_scanned} effects scanned this call; call again with cursor set to next_cursor to scan further.`
          : `No further matches: this call scanned the last ${outcome.scan.effects_scanned} of ${outcome.scan.total_effects} effects, so the scan is complete. If earlier pages returned no match either, no effect references this provision by URI. ${HEADING_ROUTE}`,
      );
    } else if (outcome.effects.length === 0) {
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
            : `No effect references this provision by URI. ${HEADING_ROUTE}`,
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
