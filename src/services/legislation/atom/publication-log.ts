/**
 * @fileoverview Parses Publication Log feeds (`/update/…/data.feed`) into
 * event records.
 * @module services/legislation/atom/publication-log
 */

import {
  attr,
  bilingualText,
  child,
  childrenNamed,
  legislationPath,
  parseXml,
  textOf,
  toHttps,
  type XmlElement,
} from '../xml.js';
import { entries, type FeedPaging, readPaging } from './common.js';

/** One Publication Log event. */
export interface PublicationEvent {
  category?: string;
  content_type: string;
  direction?: string;
  document_uri?: string;
  event: string;
  format?: string;
  item: { id_uri: string; path: string; title: string; title_cy?: string };
  language?: string;
  new?: boolean;
  newly_issued?: boolean;
  number?: string;
  publisher: string;
  republished?: boolean;
  resource_uri: string;
  type: string;
  /** Event timestamp as upstream writes it (UK local time with offset). */
  updated: string;
  year?: number;
}

/** A parsed Publication Log page. */
export interface PublicationLogPage extends FeedPaging {
  events: PublicationEvent[];
}

function flag(entry: XmlElement, name: string): boolean | undefined {
  const text = textOf(child(entry, name)).toLowerCase();
  return text === 'true' ? true : text === 'false' ? false : undefined;
}

function parseEvent(entry: XmlElement): PublicationEvent | undefined {
  const id = textOf(child(entry, 'id'));
  const identifier = textOf(child(entry, 'dc:identifier'));
  const path = legislationPath(identifier);
  if (!path) return;
  const title = bilingualText(child(entry, 'title'));
  const year = Number(attr(child(entry, 'ukm:Year'), 'Value'));
  const number = attr(child(entry, 'ukm:Number'), 'Value');
  const category = attr(child(entry, 'ukm:DocumentCategory'), 'Value');
  const document = textOf(child(entry, 'pbl:Document'));
  const published = textOf(child(entry, 'pbl:Item_Published'));
  const format = textOf(child(entry, 'pbl:Format'));
  const language = textOf(child(entry, 'dc:language'));
  const direction = textOf(child(entry, 'pbl:Direction'));
  const flags = {
    new: flag(entry, 'pbl:New'),
    newly_issued: flag(entry, 'pbl:NewlyIssued'),
    republished: flag(entry, 'pbl:Republished'),
  };
  return {
    updated: textOf(child(entry, 'updated')),
    item: {
      path,
      id_uri: toHttps(identifier),
      title: title.en,
      ...(title.cy ? { title_cy: title.cy } : {}),
    },
    content_type: textOf(child(entry, 'pbl:ContentType')),
    event: textOf(child(entry, 'pbl:Event')),
    ...(category ? { category } : {}),
    type: path.split('/')[0] ?? '',
    ...(Number.isInteger(year) && year > 0 ? { year } : {}),
    ...(number ? { number } : {}),
    ...(document ? { document_uri: toHttps(document) } : {}),
    resource_uri: toHttps(published || id.replace(/\/(?:published|withdrawn)\/[^/]+$/, '')),
    ...(format ? { format } : {}),
    ...(language ? { language } : {}),
    ...Object.fromEntries(Object.entries(flags).filter(([, v]) => v !== undefined)),
    ...(direction ? { direction } : {}),
    publisher: textOf(child(childrenNamed(entry, 'author')[0], 'name')),
  };
}

/** Parses a Publication Log feed body. */
export function parsePublicationLog(body: string): PublicationLogPage {
  const feed = parseXml(body, 'a Publication Log feed');
  return {
    ...readPaging(feed),
    events: entries(feed)
      .map(parseEvent)
      .filter((e): e is PublicationEvent => e !== undefined),
  };
}
