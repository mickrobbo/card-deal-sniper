import { test } from "node:test";
import assert from "node:assert/strict";
import { matchManual, medianSold, CompsEngine, staleComps } from "../lib/comps.mjs";
import { DEFAULT_CONFIG } from "../lib/config.mjs";

const cs = DEFAULT_CONFIG.comps;
const manual = [
  { name: "Mewtwo ex", match_keywords: ["mewtwo ex"], comp_aud: 30, comp_date: "2026-11-01" },
  { name: "Mewtwo ex 151/128", match_keywords: ["mewtwo ex 151/128"], comp_aud: 47, comp_date: "2026-11-03" },
];
const now = new Date("2026-11-23T00:00:00Z");

test("fuzzy match normalises punctuation and picks the longest keyword", () => {
  assert.equal(matchManual("MEWTWO EX - 151/128 Holo!!", manual).name, "Mewtwo ex 151/128");
  assert.equal(matchManual("Mewtwo-ex promo", manual).name, "Mewtwo ex");
  assert.equal(matchManual("Pikachu", manual), null);
});

test("median sold excludes Best Offer sales and old sales", () => {
  const sales = [
    { lastSoldPrice: { value: "40", currency: "AUD" }, lastSoldDate: "2026-11-20T00:00:00Z", buyingOptions: ["FIXED_PRICE"] },
    { lastSoldPrice: { value: "50", currency: "AUD" }, lastSoldDate: "2026-11-21T00:00:00Z", buyingOptions: ["FIXED_PRICE"] },
    { lastSoldPrice: { value: "60", currency: "AUD" }, lastSoldDate: "2026-11-22T00:00:00Z", buyingOptions: ["FIXED_PRICE"] },
    { lastSoldPrice: { value: "999", currency: "AUD" }, lastSoldDate: "2026-11-22T00:00:00Z", buyingOptions: ["FIXED_PRICE", "BEST_OFFER"] },
    { lastSoldPrice: { value: "5", currency: "AUD" }, lastSoldDate: "2026-09-01T00:00:00Z", buyingOptions: ["FIXED_PRICE"] },
  ];
  const r = medianSold(sales, now);
  assert.equal(r.median, 50);
  assert.equal(r.count, 3);
  assert.equal(r.excludedBestOffer, 1);
  assert.equal(medianSold(sales, now, { excludeBestOffer: false }).median, 55);
});

const provider = (name, val, calls) => ({ name, label: name, async fetch() { calls.push(name); if (val instanceof Error) throw val; return val; } });

test("provider fallback: failing source -> next source; result cached", async () => {
  const calls = [];
  const cache = {};
  const e = new CompsEngine({ manual, cache, cs, now, providers: [provider("mi", new Error("403"), calls), provider("tracker", { comp_aud: 52 }, calls)] });
  const c = await e.lookup("Mewtwo ex 151/128 PSA", {});
  assert.deepEqual(calls, ["mi", "tracker"]);
  assert.equal(c.comp_aud, 52); // fetched today is fresher than manual (Nov 3)
  assert.equal(c.source, "tracker");
  // second lookup hits the cache, no provider calls
  const c2 = await e.lookup("mewtwo ex 151/128", {});
  assert.equal(c2.comp_aud, 52);
  assert.equal(calls.length, 2);
});

test("all providers empty -> manual file fallback; negative result cached", async () => {
  const calls = [];
  const cache = {};
  const e = new CompsEngine({ manual, cache, cs, now, providers: [provider("tracker", null, calls)] });
  const c = await e.lookup("Mewtwo ex 151/128", {});
  assert.equal(c.comp_aud, 47);
  assert.equal(c.label, "manual file");
  await e.lookup("Mewtwo ex 151/128", {});
  assert.equal(calls.length, 1);
});

test("manual comp newer than cached fetch wins", async () => {
  const cache = { "mewtwo ex 151 128": { comp_aud: 40, label: "old tracker", fetched_at: "2026-11-02T00:00:00Z" } };
  const e = new CompsEngine({ manual, cache, cs: { ...cs, comp_cache_hours: 24 * 365 }, now, providers: [provider("x", null, [])] });
  const c = await e.lookup("Mewtwo ex 151/128", {});
  assert.equal(c.comp_aud, 47);
});

test("no manual match and no comp_query -> no comp", async () => {
  const e = new CompsEngine({ manual, cache: {}, cs, now, providers: [] });
  assert.equal(await e.lookup("random bulk lot", {}), null);
});

test("stale comps listed for heartbeat", () => {
  assert.deepEqual(staleComps(manual, {}, 14, now), ["Mewtwo ex", "Mewtwo ex 151/128"]);
});
