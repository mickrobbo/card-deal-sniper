// Dashboard API. Every route needs the X-Admin-Key header to match the ADMIN_KEY
// env var. CORS is open so the dashboard also works as a file saved on your desktop.
import { netlifyStore } from "../../lib/store.mjs";
import { readEnv } from "../../lib/env.mjs";
import { runEbay, runRetail, runHourly, refreshStock, stockWithPricing, runStoreWatch, buildSharedProviders } from "../../lib/core.mjs";
import { totals } from "../../lib/inventory.mjs";
import { matchManual } from "../../lib/comps.mjs";
import { withDefaults, validateConfig, DEFAULT_CONFIG } from "../../lib/config.mjs";
import { EbayClient, toListing } from "../../lib/ebay.mjs";
import { sendNtfy } from "../../lib/ntfy.mjs";
import { utcDay, localParts } from "../../lib/util.mjs";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, X-Admin-Key",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
};
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS } });

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const env = readEnv();
  if (!env.ADMIN_KEY) return json({ error: "ADMIN_KEY env var is not set on Netlify" }, 500);
  if (!safeEqual(req.headers.get("x-admin-key") || "", env.ADMIN_KEY)) return json({ error: "Wrong admin key" }, 401);

  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/?/, "");
  const store = await netlifyStore();
  const body = req.method === "POST" || req.method === "PUT" ? await req.json().catch(() => ({})) : {};
  const dry = url.searchParams.get("dry") === "1";

  try {
    switch (`${req.method} ${route}`) {
      case "GET status": {
        const cfg = withDefaults(await store.get("config"));
        const eb = await store.get("ebay-state", {});
        const rt = await store.get("retail-state", {});
        const meta = await store.get("meta", {});
        const ld = localParts(cfg.timezone).date;
        return json({
          now: new Date().toISOString(),
          paused: !!cfg.paused,
          env: { ebayKeys: !!(env.EBAY_CLIENT_ID && env.EBAY_CLIENT_SECRET), ntfy: !!env.NTFY_TOPIC, tcgprices: !!env.TCGPRICES_API_KEY },
          tcgpricesUsage: (await store.get("tcgprices-usage", {}))[new Date().toISOString().slice(0, 7)] || 0,
          storeCallsToday: (await store.get("store-calls", {}))[utcDay()] || 0,
          ebay: {
            callsTodayUTC: eb.calls?.[utcDay()] || 0, cap: cfg.ebay.daily_call_cap, callsLocalToday: eb.callsLocal?.[ld] || 0,
            lastPolled: eb.lastPolled || {}, seenCount: Object.keys(eb.seen || {}).length,
            accessErrorDay: eb.accessError || null, tokenFailSince: eb.tokenFailSince || null,
          },
          retail: { next: rt.next || {}, blocks: rt.polite?.blocks || {}, checksToday: rt.checks?.[ld] || 0, counts: rt.polite?.counts || {} },
          meta,
          configErrors: validateConfig(cfg),
        });
      }
      case "GET config": return json({ config: withDefaults(await store.get("config")), defaults: DEFAULT_CONFIG });
      case "PUT config": {
        const errors = validateConfig(body.config);
        if (errors.length) return json({ ok: false, errors }, 400);
        await store.set("config", body.config);
        return json({ ok: true });
      }
      case "GET alerts": {
        const a = [...(await store.get("alerts-ebay", [])), ...(await store.get("alerts-retail", []))];
        a.sort((x, y) => (y.sentAt || "").localeCompare(x.sentAt || ""));
        return json({ alerts: a.slice(0, 150) });
      }
      case "GET misses": return json({ misses: (await store.get("nocomp", [])).slice().reverse().slice(0, 150) });
      case "GET prices": return json({ prices: (await store.get("retail-state", {})).prices || {} });
      case "GET comps-cache": return json({ cache: await store.get("comps-cache", {}) });

      case "POST test-ntfy":
        await sendNtfy(env, { title: "Card Deal Sniper test", body: "If you can read this on your phone, alerts work.\nLanded: $68.00 (item $59 + post $9)", priority: "high", tags: "white_check_mark", click: url.origin });
        return json({ ok: true });

      case "POST test-ebay": {
        const st = await store.get("ebay-state", { calls: {} });
        st.calls ||= {};
        const day = utcDay();
        const cfg = withDefaults(await store.get("config"));
        const client = new EbayClient({
          clientId: env.EBAY_CLIENT_ID, clientSecret: env.EBAY_CLIENT_SECRET, postcode: cfg.ebay.postcode,
          budget: { cap: cfg.ebay.daily_call_cap, used: () => st.calls[day] || 0, inc: () => { st.calls[day] = (st.calls[day] || 0) + 1; } },
        });
        const r = await client.search(body.q || "pokemon booster box", 5);
        await store.set("ebay-state", st);
        const first = r.items[0] ? toListing(r.items[0]) : null;
        return json({ ok: true, total: r.total, returned: r.items.length, first: first && { title: first.title, price: first.price, url: first.url, shippingOptions: first.shippingOptions } });
      }

      case "POST run/ebay": return json(await runEbay({ store, env, dryRun: dry, force: true }));
      case "POST run/retail": {
        const only = Number.isInteger(body.only) ? body.only : null;
        return json(await runRetail({ store, env, dryRun: dry, force: true, only }));
      }
      case "POST run/heartbeat": return json(await runHourly({ store, env, forceHeartbeat: true }));

      case "GET stock": {
        const cfg = withDefaults(await store.get("config"));
        const items = await store.get("stock", []);
        const s = { fee_rate: cfg.ebay.fee_rate, outbound_postage: cfg.ebay.outbound_postage, ...cfg.stock };
        return json({ items: stockWithPricing(items, cfg), totals: totals(items, s) });
      }
      case "PUT stock": {
        if (!Array.isArray(body.items)) return json({ ok: false, error: "items must be a list" }, 400);
        await store.set("stock", body.items);
        return json({ ok: true });
      }
      case "POST stock/refresh": return json(await refreshStock({ store, env, ids: Array.isArray(body.ids) ? body.ids : null }));
      case "GET store": return json(await store.get("store-state", { lastRun: null, listings: [] }));
      case "POST run/store": return json(await runStoreWatch({ store, env, force: true, dryRun: dry }));
      case "POST test-comp": {
        // Fresh lookup (ignores the cache) so you can see exactly what each source returns.
        const cfg = withDefaults(await store.get("config"));
        const q = String(body.query || "").trim();
        if (!q) return json({ ok: false, error: "Enter a card or product name" }, 400);
        const logs = [];
        const tcgCounter = await store.get("tcgprices-usage", {});
        const results = [];
        for (const p of buildSharedProviders(cfg, env, { trackerPolite: {}, alerter: { notice: async () => {} }, now: () => new Date(), fetchImpl: fetch, log: (m) => logs.push(m), tcgCounter })) {
          try { results.push({ source: p.label, result: await p.fetch(q, new Date()) }); }
          catch (e) { results.push({ source: p.label, error: e.message }); }
        }
        await store.set("tcgprices-usage", tcgCounter);
        const manual = matchManual(q, cfg.comps.manual);
        return json({ ok: true, query: q, results, manual: manual ? { name: manual.name, comp_aud: manual.comp_aud, comp_date: manual.comp_date } : null, log: logs, note: results.length ? "" : "No live sources are on. Add TCGPRICES_API_KEY on Netlify, or turn on Marketplace Insights once eBay approves it." });
      }
      case "POST unblock": {
        const rt = await store.get("retail-state", {});
        if (rt.polite?.blocks?.[body.retailer]) delete rt.polite.blocks[body.retailer];
        if (rt.polite?.robots) rt.polite.robots = {}; // re-read robots.txt next time
        await store.set("retail-state", rt);
        return json({ ok: true });
      }
      case "POST reset-seen": {
        const eb = await store.get("ebay-state", {});
        eb.seen = {};
        await store.set("ebay-state", eb);
        return json({ ok: true });
      }
      default: return json({ error: `No route ${req.method} /api/${route}` }, 404);
    }
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
};

export const config = { path: "/api/*" };
