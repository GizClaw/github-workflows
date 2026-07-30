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
assert.match(workflowSource, /const codeConclusion = findingCount === 0/);
assert.match(workflowSource, /'# ✅ Conclusion: PASS'/);
assert.match(workflowSource, /`# ❌ Conclusion: FAIL \(\$\{findingCount\} actionable finding/);
assert.match(
  workflowSource,
  /let body = \[\n\s+conclusion,\n\s+'## 🤖 OpenAI PR review',\n\s+codeConclusion,/,
);
assert.equal(
  (workflowSource.match(/name: 'OpenAI PR review'/g) || []).length,
  1,
);
assert.doesNotMatch(workflowSource, /name: 'OpenAI PR readiness'/);
assert.doesNotMatch(workflowSource, /readiness_check_run_id/);
assert.match(workflowSource, /READINESS_VERDICT/);
assert.match(
  workflowSource,
  /executionSucceeded && reviewPassed[\s\S]*?\? 'success'/,
);
assert.match(workflowSource, /failure: executionSucceeded[\s\S]*?'Review blocked'/);

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
  fs.writeFileSync(contextFile, "{}\n");
  const reviewOutput = path.join(temporary, "review-output");
  const fakeCodex = path.join(fakeBin, "codex");
  fs.writeFileSync(fakeCodex, `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output-last-message");
if (outputIndex < 0) process.exit(2);
const outputFile = args[outputIndex + 1];
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
fs.writeFileSync(outputFile, JSON.stringify({
  summary: "Fake review complete.",
  findings: [],
  readiness: { verdict: "pass", blockers: [] }
}));
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
      GENERATION_KEY: latestGeneration.key,
      MODEL: "gpt-5.6-terra",
      EFFORT: "medium",
      REVIEW_INSTRUCTIONS: "Review the diff.",
    },
  });
  assert.equal(runResult.status, 0, runResult.stderr);
  const completedLedger = JSON.parse(fs.readFileSync(
    path.join(state, "review-ledger.json"),
    "utf8",
  ));
  assert.equal(completedLedger.generations.at(-1).status, "completed");
  assert.equal(completedLedger.generations.at(-1).aggregate.metrics.input_tokens, 100);
  const reviewOutputs = fs.readFileSync(reviewOutput, "utf8");
  assert.match(reviewOutputs, /^credits_available=true$/m);
  assert.match(reviewOutputs, /^estimated_credits=0\.022$/m);
  const usageOutput = reviewOutputs
    .split("\n")
    .find((line) => line.startsWith("usage_json="));
  assert.ok(usageOutput);
  const usage = JSON.parse(usageOutput.slice("usage_json=".length));
  assert.equal(usage.turns.length, 2);
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
      GENERATION_KEY: latestGeneration.key,
      GENERATION_REUSED: "true",
      MODEL: "gpt-5.6-terra",
      EFFORT: "medium",
      REVIEW_INSTRUCTIONS: "Review the diff.",
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
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

process.stdout.write("pr-review scripts: ok\n");
