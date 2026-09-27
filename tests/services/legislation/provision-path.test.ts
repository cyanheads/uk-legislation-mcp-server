/**
 * @fileoverview Tests for item, provision, and version normalization: item
 * paths and legislation.gov.uk URIs (split into provision, version, language),
 * citation shorthand, enacted-keyword mapping, calendar validation, labels.
 * @module tests/services/legislation/provision-path.test
 */

import { describe, expect, it } from 'vitest';
import {
  isCalendarDate,
  isEnactedKeyword,
  normalizeProvision,
  parseItemInput,
  provisionFromUri,
  provisionLabel,
  splitLeadingProvision,
  splitProvisionTail,
  versionSegment,
} from '@/services/legislation/provision-path.js';

describe('parseItemInput', () => {
  it('parses a full item path', () => {
    expect(parseItemInput('ukpga/2018/12')).toEqual({
      item: {
        path: 'ukpga/2018/12',
        type: 'ukpga',
        year: '2018',
        number: '12',
        full: true,
        regnal: false,
      },
    });
  });

  it.each([
    'https://www.legislation.gov.uk/id/ukpga/2018/12',
    'http://www.legislation.gov.uk/ukpga/2018/12',
    'legislation.gov.uk/ukpga/2018/12',
    'www.legislation.gov.uk/ukpga/2018/12/',
    'https://www.legislation.gov.uk/ukpga/2018/12/contents',
    'https://www.legislation.gov.uk/ukpga/2018/12/data.xml',
    'https://www.legislation.gov.uk/ukpga/2018/12?view=plain#top',
    '/ukpga/2018/12/',
    'UKPGA/2018/12',
  ])('accepts the item URI form %s', (input) => {
    expect(parseItemInput(input)?.item.path).toBe('ukpga/2018/12');
  });

  it('splits a provision, version, and Welsh language out of a URI', () => {
    expect(
      parseItemInput('http://www.legislation.gov.uk/ukpga/2018/12/section/45/enacted/data.xml'),
    ).toMatchObject({
      item: { path: 'ukpga/2018/12' },
      provision: 'section/45',
      version: 'enacted',
    });
    expect(parseItemInput('anaw/2016/1/section/1/welsh')).toMatchObject({
      provision: 'section/1',
      language: 'cy',
    });
    expect(parseItemInput('uksi/2019/419/regulation/5/made')).toMatchObject({
      provision: 'regulation/5',
      version: 'made',
    });
    expect(parseItemInput('ukpga/2018/12/section/45/2020-01-01')).toMatchObject({
      version: '2020-01-01',
    });
    expect(parseItemInput('ukpga/2018/12/section/45/prospective')?.version).toBe('prospective');
  });

  it('skips an extent segment inside a URI', () => {
    expect(parseItemInput('ukpga/2018/12/section/45/england+wales')).toMatchObject({
      provision: 'section/45',
    });
  });

  it('parses regnal-year items as two year segments', () => {
    expect(parseItemInput('ukpga/Eliz2/3-4/19')?.item).toEqual({
      path: 'ukpga/Eliz2/3-4/19',
      type: 'ukpga',
      year: 'Eliz2/3-4',
      number: '19',
      full: true,
      regnal: true,
    });
    expect(parseItemInput('aep/Ann/6/11')?.item).toMatchObject({ year: 'Ann/6', regnal: true });
  });

  it('accepts ISBN-numbered drafts and lower-case roman Local Act numbers', () => {
    expect(parseItemInput('ukdsi/2026/9780348287233')?.item).toMatchObject({
      number: '9780348287233',
      full: true,
    });
    expect(parseItemInput('ukla/1980/xliii')?.item.full).toBe(true);
  });

  it('returns partial paths only when allowed', () => {
    expect(parseItemInput('ukpga/2018')).toBeUndefined();
    expect(parseItemInput('ukpga/2018', { allowPartial: true })?.item).toEqual({
      path: 'ukpga/2018',
      type: 'ukpga',
      year: '2018',
      full: false,
      regnal: false,
    });
    expect(parseItemInput('uksi', { allowPartial: true })?.item).toMatchObject({
      path: 'uksi',
      full: false,
    });
  });

  it.each([
    'xyz/2018/12',
    'https://example.org/ukpga/2018/12',
    'https://www.legislation.gov.uk/id',
    'ukpga/2018/12/foo/1',
    'ukpga/2018/12/section',
    'ukpga/2018/12/introduction/2',
    'ukpga/twenty/12',
    '',
  ])('rejects %j', (input) => {
    expect(parseItemInput(input, { allowPartial: true })).toBeUndefined();
  });
});

describe('normalizeProvision', () => {
  it.each([
    ['s. 45(2)(f)', 'section/45/2/f'],
    ['s.45A', 'section/45A'],
    ['section 45', 'section/45'],
    ['s. 45 (2) (f)', 'section/45/2/f'],
    ['reg. 5', 'regulation/5'],
    ['art. 28(3)', 'article/28/3'],
    ['Article 28', 'article/28'],
    ['r. 7', 'rule/7'],
    ['r. 3.4', 'rule/3.4'],
    ['rule 3.4(2)(a)', 'rule/3.4/2/a'],
    ['r. 44.3A', 'rule/44.3A'],
    ['Sch. 2 para. 3(1)', 'schedule/2/paragraph/3/1'],
    ['Sch 2 para 3', 'schedule/2/paragraph/3'],
    ['Pt 3', 'part/3'],
    ['Part 3 Chapter 2', 'part/3/chapter/2'],
    ['Pt. 3 Ch. 2', 'part/3/chapter/2'],
    ['chapter IV', 'chapter/IV'],
    ['section/45/2/f', 'section/45/2/f'],
    ['/section/45/', 'section/45'],
    ['SECTION/45', 'section/45'],
    ['schedule/2/paragraph/3/1', 'schedule/2/paragraph/3/1'],
    ['part/3/chapter/1/crossheading/scope', 'part/3/chapter/1/crossheading/scope'],
    ['introduction', 'introduction'],
    ['INTRODUCTION', 'introduction'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeProvision(input)).toBe(expected);
  });

  it.each([
    'foo 3',
    's.',
    '',
    '   ',
    'section/45/foo bar',
    'section/',
    'section/schedule/2',
    'introduction/1',
    'para. 3 of Sch. 2',
    'r. 3.',
    'r. 3..4',
    'constructor 1',
    's. 1 constructor 2',
  ])('rejects %j', (input) => {
    expect(normalizeProvision(input)).toBeUndefined();
  });
});

describe('splitProvisionTail', () => {
  it.each([
    ['Data Protection Act 2018 s. 45', 'Data Protection Act 2018', 'section/45'],
    ['Data Protection Act 2018, s. 45(2)(f)', 'Data Protection Act 2018', 'section/45/2/f'],
    ['S.I. 2019/419 reg. 5', 'S.I. 2019/419', 'regulation/5'],
    ['Regulation (EU) 2016/679 art. 28', 'Regulation (EU) 2016/679', 'article/28'],
    [
      'Data Protection Act 2018 Sch. 2 para. 3(1)',
      'Data Protection Act 2018',
      'schedule/2/paragraph/3/1',
    ],
    ['Civil Procedure Rules 1998 r. 3.4', 'Civil Procedure Rules 1998', 'rule/3.4'],
  ])('%s', (citation, head, provision) => {
    expect(splitProvisionTail(citation)).toEqual({ head, provision });
  });

  it.each([
    'Human Rights Act 1998',
    'Civil Partnership Act 2004',
    'Parliament Act 1911',
    'Data Protection Regulations 2018',
  ])('leaves a title without a provision tail untouched: %s', (citation) => {
    expect(splitProvisionTail(citation)).toEqual({ head: citation });
  });

  it('reads no provision from a tail naming an Object.prototype member', () => {
    expect(splitProvisionTail('Data Protection Act 2018 s. 1 constructor 2')).toEqual({
      head: 'Data Protection Act 2018 s. 1 constructor 2',
    });
  });
});

describe('splitLeadingProvision', () => {
  it.each([
    ['section 45 of the Data Protection Act 2018', 'Data Protection Act 2018', 'section/45'],
    ['s. 45(2)(f) of 2018 c. 12', '2018 c. 12', 'section/45/2/f'],
    ['Article 28 of the UK GDPR', 'UK GDPR', 'article/28'],
    [
      'Sch. 2 para. 3 of The Data Protection Act 2018',
      'Data Protection Act 2018',
      'schedule/2/paragraph/3',
    ],
    [
      'section 1 of the Representation of the People Act 1983',
      'Representation of the People Act 1983',
      'section/1',
    ],
  ])('%s', (citation, head, provision) => {
    expect(splitLeadingProvision(citation)).toEqual({ head, provision });
  });

  it.each([
    'Representation of the People Act 1983',
    'Rules of the Supreme Court 1965',
    'section 45 of',
    'Data Protection Act 2018 s. 45',
    'foo 3 of the Data Protection Act 2018',
  ])('leaves %j untouched', (citation) => {
    expect(splitLeadingProvision(citation)).toEqual({ head: citation });
  });
});

describe('versions and dates', () => {
  it('maps enacted and its synonyms to the type’s own keyword', () => {
    expect(versionSegment('current', 'ukpga')).toBeUndefined();
    expect(versionSegment('enacted', 'ukpga')).toBe('enacted');
    expect(versionSegment('enacted', 'uksi')).toBe('made');
    expect(versionSegment('made', 'ukpga')).toBe('enacted');
    expect(versionSegment('enacted', 'eur')).toBe('adopted');
    expect(versionSegment('created', 'ukdsi')).toBe('created');
    expect(versionSegment('2020-01-31', 'ukpga')).toBe('2020-01-31');
  });

  it('isEnactedKeyword', () => {
    expect(isEnactedKeyword('made')).toBe(true);
    expect(isEnactedKeyword('adopted')).toBe(true);
    expect(isEnactedKeyword('current')).toBe(false);
    expect(isEnactedKeyword(undefined)).toBe(false);
  });

  it.each([
    ['2019-02-28', true],
    ['2020-02-29', true],
    ['2019-02-29', false],
    ['2019-02-30', false],
    ['2019-13-01', false],
    ['2019-04-31', false],
    ['2019-1-1', false],
    ['20190101', false],
  ])('isCalendarDate(%s) = %s', (value, expected) => {
    expect(isCalendarDate(value)).toBe(expected);
  });
});

describe('labels', () => {
  it.each([
    ['section/45/2/f', 'Section 45(2)(f)'],
    ['regulation/5', 'Regulation 5'],
    ['schedule/2/paragraph/3/1', 'Schedule 2 paragraph 3(1)'],
    ['part/3/chapter/2', 'Part 3 Chapter 2'],
    ['introduction', 'Introduction'],
    ['part/3/chapter/1/crossheading/scope', 'Part 3 Chapter 1 Cross-heading scope'],
  ])('provisionLabel(%s)', (path, label) => {
    expect(provisionLabel(path)).toBe(label);
  });

  it('provisionFromUri strips version and language relative to the item', () => {
    expect(
      provisionFromUri(
        'http://www.legislation.gov.uk/uksi/2019/419/regulation/1/made',
        'uksi/2019/419',
      ),
    ).toBe('regulation/1');
    expect(
      provisionFromUri('http://www.legislation.gov.uk/anaw/2016/1/section/1/welsh', 'anaw/2016/1'),
    ).toBe('section/1');
    expect(
      provisionFromUri('http://www.legislation.gov.uk/ukpga/2018/12/section/1', 'ukpga/2018/13'),
    ).toBeUndefined();
    expect(provisionFromUri(undefined, 'ukpga/2018/12')).toBeUndefined();
  });
});
