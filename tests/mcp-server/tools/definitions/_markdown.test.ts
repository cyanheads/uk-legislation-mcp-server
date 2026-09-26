/**
 * @fileoverview Tests for the `format()` Markdown helpers: inline slots flatten
 * line breaks (CR, LF, U+2028, U+2029) and escape Markdown/HTML openers, URI
 * and path slots percent-encode what a URI may not carry, multi-line upstream
 * text is blockquoted line by line, and an effect record renders every field.
 * @module tests/mcp-server/tools/definitions/_markdown.test
 */

import { describe, expect, it } from 'vitest';
import {
  attributionLines,
  blockquote,
  cell,
  inline,
  renderEffect,
  uri,
} from '@/mcp-server/tools/definitions/_markdown.js';
import { parseChangesFeed } from '@/services/legislation/atom/changes-feed.js';
import { ATTRIBUTION_LINES } from '@/services/legislation/reference-data.js';
import type { EffectRecord } from '@/services/legislation/types.js';
import { fixture } from '../../../helpers/upstream.js';

describe('inline', () => {
  it('flattens every line break to a space', () => {
    expect(inline('a\r\nb\nc\rd\u2028e\u2029f')).toBe('a b c d e f');
  });

  it('escapes Markdown openers and HTML tags', () => {
    expect(inline('**bold** `code` [link](x) <img src=x> a < b')).toBe(
      '\\*\\*bold\\*\\* \\`code\\` \\[link\\](x) &lt;img src=x> a < b',
    );
  });

  it('escapes underscores only at word boundaries', () => {
    expect(inline('_emph_ snake_case')).toBe('\\_emph\\_ snake_case');
  });

  it('renders numbers, booleans, and undefined', () => {
    expect(inline(42)).toBe('42');
    expect(inline(false)).toBe('false');
    expect(inline(undefined)).toBe('');
  });

  it('cell also escapes table pipes', () => {
    expect(cell('a | b\nc')).toBe('a \\| b c');
  });
});

describe('uri', () => {
  it('percent-encodes line breaks, whitespace, and every character a URI may not carry', () => {
    expect(uri('https://x/a\r\nb c\u2028d<e>`f`[g]|h"{i}^\\')).toBe(
      'https://x/a%0D%0Ab%20c%E2%80%A8d%3Ce%3E%60f%60%5Bg%5D%7Ch%22%7Bi%7D%5E%5C',
    );
  });

  it('leaves a well-formed URI or path unchanged, underscores and asterisks included', () => {
    for (const value of [
      'https://www.legislation.gov.uk/ukpga/2018/12/pdfs/ukpga_20180012_en.pdf',
      'https://www.legislation.gov.uk/all/2020-*/data.feed?title=a&page=2#x',
      'ukpga/Eliz2/3-4/19',
    ]) {
      expect(uri(value)).toBe(value);
    }
  });
});

describe('blockquote', () => {
  it('prefixes every line, keeps empty lines quoted, and escapes HTML openers', () => {
    expect(blockquote('first\n\n<script>x</script>\r\nlast\u2028sep')).toBe(
      '> first\n>\n> &lt;script>x&lt;/script>\n> last\n> sep',
    );
  });
});

describe('attributionLines', () => {
  it('lists every line under a heading', () => {
    expect(attributionLines([ATTRIBUTION_LINES.ogl, ATTRIBUTION_LINES.eu])).toBe(
      `**Attribution:**\n- ${ATTRIBUTION_LINES.ogl}\n- ${ATTRIBUTION_LINES.eu}`,
    );
  });
});

describe('renderEffect', () => {
  it('renders a recorded feed effect with both sides, dates and authority', () => {
    const [effect] = parseChangesFeed(fixture('feeds/changes-affected-ukpga-2018-12.feed')).effects;
    expect(renderEffect(effect as EffectRecord)).toBe(
      [
        '- **word substituted** — **outstanding** · applied: false · requires_applied: true (effect key-afc4da5af850ada1378557cf240207e0)',
        '  - Affected: Data Protection Act 2018 `ukpga/2018/12` <https://www.legislation.gov.uk/id/ukpga/2018/12> — s. 65 heading; provisions: s. 65 heading (https://www.legislation.gov.uk/id/ukpga/2018/12/part/3/chapter/4/crossheading/general-obligations)',
        '  - Affecting: The Data (Use and Access) Act 2025 (Consequential Amendments and Transitional Provision) Regulations 2026 `uksi/2026/386` <https://www.legislation.gov.uk/id/uksi/2026/386> — Sch. 2 para. 23(2)(3); provisions: Sch. 2 (https://www.legislation.gov.uk/id/uksi/2026/386/schedule/2); para. 23(2) (https://www.legislation.gov.uk/id/uksi/2026/386/schedule/2/paragraph/23/2); (3) (https://www.legislation.gov.uk/id/uksi/2026/386/schedule/2/paragraph/23/3)',
        '  - In force: 2026-09-30, wholly in force, applied: false',
        '  - Commencement authority: reg. 1(2) (https://www.legislation.gov.uk/id/uksi/2026/386/regulation/1/2); savings: none',
        '  - Extent: same as affected',
        '  - Modified: 2026-09-25T14:19:14Z',
      ].join('\n'),
    );
  });

  it('marks unknowns honestly and blockquotes notes', () => {
    const sparse: EffectRecord = {
      effect_id: 'key-1',
      type: 'savings',
      outstanding: false,
      requires_applied: false,
      welsh_requires_applied: true,
      welsh_applied: false,
      affected: { provisions: [{ label: 's. 198A', uri: 'https://x/198A', missing: true }] },
      affecting: { provisions: [] },
      commencement_authority: [],
      savings: [],
      in_force: [{ prospective: true, commencing_uri: 'https://x/c' }],
      notes: 'Not yet in force.\nSee <b>s. 2</b>.',
    };
    expect(renderEffect(sparse)).toBe(
      [
        '- **savings** — not outstanding · applied: not reported · requires_applied: false · welsh_requires_applied: true · welsh_applied: false (effect key-1)',
        '  - Affected: unknown — no provisions label; provisions: s. 198A (https://x/198A) [missing]',
        '  - Affecting: unknown — no provisions label; provisions: none',
        '  - In force: no date, prospective, commencing https://x/c',
        '  - Commencement authority: none; savings: none',
        '  - Notes:',
        '    > Not yet in force.',
        '    > See &lt;b>s. 2&lt;/b>.',
      ].join('\n'),
    );
  });

  it('renders a range reference with both endpoint URIs', () => {
    const ranged: EffectRecord = {
      effect_id: 'k',
      type: 'inserted',
      outstanding: true,
      affected: {
        provisions: [
          { label: 's. 186A-186C', uri: 'https://x/186A', up_to: 'https://x/186C', missing: true },
        ],
      },
      affecting: { provisions: [] },
      commencement_authority: [],
      savings: [{ label: 'regs. 3-5', uri: 'https://x/3', up_to: 'https://x/5' }],
      in_force: [],
    };
    const text = renderEffect(ranged);
    expect(text).toContain('provisions: s. 186A-186C (https://x/186A to https://x/186C) [missing]');
    expect(text).toContain('savings: regs. 3-5 (https://x/3 to https://x/5)');
  });

  it('keeps injected line breaks and HTML in upstream URIs and paths inside their slot', () => {
    const injected: EffectRecord = {
      effect_id: 'k',
      type: 'inserted',
      outstanding: true,
      affected: {
        item: 'ukpga/2018/12\n## Item`',
        id_uri: 'https://x/id\r\n## Id <b>',
        provisions: [{ label: 's. 1', uri: 'https://x/1\n## Uri', up_to: 'https://x/2\u2028> Up' }],
      },
      affecting: { provisions: [] },
      commencement_authority: [{ label: 'reg. 1', uri: 'https://x/r\n<img src=x>' }],
      savings: [],
      in_force: [{ date: '2026-01-01', commencing_uri: 'https://x/c\n## Commencing' }],
    };
    const text = renderEffect(injected);
    expect(text).not.toMatch(/[\r\u2028\u2029]/);
    for (const line of text.split('\n')) expect(line).toMatch(/^( {2})?- /);
    expect(text).not.toMatch(/<(b|img)\b/);
    expect(text).toContain('`ukpga/2018/12%0A##%20Item%60` <https://x/id%0D%0A##%20Id%20%3Cb%3E>');
    expect(text).toContain('s. 1 (https://x/1%0A##%20Uri to https://x/2%E2%80%A8%3E%20Up)');
    expect(text).toContain('reg. 1 (https://x/r%0A%3Cimg%20src=x%3E)');
    expect(text).toContain('commencing https://x/c%0A##%20Commencing');
  });

  it('says so when no commencement is recorded', () => {
    const bare: EffectRecord = {
      effect_id: 'k',
      type: 'repealed',
      outstanding: true,
      affected: { provisions: [] },
      affecting: { provisions: [] },
      commencement_authority: [],
      savings: [],
      in_force: [],
    };
    expect(renderEffect(bare)).toContain('  - In force: none recorded');
  });
});
