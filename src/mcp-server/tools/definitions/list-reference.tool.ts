/**
 * @fileoverview uklaw_list_reference — decodes the vocabulary the other tools
 * take and return. Offline; spends no upstream request.
 * @module mcp-server/tools/definitions/list-reference
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { REFERENCE_TOPICS, referenceEntries } from '@/services/legislation/reference-data.js';
import { cell } from './_markdown.js';

export const listReferenceTool = tool('uklaw_list_reference', {
  title: 'List legislation reference vocabulary',
  description:
    'Decode the vocabulary the other uklaw_* tools take and return: legislation type codes (ukpga, uksi, eur, …) with their labels, categories and enacted keywords; type groups; extents; version keywords; document status; annotation letters (F, C, I, M, E, P, X); effect record fields; provision path forms and shorthand; accepted citation formats; Publication Log vocabulary and read modes; data coverage; and the attribution lines. Offline — no request to legislation.gov.uk.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  auth: ['tool:uklaw_list_reference:read'],
  input: z.object({
    topic: z
      .enum(REFERENCE_TOPICS)
      .describe(
        'Which table to return: types, type_groups, extents, versions, document_status, annotation_types, effects, provision_paths, citation_formats, publication_log, coverage, or attribution.',
      ),
  }),
  output: z.object({
    topic: z.enum(REFERENCE_TOPICS).describe('The topic returned.'),
    entries: z
      .array(
        z
          .object({
            key: z.string().describe('The code, keyword, or form this entry decodes.'),
            label: z.string().describe('Short human name.'),
            description: z.string().describe('What the entry means and how the tools use it.'),
            details: z
              .record(z.string(), z.string())
              .optional()
              .describe(
                'Further attributes as name → value (for types: main type, category, division, number form, enacted keyword).',
              ),
          })
          .describe('One reference entry.'),
      )
      .describe('Reference entries for the topic.'),
  }),

  handler(input) {
    return { topic: input.topic, entries: referenceEntries(input.topic) };
  },

  format: (result) => {
    const lines = [
      `## Reference: ${result.topic}`,
      '',
      '| Key | Label | Description | Details |',
      '| --- | --- | --- | --- |',
      ...result.entries.map(
        (e) =>
          `| ${cell(e.key)} | ${cell(e.label)} | ${cell(e.description)} | ${
            e.details
              ? Object.entries(e.details)
                  .map(([k, v]) => `${cell(k)}: ${cell(v)}`)
                  .join('; ')
              : ''
          } |`,
      ),
    ];
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
