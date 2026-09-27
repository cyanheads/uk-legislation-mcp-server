/**
 * @fileoverview Tests for the CLML → Markdown renderer over recorded
 * documents (section 45 of the Data Protection Act 2018, a repealed section, a
 * whole Westlaw-contributed instrument) and CLML-schema snippets for the rarer
 * constructs: tables, formulae, figures, characters, status prefixes.
 * @module tests/services/legislation/clml/render.test
 */

import { describe, expect, it } from 'vitest';
import { renderNodes } from '@/services/legislation/clml/render.js';
import {
  attr,
  elements,
  findDescendant,
  parseXml,
  type XmlElement,
} from '@/services/legislation/xml.js';
import { fixture } from '../../../helpers/upstream.js';

function load(name: string): XmlElement {
  return parseXml(fixture(`clml/${name}`), 'a document');
}

function byId(root: XmlElement, idUri: string): XmlElement {
  const el = findDescendant(root, (e) => attr(e, 'IdURI') === idUri);
  if (!el) throw new Error(`no element ${idUri}`);
  return el;
}

/** Renders a CLML snippet wrapped in a Legislation root, with optional commentaries. */
function render(body: string, extras = '') {
  const root = parseXml(`<Legislation>${body}${extras}</Legislation>`, 'x');
  const first = elements(root)[0] as XmlElement;
  return renderNodes(root, [first]);
}

describe('renderNodes — recorded section 45', () => {
  const root = load('ukpga-2018-12-section-45.xml');
  const p1 = byId(root, 'http://www.legislation.gov.uk/id/ukpga/2018/12/section/45');
  const group = findDescendant(root, (e) => e.name === 'P1group' && e.children.includes(p1));
  const result = renderNodes(root, [group as XmlElement]);
  const lines = result.text.split('\n');

  it('renders the group heading bold and the section number with its commencement label', () => {
    expect(lines[0]).toBe('**Right of access by the data subject**');
    expect(lines[1]).toBe(
      '**[I1]45** (1) A data subject is entitled to obtain from the controller—',
    );
  });

  it('indents each paragraph level', () => {
    expect(lines).toContain(
      '  (a) confirmation as to whether or not personal data concerning him or her is being processed, and',
    );
    expect(lines).toContain('    (i) rectification of personal data (see section 46), and');
    expect(lines).toContain('(2) That information is—');
  });

  it('wraps inserted text with the label of its commentary', () => {
    expect(result.text).toContain(
      "(f) the existence of the data subject's right to lodge a complaint with the Commissioner [F2 (see section 165)] and the contact details of the Commissioner;",
    );
    expect(result.text).toContain('([F3 2A]) [F3 Under subsection (1),');
  });

  it('numbers labels per annotation type in order of first reference and sorts annotations by type', () => {
    const labels = result.annotations.map((a) => a.label);
    expect(labels.slice(0, 9)).toEqual(['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9']);
    expect(labels).toContain('I1');
    expect(labels.indexOf('I1')).toBeGreaterThan(labels.indexOf('F9'));
    expect(result.annotations[0]).toMatchObject({
      type: 'F',
      type_label: 'Textual amendment',
      text: expect.stringContaining('S. 45(2)(ea) inserted (19.6.2026)'),
    });
    expect(result.annotations[0]?.citations[0]).toEqual({
      uri: 'https://www.legislation.gov.uk/id/ukpga/2025/18',
      title: 'Data (Use and Access) Act 2025',
    });
  });

  it('measures size as the text plus every annotation field both surfaces carry, citations included', () => {
    const annotationChars = result.annotations.reduce(
      (n, a) =>
        n +
        a.label.length +
        a.type.length +
        a.type_label.length +
        a.text.length +
        a.citations.reduce((c, cite) => c + (cite.title?.length ?? 0) + cite.uri.length, 0),
      0,
    );
    expect(result.annotations.some((a) => a.citations.length > 0)).toBe(true);
    expect(result.chars).toBe(result.text.length + annotationChars);
    expect(result.simplifiedTable).toBe(false);
  });
});

describe('renderNodes — recorded documents', () => {
  it('prefixes a repealed provision', () => {
    const root = load('ukpga-1998-29-section-1.xml');
    const p1 = byId(root, 'http://www.legislation.gov.uk/id/ukpga/1998/29/section/1');
    const group = findDescendant(root, (e) => e.name === 'P1group' && e.children.includes(p1));
    const { text, annotations } = renderNodes(root, [group as XmlElement]);
    expect(text.split('\n')[0]).toBe('*(repealed)* **Basic interpretative provisions.**');
    expect(annotations[0]?.text).toMatch(/^Act repealed/);
  });

  it('renders a whole instrument without its prelims, with footnotes and quoted amendments', () => {
    const root = load('uksi-1984-458-made.xml');
    const secondary = elements(root).find((e) => e.name === 'Secondary') as XmlElement;
    const { text } = renderNodes(root, [secondary]);
    expect(text).not.toContain('1984 No. 458');
    expect(text).not.toContain('hereby makes the following regulations');
    expect(text.startsWith('**Citation and commencement**')).toBe(true);
    expect(text).toContain('Regulations 1974[^1]');
    expect(text).toMatch(
      /^\[\^1\]: to which there are amendments not relevant to these regulations\.$/m,
    );
    expect(text).toMatch(/^> - \\`“the determining authority” means/m);
    expect(text).toContain('Tony Newton');
  });

  it('renders the prelims when the introduction itself is requested', () => {
    const root = load('uksi-1984-458-made.xml');
    const prelims = findDescendant(root, (e) => e.name === 'SecondaryPrelims') as XmlElement;
    const { text } = renderNodes(root, [prelims]);
    expect(text).toContain('**1984 No. 458**');
    expect(text).toContain('hereby makes the following regulations.');
  });
});

describe('renderNodes — CLML constructs', () => {
  it('turns divisions into headings nested by depth', () => {
    const { text } = render(
      '<Part><Number>PART 3</Number><Title>Law enforcement processing</Title>' +
        '<Chapter><Number>CHAPTER 1</Number><Title>Scope</Title>' +
        '<Pblock><Title>Scope</Title><P1group><Title>Processing</Title><P1><Pnumber>29</Pnumber><P1para><Text>This Part applies.</Text></P1para></P1></P1group></Pblock>' +
        '</Chapter></Part>',
    );
    expect(text).toBe(
      [
        '## PART 3 — Law enforcement processing',
        '',
        '### CHAPTER 1 — Scope',
        '',
        '#### Scope',
        '',
        '**Processing**',
        '**29** This Part applies.',
      ].join('\n'),
    );
  });

  it('marks prospective and not-matching provisions', () => {
    expect(
      render(
        '<P1 Status="Prospective"><Pnumber>9</Pnumber><P1para><Text>Later.</Text></P1para></P1>',
      ).text,
    ).toBe('*(prospective — not in force at this version)* **9** Later.');
    expect(
      render('<P1 Match="false"><Pnumber>9</Pnumber><P1para><Text>X.</Text></P1para></P1>').text,
    ).toMatch(/^\*\(prospective — not in force at this version\)\*/);
  });

  it('honours number punctuation and indents sub-paragraphs', () => {
    const { text } = render(
      '<P1><Pnumber PuncBefore="" PuncAfter=".">4</Pnumber><P1para><Text>Lead—</Text>' +
        '<P2><Pnumber PuncBefore="[" PuncAfter="]">1</Pnumber><P2para><Text>one</Text></P2para></P2></P1para></P1>',
    );
    expect(text).toBe('**4.** Lead—\n[1] one');
  });

  it('renders ordered and unordered lists', () => {
    const { text } = render(
      '<P><OrderedList><ListItem><Para><Text>first</Text></Para></ListItem><ListItem><Para><Text>second</Text></Para></ListItem></OrderedList>' +
        '<UnorderedList><ListItem><Para><Text>dot</Text></Para></ListItem></UnorderedList></P>',
    );
    expect(text).toBe('1. first\n2. second\n- dot');
  });

  it('quotes block and inline amendments', () => {
    const { text } = render(
      '<P><Text>substitute—</Text><BlockAmendment><P1group><Title>New</Title><P1><Pnumber>5</Pnumber><P1para><Text>Text.</Text></P1para></P1></P1group></BlockAmendment>' +
        '<Text>for <InlineAmendment>old words</InlineAmendment> substitute</Text></P>',
    );
    expect(text).toBe('substitute—\n> **New**\n> **5** Text.\nfor “old words” substitute');
  });

  it('labels amendments and bare references by commentary type', () => {
    const commentaries =
      '<Commentaries><Commentary id="c1" Type="F"><Para><Text>Words substituted by <Citation URI="http://www.legislation.gov.uk/id/ukpga/2025/18">2025 c. 18</Citation></Text></Para></Commentary>' +
      '<Commentary id="c2" Type="C"><Para><Text>Modified.</Text></Para><Para><Text>Second para.</Text></Para></Commentary></Commentaries>';
    const result = render(
      '<P><Text><Substitution CommentaryRef="c1">new</Substitution> and <Repeal CommentaryRef="c1">gone</Repeal><CommentaryRef Ref="c2"/> <Addition>unlabelled</Addition> <CommentaryRef Ref="missing"/></Text></P>',
      commentaries,
    );
    expect(result.text).toBe('[F1 new] and [F1 gone][C1] [unlabelled] [X1]');
    expect(result.annotations).toEqual([
      {
        label: 'F1',
        type: 'F',
        type_label: 'Textual amendment',
        text: 'Words substituted by 2025 c. 18',
        citations: [
          { uri: 'https://www.legislation.gov.uk/id/ukpga/2025/18', title: '2025 c. 18' },
        ],
      },
      {
        label: 'C1',
        type: 'C',
        type_label: 'Modification without textual change',
        text: 'Modified.\nSecond para.',
        citations: [],
      },
    ]);
  });

  it('renders a table as Markdown with pipes escaped', () => {
    const result = render(
      '<Tabular><table><thead><tr><th>Column (1)</th><th>Column (2)</th></tr></thead><tbody>' +
        '<tr><td>a|b</td><td>£64.99</td></tr><tr><td>only one</td></tr></tbody></table></Tabular>',
    );
    expect(result.text).toBe(
      '| Column (1) | Column (2) |\n| --- | --- |\n| a\\|b | £64.99 |\n| only one | |',
    );
    expect(result.simplifiedTable).toBe(false);
  });

  it('flags a table with a merged cell as simplified', () => {
    const result = render(
      '<Tabular><table><tr><th colspan="2">Head</th></tr><tr><td>a</td><td>b</td></tr></table></Tabular>',
    );
    expect(result.simplifiedTable).toBe(true);
    const rowMerge = render(
      '<Tabular><table><tr><td rowspan="2" colspan="1">a</td><td colspan="1">b</td></tr><tr><td>c</td></tr></table></Tabular>',
    );
    expect(rowMerge.simplifiedTable).toBe(true);
  });

  it('does not flag a table whose cells carry rowspan="1" colspan="1" as upstream writes them', () => {
    // Cell shape from the CLML guide example ssi/2012/303/schedule/1/paragraph/3/made.
    const result = render(
      '<Tabular Orientation="portrait"><table cols="2"><thead><tr>' +
        '<th rowspan="1" colspan="1">Child or Young Person</th><th rowspan="1" colspan="1">Amount</th>' +
        '</tr></thead><tbody><tr><td rowspan="1" colspan="1">A person</td><td rowspan="1" colspan="1">£64.99</td></tr></tbody></table></Tabular>',
    );
    expect(result.text).toContain('| Child or Young Person | Amount |');
    expect(result.simplifiedTable).toBe(false);
  });

  it('renders formulae by alt text, figures by image link, and characters by name', () => {
    const resources =
      '<Resources><Resource id="r1"><ExternalVersion URI="http://www.legislation.gov.uk/uksi/2014/333/images/uksi_20140333_en_009"/></Resource></Resources>';
    const { text } = render(
      '<P><Formula><math xmlns="http://www.w3.org/1998/Math/MathML" alttext="A × B / 12"><mi>A</mi></math></Formula>' +
        '<Formula AltText="x &lt; y"/><Formula/>' +
        '<Figure><Image ResourceRef="r1"/><Image ResourceRef="missing"/></Figure>' +
        '<Text>a<Character Name="EmDash"/>b<Character Name="Unknown"/>c</Text></P>',
      resources,
    );
    expect(text).toBe(
      [
        '[formula: A × B / 12]',
        '[formula: x < y]',
        '[formula]',
        '[image](https://www.legislation.gov.uk/uksi/2014/333/images/uksi_20140333_en_009) [image]',
        'a—bc',
      ].join('\n'),
    );
  });

  it('renders a character or annotation type named after an Object.prototype member as unknown', () => {
    const result = render(
      '<P><Text>a<Character Name="constructor"/>b<Character Name="__proto__"/>c<CommentaryRef Ref="c1"/></Text></P>',
      '<Commentaries><Commentary id="c1" Type="constructor"><Para><Text>Note.</Text></Para></Commentary></Commentaries>',
    );
    expect(result.text).toBe('abc[constructor1]');
    expect(result.annotations).toEqual([
      {
        label: 'constructor1',
        type: 'constructor',
        type_label: 'Annotation',
        text: 'Note.',
        citations: [],
      },
    ]);
  });

  it('numbers footnotes once per reference target', () => {
    const { text } = render(
      '<P><Text>one<FootnoteRef Ref="f1"/> two<FootnoteRef Ref="f2"/> again<FootnoteRef Ref="f1"/></Text></P>',
      '<Footnotes><Footnote id="f1"><FootnoteText><Para><Text>First note.</Text></Para></FootnoteText></Footnote><Footnote id="f2"><FootnoteText><Para><Text>Second.</Text></Para></FootnoteText></Footnote></Footnotes>',
    );
    expect(text).toBe('one[^1] two[^2] again[^1]\n\n[^1]: First note.\n[^2]: Second.');
  });

  it('escapes Markdown and HTML openers in upstream text', () => {
    const { text } = render(
      '<P><Text>a *b* `c` &lt;script&gt;x&lt;/script&gt; 2 &lt; 3</Text></P>',
    );
    expect(text).toBe('a \\*b\\* \\`c\\` &lt;script>x&lt;/script> 2 < 3');
  });

  it('collapses U+0085 (NEL) like other whitespace in headings, numbers, text, table cells and footnotes', () => {
    const { text } = render(
      '<Part><Number>Part&#133;1</Number><Title>One&#133;two</Title><P1><Pnumber>1&#133;A</Pnumber><P1para><Text>a&#133;## b<FootnoteRef Ref="f1"/></Text></P1para></P1><Tabular><table><tr><td>c&#133;d</td></tr></table></Tabular></Part>',
      '<Footnotes><Footnote id="f1"><FootnoteText><Para><Text>note&#133;here</Text></Para></FootnoteText></Footnote></Footnotes>',
    );
    expect(text).not.toContain('\u0085');
    for (const piece of ['Part 1 — One two', '**1 A** a ## b[^1]', '| c d |', '[^1]: note here']) {
      expect(text).toContain(piece);
    }
  });

  it('renders an unknown element by its text content', () => {
    expect(render('<P><Mystery><Text>kept</Text> text</Mystery></P>').text).toBe('kept\ntext');
  });

  it('renders inline images and formulae inside running text', () => {
    const resources =
      '<Resources><Resource id="r2"><ExternalVersion URI="http://www.legislation.gov.uk/uksi/2014/2848/images/uksi_20142848_en_002"/></Resource></Resources>';
    const { text } = render(
      '<P><Text>see <Image ResourceRef="r2"/> where <Formula AltText="A × B"/> applies<FootnoteRef/></Text></P>',
      resources,
    );
    expect(text).toBe(
      'see [image](https://www.legislation.gov.uk/uksi/2014/2848/images/uksi_20142848_en_002) where [formula: A × B] applies',
    );
  });

  it('renders a block-level image, an empty figure, and a block-level inline element', () => {
    const { text } = render(
      '<P><Image ResourceRef="none"/><Figure><Title>Figure 1</Title></Figure><Emphasis>Stressed</Emphasis></P>',
    );
    expect(text).toBe('[image]\n[image]\n**Figure 1**\nStressed');
  });

  it('renders a Tabular without an XHTML table as text and skips an empty table', () => {
    expect(render('<P><Tabular><Para><Text>Table not held</Text></Para></Tabular></P>').text).toBe(
      'Table not held',
    );
    expect(render('<P><Tabular><table><tr/></table></Tabular><Text>after</Text></P>').text).toBe(
      'after',
    );
  });

  it('renders a provision with an empty number without a prefix', () => {
    expect(render('<P1><Pnumber/><P1para><Text>Unnumbered.</Text></P1para></P1>').text).toBe(
      'Unnumbered.',
    );
  });
});
