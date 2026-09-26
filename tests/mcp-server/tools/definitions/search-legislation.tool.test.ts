/**
 * @fileoverview Tests for uklaw_search_legislation over recorded feeds: title
 * listings with facets, full-text search, bilingual entries, the canonical
 * redirect-free URL, zero hits and past-the-end pages, feed 404s as validation
 * errors, every declared error reason, blank inputs, and both result surfaces
 * through the production enrichment parse.
 * @module tests/mcp-server/tools/definitions/search-legislation.tool.test
 */

import type { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { searchLegislationTool } from '@/mcp-server/tools/definitions/search-legislation.tool.js';
import { ATTRIBUTION_LINES } from '@/services/legislation/reference-data.js';
import {
  contentText,
  createUpstream,
  errorOf,
  feed,
  fixture,
  gatedPacer,
  notFound,
  ok,
  redirect,
  routes,
  status,
} from '../../../helpers/upstream.js';

type SearchInput = z.input<typeof searchLegislationTool.input>;

async function search(input: SearchInput) {
  const ctx = createMockContext({ errors: searchLegislationTool.errors });
  return searchLegislationTool.handler(searchLegislationTool.input.parse(input), ctx);
}

const TITLE_2018 = '/ukpga/2018/data.feed?title=data&results-count=3';
const TEXT = '/all/data.feed?text=processor&results-count=3';
const TITLE_ALL = '/all/data.feed?title=data%20protection&results-count=3';
const ZERO = '/ukpga/2018/=scotland/data.feed?results-count=20';

describe('results', () => {
  it('lists a type and year with facets and the applied scope', async () => {
    const up = createUpstream(routes([TITLE_2018, feed('search-ukpga-2018-title-data.feed')]));
    const result = await search({ title: 'data', types: ['ukpga'], year: 2018, limit: 3 });
    expect(up.paths()).toEqual([TITLE_2018]);
    expect(result).toMatchObject({
      page: 1,
      limit: 3,
      has_more: false,
      scope: { types: ['ukpga'], as_of: 'current' },
      attribution: [ATTRIBUTION_LINES.ogl],
    });
    expect(result.results.map((r) => r.item)).toEqual(['ukpga/2018/31', 'ukpga/2018/12']);
    expect(result.facets?.types).toEqual([
      { type: 'ukpga', label: 'UK Public General Acts', count: 2 },
    ]);
    expect(result.scope).not.toHaveProperty('extent');
  });

  it('returns no facets for a full-text search and carries the EU line for EU-origin hits', async () => {
    createUpstream(routes([TEXT, feed('search-text-processor.feed')]));
    const result = await search({ text: 'processor', limit: 3 });
    expect(result.facets).toBeUndefined();
    expect(result.has_more).toBe(true);
    expect(result.results.map((r) => r.type)).toContain('eur');
    expect(result.attribution).toEqual([ATTRIBUTION_LINES.ogl, ATTRIBUTION_LINES.eu]);
  });

  it('keeps bilingual titles', async () => {
    const path = '/anaw/2016/data.feed?results-count=3';
    createUpstream(routes([path, feed('search-bilingual.feed')]));
    const result = await search({ types: ['anaw'], year: 2016, limit: 3 });
    expect(result.results[0]).toMatchObject({
      title: 'Tax Collection and Management (Wales) Act 2016',
      title_cy: 'Deddf Casglu a Rheoli Trethi (Cymru) 2016',
    });
  });

  it('caps the year facet at 25 years and counts the rest', async () => {
    createUpstream(routes([TITLE_ALL, feed('search-title-data-protection.feed')]));
    const result = await search({ title: 'data protection', limit: 3 });
    expect(result.facets?.years).toHaveLength(25);
    expect(result.facets?.years_omitted).toBe(12);
    expect(result.facets?.types.map((t) => t.type)).toEqual([
      'uksi',
      'eudn',
      'eur',
      'eudr',
      'ukpga',
      'ssi',
    ]);
  });
});

describe('canonical URL', () => {
  it.each([
    [{ types: ['ukpga', 'all'] }, '/all/data.feed?results-count=20'],
    [{ types: [] }, '/all/data.feed?results-count=20'],
    [{ types: ['ukpga', 'uksi', 'ukpga'] }, '/ukpga+uksi/data.feed?results-count=20'],
    [{ types: ['primary', 'eu-origin'] }, '/primary+eu-origin/data.feed?results-count=20'],
    [{ year_from: 2020 }, '/all/2020-*/data.feed?results-count=20'],
    [{ year_to: 1990 }, '/all/*-1990/data.feed?results-count=20'],
    [{ year_from: 2010, year_to: 2010 }, '/all/2010-2010/data.feed?results-count=20'],
    [
      { types: ['ukpga'], as_of: '2000-01-01', title: 'data protection' },
      '/ukpga/2000-01-01/data.feed?title=data%20protection&results-count=20',
    ],
    [{ extent: ['wales', 'england', 'wales'] }, '/all/wales+england/data.feed?results-count=20'],
    [
      { extent: ['ni'], extent_match: 'exact', text: 'processor' },
      '/all/=ni/data.feed?text=processor&results-count=20',
    ],
    [{ page: 2, limit: 50 }, '/all/data.feed?results-count=50&page=2'],
  ] as [SearchInput, string][])('%j → %s', async (input, path) => {
    const up = createUpstream(routes([path, feed('search-zero-hits.feed')]));
    await search(input);
    expect(up.paths()).toEqual([path]);
  });

  it('treats blank optional strings as unset', async () => {
    const up = createUpstream(
      routes(['/all/data.feed?results-count=20', feed('search-zero-hits.feed')]),
    );
    const result = await search({ text: '', title: '   ', as_of: '', extent_match: '' });
    expect(up.paths()).toEqual(['/all/data.feed?results-count=20']);
    expect(result.scope).toEqual({ types: ['all'], as_of: 'current' });
  });

  it('echoes extent and extent_match in scope', async () => {
    createUpstream(routes([ZERO, feed('search-zero-hits.feed')]));
    const result = await search({
      types: ['ukpga'],
      year: 2018,
      extent: ['scotland'],
      extent_match: 'exact',
    });
    expect(result.scope).toEqual({
      types: ['ukpga'],
      as_of: 'current',
      extent: ['scotland'],
      extent_match: 'exact',
    });
  });
});

describe('empty results and pages past the end', () => {
  it('answers a past-the-end page (307 to the HTML search page) as empty, with no facets claimed, on both surfaces', async () => {
    const path = '/ukpga/data.feed?title=data%20protection&results-count=20&page=9';
    createUpstream(routes([path, redirect(307, '/search?type=ukpga&title=data%20protection')]));
    const result = await runToolContract(searchLegislationTool, {
      title: 'data protection',
      types: ['ukpga'],
      page: 9,
    });
    expect(result.structuredContent).toMatchObject({ results: [], has_more: false, page: 9 });
    expect(result.structuredContent).not.toHaveProperty('facets');
    const text = contentText(result);
    expect(text).toContain('Page is past the last page; start again from page 1.');
    expect(text).not.toContain('Facets');
  });

  it('a feed 404 fails filter_refused naming the refused path, not zero hits, on both surfaces', async () => {
    const path = '/ukpga/2018/scotland/data.feed?results-count=20';
    createUpstream(routes([path, notFound()]));
    const result = await runToolContract(searchLegislationTool, {
      types: ['ukpga'],
      year: 2018,
      extent: ['scotland'],
    });
    const error = errorOf(result);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining(path),
      data: { reason: 'filter_refused', status: 404 },
    });
    const hint = (error.data?.recovery as { hint: string } | undefined)?.hint;
    expect(hint).toBe(
      searchLegislationTool.errors?.find((e) => e.reason === 'filter_refused')?.recovery,
    );
    const text = contentText(result);
    expect(text).toContain(`Recovery: ${hint}`);
    expect(text).toContain('reason filter_refused');
  });
});

describe('errors', () => {
  it.each([
    [{ year: 2018, year_from: 2010 }, 'invalid_year_range'],
    [{ year: 2018, year_to: 2020 }, 'invalid_year_range'],
    [{ year_from: 2020, year_to: 2010 }, 'invalid_year_range'],
    [{ as_of: '2019-02-30' }, 'invalid_date'],
    [{ as_of: '2019-13-01' }, 'invalid_date'],
    [{ extent: ['scotland'], as_of: '2020-01-01' }, 'extent_with_as_of'],
  ] as [SearchInput, string][])('%j fails %s before any request', async (input, reason) => {
    const up = createUpstream([]);
    const ctx = createMockContext({ errors: searchLegislationTool.errors });
    await expect(
      searchLegislationTool.handler(searchLegislationTool.input.parse(input), ctx),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError, data: { reason } });
    expect(up.paths()).toEqual([]);
  });

  it('accepts an empty extent list as unset alongside as_of', async () => {
    const up = createUpstream(
      routes(['/all/2020-01-01/data.feed?results-count=20', feed('search-zero-hits.feed')]),
    );
    await search({ extent: [], as_of: '2020-01-01' });
    expect(up.paths()).toHaveLength(1);
  });

  it('maps a 403 to upstream_refused', async () => {
    createUpstream(routes([TEXT, status(403)]));
    const error = errorOf(
      await runToolContract(searchLegislationTool, { text: 'processor', limit: 3 }),
    );
    expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(error.data?.reason).toBe('upstream_refused');
  });

  it('fails pacer_shed when its only request cannot start', async () => {
    createUpstream(routes([TEXT, feed('search-text-processor.feed')]), {
      pacer: await gatedPacer(0),
    });
    const error = errorOf(
      await runToolContract(searchLegislationTool, { text: 'processor', limit: 3 }),
    );
    expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(error.data?.reason).toBe('pacer_shed');
    expect(error.data?.retryAfter).toEqual(expect.any(Number));
  });

  it.each([
    { as_of: '2019/01/01' },
    { as_of: '1 Jan 2019' },
    { year: 1266 },
    { year: 2101 },
    { year_from: 12345 },
    { limit: 0 },
    { limit: 51 },
    { page: 0 },
    { types: ['statutes'] },
    { extent: ['northern-ireland'] },
    { extent_match: 'fuzzy' },
    { text: 'x'.repeat(501) },
  ])('rejects %j at the schema', async (input) => {
    createUpstream([]);
    const error = errorOf(await runToolContract(searchLegislationTool, input as SearchInput));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.reason).toBe('invalid_arguments');
  });
});

describe('both surfaces and enrichment', () => {
  it('an under-cap partial page carries total and no truncation fields', async () => {
    createUpstream(routes([TITLE_2018, feed('search-ukpga-2018-title-data.feed')]));
    const result = await runToolContract(searchLegislationTool, {
      title: 'data',
      types: ['ukpga'],
      year: 2018,
      limit: 3,
    });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured).toMatchObject({ total: 2, has_more: false });
    expect(structured).not.toHaveProperty('truncated');
    expect(structured).not.toHaveProperty('notice');
    const text = contentText(result);
    expect(text).toContain('## Search results — page 1 (limit 3, has_more: false)');
    expect(text).toContain('### Data Protection Act 2018');
    expect(text).toContain(
      '- Item: `ukpga/2018/12` · ukpga (UK Public General Acts) · year 2018 · number 12',
    );
    expect(text).toContain('Made/enacted: 2018-05-23');
    expect(text).toContain('| ukpga | UK Public General Acts | 2 |');
    expect(text).toContain('**Facets — years** (0 further years omitted): 2025 (1), 2018 (2)');
    expect(text).toMatch(/total\**:?\** ?2/);
    expect(text).toContain(ATTRIBUTION_LINES.ogl);
  });

  it('an under-cap full-text page with a total carries no facets and no truncation', async () => {
    const path = '/ukpga/2010-2020/data.feed?text=processor&results-count=20';
    createUpstream(routes([path, feed('search-ukpga-2010-2020-text-processor.feed')]));
    const result = await runToolContract(searchLegislationTool, {
      text: 'processor',
      types: ['ukpga'],
      year_from: 2010,
      year_to: 2020,
    });
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured).toMatchObject({ total: 2, has_more: false });
    expect(structured).not.toHaveProperty('facets');
    expect(structured).not.toHaveProperty('truncated');
    expect(contentText(result)).not.toContain('Facets');
  });

  it('a capped page carries truncated, shown, cap and the next-page notice; no total when upstream omits it', async () => {
    createUpstream(routes([TEXT, feed('search-text-processor.feed')]));
    const result = await runToolContract(searchLegislationTool, { text: 'processor', limit: 3 });
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured).toMatchObject({
      has_more: true,
      truncated: true,
      shown: 3,
      cap: 3,
      notice: 'More results exist: call again with page 2.',
    });
    expect(structured).not.toHaveProperty('total');
    expect(contentText(result)).toContain('More results exist: call again with page 2.');
  });

  it('a capped page with a reported total carries both', async () => {
    createUpstream(routes([TITLE_ALL, feed('search-title-data-protection.feed')]));
    const result = await runToolContract(searchLegislationTool, {
      title: 'data protection',
      limit: 3,
    });
    expect(result.structuredContent).toMatchObject({
      total: 149,
      truncated: true,
      shown: 3,
      cap: 3,
    });
    expect(contentText(result)).toContain('(12 further years omitted)');
  });

  it('the zero-result page carries total 0 and a notice composed per condition', async () => {
    createUpstream(routes([ZERO, feed('search-zero-hits.feed')]));
    const result = await runToolContract(searchLegislationTool, {
      types: ['ukpga'],
      year: 2018,
      extent: ['scotland'],
      extent_match: 'exact',
    });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured).toMatchObject({ results: [], total: 0, has_more: false });
    expect(structured).not.toHaveProperty('truncated');
    const notice = structured.notice as string;
    expect(notice).toContain('No legislation matched.');
    expect(notice).toContain('Widen types');
    expect(notice).toContain('retry without extent');
    expect(notice).not.toContain('Title search');
    expect(contentText(result)).toContain('No legislation matched.');
  });

  it.each([
    [{ title: 'zzqx' }, '/all/data.feed?title=zzqx&results-count=20', 'uklaw_lookup_citation'],
    [
      { text: '"data subject" zzqx' },
      '/all/data.feed?text=%22data%20subject%22%20zzqx&results-count=20',
      'drop the quotes',
    ],
    [
      { as_of: '1990-01-01' },
      '/all/1990-01-01/data.feed?results-count=20',
      'drop it to search current law',
    ],
  ] as [SearchInput, string, string][])(
    'zero hits for %j add the matching notice fragment',
    async (input, path, fragment) => {
      createUpstream(routes([path, feed('search-zero-hits.feed')]));
      const result = await runToolContract(searchLegislationTool, input);
      expect((result.structuredContent as { notice: string }).notice).toContain(fragment);
      expect((result.structuredContent as { notice: string }).notice).not.toContain('Widen types');
    },
  );

  it('a past-the-end page says so in the notice', async () => {
    const path = '/all/data.feed?title=data%20protection&results-count=20&page=9';
    createUpstream(routes([path, redirect(307, '/search?title=data%20protection')]));
    const result = await runToolContract(searchLegislationTool, {
      title: 'data protection',
      page: 9,
    });
    expect((result.structuredContent as { notice: string }).notice).toContain(
      'Page is past the last page; start again from page 1.',
    );
    expect(result.structuredContent).not.toHaveProperty('total');
  });

  it('keeps injected line breaks and HTML in upstream paths, URIs and dates inside their slot', async () => {
    const injected = fixture('feeds/search-ukpga-2018-title-data.feed')
      .replace(
        '<id>http://www.legislation.gov.uk/id/ukpga/2018/12</id>',
        '<id>http://www.legislation.gov.uk/id/ukpga/2018/12`&lt;b&gt;</id>',
      )
      .replace(
        '<link href="http://www.legislation.gov.uk/ukpga/2018/12/2026-06-19"/>',
        '<link href="http://www.legislation.gov.uk/ukpga/2018/12/2026-06-19&#13;&#10;## Doc &lt;b&gt;"/>',
      )
      .replace(
        '<ukm:CreationDate Date="2018-05-23"/>',
        '<ukm:CreationDate Date="2018-05-23&#10;## Made"/>',
      )
      .replace(
        '<updated>2026-07-09T10:58:22+01:00</updated>',
        '<updated>2026-07-09T10:58:22+01:00 **x** &lt;i&gt;</updated>',
      );
    createUpstream([{ path: TITLE_2018, respond: ok(injected) }]);
    const result = await runToolContract(searchLegislationTool, {
      title: 'data',
      types: ['ukpga'],
      year: 2018,
      limit: 3,
    });
    const structured = result.structuredContent as {
      results: { document_uri?: string; item: string; made_date?: string }[];
    };
    expect(structured.results[1]).toMatchObject({
      item: 'ukpga/2018/12`<b>',
      made_date: '2018-05-23\n## Made',
      document_uri: 'https://www.legislation.gov.uk/ukpga/2018/12/2026-06-19\r\n## Doc <b>',
    });
    const text = contentText(result);
    expect(text).not.toMatch(/[\r\u2028\u2029]/);
    expect(text.split('\n').filter((line) => /^#+ (Doc|Made)\b/.test(line))).toEqual([]);
    expect(text).not.toMatch(/<(b|i)>/);
    expect(text).toContain('- Item: `ukpga/2018/12%60%3Cb%3E` · ukpga (UK Public General Acts)');
    expect(text).toContain(
      '· Document: https://www.legislation.gov.uk/ukpga/2018/12/2026-06-19%0D%0A##%20Doc%20%3Cb%3E',
    );
    expect(text).toContain(
      'Made/enacted: 2018-05-23 ## Made · Updated: 2026-07-09T10:58:22+01:00 \\*\\*x\\*\\* &lt;i>',
    );
  });

  it('renders bilingual titles, summaries and alternative numbers on the text surface', async () => {
    const path = '/uksi/2002/data.feed?results-count=20';
    createUpstream(routes([path, feed('number-uksi-2002-808.feed')]));
    const text = contentText(
      await runToolContract(searchLegislationTool, { types: ['uksi'], year: 2002 }),
    );
    expect(text).toContain(' / Gorchymyn Awdurdodau Lleol');
    expect(text).toContain('Alternative numbers: W 89, Cy 89');
    expect(text).toMatch(/^> This Order modifies/m);
  });
});
