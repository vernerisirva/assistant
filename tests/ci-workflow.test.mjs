import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

const workflowPath = ".github/workflows/tests.yml";

/**
 * Node ships no YAML parser and this project has no dependencies, so these
 * assertions read the workflow as text. Comments are stripped first, because a
 * gutted workflow can otherwise keep every required phrase in a comment while
 * doing nothing.
 */
function readWorkflow() {
  return readFileSync(workflowPath, "utf8").replace(/^\s*#.*$/gm, "");
}

describe("continuous integration workflow", () => {
  it("exists and runs the deterministic test gate on its own line", () => {
    assert.equal(existsSync(workflowPath), true);

    const workflow = readWorkflow();

    assert.match(workflow, /actions\/checkout@v\d+/);
    assert.match(workflow, /actions\/setup-node@v\d+/);
    // Anchored: "run: npm test || true" and similar must not satisfy the gate.
    assert.match(workflow, /^\s*run: npm test\s*$/m);
  });

  it("runs on pull requests and pushes that target main", () => {
    const workflow = readWorkflow();

    for (const trigger of ["pull_request", "push"]) {
      assert.match(
        workflow,
        new RegExp(`^\\s*${trigger}:\\s*\\n\\s*branches: \\[main\\]\\s*$`, "m"),
        `${trigger} must target main`,
      );
    }

    // A path filter would let changes skip the gate while still looking wired up.
    assert.doesNotMatch(workflow, /^\s*paths(-ignore)?:/m);
  });

  it("uses the Node version the project declares support for", () => {
    const workflow = readWorkflow();
    const engines = JSON.parse(readFileSync("package.json", "utf8")).engines?.node;

    assert.ok(engines, "package.json must declare engines.node");
    const declaredMajor = engines.match(/(\d+)/)[1];

    assert.match(workflow, new RegExp(`node-version: ["']?${declaredMajor}(\\.x)?["']?`));
  });

  it("needs no secrets, so it cannot silently depend on local runtime configuration", () => {
    const workflow = readWorkflow();

    assert.doesNotMatch(workflow, /secrets\./);
    assert.doesNotMatch(workflow, /\.env/);
    assert.doesNotMatch(workflow, /pull_request_target/);
    assert.match(workflow, /permissions:\s*\n\s*contents: read/);
  });
});
