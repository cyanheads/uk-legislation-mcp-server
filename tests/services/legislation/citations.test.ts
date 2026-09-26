/**
 * @fileoverview Tests for the citation grammar (numbered UK, devolved and
 * EU-origin citations, URIs, short titles, provision tails) and the bounded
 * text scan of the `/id?title=` 300 page.
 * @module tests/services/legislation/citations.test
 */

import { describe, expect, it } from 'vitest';
import {
  extractTitleCandidates,
  normalizeTitle,
  parseCitation,
} from '@/services/legislation/citations.js';
import { fixture } from '../../helpers/upstream.js';

describe('parseCitation — numbered forms', () => {
  it.each([
    ['2018 c. 12', 'ukpga', 2018, '12'],
    ['2018 c.12', 'ukpga', 2018, '12'],
    ['2018 c 012', 'ukpga', 2018, '12'],
    ['1955 c. 19', 'ukpga', 1955, '19'],
    ['S.I. 2019/419', 'uksi', 2019, '419'],
    ['SI 2019 No. 419', 'uksi', 2019, '419'],
    ['S.I. 2002/808 (W. 89)', 'uksi', 2002, '808'],
    ['S.S.I. 2020/123', 'ssi', 2020, '123'],
    ['SSI 2020/123', 'ssi', 2020, '123'],
    ['S.R. 2020/12', 'nisr', 2020, '12'],
    ['S.R. 2020 No. 12', 'nisr', 2020, '12'],
    ['2020 asp 13', 'asp', 2020, '13'],
    ['asp 2020/13', 'asp', 2020, '13'],
    ['2016 anaw 1', 'anaw', 2016, '1'],
    ['2021 asc 1', 'asc', 2021, '1'],
    ['2010 nawm 1', 'mwa', 2010, '1'],
    ['Regulation (EU) 2016/679', 'eur', 2016, '679'],
    ['Regulation (EC) No 1535/2003', 'eur', 2003, '1535'],
    ['Regulation (EC) 1907/2006', 'eur', 2006, '1907'],
    ['Regulation (EEC) No 1408/71', 'eur', 1971, '1408'],
    ['Regulation (EU) 2015/2120', 'eur', 2015, '2120'],
    ['Directive 95/46/EC', 'eudr', 1995, '46'],
    ['Directive 2016/680', 'eudr', 2016, '680'],
    ['Directive 2000/31/EC', 'eudr', 2000, '31'],
    ['Decision (EU) 2019/419', 'eudn', 2019, '419'],
  ])('%s → %s %i/%s', (citation, type, year, number) => {
    expect(parseCitation(citation)).toEqual({ kind: 'numbered', type, year, number });
  });

  it('keeps a provision tail on a numbered citation', () => {
    expect(parseCitation('S.I. 2019/419 reg. 5')).toEqual({
      kind: 'numbered',
      type: 'uksi',
      year: 2019,
      number: '419',
      provision: 'regulation/5',
    });
    expect(parseCitation('Regulation (EU) 2016/679 art. 28(3)')).toMatchObject({
      type: 'eur',
      provision: 'article/28/3',
    });
  });

  it('does not read an out-of-range year as a numbered citation', () => {
    expect(parseCitation('3000 c. 1')).toEqual({ kind: 'title', title: '3000 c. 1' });
  });
});

describe('parseCitation — URIs, titles, and unparsed input', () => {
  it('splits a legislation.gov.uk URI into item and provision', () => {
    const parsed = parseCitation(
      'https://www.legislation.gov.uk/ukpga/2018/12/section/45/2020-01-01',
    );
    expect(parsed).toMatchObject({
      kind: 'uri',
      item: { path: 'ukpga/2018/12' },
      provision: 'section/45',
    });
  });

  it('reads an item path with a shorthand provision tail', () => {
    expect(parseCitation('ukpga/2018/12 s. 45(2)(f)')).toMatchObject({
      kind: 'uri',
      item: { path: 'ukpga/2018/12' },
      provision: 'section/45/2/f',
    });
  });

  it('reads a regnal item path', () => {
    expect(parseCitation('ukpga/Eliz2/3-4/19')).toMatchObject({
      kind: 'uri',
      item: { regnal: true, year: 'Eliz2/3-4', number: '19' },
    });
  });

  it('reads a short title with its year and a provision', () => {
    expect(parseCitation('Data Protection Act 2018 s. 45')).toEqual({
      kind: 'title',
      title: 'Data Protection Act 2018',
      year: 2018,
      provision: 'section/45',
    });
    expect(parseCitation('  Human   Rights Act 1998. ')).toEqual({
      kind: 'title',
      title: 'Human Rights Act 1998',
      year: 1998,
    });
  });

  it.each([
    '???',
    '',
    '   ',
    '1234',
    's. 45',
    'Pt 3',
    'https://www.legislation.gov.uk/search?title=x',
  ])('marks %j unparsed', (input) => {
    expect(parseCitation(input)).toEqual({ kind: 'unparsed' });
  });
});

describe('extractTitleCandidates', () => {
  it('reads the candidates of the recorded 300 page in order', () => {
    const candidates = extractTitleCandidates(fixture('html/id-title-300.html.txt'));
    expect(candidates).toHaveLength(20);
    expect(candidates[0]?.item).toBe('uksi/2022/1022');
    expect(candidates).toContainEqual({ item: 'ukpga/2018/12', title: 'Data Protection Act 2018' });
    expect(candidates).toContainEqual({
      item: 'ukpga/1984/35',
      title: 'Data Protection Act 1984 (repealed 1.3.2000)',
    });
  });

  it('honours the cap', () => {
    expect(extractTitleCandidates(fixture('html/id-title-300.html.txt'), 3)).toHaveLength(3);
  });

  it('reads regnal candidates of the /id/{item} 300 page', () => {
    expect(extractTitleCandidates(fixture('html/id-ukpga-1955-19-300.html.txt'))).toEqual([
      { item: 'ukpga/Eliz2/4-5/19', title: 'Friendly Societies Act 1955' },
      { item: 'ukpga/Eliz2/3-4/19', title: 'Air Force Act 1955 (repealed)' },
    ]);
  });

  it('ignores anchors outside the content div, duplicates and non-item paths', () => {
    const html =
      '<li><a href="/id/ukpga/1998/42">Outside</a></li><div id="content"><ul>' +
      '<li><a href="/id/ukpga/2018/12">Data Protection Act 2018</a></li>' +
      '<li><a href="/id/ukpga/2018/12">Duplicate</a></li>' +
      '<li><a href="/id/ukpga">Partial</a></li>' +
      '<li><a href="/id/uksi/2019/419/">The &amp; Regulations&#8217; <em>2019</em></a></li>' +
      '</ul></div><div id="footerNav"><li><a href="/id/ukpga/2000/1">Footer</a></li></div>';
    expect(extractTitleCandidates(html)).toEqual([
      { item: 'ukpga/2018/12', title: 'Data Protection Act 2018' },
      { item: 'uksi/2019/419', title: 'The & Regulations’ 2019' },
    ]);
  });

  it('returns nothing when the page has no content div', () => {
    expect(
      extractTitleCandidates('<html><body><a href="/id/ukpga/2018/12">x</a></body></html>'),
    ).toEqual([]);
  });
});

describe('normalizeTitle', () => {
  it.each([
    ['The Data Protection Act 2018', 'data protection act 2018'],
    ['Data Protection Act 1984 (repealed 1.3.2000)', 'data protection act 1984'],
    ['The Foo Order 2020 (revoked)', 'foo order 2020'],
    ['Consumer’s  Rights Act 2015', "consumer's rights act 2015"],
  ])('%s → %s', (input, expected) => {
    expect(normalizeTitle(input)).toBe(expected);
  });
});
