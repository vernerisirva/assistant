/**
 * Resolving a Todoist project or section that the user named in words.
 *
 * "Add this to Work" has to become a project id before the create call, so the
 * API layer keeps taking ids only. Matching is exact apart from letter case and
 * repeated whitespace: no fuzzy matching and no model choice, because putting a
 * task in the wrong project is worse than asking which one was meant.
 *
 * A name that matches nothing is never quietly turned into the Inbox, and a
 * name that matches several things is never guessed. Both ask instead.
 */
import { comparableTaskTitle } from "./todoist-format.mjs";

export const targetStatuses = Object.freeze({
  resolved: "resolved",
  clarify: "clarify",
});

export function resolveTodoistProject(name, projects) {
  requireList(projects, "projects");
  const wanted = comparableTaskTitle(name ?? "");
  if (!wanted) return clarify("A project name is required.");

  const matches = live(projects).filter((project) => comparableTaskTitle(project.name ?? "") === wanted);

  if (matches.length === 0) {
    return clarify(`No Todoist project is named "${String(name).trim()}".`);
  }
  if (matches.length > 1) {
    return clarify(
      `Several Todoist projects are named "${String(name).trim()}". Say which one.`,
      matches.map((project) => ({ id: project.id, name: project.name })),
    );
  }

  return { status: targetStatuses.resolved, projectId: matches[0].id, name: matches[0].name };
}

/**
 * A section is only ever taken from the project in hand. Without a project,
 * a name shared by sections in different projects is ambiguous and asked about,
 * never picked.
 */
export function resolveTodoistSection(name, sections, { projectId, projectsById } = {}) {
  requireList(sections, "sections");
  const wanted = comparableTaskTitle(name ?? "");
  if (!wanted) return clarify("A section name is required.");

  const scoped = projectId
    ? live(sections).filter((section) => section.project_id === projectId)
    : live(sections);
  const matches = scoped.filter((section) => comparableTaskTitle(section.name ?? "") === wanted);

  const where = projectId ? " in that project" : "";
  if (matches.length === 0) {
    return clarify(`No Todoist section is named "${String(name).trim()}"${where}.`);
  }
  if (matches.length > 1) {
    return clarify(
      `Several Todoist sections are named "${String(name).trim()}"${where}. Say which project it is in.`,
      matches.map((section) => ({
        id: section.id,
        name: section.name,
        projectId: section.project_id,
        projectName: projectsById?.[section.project_id] ?? null,
      })),
    );
  }

  return {
    status: targetStatuses.resolved,
    sectionId: matches[0].id,
    projectId: matches[0].project_id,
    name: matches[0].name,
  };
}

function live(items) {
  return items.filter(
    (item) =>
      item &&
      typeof item === "object" &&
      typeof item.name === "string" &&
      item.is_archived !== true &&
      item.is_deleted !== true,
  );
}

function requireList(items, label) {
  if (!Array.isArray(items)) {
    throw new Error(`Todoist ${label} must be a list to resolve a name.`);
  }
}

function clarify(reason, matches = []) {
  return { status: targetStatuses.clarify, reason, matches };
}
