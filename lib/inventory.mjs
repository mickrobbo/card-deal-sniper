// Stock you've bought to resell: cost basis, break-even, recommended eBay price.
import { normalise } from "./util.mjs";

export function isSealedName(name, catalog) {
  const t = ` ${normalise(name)} `;
  return (catalog?.products || []).some((p) => (p.aliases || [p.name]).some((a) => t.includes(` ${normalise(a)} `)));
}

const r2 = (n) => Math.round(n * 100) / 100;

// Round up to a "x.95" style list price, e.g. 72.31 -> 72.95, 72.96 -> 73.95.
export function niceListPrice(p) {
  const f = Math.floor(p);
  return r2(p <= f + 0.95 ? f + 0.95 : f + 1.95);
}

export function unitCost(item) {
  const qty = Math.max(1, Number(item.qty) || 1);
  return r2((Number(item.paid_each) || 0) + (Number(item.shipping_in) || 0) / qty);
}

/**
 * s: { fee_rate, outbound_postage, target_profit_pct, target_profit_min }
 * market: comp price in AUD or null
 */
export function pricing(item, market, s) {
  const fee = Number.isFinite(item.fee_rate) ? item.fee_rate : s.fee_rate;
  const post = Number.isFinite(item.outbound_postage) ? item.outbound_postage : s.outbound_postage;
  const cost = unitCost(item);
  const net = (price) => r2(price * (1 - fee) - post);
  const breakeven = r2((cost + post) / (1 - fee));
  const targetProfit = Math.max(s.target_profit_min || 0, cost * (s.target_profit_pct || 0));
  const target = r2((cost + post + targetProfit) / (1 - fee));
  const mkt = Number.isFinite(market) ? market : Number.isFinite(item.manual_value) ? item.manual_value : null;

  let recommended, basis, warning = null;
  if (mkt !== null) {
    if (mkt < breakeven) { recommended = niceListPrice(breakeven); basis = "break-even"; warning = "Market is below your break-even - holding or listing at break-even loses nothing but may sit unsold."; }
    else { recommended = niceListPrice(Math.max(mkt, breakeven)); basis = "market"; }
  } else { recommended = niceListPrice(target); basis = "target profit (no comp yet)"; }

  const out = {
    fee, post, cost, breakeven, target, market: mkt, recommended, basis, warning,
    netAtRecommended: net(recommended), profitAtRecommended: r2(net(recommended) - cost),
    profitAtMarket: mkt !== null ? r2(net(mkt) - cost) : null,
  };
  if (item.status === "sold" && Number.isFinite(item.sold_price)) {
    out.realised = r2(net(item.sold_price) - cost);
    out.roi = cost > 0 ? Math.round((out.realised / cost) * 100) : null;
  }
  return out;
}

/**
 * What to do with a live listing. price = your item price (excluding postage).
 * Returns { action: OK|RAISE|LOWER|BELOW_COST|NO_COMP, suggested, reason }
 */
export function priceAdvice(price, market, breakeven, thresholdPct = 8) {
  if (!Number.isFinite(market)) return { action: "NO_COMP", suggested: null, reason: "no AU sold comp yet" };
  const floor = Number.isFinite(breakeven) ? breakeven : 0;
  const target = Math.max(market, floor);
  const t = thresholdPct / 100;
  if (Number.isFinite(breakeven) && price < breakeven) {
    return { action: "BELOW_COST", suggested: niceListPrice(target), reason: `listed under your break-even of $${breakeven.toFixed(2)}` };
  }
  if (price > target * (1 + t)) {
    return { action: "LOWER", suggested: niceListPrice(target), reason: target === floor && floor > market ? "market dropped under break-even - lowest safe price" : `${Math.round(((price - target) / target) * 100)}% above market` };
  }
  if (price < market * (1 - t)) {
    return { action: "RAISE", suggested: niceListPrice(market), reason: `${Math.round(((market - price) / market) * 100)}% under market` };
  }
  return { action: "OK", suggested: null, reason: "in line with market" };
}

export function compQueryFor(item) {
  if (item.comp_query) return item.comp_query;
  return [item.set, item.name, item.number, item.grade && item.grade !== "Raw" ? item.grade : ""].filter(Boolean).join(" ").trim();
}

export function totals(items, s) {
  let invested = 0, holdingValue = 0, realised = 0, holdingCount = 0, soldCount = 0;
  for (const it of items) {
    const qty = Math.max(1, Number(it.qty) || 1);
    const p = pricing(it, it.market?.comp_aud ?? null, s);
    if (it.status === "sold") { soldCount += qty; realised += (p.realised ?? 0) * qty; }
    else { holdingCount += qty; invested += p.cost * qty; holdingValue += (p.market ?? 0) * qty; }
  }
  return { invested: r2(invested), holdingValue: r2(holdingValue), realised: r2(realised), holdingCount, soldCount };
}
