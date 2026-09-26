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
      300,
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
      300,
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
      300,
      true,
    );
    expect(outline.total).toBe(3);
    expect(outline.entries.every((e) => e.matches_text === true)).toBe(true);
    expect(outline.entries[0]).toMatchObject({ provision: 'section/3', level: 1 });
  });

  it('caps the entries but keeps counting the total', () => {
    const outline = tocOutline(contentsOf('ukpga-2018-12-contents.xml'), 'ukpga/2018/12', 2, false);
    expect(outline.entries).toHaveLength(2);
    expect(outline.total).toBeGreaterThan(2);
  });

  it('skips entries whose URI belongs to another item and carries status', () => {
    const contents = parseXml(
      '<Contents><ContentsItem DocumentURI="http://www.legislation.gov.uk/ukpga/2018/99/section/1"><ContentsTitle>Other</ContentsTitle></ContentsItem>' +
        '<ContentsItem IdURI="http://www.legislation.gov.uk/id/ukpga/2018/12/section/2" Status="Repealed"><ContentsNumber>2</ContentsNumber></ContentsItem></Contents>',
      'x',
    );
    const outline = tocOutline(contents, 'ukpga/2018/12', 300, false);
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
    const outline = fragmentOutline(root, p1, 'ukpga/2018/12', 300);
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
    const outline = fragmentOutline(root, body, 'uksi/1984/458', 300);
    expect(outline).toHaveLength(18);
    expect(outline.at(-1)).toMatchObject({ provision: 'signature', label: 'Signature' });
    expect(outline[0]).toMatchObject({
      provision: 'regulation/1',
      label: 'Regulation 1',
      heading: 'Citation and commencement',
    });
  });

  it('honours the cap', () => {
    const root = parseXml(fixture('clml/uksi-1984-458-made.xml'), 'x');
    const body = findDescendant(root, (e) => e.name === 'Body') as XmlElement;
    expect(fragmentOutline(root, body, 'uksi/1984/458', 3)).toHaveLength(3);
  });
});
