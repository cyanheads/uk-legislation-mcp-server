/**
 * @fileoverview Tests for uklaw_get_document over recorded CLML: provision
 * reads (current, enacted, dated, EU, Westlaw, Welsh and its English
 * fallback, repealed), unapplied effects filtered to the provision with
 * whole-item effects kept, the outline arms (oversized fragment, large item,
 * match_text), whole small items reached through an unrevised 307, PDF-only
 * items, the not-found disambiguation, every declared error reason, degraded
 * answers when a later request cannot start, and both result surfaces.
 * @module tests/mcp-server/tools/definitions/get-document.tool.test
 */

import type { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { getDocumentTool } from '@/mcp-server/tools/definitions/get-document.tool.js';
import { ATTRIBUTION_LINES } from '@/services/legislation/reference-data.js';
import {
  clml,
  contentText,
  createUpstream,
  errorOf,
  fixture,
  gatedPacer,
  notFound,
  ok,
  type Route,
  redirect,
  routes,
  status,
  thrown,
} from '../../../helpers/upstream.js';

type DocumentInput = z.input<typeof getDocumentTool.input>;

const S45 = '/ukpga/2018/12/section/45/data.xml';
const ID_DPA = '/id/ukpga/2018/12';
const SI_1984 = {
  contents: '/uksi/1984/458/contents/data.xml',
  contentsMade: '/uksi/1984/458/contents/made/data.xml',
  whole: '/uksi/1984/458/made/data.xml',
};

async function read(input: DocumentInput) {
  const ctx = createMockContext({ errors: getDocumentTool.errors });
  const output = await getDocumentTool.handler(getDocumentTool.input.parse(input), ctx);
  return { output, notice: getEnrichment(ctx).notice as string | undefined };
}

function failure(input: DocumentInput) {
  const ctx = createMockContext({ errors: getDocumentTool.errors });
  return thrown(() => getDocumentTool.handler(getDocumentTool.input.parse(input), ctx));
}

/** Pads the first Text after the element with this IdURI by `extra` characters of its own words. */
function inflate(xml: string, idUri: string, extra: number): string {
  const at = xml.indexOf(`IdURI="${idUri}"`);
  const text = xml.indexOf('<Text>', at) + '<Text>'.length;
  const filler = ' personal data of the data subject'.repeat(Math.ceil(extra / 34)).slice(0, extra);
  return `${xml.slice(0, text)}${filler}${xml.slice(text)}`;
}

/** The SI 1984/458 table of contents with its leaf list padded or cut to `leaves` entries. */
function contents1984(leaves: number): string {
  const xml = fixture('clml/uksi-1984-458-contents-made.xml');
  const items = [...xml.matchAll(/<ContentsItem [\s\S]*?<\/ContentsItem>\n?/g)].map((m) => m[0]);
  const list: string[] = [];
  for (let i = 0; i < leaves; i += 1) {
    const template = items[i % items.length] as string;
    list.push(template.replaceAll(/regulation(\/|-)\d+/g, `regulation$1${i + 1}`));
  }
  const start = xml.indexOf(items[0] as string);
  const end = xml.indexOf(items.at(-1) as string) + (items.at(-1) as string).length;
  return `${xml.slice(0, start)}${list.join('')}${xml.slice(end)}`;
}

/** A recorded contents document keeping only its first `n` unapplied effects. */
function keepEffects(xml: string, n: number): string {
  let seen = 0;
  return xml.replace(/<ukm:UnappliedEffect [\s\S]*?<\/ukm:UnappliedEffect>/g, (m) =>
    ++seen <= n ? m : '',
  );
}

describe('provision reads', () => {
  it('reads current revised text with the effects touching the provision', async () => {
    const up = createUpstream(routes([S45, clml('ukpga-2018-12-section-45.xml')]));
    const { output, notice } = await read({ item: 'ukpga/2018/12', provision: 's. 45' });
    expect(up.paths()).toEqual([S45]);
    expect(notice).toBeUndefined();
    expect(output).toMatchObject({
      kind: 'full',
      item: {
        path: 'ukpga/2018/12',
        id_uri: 'https://www.legislation.gov.uk/id/ukpga/2018/12',
        title: 'Data Protection Act 2018',
        type: 'ukpga',
        type_label: 'UK Public General Acts',
        category: 'primary',
        year: 2018,
        number: '12',
      },
      provision: {
        path: 'section/45',
        id_uri: 'https://www.legislation.gov.uk/id/ukpga/2018/12/section/45',
        label: 'Section 45',
        heading: 'Right of access by the data subject',
        extent: 'E+W+S+N.I.',
        valid_from: '2026-06-19',
      },
      version: {
        requested: 'current',
        applied: '2026-06-19',
        document_uri: 'https://www.legislation.gov.uk/ukpga/2018/12/section/45',
      },
      language: 'en',
      editorial: {
        document_status: 'revised',
        publisher: ['Statute Law Database'],
        modified: '2026-07-09',
        outstanding_effects: 3,
      },
      links: {
        web: 'https://www.legislation.gov.uk/ukpga/2018/12/section/45',
        xml: 'https://www.legislation.gov.uk/ukpga/2018/12/section/45/data.xml',
        akn: 'https://www.legislation.gov.uk/ukpga/2018/12/section/45/data.akn',
        pdf: 'https://www.legislation.gov.uk/ukpga/2018/12/pdfs/ukpga_20180012_en.pdf',
      },
      attribution: [ATTRIBUTION_LINES.ogl],
    });
    expect(output.version.available).toEqual([
      'enacted',
      '2018-05-25',
      '2020-12-31',
      '2024-01-01',
      '2025-09-05',
      '2026-02-05',
      '2026-06-19',
    ]);
    expect(output.editorial.caveat).toMatch(/^Revised text: an editorial consolidation/);
    expect(output.editorial.caveat).toContain(
      '3 outstanding effects are recorded against this provision',
    );
    expect(output.unapplied_effects.map((e) => e.affected.provisions_label)).toEqual([
      's. 45(2)(f)',
      's. 45(5)(c)(d)',
      's. 45(7)(b)',
    ]);
    expect(output.text?.split('\n')[0]).toBe('**Right of access by the data subject**');
    expect(output.annotations?.map((a) => a.label)).toContain('F9');
    expect(output.outline).toBeUndefined();
  });

  it('reads the as-enacted text with a caveat that effects describe the revised text', async () => {
    const path = '/ukpga/2018/12/section/45/enacted/data.xml';
    createUpstream(routes([path, clml('ukpga-2018-12-section-45-enacted.xml')]));
    const { output } = await read({
      item: 'ukpga/2018/12',
      provision: 'section/45',
      version: 'made',
    });
    expect(output.version).toMatchObject({ requested: 'made', applied: 'enacted' });
    expect(output.editorial).toMatchObject({
      document_status: 'final',
      publisher: ["King's Printer of Acts of Parliament"],
    });
    expect(output.editorial.caveat).toContain('Original text as enacted or made');
    expect(output.editorial.caveat).toContain('Read version current for the revised text.');
    expect(output.editorial.caveat).toContain('not the history of the version shown');
    expect(output.unapplied_effects).toHaveLength(3);
  });

  it('reads a dated version with the provision’s own validity window', async () => {
    const path = '/ukpga/2018/12/section/45/2019-01-01/data.xml';
    createUpstream(routes([path, clml('ukpga-2018-12-section-45-2019-01-01.xml')]));
    const { output } = await read({
      item: 'ukpga/2018/12',
      provision: 'section/45',
      version: '2019-01-01',
    });
    expect(output.version).toMatchObject({
      requested: '2019-01-01',
      applied: '2018-07-23',
      document_uri: 'https://www.legislation.gov.uk/ukpga/2018/12/section/45/2019-01-01',
    });
    // The nearest ancestor carrying restrict dates is the section's P1group, not the document root.
    expect(output.provision).toMatchObject({ valid_from: '2018-05-25', valid_to: '2020-12-31' });
    expect(output.links.web).toBe(
      'https://www.legislation.gov.uk/ukpga/2018/12/section/45/2019-01-01',
    );
    expect(output.editorial.caveat).toContain('not the history of the version shown');
  });

  it('asks an EU-origin item for /adopted directly and carries the EU line', async () => {
    const path = '/eur/2016/679/article/28/adopted/data.xml';
    const up = createUpstream(routes([path, clml('eur-2016-679-article-28.xml')]));
    const { output } = await read({
      item: 'eur/2016/679',
      provision: 'art. 28',
      version: 'enacted',
    });
    expect(up.paths()).toEqual([path]);
    expect(output.item).toMatchObject({ type: 'eur', category: 'euretained' });
    expect(output.provision).toMatchObject({ path: 'article/28', label: 'Article 28' });
    expect(output.attribution).toEqual([ATTRIBUTION_LINES.ogl, ATTRIBUTION_LINES.eu]);
  });

  it('credits Westlaw on a Westlaw-contributed instrument', async () => {
    createUpstream(
      routes(['/uksi/1986/1078/regulation/1/data.xml', clml('uksi-1986-1078-regulation-1.xml')]),
    );
    const { output } = await read({ item: 'uksi/1986/1078', provision: 'reg. 1' });
    expect(output.editorial.publisher).toEqual(['Westlaw', 'Statute Law Database']);
    expect(output.attribution).toEqual([ATTRIBUTION_LINES.ogl, ATTRIBUTION_LINES.westlaw]);
  });

  it('marks a repealed provision', async () => {
    createUpstream(
      routes(['/ukpga/1998/29/section/1/data.xml', clml('ukpga-1998-29-section-1.xml')]),
    );
    const { output } = await read({ item: 'ukpga/1998/29', provision: 'section/1' });
    expect(output.provision).toMatchObject({
      status: 'Repealed',
      heading: 'Basic interpretative provisions.',
    });
    expect(output.text).toMatch(/^\*\(repealed\)\*/);
  });

  it.each([
    ['draft', 'draft', /^Draft legislation: not made law\./],
    [undefined, 'unknown', /did not report an editorial status .* treat the text as unverified/],
  ])('states a fixed caveat for document status %s', async (value, reported, caveat) => {
    const recorded = fixture('clml/ukpga-2018-12-section-45.xml');
    const body = recorded.replace(
      '<ukm:DocumentStatus Value="revised"/>',
      value ? `<ukm:DocumentStatus Value="${value}"/>` : '',
    );
    createUpstream([{ path: S45, respond: ok(body) }]);
    const { output } = await read({ item: 'ukpga/2018/12', provision: 'section/45' });
    expect(output.editorial.document_status).toBe(reported);
    expect(output.editorial.caveat).toMatch(caveat);
  });

  it('notes a simplified table in a provision read', async () => {
    const recorded = fixture('clml/ukpga-2018-12-section-45.xml');
    const withTable = recorded.replace(
      '<Text>That information is—</Text>',
      '<Text>That information is—</Text><Tabular><table><tr><th colspan="2">Merged</th></tr><tr><td>a</td><td>b</td></tr></table></Tabular>',
    );
    createUpstream([{ path: S45, respond: ok(withTable) }]);
    const { output, notice } = await read({ item: 'ukpga/2018/12', provision: 'section/45' });
    expect(output.text).toContain('| Merged |');
    expect(notice).toBe(
      'Tables with merged cells were simplified; the XML link carries the exact layout.',
    );
  });

  it('adds no simplified-table notice for single-span cells, on either surface', async () => {
    const recorded = fixture('clml/ukpga-2018-12-section-45.xml');
    const withTable = recorded.replace(
      '<Text>That information is—</Text>',
      '<Text>That information is—</Text><Tabular><table><tr><th rowspan="1" colspan="1">Plain</th><th rowspan="1" colspan="1">Head</th></tr><tr><td rowspan="1" colspan="1">a</td><td rowspan="1" colspan="1">b</td></tr></table></Tabular>',
    );
    createUpstream([{ path: S45, respond: ok(withTable) }]);
    const result = await runToolContract(getDocumentTool, {
      item: 'ukpga/2018/12',
      provision: 'section/45',
    });
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.text).toContain('| Plain | Head |');
    expect(structured).not.toHaveProperty('notice');
    const text = contentText(result);
    expect(text).toContain('| Plain | Head |');
    expect(text).not.toContain('Tables with merged cells were simplified');
  });

  it('returns empty text for a fragment carrying metadata but no body', async () => {
    const recorded = fixture('clml/ukpga-2018-12-section-45.xml');
    const bodiless = recorded.replace(/<Primary>[\s\S]*<\/Primary>/, '');
    createUpstream([{ path: S45, respond: ok(bodiless) }]);
    const { output } = await read({ item: 'ukpga/2018/12', provision: 'section/45' });
    expect(output).toMatchObject({ kind: 'full', text: '', annotations: [] });
    expect(output.unapplied_effects).toHaveLength(3);
  });

  it('splits a provision and version carried by an item URI', async () => {
    const path = '/ukpga/2018/12/section/45/enacted/data.xml';
    const up = createUpstream(routes([path, clml('ukpga-2018-12-section-45-enacted.xml')]));
    await read({ item: 'http://www.legislation.gov.uk/ukpga/2018/12/section/45/enacted/data.xml' });
    expect(up.paths()).toEqual([path]);
  });

  it('lets an explicit dated version override the version in the URI, and accepts a matching provision', async () => {
    const path = '/ukpga/2018/12/section/45/2019-01-01/data.xml';
    const up = createUpstream(routes([path, clml('ukpga-2018-12-section-45-2019-01-01.xml')]));
    await read({
      item: 'https://www.legislation.gov.uk/ukpga/2018/12/section/45/enacted',
      provision: 's. 45',
      version: '2019-01-01',
    });
    expect(up.paths()).toEqual([path]);
  });

  it('lets an explicit version current override the version in the URI, on both surfaces', async () => {
    const up = createUpstream(routes([S45, clml('ukpga-2018-12-section-45.xml')]));
    const result = await runToolContract(getDocumentTool, {
      item: 'https://www.legislation.gov.uk/ukpga/2018/12/section/45/enacted',
      version: 'current',
    });
    expect(up.paths()).toEqual([S45]);
    expect(result.structuredContent).toMatchObject({
      version: { requested: 'current', applied: '2026-06-19' },
    });
    expect(contentText(result)).toContain('requested current, applied 2026-06-19');
  });

  it('lets an explicit language en override /welsh in the URI, on both surfaces', async () => {
    const up = createUpstream(routes([S45, clml('ukpga-2018-12-section-45.xml')]));
    const result = await runToolContract(getDocumentTool, {
      item: 'https://www.legislation.gov.uk/ukpga/2018/12/section/45/welsh',
      language: 'en',
    });
    expect(up.paths()).toEqual([S45]);
    expect(result.structuredContent).toMatchObject({ language: 'en' });
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(contentText(result)).toContain('language en');
  });
});

describe('Welsh', () => {
  const WELSH = '/anaw/2016/1/section/1/welsh/data.xml';

  it('reads Welsh text and keeps whole-item effects on the provision', async () => {
    createUpstream(routes([WELSH, clml('anaw-2016-1-section-1-welsh.xml')]));
    const { output, notice } = await read({
      item: 'anaw/2016/1',
      provision: 'section/1',
      language: 'cy',
    });
    expect(notice).toBeUndefined();
    expect(output.language).toBe('cy');
    expect(output.links.web).toBe('https://www.legislation.gov.uk/anaw/2016/1/section/1/welsh');
    const kept = output.unapplied_effects.map((e) => e.type);
    expect(kept).toContain('power to amend conferred');
    expect(kept).toContain('savings for amendments by 2018 anaw 1, s. 6, Sch. 6');
    const labels = output.unapplied_effects.map((e) => e.affected.provisions_label);
    expect(labels).not.toContain('s. 20(3)(ma)');
    expect(labels).not.toContain('s. 135(2)(ia)');
    expect(labels).not.toContain('s. 198A');
    expect(
      output.unapplied_effects.find((e) => e.type === 'power to amend conferred'),
    ).toMatchObject({
      outstanding: true,
      welsh_requires_applied: true,
      affected: { provisions_label: 'Act', provisions: [] },
    });
    expect(
      output.unapplied_effects.find((e) => e.type.startsWith('savings for amendments')),
    ).toMatchObject({ outstanding: false, requires_applied: false });
  });

  it('does not list an effect on a section range elsewhere in the Act', async () => {
    createUpstream(routes([WELSH, clml('anaw-2016-1-section-1-welsh.xml')]));
    const { output } = await read({ item: 'anaw/2016/1', provision: 'section/1', language: 'cy' });
    expect(output.unapplied_effects.map((e) => e.affected.provisions_label)).not.toContain(
      's. 186A-186C',
    );
    expect(output.editorial.outstanding_effects).toBe(1);

    const result = await runToolContract(getDocumentTool, {
      item: 'anaw/2016/1',
      provision: 'section/1',
      language: 'cy',
    });
    const structured = result.structuredContent as {
      editorial: { outstanding_effects: number };
      unapplied_effects: { affected: { provisions_label?: string } }[];
    };
    expect(structured.editorial.outstanding_effects).toBe(1);
    expect(structured.unapplied_effects.map((e) => e.affected.provisions_label)).not.toContain(
      's. 186A-186C',
    );
    const text = contentText(result);
    expect(text).toContain('outstanding effects 1');
    expect(text).not.toContain('186A');
  });

  it('takes the Welsh language from an item URI', async () => {
    const up = createUpstream(routes([WELSH, clml('anaw-2016-1-section-1-welsh.xml')]));
    await read({ item: 'https://www.legislation.gov.uk/anaw/2016/1/section/1/welsh' });
    expect(up.paths()).toEqual([WELSH]);
  });

  it('returns English with a notice when upstream holds no Welsh text (301 to English)', async () => {
    const up = createUpstream(
      routes(
        ['/ukpga/2018/12/section/45/welsh/data.xml', redirect(301, S45)],
        [S45, clml('ukpga-2018-12-section-45.xml')],
      ),
    );
    const { output, notice } = await read({
      item: 'ukpga/2018/12',
      provision: 'section/45',
      language: 'cy',
    });
    expect(up.paths()).toEqual(['/ukpga/2018/12/section/45/welsh/data.xml', S45]);
    expect(output.language).toBe('en');
    expect(output.links.web).toBe('https://www.legislation.gov.uk/ukpga/2018/12/section/45');
    expect(notice).toBe('Welsh text is not held for this document; the English text is returned.');
  });
});

describe('oversized fragments', () => {
  it('returns an outline of child provisions with measured sizes instead of the text', async () => {
    const big = inflate(
      fixture('clml/ukpga-2018-12-section-45.xml'),
      'http://www.legislation.gov.uk/id/ukpga/2018/12/section/45/2/g',
      41_000,
    );
    createUpstream([{ path: S45, respond: ok(big) }]);
    const { output } = await read({ item: 'ukpga/2018/12', provision: 'section/45' });
    expect(output.kind).toBe('outline');
    expect(output.text).toBeUndefined();
    expect(output.outline?.map((e) => e.provision)).toEqual([
      'section/45/1',
      'section/45/2',
      'section/45/2A',
      'section/45/3',
      'section/45/4',
      'section/45/5',
      'section/45/6',
      'section/45/7',
    ]);
    const two = output.outline?.find((e) => e.provision === 'section/45/2');
    expect(two?.chars).toBeGreaterThan(40_000);
    expect(output.outline_notice).toMatch(
      /Section 45 renders to \d+ characters, over the 40000-character budget/,
    );
    expect(output.outline_notice).toContain('for example section/45/1');
    expect(output.unapplied_effects).toHaveLength(3);
  });

  it('returns the full text with a notice when an oversized provision has no smaller children', async () => {
    const big = inflate(
      fixture('clml/ukpga-2018-12-section-45.xml'),
      'http://www.legislation.gov.uk/id/ukpga/2018/12/section/45/2/g',
      41_000,
    );
    createUpstream([{ path: '/ukpga/2018/12/section/45/2/g/data.xml', respond: ok(big) }]);
    const { output, notice } = await read({ item: 'ukpga/2018/12', provision: 's. 45(2)(g)' });
    expect(output.kind).toBe('full');
    expect(output.text?.length).toBeGreaterThan(40_000);
    expect(output.provision?.label).toBe('Section 45(2)(g)');
    expect(notice).toMatch(/has no smaller child provisions; the full text is returned/);
  });
});

describe('item-level reads', () => {
  const SI419 = '/uksi/2019/419/contents/data.xml';

  it('returns the outline of a large item from its table of contents in one request', async () => {
    const up = createUpstream(routes([SI419, clml('uksi-2019-419-contents.xml')]));
    const { output, notice } = await read({ item: 'uksi/2019/419' });
    expect(up.paths()).toEqual([SI419]);
    expect(notice).toBeUndefined();
    expect(output.kind).toBe('outline');
    expect(output.provision).toBeUndefined();
    expect(output.outline?.[0]).toEqual({
      provision: 'regulation/1',
      label: 'Regulation 1',
      level: 1,
      heading: 'Citation, commencement and extent',
    });
    expect(output.outline_notice).toContain(
      'provision set to a listed path — for example regulation/1 (Regulation 1)',
    );
    expect(output.editorial).toMatchObject({ document_status: 'revised' });
    expect(output.editorial.caveat).toContain('recorded against this item');
    expect(output.unapplied_effects).toHaveLength(3);
    expect(output.version.document_uri).toBe('https://www.legislation.gov.uk/uksi/2019/419');
    expect(output.links.web).toBe('https://www.legislation.gov.uk/uksi/2019/419');
  });

  it('lists the first 20 item-level effects and routes to uklaw_get_amendments for the rest', async () => {
    createUpstream(
      routes(['/ukpga/2018/12/contents/data.xml', clml('ukpga-2018-12-contents.xml')]),
    );
    const { output, notice } = await read({ item: 'ukpga/2018/12' });
    expect(output.unapplied_effects).toHaveLength(20);
    const outstanding = output.unapplied_effects.filter((e) => e.outstanding).length;
    expect(output.editorial.outstanding_effects).toBeGreaterThanOrEqual(outstanding);
    expect(notice).toContain(
      '22 unapplied effects are recorded against this item; the first 20 are listed',
    );
    expect(notice).toContain('status "unapplied"');
  });

  it('lists exactly 20 item-level effects without a truncation notice', async () => {
    const xml = keepEffects(fixture('clml/ukpga-2018-12-contents.xml'), 20);
    createUpstream([{ path: '/ukpga/2018/12/contents/data.xml', respond: ok(xml) }]);
    const { output, notice } = await read({ item: 'ukpga/2018/12' });
    expect(output.unapplied_effects).toHaveLength(20);
    expect(notice).toBeUndefined();
  });

  it('reads a dated table of contents with the version after contents', async () => {
    const path = '/uksi/2019/419/contents/2020-12-31/data.xml';
    createUpstream(routes([path, clml('uksi-2019-419-contents-2020-12-31.xml')]));
    const { output } = await read({ item: 'uksi/2019/419', version: '2020-12-31' });
    expect(output.version).toMatchObject({ requested: '2020-12-31', applied: '2020-12-31' });
    expect(output.version.document_uri).toBe(
      'https://www.legislation.gov.uk/uksi/2019/419/2020-12-31',
    );
  });

  it('fetches a small unrevised item whole: contents 307 → /made, then the made text directly', async () => {
    const up = createUpstream(
      routes(
        [SI_1984.contents, redirect(307, SI_1984.contentsMade)],
        [SI_1984.contentsMade, clml('uksi-1984-458-contents-made.xml')],
        [SI_1984.whole, clml('uksi-1984-458-made.xml')],
      ),
    );
    const { output, notice } = await read({ item: 'uksi/1984/458' });
    expect(up.paths()).toEqual([SI_1984.contents, SI_1984.contentsMade, SI_1984.whole]);
    expect(notice).toBeUndefined();
    expect(output).toMatchObject({
      kind: 'full',
      item: { path: 'uksi/1984/458', year: 1984, number: '458', category: 'secondary' },
      version: { requested: 'current', applied: 'made' },
      editorial: { document_status: 'final' },
      attribution: [ATTRIBUTION_LINES.ogl, ATTRIBUTION_LINES.westlaw],
    });
    expect(output.editorial.caveat).toContain('No revised version is held for this document');
    expect(output.text?.startsWith('**Citation and commencement**')).toBe(true);
    expect(output.text).not.toContain('1984 No. 458');
    expect(output.outline).toBeUndefined();
    expect(output.unapplied_effects.length).toBeGreaterThan(0);
  });

  it('fetches the whole item at exactly 25 leaf provisions and returns the outline at 26', async () => {
    const at25 = createUpstream([
      { path: SI_1984.contentsMade, respond: ok(contents1984(25)) },
      { path: SI_1984.whole, respond: clml('uksi-1984-458-made.xml') },
    ]);
    expect((await read({ item: 'uksi/1984/458', version: 'made' })).output.kind).toBe('full');
    expect(at25.paths()).toEqual([SI_1984.contentsMade, SI_1984.whole]);

    const at26 = createUpstream([{ path: SI_1984.contentsMade, respond: ok(contents1984(26)) }]);
    const { output } = await read({ item: 'uksi/1984/458', version: 'made' });
    expect(output.kind).toBe('outline');
    expect(output.outline).toHaveLength(26);
    expect(at26.paths()).toEqual([SI_1984.contentsMade]);
  });

  it('returns the outline with a notice when the whole small item renders over budget', async () => {
    const big = inflate(
      fixture('clml/uksi-1984-458-made.xml'),
      'http://www.legislation.gov.uk/id/uksi/1984/458/regulation/1',
      41_000,
    );
    createUpstream([
      { path: SI_1984.contentsMade, respond: clml('uksi-1984-458-contents-made.xml') },
      { path: SI_1984.whole, respond: ok(big) },
    ]);
    const { output, notice } = await read({ item: 'uksi/1984/458', version: 'enacted' });
    expect(output.kind).toBe('outline');
    expect(output.outline).toHaveLength(17);
    expect(notice).toMatch(
      /The whole item renders to \d+ characters, over the 40000-character budget/,
    );
  });

  it('returns the outline, not an error, when the whole-item request cannot start', async () => {
    const up = createUpstream(
      [
        { path: SI_1984.contentsMade, respond: clml('uksi-1984-458-contents-made.xml') },
        { path: SI_1984.whole, respond: clml('uksi-1984-458-made.xml') },
      ],
      { pacer: await gatedPacer(1) },
    );
    const { output, notice } = await read({ item: 'uksi/1984/458', version: 'made' });
    expect(up.paths()).toEqual([SI_1984.contentsMade]);
    expect(output.kind).toBe('outline');
    expect(notice).toContain("could not be fetched within this call's request budget");
  });

  it('fails pacer_shed when the redirect hop the first request needs cannot start', async () => {
    createUpstream(
      routes(
        [SI_1984.contents, redirect(307, SI_1984.contentsMade)],
        [SI_1984.contentsMade, clml('uksi-1984-458-contents-made.xml')],
      ),
      { pacer: await gatedPacer(1) },
    );
    await expect(failure({ item: 'uksi/1984/458' })).resolves.toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'pacer_shed' },
    });
  });

  it('returns a PDF-only item with its PDF link and the whole-instrument effect', async () => {
    const up = createUpstream(
      routes(
        [
          '/uksi/1985/2081/contents/data.xml',
          redirect(307, '/uksi/1985/2081/contents/made/data.xml'),
        ],
        ['/uksi/1985/2081/contents/made/data.xml', clml('uksi-1985-2081-contents-made.xml')],
      ),
    );
    const { output } = await read({ item: 'uksi/1985/2081' });
    expect(up.paths()).toHaveLength(2);
    expect(output).toMatchObject({
      kind: 'pdf_only',
      links: { pdf: 'https://www.legislation.gov.uk/uksi/1985/2081/pdfs/uksi_19852081_en.pdf' },
      editorial: { document_status: 'final' },
    });
    expect(output.text).toBeUndefined();
    expect(output.outline).toBeUndefined();
    expect(output.unapplied_effects).toMatchObject([
      { type: 'revoked', affected: { provisions: [] } },
    ]);
  });
});

describe('match_text', () => {
  const TEXT = '/ukpga/2018/12/contents/data.xml?text=processor';

  it('returns the matching provisions from the table of contents without fetching text', async () => {
    const up = createUpstream(routes([TEXT, clml('ukpga-2018-12-contents-text-processor.xml')]));
    const { output, notice } = await read({ item: 'ukpga/2018/12', match_text: 'processor' });
    expect(up.paths()).toEqual([TEXT]);
    expect(notice).toBeUndefined();
    expect(output.kind).toBe('outline');
    expect(output.outline?.map((e) => e.provision)).toEqual([
      'section/3',
      'section/24',
      'section/28',
    ]);
    expect(output.outline?.every((e) => e.matches_text)).toBe(true);
  });

  it('says so when nothing matches', async () => {
    const path = '/uksi/2019/419/contents/data.xml?text=zzqx';
    createUpstream(routes([path, clml('uksi-2019-419-contents.xml')]));
    const { output, notice } = await read({ item: 'uksi/2019/419', match_text: 'zzqx' });
    expect(output.outline).toEqual([]);
    expect(output.outline_notice).toBe('No provisions are listed for this item at this version.');
    expect(notice).toContain('No provision of uksi/2019/419 matches "zzqx"');
  });

  it('lists the first 300 of more matches with a notice', async () => {
    const xml = fixture('clml/ukpga-2018-12-contents-text-processor.xml');
    const hit = xml.match(
      /<ContentsItem [^>]*MatchText="true"[\s\S]*?<\/ContentsItem>/,
    )?.[0] as string;
    const many = Array.from({ length: 301 }, (_, i) =>
      hit.replaceAll(/section(\/|-)3\b/g, `section$1${1000 + i}`),
    ).join('');
    createUpstream([{ path: TEXT, respond: ok(xml.replace(hit, many)) }]);
    const { output, notice } = await read({ item: 'ukpga/2018/12', match_text: 'processor' });
    expect(output.outline).toHaveLength(300);
    expect(notice).toContain(
      'match_text matched 303 table-of-contents entries; the first 300 are listed',
    );
  });
});

describe('item extent and version window', () => {
  it('reports the extent and window of a dated item version, on both surfaces', async () => {
    const path = '/uksi/2019/419/contents/2020-12-31/data.xml';
    createUpstream(routes([path, clml('uksi-2019-419-contents-2020-12-31.xml')]));
    const result = await runToolContract(getDocumentTool, {
      item: 'uksi/2019/419',
      version: '2020-12-31',
    });
    expect(result.structuredContent).toMatchObject({
      item: { extent: 'E+W+S+N.I.' },
      version: { applied: '2020-12-31', valid_to: '2025-02-27' },
    });
    const text = contentText(result);
    expect(text).toContain(
      'number 419 · extent E+W+S+N.I. · https://www.legislation.gov.uk/id/uksi/2019/419',
    );
    expect(text).toContain('requested 2020-12-31, applied 2020-12-31, valid to 2025-02-27 ·');
  });

  it('reports the item extent on a provision read, and no end date for the latest version', async () => {
    createUpstream(routes([S45, clml('ukpga-2018-12-section-45.xml')]));
    const result = await runToolContract(getDocumentTool, {
      item: 'ukpga/2018/12',
      provision: 'section/45',
    });
    const structured = result.structuredContent as {
      item: Record<string, unknown>;
      version: Record<string, unknown>;
    };
    expect(structured.item.extent).toBe('E+W+S+N.I.');
    expect(structured.version).toMatchObject({ applied: '2026-06-19' });
    expect(structured.version).not.toHaveProperty('valid_to');
    const text = contentText(result);
    expect(text).toContain('number 12 · extent E+W+S+N.I. · https://');
    expect(text).toContain('requested current, applied 2026-06-19 · language en');
  });

  it('dates the item version apart from the provision’s own window on a dated provision read', async () => {
    const path = '/ukpga/2018/12/section/45/2019-01-01/data.xml';
    createUpstream(routes([path, clml('ukpga-2018-12-section-45-2019-01-01.xml')]));
    const result = await runToolContract(getDocumentTool, {
      item: 'ukpga/2018/12',
      provision: 'section/45',
      version: '2019-01-01',
    });
    expect(result.structuredContent).toMatchObject({
      item: { extent: 'E+W+S+N.I.' },
      version: { applied: '2018-07-23', valid_to: '2019-03-29' },
      provision: { valid_from: '2018-05-25', valid_to: '2020-12-31' },
    });
    const text = contentText(result);
    expect(text).toContain('applied 2018-07-23, valid to 2019-03-29 ·');
    expect(text).toContain('valid from 2018-05-25 to 2020-12-31');
  });

  it('reads an unrecorded provision window on enacted text as unrecorded, never as open to the present', async () => {
    const path = '/ukpga/2018/12/section/45/enacted/data.xml';
    createUpstream(routes([path, clml('ukpga-2018-12-section-45-enacted.xml')]));
    const result = await runToolContract(getDocumentTool, {
      item: 'ukpga/2018/12',
      provision: 'section/45',
      version: 'enacted',
    });
    const structured = result.structuredContent as { provision: Record<string, unknown> };
    expect(structured.provision).not.toHaveProperty('valid_from');
    expect(structured.provision).not.toHaveProperty('valid_to');
    const text = contentText(result);
    expect(text).toContain('valid from an unrecorded date to an unrecorded date');
    expect(text).not.toContain('to present');
  });

  it('reads an open provision window on current revised text as running to the present', async () => {
    createUpstream(routes([S45, clml('ukpga-2018-12-section-45.xml')]));
    const result = await runToolContract(getDocumentTool, {
      item: 'ukpga/2018/12',
      provision: 'section/45',
    });
    expect(result.structuredContent).toMatchObject({ provision: { valid_from: '2026-06-19' } });
    expect(contentText(result)).toContain('valid from 2026-06-19 to present');
  });

  it('omits both when the item records neither, and says so in the text', async () => {
    createUpstream(
      routes(
        [SI_1984.contents, redirect(307, SI_1984.contentsMade)],
        [SI_1984.contentsMade, clml('uksi-1984-458-contents-made.xml')],
        [SI_1984.whole, clml('uksi-1984-458-made.xml')],
      ),
    );
    const result = await runToolContract(getDocumentTool, { item: 'uksi/1984/458' });
    const structured = result.structuredContent as {
      item: Record<string, unknown>;
      version: Record<string, unknown>;
    };
    expect(structured.item).not.toHaveProperty('extent');
    expect(structured.version).not.toHaveProperty('valid_to');
    const text = contentText(result);
    expect(text).toContain('number 458 · extent not recorded · https://');
    expect(text).toContain('requested current, applied made · language en');
  });
});

describe('not found', () => {
  it.each([404, 400] as const)(
    'provision %i and the item resolves → provision_not_found',
    async (code) => {
      const up = createUpstream(
        routes(
          ['/ukpga/2018/12/section/999/data.xml', notFound(code)],
          [ID_DPA, redirect(303, '/ukpga/2018/12/contents')],
        ),
      );
      const error = await failure({ item: 'ukpga/2018/12', provision: 'section/999' });
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'provision_not_found' },
      });
      expect(up.paths()).toEqual(['/ukpga/2018/12/section/999/data.xml', ID_DPA]);
    },
  );

  it('provision 404 and the item does not resolve → document_not_found', async () => {
    createUpstream(
      routes(
        ['/ukpga/2018/99999/section/1/data.xml', notFound(400)],
        ['/id/ukpga/2018/99999', notFound()],
      ),
    );
    await expect(
      failure({ item: 'ukpga/2018/99999', provision: 'section/1' }),
    ).resolves.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'document_not_found' },
    });
  });

  it('when the item check cannot start, fails document_not_found with a recovery covering both outcomes', async () => {
    const up = createUpstream(
      routes(
        ['/ukpga/2018/12/section/999/data.xml', notFound()],
        [ID_DPA, redirect(303, '/ukpga/2018/12/contents')],
      ),
      { pacer: await gatedPacer(1) },
    );
    const error = await failure({ item: 'ukpga/2018/12', provision: 'section/999' });
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'document_not_found' },
    });
    expect(error).toMatchObject({
      data: { recovery: { hint: expect.stringContaining('if the item resolves') } },
    });
    expect(up.paths()).toEqual(['/ukpga/2018/12/section/999/data.xml']);
  });

  it('a dated item-level 404 on an item that exists → version_not_found', async () => {
    const up = createUpstream(
      routes(
        ['/ukpga/2018/12/contents/2010-01-01/data.xml', notFound()],
        [ID_DPA, redirect(303, '/ukpga/2018/12/contents')],
      ),
    );
    await expect(failure({ item: 'ukpga/2018/12', version: '2010-01-01' })).resolves.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'version_not_found' },
    });
    expect(up.paths()).toContain(ID_DPA);
  });

  it('a dated item-level 404 on a missing item → document_not_found', async () => {
    createUpstream(
      routes(
        ['/ukpga/2018/99999/contents/2010-01-01/data.xml', notFound()],
        ['/id/ukpga/2018/99999', notFound()],
      ),
    );
    await expect(
      failure({ item: 'ukpga/2018/99999', version: '2010-01-01' }),
    ).resolves.toMatchObject({
      data: { reason: 'document_not_found' },
    });
  });

  it('a current item-level 404 → document_not_found without an identifier check', async () => {
    const up = createUpstream(routes(['/ukpga/2018/99999/contents/data.xml', notFound()]));
    await expect(failure({ item: 'ukpga/2018/99999' })).resolves.toMatchObject({
      data: { reason: 'document_not_found' },
    });
    expect(up.paths()).toEqual(['/ukpga/2018/99999/contents/data.xml']);
  });
});

describe('input validation', () => {
  it.each([
    [{ item: 'xyz/2018/12' }, 'invalid_item'],
    [{ item: 'https://example.org/ukpga/2018/12' }, 'invalid_item'],
    [{ item: 'ukpga/2018/12/foo/1' }, 'invalid_item'],
    [{ item: 'ukpga/2018/12', provision: 'foo 3' }, 'invalid_provision'],
    [{ item: 'ukpga/2018/12/section/45', provision: 'section/46' }, 'invalid_provision'],
    [{ item: 'ukpga/2018/12', version: '2019-02-30' }, 'invalid_version'],
    [{ item: 'ukpga/2018/12/section/45/prospective' }, 'invalid_version'],
    [
      { item: 'ukpga/2018/12', provision: 'section/45', match_text: 'processor' },
      'match_text_needs_item_level',
    ],
    [{ item: 'ukpga/2018/12/section/45', match_text: 'processor' }, 'match_text_needs_item_level'],
  ] as [DocumentInput, string][])('%j fails %s before any request', async (input, reason) => {
    const up = createUpstream([]);
    await expect(failure(input)).resolves.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason },
    });
    expect(up.paths()).toEqual([]);
  });

  it.each([
    { item: 'Data Protection Act 2018' },
    { item: 'ukpga/2018' },
    { item: '' },
    { item: 'ukpga/2018/12', version: 'yesterday' },
    { item: 'ukpga/2018/12', version: '2019-1-1' },
    { item: 'ukpga/2018/12', provision: 's. 45, 46' },
    { item: 'ukpga/2018/12', provision: '§ 45' },
    { item: 'ukpga/2018/12', language: 'fr' },
    { item: 'ukpga/2018/12', match_text: 'x'.repeat(201) },
  ])('rejects %j at the schema', async (input) => {
    createUpstream([]);
    const error = errorOf(await runToolContract(getDocumentTool, input as DocumentInput));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.reason).toBe('invalid_arguments');
  });

  it('treats blank optional strings as unset', async () => {
    const up = createUpstream(
      routes(['/uksi/2019/419/contents/data.xml', clml('uksi-2019-419-contents.xml')]),
    );
    const { output } = await read({
      item: ' uksi/2019/419 ',
      provision: '',
      version: '',
      language: ' ',
      match_text: '',
    });
    expect(up.paths()).toEqual(['/uksi/2019/419/contents/data.xml']);
    expect(output.version.requested).toBe('current');
    expect(output.language).toBe('en');
  });
});

describe('refusals', () => {
  it('maps a 403 to upstream_refused', async () => {
    createUpstream(routes([S45, status(403)]));
    await expect(
      failure({ item: 'ukpga/2018/12', provision: 'section/45' }),
    ).resolves.toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'upstream_refused', retryAfter: 300 },
    });
  });

  it('fails pacer_shed when the first request cannot start', async () => {
    createUpstream(routes([S45, clml('ukpga-2018-12-section-45.xml')]), {
      pacer: await gatedPacer(0),
    });
    await expect(
      failure({ item: 'ukpga/2018/12', provision: 'section/45' }),
    ).resolves.toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'pacer_shed' },
    });
  });
});

describe('both surfaces', () => {
  const routesFor = (): Route[] => routes([S45, clml('ukpga-2018-12-section-45.xml')]);

  it('renders a provision read on the text surface with every field the model needs', async () => {
    createUpstream(routesFor());
    const result = await runToolContract(getDocumentTool, {
      item: 'ukpga/2018/12',
      provision: 'section/45',
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      kind: 'full',
      provision: { path: 'section/45' },
    });
    expect(result.structuredContent).not.toHaveProperty('notice');
    const text = contentText(result);
    expect(text).toContain('## Data Protection Act 2018');
    expect(text).toContain(
      '**Item:** `ukpga/2018/12` · ukpga (UK Public General Acts) · category primary · year 2018 · number 12',
    );
    expect(text).toContain(
      '**Provision:** Section 45 (`section/45`) — Right of access by the data subject',
    );
    expect(text).toContain(
      '**Kind:** full · **Version:** requested current, applied 2026-06-19 · language en',
    );
    expect(text).toContain('**Editorial:** status revised · publisher Statute Law Database');
    expect(text).toContain('outstanding effects 3');
    expect(text).toContain('> **Right of access by the data subject**');
    expect(text).toContain('### Annotations');
    expect(text).toContain('- **F1** (F: Textual amendment)');
    expect(text).toContain('### Unapplied effects (3 listed)');
    expect(text).toContain('- **word substituted** — **outstanding**');
    expect(text).toContain(
      '**Links:** web https://www.legislation.gov.uk/ukpga/2018/12/section/45',
    );
    expect(text).toContain(ATTRIBUTION_LINES.ogl);
  });

  it('renders the outline arm and the notice trailer', async () => {
    createUpstream(
      routes(['/ukpga/2018/12/contents/data.xml', clml('ukpga-2018-12-contents.xml')]),
    );
    const result = await runToolContract(getDocumentTool, { item: 'ukpga/2018/12' });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.kind).toBe('outline');
    expect(structured.notice).toContain('first 20 are listed');
    const text = contentText(result);
    expect(text).toContain('### Outline');
    expect(text).toContain('- `part/1` Part 1 — Preliminary [level 1]');
    expect(text).toContain('  - `part/2/chapter/1` Part 2 Chapter 1');
    expect(text).toContain('**Next:**');
    expect(text).toContain('first 20 are listed');
  });

  it('renders the Welsh-fallback notice through the production enrichment parse', async () => {
    createUpstream(
      routes(
        ['/ukpga/2018/12/section/45/welsh/data.xml', redirect(301, S45)],
        [S45, clml('ukpga-2018-12-section-45.xml')],
      ),
    );
    const result = await runToolContract(getDocumentTool, {
      item: 'ukpga/2018/12',
      provision: 'section/45',
      language: 'cy',
    });
    expect(result.structuredContent).toMatchObject({
      language: 'en',
      notice: 'Welsh text is not held for this document; the English text is returned.',
    });
    expect(contentText(result)).toContain('Welsh text is not held for this document');
  });

  it('renders a PDF-only item and an empty effects list', async () => {
    createUpstream(
      routes(
        [
          '/uksi/1985/2081/contents/data.xml',
          redirect(307, '/uksi/1985/2081/contents/made/data.xml'),
        ],
        ['/uksi/1985/2081/contents/made/data.xml', clml('uksi-1985-2081-contents-made.xml')],
      ),
    );
    const text = contentText(await runToolContract(getDocumentTool, { item: 'uksi/1985/2081' }));
    expect(text).toContain('**Kind:** pdf_only');
    expect(text).toContain(
      'pdf https://www.legislation.gov.uk/uksi/1985/2081/pdfs/uksi_19852081_en.pdf',
    );
    expect(text).toContain('- **revoked** — **outstanding**');
    expect(text).not.toContain('### Text');
  });

  it('keeps injected line breaks and HTML in upstream URIs and labels inside their slot', async () => {
    const injected = fixture('clml/ukpga-2018-12-section-45.xml')
      .replace(
        'IdURI="http://www.legislation.gov.uk/id/ukpga/2018/12" ',
        'IdURI="http://www.legislation.gov.uk/id/ukpga/2018/12&#13;&#10;## Id &lt;b&gt;x&lt;/b&gt;" ',
      )
      .replace(
        '<dc:identifier>http://www.legislation.gov.uk/ukpga/2018/12/section/45</dc:identifier>',
        '<dc:identifier>http://www.legislation.gov.uk/ukpga/2018/12/section/45&lt;img src=x&gt;</dc:identifier>',
      )
      .replace('/section/45/data.akn"', '/section/45/data.akn&#10;## Akn"')
      .replaceAll('Type="F"', 'Type="F&#10;## Type"')
      .replaceAll(
        'Citation URI="http://www.legislation.gov.uk/id/ukpga/2025/18"',
        'Citation URI="http://www.legislation.gov.uk/id/ukpga/2025/18&#10;## Cite"',
      );
    createUpstream([{ path: S45, respond: ok(injected) }]);
    const result = await runToolContract(getDocumentTool, {
      item: 'ukpga/2018/12',
      provision: 'section/45',
    });
    const structured = result.structuredContent as {
      annotations: { citations: { uri: string }[]; type: string }[];
      item: { id_uri: string };
      links: { akn: string };
      version: { document_uri: string };
    };
    // structuredContent keeps every value verbatim.
    expect(structured.item.id_uri).toBe(
      'https://www.legislation.gov.uk/id/ukpga/2018/12\r\n## Id <b>x</b>',
    );
    expect(structured.links.akn).toContain('data.akn\n## Akn');
    expect(structured.version.document_uri).toContain('/section/45<img src=x>');
    expect(structured.annotations.some((a) => a.type === 'F\n## Type')).toBe(true);
    expect(
      structured.annotations.some((a) => a.citations.some((c) => c.uri.endsWith('\n## Cite'))),
    ).toBe(true);

    const text = contentText(result);
    expect(text).not.toMatch(/[\r\u2028\u2029]/);
    expect(text.split('\n').filter((line) => /^#+ (Id|Akn|Type|Cite)\b/.test(line))).toEqual([]);
    expect(text).not.toMatch(/<(b|img)\b/);
    expect(text).toContain(
      '· https://www.legislation.gov.uk/id/ukpga/2018/12%0D%0A##%20Id%20%3Cb%3Ex%3C/b%3E',
    );
    expect(text).toContain(
      '· https://www.legislation.gov.uk/ukpga/2018/12/section/45%3Cimg%20src=x%3E',
    );
    expect(text).toContain(
      'akn https://www.legislation.gov.uk/ukpga/2018/12/section/45/data.akn%0A##%20Akn',
    );
    expect(text).toMatch(/- \*\*F ## Type\d+\*\* \(F ## Type: Annotation\)/);
    expect(text).toContain('<https://www.legislation.gov.uk/id/ukpga/2025/18%0A##%20Cite>');
  });

  it('returns a declared not-found reason in the error envelope', async () => {
    createUpstream(
      routes(
        ['/ukpga/2018/12/section/999/data.xml', notFound()],
        [ID_DPA, redirect(303, '/ukpga/2018/12/contents')],
      ),
    );
    const result = await runToolContract(getDocumentTool, {
      item: 'ukpga/2018/12',
      provision: 'section/999',
    });
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data?.reason).toBe('provision_not_found');
    expect(contentText(result)).toContain('reason provision_not_found');
  });
});
