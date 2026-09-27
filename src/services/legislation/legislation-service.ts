/**
 * @fileoverview LegislationService — one method per tool, composing the URL
 * builders, the paced client, and the CLML/Atom parsers. Each call runs on its
 * own request budget; a request after the first that cannot start ends the
 * call with what it already holds.
 * @module services/legislation/legislation-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { McpError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { parseChangesFeed } from './atom/changes-feed.js';
import { type PublicationEvent, parsePublicationLog } from './atom/publication-log.js';
import { parseSearchFeed, type SearchFacets, type SearchResult } from './atom/search-feed.js';
import { buildAttribution } from './attribution.js';
import { extractTitleCandidates, normalizeTitle, type ParsedCitation } from './citations.js';
import { effectTouches, sortOutstandingFirst } from './clml/effects.js';
import { type DocumentMetadata, readMetadata } from './clml/metadata.js';
import { fragmentOutline, type OutlineEntry, tocOutline } from './clml/outline.js';
import { type Annotation, cutRendered, type RenderResult, renderNodes } from './clml/render.js';
import type { CursorPosition } from './cursor.js';
import {
  type CallBudget,
  isCannotStart,
  type LegislationClient,
  type UpstreamResult,
} from './legislation-client.js';
import {
  isCalendarDate,
  isEnactedKeyword,
  parseItemInput,
  provisionLabel,
  versionSegment,
} from './provision-path.js';
import { typeByCode, typeLabel } from './reference-data.js';
import type { EffectRecord, ItemPath } from './types.js';
import {
  changesUrl,
  contentsUrl,
  documentPath,
  documentUrl,
  idTitleUrl,
  idUrl,
  numberLookupUrl,
  ORIGIN,
  type SearchUrlInput,
  searchUrl,
  updateUrl,
} from './urls.js';
import {
  attr,
  child,
  elements,
  findPath,
  legislationPath,
  parseXml,
  textOf,
  toHttps,
  type XmlElement,
} from './xml.js';

/** A fragment whose rendered size (`RenderResult.chars`) exceeds this returns an outline instead. */
export const TEXT_BUDGET_CHARS = 20_000;
/** A fragment over budget with no smaller child provisions is cut to this rendered size. */
export const TEXT_CEILING_CHARS = 2 * TEXT_BUDGET_CHARS;
/** Item-level reads fetch the whole item only when its contents list at most this many leaf provisions. */
export const WHOLE_ITEM_MAX_LEAVES = 25;
const OUTLINE_MAX = 100;
/** Unapplied effects listed on a read, at item or provision level; a notice counts the rest (Design Decision 73). */
const EFFECTS_LISTED_MAX = 20;
/** Changes-feed page size a provision scan reads; a scan cursor's offset lies below it. */
export const SCAN_PAGE_SIZE = 500;
/** Publication Log page size, fixed upstream; a track cursor's offset lies below it. */
export const LOG_PAGE_SIZE = 20;
const SCAN_MAX_PAGES = 3;
const LOG_MAX_REQUESTS = 4;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** The UK calendar date, read by parts: the order and separators of a formatted date vary by ICU version. */
const UK_DATE = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
/** An `/id` redirect to `…/contents/made` (or enacted, …) marks an item held only as its original text. */
const ORIGINAL_ONLY = /\/contents\/(made|enacted|adopted|created)(?:\/|$)/;
const SIMPLIFIED_TABLE_NOTICE =
  'Tables with merged cells were simplified; the XML link carries the exact layout.';

// ─── search ───────────────────────────────────────────────────────────────

/** Outcome of a search call. */
export interface SearchOutcome {
  attribution: string[];
  facets?: SearchFacets;
  hasMore: boolean;
  results: SearchResult[];
  total?: number;
}

// ─── get_document ─────────────────────────────────────────────────────────

/** Document request, inputs already validated and normalized. */
export interface DocumentQuery {
  /** The date asked for when an item held only as original text is re-read at its enacted keyword. */
  asOf?: string;
  item: ItemPath;
  language: 'en' | 'cy';
  matchText?: string;
  /** Index of the first outline entry to return when the read answers with an outline. */
  outlineOffset: number;
  provision?: string;
  /** `current`, an enacted keyword, or a calendar date. */
  version: string;
}

/** The found arm of a document read, shaped as the tool's output. */
export interface DocumentOutput {
  annotations?: Annotation[];
  attribution: string[];
  editorial: {
    caveat: string;
    document_status: string;
    modified?: string;
    outstanding_effects: number;
    publisher: string[];
  };
  item: {
    category?: string;
    /** Root `RestrictExtent`: the item's extent at the version served. */
    extent?: string;
    id_uri: string;
    number?: string;
    path: string;
    title: string;
    title_cy?: string;
    type: string;
    type_label: string;
    year?: number;
  };
  kind: 'full' | 'outline' | 'pdf_only';
  language: string;
  links: { akn?: string; pdf?: string; web: string; xml: string };
  outline?: OutlineEntry[];
  outline_notice?: string;
  provision?: {
    extent?: string;
    heading?: string;
    id_uri: string;
    label: string;
    path: string;
    status?: string;
    valid_from?: string;
    valid_to?: string;
  };
  text?: string;
  /** Absent on an item-level outline, which carries a count notice instead (Design Decision 58). */
  unapplied_effects?: EffectRecord[];
  version: {
    applied: string;
    available: string[];
    document_uri: string;
    requested: string;
    /** Root `RestrictEndDate`: when the item version served was superseded. */
    valid_to?: string;
  };
}

/** Outcome of a document read. */
export type DocumentOutcome =
  | { kind: 'found'; notices: string[]; output: DocumentOutput }
  | {
      kind: 'not_found';
      /** False when the item-existence check could not run within the call's budget. */
      checkRan: boolean;
      which: 'document' | 'provision' | 'version';
    };

// ─── get_amendments ───────────────────────────────────────────────────────

/** Amendments request, inputs already validated. */
export interface AmendmentsQuery {
  counterpart?: string;
  direction: 'affected' | 'affecting';
  item: ItemPath;
  limit: number;
  position: CursorPosition;
  provision?: string;
  status: 'all' | 'applied' | 'unapplied';
}

/** Outcome of an amendments call. */
export interface AmendmentsOutcome {
  attribution: string[];
  /** True when the page or provision scan filled `limit` with more of the feed left to read. */
  capped: boolean;
  effects: EffectRecord[];
  hasMore: boolean;
  next?: CursorPosition;
  /** Present on provision scans. */
  scan?: { effects_scanned: number; pages_scanned: number; total_effects: number };
  /** True when a provision scan stopped before the end of the feed without reaching `limit`. */
  stoppedEarly: boolean;
  total: number;
}

// ─── track_changes ────────────────────────────────────────────────────────

/** Publication Log request, inputs already validated. */
export interface TrackQuery {
  category?: string;
  contentType?: string;
  direction?: string;
  endDate: string;
  event?: string;
  item?: ItemPath;
  limit: number;
  newOnly: boolean;
  position?: CursorPosition;
  startDate: string;
}

/** Outcome of a Publication Log call. */
export interface TrackOutcome {
  attribution: string[];
  /** True when `limit` events were collected with more remaining. */
  capped: boolean;
  days: { date: string; pages_read: number; total?: number }[];
  events: PublicationEvent[];
  hasMore: boolean;
  itemLogTotal?: number;
  mode: 'day_walk' | 'item_log';
  next?: CursorPosition;
  /** Item-log mode: date of the oldest log event this call examined, in or out of the window (Design Decision 68). */
  readBackTo?: string;
}

// ─── lookup_citation ──────────────────────────────────────────────────────

/** Outcome of a citation lookup, shaped as the tool's output minus `parsed`. */
export interface LookupOutcome {
  attribution: string[];
  candidates?: { id_uri: string; item: string; title: string }[];
  document_uri?: string;
  found: boolean;
  guidance?: string;
  id_uri?: string;
  item?: string;
  made_date?: string;
  number?: string;
  provision_found?: boolean;
  provision_path?: string;
  provision_uri?: string;
  title?: string;
  title_cy?: string;
  type?: string;
  type_label?: string;
  year?: number;
}

/** Constructor dependencies. */
export interface LegislationServiceOptions {
  client: LegislationClient;
  now?: () => number;
}

function idUriFor(path: string): string {
  return `${ORIGIN}/id/${path}`;
}

function dayBefore(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * A Publication Log event's date, only when its `updated` starts with a
 * calendar date: the item log places no other in the window and quotes no
 * other as read_back_to (Design Decisions 74 and 76).
 */
function calendarDateOf(event: PublicationEvent): string | undefined {
  const date = event.updated.slice(0, 10);
  return isCalendarDate(date) ? date : undefined;
}

/** The document body container (`Primary`, `Secondary`, `EURetained`, …). */
function bodyRoot(root: XmlElement): XmlElement | undefined {
  return elements(root).find(
    (el) =>
      !['ukm:Metadata', 'Contents', 'Commentaries', 'Resources', 'Footnotes'].includes(el.name),
  );
}

/**
 * Builds the fixed caveat sentence for a document's editorial status. `listed`
 * is false when the output omits `unapplied_effects` (an item outline), so the
 * sentence points at the count and uklaw_get_amendments instead.
 */
function caveatFor(
  status: string | undefined,
  outstanding: number,
  version: string,
  scope: 'provision' | 'item',
  listed: boolean,
): string {
  const historical =
    version !== 'current'
      ? ` ${listed ? 'unapplied_effects describes' : 'editorial.outstanding_effects counts'} the outstanding work on the current revised text, not the history of the version shown.`
      : '';
  if (status === 'revised') {
    const count =
      outstanding === 0
        ? `No outstanding effects are recorded against this ${scope}.`
        : `${outstanding} outstanding effect${outstanding === 1 ? ' is' : 's are'} recorded against this ${scope} but not yet applied (${listed ? 'see unapplied_effects' : 'uklaw_get_amendments lists them'}).`;
    return `Revised text: an editorial consolidation by legislation.gov.uk that can lag behind amendments; it is not the authoritative text. ${count}${historical}`;
  }
  if (status === 'final') {
    const read =
      version === 'current'
        ? `No revised version is held for this document, so the original text is served; check ${listed ? 'unapplied_effects and ' : ''}uklaw_get_amendments for changes made since.`
        : 'Read version current for the revised text.';
    return `Original text as enacted or made: later amendments are not reflected. ${read}${historical}`;
  }
  if (status === 'draft') return `Draft legislation: not made law.${historical}`;
  return `legislation.gov.uk did not report an editorial status for this document; treat the text as unverified.${historical}`;
}

/**
 * Places an outline window in the whole outline (Design Decision 59):
 * `pastEnd` when the window lists nothing of a non-empty outline, else a
 * `notice` whenever it is not the whole outline, naming the offset that
 * continues it. `count` opens the notice, e.g. "The outline has 305 entries".
 */
function placeWindow(
  offset: number,
  listed: number,
  total: number,
  count: string,
): { notice?: string; pastEnd?: string } {
  if (listed === total) return {};
  if (listed === 0) {
    return {
      pastEnd: `outline_offset ${offset} is past the end of this outline, which has ${total} entries; call again with a lower outline_offset.`,
    };
  }
  const next = offset + listed;
  const more =
    next < total
      ? ` Call again with outline_offset ${next} for the next ${Math.min(total - next, OUTLINE_MAX)}.`
      : '';
  return { notice: `${count}; entries ${offset + 1}–${next} are listed.${more}` };
}

/** Composes the tool calls into upstream requests. */
export class LegislationService {
  private readonly client: LegislationClient;
  private readonly now: () => number;

  constructor(options: LegislationServiceOptions) {
    this.client = options.client;
    this.now = options.now ?? Date.now;
  }

  /**
   * Today's UK date (Europe/London), YYYY-MM-DD: the Publication Log dates
   * events in UK local time, so a UTC date runs a day behind from midnight to
   * 01:00 BST (Design Decision 65).
   */
  today(): string {
    const { year, month, day } = Object.fromEntries(
      UK_DATE.formatToParts(this.now()).map((part) => [part.type, part.value]),
    );
    return `${year}-${month}-${day}`;
  }

  /** Runs a request after the first; undefined when it cannot start. */
  private async later<T>(run: () => Promise<T>): Promise<T | undefined> {
    try {
      return await run();
    } catch (error) {
      if (isCannotStart(error)) return;
      throw error;
    }
  }

  private body(result: UpstreamResult, what: string): string {
    if (result.kind !== 'ok') {
      throw serviceUnavailable(`legislation.gov.uk returned no ${what} (${result.kind}).`);
    }
    return result.body;
  }

  // ─── search ──────────────────────────────────────────────────────────

  async search(query: SearchUrlInput, ctx: Context): Promise<SearchOutcome> {
    const budget = this.client.budget(2);
    const result = await this.client.get(searchUrl(query), 'feed', budget, ctx);
    /** A page past the end fetched no feed, so it has no facet counts to report. */
    if (result.kind === 'past_end') {
      return { results: [], hasMore: false, attribution: buildAttribution() };
    }
    const feed = parseSearchFeed(this.body(result, 'search feed'));
    ctx.log.debug('Search feed parsed', { results: feed.results.length, hasMore: feed.hasMore });
    return {
      results: feed.results,
      hasMore: feed.hasMore,
      ...(feed.total !== undefined ? { total: feed.total } : {}),
      ...(!query.text ? { facets: feed.facets } : {}),
      attribution: buildAttribution({ types: feed.results.map((r) => r.type) }),
    };
  }

  // ─── get_document ────────────────────────────────────────────────────

  /**
   * Checks an item exists via `/id/{item}`; undefined when the check cannot start.
   * `original` is the enacted keyword of an item held only as its original text.
   */
  private async itemExists(
    item: string,
    budget: CallBudget,
    ctx: Context,
  ): Promise<{ exists: boolean; original?: string } | undefined> {
    const result = await this.later(() => this.client.get(idUrl(item), 'identifier', budget, ctx));
    if (!result) return;
    const original =
      result.kind === 'redirect' ? ORIGINAL_ONLY.exec(result.location)?.[1] : undefined;
    return { exists: result.kind !== 'not_found', ...(original ? { original } : {}) };
  }

  /**
   * After a 404: a dated read of an item held only as its original text is
   * re-read at that text's keyword on the same budget (a re-read that cannot
   * start sheds, since the call holds nothing yet); otherwise the `/id` check
   * tells a missing item from a missing provision or version.
   */
  private async afterNotFound(
    query: DocumentQuery,
    which: 'provision' | 'version',
    budget: CallBudget,
    ctx: Context,
  ): Promise<DocumentOutcome> {
    const check = await this.itemExists(query.item.path, budget, ctx);
    if (check?.original && ISO_DATE.test(query.version)) {
      return this.readDocument(
        { ...query, version: check.original, asOf: query.version },
        budget,
        ctx,
      );
    }
    return {
      kind: 'not_found',
      which: check?.exists ? which : 'document',
      checkRan: check !== undefined,
    };
  }

  getDocument(query: DocumentQuery, ctx: Context): Promise<DocumentOutcome> {
    return this.readDocument(query, this.client.budget(4), ctx);
  }

  private async readDocument(
    query: DocumentQuery,
    budget: CallBudget,
    ctx: Context,
  ): Promise<DocumentOutcome> {
    const version = versionSegment(query.version, query.item.type);
    const welsh = query.language === 'cy';
    const item = query.item.path;

    if (query.provision) {
      const result = await this.client.get(
        documentUrl({ item, provision: query.provision, ...(version ? { version } : {}), welsh }),
        'document',
        budget,
        ctx,
      );
      if (result.kind === 'not_found') return this.afterNotFound(query, 'provision', budget, ctx);
      return this.provisionDocument(query, parseXml(this.body(result, 'document'), 'a document'));
    }

    const contents = await this.client.get(
      contentsUrl({
        item,
        ...(version ? { version } : {}),
        welsh,
        ...(query.matchText ? { text: query.matchText } : {}),
      }),
      'document',
      budget,
      ctx,
    );
    if (contents.kind === 'not_found') {
      if (!ISO_DATE.test(query.version))
        return { kind: 'not_found', which: 'document', checkRan: true };
      return this.afterNotFound(query, 'version', budget, ctx);
    }
    const tocRoot = parseXml(this.body(contents, 'table of contents'), 'a table of contents');
    const md = readMetadata(tocRoot);
    if (query.asOf && md.madeDate && query.asOf < md.madeDate)
      return { kind: 'not_found', which: 'version', checkRan: true };
    const toc = child(tocRoot, 'Contents');
    const notices: string[] = [];

    if (!toc && md.numberOfProvisions === 0) {
      return { kind: 'found', notices, output: this.itemOutput(query, md, 'pdf_only', notices) };
    }
    const outline = toc
      ? tocOutline(
          toc,
          item,
          { offset: query.outlineOffset, max: OUTLINE_MAX },
          Boolean(query.matchText),
        )
      : { entries: [], leafCount: 0, total: 0 };

    if (!query.matchText && outline.leafCount <= WHOLE_ITEM_MAX_LEAVES) {
      /** An unrevised item's contents redirect to `/made`; fetch the whole item there directly, saving a hop. */
      const served =
        /\/contents\/(made|enacted|adopted|created|\d{4}-\d{2}-\d{2})\//.exec(
          contents.kind === 'ok' ? contents.url : '',
        )?.[1] ?? version;
      const whole = await this.later(() =>
        this.client.get(
          documentUrl({ item, ...(served ? { version: served } : {}), welsh }),
          'document',
          budget,
          ctx,
        ),
      );
      if (whole?.kind === 'ok') {
        const root = parseXml(whole.body, 'a document');
        const body = bodyRoot(root);
        const rendered = body ? renderNodes(root, [body]) : undefined;
        if (rendered && rendered.chars <= TEXT_BUDGET_CHARS) {
          if (rendered.simplifiedTable) notices.push(SIMPLIFIED_TABLE_NOTICE);
          const output = this.itemOutput(query, readMetadata(root), 'full', notices);
          return {
            kind: 'found',
            notices,
            output: { ...output, text: rendered.text, annotations: rendered.annotations },
          };
        }
        if (rendered) {
          notices.push(
            `The whole item renders to ${rendered.chars} characters, over the ${TEXT_BUDGET_CHARS}-character budget; the outline is returned instead.`,
          );
        }
      } else if (!whole) {
        notices.push(
          "The whole-item text could not be fetched within this call's request budget; the outline is returned instead.",
        );
      }
    }

    const window = placeWindow(
      query.outlineOffset,
      outline.entries.length,
      outline.total,
      query.matchText
        ? `match_text matched ${outline.total} table-of-contents entries`
        : `The outline has ${outline.total} entries`,
    );
    if (window.notice) notices.push(window.notice);
    if (query.matchText && outline.total === 0)
      notices.push(
        `No provision of ${item} matches "${query.matchText}" at this version. Try another term, or drop match_text to list the item's provisions.`,
      );
    const output = this.itemOutput(query, md, 'outline', notices);
    const example = outline.entries.find((e) => e.level === 1) ?? outline.entries[0];
    return {
      kind: 'found',
      notices,
      output: {
        ...output,
        outline: outline.entries,
        outline_notice:
          window.pastEnd ??
          (example
            ? `Read one provision with uklaw_get_document, item ${item} and provision set to a listed path — for example ${example.provision} (${example.label}).`
            : 'No provisions are listed for this item at this version.'),
      },
    };
  }

  /**
   * Assembles the item-level output (no provision). An outline omits
   * `unapplied_effects` and notes the item's count instead (Design Decision
   * 58); a full or PDF-only read lists them as `baseOutput` caps them.
   */
  private itemOutput(
    query: DocumentQuery,
    md: DocumentMetadata,
    kind: DocumentOutput['kind'],
    notices: string[],
  ): DocumentOutput {
    const sorted = sortOutstandingFirst(md.unappliedEffects);
    if (kind === 'outline' && sorted.length > 0) {
      const outstanding = sorted.filter((e) => e.outstanding).length;
      notices.push(
        `${sorted.length} unapplied effect${sorted.length === 1 ? ' is' : 's are'} recorded against this item (${outstanding} outstanding); an item outline does not list them. Call uklaw_get_amendments with item ${query.item.path} and status "unapplied" for the list.`,
      );
    }
    return this.baseOutput(query, md, kind, sorted, kind !== 'outline', notices, 'item');
  }

  /**
   * The output fields every document read shares. `effects` is the whole
   * sorted list, which `editorial.outstanding_effects` counts; when `listed`,
   * the first `EFFECTS_LISTED_MAX` become `unapplied_effects`, with a notice
   * when more exist (Design Decision 73).
   */
  private baseOutput(
    query: DocumentQuery,
    md: DocumentMetadata,
    kind: DocumentOutput['kind'],
    effects: EffectRecord[],
    listed: boolean,
    notices: string[],
    scope: 'provision' | 'item',
  ): DocumentOutput {
    const item = query.item;
    if (listed && effects.length > EFFECTS_LISTED_MAX) {
      notices.push(
        scope === 'item'
          ? `${effects.length} unapplied effects are recorded against this item; the first ${EFFECTS_LISTED_MAX} are listed. Call uklaw_get_amendments with item ${item.path} and status "unapplied" for the full list.`
          : `${effects.length} unapplied effects touch this provision, whole-item effects included; the first ${EFFECTS_LISTED_MAX} are listed. Call uklaw_get_amendments with item ${item.path}, provision ${query.provision} and status "unapplied" for the full list.`,
      );
    }
    const version = versionSegment(query.version, item.type);
    const served = legislationPath(md.identifier)?.split('/').at(-1);
    const applied =
      md.valid ??
      (served && isEnactedKeyword(served) ? served : undefined) ??
      (md.status === 'final' ? (typeByCode(item.type)?.enactedKeyword ?? 'enacted') : 'current');
    const language = md.language ?? 'en';
    if (query.language === 'cy' && language !== 'cy') {
      notices.push('Welsh text is not held for this document; the English text is returned.');
    }
    if (query.asOf) {
      const keyword = query.version;
      const when = md.madeDate
        ? `${keyword} ${md.madeDate}`
        : `its ${keyword} date is not recorded`;
      notices.push(
        `legislation.gov.uk holds no revised versions of ${item.path}, only its ${keyword} text (${when}), so that text is returned for ${query.asOf}.`,
      );
    }
    const outstanding = effects.filter((e) => e.outstanding).length;
    const web = `${ORIGIN}${documentPath({ item: item.path, ...(query.provision ? { provision: query.provision } : {}), ...(version ? { version } : {}), welsh: language === 'cy' })}`;
    const documentUri = query.provision
      ? md.identifier
      : md.identifier?.replace(/\/contents(?=\/|$)/, '');
    const number = md.number ?? item.number;
    return {
      kind,
      item: {
        path: item.path,
        id_uri: toHttps(md.idUri ?? idUriFor(item.path)),
        title: md.title,
        ...(md.titleCy ? { title_cy: md.titleCy } : {}),
        type: item.type,
        type_label: typeLabel(item.type),
        ...(md.category ? { category: md.category } : {}),
        ...(md.year !== undefined ? { year: md.year } : {}),
        ...(number ? { number } : {}),
        ...(md.restrictExtent ? { extent: md.restrictExtent } : {}),
      },
      version: {
        requested: query.asOf ?? query.version,
        applied,
        ...(md.restrictEndDate ? { valid_to: md.restrictEndDate } : {}),
        document_uri: toHttps(documentUri ?? web),
        available: [...new Set([...md.versions, applied])],
      },
      language,
      editorial: {
        document_status: md.status ?? 'unknown',
        publisher: md.publishers,
        ...(md.modified ? { modified: md.modified } : {}),
        outstanding_effects: outstanding,
        /** An original-only item's text is its current text, so it takes the current-read caveat. */
        caveat: caveatFor(
          md.status,
          outstanding,
          query.asOf ? 'current' : query.version,
          scope,
          listed,
        ),
      },
      ...(listed ? { unapplied_effects: effects.slice(0, EFFECTS_LISTED_MAX) } : {}),
      links: {
        web,
        xml: `${web}/data.xml`,
        ...(md.aknUri ? { akn: md.aknUri } : {}),
        ...(md.pdfUri ? { pdf: md.pdfUri } : {}),
      },
      attribution: buildAttribution({
        types: [item.type],
        categories: [md.category],
        publishers: md.publishers,
      }),
    };
  }

  /** Builds the provision-level output from a fetched fragment. */
  private provisionDocument(query: DocumentQuery, root: XmlElement): DocumentOutcome {
    const item = query.item.path;
    const provision = query.provision as string;
    const fullPath = `${item}/${provision}`;
    const md = readMetadata(root);
    if (query.asOf && md.madeDate && query.asOf < md.madeDate)
      return { kind: 'not_found', which: 'provision', checkRan: true };
    const notices: string[] = [];
    const body = bodyRoot(root);
    const path = body
      ? findPath(body, (el) => legislationPath(attr(el, 'IdURI')) === fullPath)
      : undefined;
    const target = path?.at(-1) ?? body;
    const ancestors = [root, ...(body ? [body] : []), ...(path?.slice(0, -1) ?? [])];
    const parent = ancestors.at(-1);
    const grouped =
      target?.name === 'P1' &&
      parent?.name === 'P1group' &&
      elements(parent).filter((c) => attr(c, 'DocumentURI')).length === 1;
    const renderAs = grouped ? (parent as XmlElement) : target;
    const nearest = [target, ...ancestors.toReversed()];
    const inherited = (name: string): string | undefined =>
      nearest.map((el) => attr(el, name)).find((v) => v !== undefined);
    /** Both window ends come from one element: mixing elements yields a window no element records. */
    const windowed = nearest.find(
      (el) => attr(el, 'RestrictStartDate') ?? attr(el, 'RestrictEndDate'),
    );
    let validFrom = attr(windowed, 'RestrictStartDate');
    let validTo = attr(windowed, 'RestrictEndDate');
    /** The notice quotes both ends, so it is raised only over calendar dates (Design Decision 74). */
    if (
      validFrom &&
      validTo &&
      isCalendarDate(validFrom) &&
      isCalendarDate(validTo) &&
      validTo < validFrom
    ) {
      notices.push(
        `legislation.gov.uk records this provision's text window as ${validFrom} to ${validTo}, which ends before it starts; valid_from and valid_to are omitted.`,
      );
      validFrom = validTo = undefined;
    }

    const touching = sortOutstandingFirst(
      md.unappliedEffects.filter((e) => effectTouches(e, 'affected', fullPath)),
    );
    const base = this.baseOutput(query, md, 'full', touching, true, notices, 'provision');
    const heading = textOf(
      (target?.name === 'P1' && parent?.name === 'P1group' ? child(parent, 'Title') : undefined) ??
        child(target, 'Title') ??
        child(child(target, 'TitleBlock'), 'Title'),
    );
    const status = attr(target, 'Status') ?? (grouped ? attr(parent, 'Status') : undefined);
    const extent = inherited('RestrictExtent');
    const output: DocumentOutput = {
      ...base,
      provision: {
        path: provision,
        id_uri: idUriFor(fullPath),
        label: provisionLabel(provision),
        ...(heading ? { heading } : {}),
        ...(status ? { status } : {}),
        ...(extent ? { extent } : {}),
        ...(validFrom ? { valid_from: validFrom } : {}),
        ...(validTo ? { valid_to: validTo } : {}),
      },
    };
    if (!renderAs)
      return { kind: 'found', notices, output: { ...output, text: '', annotations: [] } };

    const rendered = renderNodes(root, [renderAs]);
    let returned: RenderResult = rendered;
    if (rendered.chars > TEXT_BUDGET_CHARS && target) {
      const outline = fragmentOutline(root, target, item, {
        offset: query.outlineOffset,
        max: OUTLINE_MAX,
      });
      if (outline.total > 0) {
        const window = placeWindow(
          query.outlineOffset,
          outline.entries.length,
          outline.total,
          `The outline has ${outline.total} entries`,
        );
        if (window.notice) notices.push(window.notice);
        const fits =
          outline.entries.find((e) => (e.chars ?? 0) <= TEXT_BUDGET_CHARS) ?? outline.entries[0];
        const over = `${provisionLabel(provision)} renders to ${rendered.chars} characters, over the ${TEXT_BUDGET_CHARS}-character budget.`;
        return {
          kind: 'found',
          notices,
          output: {
            ...output,
            kind: 'outline',
            outline: outline.entries,
            outline_notice: `${over} ${window.pastEnd ?? `Re-call uklaw_get_document with a narrower provision from the outline — for example ${fits?.provision} (${fits?.chars} characters).`}`,
          },
        };
      }
      const leafless = `This provision renders to ${rendered.chars} characters and has no smaller child provisions`;
      if (rendered.chars > TEXT_CEILING_CHARS) {
        returned = cutRendered(rendered, TEXT_CEILING_CHARS);
        notices.push(
          `${leafless}, so its text is cut to ${returned.chars} characters to fit the ${TEXT_CEILING_CHARS}-character ceiling, keeping only the annotations that text references. The full text is at ${output.links.web}, and its XML at ${output.links.xml}.`,
        );
      } else {
        notices.push(
          `${leafless}; that is within the ${TEXT_CEILING_CHARS}-character ceiling, so the full text is returned.`,
        );
      }
    }
    if (rendered.simplifiedTable) notices.push(SIMPLIFIED_TABLE_NOTICE);
    return {
      kind: 'found',
      notices,
      output: { ...output, text: returned.text, annotations: returned.annotations },
    };
  }

  // ─── get_amendments ──────────────────────────────────────────────────

  async getAmendments(query: AmendmentsQuery, ctx: Context): Promise<AmendmentsOutcome> {
    const budget = this.client.budget(SCAN_MAX_PAGES);
    const base = {
      item: query.item.path,
      direction: query.direction,
      status: query.status,
      ...(query.counterpart ? { counterpart: query.counterpart } : {}),
    };
    const attributionOf = (effects: EffectRecord[]) =>
      buildAttribution({
        types: [
          query.item.type,
          ...effects.flatMap((e) =>
            [e.affected.item, e.affecting.item].map((p) => p?.split('/')[0]),
          ),
        ],
      });

    if (!query.provision) {
      const result = await this.client.get(
        changesUrl({ ...base, limit: query.limit, page: query.position.page }),
        'feed',
        budget,
        ctx,
      );
      const feed = result.kind === 'ok' ? parseChangesFeed(result.body) : undefined;
      const total = feed ? feed.total : 0;
      if (total === undefined)
        throw serviceUnavailable('legislation.gov.uk returned a changes feed without a total.');
      const hasMore = feed?.hasMore ?? false;
      const effects = feed?.effects ?? [];
      return {
        effects,
        total,
        hasMore,
        ...(hasMore ? { next: { page: query.position.page + 1, offset: 0 } } : {}),
        capped: hasMore,
        stoppedEarly: false,
        attribution: attributionOf(effects),
      };
    }

    const fullPath = `${query.item.path}/${query.provision}`;
    const matches: EffectRecord[] = [];
    let page = query.position.page;
    let offset = query.position.offset;
    let scanned = 0;
    let pagesScanned = 0;
    let total = 0;
    let next: CursorPosition | undefined;
    let capped = false;
    let stoppedEarly = false;
    for (let i = 0; i < SCAN_MAX_PAGES; i += 1) {
      const url = changesUrl({ ...base, limit: SCAN_PAGE_SIZE, page });
      const run = () => this.client.get(url, 'feed', budget, ctx);
      const result = i === 0 ? await run() : await this.later(run);
      if (!result) {
        next = { page, offset };
        stoppedEarly = true;
        break;
      }
      if (result.kind !== 'ok') {
        next = undefined;
        break;
      }
      const feed = parseChangesFeed(result.body);
      if (feed.total === undefined)
        throw serviceUnavailable('legislation.gov.uk returned a changes feed without a total.');
      total = feed.total;
      pagesScanned += 1;
      let stopAt: number | undefined;
      for (let idx = offset; idx < feed.effects.length; idx += 1) {
        const effect = feed.effects[idx] as EffectRecord;
        scanned += 1;
        if (effectTouches(effect, query.direction, fullPath)) matches.push(effect);
        if (matches.length >= query.limit) {
          stopAt = idx + 1;
          break;
        }
      }
      if (stopAt !== undefined) {
        if (stopAt < feed.effects.length) next = { page, offset: stopAt };
        else if (feed.hasMore) next = { page: page + 1, offset: 0 };
        else next = undefined;
        capped = next !== undefined;
        break;
      }
      offset = 0;
      if (!feed.hasMore) {
        next = undefined;
        break;
      }
      page += 1;
      next = { page, offset: 0 };
      if (i === SCAN_MAX_PAGES - 1) stoppedEarly = true;
    }
    return {
      effects: matches,
      total,
      hasMore: next !== undefined,
      ...(next ? { next } : {}),
      scan: { effects_scanned: scanned, pages_scanned: pagesScanned, total_effects: total },
      capped,
      stoppedEarly,
      attribution: attributionOf(matches),
    };
  }

  // ─── track_changes ───────────────────────────────────────────────────

  async trackChanges(query: TrackQuery, ctx: Context): Promise<TrackOutcome> {
    // The log holds no events dated after today's UK date, so no request reads one (Decision 65).
    const today = this.today();
    if (query.startDate > today) {
      return {
        mode: query.item?.full ? 'item_log' : 'day_walk',
        events: [],
        days: [],
        hasMore: false,
        capped: false,
        attribution: buildAttribution(),
      };
    }
    const budget = this.client.budget(LOG_MAX_REQUESTS);
    const filters = {
      ...(query.contentType ? { contentType: query.contentType } : {}),
      ...(query.direction ? { direction: query.direction } : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(query.event ? { event: query.event } : {}),
      newOnly: query.newOnly,
    };
    const events: PublicationEvent[] = [];
    const attributionOf = () =>
      buildAttribution({
        types: events.map((e) => e.type),
        categories: events.map((e) => e.category),
      });

    const logItem = query.item?.full ? query.item.path : undefined;
    if (logItem) {
      let page = query.position?.page ?? 1;
      let offset = query.position?.offset ?? 0;
      let next: CursorPosition | undefined;
      let itemLogTotal: number | undefined;
      let readBackTo: string | undefined;
      let capped = false;
      for (let i = 0; i < LOG_MAX_REQUESTS; i += 1) {
        const run = () =>
          this.client.get(updateUrl({ ...filters, item: logItem, page }), 'feed', budget, ctx);
        const result = i === 0 ? await run() : await this.later(run);
        if (!result) {
          next = { page, offset };
          break;
        }
        if (result.kind !== 'ok') {
          next = undefined;
          break;
        }
        const feed = parsePublicationLog(result.body);
        itemLogTotal = feed.total;
        let done = false;
        let stopAt: number | undefined;
        for (let idx = offset; idx < feed.events.length; idx += 1) {
          const event = feed.events[idx] as PublicationEvent;
          const date = calendarDateOf(event);
          if (date === undefined) continue;
          if (readBackTo === undefined || date < readBackTo) readBackTo = date;
          if (date > query.endDate) continue;
          if (date < query.startDate) {
            done = true;
            break;
          }
          events.push(event);
          if (events.length >= query.limit) {
            stopAt = idx + 1;
            break;
          }
        }
        offset = 0;
        if (stopAt !== undefined) {
          // The log is newest-first: an older event left on the page ends the window there.
          const rest = feed.events.slice(stopAt);
          const moreOnPage = rest.some((e) => {
            const date = calendarDateOf(e);
            return date !== undefined && date >= query.startDate;
          });
          next = moreOnPage
            ? { page, offset: stopAt }
            : rest.length === 0 && feed.hasMore
              ? { page: page + 1, offset: 0 }
              : undefined;
          capped = next !== undefined;
          break;
        }
        if (done || !feed.hasMore) {
          next = undefined;
          break;
        }
        page += 1;
        next = { page, offset: 0 };
      }
      return {
        mode: 'item_log',
        events,
        days: [],
        ...(itemLogTotal !== undefined ? { itemLogTotal } : {}),
        ...(readBackTo !== undefined ? { readBackTo } : {}),
        hasMore: next !== undefined,
        ...(next ? { next } : {}),
        capped,
        attribution: attributionOf(),
      };
    }

    const days = new Map<string, { date: string; pages_read: number; total?: number }>();
    let date = query.position?.date ?? (query.endDate < today ? query.endDate : today);
    let page = query.position?.page ?? 1;
    let offset = query.position?.offset ?? 0;
    let next: CursorPosition | undefined;
    let capped = false;
    for (let i = 0; ; i += 1) {
      if (date < query.startDate) {
        next = undefined;
        break;
      }
      if (i >= LOG_MAX_REQUESTS) {
        next = { date, page, offset };
        break;
      }
      const url = updateUrl({
        ...filters,
        date,
        ...(query.item ? { item: query.item.path } : {}),
        page,
      });
      const run = () => this.client.get(url, 'feed', budget, ctx);
      const result = i === 0 ? await run() : await this.later(run);
      if (!result) {
        next = { date, page, offset };
        break;
      }
      const feed = result.kind === 'ok' ? parsePublicationLog(result.body) : undefined;
      const day = days.get(date) ?? {
        date,
        pages_read: 0,
        ...(feed?.total !== undefined ? { total: feed.total } : {}),
      };
      day.pages_read += 1;
      days.set(date, day);
      const pageEvents = feed?.events ?? [];
      let stopAt: number | undefined;
      for (let idx = offset; idx < pageEvents.length; idx += 1) {
        events.push(pageEvents[idx] as PublicationEvent);
        if (events.length >= query.limit) {
          stopAt = idx + 1;
          break;
        }
      }
      offset = 0;
      const moreToday = feed?.hasMore ?? false;
      if (stopAt !== undefined) {
        if (stopAt < pageEvents.length) next = { date, page, offset: stopAt };
        else if (moreToday) next = { date, page: page + 1, offset: 0 };
        else
          next =
            dayBefore(date) >= query.startDate
              ? { date: dayBefore(date), page: 1, offset: 0 }
              : undefined;
        capped = next !== undefined;
        break;
      }
      if (moreToday) page += 1;
      else {
        date = dayBefore(date);
        page = 1;
      }
    }
    return {
      mode: 'day_walk',
      events,
      days: [...days.values()],
      hasMore: next !== undefined,
      ...(next ? { next } : {}),
      capped,
      attribution: attributionOf(),
    };
  }

  // ─── lookup_citation ─────────────────────────────────────────────────

  /**
   * Resolves a numbered item through the listing feed: its entries for that
   * number. A feed the listing path refuses (a five-digit year, say) is a miss,
   * since a lookup reports misses as results.
   */
  private async numberEntries(
    type: string,
    year: string | number,
    number: string,
    budget: CallBudget,
    ctx: Context,
    first: boolean,
  ): Promise<SearchResult[] | undefined> {
    const run = () => this.client.get(numberLookupUrl(type, year, number), 'feed', budget, ctx);
    let result: UpstreamResult | undefined;
    try {
      result = first ? await run() : await this.later(run);
    } catch (error) {
      if (error instanceof McpError && error.data?.reason === 'filter_refused') return [];
      throw error;
    }
    if (!result) return;
    if (result.kind !== 'ok') return [];
    return parseSearchFeed(result.body).results;
  }

  private foundFields(entry: SearchResult): LookupOutcome {
    return {
      found: true,
      item: entry.item,
      id_uri: entry.id_uri,
      document_uri: `${ORIGIN}/${entry.item}`,
      title: entry.title,
      ...(entry.title_cy ? { title_cy: entry.title_cy } : {}),
      type: entry.type,
      type_label: entry.type_label,
      ...(entry.year !== undefined ? { year: entry.year } : {}),
      ...(entry.number ? { number: entry.number } : {}),
      ...(entry.made_date ? { made_date: entry.made_date } : {}),
      attribution: [],
    };
  }

  private pathFields(item: ItemPath, title?: string): LookupOutcome {
    const year = Number(item.year);
    return {
      found: true,
      item: item.path,
      id_uri: idUriFor(item.path),
      document_uri: `${ORIGIN}/${item.path}`,
      ...(title ? { title } : {}),
      type: item.type,
      type_label: typeLabel(item.type),
      ...(Number.isInteger(year) ? { year } : {}),
      ...(item.number ? { number: item.number } : {}),
      attribution: [],
    };
  }

  /** Hydrates a resolved item with its listing entry; path-only fields when hydration cannot run. */
  private async hydrate(
    item: ItemPath,
    title: string | undefined,
    budget: CallBudget,
    ctx: Context,
  ): Promise<{ outcome: LookupOutcome; hydrated: boolean }> {
    if (item.regnal || !item.year || !item.number)
      return { outcome: this.pathFields(item, title), hydrated: true };
    const entries = await this.numberEntries(item.type, item.year, item.number, budget, ctx, false);
    if (!entries) return { outcome: this.pathFields(item, title), hydrated: false };
    const match =
      entries.find((e) => e.item === item.path) ?? (entries.length === 1 ? entries[0] : undefined);
    return {
      outcome: match ? this.foundFields(match) : this.pathFields(item, title),
      hydrated: true,
    };
  }

  async lookupCitation(parsed: ParsedCitation, ctx: Context): Promise<LookupOutcome> {
    const budget = this.client.budget(4);
    const miss = (guidance: string, candidates?: LookupOutcome['candidates']): LookupOutcome => ({
      found: false,
      guidance,
      ...(candidates ? { candidates } : {}),
      attribution: buildAttribution(
        candidates ? { types: candidates.map((c) => c.item.split('/')[0]) } : {},
      ),
    });

    if (parsed.kind === 'unparsed') {
      return miss(
        'Could not read this as a citation. Accepted forms: 2018 c. 12, S.I. 2019/419, S.S.I. 2020/123, S.R. 2020/12, 2020 asp 13, Regulation (EU) 2016/679, a legislation.gov.uk URI, or a short title such as Data Protection Act 2018 — each optionally followed by a provision such as s. 45(2)(f). uklaw_list_reference topic citation_formats lists every form.',
      );
    }

    let outcome: LookupOutcome;
    let hydrationSkipped = false;
    let foundByChapter: string | undefined;
    if (parsed.kind === 'numbered' || (parsed.kind === 'uri' && !parsed.item.regnal)) {
      const [type, year, number] =
        parsed.kind === 'numbered'
          ? [parsed.type, String(parsed.year), parsed.number]
          : [parsed.item.type, parsed.item.year as string, parsed.item.number as string];
      const entries = (await this.numberEntries(type, year, number, budget, ctx, true)) ?? [];
      const exact =
        parsed.kind === 'uri' ? entries.find((e) => e.item === parsed.item.path) : undefined;
      if (exact || entries.length === 1) {
        outcome = this.foundFields((exact ?? entries[0]) as SearchResult);
      } else if (entries.length > 1) {
        return miss(
          `${entries.length} items carry this number; pick one and call uklaw_get_document with its item path.`,
          entries.slice(0, 20).map((e) => ({ item: e.item, id_uri: e.id_uri, title: e.title })),
        );
      } else {
        return miss(
          `No ${typeLabel(type)} item is numbered ${year}/${number}. Check the year and the series (c., S.I., S.S.I., S.R.), or search by title with uklaw_search_legislation.`,
        );
      }
    } else if (parsed.kind === 'uri') {
      const result = await this.client.get(idUrl(parsed.item.path), 'identifier', budget, ctx);
      if (result.kind === 'not_found') {
        return miss(
          `legislation.gov.uk holds no item at ${parsed.item.path}. Check the path, or search by title with uklaw_search_legislation.`,
        );
      }
      if (result.kind === 'multiple') {
        const candidates = extractTitleCandidates(result.body).map((c) => ({
          item: c.item,
          id_uri: idUriFor(c.item),
          title: c.title,
        }));
        return miss(
          `${candidates.length} items match this path; pick one and call uklaw_get_document with its item path.`,
          candidates,
        );
      }
      outcome = this.pathFields(parsed.item);
    } else {
      const result = await this.client.get(idTitleUrl(parsed.title), 'identifier', budget, ctx);
      const wanted = normalizeTitle(parsed.title);
      let resolved: { item: ItemPath; title?: string } | undefined;
      let titleMiss: { candidates?: LookupOutcome['candidates']; guidance: string } | undefined;
      if (result.kind === 'not_found') {
        titleMiss = {
          guidance: `No item has the short title "${parsed.title}". Call uklaw_search_legislation with title set to its distinctive words.`,
        };
      } else if (result.kind === 'multiple') {
        const candidates = extractTitleCandidates(result.body);
        const exact = candidates.filter((c) => normalizeTitle(c.title) === wanted);
        const only = exact.length === 1 ? exact[0] : undefined;
        const item = only ? parseItemInput(only.item)?.item : undefined;
        if (only && item) {
          resolved = { item, title: only.title };
        } else {
          titleMiss = {
            guidance: `${candidates.length} items match "${parsed.title}"; pick one and call uklaw_get_document with its item path.`,
            candidates: candidates.map((c) => ({
              item: c.item,
              id_uri: idUriFor(c.item),
              title: c.title,
            })),
          };
        }
      } else if (result.kind === 'redirect') {
        const item = parseItemInput(result.location)?.item;
        if (item?.full) resolved = { item };
      }
      if (resolved) {
        const hydrated = await this.hydrate(resolved.item, resolved.title, budget, ctx);
        outcome = hydrated.outcome;
        hydrationSkipped = !hydrated.hydrated;
      } else {
        titleMiss ??= {
          guidance: `legislation.gov.uk could not resolve "${parsed.title}". Call uklaw_search_legislation with title set to its distinctive words.`,
        };
        /**
         * A trailing `(c. N)` names the Act outright once the year is known, so
         * a title that does not resolve is retried by chapter number, and a
         * pre-1963 chapter shared across sessions is settled by the title.
         */
        if (!parsed.chapter || parsed.year === undefined) {
          return miss(titleMiss.guidance, titleMiss.candidates);
        }
        const chapter = `${parsed.year} c. ${parsed.chapter}`;
        const entries = await this.numberEntries(
          'ukpga',
          parsed.year,
          parsed.chapter,
          budget,
          ctx,
          false,
        );
        if (!entries) {
          return miss(
            `${titleMiss.guidance} The chapter number was not tried within this call's request budget; call uklaw_lookup_citation with "${chapter}".`,
            titleMiss.candidates,
          );
        }
        const titled = entries.filter((e) => normalizeTitle(e.title) === wanted);
        const match =
          entries.length === 1 ? entries[0] : titled.length === 1 ? titled[0] : undefined;
        if (!match) {
          if (entries.length === 0) {
            return miss(
              `${titleMiss.guidance} No ${typeLabel('ukpga')} item is numbered ${parsed.year}/${parsed.chapter} either.`,
              titleMiss.candidates,
            );
          }
          return miss(
            `"${parsed.title}" did not resolve as a short title, and ${entries.length} items carry this number (${chapter}); pick one and call uklaw_get_document with its item path.`,
            entries.slice(0, 20).map((e) => ({ item: e.item, id_uri: e.id_uri, title: e.title })),
          );
        }
        outcome = this.foundFields(match);
        foundByChapter = `"${parsed.title}" did not resolve as a short title; the item was found by its chapter number, ${chapter}.`;
      }
    }

    const guidance: string[] = foundByChapter ? [foundByChapter] : [];
    if (hydrationSkipped) {
      guidance.push(
        `Title and dates were not fetched within this call's request budget; uklaw_get_document with item ${outcome.item} returns them.`,
      );
    }
    const provision = parsed.provision;
    if (provision && outcome.item) {
      const itemPath = outcome.item;
      outcome.provision_path = provision;
      outcome.provision_uri = idUriFor(`${itemPath}/${provision}`);
      const check = await this.later(() =>
        this.client.get(documentUrl({ item: itemPath, provision }), 'document', budget, ctx),
      );
      if (!check) {
        guidance.push(
          `The provision was not verified within this call's request budget; call uklaw_get_document with item ${itemPath} and provision ${provision} to read it.`,
        );
      } else {
        outcome.provision_found = check.kind === 'ok';
        if (!outcome.provision_found) {
          guidance.push(
            `${itemPath} has no provision at ${provision} in its current version. Call uklaw_get_document with item ${itemPath} and no provision to list its provision paths.`,
          );
        }
      }
    }
    return {
      ...outcome,
      ...(guidance.length > 0 ? { guidance: guidance.join(' ') } : {}),
      attribution: buildAttribution({ types: [outcome.type] }),
    };
  }
}

// ─── init/accessor ─────────────────────────────────────────────────────────

let _service: LegislationService | undefined;

/** Registers the process-wide service (called from `setup()`, or a test's `beforeEach`). */
export function initLegislationService(service: LegislationService): void {
  _service = service;
}

/** The process-wide service. */
export function getLegislationService(): LegislationService {
  if (!_service)
    throw new Error(
      'LegislationService not initialized — call initLegislationService() in setup()',
    );
  return _service;
}
