import { describe, it } from "node:test";
import assert from "node:assert/strict";
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
import { parseTodoistArgs, runTodoistCli } from "../scripts/todoist.mjs";

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
        replacementDescription: "Warm up\nStrength",
      }).mode,
      "execute_then_confirm",
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
