/**
 * @fileoverview Tests for the URL builders: the redirect-free canonical paths
 * verified live, with only allowlisted query parameters sent.
 * @module tests/services/legislation/urls.test
 */

import { describe, expect, it } from 'vitest';
import {
  changesUrl,
  contentsUrl,
  documentPath,
  documentUrl,
  idTitleUrl,
  idUrl,
  numberLookupUrl,
  ORIGIN,
  searchUrl,
  updateUrl,
} from '@/services/legislation/urls.js';

const base = { extentMatch: 'applicable' as const, limit: 20, page: 1, types: ['all'] };

describe('searchUrl', () => {
  it('builds the plain listing path with results-count', () => {
    expect(searchUrl(base)).toBe('/all/data.feed?results-count=20');
  });

  it('joins types with + and adds a year segment', () => {
    expect(searchUrl({ ...base, types: ['ukpga', 'uksi'], year: 2018 })).toBe(
      '/ukpga+uksi/2018/data.feed?results-count=20',
    );
  });

  it('sends a missing range bound as *', () => {
    expect(searchUrl({ ...base, yearFrom: 2020 })).toBe('/all/2020-*/data.feed?results-count=20');
    expect(searchUrl({ ...base, yearTo: 1990 })).toBe('/all/*-1990/data.feed?results-count=20');
    expect(searchUrl({ ...base, yearFrom: 2010, yearTo: 2020 })).toBe(
      '/all/2010-2020/data.feed?results-count=20',
    );
  });

  it('composes extent into the path, = prefixed for exact matching', () => {
    expect(searchUrl({ ...base, types: ['ukpga'], extent: ['england', 'wales'] })).toBe(
      '/ukpga/england+wales/data.feed?results-count=20',
    );
    expect(
      searchUrl({
        ...base,
        types: ['ukpga'],
        year: 2018,
        extent: ['scotland'],
        extentMatch: 'exact',
      }),
    ).toBe('/ukpga/2018/=scotland/data.feed?results-count=20');
  });

  it('adds the as_of date segment when no extent is given', () => {
    expect(searchUrl({ ...base, types: ['ukpga'], asOf: '2000-01-01' })).toBe(
      '/ukpga/2000-01-01/data.feed?results-count=20',
    );
  });

  it('encodes title and text, and sends page only past the first', () => {
    expect(
      searchUrl({ ...base, title: 'data protection', text: '"data processor" & co', page: 3 }),
    ).toBe(
      '/all/data.feed?title=data%20protection&text=%22data%20processor%22%20%26%20co&results-count=20&page=3',
    );
  });

  it('drops empty title and text values', () => {
    expect(searchUrl({ ...base, title: '', text: '' })).toBe('/all/data.feed?results-count=20');
  });
});

describe('document URLs', () => {
  it('builds provision, version, and welsh segments in order', () => {
    expect(documentUrl({ item: 'ukpga/2018/12', provision: 'section/45' })).toBe(
      '/ukpga/2018/12/section/45/data.xml',
    );
    expect(
      documentUrl({ item: 'anaw/2016/1', provision: 'section/1', version: 'enacted', welsh: true }),
    ).toBe('/anaw/2016/1/section/1/enacted/welsh/data.xml');
    expect(documentPath({ item: 'uksi/1984/458', version: 'made' })).toBe('/uksi/1984/458/made');
  });

  it('puts the version after contents and encodes the text filter', () => {
    expect(contentsUrl({ item: 'ukpga/2018/12' })).toBe('/ukpga/2018/12/contents/data.xml');
    expect(
      contentsUrl({
        item: 'ukpga/2018/12',
        version: '2019-01-01',
        welsh: true,
        text: 'data processor',
      }),
    ).toBe('/ukpga/2018/12/contents/2019-01-01/welsh/data.xml?text=data%20processor');
  });

  it('builds identifier and number-lookup URLs', () => {
    expect(idUrl('ukpga/2018/12')).toBe('/id/ukpga/2018/12');
    expect(idTitleUrl('Data Protection Act 2018')).toBe('/id?title=Data%20Protection%20Act%202018');
    expect(numberLookupUrl('uksi', 2019, '419')).toBe('/uksi/2019/data.feed?number=419');
    expect(ORIGIN).toBe('https://www.legislation.gov.uk');
  });
});

describe('changesUrl', () => {
  it('omits the status segment for all and adds the counterpart on the other side', () => {
    expect(
      changesUrl({
        item: 'ukpga/2018/12',
        direction: 'affected',
        status: 'all',
        limit: 50,
        page: 1,
      }),
    ).toBe('/changes/affected/ukpga/2018/12/data.feed?results-count=50');
    expect(
      changesUrl({
        item: 'ukpga/2025/18',
        direction: 'affecting',
        status: 'unapplied',
        counterpart: 'ukpga/2018',
        limit: 500,
        page: 2,
      }),
    ).toBe(
      '/changes/unapplied/affecting/ukpga/2025/18/affected/ukpga/2018/data.feed?results-count=500&page=2',
    );
  });
});

describe('updateUrl', () => {
  it('orders segments date, content type, direction, category, item', () => {
    expect(
      updateUrl({
        date: '2026-09-24',
        contentType: 'legislation',
        category: 'primary',
        item: 'ukpga/2018',
        newOnly: true,
        event: 'published',
        page: 2,
      }),
    ).toBe(
      '/update/2026-09-24/legislation/primary/ukpga/2018/data.feed?new=true&event=published&page=2',
    );
    expect(
      updateUrl({
        contentType: 'changes',
        direction: 'affected',
        item: 'ukpga/2018/12',
        newOnly: false,
        page: 1,
      }),
    ).toBe('/update/changes/affected/ukpga/2018/12/data.feed');
  });
});
