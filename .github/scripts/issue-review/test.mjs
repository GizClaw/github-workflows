#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  analyzeIssue,
  issueSnapshotSha256,
} from "./common.mjs";

const validBody = [
  "## Background\n\nBackground details.",
  "## Goal\n\nGoal details.\n\n### Non-goals\n\nNo additional scope.",
  "## Code Changes Tree\n\nCode Changes Tree details.",
  "## Design\n\nDesign details.",
  [
    "## Test And Acceptance Criteria",
    "",
    "### Acceptance Criteria",
    "",
    "Observable close condition.",
    "",
    "### Validation",
    "",
    "Run the focused test.",
  ].join("\n"),
].join("\n\n");
const trackingBody = [
  "## Background\n\nBackground details.",
  "## Goal\n\nGoal details.\n\n### Non-goals\n\nNo additional scope.",
  "## Sub-issues\n\n- #20",
  "## Completion Criteria\n\nAll native children are closed.",
].join("\n\n");
const valid = {
  repository: "GizClaw/example",
  number: 10,
  title: "ci: Add readiness gate",
  body: validBody,
  state: "OPEN",
  issue_type: "Feature",
  parent_number: null,
  sub_issue_numbers: [],
  sub_issues: [],
};
assert.deepEqual(analyzeIssue(valid).deterministic_blockers, []);
assert.equal(issueSnapshotSha256(valid), issueSnapshotSha256({ ...valid }));
assert.notEqual(
  issueSnapshotSha256(valid),
  issueSnapshotSha256({ ...valid, body: `${validBody}\nchanged` }),
);
assert.notEqual(
  issueSnapshotSha256(valid),
  issueSnapshotSha256({ ...valid, body_truncated: true }),
);
assert.notEqual(
  issueSnapshotSha256(valid),
  issueSnapshotSha256({ ...valid, state: "CLOSED" }),
);
assert.ok(analyzeIssue({ ...valid, body_truncated: true })
  .deterministic_blockers.some((item) => item.code === "issue-body-truncated"));
assert.deepEqual(
  analyzeIssue({ ...valid, title: "Project-specific title", issue_type: "" })
    .deterministic_blockers,
  [],
);
assert.ok(analyzeIssue({
  ...valid,
  sub_issue_count: 101,
  sub_issue_numbers: Array.from({ length: 100 }, (_, index) => index + 1),
}).deterministic_blockers.some(
  (item) => item.code === "sub-issues-truncated",
));
assert.deepEqual(analyzeIssue({
  ...valid,
  issue_type: "Task",
  body: trackingBody,
  sub_issue_count: 1,
  sub_issues: [{
    repository: valid.repository,
    number: 20,
    state: "OPEN",
  }],
}).deterministic_blockers, []);
assert.deepEqual(analyzeIssue({
  ...valid,
  body: "Any project-defined Issue structure is accepted deterministically.",
}).deterministic_blockers, []);

process.stdout.write("issue-review tests passed\n");
