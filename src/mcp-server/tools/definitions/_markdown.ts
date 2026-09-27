/**
 * @fileoverview Markdown helpers for `format()`. Upstream text in an inline
 * slot is flattened to one line with Markdown/HTML openers escaped; an
 * upstream URI or path is percent-encoded instead, since escaping would
 * corrupt it; multi-line upstream text is blockquoted line by line.
 * `structuredContent` keeps every value verbatim — these helpers shape
 * `content[]` only.
 * @module mcp-server/tools/definitions/_markdown
 */

import type { z } from '@cyanheads/mcp-ts-core';
import type { EffectRecordSchema } from './_schemas.js';

type EffectRecord = z.output<typeof EffectRecordSchema>;

/** NEL and the Unicode line and paragraph separators, which break a line like CR/LF; the regex `\s` class omits NEL. */
const SEPARATORS = String.fromCodePoint(0x0085, 0x2028, 0x2029);
const LINE_BREAKS = new RegExp(`[\\r\\n${SEPARATORS}]+`, 'g');
const LINE_SPLIT = new RegExp(`\\r\\n|[\\r\\n${SEPARATORS}]`);

/** Characters backslash-escaped in an inline slot; the backslash itself is one, so upstream text cannot cancel an escape. */
const INLINE_SPECIALS = /[\\*`[\]]/g;
/** The inline specials plus the pipe, which would otherwise split a table cell. */
const CELL_SPECIALS = /[\\*`[\]|]/g;

/**
 * Flattens line breaks to a space and backslash-escapes `specials` in one pass,
 * so an inserted escape is never itself escaped, then escapes `_` at word
 * edges and `<` before a tag opener.
 */
function escapeInline(value: string | number | boolean | undefined, specials: RegExp): string {
  if (value === undefined) return '';
  return String(value)
    .replace(LINE_BREAKS, ' ')
    .replace(specials, (c) => `\\${c}`)
    .replace(/(^|[^A-Za-z0-9])_|_(?=[^A-Za-z0-9]|$)/g, (m) => m.replace('_', '\\_'))
    .replace(/<(?=[A-Za-z/!?])/g, '&lt;');
}

/** Flattens line breaks to a space and escapes Markdown/HTML openers for an inline slot. */
export function inline(value: string | number | boolean | undefined): string {
  return escapeInline(value, INLINE_SPECIALS);
}

/** Whitespace (line separators and NEL included) and the characters RFC 3986 bars from a URI unencoded. */
const URI_UNSAFE = /[\s\u0085"<>\\^`{|}[\]]/g;

/**
 * A URI or path for an inline slot, bare, in a code span, or in `<…>`:
 * percent-encodes each character that would break the line or open
 * Markdown/HTML syntax, leaving a well-formed URI unchanged.
 */
export function uri(value: string): string {
  return value.replace(URI_UNSAFE, (c) => encodeURIComponent(c));
}

/** Inline text for a Markdown table cell (pipes escaped too). */
export function cell(value: string | number | boolean | undefined): string {
  return escapeInline(value, CELL_SPECIALS);
}

/** Blockquotes multi-line upstream text line by line. */
export function blockquote(value: string): string {
  return value
    .split(LINE_SPLIT)
    .map((line) => (line.length > 0 ? `> ${line.replace(/<(?=[A-Za-z/!?])/g, '&lt;')}` : '>'))
    .join('\n');
}

/** Renders the attribution lines. */
export function attributionLines(lines: string[]): string {
  return ['**Attribution:**', ...lines.map((line) => `- ${inline(line)}`)].join('\n');
}

function refs(list: EffectRecord['savings']): string {
  if (list.length === 0) return 'none';
  return list
    .map((r) => {
      const start = r.uri !== undefined ? uri(r.uri) : undefined;
      const uris = r.up_to ? `${start ?? 'unrecorded'} to ${uri(r.up_to)}` : start;
      return `${inline(r.label)}${uris ? ` (${uris})` : ''}${r.missing ? ' [missing]' : ''}`;
    })
    .join('; ');
}

function side(name: string, s: EffectRecord['affected']): string {
  const head = [s.title ? inline(s.title) : undefined, s.item ? `\`${uri(s.item)}\`` : undefined]
    .filter(Boolean)
    .join(' ');
  return `  - ${name}: ${head || 'unknown'}${s.id_uri ? ` <${uri(s.id_uri)}>` : ''} — ${s.provisions_label ? inline(s.provisions_label) : 'no provisions label'}; provisions: ${refs(s.provisions)}`;
}

/** Renders one effect record as a Markdown list item with every field. */
export function renderEffect(e: EffectRecord): string {
  const flags = [
    e.outstanding ? '**outstanding**' : 'not outstanding',
    e.applied !== undefined ? `applied: ${e.applied}` : 'applied: not reported',
    e.requires_applied !== undefined ? `requires_applied: ${e.requires_applied}` : undefined,
    e.welsh_requires_applied !== undefined
      ? `welsh_requires_applied: ${e.welsh_requires_applied}`
      : undefined,
    e.welsh_applied !== undefined ? `welsh_applied: ${e.welsh_applied}` : undefined,
  ].filter(Boolean);
  const inForce =
    e.in_force.length === 0
      ? 'none recorded'
      : e.in_force
          .map((f) =>
            [
              f.date ? inline(f.date) : 'no date',
              f.qualification ? inline(f.qualification) : undefined,
              f.prospective ? 'prospective' : undefined,
              f.applied !== undefined ? `applied: ${f.applied}` : undefined,
              f.commencing_uri ? `commencing ${uri(f.commencing_uri)}` : undefined,
            ]
              .filter(Boolean)
              .join(', '),
          )
          .join('; ');
  const lines = [
    `- **${inline(e.type)}** — ${flags.join(' · ')} (effect ${inline(e.effect_id)})`,
    side('Affected', e.affected),
    side('Affecting', e.affecting),
    `  - In force: ${inForce}`,
    `  - Commencement authority: ${refs(e.commencement_authority)}; savings: ${refs(e.savings)}`,
  ];
  if (e.extent) lines.push(`  - Extent: ${inline(e.extent)}`);
  if (e.notes) {
    lines.push(
      '  - Notes:',
      ...blockquote(e.notes)
        .split('\n')
        .map((line) => `    ${line}`),
    );
  }
  if (e.modified) lines.push(`  - Modified: ${inline(e.modified)}`);
  return lines.join('\n');
}
