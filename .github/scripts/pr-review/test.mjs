#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  estimateCodexCredits,
  numberInRanges,
  rangesFromNumbers,
  sha256,
  treeHash,
  usageDelta,
} from "./common.mjs";
import {
  emptyMetrics,
  snapshotDiff,
  stageIdentity,
  totalMetrics,
} from "./stages.mjs";

assert.deepEqual(rangesFromNumbers([5, 2, 3, 3, 8]), [[2, 3], [5, 5], [8, 8]]);
assert.equal(numberInRanges(3, [[2, 3]]), true);
assert.equal(numberInRanges(4, [[2, 3]]), false);
assert.equal(sha256("review"), "c97ace4c8fef2cee8fa0f3c9f52aab18dbd4f42438afe362ffb8f75ce4c04b84");
assert.deepEqual(
  estimateCodexCredits({
    model: "gpt-5.6-terra",
    inputTokens: 1_000_000,
    cachedInputTokens: 800_000,
    outputTokens: 10_000,
  }),
  {
    credits: 21.25,
    uncached_input_tokens: 200_000,
    cached_input_tokens: 800_000,
    output_tokens: 10_000,
    rates_per_million: {
      input: 62.5,
      cached_input: 6.25,
      output: 375,
    },
  },
);
assert.equal(estimateCodexCredits({
  model: "unknown",
  inputTokens: 1,
  cachedInputTokens: 0,
  outputTokens: 1,
}), null);
assert.deepEqual(
  snapshotDiff(null, { title: "feat: Add review", body: "Body" }),
  {
    mode: "full",
    snapshot: { title: "feat: Add review", body: "Body" },
  },
);
assert.deepEqual(
  snapshotDiff(
    { title: "feat: Add review", body: "one\ntwo\nthree" },
    { title: "feat: Add review", body: "one\nchanged\nthree" },
  ),
  {
    mode: "incremental",
    changes: [{
      field: "body",
      text_diff: {
        old_start: 2,
        new_start: 2,
        removed: ["two"],
        added: ["changed"],
      },
    }],
  },
);
assert.deepEqual(
  stageIdentity({
    stage: "pr",
    snapshot: { title: "feat: Review" },
    policySha256: "policy",
    model: "gpt-5.6-terra",
    effort: "medium",
  }),
  {
    version: 1,
    stage: "pr",
    snapshot_sha256:
      "1638e8446487299b8fa352347439a0c627a5dd8355448a1a3b1a7d69a58c531f",
    policy_sha256: "policy",
    model: "gpt-5.6-terra",
    effort: "medium",
  },
);
assert.deepEqual(
  totalMetrics([
    emptyMetrics("pr:reused", "pr", "reused"),
    {
      ...emptyMetrics("issue:1", "issue", "full", 1),
      input_tokens: 100,
      cached_input_tokens: 50,
      output_tokens: 20,
      total_tokens: 120,
    },
  ]),
  {
    duration_seconds: 0,
    input_tokens: 100,
    cached_input_tokens: 50,
    cache_write_tokens: 0,
    output_tokens: 20,
    reasoning_output_tokens: 0,
    total_tokens: 120,
    cache_hit_ratio: 0.5,
  },
);

const workflowSource = fs.readFileSync(
  path.join(
    path.dirname(new URL(import.meta.url).pathname),
    "..",
    "..",
    "workflows",
    "codex-openai-review.yml",
  ),
  "utf8",
);
for (const jobName of ["start", "finalize"]) {
  assert.match(
    workflowSource,
    new RegExp(
      `^  ${jobName}:\\n(?:(?!^  \\S)[\\s\\S])*?^      pull-requests: write$`,
      "m",
    ),
    `${jobName} must be allowed to manage reactions on PR comments`,
  );
}
const runSource = fs.readFileSync(
  path.join(path.dirname(new URL(import.meta.url).pathname), "run.mjs"),
  "utf8",
);
assert.match(
  runSource,
  /Before reviewing code, read the linked Issue context/,
);
assert.match(runSource, /linked_issue_evidence/);
assert.match(runSource, /Use the checked-out trusted base repository as evidence/);
assert.match(runSource, /Apply the write-issue contract/);
assert.match(runSource, /workflow_source_sha: workflowSourceSha/);
assert.match(runSource, /deterministic PR linkage owns that decision/);
assert.match(runSource, /do not return a second blocker for the same condition/);
assert.match(workflowSource, /const overallPass = readiness\.verdict === 'pass' && findingCount === 0/);
assert.match(workflowSource, /'# ✅ OpenAI PR Review: PASS'/);
assert.match(workflowSource, /'# ❌ OpenAI PR Review: FAIL'/);
assert.match(
  workflowSource,
  /let body = \[\n\s+conclusion,\n\s+conclusionDetail,\n\s+readinessDetails,/,
);
assert.match(workflowSource, /'> \*\*Conclusion:\*\* Ready from the OpenAI review perspective\./);
assert.match(workflowSource, /'## Review checks'/);
assert.match(workflowSource, /'<summary>Review metadata<\/summary>'/);
assert.match(workflowSource, /'<summary>Token and cache details<\/summary>'/);
assert.doesNotMatch(workflowSource, /'## 🤖 OpenAI PR review'/);
assert.doesNotMatch(workflowSource, /'# ✅ PR readiness: PASS'/);
for (const name of [
  "OpenAI PR Review",
  "OpenAI Issue Review",
  "OpenAI Code Review",
]) {
  assert.equal(
    (workflowSource.match(new RegExp(`name: '${name}'`, "g")) || []).length,
    2,
  );
}
assert.doesNotMatch(workflowSource, /name: 'OpenAI PR readiness'/);
assert.match(workflowSource, /pr_check_run_id/);
assert.match(workflowSource, /issue_check_run_id/);
assert.match(workflowSource, /code_check_run_id/);
assert.match(workflowSource, /stage_verdicts\?\.pr_review/);
assert.match(
  workflowSource,
  /executionSucceeded && check\.verdict === 'pass'[\s\S]*?\? 'success'/,
);
assert.match(workflowSource, /failure: executionSucceeded[\s\S]*?'Review blocked'/);
assert.match(workflowSource, /Token and cache details/);

assert.deepEqual(
  usageDelta(
    { input_tokens: 100, cached_input_tokens: 50, output_tokens: 10 },
    {
      input_tokens: 250,
      cached_input_tokens: 170,
      output_tokens: 30,
      reasoning_output_tokens: 5,
      total_tokens: 280,
    },
  ),
  {
    input_tokens: 150,
    cached_input_tokens: 120,
    cache_write_tokens: 0,
    cache_hit_ratio: 0.8,
    output_tokens: 20,
    reasoning_output_tokens: 5,
    total_tokens: 280,
  },
);

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pr-review-test-"));
try {
  fs.mkdirSync(path.join(temporary, "nested"));
  fs.writeFileSync(path.join(temporary, "a"), "one");
  fs.writeFileSync(path.join(temporary, "nested", "b"), "two");
  const first = treeHash(temporary);
  fs.writeFileSync(path.join(temporary, "nested", "b"), "three");
  assert.notEqual(treeHash(temporary), first);

  const repo = path.join(temporary, "repo");
  fs.mkdirSync(repo);
  const run = (...args) => {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  run("init", "-q");
  run("config", "user.name", "Review Test");
  run("config", "user.email", "review@example.com");
  fs.writeFileSync(path.join(repo, "large.txt"), "start\n");
  run("add", "large.txt");
  run("commit", "-qm", "base");
  const base = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repo, encoding: "utf8",
  }).stdout.trim();
  fs.writeFileSync(
    path.join(repo, "large.txt"),
    `${Array.from({ length: 200 }, (_, index) => `line-${index}`).join("\n")}\n`,
  );
  run("add", "large.txt");
  run("commit", "-qm", "head");
  const head = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repo, encoding: "utf8",
  }).stdout.trim();
  const state = path.join(temporary, "state");
  const result = spawnSync(process.execPath, [
    path.join(path.dirname(new URL(import.meta.url).pathname), "prepare.mjs"),
  ], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      REPOSITORY_DIR: repo,
      PR_REVIEW_STATE_DIR: state,
      PR_BASE_SHA: base,
      PR_HEAD_SHA: head,
      SESSION_KEY: "repo:1:pr:2:v2",
      MAX_DIFF_BYTES: "1000000",
      CHUNK_TARGET_BYTES: "600",
      READINESS_CONTEXT_SHA256: "context-v1",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const ledger = JSON.parse(fs.readFileSync(
    path.join(state, "review-ledger.json"),
    "utf8",
  ));
  assert.equal(ledger.generations.length, 1);
  assert.ok(ledger.generations[0].chunks.length > 1);
  for (const chunk of ledger.generations[0].chunks) {
    assert.ok(fs.existsSync(path.join(
      state,
      "generations",
      ledger.generations[0].key,
      chunk.relative_path,
    )));
  }
  const firstGeneration = ledger.generations[0];
  const firstGenerationResults = path.join(
    state,
    "generations",
    firstGeneration.key,
    "results",
  );
  assert.ok(fs.existsSync(firstGenerationResults));
  fs.rmSync(firstGenerationResults, { recursive: true });
  const restored = spawnSync(process.execPath, [
    path.join(path.dirname(new URL(import.meta.url).pathname), "prepare.mjs"),
  ], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      REPOSITORY_DIR: repo,
      PR_REVIEW_STATE_DIR: state,
      PR_BASE_SHA: base,
      PR_HEAD_SHA: head,
      SESSION_KEY: "repo:1:pr:2:v2",
      MAX_DIFF_BYTES: "1000000",
      CHUNK_TARGET_BYTES: "600",
      READINESS_CONTEXT_SHA256: "context-v1",
    },
  });
  assert.equal(restored.status, 0, restored.stderr);
  assert.ok(fs.existsSync(firstGenerationResults));
  firstGeneration.status = "completed";
  firstGeneration.completed_at = new Date().toISOString();
  fs.writeFileSync(
    path.join(state, "review-ledger.json"),
    `${JSON.stringify(ledger, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(state, "generations", firstGeneration.key, "generation.json"),
    `${JSON.stringify(firstGeneration, null, 2)}\n`,
  );
  fs.appendFileSync(path.join(repo, "large.txt"), "incremental\n");
  run("add", "large.txt");
  run("commit", "-qm", "incremental");
  const nextHead = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repo, encoding: "utf8",
  }).stdout.trim();
  const incremental = spawnSync(process.execPath, [
    path.join(path.dirname(new URL(import.meta.url).pathname), "prepare.mjs"),
  ], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      REPOSITORY_DIR: repo,
      PR_REVIEW_STATE_DIR: state,
      PR_BASE_SHA: base,
      PR_HEAD_SHA: nextHead,
      SESSION_KEY: "repo:1:pr:2:v2",
      MAX_DIFF_BYTES: "1000000",
      CHUNK_TARGET_BYTES: "600",
      READINESS_CONTEXT_SHA256: "context-v1",
    },
  });
  assert.equal(incremental.status, 0, incremental.stderr);
  const updatedLedger = JSON.parse(fs.readFileSync(
    path.join(state, "review-ledger.json"),
    "utf8",
  ));
  assert.equal(updatedLedger.generations.at(-1).mode, "incremental");
  assert.equal(updatedLedger.generations.at(-1).from_sha, head);
  assert.equal(updatedLedger.generations.at(-1).to_sha, nextHead);

  const fakeBin = path.join(temporary, "bin");
  const codexHome = path.join(temporary, "codex-home");
  const contextFile = path.join(temporary, "context.json");
  fs.mkdirSync(fakeBin);
  fs.mkdirSync(codexHome);
  fs.writeFileSync(contextFile, `${JSON.stringify({
    trusted_readiness_policy_sha256: "policy-v1",
    readiness: {
      snapshot: {
        repository: "example/repo",
        number: 2,
        title: "feat: Review workflow",
        body: "Closes #1",
        base_sha: base,
        head_sha: nextHead,
        linked_issues: [{
          snapshot: {
            repository: "example/repo",
            number: 1,
            title: "feat: Review workflow",
            body: [
              "## Background",
              "Context.",
              "## Goal",
              "Goal.",
              "### Non-goals",
              "No additional scope.",
              "## Code Changes Tree",
              "Tree.",
              "## Design",
              "Design.",
              "## Test And Acceptance Criteria",
              "### Acceptance Criteria",
              "Observable close condition.",
              "### Validation",
              "Run the focused test.",
            ].join("\n"),
            issue_type: "Feature",
            parent_number: null,
            sub_issue_count: 0,
            sub_issue_numbers: [],
          },
          snapshot_sha256: "issue-v1",
        }],
      },
      deterministic_blockers: [],
    },
  }, null, 2)}\n`);
  const reviewOutput = path.join(temporary, "review-output");
  const fakeCodex = path.join(fakeBin, "codex");
  fs.writeFileSync(fakeCodex, `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output-last-message");
if (outputIndex < 0) process.exit(2);
const outputFile = args[outputIndex + 1];
const schemaIndex = args.indexOf("--output-schema");
const schemaFile = args[schemaIndex + 1];
const id = "019f0000-0000-7000-8000-000000000001";
const sessionDir = path.join(process.env.CODEX_HOME, "sessions", "2026", "07", "23");
const sessionFile = path.join(sessionDir, "rollout-test.jsonl");
fs.mkdirSync(sessionDir, { recursive: true });
let calls = 0;
if (fs.existsSync(sessionFile)) {
  calls = fs.readFileSync(sessionFile, "utf8").split("\\n")
    .filter((line) => line.includes('"type":"token_count"')).length;
} else {
  fs.appendFileSync(sessionFile, JSON.stringify({
    type: "session_meta",
    payload: { id, thread_source: "exec" }
  }) + "\\n");
}
calls += 1;
fs.appendFileSync(sessionFile, JSON.stringify({
  type: "event_msg",
  payload: {
    type: "token_count",
    info: { total_token_usage: {
      input_tokens: calls * 100,
      cached_input_tokens: calls * 50,
      cache_write_input_tokens: calls * 10,
      output_tokens: calls * 20,
      reasoning_output_tokens: calls * 5,
      total_tokens: calls * 120
    }}
  }
}) + "\\n");
fs.writeFileSync(outputFile, JSON.stringify(
  schemaFile.endsWith("stage-output-schema.json")
    ? { summary: "Fake stage review complete.", blockers: [] }
    : {
        summary: "Fake code review complete.",
        findings: [],
        readiness: { verdict: "pass", blockers: [] }
      }
));
`, { mode: 0o755 });
  const latestGeneration = updatedLedger.generations.at(-1);
  fs.rmSync(path.join(
    state,
    "generations",
    latestGeneration.key,
    "results",
  ), { recursive: true });
  const runResult = spawnSync(process.execPath, [
    path.join(path.dirname(new URL(import.meta.url).pathname), "run.mjs"),
  ], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
      GITHUB_OUTPUT: reviewOutput,
      PR_REVIEW_STATE_DIR: state,
      CODEX_HOME: codexHome,
      REPOSITORY_DIR: repo,
      PR_CONTEXT_FILE: contextFile,
      REVIEW_OUTPUT_SCHEMA: path.join(
        path.dirname(new URL(import.meta.url).pathname),
        "review-output-schema.json",
      ),
      STAGE_OUTPUT_SCHEMA: path.join(
        path.dirname(new URL(import.meta.url).pathname),
        "stage-output-schema.json",
      ),
      GENERATION_KEY: latestGeneration.key,
      MODEL: "gpt-5.6-terra",
      EFFORT: "medium",
      REVIEW_INSTRUCTIONS: "Review the diff.",
      ISSUE_REVIEW_INSTRUCTIONS: "Review the Issue.",
      PR_REVIEW_INSTRUCTIONS: "Review PR readiness.",
    },
  });
  assert.equal(runResult.status, 0, runResult.stderr);
  const completedLedger = JSON.parse(fs.readFileSync(
    path.join(state, "review-ledger.json"),
    "utf8",
  ));
  const codeIssueContext = JSON.parse(fs.readFileSync(path.join(
    state,
    "generations",
    latestGeneration.key,
    "stage-inputs",
    "code-linked-issues.json",
  ), "utf8"));
  assert.equal(codeIssueContext.mode, "full");
  assert.match(
    codeIssueContext.linked_issues[0].snapshot.body,
    /## Background[\s\S]*## Test And Acceptance Criteria/,
  );
  const aggregateInput = JSON.parse(fs.readFileSync(path.join(
    state,
    "generations",
    latestGeneration.key,
    "aggregate-input.json",
  ), "utf8"));
  assert.equal(aggregateInput.linked_issue_evidence[0].number, 1);
  assert.equal(aggregateInput.linked_issue_evidence[0].mode, "full");
  assert.equal(
    completedLedger.stage_evidence.issues["example/repo#1"].trusted_base_sha,
    base,
  );
  assert.equal(completedLedger.generations.at(-1).status, "completed");
  assert.equal(completedLedger.generations.at(-1).aggregate.metrics.input_tokens, 100);
  const reviewOutputs = fs.readFileSync(reviewOutput, "utf8");
  assert.match(reviewOutputs, /^credits_available=true$/m);
  assert.match(reviewOutputs, /^estimated_credits=0\.044$/m);
  const usageOutput = reviewOutputs
    .split("\n")
    .find((line) => line.startsWith("usage_json="));
  assert.ok(usageOutput);
  const usage = JSON.parse(usageOutput.slice("usage_json=".length));
  assert.equal(usage.turns.length, 5);
  assert.deepEqual(
    usage.turns.map((turn) => [turn.stage, turn.mode, turn.issue_number]),
    [
      ["pr", "deterministic", null],
      ["pr", "full", null],
      ["issue", "full", 1],
      ["code", "incremental", null],
      ["code", "incremental", null],
    ],
  );
  assert.equal(usage.turns.every(
    (turn) => typeof turn.estimated_credits === "number",
  ), true);

  const reusedOutput = path.join(temporary, "reused-output");
  const reusedResult = spawnSync(process.execPath, [
    path.join(path.dirname(new URL(import.meta.url).pathname), "run.mjs"),
  ], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
      GITHUB_OUTPUT: reusedOutput,
      PR_REVIEW_STATE_DIR: state,
      CODEX_HOME: codexHome,
      REPOSITORY_DIR: repo,
      PR_CONTEXT_FILE: contextFile,
      REVIEW_OUTPUT_SCHEMA: path.join(
        path.dirname(new URL(import.meta.url).pathname),
        "review-output-schema.json",
      ),
      STAGE_OUTPUT_SCHEMA: path.join(
        path.dirname(new URL(import.meta.url).pathname),
        "stage-output-schema.json",
      ),
      GENERATION_KEY: latestGeneration.key,
      GENERATION_REUSED: "true",
      RESUMED_SESSION_ID: "019f0000-0000-7000-8000-000000000001",
      MODEL: "gpt-5.6-terra",
      EFFORT: "medium",
      REVIEW_INSTRUCTIONS: "Review the diff.",
      ISSUE_REVIEW_INSTRUCTIONS: "Review the Issue.",
      PR_REVIEW_INSTRUCTIONS: "Review PR readiness.",
    },
  });
  assert.equal(reusedResult.status, 0, reusedResult.stderr);
  const reusedOutputs = fs.readFileSync(reusedOutput, "utf8");
  assert.match(reusedOutputs, /^duration_seconds=0$/m);
  assert.match(reusedOutputs, /^input_tokens=0$/m);
  assert.match(reusedOutputs, /^cached_input_tokens=0$/m);
  assert.match(reusedOutputs, /^cache_write_tokens=0$/m);
  assert.match(reusedOutputs, /^cache_hit_ratio=N\/A$/m);
  assert.match(reusedOutputs, /^output_tokens=0$/m);
  assert.match(reusedOutputs, /^reasoning_output_tokens=0$/m);
  assert.match(reusedOutputs, /^total_tokens=0$/m);
  assert.match(reusedOutputs, /^credits_available=true$/m);
  assert.match(reusedOutputs, /^estimated_credits=0\.000$/m);
  const reusedUsageLine = reusedOutputs
    .split("\n")
    .find((line) => line.startsWith("usage_json="));
  const reusedUsage = JSON.parse(reusedUsageLine.slice("usage_json=".length));
  assert.deepEqual(
    reusedUsage.turns.map((turn) => [turn.stage, turn.mode]),
    [
      ["pr", "deterministic"],
      ["pr", "reused"],
      ["issue", "reused"],
      ["code", "reused"],
    ],
  );

  const changedContext = JSON.parse(fs.readFileSync(contextFile, "utf8"));
  changedContext.readiness.snapshot.linked_issues[0].snapshot.body +=
    "\n\nAcceptance detail changed.";
  changedContext.readiness.snapshot.linked_issues[0].snapshot_sha256 = "issue-v2";
  fs.writeFileSync(
    contextFile,
    `${JSON.stringify(changedContext, null, 2)}\n`,
  );
  const issueChangedOutput = path.join(temporary, "issue-changed-output");
  const issueChangedResult = spawnSync(process.execPath, [
    path.join(path.dirname(new URL(import.meta.url).pathname), "run.mjs"),
  ], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
      GITHUB_OUTPUT: issueChangedOutput,
      PR_REVIEW_STATE_DIR: state,
      CODEX_HOME: codexHome,
      REPOSITORY_DIR: repo,
      PR_CONTEXT_FILE: contextFile,
      REVIEW_OUTPUT_SCHEMA: path.join(
        path.dirname(new URL(import.meta.url).pathname),
        "review-output-schema.json",
      ),
      STAGE_OUTPUT_SCHEMA: path.join(
        path.dirname(new URL(import.meta.url).pathname),
        "stage-output-schema.json",
      ),
      GENERATION_KEY: latestGeneration.key,
      RESUMED_SESSION_ID: "019f0000-0000-7000-8000-000000000001",
      MODEL: "gpt-5.6-terra",
      EFFORT: "medium",
      REVIEW_INSTRUCTIONS: "Review the diff.",
      ISSUE_REVIEW_INSTRUCTIONS: "Review the Issue.",
      PR_REVIEW_INSTRUCTIONS: "Review PR readiness.",
    },
  });
  assert.equal(issueChangedResult.status, 0, issueChangedResult.stderr);
  const issueChangedOutputs = fs.readFileSync(issueChangedOutput, "utf8");
  assert.match(issueChangedOutputs, /^input_tokens=200$/m);
  const issueChangedUsageLine = issueChangedOutputs
    .split("\n")
    .find((line) => line.startsWith("usage_json="));
  const issueChangedUsage = JSON.parse(
    issueChangedUsageLine.slice("usage_json=".length),
  );
  const changedCodeIssueContext = JSON.parse(fs.readFileSync(path.join(
    state,
    "generations",
    latestGeneration.key,
    "stage-inputs",
    "code-linked-issues.json",
  ), "utf8"));
  assert.equal(changedCodeIssueContext.mode, "incremental");
  assert.equal(
    Object.hasOwn(changedCodeIssueContext.linked_issues[0], "snapshot"),
    false,
  );
  assert.equal(
    changedCodeIssueContext.linked_issues[0].change.mode,
    "incremental",
  );
  const changedAggregateInput = JSON.parse(fs.readFileSync(path.join(
    state,
    "generations",
    latestGeneration.key,
    "aggregate-input.json",
  ), "utf8"));
  assert.equal(
    changedAggregateInput.linked_issue_evidence[0].change.mode,
    "incremental",
  );
  assert.deepEqual(
    issueChangedUsage.turns.map((turn) => [turn.stage, turn.mode]),
    [
      ["pr", "deterministic"],
      ["pr", "reused"],
      ["issue", "incremental"],
      ["code", "incremental"],
    ],
  );
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

process.stdout.write("pr-review scripts: ok\n");
