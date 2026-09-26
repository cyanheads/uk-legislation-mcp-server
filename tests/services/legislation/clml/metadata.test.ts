/**
 * @fileoverview Tests for CLML metadata reading over recorded documents:
 * identity, status read per document, publishers, versions, links (the main
 * PDF, not an explanatory note), Welsh documents, and PDF-only items.
 * @module tests/services/legislation/clml/metadata.test
 */

import { describe, expect, it } from 'vitest';
import { readMetadata } from '@/services/legislation/clml/metadata.js';
import { parseXml } from '@/services/legislation/xml.js';
import { fixture } from '../../../helpers/upstream.js';

const read = (name: string) => readMetadata(parseXml(fixture(`clml/${name}`), 'a document'));

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
      restrictExtent: 'E+W+S+N.I.',
      restrictStartDate: '2026-06-19',
      aknUri: 'https://www.legislation.gov.uk/ukpga/2018/12/section/45/data.akn',
      pdfUri: 'https://www.legislation.gov.uk/ukpga/2018/12/pdfs/ukpga_20180012_en.pdf',
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
