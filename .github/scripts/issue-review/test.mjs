#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  REQUIRED_SECTIONS,
  analyzeIssue,
  issueSnapshotSha256,
} from "./common.mjs";

const validBody = REQUIRED_SECTIONS.map((section) => (
  `## ${section}\n\n${section} details.`
)).join("\n\n");
const valid = {
  repository: "GizClaw/example",
  number: 10,
  title: "ci: Add readiness gate",
  body: validBody,
  issue_type: "Feature",
  parent_number: null,
  sub_issue_numbers: [],
};
const workflowSource = fs.readFileSync(path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
  "workflows",
  "codex-openai-issue-review.yml",
), "utf8");
assert.match(workflowSource, /const data = await github\.graphql\(`/);
assert.match(workflowSource, /const repository = data\.repository;/);
assert.deepEqual(analyzeIssue(valid).deterministic_blockers, []);
assert.equal(issueSnapshotSha256(valid), issueSnapshotSha256({ ...valid }));
assert.notEqual(
  issueSnapshotSha256(valid),
  issueSnapshotSha256({ ...valid, body: `${validBody}\nchanged` }),
);
assert.ok(analyzeIssue({ ...valid, title: "Bad title" })
  .deterministic_blockers.some((item) => item.code === "invalid-title"));
assert.ok(analyzeIssue({ ...valid, issue_type: "" })
  .deterministic_blockers.some((item) => item.code === "missing-issue-type"));
assert.ok(analyzeIssue({ ...valid, issue_type: "Task" })
  .deterministic_blockers.some((item) => item.code === "tracking-task"));
assert.ok(analyzeIssue({ ...valid, body: "## Goal\n\nToo little." })
  .deterministic_blockers.some((item) => item.code === "invalid-section-contract"));
assert.ok(analyzeIssue({
  ...valid,
  body: validBody.replace(
    "Background details.",
    "Parent: #1\n\n- Follow up to: #2",
  ),
}).deterministic_blockers.some(
  (item) => item.code === "invalid-background-relationship",
));
assert.deepEqual(analyzeIssue({
  ...valid,
  body: validBody.replace(
    "Design details.",
    "```markdown\n## Not a real top-level section\n```\n\nDesign details.",
  ),
}).deterministic_blockers, []);

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "issue-review-test-"));
try {
  const contextFile = path.join(temporary, "context.json");
  const resultFile = path.join(temporary, "result.json");
  const outputFile = path.join(temporary, "github-output");
  const fakeBin = path.join(temporary, "bin");
  const codexHome = path.join(temporary, "codex-home");
  fs.mkdirSync(fakeBin);
  fs.mkdirSync(codexHome);
  fs.writeFileSync(contextFile, JSON.stringify({
    issue: {
      deterministic_blockers: [{
        code: "invalid-title",
        message: "Issue title is invalid.",
      }],
    },
  }));
  fs.writeFileSync(path.join(fakeBin, "codex"), `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
const output = args[args.indexOf("--output-last-message") + 1];
fs.writeFileSync(output, JSON.stringify({
  verdict: "pass",
  summary: "Model found no semantic blockers.",
  blockers: []
}));
`, { mode: 0o755 });
  const run = spawnSync(process.execPath, [
    path.join(path.dirname(new URL(import.meta.url).pathname), "run.mjs"),
  ], {
    cwd: temporary,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
      GITHUB_OUTPUT: outputFile,
      ISSUE_CONTEXT_FILE: contextFile,
      ISSUE_REVIEW_OUTPUT_FILE: resultFile,
      ISSUE_REVIEW_OUTPUT_SCHEMA: path.join(
        path.dirname(new URL(import.meta.url).pathname),
        "review-output-schema.json",
      ),
      REPOSITORY_DIR: temporary,
      MODEL: "gpt-5.6-terra",
      EFFORT: "medium",
      ISSUE_REVIEW_INSTRUCTIONS: "Review the Issue.",
      CODEX_HOME: codexHome,
    },
  });
  assert.equal(run.status, 0, run.stderr);
  const merged = JSON.parse(fs.readFileSync(resultFile, "utf8"));
  assert.equal(merged.verdict, "fail");
  assert.equal(merged.blockers[0].code, "invalid-title");
  assert.match(fs.readFileSync(outputFile, "utf8"), /^verdict=fail$/m);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

process.stdout.write("issue-review tests passed\n");
