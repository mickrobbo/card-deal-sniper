// Pull {id, name, price, inStock, url} products out of a page or JSON response.
// Strategies: "json" (configured endpoint + field paths), "jsonld" (schema.org
// Product data most retail sites embed for Google), "regex" (configured pattern).
import { getPath, parsePrice } from "./util.mjs";

function absolute(url, base) {
  if (!url) return null;
  try { return new URL(String(url), base).toString(); } catch { return null; }
}

function stockFrom(v) {
  if (v === true || v === false) return v;
  if (v === null || v === undefined) return null;
  const s = String(v).toLowerCase();
  if (/outofstock|out of stock|soldout|sold out|discontinued|unavailable|false|^0$/.test(s)) return false;
  if (/instock|in stock|limitedavailability|onlineonly|preorder|available|true|^[1-9]/.test(s)) return true;
  return null;
}

export function extractJson(json, cfg) {
  const items = getPath(json, cfg.items_path);
  if (!Array.isArray(items)) return null;
  const f = cfg.fields || {};
  return items.map((it) => {
    const url = absolute(getPath(it, f.url), cfg.url_prefix || "https://example.com");
    return {
      id: String(getPath(it, f.id) ?? url ?? getPath(it, f.name)),
      name: String(getPath(it, f.name) ?? ""),
      price: parsePrice(getPath(it, f.price)),
      inStock: stockFrom(getPath(it, f.in_stock)),
      url,
    };
  }).filter((p) => p.name && p.price !== null);
}

function* walk(node) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const n of node) yield* walk(n); return; }
  yield node;
  for (const k of ["@graph", "itemListElement", "item", "mainEntity", "offers", "hasVariant"]) {
    if (node[k] && typeof node[k] === "object") yield* walk(node[k]);
  }
}

const isType = (n, t) => [].concat(n?.["@type"] || []).some((x) => String(x).toLowerCase() === t);

export function extractJsonLd(html, base) {
  const out = [];
  const seen = new Set();
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }
    for (const n of walk(data)) {
      if (!isType(n, "product")) continue;
      const offers = [].concat(n.offers || []).flatMap((o) => (isType(o, "aggregateoffer") && o.offers ? [].concat(o.offers) : [o]));
      const o = offers[0] || {};
      const price = parsePrice(o.price ?? o.lowPrice ?? n.price);
      const url = absolute(n.url || o.url, base);
      const id = String(n.sku || n.productID || n.gtin13 || url || n.name);
      if (!n.name || price === null || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, name: String(n.name), price, inStock: stockFrom(o.availability), url });
    }
  }
  return out;
}

// cfg.regex: pattern with named groups (?<name>) (?<price>) and optional (?<url>) (?<stock>)
export function extractRegex(html, cfg, base) {
  if (!cfg?.regex) return null;
  let re;
  try { re = new RegExp(cfg.regex, "gis"); } catch { return null; }
  const out = [];
  for (const m of html.matchAll(re)) {
    const g = m.groups || {};
    const price = parsePrice(g.price);
    if (!g.name || price === null) continue;
    const url = absolute(g.url, base);
    out.push({ id: String(url || g.name), name: g.name.replace(/<[^>]+>/g, "").trim(), price, inStock: stockFrom(g.stock ?? null), url });
  }
  return out;
}
