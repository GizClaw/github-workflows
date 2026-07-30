#!/usr/bin/env node

import assert from "node:assert/strict";
import { REQUIRED_SECTIONS } from "../issue-review/common.mjs";
import { analyzePullRequest, evaluateReadiness } from "./common.mjs";

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

process.stdout.write("pr-readiness tests passed\n");
