import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSourceFetcher, parseRobots, robotsAllows } from "../scripts/lib/stock-http.mjs";

/** A fake network: `routes` maps a URL to a response or a function of the request. */
function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers, redirect: init.redirect });
    const route = routes[url] ?? routes[new URL(url).origin + new URL(url).pathname];
    const spec = typeof route === "function" ? route(url, init) : route;
    if (!spec) return new Response("not found", { status: 404 });
    if (spec instanceof Error) throw spec;
    return new Response(spec.body ?? "", { status: spec.status ?? 200, headers: spec.headers ?? {} });
  };
  return { fetchImpl, calls };
}

const ALLOW_ALL = { body: "User-agent: *\nAllow: /\n" };

describe("robots.txt", () => {
  const groups = parseRobots(["User-agent: *", "Disallow: /private/", "Allow: /private/public", "Disallow: /*.pdf$", "", "User-agent: HillaStockWatch", "Disallow: /no-hilla"].join("\n"));

  it("follows the longest matching rule, Allow winning a tie", () => {
    assert.equal(robotsAllows(groups, "OtherBot/1.0", "/news"), true);
    assert.equal(robotsAllows(groups, "OtherBot/1.0", "/private/x"), false);
    assert.equal(robotsAllows(groups, "OtherBot/1.0", "/private/public/x"), true);
    assert.equal(robotsAllows(groups, "OtherBot/1.0", "/report.pdf"), false);
    assert.equal(robotsAllows(groups, "OtherBot/1.0", "/report.pdf?x=1"), true, "$ anchors the end");
  });

  it("uses the group that names the agent instead of the * group", () => {
    assert.equal(robotsAllows(groups, "HillaStockWatch/1.0 (personal)", "/no-hilla"), false);
    assert.equal(robotsAllows(groups, "HillaStockWatch/1.0 (personal)", "/private/x"), true, "the * rules no longer apply");
  });

  it("treats an empty Disallow as allowing everything", () => {
    assert.equal(robotsAllows(parseRobots("User-agent: *\nDisallow:\n"), "Any", "/x"), true);
  });
});

describe("source fetcher", () => {
  it("reads robots.txt first, sends no cookies and returns the body", async () => {
    const { fetchImpl, calls } = fakeFetch({ "https://feed.example/robots.txt": ALLOW_ALL, "https://feed.example/rss": { body: "<rss/>", headers: { etag: '"v1"' } } });
    const fetcher = createSourceFetcher({ fetchImpl, sleep: async () => {} });
    const result = await fetcher.get("https://feed.example/rss", { hosts: ["feed.example"] });
    assert.equal(result.status, "ok");
    assert.equal(result.body, "<rss/>");
    assert.equal(result.etag, '"v1"');
    assert.deepEqual(calls.map((call) => new URL(call.url).pathname), ["/robots.txt", "/rss"]);
    assert.equal(calls[1].headers.cookie, undefined);
    assert.equal(calls[1].redirect, "manual");
    assert.equal(fetcher.requestsUsed(), 2);
  });

  it("does not fetch what robots.txt disallows", async () => {
    const { fetchImpl, calls } = fakeFetch({ "https://feed.example/robots.txt": { body: "User-agent: *\nDisallow: /search\n" } });
    const result = await createSourceFetcher({ fetchImpl, sleep: async () => {} }).get("https://feed.example/search?q=x", { hosts: ["feed.example"] });
    assert.equal(result.status, "blocked");
    assert.equal(calls.length, 1);
  });

  it("allows everything when robots.txt is missing, and nothing when it is unreachable", async () => {
    const missing = fakeFetch({ "https://a.example/robots.txt": { status: 404 }, "https://a.example/x": { body: "ok" } });
    assert.equal((await createSourceFetcher({ fetchImpl: missing.fetchImpl, sleep: async () => {} }).get("https://a.example/x", { hosts: ["a.example"] })).status, "ok");
    const down = fakeFetch({ "https://b.example/robots.txt": { status: 500 }, "https://b.example/x": { body: "ok" } });
    const result = await createSourceFetcher({ fetchImpl: down.fetchImpl, sleep: async () => {} }).get("https://b.example/x", { hosts: ["b.example"] });
    assert.equal(result.status, "blocked");
    assert.equal(down.calls.length, 1);
  });

  it("reuses the robots cache between runs", async () => {
    const robots = {};
    const first = fakeFetch({ "https://feed.example/robots.txt": ALLOW_ALL, "https://feed.example/rss": { body: "a" } });
    await createSourceFetcher({ fetchImpl: first.fetchImpl, sleep: async () => {}, robots }).get("https://feed.example/rss", { hosts: ["feed.example"] });
    const second = fakeFetch({ "https://feed.example/rss": { body: "b" } });
    await createSourceFetcher({ fetchImpl: second.fetchImpl, sleep: async () => {}, robots }).get("https://feed.example/rss", { hosts: ["feed.example"] });
    assert.deepEqual(second.calls.map((call) => new URL(call.url).pathname), ["/rss"]);
  });

  it("reports rate limits and refusals instead of retrying", async () => {
    const { fetchImpl, calls } = fakeFetch({
      "https://feed.example/robots.txt": ALLOW_ALL,
      "https://feed.example/slow": { status: 429, headers: { "retry-after": "120" } },
      "https://feed.example/no": { status: 403 },
      "https://feed.example/down": { status: 503 },
    });
    const fetcher = createSourceFetcher({ fetchImpl, sleep: async () => {} });
    const slow = await fetcher.get("https://feed.example/slow", { hosts: ["feed.example"] });
    assert.equal(slow.status, "rate_limited");
    assert.equal(slow.retryAfter, "120");
    assert.equal((await fetcher.get("https://feed.example/no", { hosts: ["feed.example"] })).status, "blocked");
    assert.equal((await fetcher.get("https://feed.example/down", { hosts: ["feed.example"] })).status, "rate_limited");
    assert.equal(calls.filter((call) => call.url.endsWith("/slow")).length, 1);
  });

  it("follows redirects only within the source's hosts", async () => {
    const { fetchImpl } = fakeFetch({
      "https://feed.example/robots.txt": ALLOW_ALL,
      "https://cdn.feed.example/robots.txt": ALLOW_ALL,
      "https://feed.example/a": { status: 301, headers: { location: "https://cdn.feed.example/a" } },
      "https://cdn.feed.example/a": { body: "moved" },
      "https://feed.example/b": { status: 302, headers: { location: "https://tracker.example/b" } },
    });
    const fetcher = createSourceFetcher({ fetchImpl, sleep: async () => {} });
    assert.equal((await fetcher.get("https://feed.example/a", { hosts: ["feed.example", "cdn.feed.example"] })).body, "moved");
    const away = await fetcher.get("https://feed.example/b", { hosts: ["feed.example"] });
    assert.equal(away.status, "blocked");
    assert.match(away.reason, /tracker\.example/);
  });

  it("stops at the run's request budget and cuts off oversized responses", async () => {
    const { fetchImpl } = fakeFetch({ "https://feed.example/robots.txt": ALLOW_ALL, "https://feed.example/big": { body: "x".repeat(5000) }, "https://feed.example/small": { body: "ok" } });
    const fetcher = createSourceFetcher({ fetchImpl, sleep: async () => {}, maxRequests: 2, maxBytes: 1000 });
    const big = await fetcher.get("https://feed.example/big", { hosts: ["feed.example"] });
    assert.equal(big.status, "error");
    assert.match(big.reason, /larger than/);
    assert.equal((await fetcher.get("https://feed.example/small", { hosts: ["feed.example"] })).status, "budget");
  });

  it("spaces out requests to one host", async () => {
    const { fetchImpl } = fakeFetch({ "https://feed.example/robots.txt": ALLOW_ALL, "https://feed.example/a": { body: "1" }, "https://feed.example/b": { body: "2" } });
    const waits = [];
    const fetcher = createSourceFetcher({ fetchImpl, sleep: async (ms) => waits.push(ms), minIntervalMs: 1000 });
    await fetcher.get("https://feed.example/a", { hosts: ["feed.example"] });
    await fetcher.get("https://feed.example/b", { hosts: ["feed.example"] });
    assert.equal(waits.length, 2, "robots.txt, the first page and the second page are spaced");
    assert.ok(waits.every((ms) => ms > 0 && ms <= 1000));
  });

  it("refuses plain http and hosts the source did not declare", async () => {
    const fetcher = createSourceFetcher({ fetchImpl: async () => assert.fail("no request"), sleep: async () => {} });
    assert.equal((await fetcher.get("http://feed.example/rss", { hosts: ["feed.example"] })).status, "error");
    assert.equal((await fetcher.get("https://other.example/rss", { hosts: ["feed.example"] })).status, "error");
  });

  it("keeps URLs out of network error messages", async () => {
    const { fetchImpl } = fakeFetch({ "https://feed.example/robots.txt": ALLOW_ALL, "https://feed.example/x": new Error("connect ECONNREFUSED https://feed.example/x?token=abc") });
    const result = await createSourceFetcher({ fetchImpl, sleep: async () => {} }).get("https://feed.example/x", { hosts: ["feed.example"] });
    assert.equal(result.status, "error");
    assert.ok(!result.reason.includes("token=abc"));
  });
});

describe("robots.txt redirects and crawl delays", () => {
  it("follows a robots.txt redirect, and treats a page without rules as allowing everything", async () => {
    const { fetchImpl, calls } = fakeFetch({
      "https://register.example/robots.txt": { status: 301, headers: { location: "https://www.register.example/robots-page" } },
      "https://www.register.example/robots-page": { body: "<html><body>Moved</body></html>" },
      "https://register.example/select": { body: "{}" },
    });
    const result = await createSourceFetcher({ fetchImpl, sleep: async () => {} }).get("https://register.example/select?q=x", { hosts: ["register.example"] });
    assert.equal(result.status, "ok");
    assert.deepEqual(calls.map((call) => new URL(call.url).pathname), ["/robots.txt", "/robots-page", "/select"]);
  });

  it("keeps a site's Crawl-delay between its requests", async () => {
    const { fetchImpl } = fakeFetch({ "https://tools.example/robots.txt": { body: "User-agent: *\nCrawl-Delay: 20\nAllow: /tools/\nDisallow: /\n" }, "https://tools.example/tools/a": { body: "a" }, "https://tools.example/tools/b": { body: "b" } });
    const waits = [];
    let clock = 0;
    const fetcher = createSourceFetcher({ fetchImpl, now: () => new Date(clock), sleep: async (ms) => { waits.push(ms); clock += ms; }, minIntervalMs: 1000 });
    await fetcher.get("https://tools.example/tools/a", { hosts: ["tools.example"] });
    await fetcher.get("https://tools.example/tools/b", { hosts: ["tools.example"] });
    assert.deepEqual(waits, [20_000, 20_000]);
    assert.equal((await fetcher.get("https://tools.example/other", { hosts: ["tools.example"] })).status, "blocked");
  });

  it("fetches a shared feed once per run, however many companies read it", async () => {
    const { fetchImpl, calls } = fakeFetch({ "https://feeds.example/robots.txt": ALLOW_ALL, "https://feeds.example/country": { body: "<rss/>" } });
    const fetcher = createSourceFetcher({ fetchImpl, sleep: async () => {} });
    const first = await fetcher.get("https://feeds.example/country", { hosts: ["feeds.example"], shared: true });
    const second = await fetcher.get("https://feeds.example/country", { hosts: ["feeds.example"], shared: true });
    assert.equal(first.body, second.body);
    assert.equal(calls.filter((call) => call.url.endsWith("/country")).length, 1);
  });

  it("asks for only a document's first bytes, and accepts a server that sends the whole file", async () => {
    const big = `%PDF-1.7${"x".repeat(100_000)}`;
    const { fetchImpl, calls } = fakeFetch({ "https://docs.example/robots.txt": ALLOW_ALL, "https://docs.example/report.pdf": { body: big } });
    const result = await createSourceFetcher({ fetchImpl, sleep: async () => {}, maxBytes: 1000 }).get("https://docs.example/report.pdf", { hosts: ["docs.example"], firstBytes: 2048 });
    assert.equal(result.status, "ok");
    assert.ok(result.body.startsWith("%PDF") && result.body.length <= 2048);
    assert.equal(calls[1].headers.range, "bytes=0-2047");
  });
});
