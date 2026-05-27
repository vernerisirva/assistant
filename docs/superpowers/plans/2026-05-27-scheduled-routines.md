# Scheduled Routines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn existing memory-aware routines into Telegram-delivered OpenClaw cron jobs with safe feedback prompts.

**Architecture:** Keep routine content in `scripts/lib/routine.mjs` and add a separate cron-planning module that converts `config/schedules.json` into OpenClaw cron job definitions. Install jobs by upserting stable job names into the local OpenClaw cron store so existing unrelated reminders are preserved.

**Tech Stack:** Node.js ESM, OpenClaw CLI cron commands, built-in `node:test`, local `.env` and `.openclaw` config/state.

---

### Task 1: Routine Cron Planning

**Files:**
- Create: `scripts/lib/routine-cron.mjs`
- Test: `tests/routine-cron.test.mjs`

- [ ] **Step 1: Write failing tests** for daily cron expressions, weekly cron expressions, workout midpoint scheduling, Telegram delivery targets, feedback prompt text, and stable upsert names.
- [ ] **Step 2: Run test to verify RED**

Run: `node --test tests/routine-cron.test.mjs`

Expected: FAIL because `scripts/lib/routine-cron.mjs` does not exist.

- [ ] **Step 3: Implement planner** with `buildRoutineCronJobs`, `buildRoutineCronCommands`, and `maskCronCommandForDisplay`.
- [ ] **Step 4: Run test to verify GREEN**

Run: `node --test tests/routine-cron.test.mjs`

Expected: PASS.

### Task 2: Installer CLI

**Files:**
- Create: `scripts/routines-cron.mjs`
- Modify: `package.json`
- Test: `tests/routine-cron.test.mjs`

- [ ] **Step 1: Write failing tests** for `parseRoutineCronArgs`, dry-run planning, and existing-job edit planning.
- [ ] **Step 2: Run test to verify RED**

Run: `node --test tests/routine-cron.test.mjs`

Expected: FAIL because the CLI module does not exist.

- [ ] **Step 3: Implement CLI** with `plan`, `install`, and `--dry-run`. Read `.env`, `.openclaw/openclaw.json`, and `.openclaw/state/cron/jobs.json`. Never print gateway tokens. Install by writing the local cron store because this launchd gateway does not expose operator-scope cron RPCs to the CLI.
- [ ] **Step 4: Run test to verify GREEN**

Run: `node --test tests/routine-cron.test.mjs`

Expected: PASS.

### Task 3: Agent and User Documentation

**Files:**
- Modify: `agents/personal/AGENTS.md`
- Modify: `docs/setup/routines.md`
- Modify: `docs/runbooks/daily-operation.md`
- Modify: `README.md`

- [ ] **Step 1: Update docs** to explain scheduled routine installation, feedback boundaries, and approval safety.
- [ ] **Step 2: Run boundary/docs tests**

Run: `node --test tests/agent-boundaries.test.mjs tests/routine-cron.test.mjs`

Expected: PASS.

### Task 4: Verification and Live Install

**Files:**
- Generated runtime state only via OpenClaw CLI; no generated cron state is committed.

- [ ] **Step 1: Run full verification**

Run: `npm test`, `npm run validate:env`, `npm run doctor`, `npm run routines:plan`.

Expected: all commands exit 0.

- [ ] **Step 2: Install routine jobs**

Run: `npm run routines:install`.

Expected: five assistant routine jobs are present in `.openclaw/state/cron/jobs.json`, unrelated jobs remain intact.

- [ ] **Step 3: Refresh gateway**

Run: `npm run render:config` and `launchctl kickstart -k gui/501/ai.openclaw.gateway`.

Expected: gateway status reports connectivity OK.
