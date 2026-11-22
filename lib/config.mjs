// Default config + validation. The live config is stored in Netlify Blobs and
// edited from the dashboard; anything missing falls back to these defaults.
import { DEFAULT_CATALOG } from "./catalog.mjs";

export const DEFAULT_CONFIG = {
  // Australia/Sydney = Melbourne/Sydney clock time (AEST, AEDT in summer).
  // Australia/Brisbane = AEST all year round.
  timezone: "Australia/Sydney",
  paused: false,
  catalog: DEFAULT_CATALOG,
  ebay: {
    enabled: true,
    poll_interval_minutes: 10,
    daily_call_cap: 4800,
    fee_rate: 0.13,
    outbound_postage: 9.5,
    unknown_postage_estimate: 10.0,
    retention_days: 7,
    postcode: "3000",
    min_seller_feedback_pct: 95,
    send_wait_alerts: false,
    // Listings whose title contains any of these are skipped (fakes, empties, codes...)
    exclude_keywords: [
      "proxy", "replica", "fake", "custom", "orica", "digital", "code card", "code cards",
      "online code", "empty", "box only", "display only", "no cards", "art card", "fan made",
    ],
    searches: [
      { q: "pokemon booster box sealed", min_profit: 20, max_landed: 200 },
      { q: "pokemon booster bundle sealed", min_profit: 15 },
      { q: "Mewtwo ex 151/128", min_profit: 15, max_landed: 60, comp_query: "Mewtwo ex 151/128" },
      { q: "pokemon bulk cards lot", min_profit: 20 },
    ],
  },
  retailers: {
    enabled: true,
    default_interval_minutes: 30,
    jitter_minutes: 10,
    daily_cap_per_retailer: 48,
    alert_cooldown_hours: 12,
    drop_interval_minutes: 5,
    user_agent: "CardDealSniper/1.0 (personal price monitor; contact: you@example.com)",
    watches: [
      { retailer: "kmart", query: "pokemon mega evolution", target_price: 70 },
      { retailer: "bigw", query: "pokemon elite trainer box", watch_stock: true, target_price: 80 },
    ],
    // Per-site adapter settings. Fix endpoints here (dashboard > Settings > Advanced)
    // without a code change. "VERIFY" means: check in your browser's DevTools.
    sites: {
      kmart: {
        label: "Kmart", base: "https://www.kmart.com.au", default_shipping: 5, ignore_robots: false,
        strategies: ["jsonld", "regex"],
        search_url: "https://www.kmart.com.au/search/?searchTerm={query_url}",
        json: null,
      },
      bigw: {
        label: "Big W", base: "https://www.bigw.com.au", default_shipping: 7, ignore_robots: false,
        strategies: ["json", "jsonld"],
        search_url: "https://www.bigw.com.au/search?text={query_url}",
        // Big W search runs on Algolia. Copy app id / search-only key / index from DevTools.
        json: {
          method: "POST",
          url: "https://{app_id}-dsn.algolia.net/1/indexes/{index}/query",
          headers: { "X-Algolia-Application-Id": "{app_id}", "X-Algolia-API-Key": "{api_key}", "Content-Type": "application/json" },
          body: { params: "query={query_url}&hitsPerPage=40" },
          vars: { app_id: "VERIFY", api_key: "VERIFY", index: "VERIFY" },
          items_path: "hits",
          fields: { id: "objectID", name: "name", price: "price", in_stock: "inStock", url: "url" },
          url_prefix: "https://www.bigw.com.au",
        },
      },
      target: {
        label: "Target", base: "https://www.target.com.au", default_shipping: 5, ignore_robots: false,
        strategies: ["jsonld", "regex"],
        search_url: "https://www.target.com.au/search?text={query_url}",
        json: null,
      },
      ebgames: {
        label: "EB Games", base: "https://www.ebgames.com.au", default_shipping: 6, ignore_robots: false,
        strategies: ["jsonld", "regex"],
        search_url: "https://www.ebgames.com.au/search?q={query_url}",
        json: null,
      },
      jbhifi: {
        label: "JB Hi-Fi", base: "https://www.jbhifi.com.au", default_shipping: 0, ignore_robots: false,
        strategies: ["json", "jsonld"],
        search_url: "https://www.jbhifi.com.au/search?query={query_url}",
        // JB Hi-Fi runs on Shopify; Shopify's public predictive-search endpoint.
        json: {
          method: "GET",
          url: "https://www.jbhifi.com.au/search/suggest.json?q={query_url}&resources[type]=product&resources[limit]=10",
          headers: { Accept: "application/json" },
          vars: {},
          items_path: "resources.results.products",
          fields: { id: "id", name: "title", price: "price", in_stock: "available", url: "url" },
          url_prefix: "https://www.jbhifi.com.au",
        },
      },
      amazon: {
        label: "Amazon AU", base: "https://www.amazon.com.au", default_shipping: 0, ignore_robots: false,
        experimental: true,
        strategies: ["regex"],
        search_url: "https://www.amazon.com.au/s?k={query_url}",
        json: null,
      },
    },
  },
  // Stock you bought to resell (Stock tab). Recommended price = market price,
  // never below break-even. Target profit is used when there's no comp yet.
  stock: {
    target_profit_pct: 0.2,
    target_profit_min: 5,
  },
  // Watches YOUR eBay listings (public data, by seller username) and alerts when a
  // price should move with the market while staying above break-even.
  my_store: {
    enabled: false,
    seller_username: "",
    search_q: "pokemon",
    interval_hours: 6,
    adjust_threshold_pct: 8,
    cooldown_hours: 24,
  },
  alerts: {
    max_per_hour: 20,
    heartbeat_hour: 7,
  },
  comps: {
    marketplace_insights_enabled: false,
    exclude_best_offer: true,
    comp_cache_hours: 24,
    comp_stale_days: 14,
    stale_comp_days_for_multiplier: 30,
    stale_comp_profit_multiplier: 2.0,
    // TCG Prices AU official API: eBay Australia sold prices with outlier filtering.
    // Needs a key (env var TCGPRICES_API_KEY). Their terms: cache max 24h, credit
    // "Prices from TCG Prices AU". Field paths are best-guess until checked with
    // dashboard > Comps > Test a comp; fix them under fields.
    tcgprices_api: {
      enabled: true,
      base_url: "https://tcgprices.com.au/api/v1",
      card_path: "/price",
      sealed_path: "/sealed",
      query_param: "q",
      monthly_cap: 950,
      min_sales: 3,
      fields: { items_path: "", name: "", price: "", sample: "", last_sold: "" },
    },
    sold_filters: {
      // sold listings containing these are ignored when building a comp
      exclude_keywords: ["empty", "box only", "proxy", "fake", "custom", "damaged", "opened", "resealed", "lot of", "bulk", "japanese", "korean", "chinese"],
      // graded slabs are ignored unless your comp name mentions grading
      graded_keywords: ["psa", "cgc", "bgs", "beckett", "graded", "slab", "ace grading", "tag 10"],
      trim_outliers: true,
      days: 30,
    },
    // Scrapers for sites without an API. Off until you confirm the URL works.
    trackers: [
      { name: "pokebinder", label: "PokeBinder", enabled: false, strategy: "jsonld",
        search_url: "https://www.poke-binder.com/search?q={query_url}" },
      { name: "pullday", label: "Pullday", enabled: false, strategy: "jsonld",
        search_url: "https://www.pullday.com/search?q={query_url}" },
    ],
    manual: [
      { name: "Mega Evolution booster bundle", match_keywords: ["mega evolution booster bundle"],
        comp_aud: 62.0, comp_source: "eBay sold, checked 2026-11-22", comp_date: "2026-11-22", fee_rate: 0.13 },
      { name: "Mewtwo ex 151/128", match_keywords: ["mewtwo ex 151/128", "mewtwo ex 30th celebration"],
        comp_aud: 47.0, comp_source: "PokeBinder tracker", comp_date: "2026-11-22" },
    ],
  },
};

function isObj(v) { return v && typeof v === "object" && !Array.isArray(v); }

export function deepMerge(base, over) {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(base[k]) ? deepMerge(base[k], v) : v;
  return out;
}

export function withDefaults(cfg) {
  return deepMerge(DEFAULT_CONFIG, cfg || {});
}

const num = (v) => typeof v === "number" && Number.isFinite(v);

// Returns a list of human-readable problems. Empty list = OK.
export function validateConfig(cfg) {
  const e = [];
  const c = withDefaults(cfg);
  try { new Intl.DateTimeFormat("en-AU", { timeZone: c.timezone }); } catch { e.push(`timezone "${c.timezone}" is not a valid time zone`); }
  const eb = c.ebay;
  if (!num(eb.poll_interval_minutes) || eb.poll_interval_minutes < 5) e.push("ebay.poll_interval_minutes must be a number >= 5");
  if (!num(eb.daily_call_cap) || eb.daily_call_cap > 5000) e.push("ebay.daily_call_cap must be a number <= 5000 (eBay free limit)");
  if (!num(eb.fee_rate) || eb.fee_rate < 0 || eb.fee_rate >= 1) e.push("ebay.fee_rate must be between 0 and 1 (e.g. 0.13)");
  if (!num(eb.outbound_postage) || eb.outbound_postage < 0) e.push("ebay.outbound_postage must be a number >= 0");
  if (!Array.isArray(eb.searches)) e.push("ebay.searches must be a list");
  else eb.searches.forEach((s, i) => {
    if (!s || typeof s.q !== "string" || !s.q.trim()) e.push(`ebay search #${i + 1}: q (search text) is required`);
    if (s && s.min_profit !== undefined && !num(s.min_profit)) e.push(`ebay search #${i + 1}: min_profit must be a number`);
    if (s && s.max_landed !== undefined && s.max_landed !== null && !num(s.max_landed)) e.push(`ebay search #${i + 1}: max_landed must be a number`);
  });
  const calls = (eb.searches?.length || 0) * (1440 / (eb.poll_interval_minutes || 10));
  if (calls > eb.daily_call_cap) e.push(`ebay: ${eb.searches.length} searches every ${eb.poll_interval_minutes} min = ~${Math.round(calls)} calls/day, over the ${eb.daily_call_cap} cap. Raise the interval or remove searches.`);

  const r = c.retailers;
  if (!Array.isArray(r.watches)) e.push("retailers.watches must be a list");
  else r.watches.forEach((w, i) => {
    if (!w || !r.sites[w.retailer]) e.push(`retail watch #${i + 1}: unknown retailer "${w?.retailer}" (use one of: ${Object.keys(r.sites).join(", ")})`);
    if (!w?.query) e.push(`retail watch #${i + 1}: query is required`);
    if (w && w.target_price === undefined && !w.watch_stock) e.push(`retail watch #${i + 1}: set target_price or watch_stock`);
    if (w?.drop_start && Number.isNaN(Date.parse(w.drop_start))) e.push(`retail watch #${i + 1}: drop_start is not a valid date/time`);
    if (w?.drop_end && Number.isNaN(Date.parse(w.drop_end))) e.push(`retail watch #${i + 1}: drop_end is not a valid date/time`);
  });
  if (!num(r.default_interval_minutes) || r.default_interval_minutes < 15) e.push("retailers.default_interval_minutes must be >= 15 (be polite)");
  if (!num(r.drop_interval_minutes) || r.drop_interval_minutes < 3) e.push("retailers.drop_interval_minutes must be >= 3");

  const m = c.comps.manual;
  if (!Array.isArray(m)) e.push("comps.manual must be a list");
  else m.forEach((x, i) => {
    if (!x?.name) e.push(`manual comp #${i + 1}: name is required`);
    if (!Array.isArray(x?.match_keywords) || !x.match_keywords.length) e.push(`manual comp #${i + 1} (${x?.name}): match_keywords needs at least one entry`);
    if (x?.comp_aud !== undefined && x.comp_aud !== null && !num(x.comp_aud)) e.push(`manual comp #${i + 1} (${x?.name}): comp_aud must be a number`);
    if (num(x?.comp_aud) && Number.isNaN(Date.parse(x.comp_date))) e.push(`manual comp #${i + 1} (${x?.name}): comp_date must be a date like 2026-11-22`);
  });
  if (c.my_store.enabled && !String(c.my_store.seller_username || "").trim()) e.push("my_store: enter your eBay seller username, or turn the store watcher off");
  if (!num(c.my_store.interval_hours) || c.my_store.interval_hours < 1) e.push("my_store.interval_hours must be >= 1");
  if (!num(c.alerts.heartbeat_hour) || c.alerts.heartbeat_hour < 0 || c.alerts.heartbeat_hour > 23) e.push("alerts.heartbeat_hour must be 0-23");
  return e;
}
