// Read secrets from Netlify environment variables.
export function readEnv() {
  const g = (k) => (globalThis.Netlify?.env?.get(k) ?? process.env[k]) || undefined;
  return {
    EBAY_CLIENT_ID: g("EBAY_CLIENT_ID"),
    EBAY_CLIENT_SECRET: g("EBAY_CLIENT_SECRET"),
    NTFY_TOPIC: g("NTFY_TOPIC"),
    NTFY_SERVER: g("NTFY_SERVER"),
    NTFY_TOKEN: g("NTFY_TOKEN"),
    ADMIN_KEY: g("ADMIN_KEY"),
    TCGPRICES_API_KEY: g("TCGPRICES_API_KEY"),
  };
}
