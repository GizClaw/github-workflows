#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  TRACKING_SECTIONS,
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
assert.ok(analyzeIssue({ ...valid, title: "Bad title" })
  .deterministic_blockers.some((item) => item.code === "invalid-title"));
assert.ok(analyzeIssue({ ...valid, issue_type: "" })
  .deterministic_blockers.some((item) => item.code === "missing-issue-type"));
assert.ok(analyzeIssue({ ...valid, issue_type: "Task" })
  .deterministic_blockers.some((item) => item.code === "tracking-task"));
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
}, { implementationIssue: false }).deterministic_blockers, []);
assert.deepEqual(
  TRACKING_SECTIONS,
  ["Background", "Goal", "Sub-issues", "Completion Criteria"],
);
assert.ok(analyzeIssue({
  ...valid,
  body: validBody.replace("### Non-goals", "### Scope"),
}).deterministic_blockers.some((item) => item.code === "missing-non-goals"));
assert.ok(analyzeIssue({
  ...valid,
  body: validBody.replace("### Validation", "### Verification"),
}).deterministic_blockers.some(
  (item) => item.code === "invalid-test-and-acceptance-structure",
));
assert.ok(analyzeIssue({
  ...valid,
  issue_type: "Task",
  body: validBody,
  sub_issue_count: 1,
  sub_issues: [{
    repository: valid.repository,
    number: 20,
    state: "OPEN",
  }],
}, { implementationIssue: false }).deterministic_blockers.some(
  (item) => item.code === "invalid-section-contract",
));
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

process.stdout.write("issue-review tests passed\n");
