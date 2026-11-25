/**
 * @fileoverview Tests for outlines: the item-level outline read from a
 * recorded table of contents (containers and loose provisions, or every
 * MatchText hit), and an oversized fragment's measured child provisions.
 * @module tests/services/legislation/clml/outline.test
 */

import { describe, expect, it } from 'vitest';
import { fragmentOutline, tocOutline } from '@/services/legislation/clml/outline.js';
import {
  attr,
  child,
  findDescendant,
  parseXml,
  type XmlElement,
} from '@/services/legislation/xml.js';
import { fixture } from '../../../helpers/upstream.js';

/** A window holding every entry of the recorded outlines. */
const ALL = { offset: 0, max: 300 };

function contentsOf(name: string): XmlElement {
  const contents = child(parseXml(fixture(`clml/${name}`), 'x'), 'Contents');
  if (!contents) throw new Error('no Contents');
  return contents;
}

describe('tocOutline', () => {
  it('lists regulations and schedules of a recorded SI table of contents', () => {
    const outline = tocOutline(
      contentsOf('uksi-2019-419-contents.xml'),
      'uksi/2019/419',
      ALL,
      false,
    );
    expect(outline.leafCount).toBe(28);
    expect(outline.total).toBe(10);
    expect(outline.entries[0]).toEqual({
      provision: 'regulation/1',
      label: 'Regulation 1',
      level: 1,
      heading: 'Citation, commencement and extent',
    });
    expect(outline.entries.map((e) => e.provision)).toEqual([
      'regulation/1',
      'regulation/2',
      'regulation/3',
      'regulation/4',
      'regulation/5',
      'regulation/6',
      'regulation/7',
      'regulation/8',
      'schedule/1',
      'schedule/2',
    ]);
  });

  it('nests Parts and Chapters and walks through cross-headings without listing them', () => {
    const outline = tocOutline(
      contentsOf('ukpga-2018-12-contents.xml'),
      'ukpga/2018/12',
      ALL,
      false,
    );
    const levels = Object.fromEntries(outline.entries.map((e) => [e.provision, e.level]));
    expect(levels['part/1']).toBe(1);
    expect(levels['part/2']).toBe(1);
    expect(levels['part/2/chapter/2']).toBe(2);
    expect(levels['schedule/1']).toBe(1);
    expect(Object.keys(levels).some((p) => p.includes('crossheading'))).toBe(false);
    expect(Object.keys(levels).some((p) => p.startsWith('section/'))).toBe(false);
    expect(outline.leafCount).toBeGreaterThan(25);
  });

  it('lists every MatchText hit in match mode, flagged', () => {
    const outline = tocOutline(
      contentsOf('ukpga-2018-12-contents-text-processor.xml'),
      'ukpga/2018/12',
      ALL,
      true,
    );
    expect(outline.total).toBe(3);
    expect(outline.entries.every((e) => e.matches_text === true)).toBe(true);
    expect(outline.entries[0]).toMatchObject({ provision: 'section/3', level: 1 });
  });

  it('returns the window from the offset but keeps counting the total', () => {
    const contents = contentsOf('ukpga-2018-12-contents.xml');
    const whole = tocOutline(contents, 'ukpga/2018/12', ALL, false);
    const window = tocOutline(contents, 'ukpga/2018/12', { offset: 1, max: 2 }, false);
    expect(window.entries).toEqual(whole.entries.slice(1, 3));
    expect(window.total).toBe(whole.total);
    expect(window.leafCount).toBe(whole.leafCount);
    const past = tocOutline(contents, 'ukpga/2018/12', { offset: whole.total, max: 300 }, false);
    expect(past.entries).toEqual([]);
    expect(past.total).toBe(whole.total);
  });

  it('skips entries whose URI belongs to another item and carries status', () => {
    const contents = parseXml(
      '<Contents><ContentsItem DocumentURI="http://www.legislation.gov.uk/ukpga/2018/99/section/1"><ContentsTitle>Other</ContentsTitle></ContentsItem>' +
        '<ContentsItem IdURI="http://www.legislation.gov.uk/id/ukpga/2018/12/section/2" Status="Repealed"><ContentsNumber>2</ContentsNumber></ContentsItem></Contents>',
      'x',
    );
    const outline = tocOutline(contents, 'ukpga/2018/12', ALL, false);
    expect(outline.entries).toEqual([
      { provision: 'section/2', label: 'Section 2', level: 1, status: 'Repealed' },
    ]);
    expect(outline.leafCount).toBe(2);
  });
});

describe('fragmentOutline', () => {
  it('lists the child provisions of section 45 with their measured sizes', () => {
    const root = parseXml(fixture('clml/ukpga-2018-12-section-45.xml'), 'x');
    const p1 = findDescendant(
      root,
      (e) => attr(e, 'IdURI') === 'http://www.legislation.gov.uk/id/ukpga/2018/12/section/45',
    ) as XmlElement;
    const { entries: outline, total } = fragmentOutline(root, p1, 'ukpga/2018/12', ALL);
    expect(total).toBe(8);
    expect(outline.map((e) => e.provision)).toEqual([
      'section/45/1',
      'section/45/2',
      'section/45/2A',
      'section/45/3',
      'section/45/4',
      'section/45/5',
      'section/45/6',
      'section/45/7',
    ]);
    for (const entry of outline) {
      expect(entry.level).toBe(1);
      expect(entry.chars).toBeGreaterThan(0);
    }
    expect(outline[0]?.label).toBe('Section 45(1)');
  });

  it('keeps a numbered provision with its heading group', () => {
    const root = parseXml(fixture('clml/uksi-1984-458-made.xml'), 'x');
    const body = findDescendant(root, (e) => e.name === 'Body') as XmlElement;
    const { entries: outline } = fragmentOutline(root, body, 'uksi/1984/458', ALL);
    expect(outline).toHaveLength(18);
    expect(outline.at(-1)).toMatchObject({ provision: 'signature', label: 'Signature' });
    expect(outline[0]).toMatchObject({
      provision: 'regulation/1',
      label: 'Regulation 1',
      heading: 'Citation and commencement',
    });
  });

  it('returns the window from the offset and the whole count', () => {
    const root = parseXml(fixture('clml/uksi-1984-458-made.xml'), 'x');
    const body = findDescendant(root, (e) => e.name === 'Body') as XmlElement;
    const whole = fragmentOutline(root, body, 'uksi/1984/458', ALL).entries;
    const window = fragmentOutline(root, body, 'uksi/1984/458', { offset: 2, max: 3 });
    expect(window.entries).toEqual(whole.slice(2, 5));
    expect(window.total).toBe(18);
    expect(fragmentOutline(root, body, 'uksi/1984/458', { offset: 18, max: 300 })).toEqual({
      entries: [],
      total: 18,
    });
  });

  /** The element of a recorded fragment with this IdURI path, or the first element of this name. */
  function targetIn(root: XmlElement, item: string, target: string): XmlElement {
    return findDescendant(root, (e) =>
      target.includes('/')
        ? attr(e, 'IdURI') === `http://www.legislation.gov.uk/id/${item}/${target}`
        : e.name === target,
    ) as XmlElement;
  }

  it.each([
    [
      'uksi-1984-458-made.xml',
      'uksi/1984/458',
      'Body',
      [
        'Citation and commencement',
        'Amendment of the Social Security (Benefit) (Married Women and Widows Special Provisions) Regulations 1974',
        'Amendment of the Mobility Allowance Regulations 1975',
        'Amendment of the Mobility Allowance (Vehicle Scheme Beneficiaries) Regulations 1977',
        'Amendment of the Social Security (Claims and Payments) Regulations 1979',
        'Amendment of the Social Security (General Benefit) Regulations 1982',
        'Amendment of the Social Security (Industrial Injuries) (Prescribed Diseases) Regulations 1980',
        'Amendment of the Child Benefit (Residence and Persons Abroad) Regulations 1976',
        'Amendment of the Child Benefit (Claims and Payments) Regulations 1976',
        'Amendment of the Child Benefit (Interim Payments) Regulations 1983',
        'Amendment of the Employment Protection (Recoupment of Unemployment Benefit and Supplementary Benefit) Regulations 1977',
        'Amendment of the Supplementary Benefit (Transitional) Regulations 1980',
        'Amendment of the Supplementary Benefit (Trade Disputes and Recovery from Earnings) Regulations 1980',
        'Amendment of the Supplementary Benefit (Determination of Questions) Regulations 1980',
        'Amendment of the Supplementary Benefit (Claims and Payments) Regulations 1981',
        'Amendment of the Supplementary Benefit (Conditions of Entitlement) Regulations 1981',
        'Amendment of the Family Income Supplements (General) Regulations 1983',
        undefined,
      ],
    ],
    [
      'wsi-2024-1337-made.xml',
      'wsi/2024/1337',
      'Body',
      [
        'Title and interpretation',
        'Provisions coming into force on 1 January 2025',
        'Provisions coming into force on 1 April 2025',
        undefined,
      ],
    ],
    [
      'uksi-1998-3132-part-77-crossheading-1.xml',
      'uksi/1998/3132',
      'part/77/crossheading/1',
      [
        'Interpretation',
        'Application for a SCPO',
        'Applications by third parties to make representations and applications to vary or discharge a SCPO made by the High Court',
        'Application to vary or discharge a SCPO made by the Crown Court',
        'Where to make an application',
      ],
    ],
    ['ukpga-2018-12-section-45.xml', 'ukpga/2018/12', 'section/45', Array(8).fill(undefined)],
    ['ukpga-2018-12-section-45.xml', 'ukpga/2018/12', 'part/3/chapter/3', ['...']],
    [
      'ukpga-2018-12-section-45.xml',
      'ukpga/2018/12',
      'part/3/chapter/3/crossheading/data-subjects-right-of-access',
      ['Right of access by the data subject'],
    ],
    [
      'ukpga-2018-12-schedule-1-paragraph-2-2.xml',
      'ukpga/2018/12',
      'Schedules',
      ['Special categories of personal data and criminal convictions etc data'],
    ],
    [
      'ukpga-2018-12-schedule-1-paragraph-2-2.xml',
      'ukpga/2018/12',
      'schedule/1/part/1/crossheading/health-or-social-care-purposes',
      [undefined],
    ],
    ['eur-2016-679-article-28.xml', 'eur/2016/679', 'chapter/IV', ['General obligations']],
  ])('keeps the entry headings of %s under %s %s', (name, item, target, headings) => {
    const root = parseXml(fixture(`clml/${name}`), 'x');
    const { entries } = fragmentOutline(root, targetIn(root, item, target), item, ALL);
    expect(entries.map((e) => e.heading)).toEqual(headings);
  });

  it('heads a child cross-heading that carries only a number by its number', () => {
    const root = parseXml(fixture('clml/uksi-1998-3132-rule-77.3.xml'), 'x');
    const part = targetIn(root, 'uksi/1998/3132', 'part/77');
    const { entries } = fragmentOutline(root, part, 'uksi/1998/3132', ALL);
    expect(entries).toEqual([
      {
        provision: 'part/77/crossheading/1',
        label: 'Part 77 Cross-heading 1',
        level: 1,
        heading: 'SECTION 1 – SERIOUS CRIME PREVENTION ORDERS',
        chars: expect.any(Number),
      },
    ]);
  });

  it('heads each child as a read of it is headed, past a heading group holding several', () => {
    const uri = (p: string) => `http://www.legislation.gov.uk/ukpga/2018/12/${p}`;
    const root = parseXml(
      '<Legislation><Body>' +
        `<PsubBlock DocumentURI="${uri('part/1/crossheading/a')}"><Number>Sub-heading A</Number><P><Text>t</Text></P></PsubBlock>` +
        `<P1group><Title>Shared heading</Title><P1 DocumentURI="${uri('section/2')}"><Text>Two</Text></P1><P1 DocumentURI="${uri('section/3')}"><Text>Three</Text></P1></P1group>` +
        `<Part DocumentURI="${uri('part/9')}"><Number>PART 9</Number><P><Text>t</Text></P></Part>` +
        '</Body></Legislation>',
      'x',
    );
    const body = findDescendant(root, (e) => e.name === 'Body') as XmlElement;
    const { entries } = fragmentOutline(root, body, 'ukpga/2018/12', ALL);
    expect(entries.map((e) => [e.provision, e.heading])).toEqual([
      ['part/1/crossheading/a', 'Sub-heading A'],
      ['section/2', 'Shared heading'],
      ['section/3', 'Shared heading'],
      ['part/9', undefined],
    ]);
  });

  it('drops a child provision of another item before cutting the window', () => {
    const root = parseXml(
      '<Legislation><Body>' +
        '<P1 DocumentURI="http://www.legislation.gov.uk/ukpga/2018/99/section/1"><Text>Other item</Text></P1>' +
        '<P1 DocumentURI="http://www.legislation.gov.uk/ukpga/2018/12/section/1"><Text>One</Text></P1>' +
        '<P1 DocumentURI="http://www.legislation.gov.uk/ukpga/2018/12/section/2"><Text>Two</Text></P1>' +
        '</Body></Legislation>',
      'x',
    );
    const body = findDescendant(root, (e) => e.name === 'Body') as XmlElement;
    const outline = fragmentOutline(root, body, 'ukpga/2018/12', { offset: 0, max: 1 });
    expect(outline.total).toBe(2);
    expect(outline.entries.map((e) => e.provision)).toEqual(['section/1']);
  });
});
