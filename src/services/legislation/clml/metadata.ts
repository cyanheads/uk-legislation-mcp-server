/**
 * @fileoverview Reads CLML document metadata: identity, title, language,
 * publishers, editorial status, versions, links, and unapplied effects.
 * @module services/legislation/clml/metadata
 */

import type { EffectRecord } from '../types.js';
import {
  attr,
  child,
  childrenNamed,
  elements,
  findDescendants,
  textOf,
  toHttps,
  type XmlElement,
} from '../xml.js';
import { parseEffect } from './effects.js';

/** Metadata common to documents and tables of contents. */
export interface DocumentMetadata {
  aknUri?: string;
  category?: string;
  /** `dc:identifier` — the served document's URI (with its version segment when it has one). */
  identifier?: string;
  idUri?: string;
  language?: string;
  mainType?: string;
  modified?: string;
  number?: string;
  numberOfProvisions?: number;
  pdfUri?: string;
  publishers: string[];
  restrictEndDate?: string;
  restrictExtent?: string;
  restrictStartDate?: string;
  status?: string;
  title: string;
  titleCy?: string;
  unappliedEffects: EffectRecord[];
  /** `dct:valid` — start date of the version served. */
  valid?: string;
  /** `dct:hasVersion` titles in document order. */
  versions: string[];
  year?: number;
}

const HAS_VERSION = 'http://purl.org/dc/terms/hasVersion';

/** The type-specific metadata block (`ukm:PrimaryMetadata`, `ukm:SecondaryMetadata`, `ukm:EUMetadata`, …). */
function typedMetadata(metadata: XmlElement | undefined): XmlElement | undefined {
  return metadata ? elements(metadata).find((el) => /^ukm:\w+Metadata$/.test(el.name)) : undefined;
}

/** Reads the metadata of a parsed CLML root element. */
export function readMetadata(root: XmlElement): DocumentMetadata {
  const metadata = child(root, 'ukm:Metadata');
  const typed = typedMetadata(metadata);
  const classification = child(typed, 'ukm:DocumentClassification');
  const titles = childrenNamed(metadata, 'dc:title');
  const title = titles.find((t) => t.attrs['xml:lang'] !== 'cy') ?? titles[0];
  const titleCy = titles.find((t) => t.attrs['xml:lang'] === 'cy');
  const links = childrenNamed(metadata, 'atom:link');
  const akn = links.find((l) => attr(l, 'type') === 'application/akn+xml');
  const pdfLink = links.find((l) => attr(l, 'type') === 'application/pdf');
  const alternative = childrenNamed(child(metadata, 'ukm:Alternatives'), 'ukm:Alternative')[0];
  const year = Number(attr(child(typed, 'ukm:Year'), 'Value'));
  const provisions = Number(attr(root, 'NumberOfProvisions'));
  const pdf = attr(alternative, 'URI') ?? attr(pdfLink, 'href');
  const optional = {
    identifier: textOf(child(metadata, 'dc:identifier')) || undefined,
    idUri: attr(root, 'IdURI'),
    language: textOf(child(metadata, 'dc:language')) || undefined,
    modified: textOf(child(metadata, 'dc:modified')) || undefined,
    valid: textOf(child(metadata, 'dct:valid')) || undefined,
    category: attr(child(classification, 'ukm:DocumentCategory'), 'Value'),
    mainType: attr(child(classification, 'ukm:DocumentMainType'), 'Value'),
    status: attr(child(classification, 'ukm:DocumentStatus'), 'Value'),
    number: attr(child(typed, 'ukm:Number'), 'Value'),
    restrictExtent: attr(root, 'RestrictExtent'),
    restrictStartDate: attr(root, 'RestrictStartDate'),
    restrictEndDate: attr(root, 'RestrictEndDate'),
    aknUri: attr(akn, 'href') ? toHttps(attr(akn, 'href') as string) : undefined,
    pdfUri: pdf ? toHttps(pdf) : undefined,
    titleCy: titleCy ? textOf(titleCy) : undefined,
  };
  return {
    title: textOf(title),
    publishers: childrenNamed(metadata, 'dc:publisher').map(textOf).filter(Boolean),
    versions: links
      .filter((l) => attr(l, 'rel') === HAS_VERSION)
      .map((l) => attr(l, 'title') ?? '')
      .filter(Boolean),
    unappliedEffects: findDescendants(typed ?? root, (el) => el.name === 'ukm:UnappliedEffect').map(
      parseEffect,
    ),
    ...(Number.isFinite(year) && year > 0 ? { year } : {}),
    ...(Number.isFinite(provisions) ? { numberOfProvisions: provisions } : {}),
    ...(Object.fromEntries(
      Object.entries(optional).filter(([, v]) => v !== undefined),
    ) as Partial<DocumentMetadata>),
  };
}
