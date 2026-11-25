/**
 * @fileoverview The heading of a CLML provision element: one rule for a
 * provision read's own heading, the headings of the elements enclosing it,
 * and a fragment outline's entries, so an outline entry and a read of it
 * carry the same heading.
 * @module services/legislation/clml/provision-heading
 */

import { child, textOf, type XmlElement } from '../xml.js';

/**
 * The heading of `el`, a provision element sitting in `container`: a P1's
 * P1group title, else its own title or its TitleBlock's (a Schedule's), else
 * a cross-heading's number, which is all some cross-headings carry (CPR
 * Part 77's). Undefined when it has none.
 */
export function provisionHeading(
  el: XmlElement,
  container: XmlElement | undefined,
): string | undefined {
  const title =
    (el.name === 'P1' && container?.name === 'P1group' ? child(container, 'Title') : undefined) ??
    child(el, 'Title') ??
    child(child(el, 'TitleBlock'), 'Title');
  const crossheading = el.name === 'Pblock' || el.name === 'PsubBlock';
  return textOf(title) || (crossheading ? textOf(child(el, 'Number')) : '') || undefined;
}
