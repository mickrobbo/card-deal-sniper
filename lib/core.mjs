// The three jobs (eBay poll, retail poll, hourly housekeeping) plus the
// rate-limited alerter. Everything takes an injected store/fetch/clock so it can
// be unit-tested without Netlify.
import { withDefaults } from "./config.mjs";
import { EbayClient, toListing, BudgetError, EbayAccessError, EbayAuthError } from "./ebay.mjs";
import { cheapestPostage, evaluateListing, formatEbayAlert } from "./evaluate.mjs";
import { CompsEngine, marketplaceInsightsProvider, trackerProvider, tcgPricesProvider, staleComps } from "./comps.mjs";
import { isSealedName, pricing, priceAdvice, compQueryFor, unitCost } from "./inventory.mjs";
import { matchManual } from "./comps.mjs";
import { compLine } from "./evaluate.mjs";
import { PoliteFetcher } from "./polite.mjs";
import { fetchProducts, evaluateWatch, inDropWindow } from "./retailers.mjs";
import { sendNtfy } from "./ntfy.mjs";
import { containsAny, containsAllTokens, utcDay, localParts, clampList, money, moneyShort, localAgeDays } from "./util.mjs";

const TIME_BUDGET_MS = 20000; // scheduled functions get 30s; leave headroom to save state

function makeLogger(lines) {
  return (msg) => { const l = `${new Date().toISOString()} ${msg}`; lines.push(l); console.log(l); };
}

export class Alerter {
  constructor({ store, env, cfg, source, now, dryRun, fetchImpl, log }) {
    Object.assign(this, { store, env, cfg, source, now, dryRun, fetchImpl, log });
    this.sentPreview = [];
  }
  async load() {
    this.logs = {
      ebay: await this.store.get("alerts-ebay", []),
      retail: await this.store.get("alerts-retail", []),
    };
    this.queue = await this.store.get(`queue-${this.source}`, []);
    return this;
  }
  sentThisHour() {
    const hour = this.now().toISOString().slice(0, 13);
    return [...this.logs.ebay, ...this.logs.retail].filter((a) => !a.queued && a.sentAt?.slice(0, 13) === hour).length;
  }
  async push(msg) {
    if (this.dryRun) { this.sentPreview.push(msg); this.log(`[dry-run] would send: ${msg.title}`); return; }
    await sendNtfy(this.env, msg, this.fetchImpl);
  }
  async alert(a) {
    const entry = { sentAt: this.now().toISOString(), kind: a.kind, key: a.key, title: a.title, body: a.body, url: a.url };
    if (this.sentThisHour() >= this.cfg.alerts.max_per_hour) {
      entry.queued = true;
      this.queue.push(entry);
      this.log(`rate limit hit - queued "${a.title}" for the hourly summary`);
    } else {
      try { await this.push({ title: a.title, body: a.body, priority: a.priority || "high", tags: a.tags || "", click: a.url, actionLabel: a.kind === "ebay" ? "Open listing" : "Open product" }); }
      catch (e) { this.log(`alert send failed: ${e.message}`); entry.error = e.message; }
    }
    this.logs[this.source].push(entry);
  }
  // System notices (blocks, auth problems) bypass the rate limit.
  async notice(title, body) {
    try { await this.push({ title: `Card Deal Sniper: ${title}`, body, priority: "default", tags: "warning" }); }
    catch (e) { this.log(`notice send failed: ${e.message}`); }
  }
  async save() {
    if (this.dryRun) return;
    await this.store.set(`alerts-${this.source}`, clampList(this.logs[this.source], 300));
    await this.store.set(`queue-${this.source}`, this.queue);
  }
}

function politeFactory(state, cfg, alerter, now, fetchImpl, log) {
  return (t) => new PoliteFetcher(state, {
    name: t.name, label: t.label, userAgent: cfg.retailers.user_agent,
    dailyCap: t.daily_cap || 20, ignoreRobots: !!t.ignore_robots, fetch: fetchImpl, now, log,
    notify: (title, body) => alerter.notice(title, body),
  });
}

// Comp sources that don't need an eBay client (used by the eBay job and the Stock tab).
export function buildSharedProviders(cfg, env, { trackerPolite, alerter, now, fetchImpl, log, tcgCounter }) {
  const out = [];
  const tp = cfg.comps.tcgprices_api;
  if (tp?.enabled && env.TCGPRICES_API_KEY) {
    out.push(tcgPricesProvider(tp, { apiKey: env.TCGPRICES_API_KEY, counter: tcgCounter, fetchImpl, now, isSealed: (q) => isSealedName(q, cfg.catalog) }));
  }
  const pf = politeFactory(trackerPolite, cfg, alerter, now, fetchImpl, log);
  for (const t of cfg.comps.trackers || []) if (t.enabled) out.push(trackerProvider(t, pf));
  return out;
}

/* ------------------------------ eBay job ------------------------------ */
export async function runEbay({ store, env, now = () => new Date(), dryRun = false, force = false, fetchImpl = fetch } = {}) {
  const lines = [];
  const log = makeLogger(lines);
  const started = Date.now();
  const cfg = withDefaults(await store.get("config"));
  const out = { polled: 0, newItems: 0, alerts: 0, noComp: 0, errors: [], log: lines, preview: [] };
  if (cfg.paused && !force) { log("paused - skipping eBay"); return out; }
  if (!cfg.ebay.enabled && !force) { log("eBay watcher disabled"); return out; }
  const eb = cfg.ebay;
  const st = await store.get("ebay-state", { lastPolled: {}, seen: {}, calls: {} });
  st.lastPolled ||= {}; st.seen ||= {}; st.calls ||= {};
  if (!force && st.authRetryAt && new Date(st.authRetryAt) > now()) { log(`eBay auth retry scheduled for ${st.authRetryAt}`); return out; }

  const compsCache = await store.get("comps-cache", {});
  const trackerPolite = await store.get("tracker-polite", {});
  const nocomp = await store.get("nocomp", []);
  const alerter = await new Alerter({ store, env, cfg, source: "ebay", now, dryRun, fetchImpl, log }).load();
  const day = utcDay(now());
  const ld = localParts(cfg.timezone, now()).date;
  st.callsLocal ||= {};
  const storeCalls = await store.get("store-calls", {});
  const budget = { cap: eb.daily_call_cap, used: () => (st.calls[day] || 0) + (storeCalls[day] || 0), inc: () => { st.calls[day] = (st.calls[day] || 0) + 1; st.callsLocal[ld] = (st.callsLocal[ld] || 0) + 1; } };

  let client;
  try {
    client = new EbayClient({ clientId: env.EBAY_CLIENT_ID, clientSecret: env.EBAY_CLIENT_SECRET, budget, postcode: eb.postcode, fetchImpl, log });
  } catch (e) { log(e.message); out.errors.push(e.message); return out; }

  const providers = [];
  if (cfg.comps.marketplace_insights_enabled) providers.push(marketplaceInsightsProvider(client, cfg.comps));
  const tcgCounter = await store.get("tcgprices-usage", {});
  providers.push(...buildSharedProviders(cfg, env, { trackerPolite, alerter, now, fetchImpl, log, tcgCounter }));
  const engine = new CompsEngine({ manual: cfg.comps.manual, cache: compsCache, providers, cs: cfg.comps, now: now(), tz: cfg.timezone, log });

  const intervalMs = eb.poll_interval_minutes * 60000;
  const due = eb.searches
    .filter((t) => force || !st.lastPolled[t.q] || now() - new Date(st.lastPolled[t.q]) >= intervalMs - 30000)
    .sort((a, b) => String(st.lastPolled[a.q] || "").localeCompare(String(st.lastPolled[b.q] || "")));

  outer: for (const term of due) {
    if (Date.now() - started > TIME_BUDGET_MS) { log("time budget used - remaining searches next run"); break; }
    let res;
    try {
      res = await client.search(term.q);
      st.tokenFailSince = null; st.tokenNotified = false; st.authRetryAt = null; st.accessError = null;
    } catch (e) {
      if (e instanceof BudgetError) {
        if (st.budgetLoggedDay !== day) { log(e.message); st.budgetLoggedDay = day; }
        out.errors.push(e.message); break;
      }
      if (e instanceof EbayAuthError) {
        log(e.message); out.errors.push(e.message);
        st.tokenFailSince ||= now().toISOString();
        st.authRetryAt = new Date(now().getTime() + 15 * 60000).toISOString();
        if (!st.tokenNotified && now() - new Date(st.tokenFailSince) >= 3600000) {
          await alerter.notice("eBay login failing", `eBay token requests have failed for over an hour.\n${e.message}`);
          st.tokenNotified = true;
        }
        break;
      }
      if (e instanceof EbayAccessError) {
        log(e.message); out.errors.push(e.message);
        if (st.accessError !== day) { await alerter.notice("eBay access denied", e.message); st.accessError = day; }
        break;
      }
      log(`search "${term.q}" failed: ${e.message} - will retry next cycle`);
      out.errors.push(e.message);
      continue;
    }
    st.lastPolled[term.q] = now().toISOString();
    out.polled++;
    for (const s of res.items) {
      const L = toListing(s);
      if (!L.itemId || st.seen[L.itemId]) continue;
      out.newItems++;
      const mark = (extra = {}) => { st.seen[L.itemId] = { t: now().toISOString(), title: L.title.slice(0, 120), ...extra }; };
      if (L.currency && L.currency !== "AUD") { mark({ skip: "currency" }); continue; }
      if (!Number.isFinite(L.price)) { mark({ skip: "no price" }); continue; }
      const bad = containsAny(L.title, [...(eb.exclude_keywords || []), ...(term.exclude || [])]);
      if (bad) { mark({ skip: `excluded: ${bad}` }); continue; }
      const fb = Number(L.seller?.feedbackPercentage);
      if (Number.isFinite(fb) && fb < eb.min_seller_feedback_pct) { mark({ skip: `seller ${fb}%` }); continue; }

      let postage = cheapestPostage(L.shippingOptions);
      if (postage === null) {
        try { postage = cheapestPostage((await client.getItem(L.itemId)).shippingOptions); }
        catch (e) { if (e instanceof BudgetError) { mark(); break outer; } log(`item detail failed for ${L.itemId}: ${e.message}`); }
      }
      L.postage = postage;
      const comp = await engine.lookup(L.title, term);
      const d = evaluateListing(L, comp, term, eb, cfg.comps, now(), cfg.timezone);
      mark({ landed: d.landed, alerted: d.shouldAlert ? 1 : 0 });
      if (!comp) {
        nocomp.push({ itemId: L.itemId, title: L.title, landed: d.landed, url: L.url, seenAt: now().toISOString(), q: term.q });
        out.noComp++;
        continue;
      }
      if (d.shouldAlert) {
        const m = formatEbayAlert(L, comp, d, eb, cfg.timezone);
        await alerter.alert({ kind: "ebay", key: L.itemId, title: m.title, body: m.body, url: L.url, priority: d.verdict === "BUY" ? "high" : "low", tags: d.verdict === "BUY" ? "moneybag" : "hourglass" });
        out.alerts++;
      }
    }
  }

  // retention purge
  const cutoff = now().getTime() - eb.retention_days * 86400000;
  for (const [id, v] of Object.entries(st.seen)) if (new Date(v.t).getTime() < cutoff) delete st.seen[id];
  const old = utcDay(new Date(now().getTime() - 10 * 86400000));
  for (const k of Object.keys(st.calls)) if (k < old) delete st.calls[k];
  for (const k of Object.keys(st.callsLocal)) if (k < old) delete st.callsLocal[k];
  out.callsToday = st.calls[day] || 0;
  out.preview = alerter.sentPreview;

  if (!dryRun) {
    await store.set("ebay-state", st);
    if (engine.dirty) await store.set("comps-cache", compsCache);
    await store.set("tracker-polite", trackerPolite);
    await store.set("tcgprices-usage", tcgCounter);
    await store.set("nocomp", clampList(nocomp.filter((n) => new Date(n.seenAt).getTime() >= cutoff), 300));
    await alerter.save();
  }
  log(`eBay: ${out.polled} searches, ${out.newItems} new items, ${out.alerts} alerts, ${out.noComp} no-comp, ${out.callsToday} calls today`);
  return out;
}

/* ----------------------------- Retail job ----------------------------- */
export async function runRetail({ store, env, now = () => new Date(), dryRun = false, force = false, only = null, fetchImpl = fetch, random = Math.random } = {}) {
  const lines = [];
  const log = makeLogger(lines);
  const started = Date.now();
  const cfg = withDefaults(await store.get("config"));
  const r = cfg.retailers;
  const out = { checked: 0, alerts: 0, log: lines, results: [], preview: [] };
  if (cfg.paused && !force) { log("paused - skipping retailers"); return out; }
  if (!r.enabled && !force) { log("retail watcher disabled"); return out; }
  const st = await store.get("retail-state", { next: {}, prices: {}, lastAlert: {}, polite: {}, checks: {} });
  for (const k of ["next", "prices", "lastAlert", "polite", "checks"]) st[k] ||= {};
  const alerter = await new Alerter({ store, env, cfg, source: "retail", now, dryRun, fetchImpl, log }).load();
  const day = localParts(cfg.timezone, now()).date;

  const perRetailer = {};
  for (const w of r.watches) perRetailer[w.retailer] = (perRetailer[w.retailer] || 0) + 1;

  for (const [i, w] of r.watches.entries()) {
    if (only !== null && only !== i) continue;
    if (Date.now() - started > TIME_BUDGET_MS) { log("time budget used - remaining watches next run"); break; }
    const site = r.sites[w.retailer];
    if (!site) { log(`unknown retailer ${w.retailer}`); continue; }
    if (site.enabled === false) continue;
    const key = `${w.retailer}|${w.query}`;
    if (!force && st.next[key] && new Date(st.next[key]) > now()) continue;

    const cap = site.daily_cap || r.daily_cap_per_retailer;
    const polite = new PoliteFetcher(st.polite, {
      name: w.retailer, label: site.label, userAgent: r.user_agent, dailyCap: cap,
      ignoreRobots: !!site.ignore_robots, fetch: fetchImpl, now, log,
      notify: (title, body) => alerter.notice(title, body),
    });
    const res = await fetchProducts(site, w.query, polite);
    const drop = inDropWindow(w, now());
    // Spread the daily cap across all watches for this retailer.
    const minInterval = (perRetailer[w.retailer] * 1440) / cap;
    const base = drop ? r.drop_interval_minutes : Math.max(w.interval_minutes || r.default_interval_minutes, minInterval);
    const jitter = drop ? 0 : random() * (r.jitter_minutes || 0);
    st.next[key] = new Date(now().getTime() + (base + jitter) * 60000).toISOString();
    st.checks[day] = (st.checks[day] || 0) + 1;
    out.checked++;
    const summary = { watch: key, via: res.via || null, found: res.products?.length ?? null, notes: res.notes, matches: [] };
    if (res.products === null) { log(`[${w.retailer}] ${res.notes.join("; ")}`); out.results.push(summary); continue; }
    if (!res.products.length) log(`[${w.retailer}] no products for "${w.query}": ${res.notes.join("; ")}`);
    const alerts = evaluateWatch(w, w.retailer, site, res.products, st.prices, st.lastAlert, r, now());
    summary.matches = Object.entries(st.prices).filter(([k]) => k.startsWith(`${w.retailer}|`)).slice(-10).map(([, v]) => ({ name: v.name, price: v.price, inStock: v.inStock }));
    out.results.push(summary);
    for (const a of alerts) { await alerter.alert(a); out.alerts++; }
  }
  for (const k of Object.keys(st.checks)) if (k < utcDay(new Date(now().getTime() - 10 * 86400000))) delete st.checks[k];
  out.preview = alerter.sentPreview;
  if (!dryRun) { await store.set("retail-state", st); await alerter.save(); }
  log(`retail: ${out.checked} checks, ${out.alerts} alerts`);
  return out;
}

/* ---------------------- Hourly: summary + heartbeat --------------------- */
export async function runHourly({ store, env, now = () => new Date(), fetchImpl = fetch, forceHeartbeat = false } = {}) {
  const lines = [];
  const log = makeLogger(lines);
  const cfg = withDefaults(await store.get("config"));
  const meta = await store.get("meta", {});
  const send = (msg) => sendNtfy(env, msg, fetchImpl);

  // 1. flush rate-limited alerts as one summary
  const queued = [];
  for (const src of ["ebay", "retail"]) {
    const q = await store.get(`queue-${src}`, []);
    if (q.length) { queued.push(...q); await store.set(`queue-${src}`, []); }
  }
  if (queued.length) {
    const body = queued.map((a) => `- ${a.title}\n  ${(a.body.split("\n")[0] || "")}\n  ${a.url || ""}`).join("\n").slice(0, 3800);
    try { await send({ title: `${queued.length} more alerts (rate limit)`, body, priority: "high", tags: "package" }); log(`sent summary of ${queued.length} queued alerts`); }
    catch (e) { log(`summary send failed: ${e.message}`); }
  }

  // 2. daily heartbeat at the configured local hour
  const lp = localParts(cfg.timezone, now());
  if (forceHeartbeat || (lp.hour === cfg.alerts.heartbeat_hour && meta.heartbeatDate !== lp.date)) {
    const yday = localParts(cfg.timezone, new Date(now().getTime() - 86400000)).date;
    const eb = await store.get("ebay-state", { callsLocal: {} });
    const rt = await store.get("retail-state", { checks: {} });
    const stale = staleComps(cfg.comps.manual, await store.get("comps-cache", {}), cfg.comps.comp_stale_days, now());
    const blocks = Object.entries(rt.polite?.blocks || {}).filter(([, b]) => b.until && new Date(b.until) > now()).map(([k]) => k);
    const body = [
      `alive, ${eb.callsLocal?.[yday] || 0} eBay calls yesterday, ${rt.checks?.[yday] || 0} retailer checks, ${stale.length} stale comps${stale.length ? `: ${stale.join(", ")}` : ""}`,
      ...(blocks.length ? [`currently backing off: ${blocks.join(", ")}`] : []),
      ...(cfg.paused ? ["NOTE: app is PAUSED (dashboard > Settings)"] : []),
    ].join("\n");
    try { await send({ title: "Card Deal Sniper heartbeat", body, priority: "low", tags: "heartbeat" }); meta.heartbeatDate = lp.date; log("heartbeat sent"); }
    catch (e) { log(`heartbeat failed: ${e.message}`); }
  }
  meta.lastHourly = now().toISOString();
  await store.set("meta", meta);
  return { log: lines, queued: queued.length };
}

/* ------------------------- Shared comp engine ------------------------- */
async function makeEngine({ store, env, cfg, alerter, now, fetchImpl, log, ebayClient = null }) {
  const compsCache = await store.get("comps-cache", {});
  const trackerPolite = await store.get("tracker-polite", {});
  const tcgCounter = await store.get("tcgprices-usage", {});
  const providers = [];
  if (ebayClient && cfg.comps.marketplace_insights_enabled) providers.push(marketplaceInsightsProvider(ebayClient, cfg.comps));
  providers.push(...buildSharedProviders(cfg, env, { trackerPolite, alerter, now, fetchImpl, log, tcgCounter }));
  const engine = new CompsEngine({ manual: cfg.comps.manual, cache: compsCache, providers, cs: cfg.comps, now: now(), tz: cfg.timezone, log });
  engine.persist = async () => {
    if (engine.dirty) await store.set("comps-cache", compsCache);
    await store.set("tracker-polite", trackerPolite);
    await store.set("tcgprices-usage", tcgCounter);
  };
  return engine;
}

function stockSettings(cfg) {
  return { fee_rate: cfg.ebay.fee_rate, outbound_postage: cfg.ebay.outbound_postage, ...cfg.stock };
}

/* --------------------------- Stock: refresh --------------------------- */
// Looks up a current AU comp for every item you still hold and stores it on the item.
export async function refreshStock({ store, env, now = () => new Date(), fetchImpl = fetch, ids = null } = {}) {
  const lines = [];
  const log = makeLogger(lines);
  const cfg = withDefaults(await store.get("config"));
  const items = await store.get("stock", []);
  const alerter = await new Alerter({ store, env, cfg, source: "ebay", now, dryRun: true, fetchImpl, log }).load();
  let ebayClient = null;
  if (cfg.comps.marketplace_insights_enabled && env.EBAY_CLIENT_ID) {
    const storeCalls = await store.get("store-calls", {});
    const es = await store.get("ebay-state", { calls: {} });
    const day = utcDay(now());
    ebayClient = new EbayClient({ clientId: env.EBAY_CLIENT_ID, clientSecret: env.EBAY_CLIENT_SECRET, postcode: cfg.ebay.postcode, fetchImpl, log,
      budget: { cap: cfg.ebay.daily_call_cap, used: () => (es.calls?.[day] || 0) + (storeCalls[day] || 0), inc: () => { storeCalls[day] = (storeCalls[day] || 0) + 1; } } });
    ebayClient._save = () => store.set("store-calls", storeCalls);
  }
  const engine = await makeEngine({ store, env, cfg, alerter, now, fetchImpl, log, ebayClient });
  let updated = 0;
  for (const it of items) {
    if (it.status === "sold" || (ids && !ids.includes(it.id))) continue;
    const q = compQueryFor(it);
    if (!q) continue;
    const comp = await engine.resolve(q, matchManual(q, cfg.comps.manual));
    it.market = comp ? { comp_aud: comp.comp_aud, label: comp.label, source: comp.source, sample: comp.sample ?? null, as_of: comp.as_of, style: comp.style } : null;
    it.market_checked = now().toISOString();
    updated++;
  }
  await engine.persist();
  if (ebayClient?._save) await ebayClient._save();
  await store.set("stock", items);
  log(`stock: refreshed ${updated} items`);
  return { updated, log: lines };
}

export function stockWithPricing(items, cfg) {
  const s = stockSettings(cfg);
  return items.map((it) => ({ ...it, pricing: pricing(it, it.market?.comp_aud ?? null, s) }));
}

/* ------------------------- My eBay store watch ------------------------ */
export async function runStoreWatch({ store, env, now = () => new Date(), fetchImpl = fetch, force = false, dryRun = false } = {}) {
  const lines = [];
  const log = makeLogger(lines);
  const cfg = withDefaults(await store.get("config"));
  const ms = cfg.my_store;
  const out = { checked: 0, alerts: 0, listings: [], log: lines, preview: [], errors: [] };
  if (!force && (cfg.paused || !ms.enabled)) return out;
  if (!ms.seller_username) { out.errors.push("Set your eBay seller username in Settings first."); return out; }
  const st = await store.get("store-state", { lastRun: null, lastAlert: {}, listings: [] });
  st.lastAlert ||= {};
  if (!force && st.lastRun && now() - new Date(st.lastRun) < ms.interval_hours * 3600000 - 120000) return out;

  const storeCalls = await store.get("store-calls", {});
  const es = await store.get("ebay-state", { calls: {} });
  const day = utcDay(now());
  const alerter = await new Alerter({ store, env, cfg, source: "ebay", now, dryRun, fetchImpl, log }).load();
  let client;
  try {
    client = new EbayClient({ clientId: env.EBAY_CLIENT_ID, clientSecret: env.EBAY_CLIENT_SECRET, postcode: cfg.ebay.postcode, fetchImpl, log,
      budget: { cap: cfg.ebay.daily_call_cap, used: () => (es.calls?.[day] || 0) + (storeCalls[day] || 0), inc: () => { storeCalls[day] = (storeCalls[day] || 0) + 1; } } });
  } catch (e) { out.errors.push(e.message); return out; }

  // Fetch all your live fixed-price listings (public data), up to 3 pages of 200.
  const raw = [];
  try {
    for (let page = 0; page < 3; page++) {
      const r = await client.search(ms.search_q || "pokemon", 200, { filter: `sellers:{${ms.seller_username.trim()}},buyingOptions:{FIXED_PRICE}`, offset: page * 200, sort: "" });
      raw.push(...r.items);
      if (raw.length >= r.total || r.items.length < 200) break;
    }
  } catch (e) { log(`store fetch failed: ${e.message}`); out.errors.push(e.message); await store.set("store-calls", storeCalls); return out; }

  const engine = await makeEngine({ store, env, cfg, alerter, now, fetchImpl, log, ebayClient: client });
  const stock = await store.get("stock", []);
  const s = stockSettings(cfg);
  let stockChanged = false;

  for (const sItem of raw) {
    const L = toListing(sItem);
    const post = cheapestPostage(L.shippingOptions);
    // link to a Stock item: explicit item id first, then title match
    let linked = stock.find((it) => it.ebay_item_id && (it.ebay_item_id === L.itemId || L.itemId.includes(`|${it.ebay_item_id}|`)));
    if (!linked) linked = stock.find((it) => it.status !== "sold" && !it.ebay_item_id && compQueryFor(it) && containsAllTokens(L.title, compQueryFor(it)));
    if (linked && (linked.status !== "listed" || linked.list_price !== L.price || !linked.ebay_item_id)) {
      linked.status = "listed"; linked.list_price = L.price; linked.ebay_item_id ||= L.itemId; linked.ebay_url = L.url; stockChanged = true;
    }
    const q = linked ? compQueryFor(linked) : matchManual(L.title, cfg.comps.manual)?.name || null;
    const comp = q ? await engine.resolve(q, matchManual(q, cfg.comps.manual)) : null;
    const pr = linked ? pricing(linked, comp?.comp_aud ?? null, s) : null;
    const adv = priceAdvice(L.price, comp?.comp_aud ?? null, pr?.breakeven ?? null, ms.adjust_threshold_pct);
    const row = { itemId: L.itemId, title: L.title, price: L.price, postage: post, url: L.url, linkedId: linked?.id || null,
      cost: pr?.cost ?? null, breakeven: pr?.breakeven ?? null, market: comp?.comp_aud ?? null, compLabel: comp ? compLine(comp, localAgeDays(comp.as_of, now(), cfg.timezone)) : null, ...adv };
    out.listings.push(row);
    out.checked++;

    if (["LOWER", "RAISE", "BELOW_COST"].includes(adv.action)) {
      const ak = `${L.itemId}|${adv.action}`;
      const prev = st.lastAlert[ak];
      if (prev && prev.price === L.price && now() - new Date(prev.at) < ms.cooldown_hours * 3600000) continue;
      st.lastAlert[ak] = { at: now().toISOString(), price: L.price };
      const net = (p) => p * (1 - s.fee_rate) - s.outbound_postage;
      const profitAt = (p) => (pr ? ` (profit ~${moneyShort(Math.round(net(p) - pr.cost))})` : "");
      const body = [
        `Your price: ${money(L.price)}${Number.isFinite(post) ? ` + post ${moneyShort(post)}` : ""}${profitAt(L.price)}`,
        row.compLabel ? row.compLabel.replace(/^Comp/, "Market") : "",
        pr ? `Break-even: ${money(pr.breakeven)} (cost ${money(pr.cost)} + ${Math.round(s.fee_rate * 100)}% fees + ${money(s.outbound_postage)} post)` : "Not linked to a Stock item - break-even unknown",
        `-> ${adv.action === "BELOW_COST" ? "RAISE NOW" : adv.action} to ${money(adv.suggested)}${profitAt(adv.suggested)}`,
        `Why: ${adv.reason}`,
        comp?.source === "tcgprices" ? "Prices from TCG Prices AU (tcgprices.com.au)" : "",
        "", L.url,
      ].filter((x) => x !== "").join("\n");
      await alerter.alert({ kind: "store", key: ak, title: `PRICE CHECK: ${L.title}`, body, url: L.url, priority: adv.action === "BELOW_COST" ? "urgent" : "default", tags: adv.action === "RAISE" ? "chart_with_upwards_trend" : "chart_with_downwards_trend" });
      out.alerts++;
    }
  }
  out.preview = alerter.sentPreview;
  if (!dryRun) {
    st.lastRun = now().toISOString();
    st.listings = out.listings;
    await store.set("store-state", st);
    await store.set("store-calls", storeCalls);
    if (stockChanged) await store.set("stock", stock);
    await engine.persist();
    await alerter.save();
  }
  log(`store: ${out.checked} listings checked, ${out.alerts} price alerts`);
  return out;
}
