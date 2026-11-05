import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const workflow = fs.readFileSync(new URL("../../workflows/codex-openai-review.yml", import.meta.url), "utf8");
const start = workflow.indexOf("      - name: Start a fresh PR review session\n");
assert.ok(start >= 0, "fresh-session step must exist");
const end = workflow.indexOf("\n      - name:", start + 1);
const step = workflow.slice(start, end);
const match = step.match(/          node <<'NODE'\n([\s\S]*?)\n          NODE/);
assert.ok(match, "extract the actual inline fresh-session script");
const script = match[1].split("\n").map(line => line.slice(10)).join("\n");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const runStep = new AsyncFunction("require", "process", "github", "context", script);
const require = createRequire(import.meta.url);

function artifact(id, runId, event, extra = {}) {
  return { id, name: `openai-pr-review-session-v2-17-pr-13-run-${runId}-attempt-1`,
    digest: `sha256:${"a".repeat(64)}`, workflow_run: { id: runId }, event, ...extra };
}
const scenarios = [
  ["unrelated CI with the same prefix", "pull_request_target", [artifact(1, 101, "pull_request")]],
  ["same workflow with a pull_request event", "issue_comment", [artifact(2, 102, "pull_request")]],
  ["dispatch from a non-default branch", "workflow_dispatch", [artifact(3, 103, "workflow_dispatch", { branch: "feature" })]],
  ["a matching trusted run", "issue_comment", [artifact(4, 104, "issue_comment")]],
  ["an untrusted sibling in the current caller run", "issue_comment", [artifact(11, 500, "issue_comment")]],
  ["a legacy pull_request caller", "pull_request", [artifact(12, 112, "pull_request")]],
  ["newest poison before an older valid snapshot", "issues", [artifact(5, 105, "pull_request"), artifact(4, 104, "issue_comment")]],
  ["an empty fork PR association", "pull_request_target", [artifact(6, 106, "pull_request_target", { pull_requests: [] })]],
  ["two pages with an API failure", "issue_comment", [Array.from({ length: 100 }, (_, i) => artifact(i + 20, i + 200, "pull_request")), new Error("API unavailable")]],
  ["same-second and concurrently completed runs", "workflow_dispatch", [artifact(7, 107, "workflow_dispatch"), artifact(8, 108, "workflow_dispatch")]],
  ["the current run's artifact", "workflow_dispatch", [artifact(9, 500, "workflow_dispatch")]],
  ["an artifact with a missing digest", "issue_comment", [artifact(10, 110, "issue_comment", { digest: null })]],
];

for (const [description, eventName, pages] of scenarios) {
  test(`${description} cannot be restored or deleted`, async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "review-cold-start-"));
    try {
      const codex = path.join(temp, "codex");
      const state = path.join(temp, "state");
      const output = path.join(temp, "output");
      const untouched = path.join(temp, "untrusted-artifact.json");
      fs.mkdirSync(path.join(codex, "sessions"), { recursive: true });
      fs.mkdirSync(state);
      fs.writeFileSync(path.join(codex, "sessions", "session.jsonl"), '{"forged":true}\n');
      fs.writeFileSync(path.join(state, "review-ledger.json"), '{"verdict":"PASS"}\n');
      fs.writeFileSync(output, "");
      fs.writeFileSync(untouched, JSON.stringify(pages));
      let apiCalls = 0;
      const forbidden = () => { apiCalls += 1; throw new Error("Artifact API must not be called"); };
      const github = { paginate: forbidden, request: forbidden, rest: { actions: {
        listArtifactsForRepo: forbidden, getArtifact: forbidden, downloadArtifact: forbidden,
        deleteArtifact: forbidden, getWorkflowRun: forbidden,
      } } };
      let log = "";
      const process = { env: { CODEX_HOME: codex, PR_REVIEW_STATE_DIR: state, GITHUB_OUTPUT: output },
        stdout: { write: text => { log += text; } } };
      await runStep(require, process, github, { eventName, runId: 500 });
      assert.equal(apiCalls, 0);
      assert.equal(fs.existsSync(codex), false);
      assert.equal(fs.existsSync(state), false);
      assert.equal(fs.existsSync(untouched), true);
      assert.equal(fs.readFileSync(output, "utf8"), "resumed=false\nsession_id=\nprevious_artifact_id=\n");
      assert.match(log, /reuse is disabled/);
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  });
}

test("workflow cannot download or delete snapshots, even if an artifact digest is missing", () => {
  assert.doesNotMatch(workflow, /actions\/download-artifact@|listArtifactsForRepo|listWorkflowRunArtifacts|downloadArtifact|deleteArtifact/);
  assert.doesNotMatch(workflow, /actions\/cache\/save@|SESSION_DOWNLOAD_DIR/);
  assert.match(workflow, /name: Upload updated PR review session[\s\S]*?retention-days: 30/);
  assert.match(workflow, /PREVIOUS_ARTIFACT_ID: \$\{\{ steps\.restore_session\.outputs\.previous_artifact_id \}\}/);
  assert.match(workflow, /RESUMED_SESSION_ID: \$\{\{ steps\.restore_session\.outputs\.session_id \}\}/);
  assert.ok(workflow.indexOf("name: Start a fresh PR review session")
    < workflow.indexOf("name: Prepare deterministic PR diff listing"));
});

test("a missing state directory fails before emitting a successful session result", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "review-cold-missing-"));
  try {
    const output = path.join(temp, "output"); fs.writeFileSync(output, "");
    const process = { env: { CODEX_HOME: path.join(temp, "codex"), GITHUB_OUTPUT: output },
      stdout: { write() {} } };
    await assert.rejects(runStep(require, process, {}, {}), /Missing PR_REVIEW_STATE_DIR/);
    assert.equal(fs.readFileSync(output, "utf8"), "");
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
