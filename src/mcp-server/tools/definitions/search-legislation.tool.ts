/**
 * @fileoverview uklaw_search_legislation — full-text and title search, and
 * type/year listings, over the UK statute book with type, year, extent, and
 * point-in-time filters.
 * @module mcp-server/tools/definitions/search-legislation
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { MAX_PAGE } from '@/services/legislation/cursor.js';
import { getLegislationService } from '@/services/legislation/legislation-service.js';
import { isCalendarDate } from '@/services/legislation/provision-path.js';
import { EXTENTS, TYPE_CODES, TYPE_GROUPS } from '@/services/legislation/reference-data.js';
import { attributionLines, blockquote, cell, inline, uri } from './_markdown.js';
import { AttributionSchema, blankAsUnset, DateInput, TextInput } from './_schemas.js';

const TYPE_VALUES = [...TYPE_GROUPS, ...TYPE_CODES] as [string, ...string[]];
const YEAR = z.number().int().min(1267).max(2100);

export const searchLegislationTool = tool('uklaw_search_legislation', {
  title: 'Search UK legislation',
  description:
    'Search the UK statute book on legislation.gov.uk by full text or title, or list legislation by type and year, filtered by geographical extent and point in time. Full-text search ranks by relevance; title searches and type/year listings run newest year first and carry type and year counts (facets) to narrow with. Each result gives the item path to pass to uklaw_get_document. For a known citation or short title, uklaw_lookup_citation is cheaper and exact.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  auth: ['tool:uklaw_search_legislation:read'],
  input: z.object({
    text: blankAsUnset(TextInput.max(500).optional()).describe(
      'Full-text query. Supports AND/OR, "quoted phrases", and stemming. Omit for a title search or a listing.',
    ),
    title: blankAsUnset(TextInput.max(300).optional()).describe(
      'Words that must all occur in the title. For a known short title or citation, uklaw_lookup_citation is exact.',
    ),
    types: z
      .array(z.enum(TYPE_VALUES))
      .max(TYPE_VALUES.length)
      .default(['all'])
      .describe(
        'Type codes (ukpga, uksi, asp, eur, …) and/or groups (all, primary, secondary, eu-origin, draft). "all" covers UK and EU-origin legislation, excluding drafts, and absorbs any other value. uklaw_list_reference topic types lists the codes.',
      ),
    year: YEAR.optional().describe(
      'Calendar year (also for pre-1963 Acts numbered by regnal year). Not combinable with year_from/year_to.',
    ),
    year_from: YEAR.optional().describe(
      'Earliest calendar year of a range; the other bound may be omitted.',
    ),
    year_to: YEAR.optional().describe(
      'Latest calendar year of a range; the other bound may be omitted.',
    ),
    extent: z
      .array(z.enum(EXTENTS))
      .max(EXTENTS.length)
      .optional()
      .describe(
        'Geographical extent: england, wales, scotland, ni. An item matches when one of its provisions extends there. Cannot combine with as_of. legislation.gov.uk has not recorded provision-level extent for many recent items, so an empty result does not prove nothing extends there.',
      ),
    extent_match: blankAsUnset(z.enum(['applicable', 'exact']).default('applicable')).describe(
      'Used only with extent. applicable: a provision extends to any given extent; exact: a provision extends to exactly that set.',
    ),
    as_of: blankAsUnset(DateInput.optional()).describe(
      'Point in time YYYY-MM-DD: only legislation as it stood on that date (items not yet enacted or made are excluded). Omit for current law. Cannot combine with extent.',
    ),
    limit: z.number().int().min(1).max(50).default(20).describe('Results per page (1–50).'),
    page: z
      .number()
      .int()
      .min(1)
      .max(MAX_PAGE)
      .default(1)
      .describe(`Page number (1–${MAX_PAGE.toLocaleString('en-GB')}).`),
  }),
  output: z.object({
    results: z
      .array(
        z
          .object({
            item: z
              .string()
              .describe('Item path to pass to uklaw_get_document, e.g. ukpga/2018/12.'),
            id_uri: z.string().describe('Canonical identifier URI.'),
            title: z.string().describe('Title (English).'),
            title_cy: z.string().optional().describe('Welsh title, for bilingual items.'),
            type: z.string().describe('Type code.'),
            type_label: z.string().describe('Human label of the type.'),
            year: z
              .number()
              .optional()
              .describe('Calendar year; absent when legislation.gov.uk does not report it.'),
            number: z.string().optional().describe('Number within the year (an ISBN for drafts).'),
            alternative_numbers: z
              .array(
                z
                  .object({
                    series: z
                      .string()
                      .describe(
                        'Series letter: W. (Wales), C. (commencement), S. (Scotland), L. (legal), NI.',
                      ),
                    value: z.string().describe('Number in that series.'),
                  })
                  .describe('An alternative number.'),
              )
              .describe('Alternative series numbers, e.g. W. 89 for a Welsh SI; empty when none.'),
            made_date: z
              .string()
              .optional()
              .describe('Date enacted or made (YYYY-MM-DD); absent when not reported.'),
            summary: z
              .string()
              .optional()
              .describe('Summary or long title; absent when legislation.gov.uk gives none.'),
            subjects: z
              .array(z.string())
              .describe('Subject headings legislation.gov.uk assigns; empty when none.'),
            updated: z
              .string()
              .optional()
              .describe('When legislation.gov.uk last updated the item; absent when not reported.'),
            document_uri: z
              .string()
              .optional()
              .describe(
                'Version-specific document URI legislation.gov.uk links for the entry; absent when none is linked.',
              ),
          })
          .describe('One result.'),
      )
      .describe('Matching items on this page.'),
    page: z.number().describe('Page returned.'),
    limit: z.number().describe('Page size applied.'),
    has_more: z.boolean().describe('True when a further page exists (call again with page + 1).'),
    facets: z
      .object({
        types: z
          .array(
            z
              .object({
                type: z.string().describe('Type code.'),
                label: z.string().describe('Type label.'),
                count: z.number().describe('Matching items of this type.'),
              })
              .describe('One type count.'),
          )
          .describe('Matching items per type.'),
        years: z
          .array(
            z
              .object({
                year: z.number().describe('Calendar year.'),
                count: z.number().describe('Matching items in that year.'),
              })
              .describe('One year count.'),
          )
          .describe(
            'Matching items per year, newest 25 years; a year filter is left out of these counts so neighbouring years show.',
          ),
        years_omitted: z.number().describe('Further years with matches beyond the 25 listed.'),
      })
      .optional()
      .describe(
        'Type and year counts — title searches and listings only; absent on full-text searches and on a page past the last page.',
      ),
    scope: z
      .object({
        types: z.array(z.string()).describe('Types searched, after reducing "all".'),
        as_of: z.string().describe('Point in time searched: "current" or a date.'),
        extent: z
          .array(z.string())
          .optional()
          .describe('Extents filtered on; present only when extent was given.'),
        extent_match: z
          .string()
          .optional()
          .describe('Extent matching applied; present only when extent was given.'),
      })
      .describe('The scope applied, defaults included.'),
    attribution: AttributionSchema,
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe('Guidance when nothing matched, or how to fetch the next page.'),
    total: z
      .number()
      .optional()
      .describe(
        'Total matches; present only when legislation.gov.uk reports it (often absent on large result sets).',
      ),
    truncated: z.boolean().optional().describe('True when more results exist beyond this page.'),
    shown: z.number().optional().describe('Results on this page.'),
    cap: z.number().optional().describe('Page size that capped the list.'),
  },
  errors: [
    {
      reason: 'invalid_date',
      code: JsonRpcErrorCode.ValidationError,
      severity: 'notice',
      when: 'as_of is shaped YYYY-MM-DD but is not a real calendar date.',
      recovery:
        'Pass as_of as a calendar date such as 2020-01-31, or omit it to search current law.',
    },
    {
      reason: 'extent_with_as_of',
      code: JsonRpcErrorCode.ValidationError,
      severity: 'notice',
      when: 'Both extent and as_of are set.',
      recovery:
        'Search with either extent or as_of, not both; run a second search for the other filter.',
    },
    {
      reason: 'invalid_year_range',
      code: JsonRpcErrorCode.ValidationError,
      severity: 'notice',
      when: 'year is combined with a range, or year_from is after year_to.',
      recovery: 'Pass a single year, or year_from and year_to with year_from not after year_to.',
    },
    {
      reason: 'filter_refused',
      code: JsonRpcErrorCode.ValidationError,
      severity: 'warning',
      when: 'legislation.gov.uk answered the search feed with 404 or 400: a filter combination it does not accept.',
      recovery:
        'Drop one filter at a time (extent, as_of, year, types) and search again, running a second search for the filter removed.',
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
        'Wait the retryAfter seconds in the error data, then call uklaw_search_legislation again.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    if (
      input.year !== undefined &&
      (input.year_from !== undefined || input.year_to !== undefined)
    ) {
      throw ctx.fail(
        'invalid_year_range',
        'year cannot be combined with year_from or year_to.',
        ctx.recoveryFor('invalid_year_range'),
      );
    }
    if (
      input.year_from !== undefined &&
      input.year_to !== undefined &&
      input.year_from > input.year_to
    ) {
      throw ctx.fail(
        'invalid_year_range',
        `year_from ${input.year_from} is after year_to ${input.year_to}.`,
        ctx.recoveryFor('invalid_year_range'),
      );
    }
    if (input.as_of !== undefined && !isCalendarDate(input.as_of)) {
      throw ctx.fail(
        'invalid_date',
        `as_of ${input.as_of} is not a real calendar date.`,
        ctx.recoveryFor('invalid_date'),
      );
    }
    const extent = input.extent && input.extent.length > 0 ? [...new Set(input.extent)] : undefined;
    if (extent && input.as_of) {
      throw ctx.fail(
        'extent_with_as_of',
        'extent and as_of cannot be combined — legislation.gov.uk refuses the combination.',
        ctx.recoveryFor('extent_with_as_of'),
      );
    }
    const types =
      input.types.length === 0 || input.types.includes('all') ? ['all'] : [...new Set(input.types)];

    const outcome = await getLegislationService().search(
      {
        types,
        ...(input.year !== undefined ? { year: input.year } : {}),
        ...(input.year_from !== undefined ? { yearFrom: input.year_from } : {}),
        ...(input.year_to !== undefined ? { yearTo: input.year_to } : {}),
        ...(extent ? { extent } : {}),
        extentMatch: input.extent_match,
        ...(input.as_of ? { asOf: input.as_of } : {}),
        ...(input.title ? { title: input.title } : {}),
        ...(input.text ? { text: input.text } : {}),
        limit: input.limit,
        page: input.page,
      },
      ctx,
    );

    if (outcome.total !== undefined) ctx.enrich({ total: outcome.total });
    /** Only a query reported as matching nothing gets filter advice; any other empty later page is past the end. */
    if (outcome.results.length === 0 && input.page > 1 && outcome.total !== 0) {
      ctx.enrich.notice(
        `Page ${input.page} is past the last page of results; call again with page 1 or a lower page.`,
      );
    } else if (outcome.results.length === 0) {
      const fragments: string[] = ['No legislation matched.'];
      if (input.title) {
        fragments.push(
          'Title search needs every word in the title; for a known short title or citation call uklaw_lookup_citation.',
        );
      }
      if (input.text && (/"/.test(input.text) || input.text.trim().split(/\s+/).length > 1)) {
        fragments.push(
          'Full-text search matched nothing for the whole query; drop the quotes or some terms.',
        );
      }
      if (types[0] !== 'all')
        fragments.push('Widen types ("all" includes EU-origin law such as the UK GDPR).');
      if (extent) {
        fragments.push(
          'Extent matching depends on provision-level extent data that legislation.gov.uk has not recorded for many recent items; retry without extent.',
        );
      }
      if (input.as_of)
        fragments.push(
          'as_of limits results to legislation as it stood on that date; drop it to search current law.',
        );
      ctx.enrich.notice(fragments.join(' '));
    } else if (outcome.hasMore) {
      ctx.enrich.truncated({
        shown: outcome.results.length,
        cap: input.limit,
        guidance: `More results exist: call again with page ${input.page + 1}.`,
      });
    }

    return {
      results: outcome.results,
      page: input.page,
      limit: input.limit,
      has_more: outcome.hasMore,
      ...(outcome.facets ? { facets: outcome.facets } : {}),
      scope: {
        types,
        as_of: input.as_of ?? 'current',
        ...(extent ? { extent, extent_match: input.extent_match } : {}),
      },
      attribution: outcome.attribution,
    };
  },

  format: (result) => {
    const scope = result.scope;
    const lines = [
      `## Search results — page ${result.page} (limit ${result.limit}, has_more: ${result.has_more})`,
      `**Scope:** types ${scope.types.join(', ')} · as_of ${scope.as_of}${scope.extent ? ` · extent ${scope.extent.join('+')} (${scope.extent_match ?? 'applicable'})` : ''}`,
    ];
    for (const r of result.results) {
      lines.push(
        '',
        `### ${inline(r.title)}${r.title_cy ? ` / ${inline(r.title_cy)}` : ''}`,
        `- Item: \`${uri(r.item)}\` · ${inline(r.type)} (${inline(r.type_label)}) · year ${r.year ?? 'unknown'} · number ${inline(r.number ?? 'unknown')}`,
        `- Identifier: ${uri(r.id_uri)}${r.document_uri ? ` · Document: ${uri(r.document_uri)}` : ''}`,
      );
      const facts = [
        r.made_date ? `Made/enacted: ${inline(r.made_date)}` : undefined,
        r.updated ? `Updated: ${inline(r.updated)}` : undefined,
        r.alternative_numbers.length > 0
          ? `Alternative numbers: ${r.alternative_numbers.map((n) => `${inline(n.series)} ${inline(n.value)}`).join(', ')}`
          : undefined,
        r.subjects.length > 0 ? `Subjects: ${r.subjects.map(inline).join('; ')}` : undefined,
      ].filter(Boolean);
      if (facts.length > 0) lines.push(`- ${facts.join(' · ')}`);
      if (r.summary) lines.push(blockquote(r.summary));
    }
    if (result.facets) {
      lines.push('', '**Facets — types:**', '', '| Type | Label | Count |', '| --- | --- | --- |');
      for (const f of result.facets.types)
        lines.push(`| ${cell(f.type)} | ${cell(f.label)} | ${f.count} |`);
      lines.push(
        '',
        `**Facets — years** (${result.facets.years_omitted} further years omitted): ${
          result.facets.years.map((y) => `${y.year} (${y.count})`).join(', ') || 'none'
        }`,
      );
    }
    lines.push('', attributionLines(result.attribution));
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
