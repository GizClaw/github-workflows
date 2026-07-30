#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
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
const blockerCodes = (readiness) => (
  readiness.deterministic_blockers.map((item) => item.code)
);
assert.deepEqual(context.readiness.deterministic_blockers, []);
assert.ok(analyzePullRequest({ ...input, title: "Bad title" })
  .deterministic_blockers.some((item) => item.code === "invalid-title"));
assert.ok(analyzePullRequest({ ...input, body: "" })
  .deterministic_blockers.some((item) => item.code === "missing-body"));
assert.ok(analyzePullRequest({ ...input, linked_issues: [] })
  .deterministic_blockers.some((item) => item.code === "missing-closing-issue"));
assert.ok(blockerCodes(analyzePullRequest({
  ...input,
  body: "Related to #10, but this is not a native closing relationship.",
  linked_issues: [],
})).includes("missing-closing-issue"));
assert.ok(blockerCodes(analyzePullRequest({
  ...input,
  linked_issues: [{
    ...input.linked_issues[0],
    repository: "Other/example",
  }],
})).includes("missing-closing-issue"));
assert.deepEqual(blockerCodes(analyzePullRequest({
  ...input,
  linked_issues: [{
    ...input.linked_issues[0],
    issue_type: "Task",
    sub_issue_numbers: [20],
  }],
})), ["missing-closing-issue"]);
assert.deepEqual(blockerCodes(analyzePullRequest({
  ...input,
  linked_issues: [
    input.linked_issues[0],
    {
      ...input.linked_issues[0],
      number: 11,
      issue_type: "Task",
      body: "",
      sub_issue_numbers: [20],
    },
  ],
})), []);
assert.ok(blockerCodes(analyzePullRequest({
  ...input,
  linked_issues: [{
    ...input.linked_issues[0],
    sub_issue_count: 101,
    sub_issue_numbers: Array.from({ length: 100 }, (_, index) => index + 1),
  }],
})).includes("sub-issues-truncated"));
assert.ok(blockerCodes(analyzePullRequest({
  ...input,
  linked_issue_count: 2,
})).includes("too-many-closing-issues"));
assert.ok(blockerCodes(analyzePullRequest({
  ...input,
  unresolved_openai_thread_count: 2,
})).includes("unresolved-actionable-threads"));
assert.ok(blockerCodes(analyzePullRequest({
  ...input,
  review_threads_truncated: true,
})).includes("review-thread-query-truncated"));
assert.notEqual(
  analyzePullRequest(input).snapshot_sha256,
  analyzePullRequest({ ...input, body: `${input.body}\nchanged` }).snapshot_sha256,
);
assert.notEqual(
  analyzePullRequest(input).snapshot_sha256,
  analyzePullRequest({ ...input, trigger_comment_id: "123" }).snapshot_sha256,
);
assert.notEqual(
  analyzePullRequest(input).snapshot_sha256,
  analyzePullRequest({ ...input, base_sha: "c".repeat(40) }).snapshot_sha256,
);
assert.notEqual(
  analyzePullRequest(input).snapshot_sha256,
  analyzePullRequest({ ...input, head_sha: "c".repeat(40) }).snapshot_sha256,
);
assert.notEqual(
  analyzePullRequest(input).snapshot_sha256,
  analyzePullRequest({
    ...input,
    linked_issues: [{
      ...input.linked_issues[0],
      body: `${issueBody}\nchanged`,
    }],
  }).snapshot_sha256,
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
for (const [category, stage] of [
  ["pr-format", "pr_review"],
  ["issue-design", "issue_review"],
  ["plan-conformance", "code_review"],
]) {
  const failed = evaluateReadiness({
    context,
    review: {
      ...cleanReview,
      readiness: {
        verdict: "fail",
        blockers: [{
          category,
          code: `${category}-failure`,
          title: "Blocked",
          body: "Required evidence could not be verified.",
        }],
      },
    },
    workflowSourceSha: "c".repeat(40),
    model: "gpt-5.6-terra",
    effort: "medium",
  });
  assert.equal(failed.verdict, "fail");
  assert.equal(failed.stage_verdicts[stage], "fail");
  assert.ok(failed.blockers.some((item) => item.source === category));
}

const aggregateContext = {
  ...context,
  readiness: analyzePullRequest({
    ...input,
    title: "Bad title",
    body: "",
    linked_issues: [],
    linked_issue_count: 1,
    unresolved_openai_thread_count: 1,
    review_threads_truncated: true,
  }),
};
const aggregateFailure = evaluateReadiness({
  context: aggregateContext,
  review: {
    findings: [{
      priority: "P1",
      path: "a.mjs",
      line: 1,
      title: "Broken",
    }],
    readiness: {
      verdict: "fail",
      blockers: [{
        category: "plan-conformance",
        code: "undisclosed-plan-deviation",
        title: "Plan deviation",
        body: "The implementation differs from the Issue without disclosure.",
      }],
    },
  },
  workflowSourceSha: "c".repeat(40),
  model: "gpt-5.6-terra",
  effort: "medium",
});
assert.equal(aggregateFailure.verdict, "fail");
assert.deepEqual(
  new Set(aggregateFailure.blockers.map((item) => item.source)),
  new Set([
    "pr-format",
    "pr-linkage",
    "review-thread",
    "plan-conformance",
    "code-review",
  ]),
);

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
            subIssues: { totalCount: 0, nodes: [] },
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

  const assertStale = (mutate) => {
    const staleFixture = structuredClone(fixture);
    mutate(staleFixture.repository.pullRequest);
    fs.writeFileSync(fixtureFile, JSON.stringify(staleFixture));
    const result = verify(context.readiness.snapshot_sha256);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /changed while readiness review was running/);
  };
  assertStale((pullRequest) => {
    pullRequest.title = "ci: Changed title";
  });
  assertStale((pullRequest) => {
    pullRequest.body = `${input.body}\nchanged`;
  });
  assertStale((pullRequest) => {
    pullRequest.baseRefOid = "c".repeat(40);
  });
  assertStale((pullRequest) => {
    pullRequest.headRefOid = "c".repeat(40);
  });
  assertStale((pullRequest) => {
    pullRequest.closingIssuesReferences.nodes[0].body = `${issueBody}\nchanged`;
  });
  assertStale((pullRequest) => {
    pullRequest.reviewThreads.nodes.push({
      isResolved: false,
      comments: {
        nodes: [{
          author: { login: "github-actions[bot]" },
          body: "![P1 Badge](https://img.shields.io/badge/P1-orange)",
        }],
      },
    });
  });

  fs.writeFileSync(fixtureFile, JSON.stringify({
    errors: [{ message: "rate limit exceeded" }],
  }));
  const apiFailure = verify(context.readiness.snapshot_sha256);
  assert.notEqual(apiFailure.status, 0);
  assert.match(apiFailure.stderr, /GitHub GraphQL failed: rate limit exceeded/);

  fs.writeFileSync(fixtureFile, "{");
  assert.notEqual(verify(context.readiness.snapshot_sha256).status, 0);

  fs.writeFileSync(fixtureFile, JSON.stringify({ repository: {} }));
  const missingEvidence = verify(context.readiness.snapshot_sha256);
  assert.notEqual(missingEvidence.status, 0);
  assert.match(missingEvidence.stderr, /Pull request was not found/);

  fixture.repository.pullRequest.body = `${input.body}\nchanged`;
  fs.writeFileSync(fixtureFile, JSON.stringify(fixture));
  assert.notEqual(verify(context.readiness.snapshot_sha256).status, 0);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

process.stdout.write("pr-readiness tests passed\n");
