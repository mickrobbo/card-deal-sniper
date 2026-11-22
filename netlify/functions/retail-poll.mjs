// Runs every 5 minutes; each retailer watch is checked on its own jittered interval
// (default 30 min, or drop_interval_minutes inside a drop window).
import { netlifyStore } from "../../lib/store.mjs";
import { readEnv } from "../../lib/env.mjs";
import { runRetail } from "../../lib/core.mjs";

export default async () => {
  try {
    await runRetail({ store: await netlifyStore(), env: readEnv() });
  } catch (e) {
    console.error("retail-poll crashed:", e);
  }
};

export const config = { schedule: "1-59/5 * * * *" }; // offset by a minute from ebay-poll
