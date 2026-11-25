/**
 * @fileoverview Tests for CLML metadata reading over recorded documents:
 * identity, status read per document, the made or enactment date, publishers,
 * versions, links (the main PDF in the language served, not an explanatory
 * note; the notes page), Welsh documents, PDF-only items, the laid and
 * in-force dates, and every associated-document family.
 * @module tests/services/legislation/clml/metadata.test
 */

import { describe, expect, it } from 'vitest';
import { ASSOCIATED_DOCUMENT_KINDS, readMetadata } from '@/services/legislation/clml/metadata.js';
import { parseXml } from '@/services/legislation/xml.js';
import { fixture } from '../../../helpers/upstream.js';

const read = (name: string) => readMetadata(parseXml(fixture(`clml/${name}`), 'a document'));

/** Metadata of a document whose `ukm:Metadata` holds `inner` after a typed block holding `typed`. */
const withMetadata = (inner: string, typed = '') =>
  readMetadata(
    parseXml(
      `<Legislation><ukm:Metadata xmlns:ukm="u" xmlns:dc="d" xmlns:atom="a"><ukm:SecondaryMetadata>${typed}</ukm:SecondaryMetadata>${inner}</ukm:Metadata></Legislation>`,
      'x',
    ),
  );

/** `inner` wrapped in each element of `path`, outermost first. */
const nest = (path: string[], inner: string) =>
  path.reduceRight((xml, name) => `<${name}>${xml}</${name}>`, inner);

describe('readMetadata', () => {
  it('reads a revised provision fragment', () => {
    const { unappliedEffects, ...md } = read('ukpga-2018-12-section-45.xml');
    expect(md).toEqual({
      title: 'Data Protection Act 2018',
      publishers: ['Statute Law Database'],
      versions: [
        'enacted',
        '2018-05-25',
        '2020-12-31',
        '2024-01-01',
        '2025-09-05',
        '2026-02-05',
        '2026-06-19',
      ],
      year: 2018,
      numberOfProvisions: 1182,
      identifier: 'http://www.legislation.gov.uk/ukpga/2018/12/section/45',
      idUri: 'http://www.legislation.gov.uk/id/ukpga/2018/12',
      language: 'en',
      modified: '2026-07-09',
      valid: '2026-06-19',
      category: 'primary',
      mainType: 'UnitedKingdomPublicGeneralAct',
      status: 'revised',
      number: '12',
      madeDate: '2018-05-23',
      restrictExtent: 'E+W+S+N.I.',
      restrictStartDate: '2026-06-19',
      aknUri: 'https://www.legislation.gov.uk/ukpga/2018/12/section/45/data.akn',
      pdfUri: 'https://www.legislation.gov.uk/ukpga/2018/12/pdfs/ukpga_20180012_en.pdf',
      notesUri: 'https://www.legislation.gov.uk/ukpga/2018/12/notes',
      associatedDocuments: [
        {
          kind: 'notes',
          title: 'Explanatory Note',
          date: '2022-01-13',
          uri: 'https://www.legislation.gov.uk/ukpga/2018/12/pdfs/ukpgaen_20180012_en.pdf',
        },
        {
          kind: 'correction_slip',
          title: 'Correction Slip 1',
          date: '2019-08-19',
          uri: 'https://www.legislation.gov.uk/ukpga/2018/12/pdfs/ukpgacs_20180012_en_001.pdf',
        },
      ],
    });
    expect(unappliedEffects).toHaveLength(7);
  });

  it('reads the as-enacted status per document, not from the type', () => {
    const md = read('ukpga-2018-12-section-45-enacted.xml');
    expect(md.status).toBe('final');
    expect(md.publishers).toEqual(["King's Printer of Acts of Parliament"]);
    expect(md.identifier).toBe('http://www.legislation.gov.uk/ukpga/2018/12/section/45/enacted');
    expect(md.valid).toBeUndefined();
  });

  it('reads a dated version with its validity window', () => {
    const md = read('ukpga-2018-12-section-45-2019-01-01.xml');
    expect(md.valid).toBe('2018-07-23');
    expect(md.identifier).toBe('http://www.legislation.gov.uk/ukpga/2018/12/section/45/2019-01-01');
  });

  it('reads the made date of an instrument from ukm:Made', () => {
    expect(read('uksi-1984-458-made.xml').madeDate).toBe('1984-03-28');
  });

  it('reads secondary legislation as revised when upstream says so', () => {
    const md = read('uksi-2019-419-contents.xml');
    expect(md).toMatchObject({
      status: 'revised',
      category: 'secondary',
      mainType: 'UnitedKingdomStatutoryInstrument',
    });
    expect(md.unappliedEffects).toHaveLength(3);
  });

  it('reads both publishers of a Westlaw-contributed instrument', () => {
    expect(read('uksi-1986-1078-regulation-1.xml').publishers).toEqual([
      'Westlaw',
      'Statute Law Database',
    ]);
    expect(read('uksi-1984-458-made.xml').publishers).toEqual([
      'Westlaw',
      "King's Printer of Acts of Parliament",
    ]);
  });

  it('reads an EU-origin document', () => {
    const md = read('eur-2016-679-article-28.xml');
    expect(md).toMatchObject({ mainType: 'EuropeanUnionRegulation', status: 'revised' });
    expect(md.category).toBe('euretained');
  });

  it('reads a Welsh-language document', () => {
    const md = read('anaw-2016-1-section-1-welsh.xml');
    expect(md).toMatchObject({
      language: 'cy',
      title: 'Deddf Rhentu Cartrefi (Cymru) 2016',
      identifier: 'http://www.legislation.gov.uk/anaw/2016/1/section/1/welsh',
    });
  });

  it('reads a PDF-only made instrument: zero provisions, a PDF alternative', () => {
    const md = read('uksi-1985-2081-contents-made.xml');
    expect(md).toMatchObject({
      numberOfProvisions: 0,
      status: 'final',
      pdfUri: 'https://www.legislation.gov.uk/uksi/1985/2081/pdfs/uksi_19852081_en.pdf',
    });
    expect(md.unappliedEffects).toHaveLength(1);
  });

  it('tolerates a document with no metadata block', () => {
    expect(readMetadata(parseXml('<Legislation/>', 'x'))).toEqual({
      title: '',
      publishers: [],
      versions: [],
      associatedDocuments: [],
      unappliedEffects: [],
    });
  });

  it('reads a Welsh title tagged xml:lang="cy" separately from the English one', () => {
    const md = readMetadata(
      parseXml(
        '<Legislation><ukm:Metadata xmlns:ukm="u" xmlns:dc="d"><dc:title>Housing Act</dc:title><dc:title xml:lang="cy">Deddf Tai</dc:title></ukm:Metadata></Legislation>',
        'x',
      ),
    );
    expect(md).toMatchObject({ title: 'Housing Act', titleCy: 'Deddf Tai' });
  });
});

describe('readMetadata: the item PDF', () => {
  it.each([
    [
      'ukpga-2006-46-section-29.xml',
      'https://www.legislation.gov.uk/ukpga/2006/46/pdfs/ukpga_20060046_en.pdf',
    ],
    [
      'wsi-2024-1337-made.xml',
      'https://www.legislation.gov.uk/wsi/2024/1337/pdfs/wsi_20241337_mi.pdf',
    ],
    [
      'eur-2016-679-article-28.xml',
      'https://www.legislation.gov.uk/eur/2016/679/pdfs/eur_20160679_adopted_en.pdf',
    ],
    [
      'anaw-2016-1-section-1-welsh.xml',
      'https://www.legislation.gov.uk/anaw/2016/1/pdfs/anaw_20160001_we.pdf',
    ],
  ])('links %s to its own PDF, never an explanatory note or volume', (name, pdf) => {
    expect(read(name).pdfUri).toBe(pdf);
  });

  it('links an English read of a Welsh Act to the English PDF, not the first listed', () => {
    const md = read('anaw-2016-1-section-7-1.xml');
    expect(md.language).toBe('en');
    expect(md.pdfUri).toBe('https://www.legislation.gov.uk/anaw/2016/1/pdfs/anaw_20160001_en.pdf');
  });

  const pdfs = (...files: [name: string, language?: string][]) =>
    `<ukm:Alternatives>${files.map(([name, language]) => `<ukm:Alternative URI="http://www.legislation.gov.uk/x/${name}.pdf"${language ? ` Language="${language}"` : ''}/>`).join('')}</ukm:Alternatives>`;

  it.each([
    ['cy', 'we'],
    ['en', 'en'],
  ])('picks the PDF in the served language %s wherever it is listed', (language, picked) => {
    const md = withMetadata(
      `<dc:language>${language}</dc:language>${pdfs(['mi', 'Mixed'], ['we', 'Welsh'], ['en'])}`,
    );
    expect(md.pdfUri).toBe(`https://www.legislation.gov.uk/x/${picked}.pdf`);
  });

  it.each([
    ['cy', pdfs(['mi', 'Mixed'], ['en'])],
    ['en', pdfs(['mi', 'Mixed'], ['we', 'Welsh'])],
  ])('falls back to the first PDF when none is in the served language %s', (language, list) => {
    expect(withMetadata(`<dc:language>${language}</dc:language>${list}`).pdfUri).toBe(
      'https://www.legislation.gov.uk/x/mi.pdf',
    );
  });
});

describe('readMetadata: dates and associated documents', () => {
  it('reads the made, laid and in-force dates, the Explanatory Memorandum and its page of a made SI', () => {
    const md = read('uksi-2026-1156-contents-made.xml');
    expect(md.madeDate).toBe('2026-10-30');
    expect(md.laid).toEqual([{ date: '2026-11-04', legislature: 'UnitedKingdomParliament' }]);
    expect(md.comingIntoForce).toEqual(['2026-11-26']);
    expect(md.associatedDocuments).toEqual([
      {
        kind: 'notes',
        title: 'UK Explanatory Memorandum',
        date: '2026-11-04',
        uri: 'https://www.legislation.gov.uk/uksi/2026/1156/pdfs/uksiem_20261156_en_001.pdf',
      },
    ]);
    expect(md.notesUri).toBe('https://www.legislation.gov.uk/uksi/2026/1156/memorandum');
  });

  it('reads an SI with no laying or in-force date: its Explanatory Memorandum and a correction slip to it', () => {
    const md = read('uksi-2019-419-contents.xml');
    expect(md.madeDate).toBe('2019-02-28');
    expect(md).not.toHaveProperty('laid');
    expect(md).not.toHaveProperty('comingIntoForce');
    expect(md.associatedDocuments).toEqual([
      {
        kind: 'notes',
        title: 'UK Explanatory Memorandum',
        date: '2019-03-06',
        uri: 'https://www.legislation.gov.uk/uksi/2019/419/pdfs/uksiem_20190419_en.pdf',
      },
      {
        kind: 'correction_slip',
        title: 'Correction Slip 1',
        date: '2022-02-24',
        uri: 'https://www.legislation.gov.uk/uksi/2019/419/pdfs/uksics_20190419_en_001.pdf',
      },
    ]);
    expect(md.notesUri).toBe('https://www.legislation.gov.uk/uksi/2019/419/memorandum');
  });

  it('reads a commencement order with a made date and nothing else: no documents, no notes page', () => {
    const md = read('uksi-2019-1434-regulation-2-made.xml');
    expect(md.madeDate).toBe('2019-10-30');
    expect(md.associatedDocuments).toEqual([]);
    for (const absent of ['laid', 'comingIntoForce', 'notesUri']) {
      expect(md).not.toHaveProperty(absent);
    }
  });

  it('reads a correction slip with no title as upstream records it', () => {
    expect(read('eur-2016-679-article-28.xml').associatedDocuments).toEqual([
      {
        kind: 'correction_slip',
        date: '2018-05-23',
        uri: 'https://www.legislation.gov.uk/eur/2016/679/pdfs/eurcs_20160679_en_001.pdf',
      },
    ]);
  });

  it('tells the three Explanatory Notes of a Welsh Act apart by language', () => {
    const md = read('anaw-2016-1-section-1-welsh.xml');
    expect(md.associatedDocuments).toEqual([
      {
        kind: 'notes',
        title: 'Explanatory Note',
        date: '2016-01-26',
        language: 'Welsh',
        uri: 'https://www.legislation.gov.uk/anaw/2016/1/pdfs/anawen_20160001_we.pdf',
      },
      {
        kind: 'notes',
        title: 'Explanatory Note',
        date: '2016-01-26',
        language: 'Mixed',
        uri: 'https://www.legislation.gov.uk/anaw/2016/1/pdfs/anawen_20160001_mi.pdf',
      },
      {
        kind: 'notes',
        title: 'Explanatory Note',
        date: '2016-01-26',
        uri: 'https://www.legislation.gov.uk/anaw/2016/1/pdfs/anawen_20160001_en.pdf',
      },
      {
        kind: 'correction_slip',
        title: 'Correction Slip 1',
        date: '2023-01-19',
        language: 'Mixed',
        uri: 'https://www.legislation.gov.uk/anaw/2016/1/pdfs/anawcs_20160001_mi_001.pdf',
      },
    ]);
    expect(md.notesUri).toBe('https://www.legislation.gov.uk/id/anaw/2016/1/section/1/notes/welsh');
  });

  it('reads a Westlaw SI’s laying, in-force date and post-implementation impact assessment', () => {
    const md = read('uksi-1986-1078-regulation-1.xml');
    expect(md.laid).toEqual([{ date: '1986-07-18', legislature: 'UnitedKingdomParliament' }]);
    expect(md.comingIntoForce).toEqual(['1986-08-11']);
    expect(md.associatedDocuments).toMatchObject([
      {
        kind: 'impact_assessment',
        date: '2026-06-16',
        uri: 'https://www.legislation.gov.uk/ukia/2026/109/pdfs/ukia_20260109_en.pdf',
      },
    ]);
    expect(md).not.toHaveProperty('notesUri');
  });

  it('reads an Act’s tables of origins and destinations, leaving its own volume PDFs to pdfUri', () => {
    const md = read('ukpga-2006-46-section-29.xml');
    expect(md.associatedDocuments.map((d) => [d.kind, d.title])).toEqual([
      ['notes', 'Explanatory Note'],
      ['correction_slip', 'Correction Slip'],
      ['table_of_destinations', 'Table Of Destinations'],
      ['table_of_origins', 'Table Of Origins'],
    ]);
    expect(md.notesUri).toBe('https://www.legislation.gov.uk/id/ukpga/2006/46/section/29/notes');
  });

  it('reads a draft: no made date, the in-force date it proposes, its draft memorandum', () => {
    const md = read('ukdsi-2026-9780348288018-contents.xml');
    expect(md.status).toBe('draft');
    expect(md).not.toHaveProperty('madeDate');
    expect(md).not.toHaveProperty('laid');
    expect(md.comingIntoForce).toEqual(['2027-03-31']);
    expect(md.associatedDocuments).toMatchObject([
      { kind: 'notes', title: 'UK Draft Explanatory Memorandum', date: '2026-10-20' },
    ]);
    expect(md.notesUri).toBe('https://www.legislation.gov.uk/ukdsi/2026/9780348288018/memorandum');
  });

  it('reads a Scottish SI: laid before the Scottish Parliament, its Policy Note and its page', () => {
    const md = read('ssi-2026-1-contents-made.xml');
    expect(md.laid).toEqual([{ date: '2026-01-08', legislature: 'ScottishParliament' }]);
    expect(md.comingIntoForce).toEqual(['2026-04-01']);
    expect(md.associatedDocuments.map((d) => [d.kind, d.title])).toEqual([
      ['notes', 'Policy Note'],
      ['other_document', "Children's Rights and Wellbeing Impact Assessment"],
    ]);
    expect(md.notesUri).toBe('https://www.legislation.gov.uk/ssi/2026/1/policy-note');
  });

  it('reads every laying and in-force date in document order, dropping times and entries missing a part', () => {
    const md = withMetadata(
      '',
      '<ukm:Laid Date="2020-01-02" Time="00:00:00" Class="UnitedKingdomParliament"/><ukm:Laid Date="2020-01-03" Class="ScottishParliament"/><ukm:Laid Class="WelshParliament"/><ukm:Laid Date="2020-01-04"/><ukm:ComingIntoForce><ukm:DateTime Date="2020-02-01" Time="00:00:00"/><ukm:DateTime Date="2020-03-01"/><ukm:DateTime Time="00:00:00"/><ukm:DateTime Date="2020-04-01"/></ukm:ComingIntoForce>',
    );
    expect(md.laid).toEqual([
      { date: '2020-01-02', legislature: 'UnitedKingdomParliament' },
      { date: '2020-01-03', legislature: 'ScottishParliament' },
    ]);
    expect(md.comingIntoForce).toEqual(['2020-02-01', '2020-03-01', '2020-04-01']);
  });

  const FAMILIES: [kind: string, path: string[], member: string][] = [
    ['notes', ['ukm:Notes', 'ukm:Alternatives'], 'ukm:Alternative'],
    ['notes_correction_slip', ['ukm:Notes', 'ukm:CorrectionSlips'], 'ukm:CorrectionSlip'],
    ['correction_slip', ['ukm:CorrectionSlips'], 'ukm:CorrectionSlip'],
    ['impact_assessment', ['ukm:ImpactAssessments'], 'ukm:ImpactAssessment'],
    ['ukrpc_opinion', ['ukm:UKRPCOpinions'], 'ukm:UKRPCOpinion'],
    ['transposition_note', ['ukm:TranspositionNotes'], 'ukm:TranspositionNote'],
    ['policy_equality_statement', ['ukm:PolicyEqualityStatements'], 'ukm:PolicyEqualityStatement'],
    ['code_of_practice', ['ukm:CodesOfPractice'], 'ukm:CodeOfPractice'],
    ['code_of_conduct', ['ukm:CodesOfConduct'], 'ukm:CodeOfConduct'],
    ['order_in_council', ['ukm:OrdersInCouncil'], 'ukm:OrderInCouncil'],
    ['table_of_origins', ['ukm:TablesOfOrigins'], 'ukm:TableOfOrigins'],
    ['table_of_destinations', ['ukm:TablesOfDestinations'], 'ukm:TableOfDestinations'],
    ['explanatory_document', ['ukm:ExplanatoryDocuments'], 'ukm:ExplanatoryDocument'],
    ['other_document', ['ukm:OtherDocuments'], 'ukm:OtherDocument'],
  ];

  it('declares exactly the kinds the families report', () => {
    expect([...ASSOCIATED_DOCUMENT_KINDS].sort()).toEqual(FAMILIES.map(([kind]) => kind).sort());
  });

  it.each(FAMILIES)('reads every %s member of %j', (kind, path, member) => {
    const md = withMetadata(
      nest(
        path,
        `<${member} URI="http://www.legislation.gov.uk/doc/1.pdf" Date="2020-01-02" Title="One" Language="Welsh" Size="10"/><${member} URI="http://www.legislation.gov.uk/doc/2.pdf" Date="2020-01-03"/>`,
      ),
    );
    expect(md.associatedDocuments).toEqual([
      {
        kind,
        title: 'One',
        date: '2020-01-02',
        language: 'Welsh',
        uri: 'https://www.legislation.gov.uk/doc/1.pdf',
      },
      { kind, date: '2020-01-03', uri: 'https://www.legislation.gov.uk/doc/2.pdf' },
    ]);
  });

  it('lists families in document order, skipping ukm:Note, the item’s own PDFs and a member with no URI', () => {
    const md = withMetadata(
      [
        '<ukm:OtherDocuments><ukm:OtherDocument URI="http://www.legislation.gov.uk/a.pdf" Title="A"/></ukm:OtherDocuments>',
        '<ukm:Notes><ukm:Note IdURI="http://www.legislation.gov.uk/id/x/notes"/><ukm:Alternatives><ukm:Alternative URI="http://www.legislation.gov.uk/b.pdf" Title="B"/></ukm:Alternatives><ukm:CorrectionSlips><ukm:CorrectionSlip URI="http://www.legislation.gov.uk/c.pdf" Title="C"/></ukm:CorrectionSlips></ukm:Notes>',
        '<ukm:Alternatives><ukm:Alternative URI="http://www.legislation.gov.uk/own.pdf"/></ukm:Alternatives>',
        '<ukm:CorrectionSlips><ukm:CorrectionSlip Title="No link"/><ukm:CorrectionSlip URI="http://www.legislation.gov.uk/d.pdf"/></ukm:CorrectionSlips>',
        '<ukm:Statistics><ukm:TotalParagraphs Value="2"/></ukm:Statistics>',
      ].join(''),
    );
    expect(md.associatedDocuments).toEqual([
      { kind: 'other_document', title: 'A', uri: 'https://www.legislation.gov.uk/a.pdf' },
      { kind: 'notes', title: 'B', uri: 'https://www.legislation.gov.uk/b.pdf' },
      { kind: 'notes_correction_slip', title: 'C', uri: 'https://www.legislation.gov.uk/c.pdf' },
      { kind: 'correction_slip', uri: 'https://www.legislation.gov.uk/d.pdf' },
    ]);
    expect(md.pdfUri).toBe('https://www.legislation.gov.uk/own.pdf');
  });

  const nav = (rel: string) => `http://www.legislation.gov.uk/def/navigation/${rel}`;

  it.each([
    ['notes', true],
    ['memorandum', true],
    ['policy-note', true],
    ['note', false],
    ['notes/toc', false],
    ['memorandum/toc', false],
    ['policy-note/toc', false],
  ])('takes the notes page from rel …/%s: %s', (rel, taken) => {
    const md = withMetadata(
      `<atom:link rel="${nav(rel)}" href="http://www.legislation.gov.uk/x/page" title="t"/>`,
    );
    expect(md.notesUri).toBe(taken ? 'https://www.legislation.gov.uk/x/page' : undefined);
  });

  it('takes the notes page past the instrument’s own note and the memorandum contents', () => {
    const md = withMetadata(
      [
        `<atom:link rel="${nav('note')}" href="http://www.legislation.gov.uk/x/note"/>`,
        `<atom:link rel="${nav('memorandum/toc')}" href="http://www.legislation.gov.uk/x/memorandum/contents"/>`,
        `<atom:link rel="${nav('memorandum')}" href="http://www.legislation.gov.uk/x/memorandum"/>`,
      ].join(''),
    );
    expect(md.notesUri).toBe('https://www.legislation.gov.uk/x/memorandum');
  });
});
