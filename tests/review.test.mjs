import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createOpenRouterClient,
  MISSING_KEY_MESSAGE,
  normalizeUsage,
  openRouterKeyStatus,
  redactSecrets,
} from "../scripts/lib/openrouter.mjs";
import {
  buildReviewMessages,
  collectReviewContext,
  formatReviewSummary,
  parseReviewResponse,
  reconcileVerdict,
  REVIEW_VERDICTS,
} from "../scripts/lib/review.mjs";
import { parseReviewArgs, REVIEW_EXIT, runReviewCli } from "../scripts/review.mjs";

const config = JSON.parse(readFileSync("config/review.json", "utf8"));

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
    async text() { return typeof body === "string" ? body : JSON.stringify(body); },
  };
}

function completion(content, extra = {}) {
  return {
    model: "openai/gpt-5.6-luna-pro",
    choices: [{ message: { role: "assistant", content } }],
    usage: { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500, cost: 0.0024 },
    ...extra,
  };
}

const cleanReview = JSON.stringify({
  verdict: "PASS",
  summary: "No defects found.",
  findings: [],
  notes: [],
});

const blockingReview = JSON.stringify({
  verdict: "BLOCKERS",
  summary: "One real defect.",
  findings: [{
    severity: "blocking",
    title: "Empty description is dropped",
    file: "scripts/lib/todoist.mjs",
    evidence: "update with description '' sends {} instead of {description:''}",
    recommendation: "Keep empty strings for description",
  }],
  notes: ["Consider a no-op short circuit"],
});

/** Fake git so no test depends on the real repository history. */
function fakeGit(diff = "diff --git a/a.mjs b/a.mjs\n+const a = 1;\n") {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (args[1] === "--stat") return " a.mjs | 1 +\n";
    if (args[0] === "log") return "abc1234 Add a\n";
    return diff;
  };
  run.calls = calls;
  return run;
}

/** A fetch that fails the test if it is ever called. */
const forbiddenFetch = async () => {
  throw new Error("the review harness must not reach the network in tests");
};

describe("OpenRouter client", () => {
  it("reports key configuration without exposing the key", () => {
    assert.deepEqual(openRouterKeyStatus({}), { configured: false });
    assert.deepEqual(openRouterKeyStatus({ OPENROUTER_API_KEY: "sk-or-secret" }), { configured: true });
  });

  it("refuses to run without a key and explains the setup", () => {
    assert.throws(() => createOpenRouterClient({ apiKey: "" }), (error) => {
      assert.equal(error.message, MISSING_KEY_MESSAGE);
      assert.match(error.message, /OPENROUTER_API_KEY/);
      assert.match(error.message, /docs\/setup\/review\.md/);
      assert.match(error.message, /will not fall back to reviewing its own work/);
      return true;
    });
  });

  it("builds the request OpenRouter expects", async () => {
    const calls = [];
    const client = createOpenRouterClient({
      apiKey: "sk-or-secret",
      appTitle: "Hilla independent review",
      fetchImpl: async (url, init) => {
        calls.push({ url, init, body: JSON.parse(init.body) });
        return jsonResponse(completion(cleanReview));
      },
    });

    const result = await client.complete({
      model: "openai/gpt-5.6-luna-pro",
      messages: [{ role: "user", content: "review this" }],
      maxCompletionTokens: 6000,
      temperature: 0,
    });

    assert.equal(calls[0].url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.headers.Authorization, "Bearer sk-or-secret");
    assert.equal(calls[0].init.headers["X-Title"], "Hilla independent review");
    assert.deepEqual(calls[0].body, {
      model: "openai/gpt-5.6-luna-pro",
      messages: [{ role: "user", content: "review this" }],
      temperature: 0,
      max_completion_tokens: 6000,
    });
    assert.equal(result.content, cleanReview);
    assert.deepEqual(result.usage, {
      promptTokens: 1200,
      completionTokens: 300,
      totalTokens: 1500,
      costUsd: 0.0024,
    });
  });

  it("translates transport failures without leaking the key", async () => {
    const cases = [
      [401, /rejected the API key/],
      [402, /insufficient credit/],
      [429, /rate-limited/],
      [500, /OpenRouter request failed: 500/],
    ];

    for (const [status, pattern] of cases) {
      const client = createOpenRouterClient({
        apiKey: "sk-or-secret",
        fetchImpl: async () => jsonResponse("upstream said sk-or-secret", status),
      });

      await assert.rejects(() => client.complete({ model: "m", messages: [] }), (error) => {
        assert.match(error.message, pattern);
        assert.doesNotMatch(error.message, /sk-or-secret/);
        return true;
      });
    }
  });

  it("redacts key-shaped text even when the key itself is unknown", () => {
    assert.equal(redactSecrets("leaked sk-or-v1-abc.def_ghi here", null), "leaked [redacted] here");
    assert.equal(redactSecrets("echo sk-or-secret", "sk-or-secret"), "echo [redacted]");
  });

  it("rejects an error body and an empty completion", async () => {
    const withError = createOpenRouterClient({
      apiKey: "sk-or-secret",
      fetchImpl: async () => jsonResponse({ error: { code: 400, message: "bad model" } }),
    });
    await assert.rejects(() => withError.complete({ model: "m", messages: [] }), /bad model/);

    const empty = createOpenRouterClient({
      apiKey: "sk-or-secret",
      fetchImpl: async () => jsonResponse(completion("   ")),
    });
    await assert.rejects(() => empty.complete({ model: "m", messages: [] }), /no review content/);
  });

  it("tolerates a response without usage accounting", () => {
    assert.equal(normalizeUsage(undefined), null);
    assert.deepEqual(normalizeUsage({ prompt_tokens: 5 }), {
      promptTokens: 5,
      completionTokens: null,
      totalTokens: null,
      costUsd: null,
    });
  });
});

describe("review prompt and context", () => {
  it("gives the reviewer the objective, diff and evidence, and nothing about how it was written", () => {
    const messages = buildReviewMessages({
      objective: "Tasks must keep user text intact.",
      diff: "diff --git a/a.mjs b/a.mjs",
      diffStat: " a.mjs | 1 +",
      commits: "abc1234 Add a",
      testSummary: "329 passing",
    });

    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, "system");
    assert.match(messages[0].content, /independent code reviewer/i);
    assert.match(messages[0].content, /bypassing the real boundary/i);
    assert.match(messages[0].content, /concrete failure/i);
    assert.match(messages[1].content, /Tasks must keep user text intact\./);
    assert.match(messages[1].content, /abc1234 Add a/);
    assert.match(messages[1].content, /329 passing/);
    assert.match(messages[1].content, /```diff/);
  });

  it("is stable for identical input", () => {
    const input = { diff: "diff --git a/a b/a", diffStat: "s", commits: "c" };
    assert.deepEqual(buildReviewMessages(input), buildReviewMessages(input));
  });

  it("refuses to review an empty diff", () => {
    assert.throws(() => buildReviewMessages({ diff: "   " }), /non-empty diff is required/);
  });

  it("reads the three-dot range and reports truncation instead of hiding it", () => {
    const git = fakeGit();
    const context = collectReviewContext({ base: "main", head: "HEAD", git });

    assert.deepEqual(git.calls[0], ["diff", "main...HEAD"]);
    assert.equal(context.truncated, false);
    assert.equal(context.diffStat, "a.mjs | 1 +");

    const big = collectReviewContext({ git: fakeGit("x".repeat(500)), maxDiffBytes: 100 });
    assert.equal(big.truncated, true);
    assert.equal(big.diff.length, 100);
    assert.match(buildReviewMessages({ ...big }).at(1).content, /truncated/i);
  });

  it("reports an empty range rather than reviewing nothing", () => {
    assert.throws(
      () => collectReviewContext({ git: fakeGit("") }),
      /No changes found between main and HEAD/,
    );
  });
});

describe("reviewer output parsing", () => {
  it("accepts bare JSON, fenced JSON, and JSON wrapped in prose", () => {
    for (const content of [
      cleanReview,
      "```json\n" + cleanReview + "\n```",
      "Here is my review:\n" + cleanReview + "\nThat is all.",
    ]) {
      assert.equal(parseReviewResponse(content).verdict, "PASS");
    }
  });

  it("rejects malformed output instead of treating it as a pass", () => {
    for (const [content, pattern] of [
      ["not json at all", /could not be parsed as JSON/],
      ["", /empty response/],
      ["[1,2,3]", /did not return a JSON object/],
      ['{"verdict":"LOOKS_FINE"}', /unknown verdict/],
      ['{"verdict":"PASS","findings":"none"}', /findings that are not a list/],
      ['{"verdict":"PASS","notes":"none"}', /notes that are not a list/],
    ]) {
      assert.throws(() => parseReviewResponse(content), pattern, `content: ${content}`);
    }
  });

  it("normalizes severities and keeps evidence", () => {
    const parsed = parseReviewResponse(JSON.stringify({
      verdict: "BLOCKERS",
      findings: [
        { severity: "Critical", title: "a", evidence: "e" },
        { severity: "nitpick", title: "b" },
        { severity: "BLOCKER", title: "c" },
      ],
    }));

    assert.deepEqual(parsed.findings.map((finding) => finding.severity), ["blocking", "note", "blocking"]);
    assert.equal(parsed.findings[0].evidence, "e");
    assert.equal(parsed.findings[1].title, "b");
  });
});

describe("verdict reconciliation", () => {
  it("cannot be talked out of a blocking finding", () => {
    const parsed = parseReviewResponse(JSON.stringify({
      verdict: "PASS",
      findings: [{ severity: "blocking", title: "real defect", evidence: "x -> y" }],
    }));

    assert.equal(parsed.claimedVerdict, "PASS");
    assert.equal(parsed.verdict, "BLOCKERS");
    assert.match(
      formatReviewSummary({ ...parsed, model: "m", usage: null }),
      /Verdict adjusted from the reviewer's claimed PASS/,
    );
  });

  it("keeps a claimed blocker even with no structured findings", () => {
    assert.equal(reconcileVerdict("BLOCKERS", [], []), "BLOCKERS");
  });

  it("separates a clean pass from a pass with notes", () => {
    assert.equal(reconcileVerdict("PASS", [], []), "PASS");
    assert.equal(reconcileVerdict("PASS", [], ["a note"]), "PASS_WITH_NOTES");
    assert.equal(reconcileVerdict("PASS", [{ severity: "note", title: "t" }], []), "PASS_WITH_NOTES");
    assert.deepEqual(REVIEW_VERDICTS, ["BLOCKERS", "PASS_WITH_NOTES", "PASS"]);
  });
});

describe("review CLI", () => {
  const base = { config, git: fakeGit(), env: { OPENROUTER_API_KEY: "sk-or-secret" } };

  it("parses arguments with sensible defaults", () => {
    assert.deepEqual(parseReviewArgs([]), {
      base: "main", head: "HEAD", json: false, dryRun: false, second: false,
    });
    assert.equal(parseReviewArgs(["--base", "main", "--head", "topic"]).head, "topic");
    assert.throws(() => parseReviewArgs(["--nope", "x"]), /Unknown review option/);
    assert.throws(() => parseReviewArgs(["--base"]), /requires a value/);
  });

  it("spends nothing on a dry run and reports what it would send", async () => {
    const result = await runReviewCli(["--dry-run"], { ...base, fetchImpl: forbiddenFetch });

    assert.equal(result.dryRun, true);
    assert.equal(result.exitCode, REVIEW_EXIT.clean);
    assert.deepEqual(result.models, [config.primaryModel]);
    assert.ok(result.promptBytes > 0);
    assert.equal(result.limits.maxCostUsd, config.maxCostUsd);
  });

  it("returns a clean verdict and exit code zero", async () => {
    const result = await runReviewCli([], {
      ...base,
      fetchImpl: async () => jsonResponse(completion(cleanReview)),
    });

    assert.equal(result.verdict, "PASS");
    assert.equal(result.exitCode, REVIEW_EXIT.clean);
    assert.equal(result.reviews[0].model, "openai/gpt-5.6-luna-pro");
    assert.equal(result.totalCostUsd, 0.0024);
  });

  it("returns exit code one when the reviewer finds a blocker", async () => {
    const result = await runReviewCli([], {
      ...base,
      fetchImpl: async () => jsonResponse(completion(blockingReview)),
    });

    assert.equal(result.verdict, "BLOCKERS");
    assert.equal(result.exitCode, REVIEW_EXIT.blockers);
    assert.equal(result.reviews[0].findings[0].severity, "blocking");
  });

  it("fails clearly without a key instead of reviewing its own work", async () => {
    await assert.rejects(
      () => runReviewCli([], { ...base, env: {}, fetchImpl: forbiddenFetch }),
      (error) => {
        assert.equal(error.message, MISSING_KEY_MESSAGE);
        return true;
      },
    );
  });

  it("asks a second reviewer only when requested, and takes the worst verdict", async () => {
    const asked = [];
    const fetchImpl = async (_url, init) => {
      const body = JSON.parse(init.body);
      asked.push(body.model);
      return jsonResponse(completion(asked.length === 1 ? cleanReview : blockingReview));
    };

    const single = await runReviewCli([], { ...base, fetchImpl: async () => jsonResponse(completion(cleanReview)) });
    assert.equal(single.reviews.length, 1);

    const both = await runReviewCli(["--second"], { ...base, fetchImpl });
    assert.deepEqual(asked, [config.primaryModel, config.secondaryModel]);
    assert.equal(both.reviews.length, 2);
    assert.equal(both.verdict, "BLOCKERS");
  });

  it("warns when a review costs more than the configured ceiling", async () => {
    const result = await runReviewCli([], {
      ...base,
      config: { ...config, maxCostUsd: 0.001 },
      fetchImpl: async () => jsonResponse(completion(cleanReview)),
    });

    assert.match(result.reviews[0].costWarning, /above the configured ceiling/);
  });

  it("surfaces malformed reviewer output as an error, never as a pass", async () => {
    await assert.rejects(
      () => runReviewCli([], {
        ...base,
        fetchImpl: async () => jsonResponse(completion("I think it looks good to me!")),
      }),
      /could not be parsed as JSON/,
    );
  });
});
