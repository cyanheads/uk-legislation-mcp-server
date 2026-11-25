/**
 * @fileoverview Tests for the citation grammar (numbered UK, devolved and
 * EU-origin citations, URIs, short titles, provision tails and leading
 * provisions), the bounded text scan of the `/id?title=` 300 page, and the
 * time the citation and provision parsers take as their input grows.
 * @module tests/services/legislation/citations.test
 */

import { describe, expect, it } from 'vitest';
import {
  extractTitleCandidates,
  normalizeTitle,
  parseCitation,
} from '@/services/legislation/citations.js';
import { normalizeProvision } from '@/services/legislation/provision-path.js';
import { fixture } from '../../helpers/upstream.js';

/** Least thread CPU milliseconds per call of `run`, over `rounds` batches of `calls` calls. */
function leastCpuMs(run: () => unknown, calls = 1, rounds = 3): number {
  let best = Number.POSITIVE_INFINITY;
  for (let round = 0; round < rounds; round += 1) {
    const started = process.threadCpuUsage();
    for (let call = 0; call < calls; call += 1) run();
    const elapsed = process.threadCpuUsage(started);
    best = Math.min(best, (elapsed.user + elapsed.system) / 1_000 / calls);
  }
  return best;
}

/** Calls that bring one batch of `run` to about 2 ms of CPU, above the timer's resolution. */
function batchSize(run: () => unknown): number {
  return Math.min(64, Math.ceil(2 / Math.max(leastCpuMs(run, 1, 1), 0.01)));
}

/** Per-call CPU budget at every size; a linear parse of 320k characters stays well below it. */
const PARSE_BUDGET_MS = 250;

/**
 * Times `run` on `make(chars)` from 5k characters to `maxChars`, doubling, and
 * fails at the first size whose least per-call thread CPU passes the budget.
 * Each size is timed in pairs beside the 5k baseline, and the least growth over
 * the last size's pairs stays below four times the span.
 */
function expectLinearTime(
  run: (input: string) => unknown,
  make: (chars: number) => string,
  maxChars = 320_000,
): void {
  const base = make(5_000);
  const runBase = () => run(base);
  const baseCalls = batchSize(runBase);
  let growth = Number.POSITIVE_INFINITY;
  for (let chars = 5_000; chars <= maxChars; chars *= 2) {
    const input = make(chars);
    const runSize = () => run(input);
    const calls = batchSize(runSize);
    let least = Number.POSITIVE_INFINITY;
    growth = Number.POSITIVE_INFINITY;
    for (let pair = 0; pair < 3; pair += 1) {
      const baseMs = leastCpuMs(runBase, baseCalls, 1);
      const sizeMs = leastCpuMs(runSize, calls, 1);
      least = Math.min(least, sizeMs);
      growth = Math.min(growth, sizeMs / Math.max(baseMs, 0.001));
    }
    expect(least).toBeLessThan(PARSE_BUDGET_MS);
  }
  expect(growth).toBeLessThan((4 * maxChars) / 5_000);
}

/** `unit` repeated to at least `chars` characters. */
const fill = (unit: string, chars: number) => unit.repeat(Math.ceil(chars / unit.length));

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

describe('parseCitation — letter-prefixed values, a Schedule "to" its item, commas', () => {
  const title = (text: string, year: number, provision?: string) => ({
    kind: 'title',
    title: text,
    year,
    ...(provision ? { provision } : {}),
  });

  it.each([
    ['Access to Justice Act 1999', title('Access to Justice Act 1999', 1999)],
    [
      'section 1 of the Access to Justice Act 1999',
      title('Access to Justice Act 1999', 1999, 'section/1'),
    ],
    [
      'section 1 to 5 of the Data Protection Act 2018',
      title('section 1 to 5 of the Data Protection Act 2018', 2018),
    ],
    [
      'regulation 3 to the Civil Procedure Rules 1998',
      title('regulation 3 to the Civil Procedure Rules 1998', 1998),
    ],
    [
      'Part 2 to the Data Protection Act 2018',
      title('Part 2 to the Data Protection Act 2018', 2018),
    ],
    [
      'Schedules 2 to 4 to the Data Protection Act 2018',
      title('Schedules 2 to 4 to the Data Protection Act 2018', 2018),
    ],
    ['Henry VIII', { kind: 'title', title: 'Henry VIII' }],
    ['Solvency II', { kind: 'title', title: 'Solvency II' }],
    [
      'Representation of the People Act 1983 Pt II',
      title('Representation of the People Act 1983', 1983, 'part/II'),
    ],
    [
      'The A1 and A19 Trunk Roads (Speed Limits) Order 2020',
      title('The A1 and A19 Trunk Roads (Speed Limits) Order 2020', 2020),
    ],
    ['Value Added Tax Act 1994', title('Value Added Tax Act 1994', 1994)],
  ])('keeps the reading of %j', (citation, parsed) => {
    expect(parseCitation(citation)).toEqual(parsed);
  });

  it.each([
    [
      'Insolvency Act 1986 Sch. B1 para. 14',
      title('Insolvency Act 1986', 1986, 'schedule/B1/paragraph/14'),
    ],
    ['Insolvency Act 1986 s. A6', title('Insolvency Act 1986', 1986, 'section/A6')],
    ['Children Act 1989 Pt XA', title('Children Act 1989', 1989, 'part/XA')],
    ['Insolvency Act 1986 Pt IX Ch. IA', title('Insolvency Act 1986', 1986, 'part/IX/chapter/IA')],
    [
      'Schedule 2 to the Data Protection Act 2018',
      title('Data Protection Act 2018', 2018, 'schedule/2'),
    ],
    [
      'paragraph 3 of Schedule 2 to the Data Protection Act 2018',
      title('Data Protection Act 2018', 2018, 'schedule/2/paragraph/3'),
    ],
    [
      'paragraph 14 of Schedule B1 to the Insolvency Act 1986',
      title('Insolvency Act 1986', 1986, 'schedule/B1/paragraph/14'),
    ],
    [
      'Part 1 of Schedule 2 to the Data Protection Act 2018',
      title('Data Protection Act 2018', 2018, 'schedule/2/part/1'),
    ],
    [
      'Schedule 2 to the Access to Justice Act 1999',
      title('Access to Justice Act 1999', 1999, 'schedule/2'),
    ],
    [
      'Schedule 2 to the Representation of the People Act 1983',
      title('Representation of the People Act 1983', 1983, 'schedule/2'),
    ],
    [
      'Schedule 2 to 2018 c. 12',
      { kind: 'numbered', type: 'ukpga', year: 2018, number: '12', provision: 'schedule/2' },
    ],
    [
      'Data Protection Act 2018, Sch. 2, para. 3',
      title('Data Protection Act 2018', 2018, 'schedule/2/paragraph/3'),
    ],
    [
      'Insolvency Act 1986, sch B1, para 14',
      title('Insolvency Act 1986', 1986, 'schedule/B1/paragraph/14'),
    ],
    [
      'Data Protection Act 2018, Sch. 2 , para. 3',
      title('Data Protection Act 2018', 2018, 'schedule/2/paragraph/3'),
    ],
    [
      'Data Protection Act 2018, Sch. 2,, para. 3',
      title('Data Protection Act 2018', 2018, 'schedule/2/paragraph/3'),
    ],
  ])('reads %j', (citation, parsed) => {
    expect(parseCitation(citation)).toEqual(parsed);
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
    // An instrument titled after its parent Act: the instrument's own year is written last.
    ['The Pensions Act 2008 (Commencement No. 3) Order 2009', 2009],
    // An ISBN after the year is one longer digit run, never a year.
    ['Draft Order 2026 ISBN 9780348288018', 2026],
  ])('takes the year of %j from the last year written as its own word', (citation, year) => {
    expect(parseCitation(citation)).toEqual({ kind: 'title', title: citation, year });
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

  it('reads the item paths of a document 300 page, which links each candidate’s provision', () => {
    expect(extractTitleCandidates(fixture('html/ukpga-1955-19-section-1-300.html.txt'))).toEqual([
      { item: 'ukpga/Eliz2/4-5/19', title: 'Friendly Societies Act 1955' },
      { item: 'ukpga/Eliz2/3-4/19', title: 'Air Force Act 1955 (repealed)' },
    ]);
  });

  it('reads a candidate once whether its anchor names the item, a provision, or a version', () => {
    const html =
      '<div id="content"><ul>' +
      '<li><a href="/ukpga/Eliz2/4-5/19/section/1/1980-01-01">Friendly Societies Act 1955</a></li>' +
      '<li><a href="/id/ukpga/Eliz2/4-5/19">Again</a></li>' +
      '<li><a href="/ukpga/Eliz2/3-4/19/contents">Air Force Act 1955</a></li>' +
      '<li><a href="/help">Help</a></li>' +
      '<li><a href="/cy/ukpga/2018/12">Cymraeg</a></li>' +
      '</ul></div>';
    expect(extractTitleCandidates(html)).toEqual([
      { item: 'ukpga/Eliz2/4-5/19', title: 'Friendly Societies Act 1955' },
      { item: 'ukpga/Eliz2/3-4/19', title: 'Air Force Act 1955' },
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
  ])('scans an adversarial page within its CPU budget: %s', (_name, list) => {
    const html = `<div id="content"><ul>${list}`;
    const started = process.threadCpuUsage();
    const candidates = extractTitleCandidates(html);
    const elapsed = process.threadCpuUsage(started);
    expect(candidates).toEqual([]);
    expect((elapsed.user + elapsed.system) / 1_000).toBeLessThan(25);
  });

  /** Thread CPU milliseconds of the fastest of three scans of `html`. */
  function scanMs(html: string): number {
    return leastCpuMs(() => expect(extractTitleCandidates(html)).toEqual([]));
  }

  it.each([
    [
      'one long line of anchors whose href runs into the next, ending in a break',
      '<li><a href="/x/',
      '\ny',
    ],
    ['list items with line breaks throughout and no anchor', '<li>  \r\n', ''],
  ])('scans in linear time from 5k to 320k characters: %s', (_name, unit, tail) => {
    const page = (chars: number) =>
      `<div id="content"><ul>${unit.repeat(Math.ceil(chars / unit.length))}${tail}`;
    const times: number[] = [];
    for (let chars = 5_000; chars <= 320_000; chars *= 2) {
      const ms = scanMs(page(chars));
      expect(ms).toBeLessThan(25);
      times.push(ms);
    }
    const first = Math.max(times[0] as number, 0.001);
    expect((times.at(-1) as number) / first).toBeLessThan(256);
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

  it('normalizes repeated unclosed status notes within its CPU budget', () => {
    const title = '(repealed'.repeat(30_000);
    const started = process.threadCpuUsage();
    const normalized = normalizeTitle(title);
    const elapsed = process.threadCpuUsage(started);
    expect(normalized).toBe(title);
    expect((elapsed.user + elapsed.system) / 1_000).toBeLessThan(100);
  });
});

describe('parser time as the input grows', () => {
  it.each<[string, (chars: number) => string]>([
    ['digit-led components ending in junk', (n) => `${fill('s 1 ', n)}x`],
    ['letter-prefixed components ending in junk', (n) => `${fill('Sch B1 ', n)}x`],
    ['roman components with a letter suffix ending in junk', (n) => `${fill('Pt XA ', n)}x`],
    [
      'a keyword, then one run of roman-numeral letters ending in a digit',
      (n) => `Pt ${'I'.repeat(n)}5`,
    ],
    ['comma-separated components ending in junk', (n) => `${fill('s 1, ', n)}x`],
    ['one component, then a run of commas and junk', (n) => `s 1${fill(', ', n)}x`],
    ['a title, a run of commas, then a component', (n) => `Act${fill(', ', n)}x s. 1`],
    ['a title holding a run of semicolons', (n) => `Act${fill('; ', n)}x`],
    ['repeated "to" with no Schedule before it', (n) => fill('a to ', n)],
    [
      'a provision "of" a chain of Schedules "to"',
      (n) => `paragraph 3 of ${fill('Schedule 2 to ', n)}`,
    ],
    [
      'years, then a long stretch without one',
      (n) => `${fill('2018 ', n / 2)}${'a'.repeat(n / 2)}`,
    ],
    ['one long line ending in a break', (n) => `${fill('s 1 ', n)}\ny`],
    ['line breaks throughout', (n) => `${fill('s 1  \r\n', n)}x`],
  ])(
    'parses a citation in linear time from 5k to 320k characters: %s',
    (_name, make) => {
      expectLinearTime(parseCitation, make);
    },
    0,
  );

  it.each<[string, (chars: number) => string]>([
    ['digit-led components ending in junk', (n) => `${fill('s 1 ', n)}x`],
    ['letter-prefixed components ending in junk', (n) => `${fill('Sch B1 ', n)}x`],
    ['roman components with a letter suffix ending in junk', (n) => `${fill('Pt XA ', n)}x`],
    ['comma-separated components ending in junk', (n) => `${fill('s 1, ', n)}x`],
    ['slashes between two letters', (n) => `x${'/'.repeat(n)}x`],
    ['one long line ending in a break', (n) => `${fill('s 1 ', n)}\ny`],
    ['line breaks throughout', (n) => `${fill('s 1  \r\n', n)}x`],
  ])(
    'normalizes a provision in linear time from 5k to 320k characters: %s',
    (_name, make) => {
      expectLinearTime(normalizeProvision, make);
    },
    0,
  );

  /** Bun's regex engine switches to a several-fold slower mode past about 160k characters of repeated sub-levels, so this shape stops at 80k, below the switch. */
  it('normalizes a provision in linear time from 5k to 80k characters: bracketed sub-levels ending in an open bracket', () => {
    expectLinearTime(normalizeProvision, (n) => `s. 1${fill(' (1)', n)}(`, 80_000);
  }, 0);
});
