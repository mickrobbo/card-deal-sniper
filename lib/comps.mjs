// Comps engine: cache -> eBay Marketplace Insights -> price trackers -> manual list.
// If both a fetched comp and a manual comp exist, the fresher one wins.
import { normalise, median, containsAllTokens, fill } from "./util.mjs";
import { extractJsonLd, extractJson, extractRegex } from "./extract.mjs";

// Longest matching keyword wins (most specific).
export function matchManual(title, manual) {
  const t = normalise(title);
  let best = null;
  for (const c of manual || []) {
    for (const kw of c.match_keywords || []) {
      const k = normalise(kw);
      if (k && t.includes(k) && (!best || k.length > best.kwLen)) best = { comp: c, kwLen: k.length };
    }
  }
  return best?.comp || null;
}

/**
 * Median of sold prices over the trailing `days`. Best Offer sales hide the real
 * accepted price, so they're excluded when excludeBestOffer is on.
 * sales: Marketplace Insights itemSales[] ({ lastSoldPrice:{value}, lastSoldDate, buyingOptions })
 */
export function medianSold(sales, now = new Date(), { days = 30, excludeBestOffer = true } = {}) {
  const cutoff = now.getTime() - days * 86400000;
  let excluded = 0;
  const prices = [];
  for (const s of sales || []) {
    const t = Date.parse(s.lastSoldDate);
    if (!Number.isFinite(t) || t < cutoff) continue;
    if (excludeBestOffer && (s.buyingOptions || []).includes("BEST_OFFER")) { excluded++; continue; }
    const v = Number(s.lastSoldPrice?.value);
    if (Number.isFinite(v) && (!s.lastSoldPrice?.currency || s.lastSoldPrice.currency === "AUD")) prices.push(v);
  }
  return { median: median(prices), count: prices.length, excludedBestOffer: excluded };
}

export function marketplaceInsightsProvider(ebay, cs) {
  return {
    name: "mi", label: "eBay sold via Market Insights",
    async fetch(query, now) {
      const sales = await ebay.marketplaceInsights(query);
      const r = medianSold(sales, now, { days: 30, excludeBestOffer: cs.exclude_best_offer });
      if (r.median === null || r.count < 3) return null;
      return { comp_aud: Math.round(r.median * 100) / 100, sample: r.count };
    },
  };
}

export function trackerProvider(t, politeFor) {
  return {
    name: t.name, label: t.label,
    async fetch(query) {
      const polite = politeFor(t);
      const url = fill(t.search_url, { query, query_url: encodeURIComponent(query) });
      const r = await polite.request(url);
      if (!r.ok) return null;
      let items = null;
      if (t.strategy === "json" && r.json) items = extractJson(r.json, t.json || {});
      else if (t.strategy === "regex") items = extractRegex(r.text, t, url);
      else items = extractJsonLd(r.text, url);
      const hit = (items || []).find((p) => containsAllTokens(p.name, query)) || null;
      return hit ? { comp_aud: hit.price } : null;
    },
  };
}

export class CompsEngine {
  /** cache: persisted object { [key]: { comp_aud|null, source, label, fetched_at } } */
  constructor({ manual, cache, providers, cs, now = new Date(), log = () => {} }) {
    Object.assign(this, { manual, cache, providers, cs, now, log });
    this.dirty = false;
  }

  async lookup(title, term = {}) {
    const manualHit = matchManual(title, this.manual);
    const query = manualHit?.name || term.comp_query || null;
    let fetched = null;
    if (query && this.providers.length) {
      const key = normalise(query);
      const c = this.cache[key];
      const fresh = c && this.now - new Date(c.fetched_at) < this.cs.comp_cache_hours * 3600000;
      if (fresh) fetched = c.comp_aud !== null ? c : null;
      else {
        let got = null;
        for (const p of this.providers) {
          try {
            const r = await p.fetch(query, this.now);
            if (r && Number.isFinite(r.comp_aud)) { got = { ...r, source: p.name, label: p.label }; break; }
          } catch (e) {
            this.log(`[comps] ${p.name} failed for "${query}": ${e.message} - trying next source`);
          }
        }
        // negative results are cached too, so trackers aren't asked again today
        this.cache[key] = got ? { ...got, fetched_at: this.now.toISOString() } : { comp_aud: null, source: "none", fetched_at: this.now.toISOString() };
        this.dirty = true;
        fetched = got ? this.cache[key] : null;
      }
    }
    const manualComp = manualHit && Number.isFinite(manualHit.comp_aud)
      ? { comp_aud: manualHit.comp_aud, label: "manual file", as_of: manualHit.comp_date, fee_rate: manualHit.fee_rate, style: "old", name: manualHit.name, source: "manual" }
      : null;
    const fetchedComp = fetched
      ? { comp_aud: fetched.comp_aud, label: fetched.label, as_of: fetched.fetched_at, fee_rate: manualHit?.fee_rate, style: "ago", name: query, source: fetched.source }
      : null;
    if (fetchedComp && manualComp) return Date.parse(fetchedComp.as_of) >= Date.parse(manualComp.as_of) ? fetchedComp : manualComp;
    return fetchedComp || manualComp || null;
  }
}

export function staleComps(manual, cache, staleDays, now = new Date()) {
  const lim = staleDays * 86400000;
  const names = [];
  for (const c of manual || []) if (Number.isFinite(c.comp_aud) && now - new Date(c.comp_date) > lim) names.push(c.name);
  for (const [k, v] of Object.entries(cache || {})) if (v.comp_aud !== null && now - new Date(v.fetched_at) > lim) names.push(k);
  return names;
}
