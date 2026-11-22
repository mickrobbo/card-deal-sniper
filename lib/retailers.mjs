// AU retailer adapters (config-driven) + restock / price-drop decisions.
import { fill, hasUnfilled, containsAllTokens, moneyShort, clampList } from "./util.mjs";
import { extractJson, extractJsonLd, extractRegex } from "./extract.mjs";

/** Try each configured strategy in order. Returns { products: [] | null, notes: [] } */
export async function fetchProducts(site, query, polite) {
  const notes = [];
  const vars = { query, query_url: encodeURIComponent(query) };
  for (const strat of site.strategies || []) {
    if (strat === "json") {
      if (!site.json) { notes.push("json: not configured"); continue; }
      const v = { ...vars, ...(site.json.vars || {}) };
      const req = fill({ url: site.json.url, headers: site.json.headers || {}, body: site.json.body ?? null }, v);
      if (hasUnfilled(req)) { notes.push("json: endpoint has VERIFY placeholders - fill them in Settings > Advanced"); continue; }
      const r = await polite.request(req.url, {
        method: site.json.method || "GET",
        headers: req.headers,
        body: req.body ? JSON.stringify(req.body) : undefined,
      });
      if (r.reason === "blocked" || /backing off|daily cap|robots/.test(r.reason || "")) return { products: null, notes: [...notes, `json: ${r.reason}`] };
      if (r.ok && r.json) {
        const p = extractJson(r.json, site.json);
        if (p) return { products: p, via: "json", notes };
        notes.push("json: response shape didn't match items_path/fields");
      } else notes.push(`json: ${r.reason || "no JSON"}`);
    } else if (strat === "jsonld" || strat === "regex") {
      if (strat === "regex" && !site.regex) { notes.push("regex: no pattern configured"); continue; }
      const url = fill(site.search_url, vars);
      const r = await polite.request(url);
      if (r.reason === "blocked" || /backing off|daily cap|robots/.test(r.reason || "")) return { products: null, notes: [...notes, `${strat}: ${r.reason}`] };
      if (!r.ok) { notes.push(`${strat}: ${r.reason}`); continue; }
      const p = strat === "jsonld" ? extractJsonLd(r.text, site.base) : extractRegex(r.text, site, site.base);
      if (p && p.length) return { products: p, via: strat, notes };
      notes.push(`${strat}: page had no product data (site may render results with JavaScript)`);
    }
  }
  return { products: [], notes };
}

export function retailLanded(product, site) {
  const known = Number.isFinite(product.shipping);
  const ship = known ? product.shipping : Number(site.default_shipping || 0);
  return { landed: Math.round((product.price + ship) * 100) / 100, ship, tbc: !known };
}

export function inDropWindow(watch, now = new Date()) {
  if (!watch.drop_start) return false;
  const s = Date.parse(watch.drop_start);
  const e = watch.drop_end ? Date.parse(watch.drop_end) : s + 3 * 3600000;
  return now.getTime() >= s - 15 * 60000 && now.getTime() <= e;
}

/**
 * Decide alerts for one watch given fresh products and stored per-product state.
 * prices: { [key]: { price, inStock, name, url, checkedAt, history: [[iso, price, stock]] } }
 * lastAlert: { [kind|key]: iso }  (cooldown memory)
 */
export function evaluateWatch(watch, siteKey, site, products, prices, lastAlert, r, now = new Date()) {
  const alerts = [];
  const matcher = watch.match || watch.query;
  const cooldownMs = (r.alert_cooldown_hours ?? 12) * 3600000;
  const drop = inDropWindow(watch, now);
  for (const p of products) {
    if (!containsAllTokens(p.name, matcher)) continue;
    const key = `${siteKey}|${p.id}`;
    const prev = prices[key];
    const { landed, ship, tbc } = retailLanded(p, site);
    const shipTxt = tbc ? `${moneyShort(ship)} shipping TBC` : `${moneyShort(ship)} shipping`;
    const landedLine = `Landed: ${moneyShort(landed)} (${moneyShort(p.price)} + ${shipTxt})`;

    const candidates = [];
    if (watch.watch_stock && prev && prev.inStock === false && p.inStock === true) {
      candidates.push({ kind: "restock", lines: [landedLine, ...(Number.isFinite(watch.target_price) ? [`Target: ${moneyShort(watch.target_price)} -> ${landed <= watch.target_price ? "PING" : "above target"}`] : [])] });
    }
    if (Number.isFinite(watch.target_price) && p.inStock !== false && landed <= watch.target_price && (!prev || prev.price !== p.price)) {
      const prevLanded = prev ? retailLanded({ ...p, price: prev.price }, site).landed : null;
      candidates.push({ kind: "price_drop", lines: [`${landedLine}${prevLanded !== null ? `, was ${moneyShort(prevLanded)}` : ", new listing"}`, `Target: ${moneyShort(watch.target_price)} -> PING`] });
    }
    for (const c of candidates) {
      const ck = `${c.kind}|${key}`;
      if (lastAlert[ck] && now - new Date(lastAlert[ck]) < cooldownMs) continue;
      lastAlert[ck] = now.toISOString();
      const head = c.kind === "restock" ? "RESTOCK" : "PRICE DROP";
      alerts.push({
        kind: c.kind, key: ck, url: p.url,
        title: `${head}: ${site.label} - ${p.name}`,
        body: [...c.lines, ...(drop ? ["DROP WINDOW - go now"] : []), "", p.url || ""].join("\n"),
        priority: drop || c.kind === "restock" ? "urgent" : "high",
        tags: c.kind === "restock" ? "rotating_light,package" : "moneybag",
      });
    }
    const hist = clampList([...(prev?.history || []), [now.toISOString(), p.price, p.inStock]], 60);
    prices[key] = { price: p.price, inStock: p.inStock, name: p.name, url: p.url, checkedAt: now.toISOString(), history: hist };
  }
  return alerts;
}
