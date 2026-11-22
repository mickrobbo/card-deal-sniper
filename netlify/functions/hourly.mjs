// Runs at 2 minutes past every hour (UTC). Sends the rate-limit summary and, when
// the local hour (config timezone, AEST/AEDT handled) matches heartbeat_hour, the
// daily "still alive" message. Australian offsets are whole hours, so :02 UTC is
// :02 local too.
import { netlifyStore } from "../../lib/store.mjs";
import { readEnv } from "../../lib/env.mjs";
import { runHourly } from "../../lib/core.mjs";

export default async () => {
  try {
    await runHourly({ store: await netlifyStore(), env: readEnv() });
  } catch (e) {
    console.error("hourly crashed:", e);
  }
};

export const config = { schedule: "2 * * * *" };
