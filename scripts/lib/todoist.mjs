export const TODOIST_API_BASE_URL = "https://api.todoist.com/api/v1";

const taskFieldMap = {
  dueString: "due_string",
  dueLang: "due_lang",
  projectId: "project_id",
  sectionId: "section_id",
  parentId: "parent_id",
  assigneeId: "assignee_id",
  deadlineDate: "deadline_date",
};

export function todoistTokenStatus(env = process.env) {
  return { configured: Boolean(env.TODOIST_API_TOKEN?.trim()) };
}

export function buildTodoistTaskPayload(input = {}, { requireContent = true } = {}) {
  if (requireContent && !input.content?.trim()) {
    throw new Error("Todoist task content is required.");
  }

  const payload = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null || value === "") continue;
    payload[taskFieldMap[key] ?? key] = value;
  }

  return payload;
}

export function createTodoistClient({
  token = process.env.TODOIST_API_TOKEN,
  fetchImpl = globalThis.fetch,
  baseUrl = TODOIST_API_BASE_URL,
} = {}) {
  if (!token?.trim()) {
    throw new Error("TODOIST_API_TOKEN is required for Todoist access.");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("A fetch implementation is required for Todoist access.");
  }

  async function request(path, { method = "GET", query, body, requestId } = {}) {
    const url = new URL(`${baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }

    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };

    const options = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }
    if (requestId) headers["X-Request-Id"] = requestId;

    const response = await fetchImpl(url.toString(), options);
    if (!response.ok) {
      const details = await response.text().catch(() => "");
      throw new Error(
        `Todoist API request failed: ${response.status}${details ? ` ${details}` : ""}`,
      );
    }

    if (response.status === 204) return true;
    return response.json();
  }

  return {
    async getProjects() {
      return normalizePaginatedResults(await request("/projects"));
    },
    async getTasks({ filter, projectId, sectionId, label } = {}) {
      const path = filter ? "/tasks/filter" : "/tasks";
      const query = filter
        ? { query: filter }
        : {
            project_id: projectId,
            section_id: sectionId,
            label,
          };

      return normalizePaginatedResults(await request(path, {
        query: {
          ...query,
        },
      }));
    },
    addTask(input, { requestId } = {}) {
      return request("/tasks", {
        method: "POST",
        body: buildTodoistTaskPayload(input),
        requestId,
      });
    },
    updateTask(taskId, input, { requestId } = {}) {
      requireTaskId(taskId);
      return request(`/tasks/${encodeURIComponent(taskId)}`, {
        method: "POST",
        body: buildTodoistTaskPayload(input, { requireContent: false }),
        requestId,
      });
    },
    closeTask(taskId) {
      requireTaskId(taskId);
      return request(`/tasks/${encodeURIComponent(taskId)}/close`, { method: "POST" });
    },
    reopenTask(taskId) {
      requireTaskId(taskId);
      return request(`/tasks/${encodeURIComponent(taskId)}/reopen`, { method: "POST" });
    },
    deleteTask(taskId) {
      requireTaskId(taskId);
      return request(`/tasks/${encodeURIComponent(taskId)}`, { method: "DELETE" });
    },
  };
}

function requireTaskId(taskId) {
  if (!taskId?.trim()) {
    throw new Error("Todoist task id is required.");
  }
}

function normalizePaginatedResults(response) {
  if (Array.isArray(response)) return response;
  if (Array.isArray(response?.results)) return response.results;
  return response;
}
