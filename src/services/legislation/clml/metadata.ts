/**
 * @fileoverview Reads CLML document metadata: identity, title, language,
 * publishers, editorial status, made/enactment, laid and in-force dates,
 * versions, links, associated documents, and unapplied effects.
 * @module services/legislation/clml/metadata
 */

import { isCalendarDate } from '../provision-path.js';
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

/**
 * The kinds of associated document, each the snake-cased name of its member
 * element in the metadata `Alter` group, except within `ukm:Notes`: its PDFs
 * (Explanatory Notes, Explanatory Memorandum or Policy Note) are `notes` and
 * its correction slips `notes_correction_slip`, so a correction to the notes
 * never reads as one to the legislation.
 */
export const ASSOCIATED_DOCUMENT_KINDS = [
  'notes',
  'notes_correction_slip',
  'correction_slip',
  'impact_assessment',
  'ukrpc_opinion',
  'transposition_note',
  'policy_equality_statement',
  'code_of_practice',
  'code_of_conduct',
  'order_in_council',
  'table_of_origins',
  'table_of_destinations',
  'explanatory_document',
  'other_document',
] as const;

export type AssociatedDocumentKind = (typeof ASSOCIATED_DOCUMENT_KINDS)[number];

/** A document legislation.gov.uk publishes with the item (linked, never fetched). */
export interface AssociatedDocument {
  date?: string;
  kind: AssociatedDocumentKind;
  /** `@Language` as upstream words it (`Welsh`, `Mixed`); absent for English. */
  language?: string;
  title?: string;
  uri: string;
}

/** One `ukm:Laid`: when, and before which legislature (`@Class`, e.g. `UnitedKingdomParliament`). */
export interface LaidRecord {
  date: string;
  legislature: string;
}

/** Metadata common to documents and tables of contents. */
export interface DocumentMetadata {
  aknUri?: string;
  /** Every associated document, in document order; the item's own PDFs are `pdfUri`. */
  associatedDocuments: AssociatedDocument[];
  category?: string;
  /** `ukm:ComingIntoForce/ukm:DateTime/@Date` values in document order; absent when none. */
  comingIntoForce?: string[];
  /** `dc:identifier` — the served document's URI (with its version segment when it has one). */
  identifier?: string;
  idUri?: string;
  /** Every `ukm:Laid` carrying a date and a legislature, in document order; absent when none. */
  laid?: LaidRecord[];
  language?: string;
  /** `ukm:Made` or `ukm:EnactmentDate` — the date the item was made or enacted; absent unless a calendar date. */
  madeDate?: string;
  mainType?: string;
  modified?: string;
  /** Page of the explanatory notes, explanatory memorandum or policy note; absent when none. */
  notesUri?: string;
  number?: string;
  numberOfProvisions?: number;
  /** The item's own PDF in the language served, else the first listed. */
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
/**
 * Rels of the explanatory notes (Acts), explanatory memorandum (UK and NI
 * instruments, drafts) and policy note (Scottish instruments) pages, matched
 * exactly: `…/navigation/note` is the instrument's own explanatory note, part
 * of its text, and the `…/toc` variants are tables of contents.
 */
const NOTES_RELS = new Set([
  'http://www.legislation.gov.uk/def/navigation/notes',
  'http://www.legislation.gov.uk/def/navigation/memorandum',
  'http://www.legislation.gov.uk/def/navigation/policy-note',
]);

/** One associated-document family: its container's member element and the kind each member reports. */
interface Family {
  kind: AssociatedDocumentKind;
  member: string;
}

/**
 * The `Alter` group families by container element. The item's own
 * `ukm:Alternatives` is absent (it is `pdfUri`), and `ukm:Notes` reads its
 * inner containers from `NOTES_FAMILIES`.
 */
const FAMILIES: ReadonlyMap<string, Family> = new Map([
  ['ukm:CorrectionSlips', { member: 'ukm:CorrectionSlip', kind: 'correction_slip' }],
  ['ukm:ImpactAssessments', { member: 'ukm:ImpactAssessment', kind: 'impact_assessment' }],
  ['ukm:UKRPCOpinions', { member: 'ukm:UKRPCOpinion', kind: 'ukrpc_opinion' }],
  ['ukm:TranspositionNotes', { member: 'ukm:TranspositionNote', kind: 'transposition_note' }],
  [
    'ukm:PolicyEqualityStatements',
    { member: 'ukm:PolicyEqualityStatement', kind: 'policy_equality_statement' },
  ],
  ['ukm:CodesOfPractice', { member: 'ukm:CodeOfPractice', kind: 'code_of_practice' }],
  ['ukm:CodesOfConduct', { member: 'ukm:CodeOfConduct', kind: 'code_of_conduct' }],
  ['ukm:OrdersInCouncil', { member: 'ukm:OrderInCouncil', kind: 'order_in_council' }],
  ['ukm:TablesOfOrigins', { member: 'ukm:TableOfOrigins', kind: 'table_of_origins' }],
  [
    'ukm:TablesOfDestinations',
    { member: 'ukm:TableOfDestinations', kind: 'table_of_destinations' },
  ],
  ['ukm:ExplanatoryDocuments', { member: 'ukm:ExplanatoryDocument', kind: 'explanatory_document' }],
  ['ukm:OtherDocuments', { member: 'ukm:OtherDocument', kind: 'other_document' }],
]);

/** The containers inside `ukm:Notes`; its `ukm:Note` carries only identifiers and is skipped. */
const NOTES_FAMILIES: ReadonlyMap<string, Family> = new Map([
  ['ukm:Alternatives', { member: 'ukm:Alternative', kind: 'notes' }],
  ['ukm:CorrectionSlips', { member: 'ukm:CorrectionSlip', kind: 'notes_correction_slip' }],
]);

/** The type-specific metadata block (`ukm:PrimaryMetadata`, `ukm:SecondaryMetadata`, `ukm:EUMetadata`, …). */
function typedMetadata(metadata: XmlElement | undefined): XmlElement | undefined {
  return metadata ? elements(metadata).find((el) => /^ukm:\w+Metadata$/.test(el.name)) : undefined;
}

/** The members of `container` when `families` names it; a member with no `@URI` links nowhere and is skipped. */
function members(
  container: XmlElement,
  families: ReadonlyMap<string, Family>,
): AssociatedDocument[] {
  const family = families.get(container.name);
  if (!family) return [];
  return childrenNamed(container, family.member).flatMap((el) => {
    const uri = attr(el, 'URI');
    if (!uri) return [];
    const title = attr(el, 'Title');
    const date = attr(el, 'Date');
    const language = attr(el, 'Language');
    return [
      {
        kind: family.kind,
        ...(title ? { title } : {}),
        ...(date ? { date } : {}),
        ...(language ? { language } : {}),
        uri: toHttps(uri),
      },
    ];
  });
}

/** Every associated document of the metadata block, in document order. */
function associatedDocuments(metadata: XmlElement | undefined): AssociatedDocument[] {
  if (!metadata) return [];
  return elements(metadata).flatMap((container) =>
    container.name === 'ukm:Notes'
      ? elements(container).flatMap((inner) => members(inner, NOTES_FAMILIES))
      : members(container, FAMILIES),
  );
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
  const aknLink = links.find((l) => attr(l, 'type') === 'application/akn+xml');
  const pdfLink = links.find((l) => attr(l, 'type') === 'application/pdf');
  const notesLink = links.find((l) => NOTES_RELS.has(attr(l, 'rel') ?? ''));
  const language = textOf(child(metadata, 'dc:language')) || undefined;
  /** The item's own PDFs: the English one records no `@Language`, the Welsh one `Welsh`. */
  const alternatives = childrenNamed(child(metadata, 'ukm:Alternatives'), 'ukm:Alternative');
  const pdfLanguage = language === 'cy' ? 'Welsh' : undefined;
  const alternative =
    alternatives.find((a) => attr(a, 'Language') === pdfLanguage) ?? alternatives[0];
  const year = Number(attr(child(typed, 'ukm:Year'), 'Value'));
  const provisions = Number(attr(root, 'NumberOfProvisions'));
  const akn = attr(aknLink, 'href');
  const pdf = attr(alternative, 'URI') ?? attr(pdfLink, 'href');
  const notes = attr(notesLink, 'href');
  const made =
    attr(child(typed, 'ukm:Made'), 'Date') ?? attr(child(typed, 'ukm:EnactmentDate'), 'Date');
  const laid = childrenNamed(typed, 'ukm:Laid').flatMap((el) => {
    const date = attr(el, 'Date');
    const legislature = attr(el, 'Class');
    return date && legislature ? [{ date, legislature }] : [];
  });
  const comingIntoForce = childrenNamed(typed, 'ukm:ComingIntoForce')
    .flatMap((el) => childrenNamed(el, 'ukm:DateTime'))
    .map((el) => attr(el, 'Date'))
    .filter((date) => date !== undefined);
  const optional = {
    identifier: textOf(child(metadata, 'dc:identifier')) || undefined,
    idUri: attr(root, 'IdURI'),
    language,
    modified: textOf(child(metadata, 'dc:modified')) || undefined,
    valid: textOf(child(metadata, 'dct:valid')) || undefined,
    category: attr(child(classification, 'ukm:DocumentCategory'), 'Value'),
    mainType: attr(child(classification, 'ukm:DocumentMainType'), 'Value'),
    status: attr(child(classification, 'ukm:DocumentStatus'), 'Value'),
    number: attr(child(typed, 'ukm:Number'), 'Value'),
    /** Kept only as a calendar date: a notice quotes it and dated reads compare against it (Design Decision 74). */
    madeDate: made && isCalendarDate(made) ? made : undefined,
    laid: laid.length > 0 ? laid : undefined,
    comingIntoForce: comingIntoForce.length > 0 ? comingIntoForce : undefined,
    restrictExtent: attr(root, 'RestrictExtent'),
    restrictStartDate: attr(root, 'RestrictStartDate'),
    restrictEndDate: attr(root, 'RestrictEndDate'),
    aknUri: akn ? toHttps(akn) : undefined,
    pdfUri: pdf ? toHttps(pdf) : undefined,
    notesUri: notes ? toHttps(notes) : undefined,
    titleCy: titleCy ? textOf(titleCy) : undefined,
  };
  return {
    title: textOf(title),
    publishers: childrenNamed(metadata, 'dc:publisher').map(textOf).filter(Boolean),
    versions: links
      .filter((l) => attr(l, 'rel') === HAS_VERSION)
      .map((l) => attr(l, 'title') ?? '')
      .filter(Boolean),
    associatedDocuments: associatedDocuments(metadata),
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
