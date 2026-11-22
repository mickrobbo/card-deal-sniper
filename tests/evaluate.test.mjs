import { test } from "node:test";
import assert from "node:assert/strict";
import { cheapestPostage, landedPrice, netResale, evaluateListing, formatEbayAlert } from "../lib/evaluate.mjs";
import { DEFAULT_CONFIG } from "../lib/config.mjs";

const eb = DEFAULT_CONFIG.ebay;
const cs = DEFAULT_CONFIG.comps;
const now = new Date("2026-11-23T00:00:00Z");
const listing = (o = {}) => ({ itemId: "1", title: "Pokemon Mega Evolution Booster Bundle", price: 59, postage: 9, url: "https://ebay.com.au/itm/1", buyingOptions: ["FIXED_PRICE"], ...o });
const comp = (o = {}) => ({ comp_aud: 95, label: "tcgprices.com.au", as_of: "2026-11-22T00:00:00Z", style: "ago", ...o });

test("cheapest postage picks the lowest known cost, null when none", () => {
  assert.equal(cheapestPostage([{ shippingCost: { value: "12.00" } }, { shippingCost: { value: "9.00" } }]), 9);
  assert.equal(cheapestPostage([{ shippingCost: { value: "0.00" } }]), 0);
  assert.equal(cheapestPostage([{ shippingCostType: "CALCULATED" }]), null);
  assert.equal(cheapestPostage(undefined), null);
});

test("landed = item + postage; unknown postage uses flat estimate and is flagged", () => {
  assert.deepEqual(landedPrice(59, 9, 10), { landed: 68, postage: 9, postageUnknown: false });
  assert.deepEqual(landedPrice(59, null, 10), { landed: 69, postage: 10, postageUnknown: true });
});

test("net resale = comp x (1 - fee) - outbound postage", () => {
  assert.equal(netResale(95, 0.13, 9.5), 73.15);
});

test("brief example: $68 landed vs $95 comp -> ~$5 profit -> WAIT", () => {
  const d = evaluateListing(listing(), comp(), { min_profit: 20 }, eb, cs, now);
  assert.equal(d.landed, 68);
  assert.equal(d.profit, 5.15);
  assert.equal(d.verdict, "WAIT");
  assert.equal(d.shouldAlert, false);
  const m = formatEbayAlert(listing(), comp(), d, eb);
  assert.match(m.body, /^Landed: \$68\.00 \(item \$59 \+ post \$9\)/);
  assert.match(m.body, /Comp: \$95\.00 \(tcgprices\.com\.au, 1 day ago\)/);
  assert.match(m.body, /Net after 13% fees \+ \$9\.50 post: ~\$73/);
  assert.match(m.body, /Est profit: ~\$5 -> WAIT \(under \$20 bar\)/);
});

test("passing deal says BUY and alerts", () => {
  const d = evaluateListing(listing({ price: 35, postage: 7 }), comp(), { min_profit: 20 }, eb, cs, now);
  assert.equal(d.profit, 31.15);
  assert.equal(d.verdict, "BUY");
  assert.ok(d.shouldAlert);
  assert.match(formatEbayAlert(listing({ price: 35, postage: 7 }), comp(), d, eb).body, /Est profit: ~\$31 -> BUY/);
});

test("postage unknown: estimate added and flagged in the alert", () => {
  const L = listing({ price: 30, postage: null });
  const d = evaluateListing(L, comp(), { min_profit: 20 }, eb, cs, now);
  assert.equal(d.landed, 40);
  assert.ok(d.postageUnknown);
  assert.match(formatEbayAlert(L, comp(), d, eb).body, /POSTAGE UNKNOWN/);
});

test("stale comp (>30 days) doubles the profit bar", () => {
  const old = comp({ as_of: "2026-10-01T00:00:00Z" });
  const L = listing({ price: 35, postage: 7 }); // profit 31.15
  const d = evaluateListing(L, old, { min_profit: 20 }, eb, cs, now);
  assert.ok(d.stale);
  assert.equal(d.required, 40);
  assert.equal(d.verdict, "WAIT");
  const fresh = evaluateListing(L, comp(), { min_profit: 20 }, eb, cs, now);
  assert.equal(fresh.verdict, "BUY");
});

test("max_landed blocks the alert even when profitable", () => {
  const d = evaluateListing(listing({ price: 35, postage: 7 }), comp(), { min_profit: 20, max_landed: 40 }, eb, cs, now);
  assert.equal(d.overMax, true);
  assert.equal(d.shouldAlert, false);
});

test("no comp -> NOCOMP, never alerts", () => {
  const d = evaluateListing(listing(), null, { min_profit: 20 }, eb, cs, now);
  assert.equal(d.verdict, "NOCOMP");
  assert.equal(d.shouldAlert, false);
});

test("per-comp fee_rate override is used", () => {
  const d = evaluateListing(listing({ price: 35, postage: 7 }), comp({ fee_rate: 0.1 }), { min_profit: 20 }, eb, cs, now);
  assert.equal(d.net, 76);
});
