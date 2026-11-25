/**
 * @fileoverview Tests for the provision heading rule shared by a provision
 * read, the elements enclosing it, and a fragment outline: a P1's P1group
 * title, else the element's title or its TitleBlock's, else a cross-heading's
 * number.
 * @module tests/services/legislation/clml/provision-heading.test
 */

import { describe, expect, it } from 'vitest';
import { provisionHeading } from '@/services/legislation/clml/provision-heading.js';
import { findDescendant, parseXml, type XmlElement } from '@/services/legislation/xml.js';

/** The element marked `x="1"` in `xml` and the element it sits in. */
function pick(xml: string): { container: XmlElement; el: XmlElement } {
  const root = parseXml(`<Legislation>${xml}</Legislation>`, 'x');
  const container = findDescendant(root, (e) =>
    e.children.some((c) => typeof c !== 'string' && c.attrs.x === '1'),
  );
  const el = findDescendant(root, (e) => e.attrs.x === '1');
  if (!container || !el) throw new Error('no marked element');
  return { container, el };
}

describe('provisionHeading', () => {
  it.each([
    [
      'a P1 by its P1group title',
      '<Body><P1group><Title>Interpretation</Title><P1 x="1"><Text>t</Text></P1></P1group></Body>',
      'Interpretation',
    ],
    [
      'a P1 of a P1group holding several by the group title',
      '<Body><P1group><Title>Shared</Title><P1><Text>a</Text></P1><P1 x="1"><Text>b</Text></P1></P1group></Body>',
      'Shared',
    ],
    [
      'a P1 carrying its own title by its P1group title, which takes precedence',
      '<Body><P1group><Title>Group heading</Title><P1 x="1"><Title>Own heading</Title><Text>t</Text></P1></P1group></Body>',
      'Group heading',
    ],
    [
      'a P1 in a P1group with no title as unheaded',
      '<Body><P1group><P1 x="1"><Text>t</Text></P1></P1group></Body>',
      undefined,
    ],
    [
      'a Part by its title, not its number',
      '<Body><Part x="1"><Number>PART 3</Number><Title>Law enforcement processing</Title></Part></Body>',
      'Law enforcement processing',
    ],
    [
      'a Schedule by its TitleBlock title',
      '<Schedules><Schedule x="1"><Number>SCHEDULE 1</Number><TitleBlock><Title>Special categories</Title></TitleBlock></Schedule></Schedules>',
      'Special categories',
    ],
    [
      'a cross-heading by its title over its number',
      '<Body><Pblock x="1"><Number>SECTION 1</Number><Title>Orders</Title></Pblock></Body>',
      'Orders',
    ],
    [
      'a cross-heading with no title by its number',
      '<Body><Pblock x="1"><Number>SECTION 1 – ORDERS</Number></Pblock></Body>',
      'SECTION 1 – ORDERS',
    ],
    [
      'a cross-heading with an empty title by its number',
      '<Body><Pblock x="1"><Number>SECTION 2</Number><Title> </Title></Pblock></Body>',
      'SECTION 2',
    ],
    [
      'a sub-cross-heading with no title by its number',
      '<Body><PsubBlock x="1"><Number>A</Number></PsubBlock></Body>',
      'A',
    ],
    [
      'a Part with only a number as unheaded',
      '<Body><Part x="1"><Number>PART 9</Number></Part></Body>',
      undefined,
    ],
    ['a sub-paragraph as unheaded', '<P1><P2 x="1"><Text>t</Text></P2></P1>', undefined],
    [
      'a title with markup and line breaks as its flattened text',
      '<Body><Part x="1"><Title>Rights <Emphasis>of</Emphasis>\n   the <Abbreviation>data</Abbreviation> subject</Title></Part></Body>',
      'Rights of the data subject',
    ],
  ])('heads %s', (_case, xml, heading) => {
    const { container, el } = pick(xml);
    expect(provisionHeading(el, container)).toBe(heading);
  });
});
