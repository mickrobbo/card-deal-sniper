// Shared politeness layer for every non-eBay site (retailers + price trackers):
// robots.txt, honest user agent, daily request cap, exponential backoff on blocks,
// and at most one "blocked" phone notice per site per day.
import { utcDay } from "./util.mjs";

const BACKOFF_MIN = [15, 60, 240];
const CHALLENGE = /captcha|pardon our interruption|access denied|are you a robot|_incapsula_|cf-chl|px-captcha|request unsuccessful/i;

export function parseRobots(text, uaToken = "carddealsniper") {
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const i = line.indexOf(":");
    if (i < 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const val = line.slice(i + 1).trim();
    if (key === "user-agent") {
      if (!lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (cur && (key === "allow" || key === "disallow")) cur.rules.push({ allow: key === "allow", path: val });
    }
  }
  const mine = groups.find((g) => g.agents.some((a) => a !== "*" && uaToken.includes(a)));
  const star = groups.filter((g) => g.agents.includes("*"));
  return mine ? mine.rules : star.flatMap((g) => g.rules);
}

function ruleRegex(p) {
  const esc = p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$");
  return new RegExp("^" + esc);
}

export function robotsAllows(rules, pathAndQuery) {
  let best = null;
  for (const r of rules || []) {
    if (!r.path) continue; // "Disallow:" (empty) allows everything
    if (ruleRegex(r.path).test(pathAndQuery)) {
      if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
    }
  }
  return best ? best.allow : true;
}

export class PoliteFetcher {
  /**
   * state: persisted object { blocks, counts, robots } (caller saves it)
   * opts: { name, label, userAgent, dailyCap, ignoreRobots, fetch, now, notify, log }
   */
  constructor(state, opts) {
    this.s = state;
    this.s.blocks ||= {};
    this.s.counts ||= {};
    this.s.robots ||= {};
    this.o = opts;
    this.fetch = opts.fetch || fetch;
    this.log = opts.log || (() => {});
  }

  get now() { return this.o.now ? this.o.now() : new Date(); }

  todayCount() {
    return this.s.counts[utcDay(this.now)]?.[this.o.name] || 0;
  }

  bump() {
    const d = utcDay(this.now);
    this.s.counts[d] ||= {};
    this.s.counts[d][this.o.name] = (this.s.counts[d][this.o.name] || 0) + 1;
    // keep only last 3 days of counters
    for (const k of Object.keys(this.s.counts)) if (k < utcDay(new Date(this.now.getTime() - 3 * 86400000))) delete this.s.counts[k];
  }

  blockedUntil() {
    const b = this.s.blocks[this.o.name];
    return b?.until && new Date(b.until) > this.now ? b.until : null;
  }

  async robotsOk(url) {
    if (this.o.ignoreRobots) return true;
    const u = new URL(url);
    const cached = this.s.robots[u.host];
    let rules = cached?.rules;
    if (!cached || this.now - new Date(cached.fetchedAt) > 86400000) {
      try {
        const r = await this.fetch(`${u.origin}/robots.txt`, { headers: { "User-Agent": this.o.userAgent } });
        if (r.status >= 500) rules = [{ allow: false, path: "/" }];       // server error: assume disallow
        else if (r.ok) rules = parseRobots(await r.text());
        else rules = [];                                                    // 4xx: no robots = allowed
      } catch (e) {
        this.log(`[${this.o.name}] robots.txt fetch failed: ${e.message}`);
        rules = cached?.rules || [];
      }
      this.s.robots[u.host] = { fetchedAt: this.now.toISOString(), rules };
    }
    return robotsAllows(rules, u.pathname + u.search);
  }

  // Can we make a request right now? Returns null if OK, or a reason string.
  async gate(url) {
    const until = this.blockedUntil();
    if (until) return `backing off until ${until}`;
    if (this.todayCount() >= this.o.dailyCap) return `daily cap ${this.o.dailyCap} reached`;
    if (!(await this.robotsOk(url))) return "blocked by robots.txt (set ignore_robots: true to override)";
    return null;
  }

  async recordBlock(status) {
    const b = (this.s.blocks[this.o.name] ||= { level: 0 });
    const mins = BACKOFF_MIN[Math.min(b.level, BACKOFF_MIN.length - 1)];
    b.level = Math.min(b.level + 1, BACKOFF_MIN.length - 1);
    b.until = new Date(this.now.getTime() + mins * 60000).toISOString();
    b.lastStatus = status;
    b.lastBlockedAt = this.now.toISOString();
    this.log(`[${this.o.name}] blocked (${status}); backing off ${mins} min`);
    const today = utcDay(this.now);
    if (b.lastNoticeDay !== today && this.o.notify) {
      b.lastNoticeDay = today;
      await this.o.notify(`${this.o.label} is blocking requests`, `${this.o.label} returned ${status}. Backing off (15m -> 1h -> 4h). You'll get at most one of these per day per site.`);
    }
  }

  clearBlock() {
    const b = this.s.blocks[this.o.name];
    if (b) { b.level = 0; b.until = null; }
  }

  /** Returns { ok, status, text, json, reason } — never throws. */
  async request(url, init = {}) {
    const reason = await this.gate(url);
    if (reason) { this.log(`[${this.o.name}] skip: ${reason}`); return { ok: false, reason }; }
    this.bump();
    try {
      const r = await this.fetch(url, {
        ...init,
        headers: { "User-Agent": this.o.userAgent, "Accept-Language": "en-AU,en;q=0.9", ...(init.headers || {}) },
      });
      const text = await r.text();
      if (r.status === 403 || r.status === 429 || ((r.status === 503 || r.ok) && CHALLENGE.test(text.slice(0, 20000)) && !/application\/json/.test(r.headers.get("content-type") || ""))) {
        await this.recordBlock(r.status === 200 ? "challenge page" : `HTTP ${r.status}`);
        return { ok: false, status: r.status, reason: "blocked" };
      }
      if (!r.ok) return { ok: false, status: r.status, reason: `HTTP ${r.status}` };
      this.clearBlock();
      let json;
      try { json = JSON.parse(text); } catch { /* html */ }
      return { ok: true, status: r.status, text, json };
    } catch (e) {
      this.log(`[${this.o.name}] request error: ${e.message}`);
      return { ok: false, reason: e.message };
    }
  }
}
