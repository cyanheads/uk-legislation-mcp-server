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
    ['2016 c. 5 (N.I.)', 'nia', 2016, '5'],
    ['2016 c 5 (NI)', 'nia', 2016, '5'],
    ['Council Regulation (EC) No 1/2003', 'eur', 2003, '1'],
    ['Commission Implementing Regulation (EU) 2019/947', 'eur', 2019, '947'],
    ['Commission Delegated Regulation (EU) 2019/945', 'eur', 2019, '945'],
    ['Commission Regulation (EC) No 1907/2006', 'eur', 2006, '1907'],
    ['European Parliament and Council Directive 2000/31/EC', 'eudr', 2000, '31'],
    ['European Parliament and of the Council Regulation (EU) 2016/679', 'eur', 2016, '679'],
    ['Commission Implementing Decision (EU) 2019/419', 'eudn', 2019, '419'],
    ['UK GDPR', 'eur', 2016, '679'],
    ['the UK GDPR', 'eur', 2016, '679'],
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

describe('parseCitation — written forms', () => {
  it('reads a leading provision followed by "of the"', () => {
    expect(parseCitation('section 45 of the Data Protection Act 2018')).toEqual({
      kind: 'title',
      title: 'Data Protection Act 2018',
      year: 2018,
      provision: 'section/45',
    });
    expect(parseCitation('s. 45(2)(f) of 2018 c. 12')).toEqual({
      kind: 'numbered',
      type: 'ukpga',
      year: 2018,
      number: '12',
      provision: 'section/45/2/f',
    });
    expect(parseCitation('regulation 5 of S.I. 2019/419')).toMatchObject({
      kind: 'numbered',
      type: 'uksi',
      provision: 'regulation/5',
    });
  });

  it('keeps "of" inside a title that has no leading provision', () => {
    expect(parseCitation('Representation of the People Act 1983')).toEqual({
      kind: 'title',
      title: 'Representation of the People Act 1983',
      year: 1983,
    });
  });

  it('strips a trailing chapter number from a title and keeps it', () => {
    expect(parseCitation('Human Rights Act 1998 (c. 42)')).toEqual({
      kind: 'title',
      title: 'Human Rights Act 1998',
      year: 1998,
      chapter: '42',
    });
    expect(parseCitation('Human Rights Act 1998 (c.42) s. 3')).toEqual({
      kind: 'title',
      title: 'Human Rights Act 1998',
      year: 1998,
      chapter: '42',
      provision: 'section/3',
    });
    expect(parseCitation('section 3 of the Human Rights Act 1998 (c. 42)')).toEqual({
      kind: 'title',
      title: 'Human Rights Act 1998',
      year: 1998,
      chapter: '42',
      provision: 'section/3',
    });
  });

  it('keeps a bare year and chapter in brackets as a title', () => {
    expect(parseCitation('2018 (c. 12)')).toEqual({
      kind: 'title',
      title: '2018 (c. 12)',
      year: 2018,
    });
  });

  it('reads a dotted rule number in a provision tail', () => {
    expect(parseCitation('Civil Procedure Rules 1998 r. 3.4')).toEqual({
      kind: 'title',
      title: 'Civil Procedure Rules 1998',
      year: 1998,
      provision: 'rule/3.4',
    });
  });

  it('reads the UK GDPR as Regulation (EU) 2016/679, with or without a provision', () => {
    expect(parseCitation('UK GDPR art. 28')).toEqual({
      kind: 'numbered',
      type: 'eur',
      year: 2016,
      number: '679',
      provision: 'article/28',
    });
    expect(parseCitation('Article 28(3) of the UK GDPR')).toEqual({
      kind: 'numbered',
      type: 'eur',
      year: 2016,
      number: '679',
      provision: 'article/28/3',
    });
  });

  it('does not read an issuing body without an EU act as a citation', () => {
    expect(parseCitation('Council Tax Act 1992')).toEqual({
      kind: 'title',
      title: 'Council Tax Act 1992',
      year: 1992,
    });
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

  it.each(['constructor', '__proto__'])('reads %j as a title, never as a defined name', (input) => {
    expect(parseCitation(input)).toEqual({ kind: 'title', title: input });
  });

  it('reads no provision from a tail naming an Object.prototype member', () => {
    const parsed = parseCitation('Data Protection Act 2018 s. 1 constructor 2');
    expect(parsed).toEqual({
      kind: 'title',
      title: 'Data Protection Act 2018 s. 1 constructor 2',
      year: 2018,
    });
    expect(JSON.stringify(parsed)).not.toContain('function');
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

  it('leaves a named reference it does not define literal, Object.prototype members included', () => {
    const html =
      '<div id="content"><ul><li><a href="/id/ukpga/2018/12">Data &constructor; &bogus; &amp; Act</a></li></ul></div>';
    expect(extractTitleCandidates(html)).toEqual([
      { item: 'ukpga/2018/12', title: 'Data &constructor; &bogus; & Act' },
    ]);
  });

  it('returns nothing when the page has no content div', () => {
    expect(
      extractTitleCandidates('<html><body><a href="/id/ukpga/2018/12">x</a></body></html>'),
    ).toEqual([]);
  });

  it('reads no further than 200,000 characters past the content div, footer or not', () => {
    const anchor = '<li><a href="/id/ukpga/2018/12">Data Protection Act 2018</a></li>';
    const page = (gap: number) =>
      `<div id="content"><ul>${' '.repeat(gap)}${anchor}</ul></div><div id="footerNav"></div>`;
    expect(extractTitleCandidates(page(100_000))).toHaveLength(1);
    expect(extractTitleCandidates(page(200_000))).toEqual([]);
  });

  it('skips an anchor whose text runs past 2,000 characters', () => {
    const html =
      '<div id="content"><ul>' +
      `<li><a href="/id/ukpga/2018/12">${'x'.repeat(2_001)}</a></li>` +
      '<li><a href="/id/uksi/2019/419">The Regulations 2019</a></li>' +
      '</ul></div>';
    expect(extractTitleCandidates(html)).toEqual([
      { item: 'uksi/2019/419', title: 'The Regulations 2019' },
    ]);
  });

  const unclosed = (kb: number) => '<li><a href="/id/a">'.repeat((kb * 1024) / 20);
  it.each([
    [
      '400 KB of anchors with no </a>, the footer after them',
      `${unclosed(400)}<div id="footerNav">`,
    ],
    ['190 KB of anchors with no </a>, no footer', unclosed(190)],
    [
      'one 190 KB anchor text of "<"',
      `<li><a href="/id/ukpga/2018/12">${'<'.repeat(190 * 1024)}</a>`,
    ],
  ])('scans an adversarial page in linear time: %s', (_name, list) => {
    const html = `<div id="content"><ul>${list}`;
    const started = performance.now();
    expect(extractTitleCandidates(html)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(25);
  });
});

describe('normalizeTitle', () => {
  it.each([
    ['The Data Protection Act 2018', 'data protection act 2018'],
    ['Data Protection Act 1984 (repealed 1.3.2000)', 'data protection act 1984'],
    ['The Foo Order 2020 (revoked)', 'foo order 2020'],
    ['Consumer’s  Rights Act 2015', "consumer's rights act 2015"],
    ['Air Force Act 1955  (repealed)  ', 'air force act 1955'],
    ['The Foo (Revoked) Order 2020', 'foo (revoked) order 2020'],
    ['Foo Act 2001 (repealed (in part))', 'foo act 2001 (repealed (in part))'],
    ['Foo (Amendment) Order 2020 (revoked)', 'foo (amendment) order 2020'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeTitle(input)).toBe(expected);
  });

  it('runs in linear time on an unclosed status note repeated', () => {
    const title = '(repealed'.repeat(30_000);
    const started = performance.now();
    expect(normalizeTitle(title)).toBe(title);
    expect(performance.now() - started).toBeLessThan(100);
  });
});
