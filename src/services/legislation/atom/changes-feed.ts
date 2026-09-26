/**
 * @fileoverview Parses changes feeds (`/changes/…/data.feed`): one effect
 * record per entry plus the totals upstream always reports on these feeds.
 * @module services/legislation/atom/changes-feed
 */

import { parseEffect } from '../clml/effects.js';
import type { EffectRecord } from '../types.js';
import { child, findDescendant, parseXml } from '../xml.js';
import { entries, type FeedPaging, readPaging } from './common.js';

/** A parsed changes feed page. */
export interface ChangesFeed extends FeedPaging {
  effects: EffectRecord[];
}

/** Parses a changes feed body. */
export function parseChangesFeed(body: string): ChangesFeed {
  const feed = parseXml(body, 'a changes feed');
  const effects: EffectRecord[] = [];
  for (const entry of entries(feed)) {
    const effect = findDescendant(
      child(entry, 'content') ?? entry,
      (el) => el.name === 'ukm:Effect',
    );
    if (effect) effects.push(parseEffect(effect));
  }
  return { ...readPaging(feed), effects };
}
