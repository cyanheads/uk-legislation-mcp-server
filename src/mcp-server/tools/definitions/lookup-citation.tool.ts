/**
 * @fileoverview uklaw_lookup_citation — resolves a citation, legislation.gov.uk
 * URI, or short title (optionally with a provision) to the canonical item and
 * provision. Misses and ambiguity are results, never errors.
 * @module mcp-server/tools/definitions/lookup-citation
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { type ParsedCitation, parseCitation } from '@/services/legislation/citations.js';
import { getLegislationService } from '@/services/legislation/legislation-service.js';
import { attributionLines, cell, inline, uri } from './_markdown.js';
import { AttributionSchema } from './_schemas.js';

function parsedEcho(parsed: ParsedCitation) {
  switch (parsed.kind) {
    case 'numbered':
      return {
        kind: parsed.kind,
        type: parsed.type,
        year: String(parsed.year),
        number: parsed.number,
        ...(parsed.provision ? { provision: parsed.provision } : {}),
      };
    case 'uri':
      return {
        kind: parsed.kind,
        type: parsed.item.type,
        ...(parsed.item.year ? { year: parsed.item.year } : {}),
        ...(parsed.item.number ? { number: parsed.item.number } : {}),
        ...(parsed.provision ? { provision: parsed.provision } : {}),
      };
    case 'title':
      return {
        kind: parsed.kind,
        title: parsed.title,
        ...(parsed.year !== undefined ? { year: String(parsed.year) } : {}),
        ...(parsed.provision ? { provision: parsed.provision } : {}),
      };
    default:
      return { kind: parsed.kind };
  }
}

export const lookupCitationTool = tool('uklaw_lookup_citation', {
  title: 'Resolve a legislation citation',
  description:
    'Resolve a citation or short title to the canonical legislation.gov.uk item and provision: "Data Protection Act 2018 s. 45", "2018 c. 12", "S.I. 2019/419", "S.S.I. 2020/123", "S.R. 2020/12", "2020 asp 13", "Regulation (EU) 2016/679 art. 28", a legislation.gov.uk URI, or a short title. Returns the item path to pass to uklaw_get_document, and when a provision is given, whether it exists in the current version. A miss or an ambiguous title is a result with found false plus guidance or candidates, not an error. To find legislation by topic or by partial title words rather than a known citation, use uklaw_search_legislation.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  auth: ['tool:uklaw_lookup_citation:read'],
  input: z.object({
    citation: z
      .string()
      .min(1)
      .max(300)
      .describe(
        'A citation ("2018 c. 12", "S.I. 2019/419 reg. 5", "Regulation (EU) 2016/679 art. 28"), a short title ("Data Protection Act 2018 s. 45(2)(f)"), or a legislation.gov.uk URI. uklaw_list_reference topic citation_formats lists the accepted forms.',
      ),
  }),
  output: z.object({
    found: z.boolean().describe('True when the citation resolved to exactly one item.'),
    parsed: z
      .object({
        kind: z
          .enum(['numbered', 'title', 'uri', 'unparsed'])
          .describe(
            'How the citation was read: a numbered citation, a short title, a URI, or not readable.',
          ),
        type: z
          .string()
          .optional()
          .describe('Type code the citation maps to, e.g. ukpga, uksi, eur; absent for a title.'),
        year: z
          .string()
          .optional()
          .describe(
            'Year as parsed: a calendar year, or a regnal Monarch/session; absent when none.',
          ),
        number: z.string().optional().describe('Number as parsed; absent for a title.'),
        title: z.string().optional().describe('Short title as parsed; present for kind title.'),
        provision: z
          .string()
          .optional()
          .describe('Provision path as parsed, e.g. section/45/2/f; absent when none was cited.'),
      })
      .describe('The citation as the parser read it.'),
    item: z
      .string()
      .optional()
      .describe(
        'Canonical item path, e.g. ukpga/2018/12 — pass to uklaw_get_document; present when found.',
      ),
    id_uri: z
      .string()
      .optional()
      .describe('Canonical identifier URI of the item; present when found.'),
    document_uri: z
      .string()
      .optional()
      .describe('legislation.gov.uk page for the item; present when found.'),
    title: z
      .string()
      .optional()
      .describe('Item title; absent when it could not be fetched within the call.'),
    title_cy: z.string().optional().describe('Welsh title, for bilingual items.'),
    type: z
      .string()
      .optional()
      .describe(
        'Canonical type code (a Welsh SI cited as uksi comes back as wsi); present when found.',
      ),
    type_label: z.string().optional().describe('Human label of the type; present when found.'),
    year: z
      .number()
      .optional()
      .describe(
        'Calendar year of the item; absent when not known, e.g. a regnal-year item resolved from its path.',
      ),
    number: z.string().optional().describe('Item number within the year; present when found.'),
    made_date: z
      .string()
      .optional()
      .describe('Date enacted or made (YYYY-MM-DD); absent when not fetched or not reported.'),
    provision_path: z
      .string()
      .optional()
      .describe('Provision path the citation named, when it named one and the item was found.'),
    provision_uri: z
      .string()
      .optional()
      .describe('Identifier URI of that provision, alongside provision_path.'),
    provision_found: z
      .boolean()
      .optional()
      .describe(
        'Whether the provision exists in the current version; absent when the check could not run.',
      ),
    candidates: z
      .array(
        z
          .object({
            item: z.string().describe('Candidate item path.'),
            id_uri: z.string().describe('Candidate identifier URI.'),
            title: z.string().describe('Candidate title.'),
          })
          .describe('One candidate item.'),
      )
      .optional()
      .describe('Candidate items (at most 20) when the citation is ambiguous.'),
    guidance: z
      .string()
      .optional()
      .describe('What to do next after a miss, ambiguity, or a check that could not run.'),
    attribution: AttributionSchema,
  }),
  errors: [
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
        'Wait the retryAfter seconds in the error data, then call uklaw_lookup_citation again.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const parsed = parseCitation(input.citation);
    ctx.log.debug('Citation parsed', { kind: parsed.kind });
    const outcome = await getLegislationService().lookupCitation(parsed, ctx);
    return { ...outcome, parsed: parsedEcho(parsed) };
  },

  format: (result) => {
    const p = result.parsed;
    const parsedLine = [
      `kind ${p.kind}`,
      p.type ? `type ${inline(p.type)}` : undefined,
      p.year ? `year ${inline(p.year)}` : undefined,
      p.number ? `number ${inline(p.number)}` : undefined,
      p.title ? `title "${inline(p.title)}"` : undefined,
      p.provision ? `provision ${inline(p.provision)}` : undefined,
    ]
      .filter(Boolean)
      .join(', ');
    const lines = [
      `## Citation ${result.found ? 'found' : 'not resolved'}`,
      `**Found:** ${result.found}`,
      `**Parsed:** ${parsedLine}`,
    ];
    if (result.item) {
      lines.push(
        '',
        `**${inline(result.title ?? result.item)}**${result.title_cy ? ` / ${inline(result.title_cy)}` : ''}`,
        `- Item: \`${uri(result.item)}\``,
        `- Type: ${inline(result.type)} — ${inline(result.type_label)}`,
        `- Year: ${result.year ?? 'unknown'} · Number: ${inline(result.number ?? 'unknown')}${result.made_date ? ` · Made/enacted: ${inline(result.made_date)}` : ''}`,
        `- Identifier: ${uri(result.id_uri ?? '')}`,
        `- Document: ${uri(result.document_uri ?? '')}`,
      );
    }
    if (result.provision_path) {
      lines.push(
        `- Provision: \`${uri(result.provision_path)}\` (${uri(result.provision_uri ?? '')}) — ${
          result.provision_found === undefined
            ? 'not verified'
            : result.provision_found
              ? 'exists in the current version'
              : 'not found in the current version'
        }${result.provision_found !== undefined ? ` (provision_found: ${result.provision_found})` : ''}`,
      );
    }
    if (result.candidates && result.candidates.length > 0) {
      lines.push('', '| Item | Title | Identifier |', '| --- | --- | --- |');
      for (const c of result.candidates)
        lines.push(`| \`${uri(c.item)}\` | ${cell(c.title)} | ${uri(c.id_uri)} |`);
    }
    if (result.guidance) lines.push('', `**Guidance:** ${inline(result.guidance)}`);
    lines.push('', attributionLines(result.attribution));
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
