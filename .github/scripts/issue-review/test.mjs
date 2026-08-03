#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  analyzeIssue,
  issueSnapshot,
  issueSnapshotSha256,
  ISSUE_REVIEW_SCHEMA_VERSION,
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
  blocked_by_count: 0,
  blocked_by: [],
  blocking_count: 0,
  blocking: [],
};
assert.equal(ISSUE_REVIEW_SCHEMA_VERSION, 4);
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
const dependencies = {
  ...valid,
  blocked_by_count: 3,
  blocked_by: [
    { repository: "zeta/example", number: 20, state: "open" },
    { repository: "Alpha/example", number: 30, state: "CLOSED" },
    { repository: "zeta/example", number: 20, state: "open" },
    { repository: "Alpha/example", number: 10, state: "open" },
  ],
  blocking_count: 1,
  blocking: [
    { repository: "GizClaw/example", number: 40, state: "open" },
  ],
};
assert.deepEqual(issueSnapshot(dependencies).blocked_by, [
  { repository: "Alpha/example", number: 10, state: "OPEN" },
  { repository: "Alpha/example", number: 30, state: "CLOSED" },
  { repository: "zeta/example", number: 20, state: "OPEN" },
]);
assert.deepEqual(issueSnapshot(dependencies).blocking, [
  { repository: "GizClaw/example", number: 40, state: "OPEN" },
]);
assert.deepEqual(analyzeIssue(dependencies).deterministic_blockers, []);
assert.notEqual(
  issueSnapshotSha256(dependencies),
  issueSnapshotSha256({
    ...dependencies,
    blocked_by: dependencies.blocked_by.map((dependency, index) => (
      index === 1 ? { ...dependency, state: "OPEN" } : dependency
    )),
  }),
);
assert.notEqual(
  issueSnapshotSha256(dependencies),
  issueSnapshotSha256({
    ...dependencies,
    blocked_by_count: 2,
    blocked_by: dependencies.blocked_by.slice(1),
  }),
);
assert.notEqual(
  issueSnapshotSha256(dependencies),
  issueSnapshotSha256({
    ...dependencies,
    blocked_by_count: 0,
    blocked_by: [],
    blocking_count: dependencies.blocked_by_count,
    blocking: dependencies.blocked_by,
  }),
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
assert.ok(analyzeIssue({
  ...valid,
  blocked_by_count: 2,
  blocked_by: [{ repository: valid.repository, number: 20, state: "OPEN" }],
}).deterministic_blockers.some(
  (item) => item.code === "blocked-by-truncated",
));
assert.ok(analyzeIssue({
  ...valid,
  blocking_count: 2,
  blocking: [{ repository: valid.repository, number: 20, state: "OPEN" }],
}).deterministic_blockers.some(
  (item) => item.code === "blocking-truncated",
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
