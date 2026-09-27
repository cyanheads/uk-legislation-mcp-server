/**
 * @fileoverview Pure URL builders for legislation.gov.uk, each producing the
 * redirect-free canonical path verified live. Only the query parameters listed
 * here are ever sent — upstream silently drops unknown ones.
 * @module services/legislation/urls
 */

/** legislation.gov.uk origin every path is resolved against. */
export const ORIGIN = 'https://www.legislation.gov.uk';

function query(params: Record<string, string | number | undefined>): string {
  const pairs = Object.entries(params)
    .filter(
      (entry): entry is [string, string | number] => entry[1] !== undefined && entry[1] !== '',
    )
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`);
  return pairs.length > 0 ? `?${pairs.join('&')}` : '';
}

/** Validated search inputs. */
export interface SearchUrlInput {
  asOf?: string;
  extent?: readonly string[];
  extentMatch: 'applicable' | 'exact';
  limit: number;
  page: number;
  text?: string;
  title?: string;
  /** Type codes or groups, already reduced (`all` alone when present). */
  types: readonly string[];
  year?: number;
  yearFrom?: number;
  yearTo?: number;
}

/** `/{types}[/{year}|/{from}-{to}][/{extent}|/{date}]/data.feed?title=&text=&results-count=&page=` */
export function searchUrl(input: SearchUrlInput): string {
  const segments: string[] = [input.types.join('+')];
  if (input.year !== undefined) segments.push(String(input.year));
  else if (input.yearFrom !== undefined || input.yearTo !== undefined) {
    segments.push(`${input.yearFrom ?? '*'}-${input.yearTo ?? '*'}`);
  }
  if (input.extent && input.extent.length > 0) {
    segments.push(`${input.extentMatch === 'exact' ? '=' : ''}${input.extent.join('+')}`);
  } else if (input.asOf) {
    segments.push(input.asOf);
  }
  return `/${segments.join('/')}/data.feed${query({
    title: input.title,
    text: input.text,
    'results-count': input.limit,
    page: input.page > 1 ? input.page : undefined,
  })}`;
}

/** `/{type}/{year}/data.feed?number={n}` — resolves a numbered citation to its entry. */
export function numberLookupUrl(type: string, year: string | number, number: string): string {
  return `/${type}/${year}/data.feed${query({ number })}`;
}

/** Document location pieces. */
export interface DocumentUrlInput {
  item: string;
  provision?: string;
  /** Version path segment (a date or an enacted keyword); absent for current. */
  version?: string;
  welsh?: boolean;
}

/** `/{item}[/{provision}][/{version}][/welsh]/data.xml` */
export function documentUrl(input: DocumentUrlInput): string {
  return `${documentPath(input)}/data.xml`;
}

/** `/{item}[/{provision}][/{version}][/welsh]` — the web page for a document. */
export function documentPath(input: DocumentUrlInput): string {
  const segments = [input.item, input.provision, input.version, input.welsh ? 'welsh' : undefined];
  return `/${segments.filter(Boolean).join('/')}`;
}

/** `/{item}/contents[/{version}][/welsh]/data.xml[?text=]` — version sits after `contents`. */
export function contentsUrl(
  input: Omit<DocumentUrlInput, 'provision'> & { text?: string },
): string {
  const segments = [input.item, 'contents', input.version, input.welsh ? 'welsh' : undefined];
  return `/${segments.filter(Boolean).join('/')}/data.xml${query({ text: input.text })}`;
}

/** `/id/{item}` — identifier resolution (303 when the item exists, 404 when not). */
export function idUrl(item: string): string {
  return `/id/${item}`;
}

/** `/id?title={title}` — short-title resolution (301 unique, 300 list, 404 miss). */
export function idTitleUrl(title: string): string {
  return `/id${query({ title })}`;
}

/** Changes-feed inputs. */
export interface ChangesUrlInput {
  counterpart?: string;
  direction: 'affected' | 'affecting';
  item: string;
  limit: number;
  page: number;
  status: 'all' | 'applied' | 'unapplied';
}

/**
 * `/changes[/{status}]/{direction}/{item}/data.feed?results-count=&page=`, or with a counterpart
 * `/changes[/{status}]/affected/{affected}/affecting/{affecting}/…` in either direction: upstream
 * 404s a counterpart after an `affecting` first segment (Design Decision 67).
 */
export function changesUrl(input: ChangesUrlInput): string {
  const segments = ['changes'];
  if (input.status !== 'all') segments.push(input.status);
  if (!input.counterpart) segments.push(input.direction, input.item);
  else if (input.direction === 'affected')
    segments.push('affected', input.item, 'affecting', input.counterpart);
  else segments.push('affected', input.counterpart, 'affecting', input.item);
  return `/${segments.join('/')}/data.feed${query({
    'results-count': input.limit,
    page: input.page > 1 ? input.page : undefined,
  })}`;
}

/** Publication Log inputs. */
export interface UpdateUrlInput {
  category?: string;
  contentType?: string;
  /** Event date; omitted for an item's undated log. */
  date?: string;
  direction?: string;
  event?: string;
  item?: string;
  newOnly: boolean;
  page: number;
}

/**
 * `/update[/{date}][/{content_type}][/{direction}][/{category}][/{item}]/data.feed?new=&event=&page=`.
 * Page URLs are built here rather than followed: upstream's first-page `next`
 * link is malformed (`…sortorder=descending?page=2`).
 */
export function updateUrl(input: UpdateUrlInput): string {
  const segments = [
    'update',
    input.date,
    input.contentType,
    input.direction,
    input.category,
    input.item,
  ];
  return `/${segments.filter(Boolean).join('/')}/data.feed${query({
    new: input.newOnly ? 'true' : undefined,
    event: input.event,
    page: input.page > 1 ? input.page : undefined,
  })}`;
}
