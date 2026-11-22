// Small shared helpers. No dependencies.

export function normalise(s) {
  return String(s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// "$1,299.00" -> 1299, "69" -> 69, junk -> null
export function parsePrice(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const m = String(v).replace(/,/g, "").match(/\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

export function median(nums) {
  const a = nums.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

// Tiny JSON path: "a.b[0].c", "hits", "data.items". Returns undefined if missing.
export function getPath(obj, path) {
  if (!path) return obj;
  const parts = String(path).replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[p];
  }
  return cur;
}

// Replace {name} placeholders. {query_url} is URL-encoded.
export function fill(template, vars) {
  if (typeof template === "string") {
    return template.replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? String(vars[k]) : `{${k}}`));
  }
  if (Array.isArray(template)) return template.map((t) => fill(t, vars));
  if (template && typeof template === "object") {
    const out = {};
    for (const [k, v] of Object.entries(template)) out[k] = fill(v, vars);
    return out;
  }
  return template;
}

export function hasUnfilled(obj) {
  return /VERIFY|\{\w+\}/.test(JSON.stringify(obj ?? ""));
}

export const DAY_MS = 86400000;

export function ageDays(fromIso, now = new Date()) {
  const t = new Date(fromIso).getTime();
  if (!Number.isFinite(t)) return Infinity;
  return Math.max(0, Math.floor((now.getTime() - t) / DAY_MS));
}

export function ageLabel(days, style = "ago") {
  if (!Number.isFinite(days)) return "age unknown";
  if (style === "old") return days === 0 ? "today" : `${days} day${days === 1 ? "" : "s"} old`;
  if (days === 0) return "today";
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

// ntfy titles go in an HTTP header, so keep them plain ASCII.
export function asciiSafe(s, max = 120) {
  return String(s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\x20-\x7E]/g, "")
    .slice(0, max)
    .trim();
}

export function money(n, dp = 2) {
  return `$${Number(n).toFixed(dp)}`;
}
export function moneyShort(n) {
  const r = Math.round(Number(n) * 100) / 100;
  return Number.isInteger(r) ? `$${r}` : `$${r.toFixed(2)}`;
}

export function utcDay(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

// Local date/hour in a named time zone (handles AEST/AEDT automatically).
export function localParts(tz, d = new Date()) {
  const f = new Intl.DateTimeFormat("en-AU", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false,
  });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 };
}

export function tokensOf(s) {
  return normalise(s).split(" ").filter(Boolean);
}

// All tokens of `query` appear in `text` (normalised).
export function containsAllTokens(text, query) {
  const t = ` ${normalise(text)} `;
  return tokensOf(query).every((tok) => t.includes(` ${tok} `));
}

export function containsAny(text, phrases) {
  const t = ` ${normalise(text)} `;
  return (phrases || []).find((p) => {
    const n = normalise(p);
    return n && t.includes(` ${n} `);
  }) || null;
}

export function clampList(arr, max) {
  return arr.length > max ? arr.slice(arr.length - max) : arr;
}

// Calendar-day difference in a time zone (so "today" means today in AEST/AEDT).
export function localAgeDays(fromIso, now = new Date(), tz = "Australia/Sydney") {
  const t = new Date(fromIso);
  if (!Number.isFinite(t.getTime())) return Infinity;
  const a = Date.parse(localParts(tz, t).date), b = Date.parse(localParts(tz, now).date);
  return Math.max(0, Math.round((b - a) / DAY_MS));
}

// "23 Nov 9:14am AEDT"
export function fmtLocal(iso, tz = "Australia/Sydney") {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const f = new Intl.DateTimeFormat("en-AU", { timeZone: tz, day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short" });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.day} ${p.month} ${p.hour}:${p.minute}${(p.dayPeriod || "").toLowerCase()} ${p.timeZoneName}`;
}

// Interquartile-range outlier trim (needs 5+ values, otherwise returns input).
export function trimOutliers(nums) {
  const a = nums.filter(Number.isFinite).sort((x, y) => x - y);
  if (a.length < 5) return a;
  const q = (p) => { const i = (a.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return a[lo] + (a[hi] - a[lo]) * (i - lo); };
  const q1 = q(0.25), q3 = q(0.75), iqr = q3 - q1;
  return a.filter((v) => v >= q1 - 1.5 * iqr && v <= q3 + 1.5 * iqr);
}
