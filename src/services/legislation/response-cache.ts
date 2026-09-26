/**
 * @fileoverview Process-level LRU response cache keyed by request URL and
 * bounded by stored bytes. Content is public and identical for every caller,
 * so one cache serves the whole process. Stale entries are kept for
 * `If-Modified-Since` revalidation until evicted.
 * @module services/legislation/response-cache
 */

/** One cached upstream answer. */
export interface CachedResponse {
  /** Raw body for 200 and 300 answers. */
  body?: string;
  /** Epoch ms after which the entry must be revalidated or refetched. */
  expiresAt: number;
  lastModified?: string;
  /** `Location` for 3xx answers. */
  location?: string;
  status: number;
}

/** Cache lookup result. */
export interface CacheLookup {
  entry: CachedResponse;
  fresh: boolean;
}

/** Options for {@link ResponseCache}. */
export interface ResponseCacheOptions {
  maxBytes: number;
  now?: () => number;
}

const ENTRY_OVERHEAD_BYTES = 256;

function sizeOf(url: string, entry: CachedResponse): number {
  return (
    ENTRY_OVERHEAD_BYTES +
    Buffer.byteLength(url) +
    Buffer.byteLength(entry.body ?? '') +
    Buffer.byteLength(entry.location ?? '')
  );
}

/** In-memory LRU of upstream responses, evicting least-recently-used entries past `maxBytes`. */
export class ResponseCache {
  private readonly entries = new Map<string, { entry: CachedResponse; bytes: number }>();
  private readonly maxBytes: number;
  private readonly now: () => number;
  private totalBytes = 0;

  constructor(options: ResponseCacheOptions) {
    this.maxBytes = options.maxBytes;
    this.now = options.now ?? Date.now;
  }

  /** Looks up an entry, marking it most recently used. */
  get(url: string): CacheLookup | undefined {
    const slot = this.entries.get(url);
    if (!slot) return;
    this.entries.delete(url);
    this.entries.set(url, slot);
    return { entry: slot.entry, fresh: slot.entry.expiresAt > this.now() };
  }

  /** Stores an entry, evicting the least recently used ones past the byte bound. */
  set(url: string, entry: CachedResponse): void {
    this.delete(url);
    const bytes = sizeOf(url, entry);
    if (bytes > this.maxBytes) return;
    this.entries.set(url, { entry, bytes });
    this.totalBytes += bytes;
    for (const [key, slot] of this.entries) {
      if (this.totalBytes <= this.maxBytes) break;
      this.entries.delete(key);
      this.totalBytes -= slot.bytes;
    }
  }

  /** Extends an entry's expiry after a 304 revalidation. */
  renew(url: string, expiresAt: number): void {
    const slot = this.entries.get(url);
    if (slot) slot.entry.expiresAt = expiresAt;
  }

  private delete(url: string): void {
    const slot = this.entries.get(url);
    if (!slot) return;
    this.entries.delete(url);
    this.totalBytes -= slot.bytes;
  }

  /** Drops every entry. */
  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }
}
