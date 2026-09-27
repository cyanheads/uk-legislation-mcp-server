/**
 * @fileoverview Static reference tables — legislation type codes, type groups,
 * extents, version keywords, document status, annotation types, effect fields,
 * provision paths, citation forms, Publication Log vocabulary, coverage, and
 * attribution. Drives input validation and `uklaw_list_reference`.
 * @module services/legislation/reference-data
 */

/** Legislation category a type belongs to. */
export type TypeCategory = 'primary' | 'secondary' | 'eu-origin' | 'draft';

/** One legislation type code as legislation.gov.uk addresses it. */
export interface LegislationType {
  category: TypeCategory;
  code: string;
  /** The type's division name in citations (section, article, regulation, rule). */
  division: string;
  /** Keyword the as-enacted version is addressed by. */
  enactedKeyword: 'enacted' | 'made' | 'adopted' | 'created';
  jurisdiction: string;
  label: string;
  /** `ukm:DocumentMainType` value upstream uses for this type. */
  mainType: string;
  /** How the number segment is formed. */
  numberForm: string;
}

const REGNAL = 'integer; regnal year (Monarch/session) before 1963';

/** Every type code the search, document, and changes paths accept. */
export const LEGISLATION_TYPES: readonly LegislationType[] = [
  {
    code: 'ukpga',
    label: 'UK Public General Acts',
    mainType: 'UnitedKingdomPublicGeneralAct',
    category: 'primary',
    jurisdiction: 'United Kingdom',
    division: 'section',
    numberForm: REGNAL,
    enactedKeyword: 'enacted',
  },
  {
    code: 'ukla',
    label: 'UK Local Acts',
    mainType: 'UnitedKingdomLocalAct',
    category: 'primary',
    jurisdiction: 'United Kingdom',
    division: 'section',
    numberForm: `${REGNAL}; older Local Acts use lower-case roman numerals`,
    enactedKeyword: 'enacted',
  },
  {
    code: 'ukppa',
    label: 'UK Private and Personal Acts',
    mainType: 'UnitedKingdomPrivateOrPersonalAct',
    category: 'primary',
    jurisdiction: 'United Kingdom',
    division: 'section',
    numberForm: REGNAL,
    enactedKeyword: 'enacted',
  },
  {
    code: 'asp',
    label: 'Acts of the Scottish Parliament',
    mainType: 'ScottishAct',
    category: 'primary',
    jurisdiction: 'Scotland',
    division: 'section',
    numberForm: 'integer',
    enactedKeyword: 'enacted',
  },
  {
    code: 'asc',
    label: 'Acts of Senedd Cymru',
    mainType: 'WelshParliamentAct',
    category: 'primary',
    jurisdiction: 'Wales',
    division: 'section',
    numberForm: 'integer',
    enactedKeyword: 'enacted',
  },
  {
    code: 'anaw',
    label: 'Acts of the National Assembly for Wales',
    mainType: 'WelshNationalAssemblyAct',
    category: 'primary',
    jurisdiction: 'Wales',
    division: 'section',
    numberForm: 'integer',
    enactedKeyword: 'enacted',
  },
  {
    code: 'mwa',
    label: 'Measures of the National Assembly for Wales',
    mainType: 'WelshAssemblyMeasure',
    category: 'primary',
    jurisdiction: 'Wales',
    division: 'section',
    numberForm: 'integer',
    enactedKeyword: 'enacted',
  },
  {
    code: 'ukcm',
    label: 'Church Measures',
    mainType: 'UnitedKingdomChurchMeasure',
    category: 'primary',
    jurisdiction: 'England (Church of England)',
    division: 'section',
    numberForm: 'integer',
    enactedKeyword: 'enacted',
  },
  {
    code: 'nia',
    label: 'Acts of the Northern Ireland Assembly',
    mainType: 'NorthernIrelandAct',
    category: 'primary',
    jurisdiction: 'Northern Ireland',
    division: 'section',
    numberForm: 'integer',
    enactedKeyword: 'enacted',
  },
  {
    code: 'nisi',
    label: 'Northern Ireland Orders in Council',
    mainType: 'NorthernIrelandOrderInCouncil',
    category: 'primary',
    jurisdiction: 'Northern Ireland',
    division: 'article',
    numberForm: 'integer (shares the UK SI number series)',
    enactedKeyword: 'made',
  },
  {
    code: 'apni',
    label: 'Acts of the Northern Ireland Parliament',
    mainType: 'NorthernIrelandParliamentAct',
    category: 'primary',
    jurisdiction: 'Northern Ireland',
    division: 'section',
    numberForm: REGNAL,
    enactedKeyword: 'enacted',
  },
  {
    code: 'mnia',
    label: 'Measures of the Northern Ireland Assembly',
    mainType: 'NorthernIrelandAssemblyMeasure',
    category: 'primary',
    jurisdiction: 'Northern Ireland',
    division: 'section',
    numberForm: 'integer',
    enactedKeyword: 'enacted',
  },
  {
    code: 'aosp',
    label: 'Acts of the Old Scottish Parliament',
    mainType: 'ScottishOldAct',
    category: 'primary',
    jurisdiction: 'Scotland',
    division: 'section',
    numberForm: 'integer within a calendar year',
    enactedKeyword: 'enacted',
  },
  {
    code: 'aep',
    label: 'Acts of the English Parliament',
    mainType: 'EnglandAct',
    category: 'primary',
    jurisdiction: 'England',
    division: 'section',
    numberForm: 'regnal year (Monarch/session)',
    enactedKeyword: 'enacted',
  },
  {
    code: 'aip',
    label: 'Acts of the Old Irish Parliament',
    mainType: 'IrelandAct',
    category: 'primary',
    jurisdiction: 'Ireland',
    division: 'section',
    numberForm: 'regnal year (Monarch/session)',
    enactedKeyword: 'enacted',
  },
  {
    code: 'apgb',
    label: 'Acts of the Parliament of Great Britain',
    mainType: 'GreatBritainAct',
    category: 'primary',
    jurisdiction: 'Great Britain',
    division: 'section',
    numberForm: 'regnal year (Monarch/session)',
    enactedKeyword: 'enacted',
  },
  {
    code: 'gbla',
    label: 'Local Acts of the Parliament of Great Britain',
    mainType: 'GreatBritainLocalAct',
    category: 'primary',
    jurisdiction: 'Great Britain',
    division: 'section',
    numberForm: 'regnal year (Monarch/session)',
    enactedKeyword: 'enacted',
  },
  {
    code: 'gbppa',
    label: 'Private and Personal Acts of the Parliament of Great Britain',
    mainType: 'GreatBritainPrivateOrPersonalAct',
    category: 'primary',
    jurisdiction: 'Great Britain',
    division: 'section',
    numberForm: 'regnal year (Monarch/session)',
    enactedKeyword: 'enacted',
  },
  {
    code: 'uksi',
    label: 'UK Statutory Instruments',
    mainType: 'UnitedKingdomStatutoryInstrument',
    category: 'secondary',
    jurisdiction: 'United Kingdom',
    division: 'regulation, article, or rule',
    numberForm: 'integer (a uksi search also returns Welsh SIs)',
    enactedKeyword: 'made',
  },
  {
    code: 'wsi',
    label: 'Wales Statutory Instruments',
    mainType: 'WelshStatutoryInstrument',
    category: 'secondary',
    jurisdiction: 'Wales',
    division: 'regulation, article, or rule',
    numberForm: 'integer (shares the UK SI number series, W. series as an alternative number)',
    enactedKeyword: 'made',
  },
  {
    code: 'ssi',
    label: 'Scottish Statutory Instruments',
    mainType: 'ScottishStatutoryInstrument',
    category: 'secondary',
    jurisdiction: 'Scotland',
    division: 'regulation, article, or rule',
    numberForm: 'integer',
    enactedKeyword: 'made',
  },
  {
    code: 'nisr',
    label: 'Northern Ireland Statutory Rules',
    mainType: 'NorthernIrelandStatutoryRule',
    category: 'secondary',
    jurisdiction: 'Northern Ireland',
    division: 'regulation, article, or rule',
    numberForm: 'integer',
    enactedKeyword: 'made',
  },
  {
    code: 'ukci',
    label: 'Church Instruments',
    mainType: 'UnitedKingdomChurchInstrument',
    category: 'secondary',
    jurisdiction: 'England (Church of England)',
    division: 'regulation, article, or rule',
    numberForm: 'integer',
    enactedKeyword: 'made',
  },
  {
    code: 'ukmd',
    label: 'UK Ministerial Directions',
    mainType: 'UnitedKingdomMinisterialDirection',
    category: 'secondary',
    jurisdiction: 'United Kingdom',
    division: 'paragraph',
    numberForm: 'integer',
    enactedKeyword: 'made',
  },
  {
    code: 'ukmo',
    label: 'UK Ministerial Orders',
    mainType: 'UnitedKingdomMinisterialOrder',
    category: 'secondary',
    jurisdiction: 'United Kingdom',
    division: 'article',
    numberForm: 'integer',
    enactedKeyword: 'made',
  },
  {
    code: 'uksro',
    label: 'UK Statutory Rules and Orders',
    mainType: 'UnitedKingdomStatutoryRuleOrOrder',
    category: 'secondary',
    jurisdiction: 'United Kingdom',
    division: 'regulation, article, or rule',
    numberForm: 'integer',
    enactedKeyword: 'made',
  },
  {
    code: 'nisro',
    label: 'Northern Ireland Statutory Rules and Orders',
    mainType: 'NorthernIrelandStatutoryRuleOrOrder',
    category: 'secondary',
    jurisdiction: 'Northern Ireland',
    division: 'regulation, article, or rule',
    numberForm: 'integer',
    enactedKeyword: 'made',
  },
  {
    code: 'eur',
    label: 'Regulations originating from the EU',
    mainType: 'EuropeanUnionRegulation',
    category: 'eu-origin',
    jurisdiction: 'United Kingdom (retained EU law)',
    division: 'article',
    numberForm: 'integer within a calendar year',
    enactedKeyword: 'adopted',
  },
  {
    code: 'eudn',
    label: 'Decisions originating from the EU',
    mainType: 'EuropeanUnionDecision',
    category: 'eu-origin',
    jurisdiction: 'United Kingdom (retained EU law)',
    division: 'article',
    numberForm: 'integer within a calendar year',
    enactedKeyword: 'adopted',
  },
  {
    code: 'eudr',
    label: 'Directives originating from the EU',
    mainType: 'EuropeanUnionDirective',
    category: 'eu-origin',
    jurisdiction: 'United Kingdom (EU law as it stood at 31 December 2020)',
    division: 'article',
    numberForm: 'integer within a calendar year',
    enactedKeyword: 'adopted',
  },
  {
    code: 'eut',
    label: 'EU treaties',
    mainType: 'EuropeanUnionTreaty',
    category: 'eu-origin',
    jurisdiction: 'United Kingdom (EU law as it stood at 31 December 2020)',
    division: 'article',
    numberForm: 'integer within a calendar year',
    enactedKeyword: 'adopted',
  },
  {
    code: 'ukdsi',
    label: 'UK Draft Statutory Instruments',
    mainType: 'UnitedKingdomDraftStatutoryInstrument',
    category: 'draft',
    jurisdiction: 'United Kingdom',
    division: 'regulation, article, or rule',
    numberForm: '13-digit ISBN',
    enactedKeyword: 'created',
  },
  {
    code: 'sdsi',
    label: 'Scottish Draft Statutory Instruments',
    mainType: 'ScottishDraftStatutoryInstrument',
    category: 'draft',
    jurisdiction: 'Scotland',
    division: 'regulation, article, or rule',
    numberForm: '13-digit ISBN',
    enactedKeyword: 'created',
  },
  {
    code: 'nidsr',
    label: 'Northern Ireland Draft Statutory Rules',
    mainType: 'NorthernIrelandDraftStatutoryRule',
    category: 'draft',
    jurisdiction: 'Northern Ireland',
    division: 'regulation, article, or rule',
    numberForm: '13-digit ISBN',
    enactedKeyword: 'created',
  },
];

/** Type codes in reference order — the `types` enum on search. */
export const TYPE_CODES = LEGISLATION_TYPES.map((t) => t.code) as [string, ...string[]];

/** Type groups accepted alongside codes. */
export const TYPE_GROUPS = ['all', 'primary', 'secondary', 'eu-origin', 'draft'] as const;

const TYPES_BY_CODE = new Map(LEGISLATION_TYPES.map((t) => [t.code, t]));

/** Looks up a type by its code (case-sensitive lowercase). */
export function typeByCode(code: string): LegislationType | undefined {
  return TYPES_BY_CODE.get(code);
}

/** Human label for a type code, falling back to the code itself. */
export function typeLabel(code: string): string {
  return TYPES_BY_CODE.get(code)?.label ?? code;
}

/** Type codes in one category, in reference order. */
export function codesIn(category: TypeCategory): string[] {
  return LEGISLATION_TYPES.filter((t) => t.category === category).map((t) => t.code);
}

/** EU-origin type codes — their content carries the EU attribution line. */
export const EU_TYPE_CODES: ReadonlySet<string> = new Set(codesIn('eu-origin'));

/** Extent names the search path accepts. */
export const EXTENTS = ['england', 'wales', 'scotland', 'ni'] as const;

/** Provision path keywords that may open or appear within a provision path. */
export const PROVISION_KEYWORDS: ReadonlySet<string> = new Set([
  'section',
  'regulation',
  'article',
  'rule',
  'schedule',
  'paragraph',
  'part',
  'chapter',
  'crossheading',
  'introduction',
  'body',
  'schedules',
  'signature',
  'note',
  'annex',
  'appendix',
  'title',
  'division',
  'subsection',
  'order',
  'group',
  'attachment',
  'attachments',
  'earlier-orders',
]);

/** Keywords that stand alone as a whole provision path with no number after them. */
export const STANDALONE_PROVISIONS: ReadonlySet<string> = new Set([
  'introduction',
  'body',
  'schedules',
  'signature',
  'note',
  'attachments',
  'earlier-orders',
]);

/**
 * Commentary (annotation) type letters and what each records. A `Map`,
 * because the renderer looks it up by upstream text.
 */
export const ANNOTATION_TYPES: ReadonlyMap<string, string> = new Map([
  ['F', 'Textual amendment'],
  ['C', 'Modification without textual change'],
  ['I', 'Commencement information'],
  ['M', 'Marginal citation'],
  ['E', 'Extent information'],
  ['P', 'Power exercised'],
  ['X', 'Editorial note'],
]);

/** Display order of annotation types, as legislation.gov.uk groups them. */
export const ANNOTATION_TYPE_ORDER = ['F', 'C', 'I', 'M', 'E', 'P', 'X'] as const;

/** One reference table row, in the shape `uklaw_list_reference` returns. */
export interface ReferenceEntry {
  description: string;
  details?: Record<string, string>;
  key: string;
  label: string;
}

/** Topics `uklaw_list_reference` decodes. */
export const REFERENCE_TOPICS = [
  'types',
  'type_groups',
  'extents',
  'versions',
  'document_status',
  'annotation_types',
  'effects',
  'provision_paths',
  'citation_formats',
  'publication_log',
  'coverage',
  'attribution',
] as const;

export type ReferenceTopic = (typeof REFERENCE_TOPICS)[number];

const OGL_LINE =
  '© Crown and database right. Derived from content available under the Open Government Licence v3.0 from legislation.gov.uk.';
const EU_LINE =
  'Material derived from the European Institutions © European Union, 1998-2020, re-used under Commission Decision 2011/833/EU; no endorsement by the EU is implied.';
const WESTLAW_LINE =
  'Westlaw UK derived from Crown Copyright material and contributed to legislation.gov.uk.';

/** Attribution lines, exported for the attribution builder. */
export const ATTRIBUTION_LINES = { ogl: OGL_LINE, eu: EU_LINE, westlaw: WESTLAW_LINE } as const;

const CATEGORY_LABELS: Record<TypeCategory, string> = {
  primary: 'Primary',
  secondary: 'Secondary',
  'eu-origin': 'EU-origin',
  draft: 'Draft',
};

const REFERENCE: Record<ReferenceTopic, ReferenceEntry[]> = {
  types: LEGISLATION_TYPES.map((t) => ({
    key: t.code,
    label: t.label,
    description: `${CATEGORY_LABELS[t.category]} legislation for ${t.jurisdiction}.`,
    details: {
      document_main_type: t.mainType,
      category: t.category,
      jurisdiction: t.jurisdiction,
      division: t.division,
      number_form: t.numberForm,
      enacted_keyword: t.enactedKeyword,
      ...(t.code === 'wsi' || t.code === 'nisi'
        ? { note: 'Shares the UK SI number series; a uksi search or citation also returns these.' }
        : {}),
      ...(t.code === 'uksi'
        ? {
            note: 'A uksi search or numbered citation also returns Welsh SIs (wsi), which share the number series.',
          }
        : {}),
    },
  })),
  type_groups: [
    {
      key: 'all',
      label: 'All legislation',
      description:
        'UK primary and secondary legislation plus EU-origin legislation; excludes drafts. Search default. Combined with other values it reduces to all.',
    },
    {
      key: 'primary',
      label: 'Primary legislation',
      description: `Acts and Measures: ${codesIn('primary').join(', ')}.`,
    },
    {
      key: 'secondary',
      label: 'Secondary legislation',
      description: `Statutory instruments and rules: ${codesIn('secondary').join(', ')}.`,
    },
    {
      key: 'eu-origin',
      label: 'Legislation originating from the EU',
      description: `EU regulations, decisions, directives and treaties held as they stood at the end of the transition period and since amended as UK law: ${codesIn('eu-origin').join(', ')}.`,
    },
    {
      key: 'draft',
      label: 'Draft legislation',
      description: `Draft instruments laid before Parliament, numbered by ISBN: ${codesIn('draft').join(', ')}. Not law.`,
    },
  ],
  extents: [
    {
      key: 'england',
      label: 'England',
      description: 'Provisions extending to England. Extent code E.',
    },
    { key: 'wales', label: 'Wales', description: 'Provisions extending to Wales. Extent code W.' },
    {
      key: 'scotland',
      label: 'Scotland',
      description: 'Provisions extending to Scotland. Extent code S.',
    },
    {
      key: 'ni',
      label: 'Northern Ireland',
      description: 'Provisions extending to Northern Ireland. Extent code N.I.',
    },
    {
      key: 'applicable',
      label: 'extent_match: applicable',
      description:
        'An item matches when any of its provisions extends to at least one of the given extents (default).',
    },
    {
      key: 'exact',
      label: 'extent_match: exact',
      description: 'An item matches when a provision extends to exactly the set of extents given.',
    },
    {
      key: 'restrict_extent',
      label: 'RestrictExtent strings',
      description:
        'Document extents are written as codes joined by +: E+W+S+N.I. is the whole UK, E+W is England and Wales. Upstream sometimes spells "Same as affected" letter by letter (S+A+M+E+A+S+A+F+F+E+C+T+E+D); effect records normalize it to "same as affected".',
    },
    {
      key: 'coverage',
      label: 'Extent data coverage',
      description:
        'Extent filters depend on provision-level extent data that legislation.gov.uk has not recorded for many recent items; an empty extent search does not prove no provision extends there.',
    },
  ],
  versions: [
    {
      key: 'current',
      label: 'Current revised text',
      description:
        'The latest revised version (default). Unrevised secondary legislation has no revised version; the as-made text is returned instead.',
    },
    {
      key: 'enacted',
      label: 'As enacted / made / adopted',
      description:
        'The original text. made, adopted and created are accepted as synonyms; upstream uses enacted for Acts, made for instruments, adopted for EU-origin items, created for drafts.',
    },
    {
      key: 'YYYY-MM-DD',
      label: 'Point in time',
      description:
        'The text as it stood on that date. A date before the item or provision existed is not found; a future date returns the latest known version, and version.applied reports the version actually served.',
    },
    {
      key: 'base_dates',
      label: 'Revision base dates',
      description:
        'Revised primary legislation starts from the 1 February 1991 base date (Northern Ireland: 1 January 2006); no earlier point-in-time text exists for it.',
    },
  ],
  document_status: [
    {
      key: 'final',
      label: 'As enacted / made',
      description:
        'Original text as published; later amendments are not reflected. Read version current for the revised text.',
    },
    {
      key: 'revised',
      label: 'Revised',
      description:
        'An editorial consolidation by legislation.gov.uk that applies recorded effects; it can lag behind amendments.',
    },
    {
      key: 'draft',
      label: 'Draft',
      description: 'A draft instrument laid before Parliament; not made law.',
    },
    {
      key: 'unapplied_effect',
      label: 'Unapplied effect',
      description:
        'An effect recorded against the item that the editors have not yet applied to the revised text (outstanding when it requires a text change). The same list accompanies every version of a document and describes the current revised text.',
    },
  ],
  annotation_types: ANNOTATION_TYPE_ORDER.map((letter) => ({
    key: letter,
    label: ANNOTATION_TYPES.get(letter) ?? letter,
    description: {
      F: 'Records a textual amendment (words inserted, substituted, repealed). The amended words are wrapped as [F1 …] in the text.',
      C: 'Records a modification that changes how a provision applies without changing its words.',
      I: 'Records when the provision came into force and by what instrument.',
      M: 'Marginal citation printed beside the original text.',
      E: "Records the provision's territorial extent.",
      P: 'Records a power exercised under the provision.',
      X: 'An editorial note by legislation.gov.uk.',
    }[letter] as string,
  })),
  effects: [
    { key: 'effect_id', label: 'Effect ID', description: 'Upstream identifier of the effect.' },
    {
      key: 'type',
      label: 'Effect type',
      description:
        'Free text as recorded upstream, typos included: e.g. "words substituted", "inserted", "repealed", "revoked", "applied (with modifications)", "coming into force".',
    },
    {
      key: 'applied',
      label: 'Applied',
      description:
        'Whether the editors have applied the effect to the revised text. Always false for an unapplied effect; absent when a feed omits it.',
    },
    {
      key: 'requires_applied',
      label: 'Requires applying',
      description:
        'false when the effect needs no text change (conditional, superseded, Welsh-only, text not held).',
    },
    {
      key: 'outstanding',
      label: 'Outstanding',
      description:
        'requires_applied and not applied, an unreported value counting as required and not applied: the revised text does not yet reflect it.',
    },
    {
      key: 'affected / affecting',
      label: 'Sides',
      description:
        'The item changed (affected) and the item making the change (affecting), with the provisions each names. A range such as "s. 65(2)-(4)" is one provision entry, its first provision in uri and its last in up_to.',
    },
    {
      key: 'in_force',
      label: 'In-force dates',
      description:
        'Commencement entries: a date, a qualification such as "wholly in force", or prospective when no date is set.',
    },
    {
      key: 'extent',
      label: 'Extent',
      description: 'Extent of the affecting provision, or "same as affected".',
    },
    {
      key: 'notes',
      label: 'Notes',
      description: 'Reader-facing note, usually why an effect is not applied.',
    },
    {
      key: 'coverage',
      label: 'Coverage',
      description: 'Effects are normally recorded only from amending legislation of 1994 onwards.',
    },
  ],
  provision_paths: [
    {
      key: 'section/45/2/f',
      label: 'Sections and subsections',
      description:
        'Primary legislation: section, then subsection and paragraph levels as further segments. Shorthand s. 45(2)(f) or section 45(2)(f) normalizes to it.',
    },
    { key: 'regulation/5', label: 'Regulations', description: 'Shorthand reg. 5.' },
    {
      key: 'article/28/3',
      label: 'Articles',
      description:
        'EU-origin legislation, Orders and NI Orders in Council. Shorthand art. 28(3) or Article 28(3).',
    },
    { key: 'rule/7', label: 'Rules', description: 'Shorthand r. 7.' },
    {
      key: 'schedule/2/paragraph/3/1',
      label: 'Schedules',
      description: 'Shorthand Sch. 2 para. 3(1).',
    },
    {
      key: 'part/3/chapter/2',
      label: 'Parts and Chapters',
      description:
        'Shorthand Pt. 3 Ch. 2 or Part 3 Chapter 2. EU chapters use roman numerals (chapter/IV).',
    },
    {
      key: 'introduction',
      label: 'Introduction',
      description: 'Long title, preamble and enacting text.',
    },
    { key: 'body', label: 'Body', description: 'The body without schedules.' },
    { key: 'schedules', label: 'Schedules', description: 'All schedules.' },
    {
      key: 'shorthand',
      label: 'Shorthand table',
      description:
        'Case-insensitive: s./section → section, reg. → regulation, art./Article → article, r. → rule, Sch. → schedule, para. → paragraph, Pt./Part → part, Ch./Chapter → chapter; bracketed sub-levels become segments, and a dotted number stays one value (r. 3.4 → rule/3.4). Anything else is rejected.',
    },
  ],
  citation_formats: [
    {
      key: '2018 c. 12',
      label: 'UK Act by chapter',
      description:
        'ukpga/2018/12. Before 1963 the calendar year is searched and regnal candidates are returned.',
    },
    {
      key: '2016 c. 5 (N.I.)',
      label: 'Act of the Northern Ireland Assembly',
      description: 'nia/2016/5.',
    },
    {
      key: 'S.I. 2019/419',
      label: 'UK Statutory Instrument',
      description:
        'Also SI 2019 No. 419 and S.I. 2002/808 (W. 89); alternative series numbers are ignored and upstream canonicalizes to wsi or nisi.',
    },
    {
      key: 'S.S.I. 2020/123',
      label: 'Scottish Statutory Instrument',
      description: 'ssi/2020/123.',
    },
    {
      key: 'S.R. 2020/12',
      label: 'Northern Ireland Statutory Rule',
      description: 'Also S.R. 2020 No. 12; nisr/2020/12.',
    },
    {
      key: '2020 asp 13',
      label: 'Scottish, Welsh Acts',
      description: 'Also asp 2020/13, 2016 anaw 1, 2021 asc 1, and 2010 nawm 1 (Measures, mwa).',
    },
    {
      key: 'Regulation (EU) 2016/679',
      label: 'EU-origin legislation',
      description:
        'Regulation (EU) 2016/679 → eur/2016/679; Regulation (EC) No 1535/2003 → eur/2003/1535 (pre-2015 numbering is number/year); Directive 95/46/EC → eudr/1995/46; Decision (EU) 2019/419 → eudn/2019/419. The issuing body may come first: Council, Commission, Commission Implementing, Commission Delegated, European Parliament and Council (Council Regulation (EC) No 1/2003 → eur/2003/1).',
    },
    {
      key: 'UK GDPR',
      label: 'Defined name',
      description:
        'eur/2016/679: the short name the Data Protection Act 2018 s. 3(10) defines for Regulation (EU) 2016/679 as retained in UK law.',
    },
    {
      key: 'URI',
      label: 'legislation.gov.uk URI',
      description: 'Split into item, provision and version.',
    },
    {
      key: 'provision tail',
      label: 'Provision',
      description:
        'Any form above may end with a provision: s. 45(2)(f), section 45, reg. 5, art. 28(3), r. 7, r. 3.4, Sch. 2 para. 3, Pt 3. Or it may start with one followed by "of" or "of the": section 45 of the Data Protection Act 2018.',
    },
    {
      key: 'short title',
      label: 'Short title',
      description:
        'Anything else is resolved as a short title, with its year if present (Data Protection Act 2018). A trailing UK Act chapter, as in Human Rights Act 1998 (c. 42), is left out of the title lookup and resolves the Act by number when the title does not.',
    },
  ],
  publication_log: [
    {
      key: 'legislation',
      label: 'Content type: legislation',
      description: 'A new or republished document (each format — XML, PDF — is its own event).',
    },
    {
      key: 'changes',
      label: 'Content type: changes',
      description:
        'Effects recorded against (affected) or by (affecting) an item; use direction to filter. The event carries no effect detail: uklaw_get_amendments has it.',
    },
    { key: 'draft', label: 'Content type: draft', description: 'Draft legislation.' },
    {
      key: 'associated-documents',
      label: 'Content type: associated-documents',
      description: 'Explanatory notes, impact assessments and similar.',
    },
    { key: 'events', label: 'Events', description: 'published or withdrawn.' },
    {
      key: 'category',
      label: 'Categories',
      description:
        'primary, secondary, eu-origin — valid only with content type legislation or associated-documents (elsewhere legislation.gov.uk answers zero events).',
    },
    {
      key: 'flags',
      label: 'Flags',
      description:
        'new: first appearance of the item on legislation.gov.uk; newly_issued: newly issued item; republished: a document published again.',
    },
    {
      key: 'day_walk',
      label: 'Mode: day walk',
      description:
        'Default. Walks days newest-first from end_date, 20 events per upstream page, at most 4 requests per call; continue with next_cursor.',
    },
    {
      key: 'item_log',
      label: 'Mode: item log',
      description:
        "When item is a full type/year/number: reads that item's undated log newest-first and keeps events inside the window, usually in one request. A window further back takes more calls of at most 4 requests; each reports read_back_to, the date of the oldest event read that carries a calendar date. An event not dated by a calendar date is skipped.",
    },
    {
      key: 'dates',
      label: 'Dates',
      description: "Event dates are UK local time. Today's log fills during the UK working day.",
    },
  ],
  coverage: [
    {
      key: 'primary',
      label: 'Primary legislation',
      description:
        'UK Acts back to 1267; revised text for Acts in force at the 1 February 1991 base date (Northern Ireland 1 January 2006) and later. Most primary legislation before 1988 is held as PDF only.',
    },
    {
      key: 'secondary',
      label: 'Secondary legislation',
      description: 'Older secondary legislation is often unrevised (as made) or PDF only.',
    },
    {
      key: 'eu-origin',
      label: 'EU-origin legislation',
      description: 'EU legislation as it stood at 31 December 2020 and its later UK amendments.',
    },
    {
      key: 'effects',
      label: 'Effects',
      description:
        'Recorded normally only from amending legislation of 1994 onwards; an effect not yet recorded is invisible.',
    },
    {
      key: 'pdf_only',
      label: 'PDF-only items',
      description: 'Returned as links, never fetched (robots.txt disallows PDF fetching).',
    },
    {
      key: 'case_law',
      label: 'Case law',
      description:
        "Not covered: judgments are published separately by The National Archives' Find Case Law service.",
    },
    {
      key: 'out_of_scope',
      label: 'Out of scope',
      description: 'Explanatory notes, impact assessments and the SPARQL endpoint.',
    },
  ],
  attribution: [
    { key: 'ogl', label: 'Open Government Licence', description: `Every response: "${OGL_LINE}"` },
    {
      key: 'eu',
      label: 'EU-origin content',
      description: `When an EU-origin item (eur, eudr, eudn, eut, or category euretained) appears: "${EU_LINE}"`,
    },
    {
      key: 'westlaw',
      label: 'Westlaw-contributed instruments',
      description: `When a document's publisher is Westlaw (pre-1987 SIs): "${WESTLAW_LINE}"`,
    },
  ],
};

/** The reference entries for one topic. */
export function referenceEntries(topic: ReferenceTopic): ReferenceEntry[] {
  return REFERENCE[topic];
}
