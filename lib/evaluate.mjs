// Landed price, net resale and profit maths for eBay listings, plus alert text.
import { parsePrice, money, moneyShort, ageDays, ageLabel } from "./util.mjs";

// Cheapest known postage from Browse API shippingOptions. null = unknown.
export function cheapestPostage(shippingOptions) {
  if (!Array.isArray(shippingOptions)) return null;
  const costs = shippingOptions
    .map((o) => parsePrice(o?.shippingCost?.value))
    .filter((v) => v !== null);
  return costs.length ? Math.min(...costs) : null;
}

export function landedPrice(itemPrice, postage, unknownEstimate) {
  const unknown = postage === null || postage === undefined;
  const post = unknown ? unknownEstimate : postage;
  return { landed: round2(itemPrice + post), postage: post, postageUnknown: unknown };
}

export function netResale(compAud, feeRate, outboundPostage) {
  return round2(compAud * (1 - feeRate) - outboundPostage);
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * listing: { itemId, title, price, postage (number|null), url, buyingOptions, seller }
 * comp:    { comp_aud, label, as_of (ISO), fee_rate? , style }  or null
 * term:    one ebay search entry
 * eb:      ebay settings, cs: comps settings
 */
export function evaluateListing(listing, comp, term, eb, cs, now = new Date()) {
  const { landed, postage, postageUnknown } = landedPrice(listing.price, listing.postage, eb.unknown_postage_estimate);
  const base = { landed, itemPrice: listing.price, postage, postageUnknown };
  if (!comp) return { ...base, verdict: "NOCOMP", shouldAlert: false };

  const feeRate = Number.isFinite(comp.fee_rate) ? comp.fee_rate : eb.fee_rate;
  const net = netResale(comp.comp_aud, feeRate, eb.outbound_postage);
  const profit = round2(net - landed);
  const compAge = ageDays(comp.as_of, now);
  const stale = compAge > cs.stale_comp_days_for_multiplier;
  const minProfit = Number.isFinite(term.min_profit) ? term.min_profit : 20;
  const required = stale ? minProfit * cs.stale_comp_profit_multiplier : minProfit;
  const overMax = Number.isFinite(term.max_landed) && landed > term.max_landed;
  const passes = profit >= required && !overMax;
  return {
    ...base, feeRate, net, profit, compAge, stale, required, overMax,
    verdict: passes ? "BUY" : "WAIT",
    shouldAlert: passes || (eb.send_wait_alerts && profit > 0 && !overMax),
  };
}

export function formatEbayAlert(listing, comp, d, eb) {
  const post = d.postageUnknown
    ? `post ~${moneyShort(d.postage)} est, POSTAGE UNKNOWN`
    : `post ${moneyShort(d.postage)}`;
  const lines = [
    `Landed: ${money(d.landed)} (item ${moneyShort(d.itemPrice)} + ${post})`,
    `Comp: ${money(comp.comp_aud)} (${comp.label}, ${ageLabel(d.compAge, comp.style)})`,
    `Net after ${Math.round(d.feeRate * 100)}% fees + ${money(eb.outbound_postage)} post: ~${moneyShort(Math.round(d.net))}`,
  ];
  const p = moneyShort(Math.round(d.profit));
  if (d.verdict === "BUY") lines.push(`Est profit: ~${p} -> BUY${d.stale ? " (stale comp, doubled bar cleared)" : ""}`);
  else if (d.overMax) lines.push(`Est profit: ~${p} -> WAIT (over max landed)`);
  else lines.push(`Est profit: ~${p} -> WAIT (under ${moneyShort(d.required)} bar${d.stale ? ", stale comp" : ""})`);
  if (listing.buyingOptions?.includes("BEST_OFFER")) lines.push("Best Offer accepted - try lower");
  if (listing.seller?.feedbackPercentage) lines.push(`Seller: ${listing.seller.feedbackPercentage}% (${listing.seller.feedbackScore ?? "?"})`);
  lines.push("", listing.url);
  return { title: `DEAL: ${listing.title}`, body: lines.join("\n") };
}
