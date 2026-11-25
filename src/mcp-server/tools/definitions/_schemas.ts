/**
 * @fileoverview Schema building blocks shared by the tool definitions: the
 * blank-as-unset wrapper for optional string inputs, the date pattern, the
 * free-text, item, provision and cursor input shapes, the `limit` count field
 * with the clamp that serves an over-cap value at the cap, and the effect
 * record and attribution output shapes.
 * @module mcp-server/tools/definitions/_schemas
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import { ATTR_MCP_TOOL_NAME, createCounter } from '@cyanheads/mcp-ts-core/utils';

/**
 * Treats a blank or whitespace-only string as unset before validation runs.
 * Form-based clients submit every optional field, blank ones as `""`.
 */
export const blankAsUnset = <T extends z.ZodType>(schema: T) =>
  z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    schema,
  );

/** `YYYY-MM-DD` date shape. */
export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** A `YYYY-MM-DD` date input; the handler checks it is a real calendar date. */
export const DateInput = z
  .string()
  .regex(DATE_PATTERN, 'Pass a date as YYYY-MM-DD, e.g. 2026-09-24.');

/**
 * Free text sent upstream in a query parameter. An unpaired surrogate has no
 * UTF-8 form, so the URL could not be built; it is refused here instead.
 */
export const TextInput = z
  .string()
  .refine(
    (value) => value.isWellFormed(),
    'Pass well-formed Unicode text: this value holds an unpaired surrogate.',
  );

/**
 * Item inputs are shape-checked in the schema and normalized in the handler.
 * Each pattern admits every raw form the handler accepts (paths in any case,
 * legislation.gov.uk URIs with `/id`, a provision, a version, `/contents` or
 * `/data.xml`), so it only rejects what can never be an item — a title or a
 * citation with spaces — and its message routes that input to the resolver.
 * Segments are `/`-delimited runs of non-slash characters, so matching is linear.
 */
const FULL_ITEM_PATTERN = /^[^\s/]*(?:\/[^\s/]*){2,}$/;
const ITEM_PATTERN = /^\S+$/;
/** Characters a provision path or its citation shorthand can carry. */
const PROVISION_PATTERN = /^[A-Za-z0-9.()/\s-]+$/;
/** A `next_cursor` value: base64url. */
const CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/;

/** A full item path `{type}/{year}/{number}` or legislation.gov.uk URI. */
export const FullItemInput = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .regex(
    FULL_ITEM_PATTERN,
    'Pass an item path {type}/{year}/{number} such as ukpga/2018/12, or a legislation.gov.uk URI. For a title or citation such as "Data Protection Act 2018" or "S.I. 2019/419", call uklaw_lookup_citation first and pass the item it returns.',
  );

/** A full or partial item path (type, or type and year) or legislation.gov.uk URI. */
export const ItemInput = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .regex(
    ITEM_PATTERN,
    'Pass an item path such as ukpga/2018/12, a type and year such as uksi/2026, a type such as uksi, or a legislation.gov.uk URI — one token, no spaces. For a title or citation such as "Data Protection Act 2018", call uklaw_lookup_citation first and pass the item it returns.',
  );

/** A provision path or citation shorthand. */
export const ProvisionInput = z
  .string()
  .trim()
  .max(200)
  .regex(
    PROVISION_PATTERN,
    'Pass a provision path such as section/45/2/f or schedule/2/paragraph/3, or shorthand such as s. 45(2)(f) or Sch. 2 para. 3; uklaw_list_reference topic provision_paths lists the forms.',
  );

/**
 * Strict `limit` mode, off until `setup()` reads `UK_LEGISLATION_CLAMP_LIMITS`.
 * Every definition emits its input schema when its module is imported, before
 * `createApp()` loads `.env` under Node, so nothing here may read config.
 */
let strictLimits = false;

/** Set once from `setup()`: true advertises `maximum` at each cap and rejects a `limit` above it. */
export function setStrictLimits(on: boolean): void {
  strictLimits = on;
}

/**
 * A count input: an integer from 1, advertised with its default and minimum.
 * The handler serves a larger value at `cap` ({@link clampLimit}); in strict
 * mode the schema advertises `maximum` and rejects it instead. Not `.int()`,
 * which advertises and enforces the safe-integer maximum, so a value such as
 * 1e20 would never reach the clamp.
 */
export const limitField = (cap: number, fallback: number, what: string) =>
  z
    .number()
    .min(1)
    .check((ctx) => {
      if (!Number.isInteger(ctx.value)) {
        ctx.issues.push({ code: 'invalid_type', expected: 'int', input: ctx.value });
      } else if (strictLimits && ctx.value > cap) {
        ctx.issues.push({
          code: 'too_big',
          origin: 'number',
          maximum: cap,
          inclusive: true,
          input: ctx.value,
        });
      }
    })
    .meta({
      type: 'integer',
      // Read on each schema emission, so a tools/list after setup() carries the mode it set.
      get maximum() {
        return strictLimits ? cap : undefined;
      },
    })
    .default(fallback)
    .describe(`${what}; default ${fallback}, at most ${cap.toLocaleString('en-GB')}.`);

const limitsClamped = createCounter(
  'uklaw.limit.clamped',
  'Tool calls whose limit was above the cap',
  '{calls}',
);

/** The `limit` a call is served at. */
export interface ServedLimit {
  /** The sentence the call's notice carries when `limit` is the cap below the request; absent otherwise. */
  clamp?: string;
  /** The requested limit, or the cap when more was asked for: every site that reads `limit` takes this. */
  limit: number;
}

/** Serves a requested `limit` at `cap` when it asks for more, with one log line and one count per clamped call. */
export function clampLimit(
  tool: string,
  requested: number,
  cap: number,
  ctx: Context,
): ServedLimit {
  if (requested <= cap) return { limit: requested };
  ctx.log.info('limit above the cap', { requested, applied: cap });
  limitsClamped.add(1, { [ATTR_MCP_TOOL_NAME]: tool });
  return { limit: cap, clamp: `limit ${requested} is above the cap; ${cap} applied.` };
}

/**
 * A branch's notice with the clamp sentence in front of it. `ctx.enrich.notice()`
 * and `truncated()` guidance are last-wins, so a call sends one composed string.
 */
export function withClamp(served: ServedLimit, notice: string): string {
  return served.clamp ? `${served.clamp} ${notice}` : notice;
}

/** An opaque continuation cursor from a previous `next_cursor`. */
export const CursorInput = z
  .string()
  .trim()
  .max(500)
  .regex(
    CURSOR_PATTERN,
    'Pass next_cursor from the previous response unchanged, or omit cursor to start from the beginning.',
  );

const ProvisionRefSchema = z
  .object({
    label: z.string().describe('Provision as legislation.gov.uk labels it, e.g. "s. 45(2)(f)".'),
    uri: z
      .string()
      .optional()
      .describe(
        'Identifier URI of the provision, or of the first provision of a range; absent when legislation.gov.uk records none.',
      ),
    up_to: z
      .string()
      .optional()
      .describe(
        'Identifier URI of the last provision of a range such as "s. 65(2)-(4)"; absent for a single provision.',
      ),
    missing: z
      .boolean()
      .optional()
      .describe(
        'True when legislation.gov.uk marks the cited provision (or either end of a range) as missing from its data; absent otherwise.',
      ),
  })
  .describe('One provision or provision range named by the effect.');

const EffectSideSchema = (side: string) =>
  z
    .object({
      item: z
        .string()
        .optional()
        .describe(
          `Item path of the ${side} legislation, e.g. ukpga/2018/12; absent when legislation.gov.uk gives no item URI.`,
        ),
      id_uri: z.string().optional().describe(`Identifier URI of the ${side} legislation.`),
      title: z.string().optional().describe(`Title of the ${side} legislation.`),
      provisions_label: z
        .string()
        .optional()
        .describe(
          `Provisions of the ${side} legislation as one label, e.g. "s. 45(2)(f)" or "Sch. 2 para. 3".`,
        ),
      provisions: z
        .array(ProvisionRefSchema)
        .describe(
          `Provisions of the ${side} legislation, each with its URI; empty for an effect on the whole item.`,
        ),
    })
    .describe(`The ${side} legislation and the provisions the effect names on that side.`);

/** One effect record, as `uklaw_get_document` and `uklaw_get_amendments` return it. */
export const EffectRecordSchema = z
  .object({
    effect_id: z.string().describe('Effect identifier assigned by legislation.gov.uk.'),
    type: z
      .string()
      .describe(
        'Effect type as legislation.gov.uk records it (free text), e.g. "words substituted", "repealed".',
      ),
    applied: z
      .boolean()
      .optional()
      .describe(
        'Whether editors have applied the effect to the revised text; absent when legislation.gov.uk does not report it.',
      ),
    requires_applied: z
      .boolean()
      .optional()
      .describe(
        'False when the effect needs no text change (conditional, superseded, text not held); absent when not reported.',
      ),
    outstanding: z
      .boolean()
      .describe(
        'True when the effect requires a text change not reported as applied; an unreported applied or requires_applied counts toward true.',
      ),
    welsh_requires_applied: z
      .boolean()
      .optional()
      .describe('Dual-language items: whether the Welsh text needs the change.'),
    welsh_applied: z
      .boolean()
      .optional()
      .describe('Dual-language items: whether the Welsh text has the change.'),
    affected: EffectSideSchema('affected'),
    affecting: EffectSideSchema('affecting'),
    commencement_authority: z
      .array(ProvisionRefSchema)
      .describe('Provisions that commence the effect; empty when none are recorded.'),
    savings: z
      .array(ProvisionRefSchema)
      .describe('Savings provisions attached to the effect; empty when none are recorded.'),
    in_force: z
      .array(
        z
          .object({
            date: z
              .string()
              .optional()
              .describe('In-force date (YYYY-MM-DD); absent when not yet set.'),
            qualification: z
              .string()
              .optional()
              .describe('Qualification, e.g. "wholly in force", "for specified purposes".'),
            prospective: z
              .boolean()
              .optional()
              .describe('True when the effect has no commencement date yet.'),
            applied: z
              .boolean()
              .optional()
              .describe('Whether this commencement has been applied to the revised text.'),
            commencing_uri: z
              .string()
              .optional()
              .describe('URI of the commencing provision, when recorded.'),
          })
          .describe('One commencement entry.'),
      )
      .describe('Commencement entries for the effect; empty when none are recorded.'),
    extent: z
      .string()
      .optional()
      .describe(
        'Extent of the affecting provision, e.g. "E+W", or "same as affected"; absent when not recorded.',
      ),
    notes: z
      .string()
      .optional()
      .describe('Reader-facing note, usually why the effect is not applied; absent when none.'),
    modified: z
      .string()
      .optional()
      .describe('When legislation.gov.uk last modified the effect record, when reported.'),
  })
  .describe('One effect: an amendment, repeal, commencement or modification.');

/** Attribution lines every data-returning tool carries. */
export const AttributionSchema = z
  .array(z.string())
  .describe(
    'Attribution lines the returned content requires (OGL always; EU and Westlaw credits when applicable).',
  );
