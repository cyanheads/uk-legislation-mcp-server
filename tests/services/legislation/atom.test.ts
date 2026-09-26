/**
 * @fileoverview Tests for the Atom parsers over recorded feeds: search and
 * listing entries (bilingual titles, alternative numbers, subjects, sparse
 * entries), facets, paging; changes-feed effects; Publication Log events.
 * @module tests/services/legislation/atom.test
 */

import { describe, expect, it } from 'vitest';
import { parseChangesFeed } from '@/services/legislation/atom/changes-feed.js';
import { entries, readPaging } from '@/services/legislation/atom/common.js';
import { parsePublicationLog } from '@/services/legislation/atom/publication-log.js';
import { parseSearchFeed } from '@/services/legislation/atom/search-feed.js';
import { parseXml } from '@/services/legislation/xml.js';
import { fixture } from '../../helpers/upstream.js';

describe('readPaging', () => {
  it('reads has-more from the next link, not leg:morePages', () => {
    const feed = parseXml(fixture('feeds/search-ukpga-2018-title-data.feed'), 'a feed');
    expect(fixture('feeds/search-ukpga-2018-title-data.feed')).toContain(
      '<leg:morePages>1</leg:morePages>',
    );
    expect(readPaging(feed)).toEqual({ page: 1, hasMore: false, total: 2 });
  });

  it('reads total pages on changes feeds and omits an absent total', () => {
    const changes = parseXml(fixture('feeds/changes-affected-ukpga-2018-12.feed'), 'a feed');
    expect(readPaging(changes)).toEqual({ page: 1, hasMore: true, total: 2271, totalPages: 757 });
    const text = parseXml(fixture('feeds/search-text-processor.feed'), 'a feed');
    expect(readPaging(text)).toEqual({ page: 1, hasMore: true });
  });

  it('defaults the page to 1 and lists entries in order', () => {
    const feed = parseXml('<feed><entry><id>a</id></entry><entry><id>b</id></entry></feed>', 'x');
    expect(readPaging(feed)).toEqual({ page: 1, hasMore: false });
    expect(entries(feed)).toHaveLength(2);
  });
});

describe('parseSearchFeed', () => {
  it('parses a title search with facets', () => {
    const feed = parseSearchFeed(fixture('feeds/search-ukpga-2018-title-data.feed'));
    expect(feed.results).toHaveLength(2);
    expect(feed.results[0]).toEqual({
      item: 'ukpga/2018/31',
      id_uri: 'https://www.legislation.gov.uk/id/ukpga/2018/31',
      title: 'Health and Social Care (National Data Guardian) Act 2018',
      type: 'ukpga',
      type_label: 'UK Public General Acts',
      year: 2018,
      number: '31',
      alternative_numbers: [],
      made_date: '2018-12-20',
      summary:
        'An Act to establish, and make provision about, the National Data Guardian for Health and Social Care; and for connected purposes.',
      subjects: [],
      updated: '2024-05-05T04:17:29+01:00',
      document_uri: 'https://www.legislation.gov.uk/ukpga/2018/31/2019-04-01',
    });
    expect(feed.facets).toEqual({
      types: [{ type: 'ukpga', label: 'UK Public General Acts', count: 2 }],
      years: [
        { year: 2025, count: 1 },
        { year: 2018, count: 2 },
        { year: 2014, count: 1 },
        { year: 1998, count: 1 },
        { year: 1984, count: 1 },
        { year: 1967, count: 1 },
      ],
      years_omitted: 0,
    });
    expect(feed.total).toBe(2);
    expect(feed.hasMore).toBe(false);
  });

  it('drops the ukamended sub-variants of EU type facets and caps years at 25', () => {
    const feed = parseSearchFeed(fixture('feeds/search-title-data-protection.feed'));
    expect(feed.facets.types.map((t) => [t.type, t.count])).toEqual([
      ['uksi', 89],
      ['eudn', 39],
      ['eur', 11],
      ['eudr', 5],
      ['ukpga', 3],
      ['ssi', 2],
    ]);
    expect(feed.facets.years).toHaveLength(25);
    expect(feed.facets.years_omitted).toBe(12);
    const years = feed.facets.years.map((y) => y.year);
    expect(years).toEqual([...years].sort((a, b) => b - a));
    expect(feed.total).toBe(149);
    expect(feed.hasMore).toBe(true);
  });

  it('keeps one facet per type across the whole all-types listing', () => {
    const feed = parseSearchFeed(fixture('feeds/listing-all.feed'));
    const codes = feed.facets.types.map((t) => t.type);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toContain('eur');
    expect(feed.facets.types.every((t) => !t.type.includes('|'))).toBe(true);
    expect(feed.facets.years_omitted).toBe(5);
    expect(feed.total).toBeUndefined();
  });

  it('reads bilingual titles and the English summary', () => {
    const [first] = parseSearchFeed(fixture('feeds/search-bilingual.feed')).results;
    expect(first).toMatchObject({
      item: 'anaw/2016/6',
      title: 'Tax Collection and Management (Wales) Act 2016',
      title_cy: 'Deddf Casglu a Rheoli Trethi (Cymru) 2016',
    });
    expect(first?.summary).toBeDefined();
    expect(first?.summary).not.toMatch(/Deddf/);
  });

  it('reads the canonical Welsh type, alternative numbers, and de-duplicated subjects', () => {
    const [entry] = parseSearchFeed(fixture('feeds/number-uksi-2002-808.feed')).results;
    expect(entry).toMatchObject({
      item: 'wsi/2002/808',
      type: 'wsi',
      type_label: 'Wales Statutory Instruments',
      alternative_numbers: [
        { series: 'W', value: '89' },
        { series: 'Cy', value: '89' },
      ],
    });
    expect(entry?.subjects.filter((s) => s === 'Cabinet')).toHaveLength(1);
    expect(entry?.subjects).toContain('LOCAL GOVERNMENT, WALES');
  });

  it('keeps regnal item paths from listing entries', () => {
    const feed = parseSearchFeed(fixture('feeds/number-ukpga-1955-19.feed'));
    expect(feed.results.map((r) => [r.item, r.year, r.number])).toEqual([
      ['ukpga/Eliz2/4-5/19', 1955, '19'],
      ['ukpga/Eliz2/3-4/19', 1955, '19'],
    ]);
  });

  it('parses a zero-hit feed', () => {
    const feed = parseSearchFeed(fixture('feeds/search-zero-hits.feed'));
    expect(feed.results).toEqual([]);
    expect(feed.total).toBe(0);
    expect(feed.hasMore).toBe(false);
  });

  it('omits fields a sparse entry does not carry instead of inventing them', () => {
    const recorded = fixture('feeds/search-ukpga-2018-title-data.feed');
    const sparse = recorded
      .replace(/<summary>[\s\S]*?<\/summary>/g, '')
      .replace(/<ukm:(?:Year|Number|ISBN|CreationDate)[^>]*\/>/g, '')
      .replace(/<link href="[^"]*"\/>/g, '')
      .replace(/<updated>2024[^<]*<\/updated>/, '');
    const [entry] = parseSearchFeed(sparse).results;
    expect(entry).toEqual({
      item: 'ukpga/2018/31',
      id_uri: 'https://www.legislation.gov.uk/id/ukpga/2018/31',
      title: 'Health and Social Care (National Data Guardian) Act 2018',
      type: 'ukpga',
      type_label: 'UK Public General Acts',
      number: '31',
      alternative_numbers: [],
      subjects: [],
    });
  });

  it('skips an entry whose id is not a legislation.gov.uk URI', () => {
    const feed = parseSearchFeed(
      '<feed><entry><id>https://example.org/x</id><title>X</title></entry></feed>',
    );
    expect(feed.results).toEqual([]);
  });
});

describe('parseChangesFeed', () => {
  it('parses effect records from a recorded changes feed', () => {
    const feed = parseChangesFeed(fixture('feeds/changes-affected-ukpga-2018-12.feed'));
    expect(feed.total).toBe(2271);
    expect(feed.hasMore).toBe(true);
    expect(feed.effects).toHaveLength(3);
    expect(feed.effects[0]).toEqual({
      effect_id: 'key-afc4da5af850ada1378557cf240207e0',
      type: 'word substituted',
      applied: false,
      requires_applied: true,
      outstanding: true,
      affected: {
        item: 'ukpga/2018/12',
        id_uri: 'https://www.legislation.gov.uk/id/ukpga/2018/12',
        title: 'Data Protection Act 2018',
        provisions_label: 's. 65 heading',
        provisions: [
          {
            label: 's. 65 heading',
            uri: 'https://www.legislation.gov.uk/id/ukpga/2018/12/part/3/chapter/4/crossheading/general-obligations',
          },
        ],
      },
      affecting: {
        item: 'uksi/2026/386',
        id_uri: 'https://www.legislation.gov.uk/id/uksi/2026/386',
        title:
          'The Data (Use and Access) Act 2025 (Consequential Amendments and Transitional Provision) Regulations 2026',
        provisions_label: 'Sch. 2 para. 23(2)(3)',
        provisions: [
          { label: 'Sch. 2', uri: 'https://www.legislation.gov.uk/id/uksi/2026/386/schedule/2' },
          {
            label: 'para. 23(2)',
            uri: 'https://www.legislation.gov.uk/id/uksi/2026/386/schedule/2/paragraph/23/2',
          },
          {
            label: '(3)',
            uri: 'https://www.legislation.gov.uk/id/uksi/2026/386/schedule/2/paragraph/23/3',
          },
        ],
      },
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

  it('never surfaces the editor Comments attribute', () => {
    const feed = parseChangesFeed(fixture('feeds/changes-affected-ukpga-2018-12.feed'));
    expect(JSON.stringify(feed.effects)).not.toContain('Editor: please note');
  });

  it('parses an empty feed with its zero total', () => {
    const feed = parseChangesFeed(fixture('feeds/changes-empty.feed'));
    expect(feed).toMatchObject({ effects: [], total: 0, hasMore: false });
  });

  it('skips an entry without an effect element', () => {
    const feed = parseChangesFeed(
      '<feed><openSearch:totalResults>1</openSearch:totalResults><entry><id>x</id></entry></feed>',
    );
    expect(feed.effects).toEqual([]);
    expect(feed.total).toBe(1);
  });
});

describe('parsePublicationLog', () => {
  it('parses a day page of events', () => {
    const page = parsePublicationLog(fixture('feeds/update-2026-09-24.feed'));
    expect(page.total).toBe(1232);
    expect(page.hasMore).toBe(true);
    expect(page.events).toHaveLength(20);
    expect(page.events[0]).toEqual({
      updated: '2026-09-24T23:58:08.541133+01:00',
      item: {
        path: 'uksi/1990/1869',
        id_uri: 'https://www.legislation.gov.uk/id/uksi/1990/1869',
        title: 'The Tuberculosis (England and Wales) (Amendment) Order 1990',
      },
      content_type: 'changes',
      event: 'published',
      type: 'uksi',
      year: 1990,
      number: '1869',
      resource_uri: 'https://www.legislation.gov.uk/changes/affecting/uksi/1990/1869',
      direction: 'affecting',
      publisher: 'editorial.legislation.gov.uk',
    });
  });

  it('reads document events with format, language, flags and category', () => {
    const page = parsePublicationLog(fixture('feeds/update-2026-09-24-legislation-new.feed'));
    expect(page.hasMore).toBe(false);
    expect(page.total).toBe(7);
    const event = page.events[0];
    expect(event?.content_type).toBe('legislation');
    expect(event?.new).toBe(true);
    for (const e of page.events) {
      expect(e.item.path).toMatch(/^[a-z]+\/\d{4}\/\d+$/);
      expect(e.resource_uri).toMatch(/^https:\/\/www\.legislation\.gov\.uk\//);
    }
  });

  it('parses an empty page', () => {
    const page = parsePublicationLog(fixture('feeds/update-2026-09-24-changes-primary-empty.feed'));
    expect(page).toMatchObject({ events: [], total: 0, hasMore: false });
  });

  it('skips an entry without a legislation identifier', () => {
    const page = parsePublicationLog(
      '<feed><entry><id>x</id><dc:identifier>urn:x</dc:identifier></entry></feed>',
    );
    expect(page.events).toEqual([]);
  });
});
