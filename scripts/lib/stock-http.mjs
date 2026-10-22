/**
 * Polite, bounded HTTP for the stock monitor's public sources.
 *
 * Every request is a plain GET without cookies or credentials. A run has a
 * fixed request budget, requests to one host are spaced out, responses are
 * cut off at a size limit, and redirects are followed only to hosts the
 * source declared. A 429, 403 or 503 ends the source's check as rate-limited
 * or blocked instead of being retried or worked around.
 *
 * Each host's robots.txt is read before its first request (and again after a
 * day) and followed for the source's user agent, as RFC 9309 says: a missing
 * robots.txt allows everything, an unreachable one allows nothing.
 */

export const DEFAULT_USER_AGENT = "HillaStockWatch/1.0 (personal research assistant; one user; hourly)";
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 3_000_000;
const ROBOTS_MAX_BYTES = 500_000;
const ROBOTS_TTL_MS = 24 * 3_600_000;
const MAX_REDIRECTS = 3;
/** A robots.txt Crawl-delay is followed up to this many seconds; a site asking for more is read less often by the scheduler instead. */
const MAX_CRAWL_DELAY_S = 30;

/**
 * A fetcher for one run. `robots` is a cache object kept by the caller between
 * runs ({ [origin]: { fetchedAt, status, groups } }); it is updated in place.
 */
export function createSourceFetcher({
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  maxRequests = 60,
  minIntervalMs = 1_000,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES,
  robots = {},
} = {}) {
  let used = 0;
  const lastRequestAt = new Map();
  const crawlDelayMs = new Map();
  // Feeds that serve several followed companies at once (a country feed) are fetched once per run.
  const shared = new Map();

  async function request(url, { userAgent, accept, maxResponseBytes = maxBytes, headers = {}, partial = false }) {
    if (used >= maxRequests) return { status: "budget", reason: "The run's request budget is used up." };
    used += 1;
    const host = url.host;
    const spacing = Math.max(minIntervalMs, crawlDelayMs.get(host) ?? 0);
    const waited = lastRequestAt.has(host) ? spacing - (now().getTime() - lastRequestAt.get(host)) : 0;
    if (waited > 0) await sleep(waited);
    lastRequestAt.set(host, now().getTime());
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url.toString(), {
        method: "GET",
        headers: { "user-agent": userAgent, accept, "accept-language": "en, sv;q=0.8, fi;q=0.7", ...headers },
        redirect: "manual",
        credentials: "omit",
        signal: controller.signal,
      });
      const body = response.status >= 300 && response.status < 400 ? "" : await readLimited(response, maxResponseBytes, { partial });
      return { status: "response", response, body };
    } catch (error) {
      if (error?.code === "TOO_LARGE") return { status: "error", reason: `The response is larger than ${Math.round(maxResponseBytes / 1000)} kB.` };
      return { status: "error", reason: error?.name === "AbortError" ? "Timed out." : `Request failed: ${shortError(error)}` };
    } finally {
      clearTimeout(timer);
    }
  }

  async function robotsAllow(url, userAgent) {
    const origin = url.origin;
    const cached = robots[origin];
    if (!cached || now().getTime() - Date.parse(cached.fetchedAt) > ROBOTS_TTL_MS) {
      // RFC 9309: follow up to five redirects, even to another host; whatever answers there is the robots.txt.
      let robotsUrl = new URL("/robots.txt", origin);
      let result;
      for (let hop = 0; hop <= 5; hop += 1) {
        result = await request(robotsUrl, { userAgent, accept: "text/plain", maxResponseBytes: ROBOTS_MAX_BYTES });
        const status = result.status === "response" ? result.response.status : null;
        const location = status >= 300 && status < 400 ? result.response.headers.get("location") : null;
        if (!location) break;
        const next = new URL(location, robotsUrl);
        if (next.protocol !== "https:" || hop === 5) {
          result = { status: "error" };
          break;
        }
        robotsUrl = next;
      }
      if (result.status === "budget") return { allowed: false, reason: result.reason, budget: true };
      let entry;
      if (result.status !== "response") entry = { status: "unreachable" };
      else if (result.response.status >= 200 && result.response.status < 300) entry = { status: "ok", groups: parseRobots(result.body) };
      else if (result.response.status >= 400 && result.response.status < 500) entry = { status: "missing" };
      else entry = { status: "unreachable" };
      robots[origin] = { ...entry, fetchedAt: now().toISOString() };
    }
    const entry = robots[origin];
    if (entry.status === "ok") {
      const delay = robotsCrawlDelay(entry.groups, userAgent);
      if (delay) crawlDelayMs.set(url.host, Math.min(delay, MAX_CRAWL_DELAY_S) * 1000);
    }
    if (entry.status === "missing") return { allowed: true };
    if (entry.status !== "ok") return { allowed: false, reason: `${url.host}/robots.txt could not be read, so the site is not checked.` };
    return robotsAllows(entry.groups, userAgent, `${url.pathname}${url.search}`)
      ? { allowed: true }
      : { allowed: false, reason: `${url.host}/robots.txt does not allow this page.` };
  }

  /**
   * One GET. `hosts` are the hosts this source may be served from, including
   * redirects. Returns { status: ok | not_modified | blocked | rate_limited |
   * not_found | error | budget, body, httpStatus, url, etag, lastModified, reason }.
   */
  async function get(target, options = {}) {
    if (!options.shared) return fetchOnce(target, options);
    if (!shared.has(target)) shared.set(target, fetchOnce(target, { ...options, etag: null, lastModified: null }));
    return shared.get(target);
  }

  async function fetchOnce(target, { hosts, userAgent = DEFAULT_USER_AGENT, accept = "*/*", maxResponseBytes, etag = null, lastModified = null, firstBytes = null } = {}) {
    let url = new URL(target);
    if (url.protocol !== "https:") return { status: "error", reason: "Only https sources are read." };
    if (!hosts.includes(url.host)) return { status: "error", reason: `${url.host} is not one of this source's hosts.` };
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const permission = await robotsAllow(url, userAgent);
      if (!permission.allowed) return { status: permission.budget ? "budget" : "blocked", reason: permission.reason };
      const conditional = hop === 0 ? { ...(etag ? { "if-none-match": etag } : {}), ...(lastModified ? { "if-modified-since": lastModified } : {}) } : {};
      // `firstBytes` asks for only the start of a document, enough to know it is there and what it is.
      if (firstBytes) conditional.range = `bytes=0-${firstBytes - 1}`;
      const result = await request(url, { userAgent, accept, maxResponseBytes: firstBytes ?? maxResponseBytes, headers: conditional, partial: Boolean(firstBytes) });
      if (result.status !== "response") return { status: result.status, reason: result.reason };
      const { response, body } = result;
      const httpStatus = response.status;
      if (httpStatus >= 300 && httpStatus < 400 && httpStatus !== 304) {
        const location = response.headers.get("location");
        if (!location) return { status: "error", httpStatus, reason: `HTTP ${httpStatus} without a location.` };
        const next = new URL(location, url);
        if (next.protocol !== "https:" || !hosts.includes(next.host)) return { status: "blocked", httpStatus, reason: `Redirected to ${next.host}, which this source does not use.` };
        url = next;
        continue;
      }
      const meta = { httpStatus, url: url.toString(), etag: response.headers.get("etag"), lastModified: response.headers.get("last-modified") };
      if (httpStatus === 304) return { status: "not_modified", ...meta };
      if (httpStatus === 429) return { status: "rate_limited", ...meta, retryAfter: response.headers.get("retry-after"), reason: "The source asked to slow down (HTTP 429)." };
      if (httpStatus === 403 || httpStatus === 401 || httpStatus === 451) return { status: "blocked", ...meta, reason: `The source refused the request (HTTP ${httpStatus}).` };
      if (httpStatus === 404 || httpStatus === 410) return { status: "not_found", ...meta, reason: `Not found (HTTP ${httpStatus}).` };
      if (httpStatus === 503) return { status: "rate_limited", ...meta, retryAfter: response.headers.get("retry-after"), reason: "The source is unavailable (HTTP 503)." };
      if (httpStatus < 200 || httpStatus >= 300) return { status: "error", ...meta, reason: `HTTP ${httpStatus}.` };
      return { status: "ok", body, ...meta };
    }
    return { status: "error", reason: "Too many redirects." };
  }

  return { get, requestsUsed: () => used, robots };
}

/** The body, at most `maxBytes`. Past that it is an error, unless only the start was wanted (`partial`). */
async function readLimited(response, maxBytes, { partial = false } = {}) {
  const length = Number(response.headers.get("content-length"));
  if (!partial && Number.isFinite(length) && length > maxBytes) {
    await response.body?.cancel?.();
    throw Object.assign(new Error("too large"), { code: "TOO_LARGE" });
  }
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) {
      if (partial) return Buffer.from(text).subarray(0, maxBytes).toString("latin1");
      throw Object.assign(new Error("too large"), { code: "TOO_LARGE" });
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      if (partial) {
        chunks.push(Buffer.from(value));
        return Buffer.concat(chunks).subarray(0, maxBytes).toString("latin1");
      }
      throw Object.assign(new Error("too large"), { code: "TOO_LARGE" });
    }
    chunks.push(Buffer.from(value));
  }
  return partial ? Buffer.concat(chunks).toString("latin1") : Buffer.concat(chunks).toString("utf8");
}

function shortError(error) {
  const cause = error?.cause?.code ?? error?.code ?? error?.message ?? "unknown error";
  return String(cause).replace(/https?:\/\/\S+/g, "<url>").slice(0, 120);
}

// --- robots.txt ------------------------------------------------------------------------

/** The Crawl-delay, in seconds, of the group that applies to `userAgent`; null without one. */
export function robotsCrawlDelay(groups, userAgent) {
  const delays = applicableGroups(groups, userAgent).map((group) => group.crawlDelay).filter((value) => Number.isFinite(value) && value > 0);
  return delays.length > 0 ? Math.max(...delays) : null;
}

/** Groups of `{ agents: [...], rules: [{ allow, path }], crawlDelay }`, as RFC 9309 reads a robots.txt. */
export function parseRobots(text) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (field === "user-agent") {
      if (!lastWasAgent || !current) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (field === "allow" || field === "disallow") current.rules.push({ allow: field === "allow", path: value });
    if (field === "crawl-delay" && Number.isFinite(Number(value))) current.crawlDelay = Number(value);
  }
  return groups;
}

/**
 * Whether `path` may be fetched by `userAgent`: the group naming the agent's
 * product token wins over `*`; within a group the longest matching rule wins,
 * and Allow wins a tie. An empty Disallow allows everything.
 */
export function robotsAllows(groups, userAgent, path) {
  const rules = applicableGroups(groups, userAgent).flatMap((group) => group.rules).filter((rule) => rule.path !== "");
  let best = null;
  for (const rule of rules) {
    if (!robotsPathMatches(rule.path, path)) continue;
    const length = rule.path.replace(/\*/g, "").length;
    if (!best || length > best.length || (length === best.length && rule.allow && !best.allow)) best = { allow: rule.allow, length };
  }
  return best ? best.allow : true;
}

/** The groups naming the agent's product token, or else the `*` groups. */
function applicableGroups(groups, userAgent) {
  const token = String(userAgent).split("/")[0].trim().toLowerCase();
  const named = groups.filter((group) => group.agents.some((agent) => agent !== "*" && token.startsWith(agent)));
  return named.length > 0 ? named : groups.filter((group) => group.agents.includes("*"));
}

function robotsPathMatches(pattern, path) {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const source = body
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}${anchored ? "$" : ""}`).test(decodePercent(path));
}

function decodePercent(path) {
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}
