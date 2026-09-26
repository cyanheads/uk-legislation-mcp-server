/**
 * @fileoverview Effect records — one shape for `ukm:UnappliedEffect` (document
 * metadata) and `ukm:Effect` (changes feeds) — plus provision matching at a
 * path-segment boundary (ranges in natural provision order) and the
 * outstanding-first ordering.
 * @module services/legislation/clml/effects
 */

import type { EffectRecord, EffectSide, InForceEntry, ProvisionRef } from '../types.js';
import {
  attr,
  boolAttr,
  child,
  childrenNamed,
  elements,
  legislationPath,
  textOf,
  toHttps,
  type XmlElement,
} from '../xml.js';

const SAME_AS_AFFECTED = /^S\+A\+M\+E\+A\+S\+A\+F\+F\+E\+C\+T\+E\+D$/i;

/** One `ukm:Section`, or one `ukm:SectionRange` read as its start (`uri`) and end (`up_to`). */
function provisionRef(el: XmlElement): ProvisionRef | undefined {
  const range = el.name === 'ukm:SectionRange';
  if (!range && el.name !== 'ukm:Section') return;
  const uri = attr(el, 'URI');
  const upTo = range ? attr(el, 'UpTo') : undefined;
  const missing = range
    ? boolAttr(el, 'MissingStart') || boolAttr(el, 'MissingEnd')
    : boolAttr(el, 'Missing');
  return {
    label: textOf(el),
    ...(uri ? { uri: toHttps(uri) } : {}),
    ...(upTo ? { up_to: toHttps(upTo) } : {}),
    ...(missing ? { missing: true } : {}),
  };
}

function sections(node: XmlElement | undefined): ProvisionRef[] {
  if (!node) return [];
  return elements(node)
    .map(provisionRef)
    .filter((ref): ref is ProvisionRef => ref !== undefined);
}

function side(effect: XmlElement, name: 'Affected' | 'Affecting'): EffectSide {
  const idUri = attr(effect, `${name}URI`);
  const item = legislationPath(idUri);
  const title = textOf(child(effect, `ukm:${name}Title`));
  const label = attr(effect, `${name}Provisions`);
  return {
    ...(item ? { item } : {}),
    ...(idUri ? { id_uri: toHttps(idUri) } : {}),
    ...(title ? { title } : {}),
    ...(label ? { provisions_label: label } : {}),
    provisions: sections(child(effect, `ukm:${name}Provisions`)),
  };
}

function inForce(effect: XmlElement): InForceEntry[] {
  return childrenNamed(child(effect, 'ukm:InForceDates'), 'ukm:InForce').map((entry) => {
    const date = attr(entry, 'Date');
    const qualification = attr(entry, 'Qualification');
    const prospective = boolAttr(entry, 'Prospective');
    const applied = boolAttr(entry, 'Applied');
    const commencing = attr(entry, 'CommencingURI');
    return {
      ...(date ? { date } : {}),
      ...(qualification ? { qualification } : {}),
      ...(prospective !== undefined ? { prospective } : {}),
      ...(applied !== undefined ? { applied } : {}),
      ...(commencing ? { commencing_uri: toHttps(commencing) } : {}),
    };
  });
}

/**
 * Parses one effect element. An `ukm:UnappliedEffect` is unapplied by
 * definition, so `applied` is `false` whatever its attributes say; a feed
 * `ukm:Effect` reports `applied` only when it carries the attribute. An
 * unreported `Applied` or `RequiresApplied` counts toward `outstanding`: only
 * an explicit applied or no-change-required clears it.
 */
export function parseEffect(effect: XmlElement): EffectRecord {
  const unapplied = effect.name === 'ukm:UnappliedEffect';
  const applied = unapplied ? false : boolAttr(effect, 'Applied');
  const requiresApplied = boolAttr(effect, 'RequiresApplied');
  const welshRequires = boolAttr(effect, 'RequiresWelshApplied');
  const welshApplied = boolAttr(effect, 'WelshApplied');
  const rawExtent = attr(effect, 'AffectingEffectsExtent');
  const notes = attr(effect, 'Notes');
  const modified = attr(effect, 'Modified');
  return {
    effect_id: attr(effect, 'EffectId') ?? attr(effect, 'URI') ?? '',
    type: attr(effect, 'Type') ?? '',
    ...(applied !== undefined ? { applied } : {}),
    ...(requiresApplied !== undefined ? { requires_applied: requiresApplied } : {}),
    outstanding: requiresApplied !== false && applied !== true,
    ...(welshRequires !== undefined ? { welsh_requires_applied: welshRequires } : {}),
    ...(welshApplied !== undefined ? { welsh_applied: welshApplied } : {}),
    affected: side(effect, 'Affected'),
    affecting: side(effect, 'Affecting'),
    commencement_authority: sections(child(effect, 'ukm:CommencementAuthority')),
    savings: sections(child(effect, 'ukm:Savings')),
    in_force: inForce(effect),
    ...(rawExtent
      ? { extent: SAME_AS_AFFECTED.test(rawExtent) ? 'same as affected' : rawExtent }
      : {}),
    ...(notes ? { notes } : {}),
    ...(modified ? { modified } : {}),
  };
}

const NUMBERED = /^(\d+)([a-z]*)$/;
/** Paragraph letters (a, ma, aa) and roman numerals (i, xviii); longer words name a kind, not a position. */
const ORDINAL_LETTERS = /^(?:[a-z]{1,3}|[ivxlcdm]+)$/;
const ROMAN = /^[ivxlcdm]+$/;
const ROMAN_VALUES: Readonly<Record<string, number>> = {
  i: 1,
  v: 5,
  x: 10,
  l: 50,
  c: 100,
  d: 500,
  m: 1000,
};

function romanValue(numeral: string): number {
  let total = 0;
  for (let i = 0; i < numeral.length; i += 1) {
    const value = ROMAN_VALUES[numeral.charAt(i)] ?? 0;
    total += value < (ROMAN_VALUES[numeral.charAt(i + 1)] ?? 0) ? -value : value;
  }
  return total;
}

/**
 * Alphabetical, the order insertions keep: (ma) sits between (m) and (n), 45AA
 * between 45A and 45B. A `z` followed by more letters sorts first, as
 * legislation numbers an insertion before the first (45ZA precedes 45A).
 */
function letterOrder(a: string, b: string): number {
  const x = a.replace(/z(?=[a-z])/g, '`');
  const y = b.replace(/z(?=[a-z])/g, '`');
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Natural order of two path segments; undefined when they are of different kinds. */
function compareSegments(a: string, b: string, roman: boolean): number | undefined {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  const nx = NUMBERED.exec(x);
  const ny = NUMBERED.exec(y);
  if (nx && ny) return Number(nx[1]) - Number(ny[1]) || letterOrder(nx[2] ?? '', ny[2] ?? '');
  if (!ORDINAL_LETTERS.test(x) || !ORDINAL_LETTERS.test(y)) return;
  if (roman && ROMAN.test(x) && ROMAN.test(y)) return romanValue(x) - romanValue(y);
  return letterOrder(x, y);
}

/**
 * Orders two provision paths by their first differing segment; 0 when one
 * contains the other (equal, ancestor or descendant), undefined when that
 * segment differs in kind.
 */
function comparePaths(a: string[], b: string[], roman: boolean): number | undefined {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    if (a[i] === b[i]) continue;
    const order = compareSegments(a[i] as string, b[i] as string, roman);
    if (order !== 0) return order;
  }
  return 0;
}

/**
 * True when a path lies within `[from, upTo]` or overlaps either endpoint.
 * Letter segments are tried in letter order and, failing that, by roman value:
 * `ii`–`ix` covers `v` only as numerals, `m`–`o` covers `ma` only as letters.
 */
function withinRef(target: string[], from: string[], upTo: string[]): boolean {
  if (comparePaths(target, from, false) === 0 || comparePaths(target, upTo, false) === 0) {
    return true;
  }
  return [false, true].some((roman) => {
    const low = comparePaths(target, from, roman);
    const high = comparePaths(target, upTo, roman);
    return low !== undefined && high !== undefined && low >= 0 && high <= 0;
  });
}

/**
 * True when an effect touches a provision on the given side: a provision it
 * names equals the provision, descends from it, or is its ancestor, at a
 * path-segment boundary (`section/45` and `section/45/2/f` touch each other,
 * never `section/45A`); a range touches every provision between its endpoints
 * in natural order (`s. 65(2)-(4)` touches `section/65/3`, not `section/65/5`).
 * An effect that names no provision URI on that side is a whole-item effect
 * and touches every provision.
 */
export function effectTouches(
  effect: EffectRecord,
  onSide: 'affected' | 'affecting',
  provisionPath: string,
): boolean {
  const refs = effect[onSide].provisions.flatMap((p) => {
    const from = legislationPath(p.uri ?? p.up_to)?.split('/');
    const upTo = legislationPath(p.up_to)?.split('/') ?? from;
    return from && upTo ? [{ from, upTo }] : [];
  });
  if (refs.length === 0) return true;
  const target = provisionPath.split('/');
  return refs.some(({ from, upTo }) => withinRef(target, from, upTo));
}

function firstInForceDate(effect: EffectRecord): string {
  const dates = effect.in_force.map((e) => e.date).filter((d): d is string => d !== undefined);
  return dates.sort()[0] ?? '9999-12-31';
}

/** Outstanding effects first, then by earliest in-force date (undated last). */
export function sortOutstandingFirst(effects: EffectRecord[]): EffectRecord[] {
  return [...effects].sort((a, b) => {
    if (a.outstanding !== b.outstanding) return a.outstanding ? -1 : 1;
    return firstInForceDate(a).localeCompare(firstInForceDate(b));
  });
}
