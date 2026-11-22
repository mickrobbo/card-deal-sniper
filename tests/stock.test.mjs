import { test } from "node:test";
import assert from "node:assert/strict";
import { pricing, priceAdvice, niceListPrice, unitCost, totals, isSealedName, compQueryFor } from "../lib/inventory.mjs";
import { medianSold, extractTcgPrice, tcgPricesProvider, CompsEngine } from "../lib/comps.mjs";
import { localAgeDays, fmtLocal, trimOutliers } from "../lib/util.mjs";
import { DEFAULT_CONFIG } from "../lib/config.mjs";
import { MemoryStore } from "../lib/store.mjs";
import { runStoreWatch, refreshStock } from "../lib/core.mjs";

const s = { fee_rate: 0.13, outbound_postage: 9.5, target_profit_pct: 0.2, target_profit_min: 5 };

test("cost basis includes inbound shipping split across qty", () => {
  assert.equal(unitCost({ paid_each: 40, shipping_in: 10, qty: 2 }), 45);
  assert.equal(unitCost({ paid_each: 40, shipping_in: 5 }), 45);
});

test("break-even and recommended price after 13% fees + postage", () => {
  const p = pricing({ paid_each: 40, shipping_in: 5 }, 90, s);
  assert.equal(p.cost, 45);
  assert.equal(p.breakeven, 62.64);          // (45 + 9.5) / 0.87
  assert.equal(p.recommended, 90.95);        // market, rounded to .95
  assert.equal(p.netAtRecommended, 69.63);   // 90.95 * 0.87 - 9.5
  assert.equal(p.profitAtRecommended, 24.63);
});

test("market under break-even -> recommend break-even with a warning", () => {
  const p = pricing({ paid_each: 40, shipping_in: 5 }, 50, s);
  assert.equal(p.basis, "break-even");
  assert.equal(p.recommended, 62.95);
  assert.ok(p.warning);
});

test("no comp -> target profit price", () => {
  const p = pricing({ paid_each: 40, shipping_in: 5 }, null, s);
  assert.equal(p.target, 72.99); // (45 + 9.5 + 9) / 0.87
  assert.equal(p.recommended, 73.95);
});

test("sold item shows realised profit and ROI; totals add up", () => {
  const items = [
    { paid_each: 40, shipping_in: 5, status: "sold", sold_price: 100 },
    { paid_each: 20, shipping_in: 0, qty: 2, status: "holding", market: { comp_aud: 35 } },
  ];
  const p = pricing(items[0], null, s);
  assert.equal(p.realised, 32.5); // 100*.87 - 9.5 - 45
  assert.equal(p.roi, 72);
  const t = totals(items, s);
  assert.deepEqual(t, { invested: 40, holdingValue: 70, realised: 32.5, holdingCount: 2, soldCount: 1 });
});

test("nice list price", () => {
  assert.equal(niceListPrice(72.31), 72.95);
  assert.equal(niceListPrice(72.96), 73.95);
});

test("price advice: lower, raise, below cost, ok", () => {
  assert.equal(priceAdvice(100, 80, 60, 8).action, "LOWER");
  assert.equal(priceAdvice(100, 80, 60, 8).suggested, 80.95);
  assert.equal(priceAdvice(60, 80, 50, 8).action, "RAISE");
  assert.equal(priceAdvice(55, 80, 60, 8).action, "BELOW_COST");
  assert.equal(priceAdvice(82, 80, 60, 8).action, "OK");
  // market crashed below break-even: lower only to break-even, never below
  const a = priceAdvice(100, 40, 62.64, 8);
  assert.equal(a.action, "LOWER");
  assert.equal(a.suggested, 62.95);
  assert.equal(priceAdvice(100, null, 60).action, "NO_COMP");
});

test("sealed detection and comp query from stock fields", () => {
  assert.ok(isSealedName("Prismatic Evolutions Elite Trainer Box", DEFAULT_CONFIG.catalog));
  assert.ok(isSealedName("151 ETB", DEFAULT_CONFIG.catalog));
  assert.ok(!isSealedName("Charizard ex 199/165", DEFAULT_CONFIG.catalog));
  assert.equal(compQueryFor({ set: "151", name: "Charizard ex", number: "199/165", grade: "PSA 10" }), "151 Charizard ex 199/165 PSA 10");
  assert.equal(compQueryFor({ set: "151", name: "Charizard ex", grade: "Raw" }), "151 Charizard ex");
});

const now = new Date("2026-11-23T00:00:00Z");
const sale = (title, v, date, extra = {}) => ({ title, lastSoldPrice: { value: String(v), currency: "AUD" }, lastSoldDate: date, buyingOptions: ["FIXED_PRICE"], itemLocation: { country: "AU" }, ...extra });

test("AU sold median filters graded, empties, other countries, wrong titles, outliers", () => {
  const filters = DEFAULT_CONFIG.comps.sold_filters;
  const sales = [
    sale("Pokemon 151 Charizard ex 199/165 NM", 300, "2026-11-20T00:00:00Z"),
    sale("151 Charizard ex 199/165 near mint", 310, "2026-11-21T00:00:00Z"),
    sale("Charizard ex 199/165 151 SIR", 320, "2026-11-22T00:00:00Z"),
    sale("Charizard ex 199/165 151", 305, "2026-11-19T00:00:00Z"),
    sale("Charizard ex 199/165 151", 2000, "2026-11-19T00:00:00Z"), // outlier
    sale("PSA 10 Charizard ex 199/165 151", 900, "2026-11-22T00:00:00Z"), // graded
    sale("Charizard ex 199/165 151", 280, "2026-11-22T00:00:00Z", { itemLocation: { country: "US" } }),
    sale("Charizard ex 151 proxy 199/165", 5, "2026-11-22T00:00:00Z"),
    sale("Pikachu 151", 10, "2026-11-22T00:00:00Z"),
  ];
  const r = medianSold(sales, now, { query: "151 Charizard ex 199/165", filters });
  assert.equal(r.count, 4);
  assert.equal(r.median, 307.5);
  assert.equal(r.trimmed, 1);
  assert.equal(r.excludedNotAU, 1);
  assert.equal(r.lastSold, "2026-11-22T00:00:00.000Z");
  // asking for PSA 10 keeps the slab
  assert.equal(medianSold(sales, now, { query: "Charizard ex 199/165 PSA 10", filters }).median, 900);
});

test("TCG Prices AU response parsing (guessed shapes + configured paths)", () => {
  assert.deepEqual(
    extractTcgPrice({ results: [{ name: "Charizard ex 199/165", prices: { median: "305.00" }, salesCount: 14, lastSold: "2026-11-22" }] }, "charizard ex 199/165"),
    { comp_aud: 305, sample: 14, last_sold: "2026-11-22", matched: "Charizard ex 199/165" },
  );
  assert.equal(extractTcgPrice({ results: [{ name: "Pikachu", median: 5 }] }, "charizard"), null);
  const custom = extractTcgPrice({ data: { hits: [{ t: "151 ETB", stats: { m: 120 } }] } }, "151 etb", { items_path: "data.hits", name: "t", price: "stats.m" });
  assert.equal(custom.comp_aud, 120);
});

test("TCG Prices AU provider: key header, monthly cap, min sales", async () => {
  const counter = {};
  let seen;
  const f = async (url, init) => { seen = { url, key: init.headers["X-API-Key"] }; return new Response(JSON.stringify({ results: [{ name: "151 Elite Trainer Box", median: 120, sales: 9 }] }), { status: 200 }); };
  const cfg = { ...DEFAULT_CONFIG.comps.tcgprices_api, monthly_cap: 1 };
  const p = tcgPricesProvider(cfg, { apiKey: "tcgau_x", counter, fetchImpl: f, isSealed: () => true, now: () => now });
  const r = await p.fetch("151 Elite Trainer Box");
  assert.equal(r.comp_aud, 120);
  assert.equal(seen.key, "tcgau_x");
  assert.match(seen.url, /\/api\/v1\/sealed\?q=151\+Elite\+Trainer\+Box/);
  await assert.rejects(() => p.fetch("151 Elite Trainer Box"), /monthly cap/);
});

test("TCG Prices AU comps are never cached past 24h (their terms)", async () => {
  const cache = { "151 elite trainer box": { comp_aud: 100, source: "tcgprices", label: "TCG Prices AU", fetched_at: "2026-11-21T20:00:00Z" } };
  let calls = 0;
  const e = new CompsEngine({ manual: [], cache, cs: { ...DEFAULT_CONFIG.comps, comp_cache_hours: 72 }, now, providers: [{ name: "tcgprices", label: "TCG Prices AU", fetch: async () => { calls++; return { comp_aud: 110 }; } }] });
  const c = await e.resolve("151 Elite Trainer Box", null);
  assert.equal(calls, 1);
  assert.equal(c.comp_aud, 110);
});

test("local (AEST/AEDT) day ages and time format", () => {
  // 22 Nov 13:30Z = 23 Nov 00:30 AEDT, so a comp from 22 Nov 12:00Z (23:00 AEDT 22 Nov) is "1 day" old
  assert.equal(localAgeDays("2026-11-22T12:00:00Z", new Date("2026-11-22T13:30:00Z"), "Australia/Sydney"), 1);
  assert.equal(localAgeDays("2026-11-22T12:00:00Z", new Date("2026-11-22T13:30:00Z"), "UTC"), 0);
  assert.match(fmtLocal("2026-11-22T22:14:00Z", "Australia/Sydney"), /^23 Nov 9:14\s?am AEDT$/);
  assert.match(fmtLocal("2026-11-22T22:14:00Z", "Australia/Brisbane"), /^23 Nov 8:14\s?am AEST$/);
  assert.deepEqual(trimOutliers([10, 11, 12, 13, 100]), [10, 11, 12, 13]);
});

/* ---- store watch end-to-end ---- */
const env = { EBAY_CLIENT_ID: "id", EBAY_CLIENT_SECRET: "secret", NTFY_TOPIC: "t", TCGPRICES_API_KEY: "tcgau_k" };
function fakeNet(listings, sent, seenUrls = []) {
  return async (url, init = {}) => {
    url = String(url); seenUrls.push(url);
    if (url.includes("/oauth2/token")) return new Response(JSON.stringify({ access_token: "t", expires_in: 7200 }));
    if (url.includes("item_summary/search")) return new Response(JSON.stringify({ total: listings.length, itemSummaries: listings }));
    if (url.includes("tcgprices.com.au")) return new Response(JSON.stringify({ results: [{ name: "151 Charizard ex 199/165", median: 300, sales: 12 }] }));
    if (url.startsWith("https://ntfy.sh/")) { sent.push({ title: init.headers.Title, body: init.body, priority: init.headers.Priority }); return new Response("{}"); }
    throw new Error("unexpected " + url);
  };
}

test("store watch: links stock, alerts LOWER with profit maths, respects cooldown", async () => {
  const store = new MemoryStore({
    config: { my_store: { enabled: true, seller_username: "mickscards" } },
    stock: [{ id: "s1", set: "151", name: "Charizard ex", number: "199/165", paid_each: 200, shipping_in: 10, status: "holding" }],
  });
  const sent = [], urls = [];
  const listing = { itemId: "v1|123|0", title: "Pokemon 151 Charizard ex 199/165 SIR NM", price: { value: "380.00", currency: "AUD" }, itemWebUrl: "https://www.ebay.com.au/itm/123", shippingOptions: [{ shippingCost: { value: "0.00" } }] };
  const out = await runStoreWatch({ store, env, now: () => now, fetchImpl: fakeNet([listing], sent, urls) });
  assert.ok(urls.some((u) => decodeURIComponent(u).includes("sellers:{mickscards}")));
  assert.equal(out.listings[0].action, "LOWER");
  assert.equal(out.listings[0].suggested, 300.95);
  assert.equal(sent.length, 1);
  assert.match(sent[0].title, /PRICE CHECK/);
  assert.match(sent[0].body, /Break-even: \$252\.30/); // (210 + 9.5) / 0.87
  assert.match(sent[0].body, /-> LOWER to \$300\.95 \(profit ~\$42\)/);
  assert.match(sent[0].body, /Prices from TCG Prices AU/);
  const stock = await store.get("stock");
  assert.equal(stock[0].status, "listed");
  assert.equal(stock[0].list_price, 380);
  // forced rerun inside cooldown with same price: no repeat alert
  await runStoreWatch({ store, env, now: () => new Date(now.getTime() + 3600e3), fetchImpl: fakeNet([listing], sent), force: true });
  assert.equal(sent.length, 1);
});

test("stock refresh stores AU comp on held items only", async () => {
  const store = new MemoryStore({ stock: [
    { id: "a", set: "151", name: "Charizard ex", number: "199/165", paid_each: 200, status: "holding" },
    { id: "b", set: "151", name: "Charizard ex", number: "199/165", paid_each: 200, status: "sold", sold_price: 320 },
  ] });
  await refreshStock({ store, env, now: () => now, fetchImpl: fakeNet([], []) });
  const st = await store.get("stock");
  assert.equal(st[0].market.comp_aud, 300);
  assert.equal(st[0].market.sample, 12);
  assert.equal(st[1].market, undefined);
});
