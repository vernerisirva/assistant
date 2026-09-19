#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createOpenRouterClient, MISSING_KEY_MESSAGE, redactSecrets } from "./lib/openrouter.mjs";
import {
  buildReviewMessages,
  collectReviewContext,
  DEFAULT_OBJECTIVE,
  formatReviewSummary,
  parseReviewResponse,
  plain,
} from "./lib/review.mjs";
import { mergedEnv } from "./lib/env.mjs";
import { projectPath, readJson } from "./lib/config.mjs";

const currentFile = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(currentFile), "..");

export const REVIEW_EXIT = Object.freeze({ clean: 0, blockers: 1, error: 2 });

export function parseReviewArgs(argv) {
  const options = { base: "main", head: "HEAD", json: false, dryRun: false, second: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--json") { options.json = true; continue; }
    if (arg === "--dry-run") { options.dryRun = true; continue; }
    if (arg === "--second") { options.second = true; continue; }

    const valued = ["--base", "--head", "--model", "--objective", "--test-summary"];
    if (!valued.includes(arg)) throw new Error(`Unknown review option: ${arg}`);

    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${arg} requires a value.`);
    }
    index += 1;

    switch (arg) {
      case "--base": options.base = value; break;
      case "--head": options.head = value; break;
      case "--model": options.model = value; break;
      case "--objective": options.objective = value; break;
      case "--test-summary": options.testSummary = value; break;
    }
  }

  return options;
}

export async function runReviewCli(argv, {
  env = mergedEnv(projectPath(projectRoot, ".env")),
  config = readJson(projectPath(projectRoot, "config/review.json")),
  fetchImpl,
  git,
} = {}) {
  const options = parseReviewArgs(argv);

  const client = options.dryRun
    ? null
    : createOpenRouterClient({
        apiKey: env.OPENROUTER_API_KEY,
        fetchImpl,
        endpoint: config.endpoint,
        appTitle: config.appTitle,
      });

  const context = collectReviewContext({
    base: options.base,
    head: options.head,
    maxDiffBytes: config.maxDiffBytes,
    git,
  });

  const messages = buildReviewMessages({
    objective: options.objective?.trim() || DEFAULT_OBJECTIVE,
    diff: context.diff,
    diffStat: context.diffStat,
    commits: context.commits,
    testSummary: options.testSummary,
    truncated: context.truncated,
  });

  const models = [options.model ?? config.primaryModel];
  const secondSkipped = options.second && !config.secondaryModel;
  if (options.second && config.secondaryModel) models.push(config.secondaryModel);

  const promptBytes = messages.reduce((total, message) => total + Buffer.byteLength(message.content, "utf8"), 0);

  // A dry run is the cost airlock: it shows exactly what would be sent, to
  // which models, under which caps, and spends nothing.
  if (options.dryRun) {
    return {
      dryRun: true,
      range: context.range,
      models,
      secondSkipped,
      promptBytes,
      truncated: context.truncated,
      limits: {
        maxCompletionTokens: config.maxCompletionTokens,
        maxDiffBytes: config.maxDiffBytes,
        maxCostUsd: config.maxCostUsd,
      },
      exitCode: REVIEW_EXIT.clean,
    };
  }

  const reviews = [];
  const failures = [];
  for (const model of models) {
    try {
      const completion = await client.complete({
        model,
        messages,
        maxCompletionTokens: config.maxCompletionTokens,
        temperature: config.temperature,
      });
      const parsed = redactReview(parseReviewResponse(completion.content), env.OPENROUTER_API_KEY);

      reviews.push({
        ...parsed,
        model: completion.model,
        usage: completion.usage,
        range: context.range,
        truncated: context.truncated,
        costWarning: costWarningFor(completion.usage, config.maxCostUsd),
      });
    } catch (error) {
      // A later reviewer failing must not discard an earlier answer that was
      // already paid for. The failure is reported alongside what did succeed.
      failures.push({
        model,
        message: redactSecrets(error?.message ?? String(error), env.OPENROUTER_API_KEY),
      });
    }

    const spent = totalCost(reviews).total;
    if (spent !== null && Number.isFinite(config.maxCostUsd) && spent > config.maxCostUsd) {
      // Do not keep paying once the ceiling is already behind us.
      const remaining = models.slice(models.indexOf(model) + 1);
      if (remaining.length > 0) {
        failures.push({
          model: remaining.join(", "),
          message: `Skipped: $${spent.toFixed(4)} already spent, above the ceiling of $${config.maxCostUsd}.`,
        });
      }
      break;
    }
  }

  if (reviews.length === 0) {
    throw new Error(failures[0]?.message ?? "No review was produced.");
  }

  const verdict = reviews.some((review) => review.verdict === "BLOCKERS")
    ? "BLOCKERS"
    : reviews.some((review) => review.verdict === "PASS_WITH_NOTES")
      ? "PASS_WITH_NOTES"
      : "PASS";

  const cost = totalCost(reviews);

  return {
    dryRun: false,
    verdict,
    range: context.range,
    reviews,
    failures,
    secondSkipped,
    totalCostUsd: cost.total,
    totalCostPartial: cost.partial,
    totalCostWarning:
      cost.total !== null && Number.isFinite(config.maxCostUsd) && cost.total > config.maxCostUsd
        ? `Reviews cost $${cost.total.toFixed(4)} in total, above the configured ceiling of $${config.maxCostUsd}.`
        : null,
    // A failed reviewer may have been the one saying "do not merge", so a run
    // with a lost answer is never reported as clean.
    exitCode: verdict === "BLOCKERS"
      ? REVIEW_EXIT.blockers
      : failures.length > 0
        ? REVIEW_EXIT.error
        : REVIEW_EXIT.clean,
  };
}

export function formatReviewResult(result) {
  if (result.dryRun) {
    return [
      `Independent review dry run for ${result.range}. Nothing was sent and nothing was spent.`,
      `- Models that would be asked: ${result.models.join(", ")}`,
      `- Prompt size: ${result.promptBytes} bytes`,
      result.truncated ? "- Diff would be truncated to the configured size limit." : null,
      result.secondSkipped ? "- A second opinion was requested but config.secondaryModel is not set." : null,
      `- Caps: ${result.limits.maxCompletionTokens} completion tokens, ${result.limits.maxDiffBytes} diff bytes, $${result.limits.maxCostUsd} advisory cost ceiling`,
    ].filter(Boolean).join("\n");
  }

  const sections = result.reviews.map((review) => {
    const summary = formatReviewSummary(review);
    return review.costWarning ? `${summary}\n- ${review.costWarning}` : summary;
  });

  if (result.reviews.length > 1) {
    sections.push(`Combined verdict across ${result.reviews.length} reviewers: ${result.verdict}`);
  }
  if (result.secondSkipped) {
    sections.push("A second opinion was requested but config.secondaryModel is not set.");
  }
  for (const failure of result.failures ?? []) {
    sections.push(`Reviewer ${plain(failure.model)} failed: ${plain(failure.message)}`);
  }
  if (result.totalCostUsd !== null) {
    const partial = result.totalCostPartial ? " (partial: some reviews reported no cost)" : "";
    sections.push(`Total reported cost: $${result.totalCostUsd.toFixed(4)}${partial}`);
  }
  if (result.totalCostWarning) sections.push(result.totalCostWarning);

  return sections.join("\n\n");
}

/** A reviewer can only echo a key that was already in the diff, but not through here. */
function redactReview(parsed, apiKey) {
  if (!apiKey) return parsed;
  const scrub = (value) => redactSecrets(String(value ?? ""), apiKey);

  return {
    ...parsed,
    summary: scrub(parsed.summary),
    notes: parsed.notes.map(scrub),
    findings: parsed.findings.map((finding) => ({
      ...finding,
      title: scrub(finding.title),
      file: finding.file === null ? null : scrub(finding.file),
      evidence: scrub(finding.evidence),
      recommendation: scrub(finding.recommendation),
    })),
  };
}

function costWarningFor(usage, maxCostUsd) {
  if (!usage || usage.costUsd === null || !Number.isFinite(maxCostUsd)) return null;
  if (usage.costUsd <= maxCostUsd) return null;
  return `This review cost $${usage.costUsd.toFixed(4)}, above the configured ceiling of $${maxCostUsd}.`;
}

function totalCost(reviews) {
  const costs = reviews.map((review) => review.usage?.costUsd).filter((cost) => Number.isFinite(cost));
  return {
    total: costs.length > 0 ? costs.reduce((sum, cost) => sum + cost, 0) : null,
    partial: costs.length !== reviews.length,
  };
}

if (process.argv[1] && currentFile === resolve(process.argv[1])) {
  try {
    const options = parseReviewArgs(process.argv.slice(2));
    const result = await runReviewCli(process.argv.slice(2));
    console.log(options.json ? JSON.stringify(result, null, 2) : formatReviewResult(result));
    process.exit(result.exitCode);
  } catch (error) {
    console.error(error.message === MISSING_KEY_MESSAGE ? error.message : `Independent review failed: ${error.message}`);
    process.exit(REVIEW_EXIT.error);
  }
}
