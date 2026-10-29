/**
 * @fileoverview Tests for effect records — one shape for document
 * `ukm:UnappliedEffect` and feed `ukm:Effect` — provision matching at a
 * path-segment boundary (whole-item effects kept, citation prefixes not
 * targets), the one-way match against
 * an enclosing element, and outstanding-first order.
 * @module tests/services/legislation/clml/effects.test
 */

import { describe, expect, it } from 'vitest';
import { parseChangesFeed } from '@/services/legislation/atom/changes-feed.js';
import {
  effectEncloses,
  effectTouches,
  parseEffect,
  sortOutstandingFirst,
} from '@/services/legislation/clml/effects.js';
import { readMetadata } from '@/services/legislation/clml/metadata.js';
import type { EffectRecord } from '@/services/legislation/types.js';
import { findDescendant, parseXml } from '@/services/legislation/xml.js';
import { fixture } from '../../../helpers/upstream.js';

function effectsOf(name: string): EffectRecord[] {
  return readMetadata(parseXml(fixture(`clml/${name}`), 'a document')).unappliedEffects;
}

const NS = 'xmlns:ukm="http://www.legislation.gov.uk/namespaces/metadata"';

function effect(xml: string): EffectRecord {
  const root = parseXml(`<root ${NS}>${xml}</root>`, 'x');
  const el = findDescendant(
    root,
    (e) => e.name === 'ukm:Effect' || e.name === 'ukm:UnappliedEffect',
  );
  if (!el) throw new Error('no effect');
  return parseEffect(el);
}

describe('parseEffect', () => {
  it('parses a recorded unapplied effect with every field', () => {
    const effects = effectsOf('ukpga-2018-12-section-45.xml');
    const s45 = effects.find((e) => e.affected.provisions_label === 's. 45(2)(f)');
    expect(s45).toEqual({
      effect_id: 'key-b2f16c7ececa7c327dbbc12f65cf8aa8',
      type: 'word substituted',
      applied: false,
      requires_applied: true,
      outstanding: true,
      affected: {
        item: 'ukpga/2018/12',
        id_uri: 'https://www.legislation.gov.uk/id/ukpga/2018/12',
        title: 'Data Protection Act 2018',
        provisions_label: 's. 45(2)(f)',
        provisions: [
          {
            label: 's. 45(2)(f)',
            uri: 'https://www.legislation.gov.uk/id/ukpga/2018/12/section/45/2/f',
          },
        ],
      },
      affecting: expect.objectContaining({
        item: 'uksi/2026/386',
        provisions_label: 'Sch. 2 para. 23(2)(3)',
      }),
      commencement_authority: [
        {
          label: 'reg. 1(2)',
          uri: 'https://www.legislation.gov.uk/id/uksi/2026/386/regulation/1/2',
        },
      ],
      savings: [],
      in_force: [{ date: '2026-09-30', qualification: 'wholly in force', applied: false }],
      extent: 'same as affected',
      modified: '2026-09-25T14:19:14Z',
    });
  });

  it('marks an unapplied effect applied:false even if its attributes say otherwise', () => {
    const e = effect(
      '<ukm:UnappliedEffect EffectId="k" Type="repealed" Applied="true" RequiresApplied="true"/>',
    );
    expect(e.applied).toBe(false);
    expect(e.outstanding).toBe(true);
  });

  it('an effect that needs no text change is not outstanding', () => {
    const e = effect('<ukm:UnappliedEffect EffectId="k" Type="savings" RequiresApplied="false"/>');
    expect(e).toMatchObject({ applied: false, requires_applied: false, outstanding: false });
  });

  it('a feed effect already applied is not outstanding', () => {
    const e = effect(
      '<ukm:Effect EffectId="k" Type="inserted" Applied="true" RequiresApplied="true"/>',
    );
    expect(e).toMatchObject({ applied: true, outstanding: false });
  });

  it('a feed effect that omits Applied but requires a change is outstanding', () => {
    const e = effect('<ukm:Effect EffectId="k" Type="inserted" RequiresApplied="true"/>');
    expect(e.applied).toBeUndefined();
    expect(e.outstanding).toBe(true);
  });

  it('counts an unreported Applied or RequiresApplied toward outstanding, never an explicit no', () => {
    const bare = effect('<ukm:Effect EffectId="k" Type="inserted"/>');
    expect(bare).not.toHaveProperty('applied');
    expect(bare).not.toHaveProperty('requires_applied');
    expect(bare.outstanding).toBe(true);
    const noChange = effect('<ukm:Effect EffectId="k" Type="savings" RequiresApplied="false"/>');
    expect(noChange.outstanding).toBe(false);
  });

  it('keeps the Welsh flags, Missing sections, and Notes; falls back to URI for the id', () => {
    const e = effect(
      '<ukm:Effect URI="http://www.legislation.gov.uk/id/effect/x" Type="inserted" Applied="false" RequiresApplied="true" RequiresWelshApplied="true" WelshApplied="false" Notes="Not yet in force" AffectingEffectsExtent="E+W">' +
        '<ukm:AffectedProvisions><ukm:Section URI="http://www.legislation.gov.uk/id/anaw/2016/1/section/198A" Missing="true">s. 198A</ukm:Section></ukm:AffectedProvisions>' +
        '<ukm:Savings><ukm:Section URI="http://www.legislation.gov.uk/id/wsi/2019/110/regulation/5">reg. 5</ukm:Section></ukm:Savings>' +
        '<ukm:InForceDates><ukm:InForce Prospective="true" CommencingURI="http://www.legislation.gov.uk/id/asc/2026/5/section/1"/></ukm:InForceDates>' +
        '</ukm:Effect>',
    );
    expect(e).toMatchObject({
      effect_id: 'http://www.legislation.gov.uk/id/effect/x',
      welsh_requires_applied: true,
      welsh_applied: false,
      notes: 'Not yet in force',
      extent: 'E+W',
      affected: {
        provisions: [
          {
            label: 's. 198A',
            uri: 'https://www.legislation.gov.uk/id/anaw/2016/1/section/198A',
            missing: true,
          },
        ],
      },
      savings: [
        { label: 'reg. 5', uri: 'https://www.legislation.gov.uk/id/wsi/2019/110/regulation/5' },
      ],
      in_force: [
        {
          prospective: true,
          commencing_uri: 'https://www.legislation.gov.uk/id/asc/2026/5/section/1',
        },
      ],
    });
  });

  it('omits the in-force date of a recorded effect that has none', () => {
    const effects = effectsOf('ukpga-2018-12-section-45.xml');
    const undated = effects.filter((e) => e.in_force.every((f) => f.date === undefined));
    expect(undated.length).toBeGreaterThan(0);
    for (const e of undated) for (const f of e.in_force) expect(f).not.toHaveProperty('date');
  });

  it('reads the recorded Welsh-item effects with their Welsh flags', () => {
    const effects = effectsOf('anaw-2016-1-section-1-welsh.xml');
    expect(effects).toHaveLength(6);
    expect(effects.every((e) => e.welsh_requires_applied === true)).toBe(true);
    const missing = effects.find((e) => e.affected.provisions_label === 's. 198A');
    expect(missing?.affected.provisions[0]?.missing).toBe(true);
  });

  it('reads a recorded section range as one reference with its start, end, and missing end', () => {
    const effects = effectsOf('anaw-2016-1-section-1-welsh.xml');
    const range = effects.find((e) => e.affected.provisions_label === 's. 186A-186C');
    expect(range?.affected.provisions).toEqual([
      {
        label: 's. 186A-186C',
        uri: 'https://www.legislation.gov.uk/id/anaw/2016/1/section/186A',
        up_to: 'https://www.legislation.gov.uk/id/anaw/2016/1/section/186C',
        missing: true,
      },
    ]);
  });

  it('keeps sections and ranges in document order on every provision list', () => {
    const e = effect(
      '<ukm:Effect EffectId="k" Type="repealed"><ukm:AffectedProvisions>' +
        '<ukm:Section URI="http://www.legislation.gov.uk/id/ukpga/2018/12/section/64">s. 64</ukm:Section>, ' +
        '<ukm:SectionRange URI="http://www.legislation.gov.uk/id/ukpga/2018/12/section/65/2" UpTo="http://www.legislation.gov.uk/id/ukpga/2018/12/section/65/4">' +
        '<ukm:Section URI="http://www.legislation.gov.uk/id/ukpga/2018/12/section/65/2">s. 65(2)</ukm:Section>-<ukm:Section URI="http://www.legislation.gov.uk/id/ukpga/2018/12/section/65/4">(4)</ukm:Section>' +
        '</ukm:SectionRange></ukm:AffectedProvisions>' +
        '<ukm:Savings><ukm:SectionRange URI="http://www.legislation.gov.uk/id/uksi/2026/1/regulation/3" UpTo="http://www.legislation.gov.uk/id/uksi/2026/1/regulation/5" MissingStart="true">' +
        '<ukm:Section URI="http://www.legislation.gov.uk/id/uksi/2026/1/regulation/3">regs. 3</ukm:Section>-<ukm:Section URI="http://www.legislation.gov.uk/id/uksi/2026/1/regulation/5">5</ukm:Section>' +
        '</ukm:SectionRange></ukm:Savings></ukm:Effect>',
    );
    expect(e.affected.provisions).toEqual([
      { label: 's. 64', uri: 'https://www.legislation.gov.uk/id/ukpga/2018/12/section/64' },
      {
        label: 's. 65(2)-(4)',
        uri: 'https://www.legislation.gov.uk/id/ukpga/2018/12/section/65/2',
        up_to: 'https://www.legislation.gov.uk/id/ukpga/2018/12/section/65/4',
      },
    ]);
    expect(e.savings).toEqual([
      {
        label: 'regs. 3-5',
        uri: 'https://www.legislation.gov.uk/id/uksi/2026/1/regulation/3',
        up_to: 'https://www.legislation.gov.uk/id/uksi/2026/1/regulation/5',
        missing: true,
      },
    ]);
  });
});

describe('effectTouches', () => {
  const on = (uris: string[]): EffectRecord => ({
    effect_id: 'k',
    type: 'words substituted',
    outstanding: true,
    affected: {
      provisions: uris.map((uri) => ({
        label: uri,
        uri: `https://www.legislation.gov.uk/id/${uri}`,
      })),
    },
    affecting: { provisions: [] },
    commencement_authority: [],
    savings: [],
    in_force: [],
  });

  it('matches the provision itself and its descendants', () => {
    expect(
      effectTouches(on(['ukpga/2018/12/section/45']), 'affected', 'ukpga/2018/12/section/45'),
    ).toBe(true);
    expect(
      effectTouches(on(['ukpga/2018/12/section/45/2/f']), 'affected', 'ukpga/2018/12/section/45'),
    ).toBe(true);
  });

  it('never matches a sibling that shares a prefix', () => {
    expect(
      effectTouches(on(['ukpga/2018/12/section/45A']), 'affected', 'ukpga/2018/12/section/45'),
    ).toBe(false);
    expect(
      effectTouches(on(['ukpga/2018/12/section/450']), 'affected', 'ukpga/2018/12/section/45'),
    ).toBe(false);
  });

  it('does not match the same path on another item', () => {
    expect(
      effectTouches(on(['ukpga/2018/13/section/45']), 'affected', 'ukpga/2018/12/section/45'),
    ).toBe(false);
  });

  it('keeps a whole-item effect (no provision URI on that side) for every provision', () => {
    expect(effectTouches(on([]), 'affected', 'ukpga/2018/12/section/45')).toBe(true);
    const recorded = effectsOf('uksi-1985-2081-contents-made.xml')[0];
    expect(recorded).toMatchObject({ type: 'revoked', affected: { provisions: [] } });
    expect(effectTouches(recorded as EffectRecord, 'affected', 'uksi/1985/2081/regulation/1')).toBe(
      true,
    );
  });

  it('reads the side the direction names', () => {
    const e = on(['ukpga/2018/12/section/45']);
    e.affecting.provisions = [
      { label: 'x', uri: 'https://www.legislation.gov.uk/id/uksi/2026/386/regulation/2' },
    ];
    expect(effectTouches(e, 'affecting', 'uksi/2026/386/regulation/2')).toBe(true);
    expect(effectTouches(e, 'affecting', 'ukpga/2018/12/section/45')).toBe(false);
  });

  it('filters the recorded section 45 fragment to the three effects on s. 45', () => {
    const effects = effectsOf('ukpga-2018-12-section-45.xml');
    expect(effects).toHaveLength(7);
    const touching = effects.filter((e) =>
      effectTouches(e, 'affected', 'ukpga/2018/12/section/45'),
    );
    expect(touching.map((e) => e.affected.provisions_label)).toEqual([
      's. 45(2)(f)',
      's. 45(5)(c)(d)',
      's. 45(7)(b)',
    ]);
  });

  it('attributes a recorded section-range effect to its range, not the whole item', () => {
    const effects = effectsOf('anaw-2016-1-section-1-welsh.xml');
    const range = effects.find((e) => e.affected.provisions_label === 's. 186A-186C');
    expect(range).toBeDefined();
    expect(effectTouches(range as EffectRecord, 'affected', 'anaw/2016/1/section/1')).toBe(false);
    expect(effectTouches(range as EffectRecord, 'affected', 'anaw/2016/1/section/186B')).toBe(true);
  });

  it('never attributes an effect on an enclosing Part, Chapter or cross-heading to a section', () => {
    for (const container of [
      'ukpga/2006/46/part/3',
      'ukpga/2006/46/part/3/chapter/3',
      'ukpga/2006/46/part/3/chapter/3/crossheading/x',
    ]) {
      expect(effectTouches(on([container]), 'affected', 'ukpga/2006/46/section/29')).toBe(false);
    }
  });

  it('matches an ancestor of the provision named, at a segment boundary', () => {
    const onS45 = on(['ukpga/2018/12/section/45']);
    expect(effectTouches(onS45, 'affected', 'ukpga/2018/12/section/45/2')).toBe(true);
    expect(effectTouches(onS45, 'affected', 'ukpga/2018/12/section/45/2/f')).toBe(true);
    expect(effectTouches(onS45, 'affected', 'ukpga/2018/12/section/45A/2')).toBe(false);
    expect(effectTouches(onS45, 'affected', 'ukpga/2018/12/section/4')).toBe(false);
  });

  describe('citation prefixes', () => {
    const ITEM = 'ukpga/2006/46';
    const recorded = parseChangesFeed(
      fixture('feeds/changes-unapplied-affected-ukpga-2006-46.feed'),
    ).effects;
    /** Labels of the recorded effects naming a provision that touch `provision`, in feed order. */
    const touching = (provision: string) =>
      recorded
        .filter(
          (e) =>
            e.affected.provisions.length > 0 &&
            effectTouches(e, 'affected', `${ITEM}/${provision}`),
        )
        .map((e) => e.affected.provisions_label);
    const SCHEDULE_10 = [
      'Sch. 10 para. 6(1)(c)',
      'Sch. 10 para. 6(2D)',
      'Sch. 10 para. 7(2)(a)(ii)',
      'Sch. 10 para. 7(2)(b)(ii)',
      'Sch. 10 para. 7(2A)',
    ];

    it('records "Sch. 10 para. 6(1)(c)" as its schedule/10 prefix and its target', () => {
      const sch10 = recorded.find((e) => e.affected.provisions_label === 'Sch. 10 para. 6(1)(c)');
      expect(sch10?.affected.provisions.map((p) => p.uri)).toEqual([
        'https://www.legislation.gov.uk/id/ukpga/2006/46/schedule/10',
        'https://www.legislation.gov.uk/id/ukpga/2006/46/schedule/10/paragraph/6/1/c',
      ]);
    });

    it('never matches another provision under the prefix', () => {
      expect(touching('schedule/10/paragraph/1')).toEqual([]);
      expect(touching('schedule/10/paragraph/6')).toEqual([
        'Sch. 10 para. 6(1)(c)',
        'Sch. 10 para. 6(2D)',
      ]);
      expect(touching('schedule/10/paragraph/7/2/a')).toEqual(['Sch. 10 para. 7(2)(a)(ii)']);
      expect(touching('part/3/chapter/2')).toEqual([]);
      expect(touching('part/3/chapter/3')).toEqual(['Pt. 3 Ch. 3']);
    });

    it('still matches every effect inside a provision the prefix names', () => {
      expect(touching('schedule/10')).toEqual(SCHEDULE_10);
      expect(touching('part/3')).toEqual(['Pt. 3 Ch. 3']);
    });

    it('keeps a range cited under its prefix to the range', () => {
      expect(touching('schedule/7/paragraph/8')).toEqual(['Sch. 7 para. 5-11']);
      expect(touching('schedule/7/paragraph/1')).toEqual([]);
      expect(touching('schedule/7/paragraph/12')).toEqual([]);
      expect(touching('schedule/7')).toEqual(['Sch. 7 para. 5-11']);
    });

    it('keeps the recorded whole-item effects for every provision', () => {
      const whole = recorded.filter((e) => e.affected.provisions.length === 0);
      expect(whole.map((e) => e.affected.provisions_label)).toEqual(['Act', 'Act']);
      for (const provision of ['schedule/10/paragraph/1', 'part/3/chapter/2', 'section/29']) {
        for (const e of whole)
          expect(effectTouches(e, 'affected', `${ITEM}/${provision}`)).toBe(true);
      }
    });

    it('still matches everything under an effect naming one provision URI', () => {
      const onSchedule = on([`${ITEM}/schedule/10`]);
      expect(effectTouches(onSchedule, 'affected', `${ITEM}/schedule/10/paragraph/1`)).toBe(true);
      expect(effectTouches(onSchedule, 'affected', `${ITEM}/schedule/1`)).toBe(false);
    });

    it('reads the affecting side the same way', () => {
      const e = on([]);
      e.affecting.provisions = ['schedule/2', 'schedule/2/paragraph/3'].map((p) => ({
        label: 'Sch. 2 para. 3',
        uri: `https://www.legislation.gov.uk/id/uksi/2026/386/${p}`,
      }));
      expect(effectTouches(e, 'affecting', 'uksi/2026/386/schedule/2/paragraph/1')).toBe(false);
      expect(effectTouches(e, 'affecting', 'uksi/2026/386/schedule/2/paragraph/3/1')).toBe(true);
      expect(effectTouches(e, 'affecting', 'uksi/2026/386/schedule/2')).toBe(true);
    });
  });

  describe('ranges', () => {
    const ITEM = 'ukpga/2018/12';
    const range = (from: string, upTo: string): EffectRecord => {
      const e = on([]);
      e.affected.provisions = [
        {
          label: `${from}-${upTo}`,
          uri: `https://www.legislation.gov.uk/id/${ITEM}/${from}`,
          up_to: `https://www.legislation.gov.uk/id/${ITEM}/${upTo}`,
        },
      ];
      return e;
    };
    const touched = (e: EffectRecord, provisions: string[]) =>
      provisions.filter((p) => effectTouches(e, 'affected', `${ITEM}/${p}`));

    it('matches provisions between the endpoints, the endpoints, their descendants and ancestors', () => {
      const s65 = range('section/65/2', 'section/65/4');
      expect(
        touched(s65, [
          'section/65',
          'section/65/2',
          'section/65/2/a',
          'section/65/3',
          'section/65/3/b',
          'section/65/4',
          'section/65/4/c',
          'section/65/1',
          'section/65/5',
          'section/650',
          'section/66',
          'section/64/3',
          'section/65/a',
          'schedule/65/3',
        ]),
      ).toEqual([
        'section/65',
        'section/65/2',
        'section/65/2/a',
        'section/65/3',
        'section/65/3/b',
        'section/65/4',
        'section/65/4/c',
      ]);
    });

    it('orders numbered segments by number, then by suffix as inserted provisions sit', () => {
      const e = range('section/186A', 'section/186C');
      expect(
        touched(e, [
          'section/186',
          'section/186A',
          'section/186AA',
          'section/186B',
          'section/186C',
          'section/186D',
          'section/186ZA',
          'section/1',
          'section/1860',
        ]),
      ).toEqual(['section/186A', 'section/186AA', 'section/186B', 'section/186C']);
    });

    it('orders letters alphabetically, so an inserted (ma) falls between (m) and (n)', () => {
      const e = range('section/20/3/m', 'section/20/3/o');
      expect(
        touched(e, [
          'section/20/3/l',
          'section/20/3/m',
          'section/20/3/ma',
          'section/20/3/n',
          'section/20/3/p',
        ]),
      ).toEqual(['section/20/3/m', 'section/20/3/ma', 'section/20/3/n']);
    });

    it('reads roman numerals by value as well as by letter', () => {
      const low = range('section/5/1/a/i', 'section/5/1/a/iv');
      expect(
        touched(low, [
          'section/5/1/a/ii',
          'section/5/1/a/iii',
          'section/5/1/a/ia',
          'section/5/1/a/v',
        ]),
      ).toEqual(['section/5/1/a/ii', 'section/5/1/a/iii', 'section/5/1/a/ia']);
      const wide = range('section/5/1/a/ii', 'section/5/1/a/ix');
      expect(
        touched(wide, [
          'section/5/1/a/v',
          'section/5/1/a/viii',
          'section/5/1/a/x',
          'section/5/1/a/i',
        ]),
      ).toEqual(['section/5/1/a/v', 'section/5/1/a/viii']);
    });

    it('spans endpoints at different depths', () => {
      const e = range('schedule/2/paragraph/3/1', 'schedule/2/paragraph/5');
      expect(
        touched(e, [
          'schedule/2/paragraph/2',
          'schedule/2/paragraph/3',
          'schedule/2/paragraph/3/2',
          'schedule/2/paragraph/4',
          'schedule/2/paragraph/5/1',
          'schedule/2/paragraph/6',
          'schedule/3/paragraph/4',
          'schedule/2/part/1',
        ]),
      ).toEqual([
        'schedule/2/paragraph/3',
        'schedule/2/paragraph/3/2',
        'schedule/2/paragraph/4',
        'schedule/2/paragraph/5/1',
      ]);
    });
  });
});

describe('effectEncloses', () => {
  const ITEM = 'ukpga/2006/46';
  const on = (...refs: (string | [string, string])[]): EffectRecord => ({
    effect_id: 'k',
    type: 'excluded',
    outstanding: true,
    affected: {
      provisions: refs.map((ref) =>
        typeof ref === 'string'
          ? { label: ref, uri: `https://www.legislation.gov.uk/id/${ITEM}/${ref}` }
          : {
              label: ref.join('-'),
              uri: `https://www.legislation.gov.uk/id/${ITEM}/${ref[0]}`,
              up_to: `https://www.legislation.gov.uk/id/${ITEM}/${ref[1]}`,
            },
      ),
    },
    affecting: { provisions: [] },
    commencement_authority: [],
    savings: [],
    in_force: [],
  });
  /** The enclosing elements, of those given, that the effect reaches. */
  const reached = (e: EffectRecord, enclosing: string[]) =>
    enclosing.filter((p) => effectEncloses(e, 'affected', `${ITEM}/${p}`));
  const CHAPTER_3 = ['part/3', 'part/3/chapter/3', 'part/3/chapter/3/crossheading/x'];

  it('reaches the element named and every element inside it', () => {
    expect(reached(on('part/3/chapter/3'), CHAPTER_3)).toEqual([
      'part/3/chapter/3',
      'part/3/chapter/3/crossheading/x',
    ]);
    expect(reached(on('part/3'), CHAPTER_3)).toEqual(CHAPTER_3);
  });

  it('does not reach from a sibling inside an enclosing element, or from another kind', () => {
    expect(reached(on('part/3/chapter/4'), CHAPTER_3)).toEqual([]);
    expect(reached(on('part/3/chapter/3/crossheading/y'), CHAPTER_3)).toEqual([]);
    expect(reached(on('part/4'), CHAPTER_3)).toEqual([]);
    expect(reached(on('section/29'), CHAPTER_3)).toEqual([]);
    expect(reached(on('schedule/3'), CHAPTER_3)).toEqual([]);
  });

  it('reaches through a range covering the element, never one with an end inside it', () => {
    expect(reached(on(['part/2', 'part/4']), CHAPTER_3)).toEqual(CHAPTER_3);
    expect(reached(on(['part/3/chapter/1', 'part/3/chapter/5']), CHAPTER_3)).toEqual([
      'part/3/chapter/3',
      'part/3/chapter/3/crossheading/x',
    ]);
    expect(reached(on(['part/3/chapter/4', 'part/5']), CHAPTER_3)).toEqual([]);
    expect(reached(on(['part/1', 'part/3/chapter/2']), CHAPTER_3)).toEqual([]);
    expect(reached(on(['part/4', 'part/6']), CHAPTER_3)).toEqual([]);
  });

  it('orders roman numerals by value, as pre-1963 Parts are numbered', () => {
    expect(reached(on(['part/II', 'part/IV']), ['part/III', 'part/V', 'part/I'])).toEqual([
      'part/III',
    ]);
  });

  it('leaves a whole-item effect, and one on another item, unmatched', () => {
    expect(reached(on(), CHAPTER_3)).toEqual([]);
    const other = on('part/3');
    other.affected.provisions = [
      { label: 'Pt. 3', uri: 'https://www.legislation.gov.uk/id/ukpga/2006/47/part/3' },
    ];
    expect(reached(other, CHAPTER_3)).toEqual([]);
  });

  it('reads a recorded "Pt. 3 Ch. 3" citation as the Chapter alone, not its Part prefix', () => {
    const feed = parseChangesFeed(fixture('feeds/changes-unapplied-affected-ukpga-2006-46.feed'));
    const chapter = feed.effects.find((e) => e.affected.provisions_label === 'Pt. 3 Ch. 3');
    expect(chapter?.affected.provisions.map((p) => p.uri)).toEqual([
      'https://www.legislation.gov.uk/id/ukpga/2006/46/part/3',
      'https://www.legislation.gov.uk/id/ukpga/2006/46/part/3/chapter/3',
    ]);
    const e = chapter as EffectRecord;
    expect(reached(e, ['part/3', 'part/3/chapter/3'])).toEqual(['part/3/chapter/3']);
    expect(reached(e, ['part/3', 'part/3/chapter/2'])).toEqual([]);
    expect(effectTouches(e, 'affected', `${ITEM}/section/29`)).toBe(false);
  });

  it('finds the recorded Civil Procedure Rules effects on Part 77 and its first cross-heading', () => {
    const feed = parseChangesFeed(fixture('feeds/changes-unapplied-affected-uksi-1998-3132.feed'));
    const labels = (enclosing: string) =>
      feed.effects
        .filter((e) => effectEncloses(e, 'affected', `uksi/1998/3132/${enclosing}`))
        .map((e) => e.affected.provisions_label);
    expect(labels('part/77')).toEqual([
      'Pt. 77 Table of Contents',
      'Pt. 77 Table of Contents',
      'Pt. 77 Table of Contents',
    ]);
    expect(labels('part/77/crossheading/1')).toEqual([
      'Pt. 77 Table of Contents',
      'Pt. 77 Table of Contents',
      'Pt. 77 Table of Contents',
      'rule 77.3 heading',
    ]);
  });
});

describe('sortOutstandingFirst', () => {
  const make = (id: string, outstanding: boolean, dates: (string | undefined)[]): EffectRecord => ({
    effect_id: id,
    type: 't',
    outstanding,
    affected: { provisions: [] },
    affecting: { provisions: [] },
    commencement_authority: [],
    savings: [],
    in_force: dates.map((date) => (date ? { date } : {})),
  });

  it('orders outstanding first, then by earliest in-force date, undated last', () => {
    const sorted = sortOutstandingFirst([
      make('done-early', false, ['2019-01-01']),
      make('open-undated', true, [undefined]),
      make('open-late', true, ['2026-09-30']),
      make('open-early', true, ['2027-01-01', '2020-01-01']),
    ]);
    expect(sorted.map((e) => e.effect_id)).toEqual([
      'open-early',
      'open-late',
      'open-undated',
      'done-early',
    ]);
  });

  it('does not mutate its input', () => {
    const input = [make('a', false, []), make('b', true, [])];
    sortOutstandingFirst(input);
    expect(input.map((e) => e.effect_id)).toEqual(['a', 'b']);
  });
});
