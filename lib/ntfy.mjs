// ntfy push sender. Headers only, ASCII-safe title. Never logs the topic.
import { asciiSafe } from "./util.mjs";

export async function sendNtfy(env, { title, body, priority = "default", tags = "", click = "", actionLabel = "Open" }, fetchImpl = fetch) {
  const topic = env.NTFY_TOPIC;
  if (!topic) throw new Error("NTFY_TOPIC is not set in Netlify environment variables");
  const server = (env.NTFY_SERVER || "https://ntfy.sh").replace(/\/+$/, "");
  const headers = { Title: asciiSafe(title) || "Card Deal Sniper", Priority: priority, "Content-Type": "text/plain; charset=utf-8" };
  if (tags) headers.Tags = asciiSafe(tags);
  if (click) {
    headers.Click = click;
    if (!/[,;"]/.test(click)) headers.Actions = `view, ${asciiSafe(actionLabel)}, ${click}, clear=true`;
  }
  if (env.NTFY_TOKEN) headers.Authorization = `Bearer ${env.NTFY_TOKEN}`;
  const r = await fetchImpl(`${server}/${encodeURIComponent(topic)}`, { method: "POST", headers, body: String(body ?? "") });
  if (!r.ok) throw new Error(`ntfy returned HTTP ${r.status}`);
  return true;
}
