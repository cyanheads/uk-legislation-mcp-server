/**
 * @fileoverview uklaw_get_document — reads one item or provision as current,
 * enacted/made, or dated text with its editorial status, annotations, the
 * unapplied effects touching it, available versions, and attribution.
 * Oversized reads return an outline to narrow from.
 * @module mcp-server/tools/definitions/get-document
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getLegislationService } from '@/services/legislation/legislation-service.js';
import {
  isCalendarDate,
  normalizeProvision,
  parseItemInput,
} from '@/services/legislation/provision-path.js';
import { attributionLines, blockquote, inline, renderEffect, uri } from './_markdown.js';
import {
  AttributionSchema,
  blankAsUnset,
  DATE_PATTERN,
  EffectRecordSchema,
  FullItemInput,
  ProvisionInput,
  TextInput,
} from './_schemas.js';

const VERSION_PATTERN = /^(current|enacted|made|adopted|created|\d{4}-\d{2}-\d{2})$/;
/** Markdown nesting depth for outline entries; deeper levels render at this depth, labelled with their level. */
const MAX_OUTLINE_INDENT = 6;

export const getDocumentTool = tool('uklaw_get_document', {
  title: 'Read UK legislation text',
  description:
    'Read one item or one provision of UK legislation from legislation.gov.uk — as it stands now (revised), as enacted/made, or as it stood on a date — in Markdown, with its editorial status, annotations (the applied amendment history), the unapplied effects touching it, the versions available, and attribution. Provision-level reads are the main path; an item-level read returns the whole text only for small items and otherwise an outline of provision paths to read next. With match_text (item level), returns the provisions whose text matches. Revised text is an editorial consolidation that can lag: read editorial.caveat and unapplied_effects before relying on it, and use uklaw_get_amendments for every recorded effect on an item, applied or not.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  auth: ['tool:uklaw_get_document:read'],
  input: z.object({
    item: FullItemInput.describe(
      'Item path {type}/{year}/{number} — ukpga/2018/12, uksi/2019/419, eur/2016/679, ukpga/Eliz2/3-4/19 — or any legislation.gov.uk URI (a URI carrying a provision, version, or /welsh is split into those parts; a version or /welsh in the URI applies unless the version or language input is set). Get it from uklaw_lookup_citation or uklaw_search_legislation.',
    ),
    provision: blankAsUnset(ProvisionInput.optional()).describe(
      'Provision path — section/45/2/f, regulation/5, article/28/3, schedule/2/paragraph/3, part/3/chapter/2, introduction — or citation shorthand (s. 45(2)(f), reg. 5, art. 28(3), Sch. 2 para. 3), normalized before the request. Omit to read the item; an item-level outline lists the paths.',
    ),
    version: blankAsUnset(
      z
        .string()
        .regex(
          VERSION_PATTERN,
          'Pass version as current, enacted (or made, adopted, created), or a date YYYY-MM-DD such as 2020-01-31.',
        )
        .optional(),
    ).describe(
      'current (the latest revised text, or the original text for an item never revised), enacted (made, adopted and created are synonyms — the original text), or a date YYYY-MM-DD for the text as it stood then. Omitted: the version in an item URI, else current. A future date returns the latest version, and a date on or after the made or enactment date of an item never revised returns its original text, with a notice; version.applied reports the version served.',
    ),
    language: blankAsUnset(z.enum(['en', 'cy']).optional()).describe(
      'en, or cy for the Welsh text of Welsh legislation (asc, anaw, mwa, wsi). Omitted: cy when an item URI ends in /welsh, else en. English is returned, with a notice, when no Welsh text exists.',
    ),
    match_text: blankAsUnset(TextInput.max(200).optional()).describe(
      'Item level only (omit provision): return the outline of provisions whose text contains this term, e.g. "processor" — 100 entries per call; outline_offset reaches the rest.',
    ),
    outline_offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Where a returned outline starts: 0 lists entries 1–100, 100 the next 100. Applies only when kind is outline (ignored when text is returned); a notice names the next offset while entries remain.',
      ),
  }),
  output: z.object({
    kind: z
      .enum(['full', 'outline', 'pdf_only'])
      .describe(
        'full: text returned; outline: a list of provisions to read instead; pdf_only: the item is held as PDF only (see links.pdf).',
      ),
    item: z
      .object({
        path: z.string().describe('Item path, e.g. ukpga/2018/12.'),
        id_uri: z.string().describe('Identifier URI of the item.'),
        title: z.string().describe('Title of the item.'),
        title_cy: z.string().optional().describe('Welsh title, when held.'),
        type: z.string().describe('Type code, e.g. ukpga.'),
        type_label: z.string().describe('Human label of the type code.'),
        category: z
          .string()
          .optional()
          .describe(
            'Category legislation.gov.uk reports: primary, secondary, or euretained; absent when not reported.',
          ),
        year: z
          .number()
          .optional()
          .describe('Calendar year; absent when the metadata reports none.'),
        number: z
          .string()
          .optional()
          .describe('Number within the year (an ISBN for drafts); absent when not known.'),
        extent: z
          .string()
          .optional()
          .describe(
            'Territorial extent of the whole item at the version served, e.g. E+W+S+N.I.; absent when not recorded (enacted and made text records none).',
          ),
      })
      .describe('The item read.'),
    provision: z
      .object({
        path: z.string().describe('Provision path, e.g. section/45/2/f.'),
        id_uri: z.string().describe('Identifier URI of the provision.'),
        label: z.string().describe('Human label, e.g. "Section 45(2)(f)".'),
        heading: z.string().optional().describe('Heading of the provision, when it has one.'),
        status: z
          .string()
          .optional()
          .describe(
            'Status legislation.gov.uk marks on the provision, e.g. Repealed or Prospective; absent when unmarked.',
          ),
        extent: z
          .string()
          .optional()
          .describe('Territorial extent, e.g. E+W+S+N.I.; absent when not recorded.'),
        valid_from: z
          .string()
          .optional()
          .describe(
            "Start date (YYYY-MM-DD) of this provision's own text window; it can differ from version.applied, which dates the whole document version. Both window ends come from one element, the nearest carrying either. Absent when that element records no start (enacted and made text records none), or when its window ends before it starts (a notice says so).",
          ),
        valid_to: z
          .string()
          .optional()
          .describe(
            "End date (YYYY-MM-DD) of this provision's own text window, when a later text of the provision supersedes it, from the same element as valid_from; absent while revised text is current, on enacted or made text, which records no window, and when the window ends before it starts (a notice says so).",
          ),
      })
      .optional()
      .describe('The provision read — present for provision-level reads.'),
    version: z
      .object({
        requested: z.string().describe('Version requested.'),
        applied: z
          .string()
          .describe(
            'Version served: its start date (YYYY-MM-DD), the enacted keyword, or current when no date is reported.',
          ),
        valid_to: z
          .string()
          .optional()
          .describe(
            'End date (YYYY-MM-DD) of the item version served — when a later version of the item takes over; absent for the latest version, and on enacted or made text, which records no window.',
          ),
        document_uri: z.string().describe('URI of the document served.'),
        available: z
          .array(z.string())
          .describe(
            'Versions legislation.gov.uk lists for the document plus the one served — keywords such as enacted and point-in-time dates, each usable as version.',
          ),
      })
      .describe('Version requested and served.'),
    language: z.string().describe('Language actually served (en or cy).'),
    editorial: z
      .object({
        document_status: z
          .string()
          .describe(
            'final (as enacted/made), revised, or draft as legislation.gov.uk reports it; unknown when it reports none.',
          ),
        publisher: z
          .array(z.string())
          .describe(
            'Publishers of the document as legislation.gov.uk reports them; empty when none.',
          ),
        modified: z
          .string()
          .optional()
          .describe(
            'When legislation.gov.uk last modified the document; absent when not reported.',
          ),
        outstanding_effects: z
          .number()
          .describe(
            'Effects requiring a text change not yet applied that touch this provision, or at item level every such effect on the item: the full count, beyond the 20 unapplied_effects lists.',
          ),
        caveat: z.string().describe('How far to rely on this text, given its status.'),
      })
      .describe('Editorial status — read before relying on revised text.'),
    text: z
      .string()
      .optional()
      .describe(
        'The text as Markdown, present when kind is full; amendments are wrapped as [F1 …] keyed to annotations. A provision with no smaller child provisions that renders over 40,000 characters, counting its annotations, is cut to 40,000, and a notice gives its full size and the links to the full text.',
      ),
    annotations: z
      .array(
        z
          .object({
            label: z.string().describe('Label as it appears in the text, e.g. F1, I1.'),
            type: z
              .string()
              .describe(
                'Annotation type letter: F, C, I, M, E, P, or X (uklaw_list_reference topic annotation_types).',
              ),
            type_label: z.string().describe('What the type records, e.g. Textual amendment.'),
            text: z.string().describe('Annotation text.'),
            citations: z
              .array(
                z
                  .object({
                    title: z
                      .string()
                      .optional()
                      .describe('Title of the cited item or provision, when given.'),
                    uri: z.string().describe('Identifier URI cited.'),
                  })
                  .describe('One citation.'),
              )
              .describe('Legislation the annotation cites; empty when none.'),
          })
          .describe('One annotation.'),
      )
      .optional()
      .describe(
        'Annotations referenced by the text, present when kind is full — the applied amendment history of the version served. When the text is cut, only those the kept text references.',
      ),
    unapplied_effects: z
      .array(EffectRecordSchema)
      .optional()
      .describe(
        'Recorded effects not yet applied to the revised text that touch this provision (at item level, the item’s): the first 20, outstanding first, with a notice when more exist; empty when none. Absent on an item-level outline, where a notice gives the item’s count and uklaw_get_amendments lists them.',
      ),
    outline: z
      .array(
        z
          .object({
            provision: z.string().describe('Provision path to pass back as provision.'),
            label: z.string().describe('Human label, e.g. "Part 3".'),
            heading: z.string().optional().describe('Heading, when the provision has one.'),
            level: z.number().describe('Nesting level, from 1.'),
            status: z
              .string()
              .optional()
              .describe(
                'Status legislation.gov.uk marks on the provision, e.g. Repealed; absent when unmarked.',
              ),
            chars: z
              .number()
              .optional()
              .describe(
                'Rendered size in characters, counting the text and its annotations with their citations; present in outlines of an oversized provision, absent at item level.',
              ),
            matches_text: z
              .boolean()
              .optional()
              .describe('True when the provision matched match_text.'),
          })
          .describe('One outline entry.'),
      )
      .optional()
      .describe(
        'Provisions to read next, present when kind is outline: up to 100 entries from outline_offset; empty when outline_offset is past the end.',
      ),
    outline_notice: z
      .string()
      .optional()
      .describe(
        'How to read a provision from the outline, naming one to start with; past the outline’s end, its entry count.',
      ),
    links: z
      .object({
        web: z.string().describe('legislation.gov.uk page for the version read.'),
        xml: z.string().describe('CLML XML of the version read.'),
        akn: z.string().optional().describe('Akoma Ntoso XML, when legislation.gov.uk offers it.'),
        pdf: z
          .string()
          .optional()
          .describe('Original PDF, when held (linked, never fetched by this server).'),
      })
      .describe('Links to the document.'),
    attribution: AttributionSchema,
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Notices: Welsh fallback, original text served for a dated read, an omitted provision window, the unapplied effects an item outline leaves out, truncated lists, an outline window with the outline_offset that continues it, an oversized provision with no smaller child provisions returned whole or cut (its full size, and the links to the full text), and how to continue.',
      ),
  },
  errors: [
    {
      reason: 'invalid_item',
      code: JsonRpcErrorCode.ValidationError,
      severity: 'notice',
      when: 'item is not a full {type}/{year}/{number} item path or legislation.gov.uk URI, its type code is unknown, or a URI carries an unreadable provision.',
      recovery:
        'Pass an item path such as ukpga/2018/12 from uklaw_lookup_citation or uklaw_search_legislation; uklaw_list_reference topic types lists the codes.',
    },
    {
      reason: 'invalid_provision',
      code: JsonRpcErrorCode.ValidationError,
      severity: 'notice',
      when: 'provision cannot be normalized, or conflicts with a provision embedded in item.',
      recovery:
        'Pass a provision path such as section/45/2/f, regulation/5, article/28 or schedule/2/paragraph/3; uklaw_list_reference topic provision_paths lists the forms.',
    },
    {
      reason: 'invalid_version',
      code: JsonRpcErrorCode.ValidationError,
      severity: 'notice',
      when: 'version is shaped YYYY-MM-DD but is not a real calendar date, or a URI carried an unsupported version.',
      recovery: 'Pass version as current, enacted, or a calendar date such as 2020-01-31.',
    },
    {
      reason: 'match_text_needs_item_level',
      code: JsonRpcErrorCode.ValidationError,
      severity: 'notice',
      when: 'match_text is combined with provision.',
      recovery:
        'Call uklaw_get_document with match_text and no provision to find matching provisions, then read one with provision.',
    },
    {
      reason: 'document_not_found',
      code: JsonRpcErrorCode.NotFound,
      severity: 'notice',
      when: 'legislation.gov.uk has no such item, or the identifier check that would tell a missing item from a missing provision could not run in time.',
      recovery:
        'Resolve the item with uklaw_lookup_citation or uklaw_search_legislation, then call uklaw_get_document with the returned item path.',
    },
    {
      reason: 'provision_not_found',
      code: JsonRpcErrorCode.NotFound,
      severity: 'notice',
      when: 'The item exists but has no document at that provision path and version.',
      recovery:
        "Call uklaw_get_document without provision to list this item's provision paths; if the provision was inserted later, use version current or a later date.",
    },
    {
      reason: 'version_not_found',
      code: JsonRpcErrorCode.NotFound,
      severity: 'notice',
      when: 'Item level: the item exists but has no version at the requested date (the date precedes it).',
      recovery:
        'Call uklaw_get_document with version enacted or current; version.available in that response lists the dated versions.',
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
        'Wait the retryAfter seconds in the error data, then call uklaw_get_document again.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const parsed = parseItemInput(input.item);
    if (!parsed?.item.full) {
      throw ctx.fail(
        'invalid_item',
        `"${input.item}" is not a legislation item path or legislation.gov.uk URI.`,
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
      if (provision && provision !== normalized) {
        throw ctx.fail(
          'invalid_provision',
          `item carries provision ${provision} but provision is ${normalized}; pass one of them.`,
        );
      }
      provision = normalized;
    }
    const version = input.version ?? parsed.version ?? 'current';
    if (version === 'prospective' || (DATE_PATTERN.test(version) && !isCalendarDate(version))) {
      throw ctx.fail(
        'invalid_version',
        `version ${version} is not supported: use current, enacted, or a real calendar date.`,
      );
    }
    if (input.match_text !== undefined && provision) {
      throw ctx.fail(
        'match_text_needs_item_level',
        "match_text searches an item's table of contents and cannot combine with provision.",
      );
    }
    const language = input.language ?? parsed.language ?? 'en';

    const outcome = await getLegislationService().getDocument(
      {
        item: parsed.item,
        ...(provision ? { provision } : {}),
        version,
        language,
        ...(input.match_text !== undefined ? { matchText: input.match_text } : {}),
        outlineOffset: input.outline_offset,
      },
      ctx,
    );

    if (outcome.kind === 'not_found') {
      const where = `${parsed.item.path}${provision ? `/${provision}` : ''} at version ${version}`;
      if (outcome.which === 'provision') {
        throw ctx.fail(
          'provision_not_found',
          `${parsed.item.path} exists but has no document at ${provision} (version ${version}).`,
        );
      }
      if (outcome.which === 'version') {
        throw ctx.fail(
          'version_not_found',
          `${parsed.item.path} exists but has no version at ${version}.`,
        );
      }
      if (!outcome.checkRan) {
        throw ctx.fail(
          'document_not_found',
          `legislation.gov.uk has no document at ${where}; whether the item itself exists could not be checked in time.`,
          {
            recovery: {
              hint: `Resolve the item with uklaw_lookup_citation or uklaw_search_legislation; if the item resolves, call uklaw_get_document without provision (or with version current) to list what exists.`,
            },
          },
        );
      }
      throw ctx.fail(
        'document_not_found',
        `legislation.gov.uk has no item at ${parsed.item.path}.`,
      );
    }

    if (outcome.notices.length > 0) ctx.enrich.notice(outcome.notices.join(' '));
    ctx.log.debug('Document read', {
      item: parsed.item.path,
      provision,
      kind: outcome.output.kind,
    });
    return outcome.output;
  },

  format: (result) => {
    const item = result.item;
    const lines = [
      `## ${inline(item.title)}${item.title_cy ? ` / ${inline(item.title_cy)}` : ''}`,
      `**Item:** \`${uri(item.path)}\` · ${item.type} (${inline(item.type_label)})${item.category ? ` · category ${inline(item.category)}` : ''} · year ${item.year ?? 'unknown'} · number ${inline(item.number ?? 'unknown')} · extent ${inline(item.extent ?? 'not recorded')} · ${uri(item.id_uri)}`,
    ];
    const p = result.provision;
    if (p) {
      const openEnd =
        result.editorial.document_status === 'revised' ? 'present' : 'an unrecorded date';
      lines.push(
        `**Provision:** ${inline(p.label)} (\`${uri(p.path)}\`)${p.heading ? ` — ${inline(p.heading)}` : ''} · ${uri(p.id_uri)}`,
        `**Status:** ${inline(p.status ?? 'none marked')} · extent ${inline(p.extent ?? 'not recorded')} · valid from ${inline(p.valid_from ?? 'an unrecorded date')} to ${inline(p.valid_to ?? openEnd)}`,
      );
    }
    const v = result.version;
    lines.push(
      `**Kind:** ${result.kind} · **Version:** requested ${v.requested}, applied ${inline(v.applied)}${v.valid_to ? `, valid to ${inline(v.valid_to)}` : ''} · language ${inline(result.language)} · ${uri(v.document_uri)}`,
      `**Versions available:** ${v.available.map(inline).join(', ') || 'none listed'}`,
      `**Editorial:** status ${inline(result.editorial.document_status)} · publisher ${result.editorial.publisher.map(inline).join('; ') || 'not reported'}${result.editorial.modified ? ` · modified ${inline(result.editorial.modified)}` : ''} · outstanding effects ${result.editorial.outstanding_effects}`,
      `> ${inline(result.editorial.caveat)}`,
    );
    if (result.text !== undefined)
      lines.push('', '### Text', '', blockquote(result.text || '(no text)'));
    if (result.annotations && result.annotations.length > 0) {
      lines.push('', '### Annotations');
      for (const a of result.annotations) {
        lines.push(`- **${inline(a.label)}** (${inline(a.type)}: ${inline(a.type_label)})`);
        lines.push(
          ...blockquote(a.text || '(no text)')
            .split('\n')
            .map((line) => `  ${line}`),
        );
        if (a.citations.length > 0) {
          lines.push(
            `  - Cites: ${a.citations.map((c) => `${c.title ? `${inline(c.title)} ` : ''}<${uri(c.uri)}>`).join('; ')}`,
          );
        }
      }
    }
    if (result.outline) {
      lines.push('', '### Outline', '');
      for (const o of result.outline) {
        const facts = [
          o.status ? `status ${inline(o.status)}` : undefined,
          o.chars !== undefined ? `${o.chars} chars` : undefined,
          o.matches_text ? 'matches text' : undefined,
        ].filter(Boolean);
        const indent = '  '.repeat(Math.min(Math.max(0, o.level - 1), MAX_OUTLINE_INDENT));
        lines.push(
          `${indent}- \`${uri(o.provision)}\` ${inline(o.label)}${o.heading ? ` — ${inline(o.heading)}` : ''}${facts.length > 0 ? ` (${facts.join(', ')})` : ''} [level ${o.level}]`,
        );
      }
    }
    if (result.outline_notice) lines.push('', `**Next:** ${inline(result.outline_notice)}`);
    const effects = result.unapplied_effects;
    if (effects) {
      lines.push('', `### Unapplied effects (${effects.length} listed)`);
      if (effects.length === 0) {
        lines.push(`None recorded against this ${result.provision ? 'provision' : 'item'}.`);
      }
      for (const e of effects) lines.push(renderEffect(e));
    } else {
      lines.push(
        '',
        '### Unapplied effects',
        `Not listed on an item outline; call uklaw_get_amendments with item \`${uri(item.path)}\` and status "unapplied" for them.`,
      );
    }
    const l = result.links;
    lines.push(
      '',
      `**Links:** web ${uri(l.web)} · xml ${uri(l.xml)}${l.akn ? ` · akn ${uri(l.akn)}` : ''}${l.pdf ? ` · pdf ${uri(l.pdf)}` : ''}`,
      '',
      attributionLines(result.attribution),
    );
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
