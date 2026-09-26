/**
 * @fileoverview Domain types shared by the legislation.gov.uk service, its
 * parsers, and the tool definitions.
 * @module services/legislation/types
 */

/**
 * A provision reference inside an effect: its display label and identifier
 * URI. A range (`s. 65(2)-(4)`) is one reference, its first provision in `uri`
 * and its last in `up_to`.
 */
export interface ProvisionRef {
  label: string;
  missing?: boolean;
  up_to?: string;
  uri?: string;
}

/** One side of an effect — the item it touches and the provisions named on that side. */
export interface EffectSide {
  id_uri?: string;
  item?: string;
  provisions: ProvisionRef[];
  provisions_label?: string;
  title?: string;
}

/** One commencement entry of an effect. */
export interface InForceEntry {
  applied?: boolean;
  commencing_uri?: string;
  date?: string;
  prospective?: boolean;
  qualification?: string;
}

/** One effect (amendment, repeal, commencement, modification) in the shape every tool returns. */
export interface EffectRecord {
  affected: EffectSide;
  affecting: EffectSide;
  applied?: boolean;
  commencement_authority: ProvisionRef[];
  effect_id: string;
  extent?: string;
  in_force: InForceEntry[];
  modified?: string;
  notes?: string;
  outstanding: boolean;
  requires_applied?: boolean;
  savings: ProvisionRef[];
  type: string;
  welsh_applied?: boolean;
  welsh_requires_applied?: boolean;
}

/** A normalized item path, split into its parts. */
export interface ItemPath {
  /** True when the path carries type, year, and number. */
  full: boolean;
  number?: string;
  /** Full `{type}/{year}/{number}` (or a partial path when allowed). */
  path: string;
  regnal: boolean;
  type: string;
  /** Calendar year or regnal `Monarch/session`, absent on a type-only partial path. */
  year?: string;
}

/** A parsed item input: the item plus any provision, version, and language a URI carried. */
export interface ParsedItemInput {
  item: ItemPath;
  language?: 'cy';
  provision?: string;
  version?: string;
}

/** Normalized document version: `current`, an enacted keyword, or a calendar date. */
export type VersionKeyword = 'current' | 'enacted' | 'made' | 'adopted' | 'created';
