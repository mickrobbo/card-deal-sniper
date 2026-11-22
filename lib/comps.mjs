// Comps engine: cache -> eBay Marketplace Insights -> TCG Prices AU API -> other
// trackers -> manual list. If a fetched comp and a manual comp both exist, the
// fresher one wins. Every sold-price source is filtered to AU, AUD, matching
// titles, no fakes/empties, no graded slabs (unless asked), outliers trimmed.
import { normalise, median, containsAllTokens, containsAny, fill, getPath, parsePrice, trimOutliers, localAgeDays } from "./util.mjs";
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

const DEFAULT_FILTERS = { exclude_keywords: [], graded_keywords: [], trim_outliers: true, days: 30 };

/**
 * Median AU sold price over the trailing `days`.
 * sales: Marketplace Insights itemSales[] ({ title, lastSoldPrice:{value,currency}, lastSoldDate, buyingOptions, itemLocation })
 * Best Offer sales hide the real accepted price, so they're excluded when excludeBestOffer is on.
 */
export function medianSold(sales, now = new Date(), { days = 30, excludeBestOffer = true, query = null, filters = DEFAULT_FILTERS } = {}) {
  const f = { ...DEFAULT_FILTERS, ...filters };
  const cutoff = now.getTime() - (days || f.days) * 86400000;
  const wantsGraded = query && containsAny(query, f.graded_keywords);
  const counts = { excludedBestOffer: 0, excludedTitle: 0, excludedNotAU: 0, excludedOld: 0 };
  const kept = [];
  for (const s of sales || []) {
    const t = Date.parse(s.lastSoldDate);
    if (!Number.isFinite(t) || t < cutoff) { counts.excludedOld++; continue; }
    if (excludeBestOffer && (s.buyingOptions || []).includes("BEST_OFFER")) { counts.excludedBestOffer++; continue; }
    if (s.itemLocation?.country && s.itemLocation.country !== "AU") { counts.excludedNotAU++; continue; }
    if (s.title && query && !containsAllTokens(s.title, query)) { counts.excludedTitle++; continue; }
    if (s.title && containsAny(s.title, f.exclude_keywords)) { counts.excludedTitle++; continue; }
    if (s.title && !wantsGraded && containsAny(s.title, f.graded_keywords)) { counts.excludedTitle++; continue; }
    const v = Number(s.lastSoldPrice?.value);
    if (!Number.isFinite(v) || (s.lastSoldPrice?.currency && s.lastSoldPrice.currency !== "AUD")) continue;
    kept.push({ v, t });
  }
  const values = f.trim_outliers ? trimOutliers(kept.map((k) => k.v)) : kept.map((k) => k.v);
  const lastSold = kept.length ? new Date(Math.max(...kept.map((k) => k.t))).toISOString() : null;
  return { median: median(values), count: values.length, trimmed: kept.length - values.length, lastSold, ...counts };
}

export function marketplaceInsightsProvider(ebay, cs) {
  return {
    name: "mi", label: "eBay AU sold",
    async fetch(query, now) {
      const sales = await ebay.marketplaceInsights(query);
      const r = medianSold(sales, now, { days: cs.sold_filters?.days || 30, excludeBestOffer: cs.exclude_best_offer, query, filters: cs.sold_filters });
      if (r.median === null || r.count < 3) return null;
      return { comp_aud: Math.round(r.median * 100) / 100, sample: r.count, last_sold: r.lastSold };
    },
  };
}

// Pull a price out of an unknown-shaped JSON response. Configured paths win;
// otherwise look for the usual field names.
const PRICE_KEYS = ["median", "medianPrice", "median_price", "soldMedian", "sold_median", "medianSold", "avgSold", "average", "averagePrice", "avg", "avg_price", "marketPrice", "market_price", "price", "value"];
const SAMPLE_KEYS = ["sales", "salesCount", "sales_count", "soldCount", "sold_count", "count", "sampleSize", "sample_size", "numSales"];
const NAME_KEYS = ["name", "title", "productName", "product_name", "cardName"];
const DATE_KEYS = ["lastSold", "last_sold", "lastSoldDate", "last_sold_at", "updatedAt", "updated_at"];

function firstKey(o, keys, conv) {
  for (const k of keys) {
    const v = o?.[k];
    const c = conv(v);
    if (c !== null && c !== undefined) return c;
  }
  for (const nest of ["prices", "price", "raw", "ungraded", "sold", "stats"]) {
    if (o?.[nest] && typeof o[nest] === "object") {
      for (const k of keys) { const c = conv(o[nest][k]); if (c !== null && c !== undefined) return c; }
    }
  }
  return null;
}

export function extractTcgPrice(json, query, fields = {}) {
  let items = fields.items_path ? getPath(json, fields.items_path) : null;
  if (!Array.isArray(items)) {
    items = Array.isArray(json) ? json : ["results", "data", "items", "products", "cards", "sealed"].map((k) => json?.[k]).find(Array.isArray);
    if (!items && json && typeof json === "object") items = [json];
  }
  if (!items?.length) return null;
  const nameOf = (it) => (fields.name ? getPath(it, fields.name) : firstKey(it, NAME_KEYS, (v) => (typeof v === "string" ? v : null))) || "";
  const hit = items.find((it) => containsAllTokens(nameOf(it), query)) || null;
  if (!hit) return null;
  const price = fields.price ? parsePrice(getPath(hit, fields.price)) : firstKey(hit, PRICE_KEYS, parsePrice);
  if (price === null) return null;
  const sample = fields.sample ? Number(getPath(hit, fields.sample)) : firstKey(hit, SAMPLE_KEYS, (v) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : null));
  const last = fields.last_sold ? getPath(hit, fields.last_sold) : firstKey(hit, DATE_KEYS, (v) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : null));
  return { comp_aud: price, sample: Number.isFinite(sample) ? sample : null, last_sold: last || null, matched: nameOf(hit) };
}

/**
 * TCG Prices AU API provider. counter: persisted { [YYYY-MM]: n } monthly request count.
 * isSealed(query) decides between the sealed and card endpoints.
 */
export function tcgPricesProvider(cfg, { apiKey, counter, fetchImpl = fetch, isSealed = () => false, now = () => new Date() }) {
  return {
    name: "tcgprices", label: "TCG Prices AU",
    async fetch(query) {
      if (!apiKey) return null;
      const month = now().toISOString().slice(0, 7);
      if ((counter[month] || 0) >= cfg.monthly_cap) throw new Error(`TCG Prices AU monthly cap (${cfg.monthly_cap}) reached`);
      counter[month] = (counter[month] || 0) + 1;
      const path = isSealed(query) ? cfg.sealed_path : cfg.card_path;
      const url = `${cfg.base_url}${path}?${new URLSearchParams({ [cfg.query_param || "q"]: query })}`;
      const r = await fetchImpl(url, { headers: { "X-API-Key": apiKey, Accept: "application/json" } });
      if (r.status === 401 || r.status === 403) throw new Error(`TCG Prices AU rejected the API key (HTTP ${r.status})`);
      if (r.status === 429) throw new Error("TCG Prices AU rate limit reached");
      if (!r.ok) throw new Error(`TCG Prices AU HTTP ${r.status}`);
      const res = extractTcgPrice(await r.json(), query, cfg.fields || {});
      if (!res) return null;
      if (Number.isFinite(res.sample) && res.sample < (cfg.min_sales ?? 3)) return null;
      return res;
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

// Max cache age per source (TCG Prices AU terms: 24h).
const MAX_CACHE_HOURS = { tcgprices: 24 };

export class CompsEngine {
  /** cache: persisted object { [key]: { comp_aud|null, source, label, fetched_at, sample, last_sold } } */
  constructor({ manual, cache, providers, cs, now = new Date(), tz = "Australia/Sydney", log = () => {} }) {
    Object.assign(this, { manual, cache, providers, cs, now, tz, log });
    this.dirty = false;
  }

  cacheFresh(c) {
    if (!c) return false;
    const hours = Math.min(this.cs.comp_cache_hours, MAX_CACHE_HOURS[c.source] ?? Infinity);
    return this.now - new Date(c.fetched_at) < hours * 3600000;
  }

  // Fetch (or reuse cached) comp for an explicit product/card name.
  async fetchByName(query) {
    if (!query || !this.providers.length) return null;
    const key = normalise(query);
    const c = this.cache[key];
    if (this.cacheFresh(c)) return c.comp_aud !== null ? c : null;
    let got = null;
    for (const p of this.providers) {
      try {
        const r = await p.fetch(query, this.now);
        if (r && Number.isFinite(r.comp_aud)) { got = { ...r, source: p.name, label: p.label }; break; }
      } catch (e) {
        this.log(`[comps] ${p.name} failed for "${query}": ${e.message} - trying next source`);
      }
    }
    // negative results are cached too, so sources aren't asked again today
    this.cache[key] = got ? { ...got, fetched_at: this.now.toISOString() } : { comp_aud: null, source: "none", fetched_at: this.now.toISOString() };
    this.dirty = true;
    return got ? this.cache[key] : null;
  }

  async lookup(title, term = {}) {
    const manualHit = matchManual(title, this.manual);
    const query = manualHit?.name || term.comp_query || null;
    return this.resolve(query, manualHit);
  }

  async resolve(query, manualHit) {
    const fetched = await this.fetchByName(query);
    const manualComp = manualHit && Number.isFinite(manualHit.comp_aud)
      ? { comp_aud: manualHit.comp_aud, label: "manual file", as_of: manualHit.comp_date, fee_rate: manualHit.fee_rate, style: "old", name: manualHit.name, source: "manual" }
      : null;
    const fetchedComp = fetched
      ? { comp_aud: fetched.comp_aud, label: fetched.label, as_of: fetched.fetched_at, fee_rate: manualHit?.fee_rate, style: "ago", name: query, source: fetched.source, sample: fetched.sample ?? null, last_sold: fetched.last_sold ?? null }
      : null;
    if (fetchedComp && manualComp) return Date.parse(fetchedComp.as_of) >= Date.parse(manualComp.as_of) ? fetchedComp : manualComp;
    return fetchedComp || manualComp || null;
  }

  // Comp age in local calendar days (AEST/AEDT), not UTC days.
  ageDays(comp) { return localAgeDays(comp.as_of, this.now, this.tz); }
}

export function staleComps(manual, cache, staleDays, now = new Date()) {
  const lim = staleDays * 86400000;
  const names = [];
  for (const c of manual || []) if (Number.isFinite(c.comp_aud) && now - new Date(c.comp_date) > lim) names.push(c.name);
  for (const [k, v] of Object.entries(cache || {})) if (v.comp_aud !== null && now - new Date(v.fetched_at) > lim) names.push(k);
  return names;
}
