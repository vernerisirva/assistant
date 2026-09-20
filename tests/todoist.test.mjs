import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir, userInfo } from "node:os";
import { Readable } from "node:stream";
import {
  buildTodoistTaskPayload,
  createTodoistClient,
  todoistTokenStatus,
} from "../scripts/lib/todoist.mjs";
import {
  appendExplicitTodoistDetail,
  buildExactTodoistUpdatePlan,
  cleanupTodoistDescriptionFormatting,
  resolveExactTodoistTask,
} from "../scripts/lib/todoist-exact-update.mjs";
import {
  buildTodoistCreatePlan,
  buildTodoistUpdatePlan,
  formatTodoistTaskPlan,
  supportedTaskFields,
} from "../scripts/lib/todoist-create.mjs";
import {
  hasTransportEscapes,
  normalizeTodoistDescription,
  splitTodoistTitle,
} from "../scripts/lib/todoist-format.mjs";
import {
  describeDuplicateOutcome,
  findTodoistDuplicates,
} from "../scripts/lib/todoist-duplicates.mjs";
import {
  resolveTodoistProject,
  resolveTodoistSection,
} from "../scripts/lib/todoist-targets.mjs";
import { detectTodoistNoop } from "../scripts/lib/todoist-noop.mjs";
import { parseTodoistArgs, runTodoistCli } from "../scripts/todoist.mjs";

function recordingClient(calls, response = { id: "task-new", content: "Created" }, openTasks = []) {
  return createTodoistClient({
    token: "todoist-secret",
    fetchImpl: async (url, options) => {
      const method = options.method ?? "GET";
      calls.push({ url, options, method, body: JSON.parse(options.body ?? "null") });
      return jsonResponse(method === "GET" ? { results: openTasks } : response);
    },
  });
}

/** The create POST, so a test cannot accidentally assert on the duplicate-check read. */
function postCalls(calls) {
  return calls.filter((call) => call.method === "POST");
}

function stdinOf(value) {
  return Readable.from([typeof value === "string" ? value : JSON.stringify(value)]);
}

/** Runs the real CLI through a real shell, so the transport layer is covered. */
function runCliInShell(script) {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", script], { cwd: process.cwd() });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** Builds the documented quoted-heredoc invocation for a task object. */
function heredocScript(task, flags = "--dry-run") {
  return `node scripts/todoist.mjs add --task-json-stdin ${flags} <<'TASKJSON'\n${JSON.stringify(task)}\nTASKJSON\n`;
}

const refusingClient = new Proxy({}, {
  get(_target, property) {
    return async () => {
      throw new Error(`dry run must not call ${String(property)}`);
    };
  },
});

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    async json() {
      return body;
    },
    async text() {
      return typeof body === "string" ? body : JSON.stringify(body);
    },
  };
}

function emptyResponse(status = 204) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "No Content",
    async text() {
      return "";
    },
  };
}

describe("todoistTokenStatus", () => {
  it("reports whether the Todoist API token is configured without exposing it", () => {
    assert.deepEqual(todoistTokenStatus({}), { configured: false });
    assert.deepEqual(todoistTokenStatus({ TODOIST_API_TOKEN: "secret-token" }), {
      configured: true,
    });
  });
});

describe("buildTodoistTaskPayload", () => {
  it("maps friendly task input to Todoist REST v2 fields", () => {
    assert.deepEqual(
      buildTodoistTaskPayload({
        content: "Buy Greek yogurt",
        description: "High-protein breakfast backup",
        dueString: "tomorrow",
        dueLang: "en",
        priority: 3,
        projectId: "project-1",
        sectionId: "section-1",
        labels: ["food", "health"],
      }),
      {
        content: "Buy Greek yogurt",
        description: "High-protein breakfast backup",
        due_string: "tomorrow",
        due_lang: "en",
        priority: 3,
        project_id: "project-1",
        section_id: "section-1",
        labels: ["food", "health"],
      },
    );
  });

  it("requires task content for new tasks", () => {
    assert.throws(
      () => buildTodoistTaskPayload({ dueString: "today" }),
      /Todoist task content is required/,
    );
  });
});

describe("createTodoistClient", () => {
  it("reads one task by id", async () => {
    const calls = [];
    const client = createTodoistClient({
      token: "todoist-secret",
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return jsonResponse({ id: "task-1", content: "Gym workout" });
      },
    });

    const task = await client.getTask("task-1");

    assert.equal(task.content, "Gym workout");
    assert.equal(calls[0].url, "https://api.todoist.com/api/v1/tasks/task-1");
    assert.equal(calls[0].options.method, "GET");
  });

  it("lists tasks using a bearer token and filter query", async () => {
    const calls = [];
    const client = createTodoistClient({
      token: "todoist-secret",
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return jsonResponse({ results: [{ id: "1", content: "Walk" }], next_cursor: null });
      },
    });

    const tasks = await client.getTasks({ filter: "today" });

    assert.deepEqual(tasks, [{ id: "1", content: "Walk" }]);
    assert.equal(calls[0].url, "https://api.todoist.com/api/v1/tasks/filter?query=today");
    assert.equal(calls[0].options.headers.Authorization, "Bearer todoist-secret");
  });

  it("creates a task with an idempotency key", async () => {
    const calls = [];
    const client = createTodoistClient({
      token: "todoist-secret",
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return jsonResponse({ id: "42", content: "Buy oats" }, 200);
      },
    });

    const task = await client.addTask(
      { content: "Buy oats", dueString: "tomorrow" },
      { requestId: "req-1" },
    );

    assert.equal(task.id, "42");
    assert.equal(calls[0].url, "https://api.todoist.com/api/v1/tasks");
    assert.equal(calls[0].options.method, "POST");
    assert.equal(calls[0].options.headers["X-Request-Id"], "req-1");
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      content: "Buy oats",
      due_string: "tomorrow",
    });
  });

  it("returns true for successful task completion", async () => {
    const calls = [];
    const client = createTodoistClient({
      token: "todoist-secret",
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return emptyResponse();
      },
    });

    assert.equal(await client.closeTask("task-1"), true);
    assert.equal(calls[0].url, "https://api.todoist.com/api/v1/tasks/task-1/close");
    assert.equal(calls[0].options.method, "POST");
  });

  it("raises a redacted error when Todoist rejects a request", async () => {
    const client = createTodoistClient({
      token: "todoist-secret",
      fetchImpl: async () => jsonResponse("bad token", 401),
    });

    await assert.rejects(
      () => client.getTasks(),
      (error) => {
        assert.match(error.message, /Todoist API request failed: 401/);
        assert.doesNotMatch(error.message, /todoist-secret/);
        return true;
      },
    );
  });
});

describe("parseTodoistArgs", () => {
  it("parses task list filters", () => {
    assert.deepEqual(parseTodoistArgs(["tasks", "--filter", "today"]), {
      command: "tasks",
      options: { filter: "today" },
      dryRun: false,
    });
  });

  it("parses dry-run task creation options", () => {
    assert.deepEqual(
      parseTodoistArgs([
        "add",
        "--content",
        "Buy oats",
        "--due",
        "tomorrow",
        "--label",
        "food",
        "--label",
        "health",
        "--dry-run",
      ]),
      {
        command: "add",
        options: {
          content: "Buy oats",
          dueString: "tomorrow",
          labels: ["food", "health"],
        },
        dryRun: true,
      },
    );
  });

  it("requires a task id for completion commands", () => {
    assert.throws(() => parseTodoistArgs(["close"]), /--task-id is required/);
  });
});

describe("exact Todoist update helpers", () => {
  const tasks = [
    { id: "task-1", content: "AI video", description: "Line one\n\n\n-  messy bullet  " },
    { id: "task-2", content: "Gym workout", description: "Warm up\nStrength" },
  ];

  it("resolves one exact task by id or content and asks for clarification on ambiguous titles", () => {
    assert.deepEqual(resolveExactTodoistTask(tasks, { taskId: "task-1" }), {
      status: "exact",
      task: tasks[0],
    });
    assert.deepEqual(resolveExactTodoistTask(tasks, { content: "gym workout" }), {
      status: "exact",
      task: tasks[1],
    });
    assert.equal(
      resolveExactTodoistTask([
        { id: "a", content: "AI video" },
        { id: "b", content: "AI video" },
      ], { content: "AI video" }).status,
      "clarification_needed",
    );
  });

  it("cleans up Todoist description formatting without changing substantive content", () => {
    assert.equal(
      cleanupTodoistDescriptionFormatting("  Warm up  \n\n\n -  Strength  \n\nCool down  "),
      "Warm up\n\n- Strength\n\nCool down",
    );
  });

  it("leaves literal backslashes in a fetched Todoist description alone", () => {
    const stored = "Run split('\\n') on C:\\notes\\log.txt";

    assert.equal(cleanupTodoistDescriptionFormatting(stored), stored);
    assert.equal(
      cleanupTodoistDescriptionFormatting("Lunch plan:\\n- Sausages"),
      "Lunch plan:\\n- Sausages",
    );
  });

  it("appends explicit user-provided detail without inventing content", () => {
    assert.equal(
      appendExplicitTodoistDetail("Warm up", "Keep this easy after golf"),
      "Warm up\n\nKeep this easy after golf",
    );
  });

  it("builds exact update plans for formatting, wording, explicit detail, and completion", () => {
    assert.deepEqual(
      buildExactTodoistUpdatePlan(tasks[0], { action: "format-description" }),
      {
        mode: "execute_then_confirm",
        command: "update",
        taskId: "task-1",
        payload: { description: "Line one\n\n- messy bullet" },
        confirmation: "Updated the Todoist task formatting. I kept the content the same and only cleaned up the description layout.",
      },
    );
    assert.deepEqual(
      buildExactTodoistUpdatePlan(tasks[1], {
        action: "wording-description",
        replacementDescription: "Warm up first\nThen strength",
      }).mode,
      "execute_then_confirm",
    );
    // Replacing a description with what it already says changes nothing.
    assert.deepEqual(
      buildExactTodoistUpdatePlan(tasks[1], {
        action: "wording-description",
        replacementDescription: "Warm up\nStrength",
      }).mode,
      "no_change_needed",
    );
    assert.deepEqual(
      buildExactTodoistUpdatePlan(tasks[1], {
        action: "append-detail",
        detail: "Keep this easy after golf",
      }).payload,
      { description: "Warm up\nStrength\n\nKeep this easy after golf" },
    );
    assert.deepEqual(
      buildExactTodoistUpdatePlan(tasks[1], { action: "complete" }),
      {
        mode: "execute_then_confirm",
        command: "close",
        taskId: "task-2",
        payload: null,
        confirmation: "Marked the Todoist task complete.",
      },
    );
  });

  it("rejects inferred substantive detail and unsafe exact update actions", () => {
    assert.equal(
      buildExactTodoistUpdatePlan(tasks[0], {
        action: "append-detail",
        inferredUpdateContent: true,
      }).mode,
      "approval_required",
    );
    assert.equal(
      buildExactTodoistUpdatePlan(tasks[0], { action: "delete" }).mode,
      "approval_required",
    );
  });
});

describe("Todoist exact-update CLI flow", () => {
  it("fetches one exact task and dry-runs a formatting-only update", async () => {
    const calls = [];
    const client = {
      async getTask(taskId) {
        calls.push(["getTask", taskId]);
        return { id: taskId, content: "AI video", description: "  Line one  \n\n\nLine two  " };
      },
      async updateTask() {
        throw new Error("dry-run must not update");
      },
    };

    const result = await runTodoistCli([
      "exact-update",
      "--task-id",
      "task-1",
      "--action",
      "format-description",
      "--dry-run",
    ], { client });

    assert.equal(result.dryRun, true);
    assert.equal(result.mode, "execute_then_confirm");
    assert.deepEqual(result.payload, { description: "Line one\n\nLine two" });
    assert.deepEqual(calls, [["getTask", "task-1"]]);
  });

  it("returns clarification when exact-update content matching is ambiguous", async () => {
    const client = {
      async getTasks() {
        return [
          { id: "a", content: "AI video", description: "" },
          { id: "b", content: "AI video", description: "" },
        ];
      },
    };

    const result = await runTodoistCli([
      "exact-update",
      "--match-content",
      "AI video",
      "--action",
      "format-description",
      "--dry-run",
    ], { client });

    assert.equal(result.status, "clarification_needed");
  });

  it("marks one exact task complete when explicitly requested", async () => {
    const calls = [];
    const client = {
      async getTask(taskId) {
        calls.push(["getTask", taskId]);
        return { id: taskId, content: "Gym workout", description: "" };
      },
      async closeTask(taskId) {
        calls.push(["closeTask", taskId]);
        return true;
      },
    };

    const result = await runTodoistCli([
      "exact-update",
      "--task-id",
      "task-2",
      "--action",
      "complete",
    ], { client });

    assert.equal(result.mode, "execute_then_confirm");
    assert.equal(result.confirmation, "Marked the Todoist task complete.");
    assert.deepEqual(calls, [["getTask", "task-2"], ["closeTask", "task-2"]]);
  });
});

describe("Todoist task creation plan", () => {
  it("builds a simple title-only task without an empty description field", () => {
    const plan = buildTodoistCreatePlan({ content: "Call dad" });

    assert.deepEqual(plan.payload, { content: "Call dad" });
    assert.deepEqual(plan.descriptionLines, []);
    assert.equal(plan.command, "add");
    assert.equal(plan.mode, "execute_then_confirm");
    assert.deepEqual(plan.adjustments, []);
    assert.deepEqual(plan.warnings, []);
  });

  it("builds a title plus one-line description", () => {
    const plan = buildTodoistCreatePlan({
      content: "Buy Greek yogurt",
      description: "High-protein breakfast backup",
    });

    assert.deepEqual(plan.payload, {
      content: "Buy Greek yogurt",
      description: "High-protein breakfast backup",
    });
  });

  it("keeps a multiline description as real line breaks", () => {
    const plan = buildTodoistCreatePlan({
      content: "Review AI research updates",
      description: "Goal:\nFind 1-3 updates.\n\nSources:\n- Hugging Face\n- arXiv",
    });

    assert.equal(
      plan.payload.description,
      "Goal:\nFind 1-3 updates.\n\nSources:\n- Hugging Face\n- arXiv",
    );
    assert.deepEqual(plan.descriptionLines, [
      "Goal:",
      "Find 1-3 updates.",
      "",
      "Sources:",
      "- Hugging Face",
      "- arXiv",
    ]);
  });

  it("collapses accidental newlines in the title and keeps the extra lines in the description", () => {
    const plan = buildTodoistCreatePlan({
      content: "## Review AI research updates\n- Check papers\n- Read Hugging Face",
    });

    assert.equal(plan.payload.content, "Review AI research updates");
    assert.equal(plan.payload.description, "- Check papers\n- Read Hugging Face");
    assert.ok(plan.adjustments.includes("Moved extra task title lines into the description."));
  });

  it("trims a trailing newline in the title without inventing a description", () => {
    const plan = buildTodoistCreatePlan({ content: "  Call dad \n\n" });

    assert.deepEqual(plan.payload, { content: "Call dad" });
  });

  it("strips Markdown used only for visual structure in the title", () => {
    assert.equal(buildTodoistCreatePlan({ content: "**Call dad**" }).payload.content, "Call dad");
    assert.equal(buildTodoistCreatePlan({ content: "- Call dad" }).payload.content, "Call dad");
    assert.equal(
      buildTodoistCreatePlan({ content: "Call *dad* and mum" }).payload.content,
      "Call *dad* and mum",
    );
  });

  it("reduces excessive blank lines to one blank line between sections", () => {
    const plan = buildTodoistCreatePlan({
      content: "Prepare Tobias meeting",
      description: "\n\nTopics:\n- Time estimate\n\n\n\n\nOutcome:\nAgree the next step.\n\n\n",
    });

    assert.equal(
      plan.payload.description,
      "Topics:\n- Time estimate\n\nOutcome:\nAgree the next step.",
    );
  });

  it("normalizes malformed bullet spacing and keeps nested bullet lists", () => {
    const plan = buildTodoistCreatePlan({
      content: "Plan week",
      description: "-   Parent item\n  - Child item\n*  Second parent",
    });

    assert.equal(
      plan.payload.description,
      "- Parent item\n  - Child item\n* Second parent",
    );
  });

  it("keeps numbered lists intact", () => {
    const plan = buildTodoistCreatePlan({
      content: "Cook lunch",
      description: "1.   Cook potatoes\n2. Fry sausages\n10) Serve",
    });

    assert.equal(
      plan.payload.description,
      "1. Cook potatoes\n2. Fry sausages\n10) Serve",
    );
  });

  it("preserves Markdown links and plain URLs in the description", () => {
    const plan = buildTodoistCreatePlan({
      content: "Review AI research updates",
      description:
        "Sources:\n- [Hugging Face Daily Papers](https://huggingface.co/papers)\n- https://arxiv.org/list/cs.CL/recent",
    });

    assert.equal(
      plan.payload.description,
      "Sources:\n- [Hugging Face Daily Papers](https://huggingface.co/papers)\n- https://arxiv.org/list/cs.CL/recent",
    );
  });

  it("preserves bold, italic, and headings in the description", () => {
    const plan = buildTodoistCreatePlan({
      content: "Prepare review",
      description: "## Topics\n**Important:** bring the *draft* and _notes_.",
    });

    assert.equal(
      plan.payload.description,
      "## Topics\n**Important:** bring the *draft* and _notes_.",
    );
  });

  it("preserves fenced code blocks including indentation and inner blank lines", () => {
    const description = [
      "Run this:",
      "",
      "```bash",
      "if true; then",
      "    echo \"deep indent\"",
      "",
      "",
      "fi",
      "```",
      "",
      "Then report back.",
    ].join("\n");

    const plan = buildTodoistCreatePlan({ content: "Fix deploy", description });

    assert.equal(plan.payload.description, description);
  });

  it("keeps indented code blocks and table alignment outside fences", () => {
    const plan = buildTodoistCreatePlan({
      content: "Document API",
      description: "Example:\n\n    const x = 1;\n        const y = 2;\n\n| a | b  |\n| - | -- |",
    });

    assert.equal(
      plan.payload.description,
      "Example:\n\n    const x = 1;\n        const y = 2;\n\n| a | b  |\n| - | -- |",
    );
  });

  it("drops a description first line that only repeats the task title", () => {
    const plan = buildTodoistCreatePlan({
      content: "Review AI research updates",
      description: "Review AI research updates\n\nGoal:\nFind 1-3 updates.",
    });

    assert.equal(plan.payload.description, "Goal:\nFind 1-3 updates.");
    assert.ok(
      plan.adjustments.includes(
        "Removed a description first line that only repeated the task title.",
      ),
    );
  });

  it("keeps a first description line that adds information", () => {
    const plan = buildTodoistCreatePlan({
      content: "Review AI research updates",
      description: "Review AI research updates before Friday\n\nGoal:\nFind 1-3 updates.",
    });

    assert.equal(
      plan.payload.description,
      "Review AI research updates before Friday\n\nGoal:\nFind 1-3 updates.",
    );
    assert.deepEqual(plan.adjustments, []);
  });

  it("preserves due date, project, section, labels, and priority behavior", () => {
    const plan = buildTodoistCreatePlan({
      content: "Buy oats",
      dueString: "tomorrow",
      dueLang: "en",
      priority: 3,
      projectId: "project-1",
      sectionId: "section-1",
      labels: ["food", "health"],
    });

    assert.deepEqual(plan.payload, {
      content: "Buy oats",
      due_string: "tomorrow",
      due_lang: "en",
      priority: 3,
      project_id: "project-1",
      section_id: "section-1",
      labels: ["food", "health"],
    });
  });

  it("warns without rewriting when the title carries a URL or repeats the due date", () => {
    const plan = buildTodoistCreatePlan({
      content: "Read https://arxiv.org today",
      dueString: "today",
    });

    assert.equal(plan.payload.content, "Read https://arxiv.org today");
    assert.equal(plan.warnings.length, 2);
    assert.match(plan.warnings[0], /title contains a URL/i);
    assert.match(plan.warnings[1], /repeats the due date/i);
  });
});

describe("Todoist creation payload validation", () => {
  it("rejects empty or whitespace-only content", () => {
    assert.throws(() => buildTodoistCreatePlan({}), /content is required/);
    assert.throws(() => buildTodoistCreatePlan({ content: "   \n  " }), /content is required/);
    assert.throws(
      () => buildTodoistCreatePlan({ description: "Some detail" }),
      /content is required/,
    );
  });

  it("requires the description to be a string", () => {
    assert.throws(
      () => buildTodoistCreatePlan({ content: "Call dad", description: { text: "no" } }),
      /description must be a string/,
    );
    assert.throws(
      () => buildTodoistCreatePlan({ content: "Call dad", description: 42 }),
      /description must be a string/,
    );
  });

  it("refuses unsupported internal fields instead of forwarding them to Todoist", () => {
    assert.throws(
      () => buildTodoistCreatePlan({ content: "Call dad", action: "format-description" }),
      /Unsupported Todoist task field: action/,
    );
    assert.throws(
      () => buildTodoistCreatePlan({ content: "Call dad", matchContent: "Call dad" }),
      /Unsupported Todoist task field: matchContent/,
    );
  });

  it("validates priority and labels", () => {
    assert.throws(
      () => buildTodoistCreatePlan({ content: "Call dad", priority: 9 }),
      /priority must be an integer between 1 and 4/,
    );
    assert.throws(
      () => buildTodoistCreatePlan({ content: "Call dad", priority: Number("high") }),
      /priority must be an integer between 1 and 4/,
    );
    assert.throws(
      () => buildTodoistCreatePlan({ content: "Call dad", labels: "food" }),
      /labels must be an array of strings/,
    );
  });

  it("enforces Todoist length limits", () => {
    assert.throws(
      () => buildTodoistCreatePlan({ content: "x".repeat(501) }),
      /content must be 500 characters or fewer/,
    );
    assert.throws(
      () => buildTodoistCreatePlan({ content: "Call dad", description: "x".repeat(16385) }),
      /description must be 16384 characters or fewer/,
    );
  });

  it("refuses a multiline title on update instead of dropping or overwriting text", () => {
    assert.throws(
      () => buildTodoistUpdatePlan("task-1", { content: "New title\nExtra line" }),
      /content must be one line/,
    );
    assert.throws(
      () => buildTodoistUpdatePlan("", { content: "New title" }),
      /task id is required/,
    );
  });

  it("uses the same normalization for updates as for creation", () => {
    const plan = buildTodoistUpdatePlan("task-1", {
      description: "  Goal:  \n\n\n-  Ship it  ",
      dueString: "friday",
    });

    assert.deepEqual(plan.payload, {
      description: "Goal:\n\n- Ship it",
      due_string: "friday",
    });
    assert.equal(plan.taskId, "task-1");
  });

  it("rejects an update that would change nothing", () => {
    assert.throws(
      () => buildTodoistUpdatePlan("task-1", {}),
      /needs at least one field to change/,
    );
  });
});

describe("Todoist multiline transport", () => {
  it("detects an escaped newline only when the text has no real line break", () => {
    assert.equal(hasTransportEscapes("a\\nb"), true);
    assert.equal(hasTransportEscapes("real\nbreak with \\n text"), false);
    assert.equal(hasTransportEscapes("no escapes here"), false);
  });

  it("refuses an escaped newline in a shell argument instead of guessing", async () => {
    for (const flag of ["--content", "--description"]) {
      await assert.rejects(
        () => runTodoistCli(
          ["add", "--content", "Lunch plan", flag, "Prep:\\n- Sausages", "--dry-run"],
          { client: refusingClient },
        ),
        (error) => {
          assert.match(error.message, new RegExp(`\\${flag} contains a literal`));
          assert.match(error.message, /--task-json-stdin/);
          return true;
        },
      );
    }
  });

  it("parses --task-json so escaped newlines reach Todoist as real line breaks", async () => {
    const calls = [];
    const args = [
      "add",
      "--task-json",
      '{"content":"Review AI research updates","description":"Goal:\\nFind 1-3 updates.\\n\\nSources:\\n- Hugging Face","dueString":"tomorrow"}',
    ];

    const result = await runTodoistCli(args, { client: recordingClient(calls) });

    assert.equal(postCalls(calls)[0].body.content, "Review AI research updates");
    assert.equal(
      postCalls(calls)[0].body.description,
      "Goal:\nFind 1-3 updates.\n\nSources:\n- Hugging Face",
    );
    assert.equal(postCalls(calls)[0].body.due_string, "tomorrow");
    assert.ok(!JSON.stringify(postCalls(calls)[0].body).includes("\\\\n"));
    assert.equal(result.dryRun, false);
    assert.equal(result.confirmation, 'Created the Todoist task "Review AI research updates".');
  });

  it("never sends a literal backslash-n where a line break was intended", async () => {
    const calls = [];

    await assert.rejects(
      () => runTodoistCli(
        ["add", "--content", "Lunch plan", "--description", "Step one\\nStep two"],
        { client: recordingClient(calls) },
      ),
      /contains a literal/,
    );
    assert.equal(calls.length, 0);

    await runTodoistCli(["add", "--task-json-stdin"], {
      client: recordingClient(calls),
      stdin: stdinOf({ content: "Lunch plan", description: "Step one\nStep two" }),
    });

    const sent = postCalls(calls)[0].body.description;
    assert.equal(sent, "Step one\nStep two");
    assert.ok(!sent.includes("\\n"));
  });

  it("leaves a real backslash-n inside a fenced code block alone", () => {
    const description = ["```js", 'process.stdout.write("a\\nb");', "```"].join("\n");
    const plan = buildTodoistCreatePlan({ content: "Fix logging", description });

    assert.equal(plan.payload.description, description);
    assert.ok(plan.payload.description.includes("\\n"));
    assert.deepEqual(plan.adjustments, []);
  });

  it("merges --task-json with individual flags and lets explicit flags win", () => {
    const parsed = parseTodoistArgs([
      "add",
      "--task-json",
      '{"content":"From JSON","dueString":"tomorrow","labels":["ai"]}',
      "--content",
      "From flag",
    ]);

    assert.deepEqual(parsed.options, {
      content: "From flag",
      dueString: "tomorrow",
      labels: ["ai"],
    });
  });

  it("rejects invalid or unsupported --task-json input", () => {
    assert.throws(
      () => parseTodoistArgs(["add", "--task-json", "{not json"]),
      /--task-json must be valid JSON/,
    );
    assert.throws(
      () => parseTodoistArgs(["add", "--task-json", '{"content":"x","taskId":"1"}']),
      /Unsupported Todoist task field: taskId/,
    );
    assert.throws(
      () => parseTodoistArgs(["add", "--task-json", '["content"]']),
      /must be a JSON object/,
    );
  });

  it("accepts snake_case and short aliases in --task-json", () => {
    const parsed = parseTodoistArgs([
      "add",
      "--task-json",
      '{"content":"Buy oats","due":"tomorrow","project_id":"p1"}',
    ]);

    assert.deepEqual(parsed.options, {
      content: "Buy oats",
      dueString: "tomorrow",
      projectId: "p1",
    });
  });
});

describe("Todoist creation dry run", () => {
  const args = [
    "add",
    "--task-json",
    '{"content":"## Prepare Tobias meeting\\n- Time estimate","description":"Prepare Tobias meeting\\n\\nTopics:\\n-  Time estimate\\n\\n\\n\\nOutcome:\\nAgree the next step.","dueString":"tomorrow","priority":2}',
    "--label",
    "admin",
  ];

  it("sends exactly the payload the dry run showed", async () => {
    const dryRun = await runTodoistCli([...args, "--dry-run"], { client: refusingClient });
    const calls = [];
    await runTodoistCli(args, { client: recordingClient(calls) });

    assert.deepEqual(postCalls(calls)[0].body, dryRun.payload);
    assert.deepEqual(dryRun.payload, {
      content: "Prepare Tobias meeting",
      description: "- Time estimate\n\nTopics:\n- Time estimate\n\nOutcome:\nAgree the next step.",
      due_string: "tomorrow",
      priority: 2,
      labels: ["admin"],
    });
  });

  it("never posts on a dry run, and performs the read-only duplicate check", async () => {
    const calls = [];
    const result = await runTodoistCli([...args, "--dry-run"], {
      client: recordingClient(calls),
    });

    assert.deepEqual(postCalls(calls), []);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "GET");
    assert.equal(result.dryRun, true);
    assert.equal(result.duplicateCheck.status, "none");
    assert.match(result.confirmation, /^Dry run only\. No Todoist task was created/);
    assert.match(result.confirmation, /No matching open task was found\./);
  });

  it("never writes on a dry-run update or completion", async () => {
    const calls = [];
    const update = await runTodoistCli([
      "update",
      "--task-id",
      "task-1",
      "--content",
      "Renamed task",
      "--dry-run",
    ], { client: recordingClient(calls) });
    const close = await runTodoistCli([
      "close",
      "--task-id",
      "task-1",
      "--dry-run",
    ], { client: recordingClient(calls) });

    assert.deepEqual(postCalls(calls), [], "a dry run must not write");
    assert.deepEqual(update.payload, { content: "Renamed task" });
    assert.equal(update.dryRun, true);
    assert.equal(close.dryRun, true);
    assert.match(close.confirmation, /was not changed/);
  });

  it("shows the description line by line so line breaks are inspectable", async () => {
    const dryRun = await runTodoistCli([...args, "--dry-run"], { client: refusingClient });
    const text = formatTodoistTaskPlan(dryRun, { dryRun: true });

    assert.deepEqual(dryRun.descriptionLines, [
      "- Time estimate",
      "",
      "Topics:",
      "- Time estimate",
      "",
      "Outcome:",
      "Agree the next step.",
    ]);
    assert.match(text, /^Todoist add dry run\. Nothing was sent to Todoist\./);
    assert.match(text, /- Title: Prepare Tobias meeting/);
    assert.match(text, /\| Outcome:/);
    assert.match(text, /- Due: tomorrow/);
    assert.match(text, /- Labels: admin/);
    assert.match(text, /- Adjusted: Moved extra task title lines into the description\./);
  });
});

describe("shared Todoist formatting primitives", () => {
  it("uses one normalization implementation for creation and exact updates", () => {
    const messy = "  Goal:  \n\n\n-  Ship it  \n\n";

    assert.equal(
      cleanupTodoistDescriptionFormatting(messy),
      normalizeTodoistDescription(messy),
    );
    assert.equal(
      buildTodoistCreatePlan({ content: "Task", description: messy }).payload.description,
      cleanupTodoistDescriptionFormatting(messy),
    );
  });

  it("keeps formatting-only exact updates free of substantive changes", () => {
    const original = [
      "# Goal",
      "Ship **v1** and [read the docs](https://example.com).",
      "",
      "```python",
      "def run():",
      "    return 1",
      "```",
    ].join("\n");

    assert.equal(cleanupTodoistDescriptionFormatting(original), original);
  });

  it("splits a title into one line plus overflow", () => {
    assert.deepEqual(splitTodoistTitle("Call dad"), { title: "Call dad", overflow: "" });
    assert.deepEqual(splitTodoistTitle("# Title\n\nBody line\n"), {
      title: "Title",
      overflow: "Body line",
    });
    assert.deepEqual(splitTodoistTitle("   \n"), { title: "", overflow: "" });
  });
});

describe("Todoist documentation", () => {
  const setup = readFileSync("docs/setup/todoist.md", "utf8");
  const operation = readFileSync("docs/operations/daily-operation.md", "utf8");

  it("documents the canonical structured creation command", () => {
    for (const doc of [setup, operation]) {
      assert.match(doc, /npm run todoist -- add --task-json-stdin/);
      assert.match(doc, /<<'JSON'/);
      assert.match(doc, /real line break/i);
      assert.match(doc, /never enters a shell argument/i);
      assert.match(doc, /stay literal/i);
    }

    assert.match(setup, /canonical command for anything with a multiline description/i);
    assert.match(setup, /byte-for-byte what a real `add` sends/i);
    assert.match(setup, /Call O'Connor/);
    assert.match(setup, /\(unchanged\)/);
  });

  it("documents the formatting policy and the supported task fields", () => {
    assert.match(setup, /## Task Formatting/);
    assert.match(setup, /One short actionable line naming the task/i);
    assert.match(setup, /Extra title lines are moved into the description rather than dropped/i);
    assert.match(setup, /fenced code blocks are preserved exactly/i);
    assert.match(setup, /Indentation is preserved/);
    assert.match(setup, /Trailing whitespace is removed outside fenced code blocks/);
    assert.match(setup, /only repeats the title is dropped/i);
    assert.match(setup, /Validation rejects empty content/i);

    for (const field of supportedTaskFields) {
      assert.match(setup, new RegExp(`\`${field}\``));
    }
  });

  it("keeps the documented Todoist approval boundary unchanged", () => {
    assert.match(
      setup,
      /Reopening, deleting, moving between projects\/sections, bulk editing, shared\/project-wide changes, ambiguous task targets, sensitive content, inferred update content, and changes affecting other people require explicit Telegram approval/,
    );
    assert.match(
      setup,
      /Creating a task is allowed without a second approval only when the user explicitly asks/,
    );
  });
});

describe("shell-safe structured task input", () => {
  const awkwardTask = {
    content: "Call O'Connor",
    description: [
      "Don't forget this. \"Quoted\" text too.",
      "",
      "$HOME and $(whoami) and `date` stay literal.",
      "",
      "- [Hugging Face Daily Papers](https://huggingface.co/papers)",
      "",
      "```js",
      'process.stdout.write("a\\nb");',
      "```",
    ].join("\n"),
    dueString: "tomorrow",
  };

  it("keeps apostrophes, quotes, and shell metacharacters literal end to end", async () => {
    const { code, stdout, stderr } = await runCliInShell(heredocScript(awkwardTask));
    assert.equal(stderr, "");
    assert.equal(code, 0);

    const { payload } = JSON.parse(stdout);

    assert.equal(payload.content, "Call O'Connor");
    assert.match(payload.description, /Don't forget this\. "Quoted" text too\./);
    assert.match(payload.description, /\$HOME and \$\(whoami\) and `date` stay literal\./);
    assert.match(payload.description, /\[Hugging Face Daily Papers\]\(https:\/\/huggingface\.co\/papers\)/);
    assert.equal(payload.due_string, "tomorrow");
  });

  it("does not let the shell expand or execute anything in task text", async () => {
    const { stdout } = await runCliInShell(heredocScript(awkwardTask));
    const { payload } = JSON.parse(stdout);

    assert.ok(payload.description.includes("$HOME"));
    assert.ok(payload.description.includes("$(whoami)"));
    assert.ok(payload.description.includes("`date`"));
    // Compare against values that always exist, so these cannot quietly become
    // vacuous on a runner where HOME is unset or paths look different.
    assert.ok(!payload.description.includes(homedir()));
    assert.ok(!payload.description.includes(userInfo().username));
  });

  it("carries multiline text and a code block containing a literal backslash-n", async () => {
    const { stdout } = await runCliInShell(heredocScript(awkwardTask));
    const { payload, descriptionLines } = JSON.parse(stdout);

    assert.ok(payload.description.includes("\n"));
    assert.equal(descriptionLines[0], "Don't forget this. \"Quoted\" text too.");
    assert.ok(payload.description.includes('process.stdout.write("a\\nb");'));
    assert.ok(payload.description.includes("```js"));
  });

  it("fails closed on invalid stdin JSON through the real CLI", async () => {
    const { code, stdout, stderr } = await runCliInShell(
      "node scripts/todoist.mjs add --task-json-stdin --dry-run <<'TASKJSON'\n{not json\nTASKJSON\n",
    );

    assert.equal(code, 1);
    assert.equal(stdout, "");
    assert.match(stderr, /--task-json-stdin must be valid JSON/);
  });

  it("fails clearly on empty stdin through the real CLI", async () => {
    const { code, stderr } = await runCliInShell(
      "node scripts/todoist.mjs add --task-json-stdin --dry-run < /dev/null",
    );

    assert.equal(code, 1);
    assert.match(stderr, /received empty stdin/);
  });

  it("reads structured input from stdin in process", async () => {
    const result = await runTodoistCli(["add", "--task-json-stdin", "--dry-run"], {
      client: refusingClient,
      stdin: stdinOf({ content: "Call O'Connor", description: "Don't forget." }),
    });

    assert.deepEqual(result.payload, {
      content: "Call O'Connor",
      description: "Don't forget.",
    });
  });

  it("feeds stdin input through the same plan builder as flags and --task-json", async () => {
    const task = { content: "Review AI research updates", description: "Goal:\nFind updates." };
    const fromStdin = await runTodoistCli(["add", "--task-json-stdin", "--dry-run"], {
      client: refusingClient,
      stdin: stdinOf(task),
    });
    const fromJsonFlag = await runTodoistCli(
      ["add", "--task-json", JSON.stringify(task), "--dry-run"],
      { client: refusingClient },
    );
    const fromFlags = await runTodoistCli(
      ["add", "--content", task.content, "--description", task.description, "--dry-run"],
      { client: refusingClient },
    );

    assert.deepEqual(fromStdin.payload, fromJsonFlag.payload);
    assert.deepEqual(fromStdin.payload, fromFlags.payload);
  });

  it("sends exactly the stdin dry-run payload on real creation", async () => {
    const task = { content: "Call O'Connor", description: "Don't forget.\n\n$HOME stays literal." };
    const dryRun = await runTodoistCli(["add", "--task-json-stdin", "--dry-run"], {
      client: refusingClient,
      stdin: stdinOf(task),
    });
    const calls = [];
    await runTodoistCli(["add", "--task-json-stdin"], {
      client: recordingClient(calls),
      stdin: stdinOf(task),
    });

    assert.deepEqual(postCalls(calls)[0].body, dryRun.payload);
    assert.equal(postCalls(calls)[0].body.content, "Call O'Connor");
    assert.ok(postCalls(calls)[0].body.description.includes("$HOME"));
  });

  it("lets explicit flags override stdin input", async () => {
    const result = await runTodoistCli(
      ["add", "--task-json-stdin", "--content", "From flag", "--dry-run"],
      { client: refusingClient, stdin: stdinOf({ content: "From stdin", dueString: "tomorrow" }) },
    );

    assert.deepEqual(result.payload, { content: "From flag", due_string: "tomorrow" });
  });

  it("rejects unsupported fields and a non-object from stdin", async () => {
    await assert.rejects(
      () => runTodoistCli(["add", "--task-json-stdin", "--dry-run"], {
        client: refusingClient,
        stdin: stdinOf({ content: "x", taskId: "1" }),
      }),
      /Unsupported Todoist task field: taskId/,
    );
    await assert.rejects(
      () => runTodoistCli(["add", "--task-json-stdin", "--dry-run"], {
        client: refusingClient,
        stdin: stdinOf("[1,2]"),
      }),
      /must be a JSON object/,
    );
  });

  it("explains itself instead of hanging when stdin is a terminal", async () => {
    await assert.rejects(
      () => runTodoistCli(["add", "--task-json-stdin", "--dry-run"], {
        client: refusingClient,
        stdin: { isTTY: true },
      }),
      /needs a JSON object on stdin/,
    );
  });

  it("refuses both structured interfaces at once", () => {
    assert.throws(
      () => parseTodoistArgs([
        "add",
        "--task-json",
        '{"content":"x"}',
        "--task-json-stdin",
      ]),
      /Use either --task-json or --task-json-stdin, not both/,
    );
  });
});

describe("description indentation is preserved", () => {
  it("keeps list continuation text indented under its item", () => {
    assert.equal(
      normalizeTodoistDescription("- Deploy release\n  only after all tests pass"),
      "- Deploy release\n  only after all tests pass",
    );
  });

  it("keeps nested list content", () => {
    assert.equal(
      normalizeTodoistDescription("- Parent\n  - Child\n    - Grandchild\n    plus a note"),
      "- Parent\n  - Child\n    - Grandchild\n    plus a note",
    );
  });

  it("keeps ordinary intentionally indented text", () => {
    assert.equal(
      normalizeTodoistDescription("Note:\n  This is indented on purpose.\n   So is this."),
      "Note:\n  This is indented on purpose.\n   So is this.",
    );
  });

  it("keeps four-space indented code blocks", () => {
    assert.equal(
      normalizeTodoistDescription("Example:\n\n    const x = 1;\n        const y = 2;"),
      "Example:\n\n    const x = 1;\n        const y = 2;",
    );
  });

  it("keeps fenced code whitespace, including trailing spaces and blank lines", () => {
    const fenced = "```bash\nif true; then\n    echo hi   \n\n\n\nfi\n```";

    assert.equal(normalizeTodoistDescription(fenced), fenced);
  });

  it("still normalizes bullet spacing and strips stray first-line indentation", () => {
    assert.equal(
      normalizeTodoistDescription("  Warm up  \n\n\n -  Strength  \n\nCool down  "),
      "Warm up\n\n- Strength\n\nCool down",
    );
    assert.equal(
      normalizeTodoistDescription("1.   Cook potatoes\n2. Fry sausages"),
      "1. Cook potatoes\n2. Fry sausages",
    );
  });

  it("preserves indentation through the creation pipeline", () => {
    const description = "- Deploy release\n  only after all tests pass\n\nNote:\n  Indented on purpose.";

    assert.equal(
      buildTodoistCreatePlan({ content: "Ship it", description }).payload.description,
      description,
    );
  });
});

describe("Todoist update preview honesty", () => {
  it("says the description is unchanged when the update has no description", () => {
    const titleOnly = buildTodoistUpdatePlan("task-1", { content: "Renamed task" });
    const dueOnly = buildTodoistUpdatePlan("task-1", { dueString: "friday" });

    for (const plan of [titleOnly, dueOnly]) {
      assert.equal(plan.descriptionState, "unchanged");
      assert.equal(plan.payload.description, undefined);
      assert.match(formatTodoistTaskPlan(plan), /- Description: \(unchanged\)/);
    }

    assert.match(formatTodoistTaskPlan(dueOnly), /- Title: \(unchanged\)/);
    assert.match(formatTodoistTaskPlan(titleOnly), /- Title: Renamed task/);
  });

  it("says the description is emptied only when the payload actually clears it", () => {
    const plan = buildTodoistUpdatePlan("task-1", { description: "" });

    assert.equal(plan.descriptionState, "empty");
    assert.equal(plan.payload.description, "");
    assert.match(formatTodoistTaskPlan(plan), /- Description: \(empty\)/);
  });

  it("shows an empty description for a new task without one", () => {
    const plan = buildTodoistCreatePlan({ content: "Call dad" });

    assert.equal(plan.descriptionState, "empty");
    assert.equal(plan.payload.description, undefined);
    assert.match(formatTodoistTaskPlan(plan), /- Description: \(empty\)/);
  });

  it("shows the description lines when there is one", () => {
    const plan = buildTodoistUpdatePlan("task-1", { description: "Goal:\nShip it." });

    assert.equal(plan.descriptionState, "set");
    assert.equal(plan.payload.description, "Goal:\nShip it.");
    assert.match(formatTodoistTaskPlan(plan), /\| Goal:\n {2}\| Ship it\./);
  });

  it("never claims a change for a field missing from the wire payload", () => {
    const plan = buildTodoistUpdatePlan("task-1", { dueString: "friday" });
    const preview = formatTodoistTaskPlan(plan);

    for (const [label, key] of [["Due", "due_string"], ["Priority", "priority"], ["Project", "project_id"]]) {
      if (plan.payload[key] === undefined) {
        assert.doesNotMatch(preview, new RegExp(`- ${label}:`));
      } else {
        assert.match(preview, new RegExp(`- ${label}:`));
      }
    }
  });
});

describe("preview and wire payload agree on clearing fields", () => {
  it("actually sends an explicit description clear to Todoist", async () => {
    const calls = [];
    const dryRun = await runTodoistCli(
      ["update", "--task-id", "task-1", "--task-json", '{"description":""}', "--dry-run"],
      { client: refusingClient },
    );
    await runTodoistCli(
      ["update", "--task-id", "task-1", "--task-json", '{"description":""}'],
      { client: recordingClient(calls) },
    );

    assert.deepEqual(dryRun.payload, { description: "" });
    assert.deepEqual(postCalls(calls)[0].body, dryRun.payload);
    assert.equal(postCalls(calls)[0].body.description, "");
  });

  it("sends exactly the update payload the dry run showed", async () => {
    const args = [
      "update",
      "--task-id",
      "task-1",
      "--task-json",
      '{"content":"Renamed","description":"","dueString":"friday","labels":["admin"]}',
    ];
    const dryRun = await runTodoistCli([...args, "--dry-run"], { client: refusingClient });
    const calls = [];
    await runTodoistCli(args, { client: recordingClient(calls) });

    assert.deepEqual(postCalls(calls)[0].body, dryRun.payload);
    assert.deepEqual(dryRun.payload, {
      content: "Renamed",
      description: "",
      due_string: "friday",
      labels: ["admin"],
    });
  });

  it("clears a whitespace-only description on the exact-update path", async () => {
    const calls = [];
    const client = {
      async getTask(taskId) {
        return { id: taskId, content: "AI video", description: "   \n  " };
      },
      async updateTask(taskId, payload) {
        calls.push({ taskId, payload });
        return true;
      },
    };

    const result = await runTodoistCli(
      ["exact-update", "--task-id", "task-1", "--action", "format-description"],
      { client },
    );

    assert.deepEqual(result.payload, { description: "" });
    assert.deepEqual(calls[0].payload, { description: "" });
  });

  it("shows cleared labels instead of implying they are unchanged", async () => {
    const plan = await runTodoistCli(
      ["update", "--task-id", "task-1", "--task-json", '{"labels":[]}', "--dry-run"],
      { client: refusingClient },
    );
    const calls = [];
    await runTodoistCli(
      ["update", "--task-id", "task-1", "--task-json", '{"labels":[]}'],
      { client: recordingClient(calls) },
    );

    assert.deepEqual(plan.payload, { labels: [] });
    assert.deepEqual(postCalls(calls)[0].body, { labels: [] });
    assert.match(formatTodoistTaskPlan(plan, { dryRun: true }), /- Labels: \(cleared\)/);
  });
});

describe("literal backslashes survive every path", () => {
  const windowsPath = "Copy from C:\\notes\\todo.txt";

  it("keeps a Windows path intact through structured JSON input", async () => {
    const fromStdin = await runTodoistCli(["add", "--task-json-stdin", "--dry-run"], {
      client: refusingClient,
      stdin: stdinOf({ content: "Restore backup", description: windowsPath }),
    });
    const fromJsonFlag = await runTodoistCli(
      ["add", "--task-json", JSON.stringify({ content: "Restore backup", description: windowsPath }), "--dry-run"],
      { client: refusingClient },
    );

    assert.equal(fromStdin.payload.description, windowsPath);
    assert.equal(fromJsonFlag.payload.description, windowsPath);
    assert.deepEqual(fromStdin.adjustments, []);
    assert.equal(hasTransportEscapes(windowsPath), true);
  });

  it("keeps a backslash that cannot be a newline escape on the plain flag", async () => {
    const result = await runTodoistCli(
      ["add", "--content", "Restore backup", "--description", "Copy from C:\\temp\\log.txt", "--dry-run"],
      { client: refusingClient },
    );

    assert.equal(result.payload.description, "Copy from C:\\temp\\log.txt");
  });

  it("refuses an ambiguous backslash-n path rather than rewriting the title", async () => {
    await assert.rejects(
      () => runTodoistCli(["add", "--content", "Clean up C:\\notes", "--dry-run"], {
        client: refusingClient,
      }),
      /--content contains a literal/,
    );

    const viaStdin = await runTodoistCli(["add", "--task-json-stdin", "--dry-run"], {
      client: refusingClient,
      stdin: stdinOf({ content: "Clean up C:\\notes" }),
    });

    assert.equal(viaStdin.payload.content, "Clean up C:\\notes");
    assert.equal(viaStdin.payload.description, undefined);
  });

  it("refuses an ambiguous escape on the exact-update detail flags too", async () => {
    await assert.rejects(
      () => runTodoistCli(
        ["exact-update", "--task-id", "t1", "--action", "append-detail", "--detail", "See C:\\notes"],
        { client: refusingClient },
      ),
      /--detail contains a literal/,
    );
  });

  it("keeps a Windows path intact end to end through the real CLI", async () => {
    const { stdout } = await runCliInShell(
      heredocScript({ content: "Restore backup", description: windowsPath }),
    );

    assert.equal(JSON.parse(stdout).payload.description, windowsPath);
  });
});

describe("normalization never deletes user content", () => {
  it("keeps a numbered first list item that matches the task title", () => {
    const plan = buildTodoistCreatePlan({
      content: "Deploy the release",
      description: "1. Deploy the release\n2. Verify metrics\n3. Announce in Slack",
    });

    assert.equal(
      plan.payload.description,
      "1. Deploy the release\n2. Verify metrics\n3. Announce in Slack",
    );
    assert.deepEqual(plan.adjustments, []);
  });

  it("keeps a bullet checklist whose first item matches the title", () => {
    const plan = buildTodoistCreatePlan({
      content: "Buy milk",
      description: "- Buy milk\n- Buy oats",
    });

    assert.equal(plan.payload.description, "- Buy milk\n- Buy oats");
  });

  it("still drops a plain repeated title line and a repeated heading", () => {
    assert.equal(
      buildTodoistCreatePlan({
        content: "Review updates",
        description: "Review updates\n\nGoal:\nFind one paper.",
      }).payload.description,
      "Goal:\nFind one paper.",
    );
    assert.equal(
      buildTodoistCreatePlan({
        content: "Review updates",
        description: "## Review updates\n\nGoal:\nFind one paper.",
      }).payload.description,
      "Goal:\nFind one paper.",
    );
  });

  it("keeps a first line whose punctuation changes its intent", () => {
    const plan = buildTodoistCreatePlan({
      content: "Call dad",
      description: "Call dad?\n\nHe asked for a ring.",
    });

    assert.equal(plan.payload.description, "Call dad?\n\nHe asked for a ring.");
  });

  it("keeps a leading number in a task title", () => {
    for (const title of ["2024. Review the year", "99. Luftballons", "3) Third item"]) {
      assert.equal(buildTodoistCreatePlan({ content: title }).payload.content, title);
    }

    assert.equal(buildTodoistCreatePlan({ content: "- Call dad" }).payload.content, "Call dad");
    assert.equal(buildTodoistCreatePlan({ content: "***Important***" }).payload.content, "Important");
  });

  it("does not let an inner fence with an info string end a code block", () => {
    const description = "```markdown\n```js\n -  bullet   \n\n\ntext   \n```";

    assert.equal(normalizeTodoistDescription(description), description);
  });

  it("never re-nests a uniformly indented list by flattening only its first item", () => {
    for (const list of [
      "  1. Buy milk\n  2. Buy oats\n  3. Buy bread",
      "  - a\n  - b\n  - c",
      "    - name: foo\n    - name: bar",
    ]) {
      assert.equal(normalizeTodoistDescription(list), list);
    }

    assert.equal(
      normalizeTodoistDescription("- Top item\n  - Nested item"),
      "- Top item\n  - Nested item",
    );
  });

  it("keeps an indented list unchanged through formatting-only exact updates", () => {
    const stored = "  1. Buy milk\n  2. Buy oats\n  3. Buy bread";

    assert.equal(cleanupTodoistDescriptionFormatting(stored), stored);
  });

  it("rejects a non-string title instead of stringifying it", () => {
    assert.throws(
      () => buildTodoistCreatePlan({ content: { a: 1 } }),
      /content must be a string/,
    );
    assert.throws(
      () => buildTodoistCreatePlan({ content: ["x", "y"] }),
      /content must be a string/,
    );
  });
});

describe("Todoist duplicate guard", () => {
  /** Shaped like the real API response: due is an object or null. */
  function openTask(content, due = null, extra = {}) {
    return {
      id: extra.id ?? "task-" + content.length,
      content,
      description: "",
      due,
      deadline: null,
      labels: [],
      priority: 1,
      project_id: "project-1",
      section_id: null,
      checked: false,
      is_deleted: false,
      ...extra,
    };
  }

  function due(string, date, isRecurring = false) {
    return { date, string, lang: "en", is_recurring: isRecurring, timezone: null };
  }

  const payload = (content, dueString) => {
    const built = { content };
    if (dueString) built.due_string = dueString;
    return built;
  };

  it("finds nothing when no open task shares the title", () => {
    const result = findTodoistDuplicates(payload("Call dad"), [
      openTask("Buy oats"),
      openTask("Call mum"),
    ]);

    assert.equal(result.status, "none");
    assert.deepEqual(result.matches, []);
  });

  it("treats a case-only difference as the same title", () => {
    assert.equal(findTodoistDuplicates(payload("call DAD"), [openTask("Call dad")]).status, "duplicate");
  });

  it("treats a whitespace-only difference as the same title", () => {
    assert.equal(
      findTodoistDuplicates(payload("  Call   dad "), [openTask("Call dad")]).status,
      "duplicate",
    );
  });

  it("keeps a punctuation difference distinct, because it can change meaning", () => {
    for (const existing of ["Call dad?", "Call dad!", "Call dad."]) {
      assert.equal(
        findTodoistDuplicates(payload("Call dad"), [openTask(existing)]).status,
        "none",
        existing,
      );
    }
  });

  it("ignores completed and deleted tasks", () => {
    const result = findTodoistDuplicates(payload("Call dad"), [
      openTask("Call dad", null, { checked: true, id: "done" }),
      openTask("Call dad", null, { is_deleted: true, id: "gone" }),
    ]);

    assert.equal(result.status, "none");
  });

  describe("due date semantics", () => {
    it("same title and same due text is a duplicate", () => {
      const result = findTodoistDuplicates(
        payload("Call dad", "tomorrow"),
        [openTask("Call dad", due("tomorrow", "2026-09-21"))],
      );

      assert.equal(result.status, "duplicate");
      assert.equal(result.matches[0].dueComparison, "same");
      assert.equal(result.matches[0].dueDate, "2026-09-21");
      assert.equal(result.matches[0].dueString, "tomorrow");
    });

    it("same title and neither has a due date is a duplicate", () => {
      const result = findTodoistDuplicates(payload("Call dad"), [openTask("Call dad", null)]);

      assert.equal(result.status, "duplicate");
      assert.equal(result.matches[0].dueComparison, "same");
      assert.equal(result.matches[0].dueDate, null);
    });

    it("same title with one due date missing is uncertain, not a duplicate", () => {
      const requestHasDue = findTodoistDuplicates(
        payload("Call dad", "tomorrow"),
        [openTask("Call dad", null)],
      );
      const existingHasDue = findTodoistDuplicates(
        payload("Call dad"),
        [openTask("Call dad", due("friday", "2026-09-25"))],
      );

      assert.equal(requestHasDue.status, "uncertain");
      assert.equal(existingHasDue.status, "uncertain");
    });

    it("same title with clearly different due text is uncertain, not a duplicate", () => {
      const result = findTodoistDuplicates(
        payload("Call dad", "tomorrow"),
        [openTask("Call dad", due("next monday", "2026-09-28"))],
      );

      assert.equal(result.status, "uncertain");
      assert.equal(result.matches[0].dueComparison, "due_text_differs");
    });

    it("never resolves natural language into a date comparison", () => {
      // "tomorrow" and the date it resolves to are not treated as equal, because
      // the harness must not invent date equivalence.
      const result = findTodoistDuplicates(
        payload("Call dad", "tomorrow"),
        [openTask("Call dad", due("2026-09-21", "2026-09-21"))],
      );

      assert.equal(result.status, "uncertain");
    });

    it("does not treat a request carrying a deadline as plainly matching", () => {
      const result = findTodoistDuplicates(
        { content: "Call dad", deadline_date: "2026-09-30" },
        [openTask("Call dad", null)],
      );

      assert.equal(result.status, "uncertain");
    });
  });

  describe("recurring tasks", () => {
    it("does not let a recurring task block a one-off request with the same title", () => {
      const result = findTodoistDuplicates(
        payload("Water the plants", "tomorrow"),
        [openTask("Water the plants", due("every day", "2026-09-21", true))],
      );

      assert.equal(result.status, "uncertain");
      assert.equal(result.matches[0].recurring, true);
    });

    it("does not let a recurring task block a request with no due date", () => {
      const result = findTodoistDuplicates(
        payload("Water the plants"),
        [openTask("Water the plants", due("every day", "2026-09-21", true))],
      );

      assert.equal(result.status, "uncertain");
    });

    it("treats an identical recurring request as a duplicate", () => {
      const result = findTodoistDuplicates(
        payload("Water the plants", "every day"),
        [openTask("Water the plants", due("every day", "2026-09-21", true))],
      );

      assert.equal(result.status, "duplicate");
    });
  });

  it("reports every match when several tasks share the title", () => {
    const result = findTodoistDuplicates(payload("Call dad"), [
      openTask("Call dad", null, { id: "a" }),
      openTask("call dad", null, { id: "b" }),
    ]);

    assert.equal(result.status, "duplicate");
    assert.equal(result.matches.length, 2);
    assert.deepEqual(result.matches.map((match) => match.id), ["a", "b"]);
    assert.match(describeDuplicateOutcome(result), /2 matching Todoist tasks already exist/);
  });

  it("describes each outcome in one concise sentence, naming the real cause", () => {
    assert.match(
      describeDuplicateOutcome({ status: "duplicate", matches: [{}] }),
      /already exists, so nothing was created/,
    );

    const causes = {
      due_text_differs: /its due date differs/,
      request_due_missing: /existing task has a due date and this request does not/,
      existing_due_missing: /this request has a due date and the existing task does not/,
      deadline_unsupported: /carries a deadline, which cannot be compared/,
      recurring_existing: /existing task recurs, so the timing may not overlap/,
    };

    for (const [dueComparison, pattern] of Object.entries(causes)) {
      const message = describeDuplicateOutcome({
        status: "uncertain",
        matches: [{ dueComparison }],
      });

      assert.match(message, pattern, dueComparison);
      assert.match(message, /Confirm whether you want another one/);
    }

    // A deadline mismatch must not be described as a due-date difference.
    assert.doesNotMatch(
      describeDuplicateOutcome({ status: "uncertain", matches: [{ dueComparison: "deadline_unsupported" }] }),
      /due date differs/,
    );
  });
});

describe("Todoist duplicate guard through the CLI", () => {
  const args = ["add", "--content", "Call dad"];

  function clientWith(openTasks, calls, response = { id: "new", content: "Call dad" }) {
    return recordingClient(calls, response, openTasks);
  }

  function existing(content, due = null, id = "existing-1") {
    return { id, content, due, checked: false, is_deleted: false, project_id: "p1", labels: [] };
  }

  it("reads before it writes, and creates when nothing matches", async () => {
    const calls = [];
    const result = await runTodoistCli(args, { client: clientWith([existing("Buy oats")], calls) });

    assert.equal(calls[0].method, "GET", "the duplicate check must happen first");
    assert.equal(calls[1].method, "POST", "the create must come second");
    assert.equal(result.duplicateCheck.status, "none");
    assert.equal(result.task.id, "new");
    assert.match(result.confirmation, /^Created the Todoist task/);
  });

  it("does not post when an exact duplicate exists", async () => {
    const calls = [];
    const result = await runTodoistCli(args, { client: clientWith([existing("Call dad")], calls) });

    assert.deepEqual(postCalls(calls), [], "no task may be created");
    assert.equal(result.mode, "clarify");
    assert.equal(result.task, null);
    assert.match(result.reason, /already exists, so nothing was created/);
    assert.equal(result.matches[0].id, "existing-1");
    assert.equal(result.matches[0].content, "Call dad");
  });

  it("does not post when several duplicates exist, and names them all", async () => {
    const calls = [];
    const result = await runTodoistCli(args, {
      client: clientWith([existing("Call dad", null, "a"), existing("CALL DAD", null, "b")], calls),
    });

    assert.deepEqual(postCalls(calls), []);
    assert.deepEqual(result.matches.map((match) => match.id), ["a", "b"]);
  });

  it("does not post when the due comparison is uncertain", async () => {
    const calls = [];
    const result = await runTodoistCli(["add", "--content", "Call dad", "--due", "tomorrow"], {
      client: clientWith(
        [existing("Call dad", { date: "2026-09-28", string: "next monday", is_recurring: false })],
        calls,
      ),
    });

    assert.deepEqual(postCalls(calls), []);
    assert.equal(result.duplicateCheck.status, "uncertain");
    assert.match(result.reason, /Confirm whether you want another one/);
  });

  it("never touches an existing task while handling a duplicate", async () => {
    const forbidden = [];
    const client = {
      async getTasks() { return [existing("Call dad")]; },
      async addTask() { forbidden.push("addTask"); return {}; },
      async updateTask() { forbidden.push("updateTask"); return {}; },
      async closeTask() { forbidden.push("closeTask"); return true; },
      async reopenTask() { forbidden.push("reopenTask"); return true; },
      async deleteTask() { forbidden.push("deleteTask"); return true; },
    };

    const result = await runTodoistCli(args, { client });

    assert.deepEqual(forbidden, [], "duplicate handling must not write anything");
    assert.equal(result.mode, "clarify");
  });

  it("fails closed when the duplicate-check read fails", async () => {
    const calls = [];
    const client = {
      async getTasks() { throw new Error("Todoist API request failed: 503"); },
      async addTask() { calls.push("addTask"); return {}; },
    };

    const result = await runTodoistCli(args, { client });

    assert.deepEqual(calls, [], "a failed read must never become a create");
    assert.equal(result.duplicateCheck.status, "read_failed");
    assert.equal(result.mode, "clarify");
    assert.match(result.reason, /Could not check for existing Todoist tasks, so nothing was created/);
    assert.doesNotMatch(result.reason, /No matching/);
  });

  it("reports a duplicate on a dry run without posting", async () => {
    const calls = [];
    const result = await runTodoistCli([...args, "--dry-run"], {
      client: clientWith([existing("Call dad")], calls),
    });

    assert.deepEqual(postCalls(calls), []);
    assert.equal(result.dryRun, true);
    assert.equal(result.duplicateCheck.status, "duplicate");
    assert.match(result.reason, /already exists/);
  });

  it("says plainly when a dry run could not check for duplicates", async () => {
    const result = await runTodoistCli([...args, "--dry-run"], { env: {} });

    assert.equal(result.dryRun, true);
    assert.equal(result.duplicateCheck.status, "unchecked");
    assert.match(result.confirmation, /Duplicate check not performed in dry-run mode\./);
    assert.doesNotMatch(result.confirmation, /No matching open task was found/);
  });

  it("sends a fresh request id per create, which cannot dedupe across requests", async () => {
    const seen = [];
    const client = {
      async getTasks() { return []; },
      async addTask(_payload, options) { seen.push(options.requestId); return { id: "x" }; },
    };

    await runTodoistCli(args, { client });
    await runTodoistCli(args, { client });

    assert.equal(seen.length, 2);
    assert.notEqual(seen[0], seen[1], "request ids are per call, so they are not a duplicate defence");
  });
});

describe("duplicate status in the readable preview", () => {
  const plan = { command: "add", payload: { content: "Call dad" }, descriptionLines: [], adjustments: [], warnings: [], confirmation: "c" };

  it("says when no matching task was found", () => {
    const text = formatTodoistTaskPlan({ ...plan, duplicateCheck: { status: "none", matches: [] } }, { dryRun: true });
    assert.match(text, /- Duplicate check: no matching open task found/);
  });

  it("says when the check was not performed, never that it passed", () => {
    const text = formatTodoistTaskPlan({ ...plan, duplicateCheck: { status: "unchecked", matches: [] } }, { dryRun: true });
    assert.match(text, /- Duplicate check: not performed in dry-run mode/);
    assert.doesNotMatch(text, /no matching open task found/);
  });

  it("says when the check failed, never that it passed", () => {
    const text = formatTodoistTaskPlan({ ...plan, duplicateCheck: { status: "read_failed", matches: [] } }, { dryRun: true });
    assert.match(text, /could not be performed, so nothing was created/);
    assert.doesNotMatch(text, /no matching open task found/);
  });

  it("names the matched tasks", () => {
    const text = formatTodoistTaskPlan({
      ...plan,
      duplicateCheck: { status: "duplicate", matches: [{ id: "a", content: "Call dad", dueString: "tomorrow" }] },
    }, { dryRun: true });

    assert.match(text, /matched 1 existing task: Call dad \(due tomorrow\)/);
  });

  it("distinguishes an uncertain due-date match", () => {
    const text = formatTodoistTaskPlan({
      ...plan,
      duplicateCheck: { status: "uncertain", matches: [{ id: "a", content: "Call dad", dueString: "friday" }] },
    }, { dryRun: true });

    assert.match(text, /different due date: Call dad \(due friday\)/);
  });

  it("omits the line entirely when there was no check to report", () => {
    assert.doesNotMatch(formatTodoistTaskPlan(plan, { dryRun: true }), /Duplicate check/);
  });
});

describe("duplicate guard fails closed on bad reads and finished tasks", () => {
  const args = ["add", "--content", "Call dad"];

  it("ignores a completed task whichever completion field the API uses", () => {
    for (const finished of [
      { checked: true },
      { is_completed: true },
      { completed_at: "2026-09-19T10:00:00Z" },
      { is_deleted: true },
    ]) {
      const result = findTodoistDuplicates({ content: "Call dad" }, [
        { id: "x", content: "Call dad", due: null, ...finished },
      ]);

      assert.equal(result.status, "none", JSON.stringify(finished));
    }
  });

  it("still matches an open task that carries the completion fields as false", () => {
    const result = findTodoistDuplicates({ content: "Call dad" }, [
      { id: "x", content: "Call dad", due: null, checked: false, is_completed: false, completed_at: null },
    ]);

    assert.equal(result.status, "duplicate");
  });

  it("refuses to judge a read that is not a list of tasks", () => {
    for (const bad of [undefined, null, {}, { results: [] }, "tasks", 7]) {
      assert.throws(
        () => findTodoistDuplicates({ content: "Call dad" }, bad),
        /needs a list of tasks/,
        JSON.stringify(bad) ?? "undefined",
      );
    }
  });

  it("treats a malformed read as a failed check and never creates", async () => {
    for (const malformed of [undefined, null, { unexpected: true }]) {
      const posted = [];
      const client = {
        async getTasks() { return malformed; },
        async addTask() { posted.push("addTask"); return { id: "x" }; },
      };

      const result = await runTodoistCli(args, { client });

      assert.deepEqual(posted, [], "a malformed read must never become a create");
      assert.equal(result.duplicateCheck.status, "read_failed");
      assert.equal(result.mode, "clarify");
      assert.match(result.reason, /Could not check for existing Todoist tasks/);
    }
  });

  it("reports a malformed read as unusable in the readable preview", async () => {
    const result = await runTodoistCli([...args, "--dry-run"], {
      client: { async getTasks() { return null; } },
    });

    const text = formatTodoistTaskPlan(result, { dryRun: true });
    assert.match(text, /could not be performed, so nothing was created/);
    assert.doesNotMatch(text, /no matching open task found/);
  });
});

describe("unreadable entries and honest uncertainty reasons", () => {
  const args = ["add", "--content", "Call dad"];

  it("does not claim no duplicate when part of the list was unreadable", () => {
    for (const bad of [null, {}, "task", 7, []]) {
      const result = findTodoistDuplicates({ content: "Call dad" }, [
        { id: "a", content: "Buy oats", due: null },
        bad,
      ]);

      assert.equal(result.status, "uncertain", JSON.stringify(bad));
      assert.equal(result.unreadableEntries, 1);
      assert.deepEqual(result.matches, []);
      assert.match(describeDuplicateOutcome(result), /could not be read \(1 unreadable entry\)/);
    }
  });

  it("does not create when part of the list was unreadable", async () => {
    const posted = [];
    const client = {
      async getTasks() { return [{ id: "a", content: "Buy oats", due: null }, null]; },
      async addTask() { posted.push("addTask"); return { id: "x" }; },
    };

    const result = await runTodoistCli(args, { client });

    assert.deepEqual(posted, []);
    assert.equal(result.mode, "clarify");
    assert.match(result.reason, /could not be read/);
  });

  it("still reports a clean none for a fully readable list", () => {
    const result = findTodoistDuplicates({ content: "Call dad" }, [
      { id: "a", content: "Buy oats", due: null },
    ]);

    assert.equal(result.status, "none");
    assert.equal(result.unreadableEntries, 0);
  });

  it("still reports a clear duplicate even alongside an unreadable entry", () => {
    const result = findTodoistDuplicates({ content: "Call dad" }, [
      { id: "a", content: "Call dad", due: null },
      null,
    ]);

    assert.equal(result.status, "duplicate");
    assert.equal(result.matches.length, 1);
  });

  it("names a recurring mismatch as recurrence, not as a due-date difference", () => {
    const result = findTodoistDuplicates(
      { content: "Water the plants", due_string: "tomorrow" },
      [{ id: "r", content: "Water the plants", due: { date: "2026-09-21", string: "every day", is_recurring: true } }],
    );

    assert.equal(result.matches[0].dueComparison, "recurring_existing");
    assert.match(describeDuplicateOutcome(result), /recurs, so the timing may not overlap/);
  });

  it("names a deadline as the cause rather than blaming the due date", async () => {
    const result = await runTodoistCli(
      ["add", "--task-json", '{"content":"Call dad","deadlineDate":"2026-09-30"}'],
      { client: { async getTasks() { return [{ id: "a", content: "Call dad", due: null }]; } } },
    );

    assert.equal(result.duplicateCheck.status, "uncertain");
    assert.match(result.reason, /carries a deadline, which cannot be compared/);
    assert.doesNotMatch(result.reason, /due date differs/);
  });
});

describe("Todoist project and section targeting by name", () => {
  const projects = [
    { id: "p-work", name: "Work" },
    { id: "p-ai", name: "AI project" },
    { id: "p-old", name: "Retired", is_archived: true },
    { id: "p-gone", name: "Removed", is_deleted: true },
  ];
  const sections = [
    { id: "s-work-iv", name: "Interviews", project_id: "p-work" },
    { id: "s-ai-iv", name: "Interviews", project_id: "p-ai" },
    { id: "s-work-bl", name: "Backlog", project_id: "p-work" },
    { id: "s-old", name: "Old", project_id: "p-work", is_archived: true },
  ];

  it("resolves an exact project name, ignoring case and spacing", () => {
    for (const name of ["Work", "work", "  WORK  ", "AI   project"]) {
      const result = resolveTodoistProject(name, projects);
      assert.equal(result.status, "resolved", name);
    }

    assert.equal(resolveTodoistProject("work", projects).projectId, "p-work");
    assert.equal(resolveTodoistProject("ai project", projects).projectId, "p-ai");
  });

  it("clarifies rather than falling back when a project name matches nothing", () => {
    const result = resolveTodoistProject("Wrok", projects);

    assert.equal(result.status, "clarify");
    assert.match(result.reason, /No Todoist project is named "Wrok"/);
    assert.ok(!("projectId" in result), "no project may be chosen");
    assert.doesNotMatch(result.reason, /inbox/i);
  });

  it("does not match an archived or deleted project", () => {
    assert.equal(resolveTodoistProject("Retired", projects).status, "clarify");
    assert.equal(resolveTodoistProject("Removed", projects).status, "clarify");
  });

  it("clarifies and lists the candidates when a project name is ambiguous", () => {
    const result = resolveTodoistProject("Work", [
      { id: "a", name: "Work" },
      { id: "b", name: "work" },
    ]);

    assert.equal(result.status, "clarify");
    assert.deepEqual(result.matches, [
      { id: "a", name: "Work" },
      { id: "b", name: "work" },
    ]);
  });

  it("resolves a section only within the project in hand", () => {
    const inWork = resolveTodoistSection("interviews", sections, { projectId: "p-work" });
    const inAi = resolveTodoistSection("Interviews", sections, { projectId: "p-ai" });

    assert.equal(inWork.sectionId, "s-work-iv");
    assert.equal(inAi.sectionId, "s-ai-iv");
    assert.equal(inAi.projectId, "p-ai");
  });

  it("never silently picks a same-named section from another project", () => {
    const result = resolveTodoistSection("Interviews", sections);

    assert.equal(result.status, "clarify");
    assert.match(result.reason, /Say which project it is in/);
    assert.deepEqual(result.matches.map((match) => match.projectId), ["p-work", "p-ai"]);
  });

  it("clarifies when a section name is absent from the named project", () => {
    const result = resolveTodoistSection("Backlog", sections, { projectId: "p-ai" });

    assert.equal(result.status, "clarify");
    assert.match(result.reason, /in that project/);
  });

  it("refuses to resolve against something that is not a list", () => {
    assert.throws(() => resolveTodoistProject("Work", null), /must be a list/);
    assert.throws(() => resolveTodoistSection("Interviews", undefined), /must be a list/);
  });

  it("requires a name", () => {
    assert.match(resolveTodoistProject("  ", projects).reason, /project name is required/);
    assert.match(resolveTodoistSection("", sections).reason, /section name is required/);
  });
});

describe("name targeting through the CLI", () => {
  function namedClient(calls, openTasks = []) {
    return {
      async getProjects() { calls.push(["getProjects"]); return [{ id: "p-work", name: "Work" }, { id: "p-ai", name: "AI project" }]; },
      async getSections(options) { calls.push(["getSections", options?.projectId ?? null]); return [
        { id: "s-work-iv", name: "Interviews", project_id: "p-work" },
        { id: "s-ai-iv", name: "Interviews", project_id: "p-ai" },
      ]; },
      async getTasks() { calls.push(["getTasks"]); return openTasks; },
      async addTask(payload, options) { calls.push(["addTask", payload, options?.requestId ? "has-request-id" : "none"]); return { id: "new" }; },
    };
  }

  it("resolves names to ids and sends only ids, in the right order", async () => {
    const calls = [];
    const result = await runTodoistCli(
      ["add", "--content", "Ask about pricing", "--project", "work", "--section", "interviews"],
      { client: namedClient(calls) },
    );

    assert.deepEqual(calls.map((call) => call[0]), ["getProjects", "getSections", "getTasks", "addTask"]);
    assert.equal(calls[1][1], "p-work", "sections must be read scoped to the resolved project");

    const posted = calls.find((call) => call[0] === "addTask")[1];
    assert.equal(posted.project_id, "p-work");
    assert.equal(posted.section_id, "s-work-iv");
    assert.ok(!("projectName" in posted) && !("sectionName" in posted), "names must not reach the API");
    assert.equal(result.task.id, "new");
  });

  it("keeps working with raw ids", async () => {
    const calls = [];
    await runTodoistCli(
      ["add", "--content", "Buy oats", "--project-id", "p-raw", "--section-id", "s-raw"],
      { client: namedClient(calls) },
    );

    assert.deepEqual(calls.map((call) => call[0]), ["getTasks", "addTask"]);
    const posted = calls.find((call) => call[0] === "addTask")[1];
    assert.equal(posted.project_id, "p-raw");
    assert.equal(posted.section_id, "s-raw");
  });

  it("does not create when a named project matches nothing", async () => {
    const calls = [];
    const result = await runTodoistCli(
      ["add", "--content", "Buy oats", "--project", "Nowhere"],
      { client: namedClient(calls) },
    );

    assert.deepEqual(calls.map((call) => call[0]), ["getProjects"]);
    assert.equal(result.mode, "clarify");
    assert.match(result.reason, /No Todoist project is named "Nowhere"/);
    assert.equal(result.task, null);
  });

  it("does not create when a section name is ambiguous across projects", async () => {
    const calls = [];
    const result = await runTodoistCli(
      ["add", "--content", "Buy oats", "--section", "Interviews"],
      { client: namedClient(calls) },
    );

    assert.deepEqual(calls.map((call) => call[0]), ["getSections", "getProjects"]);
    assert.equal(calls[0][1], null, "an unscoped section read looks across projects");
    assert.equal(result.mode, "clarify");
    assert.equal(result.matches.length, 2);
    assert.deepEqual(
      result.matches.map((match) => match.projectName).sort(),
      ["AI project", "Work"],
      "asking which project it is in has to name the projects",
    );
  });

  it("does not read projects to resolve a section that is not ambiguous", async () => {
    const calls = [];
    const result = await runTodoistCli(
      ["add", "--content", "Buy oats", "--section", "Nowhere"],
      { client: namedClient(calls) },
    );

    assert.deepEqual(calls.map((call) => call[0]), ["getSections"]);
    assert.equal(result.mode, "clarify");
    assert.equal(result.matches.length, 0);
  });

  it("runs the duplicate guard against the name-resolved destination", async () => {
    const calls = [];
    const result = await runTodoistCli(
      ["add", "--content", "Ask about pricing", "--project", "work"],
      { client: namedClient(calls, [{ id: "dup", content: "Ask about pricing", due: null }]) },
    );

    assert.deepEqual(calls.map((call) => call[0]), ["getProjects", "getTasks"]);
    assert.equal(result.duplicateCheck.status, "duplicate");
    assert.equal(result.task, null);
  });

  it("shows the resolved destination on a dry run without creating", async () => {
    const calls = [];
    const result = await runTodoistCli(
      ["add", "--content", "Ask about pricing", "--project", "AI project", "--dry-run"],
      { client: namedClient(calls) },
    );

    assert.ok(!calls.some((call) => call[0] === "addTask"), "a dry run must not create");
    assert.equal(result.payload.project_id, "p-ai");
    assert.equal(result.dryRun, true);
  });

  it("refuses a dry run with a named destination it cannot resolve", async () => {
    const result = await runTodoistCli(
      ["add", "--content", "Ask about pricing", "--project", "Work", "--dry-run"],
      { env: {} },
    );

    assert.equal(result.mode, "clarify");
    assert.equal(result.task, null);
    assert.equal(result.dryRun, true);
    assert.match(result.reason, /named project "Work" cannot be resolved without Todoist access/);
    assert.equal(
      result.payload.project_id,
      undefined,
      "a preview must not silently drop the destination and show an Inbox task",
    );
    assert.equal(result.confirmation, null, "nothing may read as a successful preview");
  });

  it("names both destinations when neither can be resolved on a dry run", async () => {
    const result = await runTodoistCli(
      [
        "add", "--content", "Ask about pricing",
        "--project", "Work", "--section", "Interviews", "--dry-run",
      ],
      { env: {} },
    );

    assert.equal(result.mode, "clarify");
    assert.match(result.reason, /project "Work" and section "Interviews"/);
  });

  it("still previews a dry run without a client when no destination was named", async () => {
    const result = await runTodoistCli(
      ["add", "--content", "Buy oats", "--dry-run"],
      { env: {} },
    );

    assert.equal(result.dryRun, true);
    assert.notEqual(result.mode, "clarify");
    assert.equal(result.duplicateCheck.status, "unchecked");
  });

  it("asks rather than using the Inbox when a named destination is left blank", async () => {
    const calls = [];
    const result = await runTodoistCli(
      ["add", "--content", "Buy oats", "--project", ""],
      { client: namedClient(calls) },
    );

    assert.ok(!calls.some((call) => call[0] === "addTask"), "a blank name must not create");
    assert.equal(result.mode, "clarify");
    assert.match(result.reason, /A project name is required/);
    assert.equal(result.payload.project_id, undefined);
  });

  it("asks when a blank section name is given", async () => {
    const calls = [];
    const result = await runTodoistCli(
      ["add", "--content", "Buy oats", "--section", "   "],
      { client: namedClient(calls) },
    );

    assert.ok(!calls.some((call) => call[0] === "addTask"), "a blank name must not create");
    assert.equal(result.mode, "clarify");
    assert.match(result.reason, /A section name is required/);
  });

  it("blames a blank name on the name, not on missing Todoist access", async () => {
    const result = await runTodoistCli(
      ["add", "--content", "Buy oats", "--project", "", "--dry-run"],
      { env: {} },
    );

    assert.equal(result.mode, "clarify");
    assert.match(result.reason, /A project name is required/);
    assert.doesNotMatch(result.reason, /without Todoist access/);
  });

  it("never creates in the Inbox when the matching project has no usable id", async () => {
    const calls = [];
    const client = {
      async getProjects() { calls.push(["getProjects"]); return [{ name: "Work" }]; },
      async getSections() { calls.push(["getSections"]); return []; },
      async getTasks() { calls.push(["getTasks"]); return []; },
      async addTask(payload) { calls.push(["addTask", payload]); return { id: "new" }; },
    };

    const result = await runTodoistCli(
      ["add", "--content", "Buy oats", "--project", "Work"],
      { client },
    );

    assert.ok(!calls.some((call) => call[0] === "addTask"), "an unusable id must not create");
    assert.equal(result.mode, "clarify");
    assert.match(result.reason, /has no usable id/);
  });

  it("never creates in the Inbox when the matching section has no usable id", async () => {
    const calls = [];
    const client = {
      async getProjects() { calls.push(["getProjects"]); return [{ id: "p-work", name: "Work" }]; },
      async getSections() { calls.push(["getSections"]); return [{ name: "Interviews", project_id: "p-work" }]; },
      async getTasks() { calls.push(["getTasks"]); return []; },
      async addTask(payload) { calls.push(["addTask", payload]); return { id: "new" }; },
    };

    const result = await runTodoistCli(
      ["add", "--content", "Buy oats", "--project", "Work", "--section", "Interviews"],
      { client },
    );

    assert.ok(!calls.some((call) => call[0] === "addTask"), "an unusable id must not create");
    assert.equal(result.mode, "clarify");
    assert.match(result.reason, /has no usable id/);
  });

  it("still says no such project when nothing carries the name", async () => {
    const result = await runTodoistCli(
      ["add", "--content", "Buy oats", "--project", "Nowhere"],
      { client: namedClient([]) },
    );

    assert.equal(result.mode, "clarify");
    assert.match(result.reason, /No Todoist project is named "Nowhere"/);
  });

  it("refuses a name and a raw id for the same destination", async () => {
    await assert.rejects(
      runTodoistCli(
        ["add", "--content", "Buy oats", "--project", "Work", "--project-id", "p-other"],
        { client: namedClient([]) },
      ),
      /Use either --project or --project-id, not both/,
    );

    await assert.rejects(
      runTodoistCli(
        ["add", "--content", "Buy oats", "--section", "Interviews", "--section-id", "s-other"],
        { client: namedClient([]) },
      ),
      /Use either --section or --section-id, not both/,
    );
  });

  it("still scopes a named section with a raw project id", async () => {
    const calls = [];
    const result = await runTodoistCli(
      ["add", "--content", "Ask about pricing", "--section", "Interviews", "--project-id", "p-ai"],
      { client: namedClient(calls) },
    );

    assert.equal(calls[0][0], "getSections");
    assert.equal(calls[0][1], "p-ai", "the raw project id must scope the section read");
    const posted = calls.find((call) => call[0] === "addTask")[1];
    assert.equal(posted.section_id, "s-ai-iv");
    assert.equal(posted.project_id, "p-ai");
    assert.equal(result.task.id, "new");
  });

  it("creates, renames, moves or deletes no project or section", async () => {
    const forbidden = [];
    const client = {
      async getProjects() { return [{ id: "p-work", name: "Work" }]; },
      async getSections() { return []; },
      async getTasks() { return []; },
      async addTask() { return { id: "new" }; },
      async addProject() { forbidden.push("addProject"); },
      async updateProject() { forbidden.push("updateProject"); },
      async deleteProject() { forbidden.push("deleteProject"); },
      async addSection() { forbidden.push("addSection"); },
      async deleteSection() { forbidden.push("deleteSection"); },
    };

    await runTodoistCli(["add", "--content", "Buy oats", "--project", "Work"], { client });

    assert.deepEqual(forbidden, []);
  });
});

describe("Todoist comments", () => {
  const task = { id: "task-1", content: "Prepare meeting", description: "" };

  function commentClient(calls, response = { id: "c1" }) {
    return {
      async getTask(taskId) { calls.push(["getTask", taskId]); return task; },
      async getTasks() { calls.push(["getTasks"]); return [task]; },
      async addComment(input, options) {
        calls.push(["addComment", input, options?.requestId ? "has-request-id" : "none"]);
        return response;
      },
      async updateTask() { calls.push(["updateTask"]); return {}; },
      async closeTask() { calls.push(["closeTask"]); return true; },
      async deleteTask() { calls.push(["deleteTask"]); return true; },
    };
  }

  it("appends one comment to one exact task", async () => {
    const calls = [];
    const result = await runTodoistCli(
      ["exact-update", "--task-id", "task-1", "--action", "comment", "--detail", "waiting for Tobias"],
      { client: commentClient(calls) },
    );

    assert.deepEqual(calls.map((call) => call[0]), ["getTask", "addComment"]);
    assert.deepEqual(calls[1][1], { taskId: "task-1", content: "waiting for Tobias" });
    assert.equal(calls[1][2], "has-request-id");
    assert.equal(result.command, "comment");
    assert.equal(result.confirmation, "Added your comment to the Todoist task.");
  });

  it("writes nothing when the task target is ambiguous", async () => {
    const calls = [];
    const client = {
      async getTasks() { calls.push(["getTasks"]); return [
        { id: "a", content: "Prepare meeting" },
        { id: "b", content: "Prepare meeting" },
      ]; },
      async addComment() { calls.push(["addComment"]); return {}; },
    };

    const result = await runTodoistCli(
      ["exact-update", "--match-content", "Prepare meeting", "--action", "comment", "--detail", "ask Nina"],
      { client },
    );

    assert.deepEqual(calls.map((call) => call[0]), ["getTasks"]);
    assert.equal(result.status, "clarification_needed");
  });

  it("writes nothing when the comment text is missing", async () => {
    const calls = [];
    const result = await runTodoistCli(
      ["exact-update", "--task-id", "task-1", "--action", "comment", "--detail", "   "],
      { client: commentClient(calls) },
    );

    assert.deepEqual(calls.map((call) => call[0]), ["getTask"]);
    assert.equal(result.mode, "clarify");
    assert.match(result.reason, /needs the text to add/);
  });

  it("carries a multiline comment as real line breaks", async () => {
    const calls = [];
    const { Readable } = await import("node:stream");
    await runTodoistCli(
      ["exact-update", "--task-id", "task-1", "--action", "comment", "--detail-stdin"],
      { client: commentClient(calls), stdin: Readable.from(["Topics:\n- pricing\n- timing\n"]) },
    );

    const sent = calls.find((call) => call[0] === "addComment")[1].content;
    assert.equal(sent, "Topics:\n- pricing\n- timing");
    assert.ok(!sent.includes("\\n"));
  });

  it("carries apostrophes, quotes and backslashes through stdin untouched", async () => {
    const calls = [];
    const { Readable } = await import("node:stream");
    const text = "Don't forget: \"quoted\" and C:\\notes\\log.txt";
    await runTodoistCli(
      ["exact-update", "--task-id", "task-1", "--action", "comment", "--detail-stdin"],
      { client: commentClient(calls), stdin: Readable.from([text]) },
    );

    assert.equal(calls.find((call) => call[0] === "addComment")[1].content, text);
  });

  it("refuses an ambiguous escaped newline in the --detail argument", async () => {
    await assert.rejects(
      () => runTodoistCli(
        ["exact-update", "--task-id", "task-1", "--action", "comment", "--detail", "a\\nb"],
        { client: commentClient([]) },
      ),
      /--detail contains a literal/,
    );
  });

  it("refuses both detail routes at once, and empty stdin", async () => {
    assert.throws(
      () => parseTodoistArgs([
        "exact-update", "--task-id", "t", "--action", "comment", "--detail", "x", "--detail-stdin",
      ]),
      /Use either --detail or --detail-stdin, not both/,
    );

    const { Readable } = await import("node:stream");
    await assert.rejects(
      () => runTodoistCli(
        ["exact-update", "--task-id", "task-1", "--action", "comment", "--detail-stdin"],
        { client: commentClient([]), stdin: Readable.from(["   "]) },
      ),
      /received empty stdin/,
    );
  });

  it("previews a comment on a dry run without writing", async () => {
    const calls = [];
    const result = await runTodoistCli(
      ["exact-update", "--task-id", "task-1", "--action", "comment", "--detail", "waiting", "--dry-run"],
      { client: commentClient(calls) },
    );

    assert.deepEqual(calls.map((call) => call[0]), ["getTask"]);
    assert.equal(result.dryRun, true);
    assert.equal(result.command, "comment");
    assert.deepEqual(result.payload, { content: "waiting" });
  });

  it("surfaces an API failure instead of reporting success", async () => {
    const client = {
      async getTask() { return task; },
      async addComment() { throw new Error("Todoist API request failed: 500"); },
    };

    await assert.rejects(
      () => runTodoistCli(
        ["exact-update", "--task-id", "task-1", "--action", "comment", "--detail", "waiting"],
        { client },
      ),
      /Todoist API request failed: 500/,
    );
  });

  it("keeps the approval gates the exact-update path already applies", () => {
    for (const flag of ["sensitiveContent", "affectsOtherPeople", "inferredUpdateContent"]) {
      const plan = buildExactTodoistUpdatePlan(task, {
        action: "comment",
        detail: "waiting",
        [flag]: true,
      });

      assert.equal(plan.mode, "approval_required", flag);
      assert.equal(plan.payload, null);
    }
  });

  it("never edits, completes or deletes while commenting", async () => {
    const calls = [];
    await runTodoistCli(
      ["exact-update", "--task-id", "task-1", "--action", "comment", "--detail", "waiting"],
      { client: commentClient(calls) },
    );

    for (const forbidden of ["updateTask", "closeTask", "deleteTask"]) {
      assert.ok(!calls.some((call) => call[0] === forbidden), forbidden);
    }
  });

  it("builds the wire payload the comments endpoint expects", async () => {
    const wire = [];
    const client = createTodoistClient({
      token: "todoist-secret",
      fetchImpl: async (url, options) => {
        wire.push({ url, method: options.method, body: JSON.parse(options.body ?? "null"), headers: options.headers });
        return jsonResponse({ id: "c1" });
      },
    });

    await client.addComment({ taskId: "task-1", content: "waiting for Tobias" }, { requestId: "req-9" });

    assert.equal(wire[0].url, "https://api.todoist.com/api/v1/comments");
    assert.equal(wire[0].method, "POST");
    assert.deepEqual(wire[0].body, { task_id: "task-1", content: "waiting for Tobias" });
    assert.equal(wire[0].headers["X-Request-Id"], "req-9");
  });

  it("requires a task id and content at the client boundary", () => {
    const client = createTodoistClient({ token: "t", fetchImpl: async () => jsonResponse({}) });

    // Validation throws synchronously, matching every other client method.
    assert.throws(() => client.addComment({ taskId: "", content: "x" }), /task id is required/);
    assert.throws(() => client.addComment({ taskId: "t", content: "  " }), /comment content is required/);
    assert.throws(() => client.addComment({ taskId: "t", content: 42 }), /comment content is required/);
  });
});

describe("Todoist no-op updates", () => {
  const task = {
    id: "task-1",
    content: "Call dad",
    description: "Ring at 18:00",
    priority: 1,
    project_id: "p1",
    section_id: null,
    labels: ["home", "family"],
    due: { date: "2026-09-21", string: "tomorrow", lang: "en", is_recurring: false },
  };

  it("recognizes equality only where it is reliable", () => {
    assert.equal(detectTodoistNoop({ description: "Ring at 18:00" }, task).noop, true);
    assert.equal(detectTodoistNoop({ content: "Call dad" }, task).noop, true);
    assert.equal(detectTodoistNoop({ priority: 1 }, task).noop, true);
    assert.equal(detectTodoistNoop({ project_id: "p1" }, task).noop, true);
    assert.equal(detectTodoistNoop({ section_id: null }, task).noop, true);
    assert.equal(detectTodoistNoop({ labels: ["family", "home"] }, task).noop, true);
    assert.equal(detectTodoistNoop({ due_string: "Tomorrow" }, task).noop, true);
  });

  it("treats any real difference as a change", () => {
    assert.equal(detectTodoistNoop({ description: "Ring at 19:00" }, task).noop, false);
    assert.equal(detectTodoistNoop({ content: "Call mum" }, task).noop, false);
    assert.equal(detectTodoistNoop({ labels: ["home"] }, task).noop, false);
    assert.equal(detectTodoistNoop({ labels: ["home", "family", "urgent"] }, task).noop, false);
    assert.equal(detectTodoistNoop({ due_string: "friday" }, task).noop, false);
    assert.equal(detectTodoistNoop({ content: "Call dad", description: "new" }, task).noop, false);
  });

  it("never invents equivalence for a field it cannot compare", () => {
    const result = detectTodoistNoop({ deadline_date: "2026-09-30" }, task);

    assert.equal(result.noop, false);
    assert.deepEqual(result.undetermined, ["deadline_date"]);

    // One incomparable field is enough to send the update.
    const mixed = detectTodoistNoop({ content: "Call dad", deadline_date: "2026-09-30" }, task);
    assert.equal(mixed.noop, false);
  });

  it("does not resolve natural language into a date to claim equality", () => {
    assert.equal(detectTodoistNoop({ due_string: "2026-09-21" }, task).noop, false);
  });

  it("makes no claim without an existing task or without fields", () => {
    assert.equal(detectTodoistNoop({ content: "Call dad" }, null).noop, false);
    assert.equal(detectTodoistNoop({}, task).noop, false);
  });

  it("skips a formatting cleanup that would change nothing", () => {
    const clean = { id: "t", content: "AI video", description: "Line one\n\n- tidy bullet" };
    const messy = { id: "t", content: "AI video", description: "Line one\n\n\n-  messy bullet  " };

    const noop = buildExactTodoistUpdatePlan(clean, { action: "format-description" });
    const real = buildExactTodoistUpdatePlan(messy, { action: "format-description" });

    assert.equal(noop.mode, "no_change_needed");
    assert.equal(noop.payload, null);
    assert.equal(noop.command, null);
    assert.equal(noop.confirmation, "No Todoist change was needed.");
    assert.equal(real.mode, "execute_then_confirm");
  });

  it("still appends explicit detail, which always changes something", () => {
    const plan = buildExactTodoistUpdatePlan(
      { id: "t", content: "Warm up", description: "Warm up" },
      { action: "append-detail", detail: "Keep it easy" },
    );

    assert.equal(plan.mode, "execute_then_confirm");
  });

  it("does not call updateTask for a no-op exact update", async () => {
    const calls = [];
    const client = {
      async getTask(taskId) { calls.push(["getTask", taskId]); return { id: taskId, content: "AI video", description: "Line one" }; },
      async updateTask() { calls.push(["updateTask"]); return {}; },
    };

    const result = await runTodoistCli(
      ["exact-update", "--task-id", "task-1", "--action", "format-description"],
      { client },
    );

    assert.deepEqual(calls, [["getTask", "task-1"]], "no write may be attempted");
    assert.equal(result.mode, "no_change_needed");
    assert.equal(result.confirmation, "No Todoist change was needed.");
  });

  it("does not call updateTask for a no-op flag update", async () => {
    const calls = [];
    const client = {
      async getTask(taskId) { calls.push(["getTask", taskId]); return task; },
      async updateTask() { calls.push(["updateTask"]); return {}; },
    };

    const result = await runTodoistCli(
      ["update", "--task-id", "task-1", "--content", "Call dad"],
      { client },
    );

    assert.deepEqual(calls, [["getTask", "task-1"]]);
    assert.equal(result.mode, "no_change_needed");
    assert.equal(result.task, null);
    assert.equal(result.payload, null);
  });

  it("still calls updateTask when something really changes", async () => {
    const calls = [];
    const client = {
      async getTask() { return task; },
      async updateTask(taskId, payload) { calls.push([taskId, payload]); return { id: taskId }; },
    };

    const result = await runTodoistCli(
      ["update", "--task-id", "task-1", "--content", "Call mum"],
      { client },
    );

    assert.deepEqual(calls, [["task-1", { content: "Call mum" }]]);
    assert.equal(result.mode, "execute_then_confirm");
  });

  it("updates rather than skipping when the task cannot be read", async () => {
    const calls = [];
    const client = {
      async getTask() { throw new Error("Todoist API request failed: 503"); },
      async updateTask(taskId, payload) { calls.push([taskId, payload]); return { id: taskId }; },
    };

    const result = await runTodoistCli(
      ["update", "--task-id", "task-1", "--content", "Call dad"],
      { client },
    );

    assert.equal(calls.length, 1, "an unreadable task must not be treated as identical");
    assert.notEqual(result.mode, "no_change_needed");
  });

  it("reports a no-op on a dry run instead of previewing a write", async () => {
    const result = await runTodoistCli(
      ["update", "--task-id", "task-1", "--content", "Call dad", "--dry-run"],
      { client: { async getTask() { return task; }, async updateTask() { throw new Error("must not write"); } } },
    );

    assert.equal(result.mode, "no_change_needed");
    assert.equal(result.dryRun, true);
    assert.match(
      formatTodoistTaskPlan(result, { dryRun: true }),
      /^No Todoist change was needed\. Task task-1 already matches/,
    );
  });

  it("never treats a comment as a no-op, even when it repeats the task's own text", () => {
    // Comments are additive and go nowhere near executeUpdate. Routing them
    // through it would compare the comment against task.content and silently
    // swallow a comment that happens to repeat the title.
    const plan = buildExactTodoistUpdatePlan(
      { id: "task-1", content: "Call dad", description: "Call dad" },
      { action: "comment", detail: "Call dad" },
    );

    assert.equal(plan.mode, "execute_then_confirm");
    assert.equal(plan.command, "comment");
    assert.equal(plan.payload.content, "Call dad");
  });

  it("sends a rename that only changes case or spacing", () => {
    // Todoist stores and shows the title exactly as written, so a case or
    // spacing change is a real change. Matching semantics (comparableTaskTitle)
    // belong to finding a task, not to deciding whether a write does anything.
    assert.equal(
      detectTodoistNoop({ content: "call dad" }, { content: " Call  dad " }).noop,
      false,
    );
    assert.equal(detectTodoistNoop({ content: "Call dad" }, { content: "Call dad" }).noop, true);
  });

  it("will not call a due change equal to a stored due that carries no text", () => {
    const stored = { id: "t", due: { date: "2026-09-21" } };

    const result = detectTodoistNoop({ due_string: "tomorrow" }, stored);
    assert.equal(result.noop, false);
    assert.deepEqual(result.undetermined, ["due_string"]);

    // The same holds for a task with no due at all.
    assert.equal(detectTodoistNoop({ due_string: "tomorrow" }, { id: "t", due: null }).noop, false);

    // A stored due text that is present still compares normally.
    assert.equal(
      detectTodoistNoop({ due_string: "tomorrow" }, { id: "t", due: { string: "Tomorrow" } }).noop,
      true,
    );
  });

  it("keeps every other outcome distinguishable", () => {
    const messy = { id: "t", content: "AI video", description: "  messy  " };

    assert.equal(buildExactTodoistUpdatePlan(messy, { action: "format-description" }).mode, "execute_then_confirm");
    assert.equal(buildExactTodoistUpdatePlan(messy, { action: "delete" }).mode, "approval_required");
    assert.equal(buildExactTodoistUpdatePlan(messy, { action: "wording-description" }).mode, "clarify");
    assert.equal(buildExactTodoistUpdatePlan(messy, { action: "nonsense" }).mode, "clarify");
    assert.equal(
      buildExactTodoistUpdatePlan({ id: "t", content: "x", description: "" }, { action: "format-description" }).mode,
      "no_change_needed",
    );
  });
});
