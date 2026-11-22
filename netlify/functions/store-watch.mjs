// Runs hourly at :07; checks your own eBay listings every my_store.interval_hours.
import { netlifyStore } from "../../lib/store.mjs";
import { readEnv } from "../../lib/env.mjs";
import { runStoreWatch } from "../../lib/core.mjs";

export default async () => {
  try {
    await runStoreWatch({ store: await netlifyStore(), env: readEnv() });
  } catch (e) {
    console.error("store-watch crashed:", e);
  }
};

export const config = { schedule: "7 * * * *" };
