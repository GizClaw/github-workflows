#!/usr/bin/env node

import assert from "node:assert/strict";
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
  body: "",
  sub_issue_count: 1,
  sub_issue_numbers: [20],
}, { implementationIssue: false }).deterministic_blockers, []);
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
