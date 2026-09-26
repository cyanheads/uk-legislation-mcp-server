/**
 * @fileoverview Builds the attribution lines a response's content requires:
 * the Open Government Licence line always, the EU line when EU-origin content
 * appears, and the Westlaw credit when a Westlaw-contributed document is served.
 * @module services/legislation/attribution
 */

import { ATTRIBUTION_LINES, EU_TYPE_CODES } from './reference-data.js';

/** What a response contains, as far as licensing is concerned. */
export interface AttributionInput {
  /** Document categories seen (`euretained` marks EU-origin content). */
  categories?: Iterable<string | undefined>;
  /** Publishers seen on served documents (`Westlaw` adds the Westlaw credit). */
  publishers?: Iterable<string | undefined>;
  /** Type codes of every item that appears in the response. */
  types?: Iterable<string | undefined>;
}

/** Returns the attribution lines for a response. */
export function buildAttribution(input: AttributionInput = {}): string[] {
  const lines: string[] = [ATTRIBUTION_LINES.ogl];
  const types = [...(input.types ?? [])];
  const categories = [...(input.categories ?? [])];
  if (types.some((t) => t && EU_TYPE_CODES.has(t)) || categories.includes('euretained')) {
    lines.push(ATTRIBUTION_LINES.eu);
  }
  if ([...(input.publishers ?? [])].some((p) => p && /westlaw/i.test(p))) {
    lines.push(ATTRIBUTION_LINES.westlaw);
  }
  return lines;
}
