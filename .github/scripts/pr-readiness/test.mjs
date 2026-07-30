#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { REQUIRED_SECTIONS } from "../issue-review/common.mjs";
import { analyzePullRequest, evaluateReadiness } from "./common.mjs";

const scriptsDirectory = path.dirname(new URL(import.meta.url).pathname);
const reviewerWorkflow = fs.readFileSync(
  path.resolve(scriptsDirectory, "../../workflows/codex-openai-review.yml"),
  "utf8",
);
assert.match(
  reviewerWorkflow,
  /const trustedBaseEvent = \[[\s\S]*?'issues',[\s\S]*?\]\.includes\(event\)/,
  "Issue-triggered linked-PR refreshes must be trusted for fork PRs",
);

const issueBody = REQUIRED_SECTIONS.map((section) => (
  `## ${section}\n\n${section} details.`
)).join("\n\n");
const input = {
  repository: "GizClaw/example",
  number: 11,
  title: "ci: Add readiness gate",
  body: "Implements the plan.\n\nValidation: node test.mjs",
  base_sha: "a".repeat(40),
  head_sha: "b".repeat(40),
  linked_issues: [{
    repository: "GizClaw/example",
    number: 10,
    title: "ci: Add readiness gate",
    body: issueBody,
    issue_type: "Feature",
    sub_issue_numbers: [],
  }],
};
const context = {
  readiness: analyzePullRequest(input),
  trusted_readiness_policy_sha256: "d".repeat(64),
};
assert.deepEqual(context.readiness.deterministic_blockers, []);
assert.ok(analyzePullRequest({ ...input, title: "Bad title" })
  .deterministic_blockers.some((item) => item.code === "invalid-title"));
assert.ok(analyzePullRequest({ ...input, body: "" })
  .deterministic_blockers.some((item) => item.code === "missing-body"));
assert.ok(analyzePullRequest({ ...input, linked_issues: [] })
  .deterministic_blockers.some((item) => item.code === "missing-closing-issue"));
assert.notEqual(
  analyzePullRequest(input).snapshot_sha256,
  analyzePullRequest({ ...input, body: `${input.body}\nchanged` }).snapshot_sha256,
);
assert.notEqual(
  analyzePullRequest(input).snapshot_sha256,
  analyzePullRequest({ ...input, trigger_comment_id: "123" }).snapshot_sha256,
);

const cleanReview = {
  findings: [],
  readiness: { verdict: "pass", blockers: [] },
};
assert.equal(evaluateReadiness({
  context,
  review: cleanReview,
  workflowSourceSha: "c".repeat(40),
  model: "gpt-5.6-terra",
  effort: "medium",
}).verdict, "pass");
assert.equal(evaluateReadiness({
  context,
  review: cleanReview,
  workflowSourceSha: "c".repeat(40),
  model: "gpt-5.6-terra",
  effort: "medium",
}).trusted_policy_sha256, "d".repeat(64));
assert.equal(evaluateReadiness({
  context,
  review: {
    ...cleanReview,
    findings: [{
      priority: "P1",
      path: "a.mjs",
      line: 1,
      title: "Broken",
    }],
  },
  workflowSourceSha: "c".repeat(40),
  model: "gpt-5.6-terra",
  effort: "medium",
}).verdict, "fail");

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pr-readiness-test-"));
try {
  const fixtureFile = path.join(temporary, "graphql.json");
  const outputFile = path.join(temporary, "github-output");
  const fixture = {
    repository: {
      nameWithOwner: input.repository,
      pullRequest: {
        title: input.title,
        body: input.body,
        baseRefOid: input.base_sha,
        headRefOid: input.head_sha,
        closingIssuesReferences: {
          totalCount: 1,
          nodes: [{
            repository: { nameWithOwner: input.repository },
            number: 10,
            title: "ci: Add readiness gate",
            body: issueBody,
            issueType: { name: "Feature" },
            parent: null,
            subIssues: { nodes: [] },
          }],
        },
        reviewThreads: {
          pageInfo: { hasNextPage: false },
          nodes: [],
        },
      },
    },
  };
  fs.writeFileSync(fixtureFile, JSON.stringify(fixture));
  const verify = (expected) => spawnSync(process.execPath, [
    path.join(path.dirname(new URL(import.meta.url).pathname), "verify.mjs"),
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_REPOSITORY: input.repository,
      PULL_REQUEST_NUMBER: String(input.number),
      PR_READINESS_VERIFY_INPUT_FILE: fixtureFile,
      EXPECTED_SNAPSHOT_SHA256: expected,
      GITHUB_OUTPUT: outputFile,
    },
  });
  assert.equal(verify(context.readiness.snapshot_sha256).status, 0);
  assert.match(
    fs.readFileSync(outputFile, "utf8"),
    new RegExp(context.readiness.snapshot_sha256),
  );
  fixture.repository.pullRequest.body = `${input.body}\nchanged`;
  fs.writeFileSync(fixtureFile, JSON.stringify(fixture));
  assert.notEqual(verify(context.readiness.snapshot_sha256).status, 0);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

process.stdout.write("pr-readiness tests passed\n");
