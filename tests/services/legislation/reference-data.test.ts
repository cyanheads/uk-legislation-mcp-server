/**
 * @fileoverview Tests for the static reference tables and the attribution
 * builder that decides which licence lines a response carries.
 * @module tests/services/legislation/reference-data.test
 */

import { describe, expect, it } from 'vitest';
import { buildAttribution } from '@/services/legislation/attribution.js';
import {
  ATTRIBUTION_LINES,
  EU_TYPE_CODES,
  LEGISLATION_TYPES,
  REFERENCE_TOPICS,
  referenceEntries,
  TYPE_CODES,
  typeByCode,
  typeLabel,
} from '@/services/legislation/reference-data.js';

describe('buildAttribution', () => {
  it('always carries the OGL line', () => {
    expect(buildAttribution()).toEqual([ATTRIBUTION_LINES.ogl]);
    expect(buildAttribution({ types: ['ukpga'] })).toEqual([ATTRIBUTION_LINES.ogl]);
  });

  it.each(['eur', 'eudr', 'eudn', 'eut'])('adds the EU line for EU-origin type %s', (type) => {
    expect(buildAttribution({ types: ['ukpga', type] })).toEqual([
      ATTRIBUTION_LINES.ogl,
      ATTRIBUTION_LINES.eu,
    ]);
  });

  it('adds the EU line for the euretained category', () => {
    expect(buildAttribution({ types: ['ukpga'], categories: [undefined, 'euretained'] })).toContain(
      ATTRIBUTION_LINES.eu,
    );
  });

  it('adds the Westlaw credit when a publisher is Westlaw', () => {
    expect(buildAttribution({ publishers: ['Westlaw', 'Statute Law Database'] })).toEqual([
      ATTRIBUTION_LINES.ogl,
      ATTRIBUTION_LINES.westlaw,
    ]);
  });

  it('combines every line in a fixed order and ignores undefined values', () => {
    expect(
      buildAttribution({ types: [undefined, 'eur'], publishers: [undefined, 'westlaw'] }),
    ).toEqual([ATTRIBUTION_LINES.ogl, ATTRIBUTION_LINES.eu, ATTRIBUTION_LINES.westlaw]);
  });
});

describe('type table', () => {
  it('holds every code the design lists, each once', () => {
    expect(TYPE_CODES).toEqual([
      'ukpga',
      'ukla',
      'ukppa',
      'asp',
      'asc',
      'anaw',
      'mwa',
      'ukcm',
      'nia',
      'nisi',
      'apni',
      'mnia',
      'aosp',
      'aep',
      'aip',
      'apgb',
      'gbla',
      'gbppa',
      'uksi',
      'wsi',
      'ssi',
      'nisr',
      'ukci',
      'ukmd',
      'ukmo',
      'uksro',
      'nisro',
      'eur',
      'eudn',
      'eudr',
      'eut',
      'ukdsi',
      'sdsi',
      'nidsr',
    ]);
    expect(new Set(TYPE_CODES).size).toBe(LEGISLATION_TYPES.length);
  });

  it('maps enacted keywords by category', () => {
    for (const type of LEGISLATION_TYPES) {
      const expected =
        type.category === 'eu-origin'
          ? 'adopted'
          : type.category === 'draft'
            ? 'created'
            : type.category === 'secondary' || type.code === 'nisi'
              ? 'made'
              : 'enacted';
      expect(type.enactedKeyword, type.code).toBe(expected);
    }
  });

  it('EU_TYPE_CODES are exactly the eu-origin category', () => {
    expect([...EU_TYPE_CODES].sort()).toEqual(
      LEGISLATION_TYPES.filter((t) => t.category === 'eu-origin')
        .map((t) => t.code)
        .sort(),
    );
  });

  it('looks up codes case-sensitively and labels unknown codes by themselves', () => {
    expect(typeByCode('ukpga')?.label).toBe('UK Public General Acts');
    expect(typeByCode('UKPGA')).toBeUndefined();
    expect(typeLabel('wsi')).toBe('Wales Statutory Instruments');
    expect(typeLabel('zzz')).toBe('zzz');
  });
});

describe('referenceEntries', () => {
  it.each(REFERENCE_TOPICS)('topic %s has well-formed, uniquely keyed entries', (topic) => {
    const entries = referenceEntries(topic);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.key.length).toBeGreaterThan(0);
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
    }
    expect(new Set(entries.map((e) => e.key)).size).toBe(entries.length);
  });

  it('types carries one entry per code with its details', () => {
    const entries = referenceEntries('types');
    expect(entries.map((e) => e.key)).toEqual(TYPE_CODES);
    expect(entries.find((e) => e.key === 'eur')?.details).toMatchObject({
      document_main_type: 'EuropeanUnionRegulation',
    });
  });

  it('attribution quotes the exact licence lines', () => {
    const text = referenceEntries('attribution')
      .map((e) => e.description)
      .join('\n');
    expect(text).toContain(ATTRIBUTION_LINES.eu);
    expect(text).toContain(ATTRIBUTION_LINES.westlaw);
  });
});
