/**
 * Ultra-fast in-process cache (Map + TTL) — zero network round-trip.
 *
 * Sits in front of Redis for data that is:
 *   • Read on EVERY message (banned check, frozen check, admin check)
 *   • Changed very rarely (bans/freezes/admin grants)
 *   • Safe to serve slightly stale (30–120 s TTLs handle consistency)
 *
 * On a single Heroku dyno this is perfectly safe.
 * On multiple dynos, stale window equals the TTL — acceptable for these use cases.
 *
 * Eviction: lazy on read (no background sweep needed for bounded key sets).
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

class InMemoryCache {
  private readonly store = new Map<string, CacheEntry<unknown>>();

  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  del(key: string): void {
    this.store.delete(key);
  }

  /** Invalidate all keys matching a prefix (e.g. after a bulk ban operation). */
  delPrefix(prefix: string): void {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }
}

export const memCache = new InMemoryCache();
