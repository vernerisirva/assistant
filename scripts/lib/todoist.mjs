export const TODOIST_API_BASE_URL = "https://api.todoist.com/api/v1";
/** Tasks per page; the API maximum. */
export const TODOIST_TASK_PAGE_LIMIT = 200;
/** A task list longer than this is refused rather than read partially. */
export const TODOIST_MAX_TASK_PAGES = 25;

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
    // An absent value is dropped. An empty description is kept, because it is a
    // real instruction to clear the field and dropping it would make a preview
    // promise a change the request never performs. No other field is clearable.
    if (value === undefined || value === null) continue;
    if (value === "" && key !== "description") continue;
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
    /**
     * Reads every page. The endpoint is cursor-paginated, and a duplicate
     * check that saw only the first page would miss most open tasks, so a list
     * that cannot be read completely fails instead of looking complete.
     */
    async getTasks({ filter, projectId, sectionId, label } = {}) {
      const path = filter ? "/tasks/filter" : "/tasks";
      const query = filter
        ? { query: filter }
        : {
            project_id: projectId,
            section_id: sectionId,
            label,
          };

      const tasks = [];
      let cursor = null;
      for (let page = 0; page < TODOIST_MAX_TASK_PAGES; page += 1) {
        const response = await request(path, {
          query: { ...query, limit: TODOIST_TASK_PAGE_LIMIT, cursor },
        });
        if (Array.isArray(response)) return [...tasks, ...response];
        if (!Array.isArray(response?.results)) {
          if (page === 0) return response;
          throw new Error("Todoist returned an unreadable page of tasks, so the task list is incomplete.");
        }
        tasks.push(...response.results);
        cursor = response.next_cursor;
        if (!cursor) return tasks;
      }
      throw new Error(
        `Todoist has more than ${TODOIST_MAX_TASK_PAGES * TODOIST_TASK_PAGE_LIMIT} matching tasks, so the list could not be read completely.`,
      );
    },
    async getSections({ projectId } = {}) {
      return normalizePaginatedResults(await request("/sections", {
        query: { project_id: projectId },
      }));
    },
    getTask(taskId) {
      requireTaskId(taskId);
      return request(`/tasks/${encodeURIComponent(taskId)}`);
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
    addComment({ taskId, content }, { requestId } = {}) {
      requireTaskId(taskId);
      if (typeof content !== "string" || content.trim() === "") {
        throw new Error("Todoist comment content is required.");
      }

      return request("/comments", {
        method: "POST",
        body: { task_id: taskId, content },
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
