import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function projectPath(projectRoot, relativePath) {
  return resolve(projectRoot, relativePath);
}

export function safeGeneratedPath(projectRoot, relativePath) {
  const invalidPathError = new Error("OPENCLAW_CONFIG_PATH must be a relative path under .openclaw/");

  if (typeof relativePath !== "string" || relativePath.trim().length === 0) {
    throw invalidPathError;
  }

  const pathSegments = relativePath.split(/[\\/]+/).filter((segment) => segment && segment !== ".");
  if (isAbsolute(relativePath) || pathSegments[0] !== ".openclaw" || pathSegments.includes("..")) {
    throw invalidPathError;
  }

  const outputPath = resolve(projectRoot, relativePath);
  const generatedRoot = resolve(projectRoot, ".openclaw");
  const relativeOutput = relative(generatedRoot, outputPath);

  if (relativeOutput === "" || relativeOutput === ".." || relativeOutput.startsWith(`..${sep}`) || isAbsolute(relativeOutput)) {
    throw invalidPathError;
  }

  return outputPath;
}
