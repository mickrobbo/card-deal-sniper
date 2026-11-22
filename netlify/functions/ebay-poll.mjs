// Runs every 5 minutes; each search term is polled on its own interval (default 10 min).
import { netlifyStore } from "../../lib/store.mjs";
import { readEnv } from "../../lib/env.mjs";
import { runEbay } from "../../lib/core.mjs";

export default async () => {
  try {
    await runEbay({ store: await netlifyStore(), env: readEnv() });
  } catch (e) {
    console.error("ebay-poll crashed:", e);
  }
};

export const config = { schedule: "*/5 * * * *" }; // UTC; interval-based so no TZ conversion needed
