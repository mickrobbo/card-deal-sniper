// Storage wrapper. In Netlify: Blobs. In tests: an in-memory Map.

export class MemoryStore {
  constructor(init = {}) { this.m = new Map(Object.entries(init).map(([k, v]) => [k, JSON.stringify(v)])); }
  async get(key, fallback = null) { return this.m.has(key) ? JSON.parse(this.m.get(key)) : fallback; }
  async set(key, val) { this.m.set(key, JSON.stringify(val)); }
}

export async function netlifyStore() {
  if (globalThis.__CDS_TEST_STORE) return globalThis.__CDS_TEST_STORE; // local testing only
  const { getStore } = await import("@netlify/blobs");
  const s = getStore({ name: "card-deal-sniper", consistency: "strong" });
  return {
    async get(key, fallback = null) {
      const v = await s.get(key, { type: "json" });
      return v === null || v === undefined ? fallback : v;
    },
    async set(key, val) { await s.setJSON(key, val); },
  };
}
