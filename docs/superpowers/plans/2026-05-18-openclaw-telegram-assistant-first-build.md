# OpenClaw Telegram Assistant First Build Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a usable repository skeleton for a local OpenClaw multi-agent assistant accessed through one Telegram bot, with Google-ready configuration, adaptive health and meal-planning prompts, approval policy, and setup scripts.

**Architecture:** The repository will not reimplement OpenClaw. It will provide agent workspaces, standing orders, configuration data, validation scripts, setup docs, and small Node scripts that render a local OpenClaw config from `.env` and JSON files. The first build stops at a safe, testable setup path; real Telegram, Google, and model credentials are supplied by the user outside git.

**Tech Stack:** Node.js 24+, built-in `node:test`, ES modules, JSON configuration files, shell commands that call the OpenClaw CLI after installation.

---

## Scope Check

This plan implements the first-build skeleton described in the approved design spec. It intentionally does not automate purchases, modify Gmail or Calendar, integrate wearable data, or deploy to cloud infrastructure. Google setup is documented and environment-validated, while real OAuth and Pub/Sub credentials remain local.

## File Structure

- `.gitignore`: keeps credentials, logs, generated OpenClaw config, and local state out of git.
- `.env.example`: documents required environment variables with safe example values.
- `package.json`: Node test and helper script entry points.
- `README.md`: operator guide for installing OpenClaw, configuring Telegram/Google/models, rendering config, and running checks.
- `agents/personal/AGENTS.md`: main assistant and routing standing orders.
- `agents/personal/SOUL.md`: voice and continuity notes for the user-facing assistant.
- `agents/admin/AGENTS.md`: Gmail, Calendar, reminders, and admin approval rules.
- `agents/health/AGENTS.md`: health, workout, daily meal planning, and grocery standing orders.
- `agents/research/AGENTS.md`: research behavior and citation expectations.
- `config/agents.json`: agent IDs, names, workspaces, prompt directories, and model env keys.
- `config/approval-policy.json`: side-effect policy and trust ladder.
- `config/schedules.json`: default Europe/Stockholm routine schedule.
- `config/food-planning.json`: meal planning and grocery defaults.
- `docs/setup/telegram.md`: Telegram BotFather and allowlist setup checklist.
- `docs/setup/google.md`: Gmail Pub/Sub and Google Calendar setup checklist.
- `docs/security/approval-model.md`: confirm-before-action and future trust ladder.
- `docs/runbooks/daily-operation.md`: operator commands and maintenance habits.
- `scripts/lib/env.mjs`: dependency-free `.env` parsing and required-key checks.
- `scripts/lib/config.mjs`: JSON loading and path helpers.
- `scripts/render-openclaw-config.mjs`: generates `.openclaw/openclaw.json`.
- `scripts/validate-env.mjs`: validates local environment readiness.
- `scripts/doctor.mjs`: local diagnostic summary for Node, npm, OpenClaw, `.env`, and generated config.
- `scripts/start-openclaw.mjs`: launches `openclaw gateway` using the rendered config.
- `tests/*.test.mjs`: focused built-in Node tests for env parsing, policy, prompts, schedules, food planning, config rendering, and command helpers.

---

### Task 1: Repository Baseline

**Files:**
- Modify: `.gitignore`
- Create: `package.json`
- Create: `.env.example`

- [ ] **Step 1: Create baseline project metadata**

Use `apply_patch` to add:

```json
{
  "name": "assistant",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Local OpenClaw multi-agent assistant accessed through Telegram.",
  "scripts": {
    "test": "node --test tests/*.test.mjs",
    "validate:env": "node scripts/validate-env.mjs",
    "render:config": "node scripts/render-openclaw-config.mjs",
    "doctor": "node scripts/doctor.mjs",
    "start:openclaw": "node scripts/start-openclaw.mjs"
  },
  "engines": {
    "node": ">=24.0.0"
  }
}
```

- [ ] **Step 2: Create ignore rules**

Use `apply_patch` to create `.gitignore`:

```gitignore
.DS_Store
.worktrees/
node_modules/
npm-debug.log*
.env
.env.*
!.env.example
.openclaw/
data/
logs/
*.log
coverage/
```

- [ ] **Step 3: Create the environment example**

Use `apply_patch` to create `.env.example`:

```dotenv
ASSISTANT_TIMEZONE=Europe/Stockholm
OPENCLAW_CONFIG_PATH=.openclaw/openclaw.json
OPENCLAW_STATE_DIR=.openclaw/state
TELEGRAM_BOT_TOKEN=123456789:example-token-from-botfather
TELEGRAM_USER_ID=123456789
GMAIL_ACCOUNT=you@example.com
GOOGLE_CLOUD_PROJECT=assistant-project
GOOGLE_PUBSUB_TOPIC=openclaw-gmail
GOOGLE_PUBSUB_SUBSCRIPTION=openclaw-gmail-subscription
PRIMARY_MODEL=provider/best-general-model
ADMIN_MODEL=provider/reliable-admin-model
HEALTH_MODEL=provider/supportive-health-model
RESEARCH_MODEL=provider/research-model
ROUTINE_MODEL=provider/fast-routine-model
```

- [ ] **Step 4: Run the baseline test command**

Run: `/opt/homebrew/bin/npm test`

Expected: failure because the `tests/` directory does not exist yet. This confirms the test entry point is wired and ready for the next task.

- [ ] **Step 5: Commit**

```bash
git add .gitignore package.json .env.example
git commit -m "chore: add project baseline"
```

---

### Task 2: Environment Parsing And Validation

**Files:**
- Create: `tests/env.test.mjs`
- Create: `scripts/lib/env.mjs`
- Create: `scripts/validate-env.mjs`

- [ ] **Step 1: Write the failing env parser tests**

Use `apply_patch` to create `tests/env.test.mjs`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseEnvText, requiredEnvReport } from "../scripts/lib/env.mjs";

describe("parseEnvText", () => {
  it("parses key values, ignores comments, and strips surrounding quotes", () => {
    const env = parseEnvText(`
      # comment
      ASSISTANT_TIMEZONE=Europe/Stockholm
      TELEGRAM_USER_ID="123456789"
      EMPTY=
    `);

    assert.equal(env.ASSISTANT_TIMEZONE, "Europe/Stockholm");
    assert.equal(env.TELEGRAM_USER_ID, "123456789");
    assert.equal(env.EMPTY, "");
  });
});

describe("requiredEnvReport", () => {
  it("separates present and missing keys", () => {
    const report = requiredEnvReport(
      { TELEGRAM_USER_ID: "123456789", GMAIL_ACCOUNT: "" },
      ["TELEGRAM_USER_ID", "GMAIL_ACCOUNT", "PRIMARY_MODEL"],
    );

    assert.deepEqual(report.present, ["TELEGRAM_USER_ID"]);
    assert.deepEqual(report.missing, ["GMAIL_ACCOUNT", "PRIMARY_MODEL"]);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `node --test tests/env.test.mjs`

Expected: FAIL with a module-not-found error for `scripts/lib/env.mjs`.

- [ ] **Step 3: Implement env helpers**

Use `apply_patch` to create `scripts/lib/env.mjs`:

```js
import { readFileSync, existsSync } from "node:fs";

export const REQUIRED_ENV_KEYS = [
  "ASSISTANT_TIMEZONE",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_STATE_DIR",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_USER_ID",
  "GMAIL_ACCOUNT",
  "GOOGLE_CLOUD_PROJECT",
  "PRIMARY_MODEL",
  "ADMIN_MODEL",
  "HEALTH_MODEL",
  "RESEARCH_MODEL",
  "ROUTINE_MODEL",
];

export function parseEnvText(text) {
  const env = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) continue;

    const key = line.slice(0, equalsIndex).trim();
    const rawValue = line.slice(equalsIndex + 1).trim();
    const value = rawValue.replace(/^["']|["']$/g, "");

    if (key) env[key] = value;
  }

  return env;
}

export function readEnvFile(path = ".env") {
  if (!existsSync(path)) return {};
  return parseEnvText(readFileSync(path, "utf8"));
}

export function mergedEnv(path = ".env") {
  return { ...readEnvFile(path), ...process.env };
}

export function requiredEnvReport(env, requiredKeys = REQUIRED_ENV_KEYS) {
  const present = [];
  const missing = [];

  for (const key of requiredKeys) {
    const value = env[key];
    if (typeof value === "string" && value.trim().length > 0) {
      present.push(key);
    } else {
      missing.push(key);
    }
  }

  return { present, missing };
}
```

- [ ] **Step 4: Add CLI validation**

Use `apply_patch` to create `scripts/validate-env.mjs`:

```js
#!/usr/bin/env node
import { mergedEnv, requiredEnvReport, REQUIRED_ENV_KEYS } from "./lib/env.mjs";

const envPath = process.argv.includes("--example") ? ".env.example" : ".env";
const env = mergedEnv(envPath);
const report = requiredEnvReport(env, REQUIRED_ENV_KEYS);

if (report.missing.length > 0) {
  console.error(`Missing required environment keys in ${envPath}:`);
  for (const key of report.missing) console.error(`- ${key}`);
  process.exit(1);
}

console.log(`Environment check passed for ${envPath}.`);
```

- [ ] **Step 5: Run tests and env example validation**

Run: `node --test tests/env.test.mjs`

Expected: PASS.

Run: `node scripts/validate-env.mjs --example`

Expected: `Environment check passed for .env.example.`

- [ ] **Step 6: Commit**

```bash
git add tests/env.test.mjs scripts/lib/env.mjs scripts/validate-env.mjs
git commit -m "test: add environment validation"
```

---

### Task 3: Approval Policy

**Files:**
- Create: `tests/approval-policy.test.mjs`
- Create: `config/approval-policy.json`
- Create: `docs/security/approval-model.md`

- [ ] **Step 1: Write the failing approval policy tests**

Use `apply_patch` to create `tests/approval-policy.test.mjs`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const policy = JSON.parse(readFileSync("config/approval-policy.json", "utf8"));

describe("approval policy", () => {
  it("keeps every side-effect domain behind Telegram approval", () => {
    const approvalDomains = policy.approvalRequired.map((entry) => entry.domain);

    assert.deepEqual(approvalDomains, [
      "email",
      "calendar",
      "shell",
      "browser",
      "files",
      "sensitive-local-data",
      "purchases-and-finance",
    ]);
  });

  it("starts in confirm-before-action mode", () => {
    assert.equal(policy.initialTrustMode, "confirm-before-action");
    assert.equal(policy.approvalChannel, "telegram");
  });

  it("defines a narrow promotion process for future trusted routines", () => {
    assert.equal(policy.trustLadder[0].mode, "confirm-before-action");
    assert.equal(policy.trustLadder[1].mode, "trusted-routine");
    assert.equal(policy.trustLadder[2].mode, "permanent-approval-required");
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `node --test tests/approval-policy.test.mjs`

Expected: FAIL with `ENOENT` for `config/approval-policy.json`.

- [ ] **Step 3: Create approval policy config**

Use `apply_patch` to create `config/approval-policy.json`:

```json
{
  "initialTrustMode": "confirm-before-action",
  "approvalChannel": "telegram",
  "allowedWithoutExtraApproval": [
    "read-telegram-messages-sent-to-assistant",
    "summarize-configured-gmail-and-calendar",
    "draft-email-calendar-plan-grocery-and-health-recommendations",
    "ask-clarifying-questions",
    "send-check-ins",
    "run-read-only-project-diagnostics"
  ],
  "approvalRequired": [
    {
      "domain": "email",
      "actions": ["send", "delete", "archive", "label", "mark-read", "move"]
    },
    {
      "domain": "calendar",
      "actions": ["create-event", "edit-event", "delete-event", "respond-to-invite"]
    },
    {
      "domain": "shell",
      "actions": ["write-files", "change-settings", "launch-apps", "install-software", "run-state-changing-commands"]
    },
    {
      "domain": "browser",
      "actions": ["submit-forms", "purchase", "book", "post", "message", "change-account-state"]
    },
    {
      "domain": "files",
      "actions": ["edit-outside-requested-implementation", "delete", "move-sensitive-files"]
    },
    {
      "domain": "sensitive-local-data",
      "actions": ["read-private-directories", "extract-secrets", "inspect-unrelated-personal-data"]
    },
    {
      "domain": "purchases-and-finance",
      "actions": ["pay", "trade", "transfer", "subscribe", "order-delivery"]
    }
  ],
  "approvalPromptRequiredFields": [
    "agent",
    "action",
    "target",
    "expectedEffect",
    "risk",
    "approvalOptions"
  ],
  "auditLogFields": [
    "timestamp",
    "agent",
    "action",
    "target",
    "decision",
    "result"
  ],
  "trustLadder": [
    {
      "mode": "confirm-before-action",
      "description": "All side effects require explicit approval."
    },
    {
      "mode": "trusted-routine",
      "description": "A named low-risk routine can run automatically after repeated successful approvals."
    },
    {
      "mode": "permanent-approval-required",
      "description": "High-risk actions stay approval-gated even when routine actions become trusted."
    }
  ]
}
```

- [ ] **Step 4: Document the approval model**

Use `apply_patch` to create `docs/security/approval-model.md`:

```markdown
# Approval Model

The assistant starts in confirm-before-action mode. It may read configured channels, summarize, draft, plan, and recommend, but it must ask in Telegram before changing external state.

Every approval prompt must say which agent is acting, what action is proposed, which target will change, what effect is expected, and what risk exists. The user can approve or deny. Denied actions are not retried unless the user asks again.

Trusted routines can be added later only as narrow named exceptions, such as drafting a weekly grocery list or suggesting a gym block. Email sends, calendar changes, purchases, financial actions, browser submissions, destructive shell commands, and sensitive local data access remain approval-gated unless the policy is explicitly changed.
```

- [ ] **Step 5: Run tests**

Run: `node --test tests/approval-policy.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add config/approval-policy.json docs/security/approval-model.md tests/approval-policy.test.mjs
git commit -m "feat: define approval policy"
```

---

### Task 4: Agent Workspaces And Standing Orders

**Files:**
- Create: `tests/agent-boundaries.test.mjs`
- Create: `config/agents.json`
- Create: `agents/personal/AGENTS.md`
- Create: `agents/personal/SOUL.md`
- Create: `agents/admin/AGENTS.md`
- Create: `agents/health/AGENTS.md`
- Create: `agents/research/AGENTS.md`

- [ ] **Step 1: Write the failing agent boundary tests**

Use `apply_patch` to create `tests/agent-boundaries.test.mjs`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

const agents = JSON.parse(readFileSync("config/agents.json", "utf8"));
const requiredAgentIds = ["personal", "admin", "health", "research"];

describe("agent configuration", () => {
  it("defines the four specialist agents", () => {
    assert.deepEqual(agents.map((agent) => agent.id), requiredAgentIds);
  });

  it("gives each agent a workspace and agent directory", () => {
    for (const agent of agents) {
      assert.match(agent.workspace, new RegExp(`workspace-${agent.id}$`));
      assert.match(agent.agentDir, new RegExp(`agents/${agent.id}/agent$`));
      assert.equal(existsSync(`${agent.promptDir}/AGENTS.md`), true);
    }
  });

  it("keeps side effects approval-gated in every agent prompt", () => {
    for (const agent of agents) {
      const prompt = readFileSync(`${agent.promptDir}/AGENTS.md`, "utf8");
      assert.match(prompt, /Confirm-before-action/);
      assert.match(prompt, /Telegram approval/);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `node --test tests/agent-boundaries.test.mjs`

Expected: FAIL with `ENOENT` for `config/agents.json`.

- [ ] **Step 3: Create agent registry**

Use `apply_patch` to create `config/agents.json`:

```json
[
  {
    "id": "personal",
    "name": "Personal",
    "default": true,
    "workspace": ".openclaw/workspace-personal",
    "agentDir": ".openclaw/agents/personal/agent",
    "promptDir": "agents/personal",
    "modelEnv": "PRIMARY_MODEL"
  },
  {
    "id": "admin",
    "name": "Admin",
    "workspace": ".openclaw/workspace-admin",
    "agentDir": ".openclaw/agents/admin/agent",
    "promptDir": "agents/admin",
    "modelEnv": "ADMIN_MODEL"
  },
  {
    "id": "health",
    "name": "Health",
    "workspace": ".openclaw/workspace-health",
    "agentDir": ".openclaw/agents/health/agent",
    "promptDir": "agents/health",
    "modelEnv": "HEALTH_MODEL"
  },
  {
    "id": "research",
    "name": "Research",
    "workspace": ".openclaw/workspace-research",
    "agentDir": ".openclaw/agents/research/agent",
    "promptDir": "agents/research",
    "modelEnv": "RESEARCH_MODEL"
  }
]
```

- [ ] **Step 4: Create personal agent standing orders**

Use `apply_patch` to create `agents/personal/AGENTS.md`:

```markdown
# Personal Agent Standing Orders

You are the user's main Telegram assistant. You are the only agent the user should feel they are talking to during normal use.

Route work quietly:
- Use the admin agent for Gmail, Calendar, reminders, logistics, meeting prep, and personal administration.
- Use the health agent for workouts, food planning, grocery lists, cravings, sleep, and daily routine support.
- Use the research agent for source-backed lookup, comparisons, planning support, and current factual questions.

Confirm-before-action:
- Drafts, summaries, plans, reminders, and recommendations are allowed.
- Side effects require Telegram approval before execution.
- Before a side effect, state the agent, action, target, expected effect, and risk.
- Never send email, change Calendar, submit browser forms, make purchases, edit unrelated files, or run state-changing shell commands without explicit approval.

Tone:
- Be concise enough for Telegram.
- Be warm, direct, and practical.
- Keep health support non-shaming.
- Ask one clarifying question when the stakes are high or the target is unclear.
```

Use `apply_patch` to create `agents/personal/SOUL.md`:

```markdown
# Personal Agent Voice

The assistant should feel like a capable personal operating layer: calm, observant, practical, and supportive. It should reduce friction in the user's day without becoming noisy.

Default to useful next actions. Keep the main response coherent even when specialists were consulted behind the scenes.
```

- [ ] **Step 5: Create admin agent standing orders**

Use `apply_patch` to create `agents/admin/AGENTS.md`:

```markdown
# Admin Agent Standing Orders

You support Gmail, Google Calendar, reminders, daily logistics, meeting preparation, and follow-up planning.

Default behavior:
- Summarize important email and calendar context.
- Draft replies, calendar changes, reminders, and agenda notes.
- Flag conflicts, missing travel buffers, and unresolved commitments.
- Prepare concise handoffs for the personal agent.

Confirm-before-action:
- Reading configured Gmail and Calendar content is allowed.
- Drafting proposed changes is allowed.
- Sending, deleting, archiving, labeling, or moving email requires Telegram approval.
- Creating, editing, deleting, or responding to Calendar events requires Telegram approval.
- Browser submissions, purchases, and shell actions require Telegram approval.

Approval prompts must include the action, target, expected effect, and risk.
```

- [ ] **Step 6: Create health agent standing orders**

Use `apply_patch` to create `agents/health/AGENTS.md`:

```markdown
# Health Agent Standing Orders

You support workouts, food choices, daily meal planning, grocery planning, sleep consistency, movement, and routine design. You are a supportive coach, not a medical system.

Daily behavior:
- Create a practical eating plan for the day.
- Suggest simple meals based on schedule pressure, workout timing, preferences, and available time.
- Include easy backup options for busy days.
- Encourage workouts and movement without shame.
- Help the user pause and choose a better next action when they want unhealthy food.

Grocery behavior:
- Build grocery lists grouped by protein, vegetables, fruit, carbs, dairy or alternatives, snacks, breakfast, pantry, and backup meals.
- Keep healthy convenience foods available.
- Ask about allergies, budget, disliked foods, and equipment when needed.

Confirm-before-action:
- Food plans, workout suggestions, grocery lists, and supportive check-ins are allowed.
- Purchases, delivery orders, browser submissions, calendar edits, local file changes, and state-changing shell commands require Telegram approval.

Health boundaries:
- Do not diagnose medical conditions.
- Do not give extreme dieting advice.
- Ask the user to consult a qualified professional for injury, medication, eating disorder, or medical-condition concerns.
```

- [ ] **Step 7: Create research agent standing orders**

Use `apply_patch` to create `agents/research/AGENTS.md`:

```markdown
# Research Agent Standing Orders

You support source-backed research, comparisons, planning, nutrition lookup, local errands, and current factual questions.

Default behavior:
- Prefer primary or official sources when available.
- Cite sources for factual, current, medical, legal, financial, travel, or purchase-related claims.
- Separate facts from recommendations.
- Return concise findings to the personal agent.

Confirm-before-action:
- Reading public sources and summarizing findings is allowed.
- Purchases, bookings, account changes, form submissions, local file edits, and state-changing shell commands require Telegram approval.
```

- [ ] **Step 8: Run tests**

Run: `node --test tests/agent-boundaries.test.mjs`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add agents config/agents.json tests/agent-boundaries.test.mjs
git commit -m "feat: add assistant agents"
```

---

### Task 5: Schedules, Meal Planning, And Grocery Defaults

**Files:**
- Create: `tests/routines.test.mjs`
- Create: `config/schedules.json`
- Create: `config/food-planning.json`

- [ ] **Step 1: Write failing routine tests**

Use `apply_patch` to create `tests/routines.test.mjs`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const schedules = JSON.parse(readFileSync("config/schedules.json", "utf8"));
const food = JSON.parse(readFileSync("config/food-planning.json", "utf8"));

describe("routine schedules", () => {
  it("uses Europe/Stockholm and defines daily assistant routines", () => {
    assert.equal(schedules.timezone, "Europe/Stockholm");
    assert.deepEqual(
      schedules.daily.map((routine) => routine.id),
      ["morning-brief", "midday-check-in", "workout-window", "evening-review"],
    );
  });

  it("defines the Sunday weekly review", () => {
    assert.equal(schedules.weekly.id, "weekly-review");
    assert.equal(schedules.weekly.day, "Sunday");
  });
});

describe("food planning defaults", () => {
  it("keeps daily meal planning and grocery planning enabled", () => {
    assert.equal(food.dailyMealPlan.enabled, true);
    assert.equal(food.groceryPlanning.enabled, true);
  });

  it("groups groceries by useful store sections", () => {
    assert.deepEqual(food.groceryPlanning.sections, [
      "protein",
      "vegetables",
      "fruit",
      "carbs",
      "dairy-or-alternatives",
      "snacks",
      "breakfast",
      "pantry",
      "backup-meals",
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `node --test tests/routines.test.mjs`

Expected: FAIL with `ENOENT` for `config/schedules.json`.

- [ ] **Step 3: Create routine schedules**

Use `apply_patch` to create `config/schedules.json`:

```json
{
  "timezone": "Europe/Stockholm",
  "daily": [
    {
      "id": "morning-brief",
      "agent": "personal",
      "time": "08:00",
      "purpose": "Calendar summary, important Gmail, top priorities, meal plan, and workout anchor."
    },
    {
      "id": "midday-check-in",
      "agent": "health",
      "time": "12:30",
      "purpose": "Food, movement, energy, and schedule pressure check."
    },
    {
      "id": "workout-window",
      "agent": "health",
      "window": {
        "start": "16:00",
        "end": "19:00"
      },
      "purpose": "Find a realistic workout or movement moment from calendar availability."
    },
    {
      "id": "evening-review",
      "agent": "personal",
      "time": "21:00",
      "purpose": "Tomorrow's calendar, open admin actions, meal prep needs, and health reflection."
    }
  ],
  "weekly": {
    "id": "weekly-review",
    "agent": "personal",
    "day": "Sunday",
    "time": "19:00",
    "purpose": "Review calendar, email, health friction, food planning, groceries, and one adjustment for the next week."
  }
}
```

- [ ] **Step 4: Create food planning defaults**

Use `apply_patch` to create `config/food-planning.json`:

```json
{
  "dailyMealPlan": {
    "enabled": true,
    "defaultMeals": ["breakfast", "lunch", "dinner", "snack"],
    "style": "simple-repeatable-high-protein",
    "includeBackupOptions": true,
    "consider": [
      "calendar-load",
      "workout-timing",
      "available-cooking-time",
      "known-preferences",
      "energy-level"
    ]
  },
  "groceryPlanning": {
    "enabled": true,
    "cadence": "weekly-with-ad-hoc-updates",
    "sections": [
      "protein",
      "vegetables",
      "fruit",
      "carbs",
      "dairy-or-alternatives",
      "snacks",
      "breakfast",
      "pantry",
      "backup-meals"
    ],
    "principles": [
      "healthy-convenience",
      "simple-prep",
      "realistic-portions",
      "easy-default-meals"
    ]
  }
}
```

- [ ] **Step 5: Run routine tests**

Run: `node --test tests/routines.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add config/schedules.json config/food-planning.json tests/routines.test.mjs
git commit -m "feat: define assistant routines"
```

---

### Task 6: OpenClaw Config Rendering

**Files:**
- Create: `tests/render-openclaw-config.test.mjs`
- Create: `scripts/lib/config.mjs`
- Create: `scripts/render-openclaw-config.mjs`

- [ ] **Step 1: Write failing config rendering tests**

Use `apply_patch` to create `tests/render-openclaw-config.test.mjs`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { buildOpenClawConfig } from "../scripts/render-openclaw-config.mjs";

const env = {
  TELEGRAM_BOT_TOKEN: "123:token",
  TELEGRAM_USER_ID: "987654321",
  PRIMARY_MODEL: "provider/best-general-model",
  ADMIN_MODEL: "provider/reliable-admin-model",
  HEALTH_MODEL: "provider/supportive-health-model",
  RESEARCH_MODEL: "provider/research-model",
  ROUTINE_MODEL: "provider/fast-routine-model",
  OPENCLAW_STATE_DIR: ".openclaw/state",
};

const projectRoot = resolve(".");

describe("buildOpenClawConfig", () => {
  it("renders four agents with per-agent models", () => {
    const config = buildOpenClawConfig(env, projectRoot);

    assert.deepEqual(
      config.agents.list.map((agent) => [agent.id, agent.model]),
      [
        ["personal", "provider/best-general-model"],
        ["admin", "provider/reliable-admin-model"],
        ["health", "provider/supportive-health-model"],
        ["research", "provider/research-model"],
      ],
    );
  });

  it("routes Telegram main account to the personal agent", () => {
    const config = buildOpenClawConfig(env, projectRoot);

    assert.deepEqual(config.bindings, [
      { agentId: "personal", match: { channel: "telegram", accountId: "main" } },
    ]);
    assert.deepEqual(config.channels.telegram.allowFrom, ["987654321"]);
    assert.equal(config.channels.telegram.accounts.main.botToken, "123:token");
  });

  it("keeps Telegram approvals pointed at the same allowlisted user", () => {
    const config = buildOpenClawConfig(env, projectRoot);

    assert.equal(config.channels.telegram.accounts.main.execApprovals.enabled, true);
    assert.deepEqual(config.channels.telegram.accounts.main.execApprovals.approvers, ["987654321"]);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `node --test tests/render-openclaw-config.test.mjs`

Expected: FAIL with a module-not-found error for `scripts/render-openclaw-config.mjs`.

- [ ] **Step 3: Add config helpers**

Use `apply_patch` to create `scripts/lib/config.mjs`:

```js
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function projectPath(projectRoot, relativePath) {
  return resolve(projectRoot, relativePath);
}
```

- [ ] **Step 4: Implement config renderer**

Use `apply_patch` to create `scripts/render-openclaw-config.mjs`:

```js
#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mergedEnv, requiredEnvReport, REQUIRED_ENV_KEYS } from "./lib/env.mjs";
import { readJson, projectPath } from "./lib/config.mjs";

const currentFile = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(currentFile), "..");

export function buildOpenClawConfig(env, root = projectRoot) {
  const agents = readJson(projectPath(root, "config/agents.json"));
  const telegramUserId = env.TELEGRAM_USER_ID;

  return {
    stateDir: projectPath(root, env.OPENCLAW_STATE_DIR || ".openclaw/state"),
    models: {
      default: env.PRIMARY_MODEL,
      routine: env.ROUTINE_MODEL,
    },
    agents: {
      defaults: {
        sandbox: {
          mode: "off",
        },
      },
      list: agents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        default: Boolean(agent.default),
        workspace: projectPath(root, agent.workspace),
        agentDir: projectPath(root, agent.agentDir),
        model: env[agent.modelEnv],
      })),
    },
    bindings: [
      {
        agentId: "personal",
        match: {
          channel: "telegram",
          accountId: "main",
        },
      },
    ],
    channels: {
      telegram: {
        defaultAccount: "main",
        dmPolicy: "allowlist",
        allowFrom: [telegramUserId],
        capabilities: {
          inlineButtons: "allowlist",
        },
        accounts: {
          main: {
            botToken: env.TELEGRAM_BOT_TOKEN,
            dmPolicy: "allowlist",
            allowFrom: [telegramUserId],
            capabilities: {
              inlineButtons: "allowlist",
            },
            execApprovals: {
              enabled: true,
              approvers: [telegramUserId],
            },
          },
        },
      },
    },
  };
}

export function writeOpenClawConfig(env = mergedEnv(".env"), root = projectRoot) {
  const report = requiredEnvReport(env, REQUIRED_ENV_KEYS);
  if (report.missing.length > 0) {
    throw new Error(`Missing environment keys: ${report.missing.join(", ")}`);
  }

  const outputPath = projectPath(root, env.OPENCLAW_CONFIG_PATH || ".openclaw/openclaw.json");
  const config = buildOpenClawConfig(env, root);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`);
  return outputPath;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const outputPath = writeOpenClawConfig();
    console.log(`Rendered OpenClaw config: ${outputPath}`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
```

- [ ] **Step 5: Run rendering tests**

Run: `node --test tests/render-openclaw-config.test.mjs`

Expected: PASS.

- [ ] **Step 6: Render example-based config without secrets**

Run: `node scripts/render-openclaw-config.mjs`

Expected: failure if `.env` is absent, with a message listing missing environment keys. This is correct for a real local run.

Run after copying `.env.example` to `.env` locally: `node scripts/render-openclaw-config.mjs`

Expected: `Rendered OpenClaw config: /Users/vernerisirva/Documents/AI assistant/.openclaw/openclaw.json`

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/config.mjs scripts/render-openclaw-config.mjs tests/render-openclaw-config.test.mjs
git commit -m "feat: render OpenClaw config"
```

---

### Task 7: Local Doctor And OpenClaw Launcher

**Files:**
- Create: `tests/commands.test.mjs`
- Create: `scripts/lib/commands.mjs`
- Create: `scripts/doctor.mjs`
- Create: `scripts/start-openclaw.mjs`

- [ ] **Step 1: Write failing command helper tests**

Use `apply_patch` to create `tests/commands.test.mjs`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildOpenClawGatewayArgs, commandExists } from "../scripts/lib/commands.mjs";

describe("buildOpenClawGatewayArgs", () => {
  it("uses the rendered config path and verbose gateway mode", () => {
    assert.deepEqual(buildOpenClawGatewayArgs(".openclaw/openclaw.json"), [
      "gateway",
      "--config",
      ".openclaw/openclaw.json",
      "--verbose",
    ]);
  });
});

describe("commandExists", () => {
  it("detects node on the local machine", () => {
    assert.equal(commandExists("node"), true);
  });

  it("returns false for a command name that should not exist", () => {
    assert.equal(commandExists("assistant-command-that-does-not-exist"), false);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `node --test tests/commands.test.mjs`

Expected: FAIL with a module-not-found error for `scripts/lib/commands.mjs`.

- [ ] **Step 3: Implement command helpers**

Use `apply_patch` to create `scripts/lib/commands.mjs`:

```js
import { spawnSync } from "node:child_process";

export function commandExists(command) {
  const result = spawnSync("zsh", ["-lc", `command -v ${command}`], {
    encoding: "utf8",
  });
  return result.status === 0;
}

export function buildOpenClawGatewayArgs(configPath) {
  return ["gateway", "--config", configPath, "--verbose"];
}
```

- [ ] **Step 4: Create doctor script**

Use `apply_patch` to create `scripts/doctor.mjs`:

```js
#!/usr/bin/env node
import { existsSync } from "node:fs";
import { commandExists } from "./lib/commands.mjs";
import { mergedEnv, requiredEnvReport, REQUIRED_ENV_KEYS } from "./lib/env.mjs";

const env = mergedEnv(".env");
const report = requiredEnvReport(env, REQUIRED_ENV_KEYS);
const configPath = env.OPENCLAW_CONFIG_PATH || ".openclaw/openclaw.json";

const checks = [
  ["node", commandExists("node")],
  ["npm", commandExists("npm") || commandExists("/opt/homebrew/bin/npm")],
  ["openclaw", commandExists("openclaw")],
  [".env", existsSync(".env")],
  [configPath, existsSync(configPath)],
  ["required-env", report.missing.length === 0],
];

for (const [name, ok] of checks) {
  console.log(`${ok ? "PASS" : "WARN"} ${name}`);
}

if (report.missing.length > 0) {
  console.log(`Missing environment keys: ${report.missing.join(", ")}`);
}

if (!commandExists("openclaw")) {
  console.log("Install OpenClaw with: npm install -g openclaw@latest");
}
```

- [ ] **Step 5: Create OpenClaw launcher**

Use `apply_patch` to create `scripts/start-openclaw.mjs`:

```js
#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mergedEnv } from "./lib/env.mjs";
import { buildOpenClawGatewayArgs } from "./lib/commands.mjs";

const env = mergedEnv(".env");
const configPath = env.OPENCLAW_CONFIG_PATH || ".openclaw/openclaw.json";

if (!existsSync(configPath)) {
  console.error(`Missing rendered OpenClaw config at ${configPath}. Run npm run render:config first.`);
  process.exit(1);
}

const child = spawn("openclaw", buildOpenClawGatewayArgs(configPath), {
  stdio: "inherit",
  env: { ...process.env, OPENCLAW_CONFIG_PATH: configPath },
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
```

- [ ] **Step 6: Run command tests and doctor**

Run: `node --test tests/commands.test.mjs`

Expected: PASS.

Run: `node scripts/doctor.mjs`

Expected: prints PASS/WARN lines. It may warn for `.env`, rendered config, or `openclaw` before local setup is complete.

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/commands.mjs scripts/doctor.mjs scripts/start-openclaw.mjs tests/commands.test.mjs
git commit -m "feat: add local OpenClaw diagnostics"
```

---

### Task 8: Setup Documentation And Operator Guide

**Files:**
- Create: `README.md`
- Create: `docs/setup/telegram.md`
- Create: `docs/setup/google.md`
- Create: `docs/runbooks/daily-operation.md`

- [ ] **Step 1: Create README**

Use `apply_patch` to create `README.md`:

```markdown
# Assistant

Local OpenClaw multi-agent assistant accessed through one Telegram bot.

## What This Builds

This repository stores the configuration, agent standing orders, safety policy, and helper scripts for a personal assistant that runs on this Mac. OpenClaw provides the gateway, Telegram channel, agents, sessions, tools, and automation runtime.

The first build creates a safe setup path. It does not store real credentials and does not grant autonomous side-effect permissions.

## Agents

- `personal`: main Telegram-facing assistant and router.
- `admin`: Gmail, Google Calendar, reminders, meeting prep, and logistics.
- `health`: workouts, meal planning, groceries, sleep, routine, and healthy-choice support.
- `research`: source-backed lookup, comparisons, and planning support.

## Setup

1. Install OpenClaw:

   ```bash
   npm install -g openclaw@latest
   openclaw onboard --install-daemon
   ```

2. Copy the environment example:

   ```bash
   cp .env.example .env
   ```

3. Fill `.env` with your Telegram bot token, Telegram numeric user ID, model names, Gmail account, and Google Cloud details.

4. Validate local configuration:

   ```bash
   npm run validate:env
   npm run render:config
   npm run doctor
   ```

5. Start OpenClaw:

   ```bash
   npm run start:openclaw
   ```

## Safety

The assistant starts in confirm-before-action mode. It may summarize, draft, plan, and recommend, but sending email, changing calendar events, making purchases, submitting browser forms, editing unrelated files, or running state-changing shell commands requires Telegram approval.

See `docs/security/approval-model.md`.
```

- [ ] **Step 2: Create Telegram setup doc**

Use `apply_patch` to create `docs/setup/telegram.md`:

```markdown
# Telegram Setup

1. Open Telegram and message `@BotFather`.
2. Create a bot and copy the bot token into `TELEGRAM_BOT_TOKEN` in `.env`.
3. Get your numeric Telegram user ID from a trusted Telegram user info bot or from OpenClaw onboarding.
4. Put the numeric ID in `TELEGRAM_USER_ID`.
5. Keep `dmPolicy` as `allowlist`.
6. Render config with `npm run render:config`.
7. Run OpenClaw diagnostics with `npm run doctor`.
8. Start the gateway with `npm run start:openclaw`.

The first version uses one Telegram bot. Specialist agents are hidden behind the personal agent.
```

- [ ] **Step 3: Create Google setup doc**

Use `apply_patch` to create `docs/setup/google.md`:

```markdown
# Google Setup

Google is used for Gmail and Google Calendar.

## Gmail

OpenClaw provides Gmail Pub/Sub helper commands:

```bash
openclaw webhooks gmail setup --account you@example.com
openclaw webhooks gmail run
```

Use the Gmail account from `GMAIL_ACCOUNT` and the Google Cloud project from `GOOGLE_CLOUD_PROJECT`.

The assistant may summarize Gmail and draft responses. Sending, archiving, deleting, labeling, or moving email requires Telegram approval.

## Google Calendar

Calendar access should be configured through an OpenClaw-compatible tool, script, or skill during implementation. The assistant may read calendar context, flag conflicts, and draft changes. Creating, editing, deleting, or responding to events requires Telegram approval.
```

- [ ] **Step 4: Create daily operation runbook**

Use `apply_patch` to create `docs/runbooks/daily-operation.md`:

```markdown
# Daily Operation Runbook

Run diagnostics:

```bash
npm run doctor
```

Render config after changing `.env` or `config/*.json`:

```bash
npm run render:config
```

Start the local OpenClaw gateway:

```bash
npm run start:openclaw
```

Expected daily routines:

- Morning brief at 08:00.
- Midday check-in at 12:30.
- Adaptive workout-window nudge between 16:00 and 19:00.
- Evening review at 21:00.
- Weekly review on Sunday at 19:00.

When the assistant proposes a side effect, approve it only if the action, target, expected effect, and risk are clear.
```

- [ ] **Step 5: Verify docs mention the major operator paths**

Run: `rg -n "OpenClaw|Telegram|Google|confirm-before-action|meal planning|grocery" README.md docs`

Expected: matches in README and docs for setup, safety, and operation.

- [ ] **Step 6: Commit**

```bash
git add README.md docs/setup docs/runbooks
git commit -m "docs: add assistant setup guide"
```

---

### Task 9: Full Verification And Handoff

**Files:**
- Modify only if verification finds a mismatch in earlier tasks.

- [ ] **Step 1: Run the full test suite**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 2: Validate example environment**

Run: `node scripts/validate-env.mjs --example`

Expected: `Environment check passed for .env.example.`

- [ ] **Step 3: Run diagnostics**

Run: `node scripts/doctor.mjs`

Expected: PASS/WARN status lines. Warnings are acceptable for missing real `.env`, generated config, and `openclaw` before setup; unexpected JavaScript errors are not acceptable.

- [ ] **Step 4: Confirm no secrets are staged**

Run: `git status --short`

Expected: only intended repository files are present. `.env`, `.openclaw/`, `logs/`, and `data/` must not be staged.

- [ ] **Step 5: Review against the design spec**

Check that the implementation includes:

- One Telegram front door.
- Four agents: `personal`, `admin`, `health`, and `research`.
- Confirm-before-action policy.
- Google Gmail and Calendar setup path.
- Daily health, meal planning, grocery, admin, and weekly review routines.
- Local OpenClaw config rendering and diagnostics.

- [ ] **Step 6: Commit final fixes if any were needed**

```bash
git add .
git commit -m "chore: verify assistant skeleton"
```

Skip this commit when no files changed after verification.

---

## Execution Notes

- Use `/opt/homebrew/bin/npm` if `npm` is not on the active shell `PATH`.
- Do not commit `.env` or generated `.openclaw` files.
- Do not install OpenClaw during automated tests.
- Ask for network escalation only when installing OpenClaw or running setup commands that need the network.
- Keep side-effect automation behind Telegram approval in prompts, config, and docs.
