import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

const workflowPath = ".github/workflows/tests.yml";

describe("continuous integration workflow", () => {
  it("exists and runs the deterministic test gate", () => {
    assert.equal(existsSync(workflowPath), true);

    const workflow = readFileSync(workflowPath, "utf8");

    assert.match(workflow, /^\s*pull_request:\s*$/m);
    assert.match(workflow, /^\s*push:\s*$/m);
    assert.match(workflow, /branches: \[main\]/);
    assert.match(workflow, /actions\/checkout@v\d+/);
    assert.match(workflow, /actions\/setup-node@v\d+/);
    assert.match(workflow, /run: npm test/);
  });

  it("uses the Node version the project declares support for", () => {
    const workflow = readFileSync(workflowPath, "utf8");
    const engines = JSON.parse(readFileSync("package.json", "utf8")).engines.node;
    const declaredMajor = engines.match(/(\d+)/)[1];

    assert.match(workflow, new RegExp(`node-version: "${declaredMajor}"`));
  });

  it("needs no secrets, so it cannot silently depend on local runtime configuration", () => {
    const workflow = readFileSync(workflowPath, "utf8");

    assert.doesNotMatch(workflow, /secrets\./);
    assert.doesNotMatch(workflow, /\.env/);
    assert.match(workflow, /permissions:\s*\n\s*contents: read/);
  });
});
