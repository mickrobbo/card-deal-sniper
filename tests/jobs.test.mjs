// End-to-end job tests with a fake store, fake clock and fake network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../lib/store.mjs";
import { runEbay, runRetail, runHourly } from "../lib/core.mjs";
import { parseRobots, robotsAllows } from "../lib/polite.mjs";
import { extractJsonLd } from "../lib/extract.mjs";
import { validateConfig, DEFAULT_CONFIG } from "../lib/config.mjs";

const env = { EBAY_CLIENT_ID: "id", EBAY_CLIENT_SECRET: "secret", NTFY_TOPIC: "deals-test" };
const res = (status, body, ct = "application/json") => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": ct } });

function ebayFetch(items, sent, opts = {}) {
  return async (url, init = {}) => {
    url = String(url);
    if (url.includes("/oauth2/token")) return res(200, { access_token: "t", expires_in: 7200 });
    if (url.includes("item_summary/search")) return opts.denied ? res(403, { errors: [{ message: "Insufficient permissions" }] }) : res(200, { total: items.length, itemSummaries: items });
    if (url.includes("/buy/browse/v1/item/")) return res(200, { shippingOptions: [{ shippingCost: { value: "8.00" } }] });
    if (url.startsWith("https://ntfy.sh/")) { sent.push({ title: init.headers.Title, body: init.body, priority: init.headers.Priority }); return res(200, {}); }
    throw new Error("unexpected " + url);
  };
}

const item = (id, title, price, post = "9.00") => ({
  itemId: id, title, price: { value: String(price), currency: "AUD" }, itemWebUrl: `https://www.ebay.com.au/itm/${id}`,
  buyingOptions: ["FIXED_PRICE"], shippingOptions: post === null ? [{ shippingCostType: "CALCULATED" }] : [{ shippingCost: { value: post } }],
  seller: { feedbackPercentage: "99.5", feedbackScore: 500 },
});

const cfg = {
  ebay: { searches: [{ q: "mega evolution", min_profit: 20 }] },
  comps: { manual: [{ name: "Mega Evolution booster bundle", match_keywords: ["mega evolution booster bundle"], comp_aud: 95, comp_source: "x", comp_date: "2026-11-22" }] },
};
const clock = (iso) => () => new Date(iso);

test("eBay run: alerts BUY deals, logs no-comp, skips excluded, dedupes on rerun", async () => {
  const store = new MemoryStore({ config: cfg });
  const sent = [];
  const items = [
    item("A", "Mega Evolution Booster Bundle sealed", 35, "7.00"),   // BUY
    item("B", "Mega Evolution Booster Bundle", 59),                  // WAIT
    item("C", "Random charizard lot", 10),                           // no comp
    item("D", "Mega Evolution Booster Bundle EMPTY box only", 5),    // excluded
    item("E", "Mega Evolution Booster Bundle", 30, null),            // postage via item detail
  ];
  const out = await runEbay({ store, env, now: clock("2026-11-23T00:00:00Z"), fetchImpl: ebayFetch(items, sent) });
  assert.equal(out.polled, 1);
  assert.equal(out.newItems, 5);
  assert.equal(out.alerts, 2);
  assert.equal(out.noComp, 1);
  assert.equal(sent.length, 2);
  assert.match(sent[0].body, /Landed: \$42\.00 \(item \$35 \+ post \$7\)/);
  assert.match(sent[1].body, /Landed: \$38\.00 \(item \$30 \+ post \$8\)/);
  assert.equal(sent[0].priority, "high");
  assert.equal(out.callsToday, 2); // 1 search + 1 item detail
  assert.equal((await store.get("nocomp")).length, 1);

  const again = await runEbay({ store, env, now: clock("2026-11-23T00:11:00Z"), fetchImpl: ebayFetch(items, sent) });
  assert.equal(again.newItems, 0);
  assert.equal(sent.length, 2);
});

test("eBay run respects the poll interval and the daily call cap", async () => {
  const store = new MemoryStore({ config: { ...cfg, ebay: { ...cfg.ebay, daily_call_cap: 1 } } });
  const sent = [];
  await runEbay({ store, env, now: clock("2026-11-23T00:00:00Z"), fetchImpl: ebayFetch([], sent) });
  const early = await runEbay({ store, env, now: clock("2026-11-23T00:05:00Z"), fetchImpl: ebayFetch([], sent) });
  assert.equal(early.polled, 0); // not due yet
  const capped = await runEbay({ store, env, now: clock("2026-11-23T00:15:00Z"), fetchImpl: ebayFetch([], sent) });
  assert.equal(capped.polled, 0);
  assert.match(capped.errors[0], /cap/);
  const nextDay = await runEbay({ store, env, now: clock("2026-11-24T00:01:00Z"), fetchImpl: ebayFetch([], sent) });
  assert.equal(nextDay.polled, 1);
});

test("eBay access denied surfaces a Growth Check message and one notice", async () => {
  const store = new MemoryStore({ config: cfg });
  const sent = [];
  const out = await runEbay({ store, env, now: clock("2026-11-23T00:00:00Z"), fetchImpl: ebayFetch([], sent, { denied: true }) });
  assert.match(out.errors[0], /Growth Check/);
  assert.equal(sent.length, 1);
  await runEbay({ store, env, now: clock("2026-11-23T00:15:00Z"), fetchImpl: ebayFetch([], sent, { denied: true }) });
  assert.equal(sent.length, 1); // once per day
});

test("dry run sends nothing and saves nothing", async () => {
  const store = new MemoryStore({ config: cfg });
  const sent = [];
  const out = await runEbay({ store, env, now: clock("2026-11-23T00:00:00Z"), dryRun: true, fetchImpl: ebayFetch([item("A", "Mega Evolution Booster Bundle", 35, "7.00")], sent) });
  assert.equal(sent.length, 0);
  assert.equal(out.preview.length, 1);
  assert.equal(await store.get("ebay-state"), null);
});

test("rate limit: over max_per_hour gets queued, then summarised by hourly job", async () => {
  const store = new MemoryStore({ config: { ...cfg, alerts: { max_per_hour: 1, heartbeat_hour: 7 } } });
  const sent = [];
  const items = [item("A", "Mega Evolution Booster Bundle", 35, "7.00"), item("B", "Mega Evolution Booster Bundle x", 36, "7.00"), item("C", "Mega Evolution Booster Bundle y", 37, "7.00")];
  await runEbay({ store, env, now: clock("2026-11-23T00:00:00Z"), fetchImpl: ebayFetch(items, sent) });
  assert.equal(sent.length, 1);
  assert.equal((await store.get("queue-ebay")).length, 2);
  await runHourly({ store, env, now: clock("2026-11-23T01:02:00Z"), fetchImpl: ebayFetch([], sent) });
  assert.equal(sent.length, 2);
  assert.match(sent[1].title, /2 more alerts/);
  assert.equal((await store.get("queue-ebay")).length, 0);
});

test("heartbeat fires once at 7am local (AEDT) with stats", async () => {
  const store = new MemoryStore({ config: cfg, "ebay-state": { callsLocal: { "2026-11-22": 1234 } }, "retail-state": { checks: { "2026-11-22": 40 } } });
  const sent = [];
  // 2026-11-22T20:02Z = 7:02am AEDT on 23 Nov
  await runHourly({ store, env, now: clock("2026-11-22T20:02:00Z"), fetchImpl: ebayFetch([], sent) });
  await runHourly({ store, env, now: clock("2026-11-22T20:30:00Z"), fetchImpl: ebayFetch([], sent) });
  await runHourly({ store, env, now: clock("2026-11-22T21:02:00Z"), fetchImpl: ebayFetch([], sent) });
  assert.equal(sent.length, 1);
  assert.match(sent[0].body, /alive, 1234 eBay calls yesterday, 40 retailer checks/);
});

/* ------------------------------ retail ------------------------------ */
const ldPage = (name, price, avail) => `<html><script type="application/ld+json">${JSON.stringify({
  "@context": "https://schema.org", "@type": "ItemList",
  itemListElement: [{ "@type": "ListItem", item: { "@type": "Product", name, sku: "SKU1", url: "/p/sku1", offers: { "@type": "Offer", price, availability: `https://schema.org/${avail}` } } }],
})}</script></html>`;

function retailFetch(pages, sent, { robots = "User-agent: *\nDisallow: /checkout" } = {}) {
  let i = 0;
  return async (url, init = {}) => {
    url = String(url);
    if (url.endsWith("/robots.txt")) return res(200, robots, "text/plain");
    if (url.startsWith("https://ntfy.sh/")) { sent.push({ title: init.headers.Title, body: init.body, priority: init.headers.Priority }); return res(200, {}); }
    const p = pages[Math.min(i++, pages.length - 1)];
    return typeof p === "number" ? res(p, "nope", "text/html") : res(200, p, "text/html");
  };
}

const rcfg = { retailers: { watches: [{ retailer: "kmart", query: "pokemon mega evolution", target_price: 75, watch_stock: true }] } };

test("retail: restock then price drop, with cooldown and landed shipping", async () => {
  const store = new MemoryStore({ config: rcfg });
  const sent = [];
  const pages = [ldPage("Pokemon TCG Mega Evolution ETB", 89, "OutOfStock"), ldPage("Pokemon TCG Mega Evolution ETB", 89, "InStock"), ldPage("Pokemon TCG Mega Evolution ETB", 69, "InStock"), ldPage("Pokemon TCG Mega Evolution ETB", 69, "InStock")];
  const f = retailFetch(pages, sent);
  const t = (iso) => ({ store, env, now: clock(iso), fetchImpl: f, random: () => 0 });
  await runRetail(t("2026-11-23T00:00:00Z"));
  assert.equal(sent.length, 0);
  await runRetail(t("2026-11-23T00:31:00Z"));
  assert.equal(sent.length, 1);
  assert.match(sent[0].title, /RESTOCK: Kmart - Pokemon TCG Mega Evolution ETB/);
  assert.match(sent[0].body, /Landed: \$94 \(\$89 \+ \$5 shipping TBC\)/);
  assert.equal(sent[0].priority, "urgent");
  await runRetail(t("2026-11-23T01:02:00Z"));
  assert.equal(sent.length, 2);
  assert.match(sent[1].title, /PRICE DROP/);
  assert.match(sent[1].body, /Landed: \$74 \(\$69 \+ \$5 shipping TBC\), was \$94/);
  await runRetail(t("2026-11-23T01:33:00Z"));
  assert.equal(sent.length, 2); // same price, no re-alert
});

test("retail: 403 backs off 15m -> 1h and sends one notice per day", async () => {
  const store = new MemoryStore({ config: rcfg });
  const sent = [];
  const f = retailFetch([403, 403, 403], sent);
  const t = (iso) => ({ store, env, now: clock(iso), fetchImpl: f, random: () => 0, force: true });
  await runRetail(t("2026-11-23T00:00:00Z"));
  let st = await store.get("retail-state");
  assert.equal(st.polite.blocks.kmart.until, "2026-11-23T00:15:00.000Z");
  assert.equal(sent.length, 1);
  await runRetail(t("2026-11-23T00:05:00Z")); // still backing off: no request
  await runRetail(t("2026-11-23T00:16:00Z"));
  st = await store.get("retail-state");
  assert.equal(st.polite.blocks.kmart.until, "2026-11-23T01:16:00.000Z");
  assert.equal(sent.length, 1);
});

test("retail: robots.txt disallow is honoured", async () => {
  const store = new MemoryStore({ config: rcfg });
  const sent = [];
  let pageHits = 0;
  const f = async (url, init) => {
    if (String(url).endsWith("/robots.txt")) return res(200, "User-agent: *\nDisallow: /search", "text/plain");
    pageHits++; return res(200, "x", "text/html");
  };
  const out = await runRetail({ store, env, now: clock("2026-11-23T00:00:00Z"), fetchImpl: f, force: true });
  assert.equal(pageHits, 0);
  assert.match(out.results[0].notes.join(" "), /robots/);
});

test("robots parser: specific agent group beats *, longest rule wins", () => {
  const rules = parseRobots("User-agent: *\nDisallow: /\n\nUser-agent: CardDealSniper\nDisallow: /cart\nAllow: /search");
  assert.equal(robotsAllows(rules, "/search?q=x"), true);
  assert.equal(robotsAllows(rules, "/cart"), false);
  const star = parseRobots("User-agent: *\nDisallow: /s?\nAllow: /s?k=");
  assert.equal(robotsAllows(star, "/s?k=pokemon"), true);
  assert.equal(robotsAllows(star, "/s?x=1"), false);
});

test("JSON-LD extraction handles AggregateOffer and @graph", () => {
  const html = `<script type="application/ld+json">{"@graph":[{"@type":"Product","name":"ETB","sku":"9","offers":{"@type":"AggregateOffer","lowPrice":"79.00","offers":[{"@type":"Offer","price":"79.00","availability":"InStock"}]}}]}</script>`;
  const p = extractJsonLd(html, "https://x.com");
  assert.equal(p[0].price, 79);
  assert.equal(p[0].inStock, true);
});

test("default config validates; bad config gives readable errors", () => {
  assert.deepEqual(validateConfig({}), []);
  const errs = validateConfig({ ebay: { fee_rate: 2, searches: [{ q: "" }] }, retailers: { watches: [{ retailer: "aldi", query: "x" }] } });
  assert.ok(errs.some((e) => /fee_rate/.test(e)));
  assert.ok(errs.some((e) => /q \(search text\)/.test(e)));
  assert.ok(errs.some((e) => /unknown retailer "aldi"/.test(e)));
  assert.ok(errs.some((e) => /target_price or watch_stock/.test(e)));
  const many = validateConfig({ ebay: { searches: Array.from({ length: 40 }, (_, i) => ({ q: `t${i}` })) } });
  assert.ok(many.some((e) => /calls\/day/.test(e)));
});
