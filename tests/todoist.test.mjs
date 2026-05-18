import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildTodoistTaskPayload,
  createTodoistClient,
  todoistTokenStatus,
} from "../scripts/lib/todoist.mjs";
import { parseTodoistArgs } from "../scripts/todoist.mjs";

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
  it("lists tasks using a bearer token and filter query", async () => {
    const calls = [];
    const client = createTodoistClient({
      token: "todoist-secret",
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return jsonResponse([{ id: "1", content: "Walk" }]);
      },
    });

    const tasks = await client.getTasks({ filter: "today" });

    assert.deepEqual(tasks, [{ id: "1", content: "Walk" }]);
    assert.equal(calls[0].url, "https://api.todoist.com/rest/v2/tasks?filter=today");
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
    assert.equal(calls[0].url, "https://api.todoist.com/rest/v2/tasks");
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
    assert.equal(calls[0].url, "https://api.todoist.com/rest/v2/tasks/task-1/close");
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
