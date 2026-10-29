/**
 * Tiny TTL cache with in-flight de-duplication.
 * - Two simultaneous requests for the same key trigger ONE portal call.
 * - Failures are never cached.
 * - Bounded size (oldest entry evicted) so it cannot grow forever.
 */
export class TtlCache {
  constructor({ maxEntries = 1000, now = () => Date.now() } = {}) {
    this.maxEntries = maxEntries;
    this.now = now;
    this.store = new Map(); // key -> { value, expiresAt }
    this.inflight = new Map(); // key -> Promise
  }

  async get(key, ttlMs, loader) {
    const hit = this.store.get(key);
    if (hit && hit.expiresAt > this.now()) return hit.value;
    if (this.inflight.has(key)) return this.inflight.get(key);

    const p = (async () => {
      try {
        const value = await loader();
        this.#set(key, value, ttlMs);
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }

  #set(key, value, ttlMs) {
    if (this.store.size >= this.maxEntries) this.store.delete(this.store.keys().next().value);
    this.store.set(key, { value, expiresAt: this.now() + ttlMs });
  }

  clear() {
    this.store.clear();
  }
}
