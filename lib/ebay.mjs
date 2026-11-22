// eBay Browse API (+ Marketplace Insights) client with OAuth client-credentials,
// in-memory token cache and a hard daily call budget.

export const TOKEN_URL = "https://api.ebay.com/identity/v1/oauth2/token";
export const SEARCH_URL = "https://api.ebay.com/buy/browse/v1/item_summary/search";
export const ITEM_URL = "https://api.ebay.com/buy/browse/v1/item/";
export const MI_URL = "https://api.ebay.com/buy/marketplace_insights/v1_beta/item_sales/search";
const SCOPE_BASE = "https://api.ebay.com/oauth/api_scope";
const SCOPE_MI = "https://api.ebay.com/oauth/api_scope/buy.marketplace.insights";

export class BudgetError extends Error {}
export class EbayAccessError extends Error {}
export class EbayAuthError extends Error {}

const tokenCache = new Map(); // survives between warm function invocations

export class EbayClient {
  /** budget: { used(): number, inc(): void, cap: number } */
  constructor({ clientId, clientSecret, budget, postcode = "3000", fetchImpl, log = () => {} }) {
    if (!clientId || !clientSecret) throw new EbayAuthError("EBAY_CLIENT_ID / EBAY_CLIENT_SECRET are not set in Netlify environment variables");
    Object.assign(this, { clientId, clientSecret, budget, postcode, log });
    this.fetch = fetchImpl || fetch;
  }

  async token(scope = SCOPE_BASE) {
    const c = tokenCache.get(scope);
    if (c && c.expires > Date.now() + 5 * 60000) return c.token; // refresh 5 min early
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");
    const r = await this.fetch(TOKEN_URL, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", scope }).toString(),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) {
      throw new EbayAuthError(`eBay token request failed (HTTP ${r.status}): ${j.error_description || j.error || "no detail"}. Check your PRODUCTION App ID / Cert ID.`);
    }
    tokenCache.set(scope, { token: j.access_token, expires: Date.now() + (j.expires_in || 7200) * 1000 });
    return j.access_token;
  }

  spend() {
    if (this.budget.used() >= this.budget.cap) throw new BudgetError(`daily eBay call cap (${this.budget.cap}) reached - pausing until next UTC day`);
    this.budget.inc();
  }

  headers(token) {
    return {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_AU",
      "X-EBAY-C-ENDUSERCTX": `contextualLocation=${encodeURIComponent(`country=AU,zip=${this.postcode}`)}`,
      Accept: "application/json",
    };
  }

  async get(url, scope) {
    const token = await this.token(scope);
    this.spend();
    const r = await this.fetch(url, { headers: this.headers(token) });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) tokenCache.delete(scope);
    if (r.status === 403 || (r.status === 401 && JSON.stringify(j).match(/insufficient|access|scope/i))) {
      const msg = j.errors?.[0]?.message || j.errors?.[0]?.longMessage || `HTTP ${r.status}`;
      throw new EbayAccessError(
        scope === SCOPE_MI
          ? `Marketplace Insights access denied (${msg}). It's Limited Release - apply in the eBay developer portal, then turn it on in Settings.`
          : `eBay production Browse access denied (${msg}). This usually means you need eBay's Application Growth Check - apply from the developer portal (describe it honestly as personal deal alerts).`,
      );
    }
    if (!r.ok) throw new Error(`eBay HTTP ${r.status}: ${j.errors?.[0]?.message || "unknown error"}`);
    return j;
  }

  async search(q, limit = 25) {
    const p = new URLSearchParams({
      q,
      filter: "buyingOptions:{FIXED_PRICE},itemLocationCountry:AU",
      sort: "newlyListed",
      limit: String(limit),
    });
    const j = await this.get(`${SEARCH_URL}?${p}`, SCOPE_BASE);
    return { total: j.total ?? 0, items: j.itemSummaries || [] };
  }

  async getItem(itemId) {
    return this.get(ITEM_URL + encodeURIComponent(itemId), SCOPE_BASE);
  }

  async marketplaceInsights(q) {
    const p = new URLSearchParams({ q, limit: "200" });
    const j = await this.get(`${MI_URL}?${p}`, SCOPE_MI);
    return j.itemSales || [];
  }
}

// Browse API item summary -> our listing shape
export function toListing(s) {
  return {
    itemId: s.itemId,
    title: s.title || "",
    price: Number(s.price?.value),
    currency: s.price?.currency,
    shippingOptions: s.shippingOptions,
    url: s.itemWebUrl,
    buyingOptions: s.buyingOptions || [],
    seller: s.seller ? { feedbackPercentage: s.seller.feedbackPercentage, feedbackScore: s.seller.feedbackScore } : null,
  };
}
