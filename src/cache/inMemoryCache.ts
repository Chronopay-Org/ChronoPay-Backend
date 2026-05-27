export type CacheSource = "cache" | "origin";

type CacheEntry<T> = {
  value: T;
  createdAt: number;
  expiresAt: number;
  lastAccessedAt: number;
};

type CacheClock = () => number;

export interface InMemoryCacheOptions {
  ttlMs: number;
  maxEntries?: number;
  clock?: CacheClock;
}

export interface CacheLoadResult<T> {
  value: T;
  source: CacheSource;
}

export class InMemoryCache<T> {
  private readonly store = new Map<string, CacheEntry<T>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly clock: CacheClock;

  constructor({ ttlMs, maxEntries = 100, clock = Date.now }: InMemoryCacheOptions) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error("Cache ttlMs must be a positive number");
    }

    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new Error("Cache maxEntries must be a positive integer");
    }

    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.clock = clock;
  }

  get(key: string): T | undefined {
    const entry = this.store.get(key);

    if (!entry) {
      return undefined;
    }

    if (this.isExpired(entry)) {
      this.store.delete(key);
      return undefined;
    }

    entry.lastAccessedAt = this.now();
    return entry.value;
  }

  set(key: string, value: T, ttlMs = this.ttlMs): void {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error("Cache entry ttlMs must be a positive number");
    }

    this.evictExpiredEntries();

    if (!this.store.has(key) && this.store.size >= this.maxEntries) {
      this.evictLeastRecentlyUsed();
    }

    const currentTime = this.now();
    this.store.set(key, {
      value,
      createdAt: currentTime,
      expiresAt: currentTime + ttlMs,
      lastAccessedAt: currentTime,
    });
  }

  async getOrLoad(
    key: string,
    loader: () => Promise<T> | T,
    ttlMs = this.ttlMs,
  ): Promise<CacheLoadResult<T>> {
    const cachedValue = this.get(key);

    if (cachedValue !== undefined) {
      return { value: cachedValue, source: "cache" };
    }

    const freshValue = await loader();
    this.set(key, freshValue, ttlMs);

    return { value: freshValue, source: "origin" };
  }

  invalidate(key: string): boolean {
    return this.store.delete(key);
  }

  invalidateByPrefix(prefix: string): number {
    let invalidatedEntries = 0;

    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
        invalidatedEntries += 1;
      }
    }

    return invalidatedEntries;
  }

  clear(): void {
    this.store.clear();
  }

  size(): number {
    this.evictExpiredEntries();
    return this.store.size;
  }

  private now(): number {
    return this.clock();
  }

  private isExpired(entry: CacheEntry<T>): boolean {
    return entry.expiresAt <= this.now();
  }

  private evictExpiredEntries(): void {
    for (const [key, entry] of this.store.entries()) {
      if (this.isExpired(entry)) {
        this.store.delete(key);
      }
    }
  }

  private evictLeastRecentlyUsed(): void {
    let keyToEvict: string | undefined;
    let oldestAccess = Number.POSITIVE_INFINITY;

    for (const [key, entry] of this.store.entries()) {
      if (entry.lastAccessedAt < oldestAccess) {
        oldestAccess = entry.lastAccessedAt;
        keyToEvict = key;
      }
    }

    if (keyToEvict) {
      this.store.delete(keyToEvict);
    }
  }
}