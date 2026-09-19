/**
 * Narrow OpenRouter client for the independent review harness.
 *
 * It does one thing: send a chat completion and return the text plus usage.
 * The API key is never echoed, and every failure mode is reported explicitly so
 * a missing key or an exhausted balance can never be mistaken for a passing
 * review.
 */
export const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

export const MISSING_KEY_MESSAGE = [
  "OPENROUTER_API_KEY is not set, so no independent review can run.",
  "Add it to .env (see .env.example) or export it for this shell:",
  "  export OPENROUTER_API_KEY=sk-or-...",
  "Create a key at https://openrouter.ai/keys. See docs/setup/review.md.",
  "This command will not fall back to reviewing its own work.",
].join("\n");

export function openRouterKeyStatus(env = process.env) {
  return { configured: Boolean(env.OPENROUTER_API_KEY?.trim()) };
}

export function createOpenRouterClient({
  apiKey,
  fetchImpl = globalThis.fetch,
  endpoint = OPENROUTER_ENDPOINT,
  appTitle,
} = {}) {
  if (!apiKey?.trim()) throw new Error(MISSING_KEY_MESSAGE);
  if (typeof fetchImpl !== "function") {
    throw new Error("A fetch implementation is required for OpenRouter access.");
  }

  return {
    async complete({ model, messages, maxCompletionTokens, temperature = 0 }) {
      if (!model?.trim()) throw new Error("An OpenRouter model id is required.");

      const headers = {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      };
      if (appTitle) headers["X-Title"] = appTitle;

      const body = { model, messages, temperature };
      if (maxCompletionTokens) body.max_completion_tokens = maxCompletionTokens;

      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const details = await response.text().catch(() => "");
        throw new Error(describeFailure(response.status, details, apiKey));
      }

      const payload = await response.json();
      if (payload?.error) {
        // A 200 response can still carry an error body that echoes the request,
        // so this is redacted exactly like a transport failure.
        const message = redactSecrets(payload.error.message ?? "unknown error", apiKey);
        throw new Error(`OpenRouter returned an error: ${message}`);
      }

      const content = payload?.choices?.[0]?.message?.content;
      if (typeof content !== "string" || content.trim() === "") {
        throw new Error("OpenRouter returned no review content.");
      }

      return {
        content,
        model: payload.model ?? model,
        usage: normalizeUsage(payload.usage),
      };
    },
  };
}

export function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return null;

  const cost = Number(usage.cost);
  return {
    promptTokens: numberOrNull(usage.prompt_tokens),
    completionTokens: numberOrNull(usage.completion_tokens),
    totalTokens: numberOrNull(usage.total_tokens),
    costUsd: Number.isFinite(cost) ? cost : null,
  };
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Upstream error bodies can echo the request, so nothing is quoted unredacted. */
export function redactSecrets(text, apiKey) {
  const redacted = apiKey ? String(text).split(apiKey).join("[redacted]") : String(text);
  return redacted.replace(/sk-or-[A-Za-z0-9._-]+/g, "[redacted]");
}

function describeFailure(status, details, apiKey) {
  const trimmed = redactSecrets(String(details ?? ""), apiKey).slice(0, 400);

  if (status === 401) {
    return "OpenRouter rejected the API key (401). Check OPENROUTER_API_KEY.";
  }
  if (status === 402) {
    return "OpenRouter reports insufficient credit (402). Top up or lower the configured model cost.";
  }
  if (status === 429) {
    return "OpenRouter rate-limited the review request (429). Retry later.";
  }

  return `OpenRouter request failed: ${status}${trimmed ? ` ${trimmed}` : ""}`;
}
