/**
 * @fileoverview Tests for uklaw_lookup_citation over the recorded upstream:
 * numbered citations through the listing feed, short titles through `/id?title=`
 * (301, 300 with exact match or candidates, 404), URIs (calendar and regnal),
 * provision confirmation by fetching the provision document (never `/id`),
 * degraded answers when later requests cannot start, and both result surfaces.
 * @module tests/mcp-server/tools/definitions/lookup-citation.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { getDocumentTool } from '@/mcp-server/tools/definitions/get-document.tool.js';
import { lookupCitationTool } from '@/mcp-server/tools/definitions/lookup-citation.tool.js';
import { ATTRIBUTION_LINES } from '@/services/legislation/reference-data.js';
import {
  clml,
  contentText,
  createUpstream,
  errorOf,
  feed,
  fixture,
  gatedPacer,
  multipleChoices,
  notFound,
  ok,
  type Route,
  redirect,
  routes,
  status,
} from '../../../helpers/upstream.js';

const NUMBER_DPA = '/ukpga/2018/data.feed?number=12';
const S45 = '/ukpga/2018/12/section/45/data.xml';

const dpaNumber = (): Route => ({ path: NUMBER_DPA, respond: feed('number-ukpga-2018-12.feed') });

async function lookup(citation: string) {
  const ctx = createMockContext({ errors: lookupCitationTool.errors });
  return lookupCitationTool.handler(lookupCitationTool.input.parse({ citation }), ctx);
}

describe('numbered citations', () => {
  it('resolves 2018 c. 12 through the listing feed', async () => {
    const up = createUpstream([dpaNumber()]);
    const result = await lookup('2018 c. 12');
    expect(result).toEqual({
      found: true,
      parsed: { kind: 'numbered', type: 'ukpga', year: '2018', number: '12' },
      item: 'ukpga/2018/12',
      id_uri: 'https://www.legislation.gov.uk/id/ukpga/2018/12',
      document_uri: 'https://www.legislation.gov.uk/ukpga/2018/12',
      title: 'Data Protection Act 2018',
      type: 'ukpga',
      type_label: 'UK Public General Acts',
      year: 2018,
      number: '12',
      made_date: '2018-05-23',
      attribution: [ATTRIBUTION_LINES.ogl],
    });
    expect(up.paths()).toEqual([NUMBER_DPA]);
  });

  it('confirms a provision by fetching its document, never through /id', async () => {
    const up = createUpstream([
      dpaNumber(),
      { path: S45, respond: clml('ukpga-2018-12-section-45.xml') },
    ]);
    const result = await lookup('2018 c. 12 s. 45');
    expect(result).toMatchObject({
      found: true,
      item: 'ukpga/2018/12',
      provision_path: 'section/45',
      provision_uri: 'https://www.legislation.gov.uk/id/ukpga/2018/12/section/45',
      provision_found: true,
    });
    expect(result.guidance).toBeUndefined();
    expect(up.paths()).toEqual([NUMBER_DPA, S45]);
    expect(up.paths().some((p) => p.startsWith('/id/'))).toBe(false);
  });

  it('reports a provision the current version does not hold as provision_found false', async () => {
    createUpstream([
      dpaNumber(),
      { path: '/ukpga/2018/12/section/999/data.xml', respond: notFound() },
    ]);
    const result = await lookup('2018 c. 12 s. 999');
    expect(result).toMatchObject({
      found: true,
      provision_path: 'section/999',
      provision_found: false,
    });
    expect(result.guidance).toContain('no provision at section/999');
  });

  it('warms the cache so the next document read for that provision costs no request', async () => {
    const up = createUpstream([
      dpaNumber(),
      { path: S45, respond: clml('ukpga-2018-12-section-45.xml') },
    ]);
    await lookup('2018 c. 12 s. 45');
    const requestsAfterLookup = up.paths().length;
    const ctx = createMockContext({ errors: getDocumentTool.errors });
    const doc = await getDocumentTool.handler(
      getDocumentTool.input.parse({ item: 'ukpga/2018/12', provision: 'section/45' }),
      ctx,
    );
    expect(doc.kind).toBe('full');
    expect(up.paths()).toHaveLength(requestsAfterLookup);
  });

  it('follows an unrevised instrument’s 307 when confirming its provision', async () => {
    const up = createUpstream(
      routes(
        ['/uksi/2002/data.feed?number=808', feed('number-uksi-2002-808.feed')],
        [
          '/wsi/2002/808/article/1/data.xml',
          redirect(307, '/wsi/2002/808/article/1/made/data.xml'),
        ],
        ['/wsi/2002/808/article/1/made/data.xml', clml('uksi-1986-1078-regulation-1.xml')],
      ),
    );
    const result = await lookup('S.I. 2002/808 (W. 89) art. 1');
    expect(result).toMatchObject({ found: true, item: 'wsi/2002/808', provision_found: true });
    expect(up.paths()).toEqual([
      '/uksi/2002/data.feed?number=808',
      '/wsi/2002/808/article/1/data.xml',
      '/wsi/2002/808/article/1/made/data.xml',
    ]);
  });

  it('returns the canonical Welsh item for an S.I. number that is Welsh', async () => {
    createUpstream([
      { path: '/uksi/2002/data.feed?number=808', respond: feed('number-uksi-2002-808.feed') },
    ]);
    const result = await lookup('S.I. 2002/808 (W. 89)');
    expect(result).toMatchObject({
      found: true,
      parsed: { kind: 'numbered', type: 'uksi', year: '2002', number: '808' },
      item: 'wsi/2002/808',
      type: 'wsi',
      type_label: 'Wales Statutory Instruments',
      title_cy: expect.stringContaining('Gorchymyn Awdurdodau Lleol'),
      made_date: '2002-03-21',
    });
  });

  it('lists candidates when a number matches several items (pre-1963 regnal Acts)', async () => {
    createUpstream([
      { path: '/ukpga/1955/data.feed?number=19', respond: feed('number-ukpga-1955-19.feed') },
    ]);
    const result = await lookup('1955 c. 19');
    expect(result).toMatchObject({
      found: false,
      candidates: [
        {
          item: 'ukpga/Eliz2/4-5/19',
          id_uri: 'https://www.legislation.gov.uk/id/ukpga/Eliz2/4-5/19',
        },
        {
          item: 'ukpga/Eliz2/3-4/19',
          id_uri: 'https://www.legislation.gov.uk/id/ukpga/Eliz2/3-4/19',
        },
      ],
    });
    expect(result.guidance).toContain('2 items carry this number');
    expect(result.item).toBeUndefined();
  });

  it('misses an unknown number with guidance, not an error', async () => {
    createUpstream([
      { path: '/uksi/2019/data.feed?number=99999', respond: feed('search-zero-hits.feed') },
    ]);
    const result = await lookup('S.I. 2019/99999');
    expect(result.found).toBe(false);
    expect(result.guidance).toMatch(/No UK Statutory Instruments item is numbered 2019\/99999/);
  });

  it('misses a number whose listing feed answers 404, on both surfaces, not an error', async () => {
    createUpstream([{ path: '/ukpga/2018/data.feed?number=9999', respond: notFound() }]);
    const result = await runToolContract(lookupCitationTool, { citation: '2018 c. 9999' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      found: false,
      guidance: expect.stringContaining('No UK Public General Acts item is numbered 2018/9999'),
    });
    expect(contentText(result)).toContain('No UK Public General Acts item is numbered 2018/9999');
  });
});

describe('short titles', () => {
  it('resolves a unique title (301) and hydrates it from the listing feed', async () => {
    const up = createUpstream([
      {
        path: '/id?title=Data%20Protection%20Act%202018',
        respond: redirect(301, '/id/ukpga/2018/12'),
      },
      dpaNumber(),
    ]);
    const result = await lookup('Data Protection Act 2018');
    expect(result).toMatchObject({
      found: true,
      parsed: { kind: 'title', title: 'Data Protection Act 2018', year: '2018' },
      item: 'ukpga/2018/12',
      title: 'Data Protection Act 2018',
      made_date: '2018-05-23',
    });
    expect(up.paths()).toEqual(['/id?title=Data%20Protection%20Act%202018', NUMBER_DPA]);
  });

  it('picks the one exact match from a 300 list, ignoring case and a leading "The"', async () => {
    createUpstream([
      {
        path: '/id?title=the%20data%20protection%20act%202018',
        respond: multipleChoices('id-title-300'),
      },
      dpaNumber(),
    ]);
    const result = await lookup('the data protection act 2018');
    expect(result).toMatchObject({
      found: true,
      item: 'ukpga/2018/12',
      title: 'Data Protection Act 2018',
    });
  });

  it('matches a candidate carrying a trailing "(repealed)" note, without hydrating a regnal item', async () => {
    const up = createUpstream([
      {
        path: '/id?title=Air%20Force%20Act%201955',
        respond: multipleChoices('id-ukpga-1955-19-300'),
      },
    ]);
    const result = await lookup('Air Force Act 1955');
    expect(result).toMatchObject({
      found: true,
      item: 'ukpga/Eliz2/3-4/19',
      title: 'Air Force Act 1955 (repealed)',
      type: 'ukpga',
      number: '19',
    });
    expect(result.year).toBeUndefined();
    expect(up.paths()).toHaveLength(1);
  });

  it('returns the candidates of an ambiguous title', async () => {
    createUpstream([
      { path: '/id?title=Data%20Protection%20Act', respond: multipleChoices('id-title-300') },
    ]);
    const result = await lookup('Data Protection Act');
    expect(result.found).toBe(false);
    expect(result.candidates).toHaveLength(20);
    expect(result.candidates).toContainEqual({
      item: 'ukpga/2018/12',
      id_uri: 'https://www.legislation.gov.uk/id/ukpga/2018/12',
      title: 'Data Protection Act 2018',
    });
    expect(result.guidance).toContain('20 items match "Data Protection Act"');
    expect(result.attribution).toEqual([ATTRIBUTION_LINES.ogl, ATTRIBUTION_LINES.eu]);
  });

  it('misses an unknown title with routing guidance', async () => {
    createUpstream([{ path: '/id?title=UK%20GDPR', respond: notFound() }]);
    const result = await lookup('UK GDPR');
    expect(result).toMatchObject({ found: false, parsed: { kind: 'title', title: 'UK GDPR' } });
    expect(result.guidance).toContain('uklaw_search_legislation');
  });

  it('misses when the title resolves to something that is not a full item', async () => {
    createUpstream([
      { path: '/id?title=Finance%20Acts', respond: redirect(301, '/id/ukpga/2018') },
    ]);
    const result = await lookup('Finance Acts');
    expect(result.found).toBe(false);
    expect(result.guidance).toContain('could not resolve');
  });
});

describe('URIs', () => {
  it('resolves a calendar-year URI through the listing feed, keeping its provision', async () => {
    const up = createUpstream([
      dpaNumber(),
      { path: S45, respond: clml('ukpga-2018-12-section-45.xml') },
    ]);
    const result = await lookup(
      'https://www.legislation.gov.uk/ukpga/2018/12/section/45/2020-01-01',
    );
    expect(result).toMatchObject({
      found: true,
      parsed: { kind: 'uri', type: 'ukpga', year: '2018', number: '12', provision: 'section/45' },
      item: 'ukpga/2018/12',
      provision_found: true,
    });
    expect(up.paths()).toEqual([NUMBER_DPA, S45]);
  });

  it('checks a regnal URI through /id and omits the unknown title', async () => {
    const up = createUpstream([
      { path: '/id/ukpga/Eliz2/3-4/19', respond: redirect(303, '/ukpga/Eliz2/3-4/19') },
    ]);
    const result = await lookup('ukpga/Eliz2/3-4/19');
    expect(result).toEqual({
      found: true,
      parsed: { kind: 'uri', type: 'ukpga', year: 'Eliz2/3-4', number: '19' },
      item: 'ukpga/Eliz2/3-4/19',
      id_uri: 'https://www.legislation.gov.uk/id/ukpga/Eliz2/3-4/19',
      document_uri: 'https://www.legislation.gov.uk/ukpga/Eliz2/3-4/19',
      type: 'ukpga',
      type_label: 'UK Public General Acts',
      number: '19',
      attribution: [ATTRIBUTION_LINES.ogl],
    });
    expect(up.paths()).toEqual(['/id/ukpga/Eliz2/3-4/19']);
  });

  it('misses a regnal URI upstream does not hold', async () => {
    createUpstream([{ path: '/id/ukpga/Eliz2/3-4/99', respond: notFound() }]);
    const result = await lookup('ukpga/Eliz2/3-4/99');
    expect(result.found).toBe(false);
    expect(result.guidance).toContain('holds no item at ukpga/Eliz2/3-4/99');
  });

  it('lists candidates when a regnal URI is ambiguous', async () => {
    createUpstream([
      { path: '/id/ukpga/Eliz2/3-4/19', respond: multipleChoices('id-ukpga-1955-19-300') },
    ]);
    const result = await lookup('ukpga/Eliz2/3-4/19');
    expect(result.found).toBe(false);
    expect(result.candidates?.map((c) => c.item)).toEqual([
      'ukpga/Eliz2/4-5/19',
      'ukpga/Eliz2/3-4/19',
    ]);
  });
});

describe('unparsed input', () => {
  it.each(['???', 's. 45', 'https://www.legislation.gov.uk/search?title=x'])(
    'answers %j with the accepted forms and spends no request',
    async (citation) => {
      const up = createUpstream([]);
      const result = await lookup(citation);
      expect(result).toMatchObject({ found: false, parsed: { kind: 'unparsed' } });
      expect(result.guidance).toContain('citation_formats');
      expect(up.paths()).toEqual([]);
    },
  );
});

describe('request budget and refusals', () => {
  it('returns the resolved item without title when hydration cannot start', async () => {
    const up = createUpstream(
      [
        {
          path: '/id?title=Data%20Protection%20Act%202018',
          respond: redirect(301, '/id/ukpga/2018/12'),
        },
        dpaNumber(),
      ],
      { pacer: await gatedPacer(1) },
    );
    const result = await lookup('Data Protection Act 2018');
    expect(result).toMatchObject({ found: true, item: 'ukpga/2018/12', year: 2018, number: '12' });
    expect(result.title).toBeUndefined();
    expect(result.guidance).toContain('Title and dates were not fetched');
    expect(up.paths()).toEqual(['/id?title=Data%20Protection%20Act%202018']);
  });

  it('leaves provision_found absent when the provision check cannot start', async () => {
    createUpstream([dpaNumber(), { path: S45, respond: clml('ukpga-2018-12-section-45.xml') }], {
      pacer: await gatedPacer(1),
    });
    const result = await lookup('2018 c. 12 s. 45');
    expect(result).toMatchObject({ found: true, provision_path: 'section/45' });
    expect(result).not.toHaveProperty('provision_found');
    expect(result.guidance).toContain('The provision was not verified');
  });

  it('fails pacer_shed only when the first request cannot start', async () => {
    createUpstream([dpaNumber()], { pacer: await gatedPacer(0) });
    const ctx = createMockContext({ errors: lookupCitationTool.errors });
    await expect(
      lookupCitationTool.handler(lookupCitationTool.input.parse({ citation: '2018 c. 12' }), ctx),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'pacer_shed', retryAfter: expect.any(Number) },
    });
  });

  it('maps a 403 to upstream_refused', async () => {
    createUpstream(routes([NUMBER_DPA, status(403)]));
    const ctx = createMockContext({ errors: lookupCitationTool.errors });
    await expect(
      lookupCitationTool.handler(lookupCitationTool.input.parse({ citation: '2018 c. 12' }), ctx),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'upstream_refused' },
    });
  });
});

describe('both surfaces', () => {
  it('renders a found item with its provision on both surfaces', async () => {
    createUpstream([dpaNumber(), { path: S45, respond: clml('ukpga-2018-12-section-45.xml') }]);
    const result = await runToolContract(lookupCitationTool, { citation: '2018 c. 12 s. 45' });
    expect(result.structuredContent).toMatchObject({
      found: true,
      item: 'ukpga/2018/12',
      provision_found: true,
    });
    const text = contentText(result);
    expect(text).toContain('## Citation found');
    expect(text).toContain('- Item: `ukpga/2018/12`');
    expect(text).toContain(
      '**Parsed:** kind numbered, type ukpga, year 2018, number 12, provision section/45',
    );
    expect(text).toContain('Provision: `section/45`');
    expect(text).toContain('exists in the current version (provision_found: true)');
    expect(text).toContain('Made/enacted: 2018-05-23');
    expect(text).toContain(ATTRIBUTION_LINES.ogl);
  });

  it('renders candidates as a table and guidance on the text surface', async () => {
    createUpstream([
      { path: '/ukpga/1955/data.feed?number=19', respond: feed('number-ukpga-1955-19.feed') },
    ]);
    const result = await runToolContract(lookupCitationTool, { citation: '1955 c. 19' });
    const text = contentText(result);
    expect(text).toContain('## Citation not resolved');
    expect(text).toContain(
      '| `ukpga/Eliz2/3-4/19` | Air Force Act 1955 (repealed) | https://www.legislation.gov.uk/id/ukpga/Eliz2/3-4/19 |',
    );
    expect(text).toContain('**Guidance:**');
  });

  it('keeps injected line breaks and HTML in upstream paths, URIs and dates inside their slot', async () => {
    const injected = fixture('feeds/number-ukpga-2018-12.feed')
      .replace(
        '<id>http://www.legislation.gov.uk/id/ukpga/2018/12</id>',
        '<id>http://www.legislation.gov.uk/id/ukpga/2018/12`&lt;b&gt;</id>',
      )
      .replace(
        '<ukm:CreationDate Date="2018-05-23"/>',
        '<ukm:CreationDate Date="2018-05-23&#13;&#10;## Made &lt;i&gt;"/>',
      );
    createUpstream([{ path: NUMBER_DPA, respond: ok(injected) }]);
    const result = await runToolContract(lookupCitationTool, { citation: '2018 c. 12' });
    expect(result.structuredContent).toMatchObject({
      item: 'ukpga/2018/12`<b>',
      made_date: '2018-05-23\r\n## Made <i>',
    });
    const text = contentText(result);
    expect(text).not.toMatch(/[\r\u2028\u2029]/);
    expect(text.split('\n').filter((line) => /^#+ Made\b/.test(line))).toEqual([]);
    expect(text).not.toMatch(/<(b|i)>/);
    expect(text).toContain('- Item: `ukpga/2018/12%60%3Cb%3E`');
    expect(text).toContain('Made/enacted: 2018-05-23 ## Made &lt;i>');
    expect(text).toContain(
      '- Identifier: https://www.legislation.gov.uk/id/ukpga/2018/12%60%3Cb%3E',
    );
    expect(text).toContain('- Document: https://www.legislation.gov.uk/ukpga/2018/12%60%3Cb%3E');
  });

  it('marks an unverified provision on the text surface', async () => {
    createUpstream([dpaNumber(), { path: S45, respond: clml('ukpga-2018-12-section-45.xml') }], {
      pacer: await gatedPacer(1),
    });
    const text = contentText(
      await runToolContract(lookupCitationTool, { citation: '2018 c. 12 s. 45' }),
    );
    expect(text).toContain('— not verified');
  });

  it('returns pacer_shed as a RateLimited envelope by reason', async () => {
    createUpstream([dpaNumber()], { pacer: await gatedPacer(0) });
    const error = errorOf(await runToolContract(lookupCitationTool, { citation: '2018 c. 12' }));
    expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(error.data?.reason).toBe('pacer_shed');
  });

  it.each(['', 'x'.repeat(301)])('rejects citation of length %#', async (citation) => {
    createUpstream([]);
    const error = errorOf(await runToolContract(lookupCitationTool, { citation }));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.reason).toBe('invalid_arguments');
  });
});
