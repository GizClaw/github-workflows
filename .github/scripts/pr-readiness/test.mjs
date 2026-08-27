#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { analyzePullRequest, evaluateReadiness } from "./common.mjs";

const issueBody = [
  "## Background\n\nBackground details.",
  "## Goal\n\nGoal details.\n\n### Non-goals\n\nNo additional scope.",
  "## Code Changes Tree\n\nREADME.md",
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
const taskBody = [
  "## Background\n\nBackground details.",
  "## Goal\n\nGoal details.\n\n### Non-goals\n\nNo additional scope.",
  "## Sub-issues\n\n- #20",
  "## Completion Criteria\n\nAll native children are closed.",
].join("\n\n");
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
    state: "OPEN",
    issue_type: "Feature",
    sub_issue_numbers: [],
    sub_issues: [],
    blocked_by_count: 2,
    blocked_by: [
      { repository: "GizClaw/example", number: 9, state: "OPEN" },
      { repository: "Other/example", number: 30, state: "CLOSED" },
    ],
    blocking_count: 1,
    blocking: [
      { repository: "GizClaw/example", number: 20, state: "OPEN" },
    ],
  }],
};
const context = {
  readiness: analyzePullRequest(input),
  trusted_readiness_policy_sha256: "d".repeat(64),
};
const blockerCodes = (readiness) => (
  readiness.deterministic_blockers.map((item) => item.code)
);
const closingChildren = Array.from({ length: 31 }, (_, index) => ({
  ...input.linked_issues[0],
  number: 101 + index,
  parent_number: 100,
}));
const manyLinkedIssues = [{
  ...input.linked_issues[0],
  number: 100,
  issue_type: "Task",
  body: taskBody,
  sub_issue_count: closingChildren.length,
  sub_issues: closingChildren.map((issue) => ({
    repository: issue.repository,
    number: issue.number,
    state: issue.state,
  })),
}, ...closingChildren];
const manyLinkedIssuesInput = {
  ...input,
  linked_issues: manyLinkedIssues,
  linked_issue_count: manyLinkedIssues.length,
};
const scriptDirectory = path.dirname(new URL(import.meta.url).pathname);
const verifySource = fs.readFileSync(
  path.join(scriptDirectory, "verify.mjs"),
  "utf8",
);
const workflowSource = fs.readFileSync(
  path.join(scriptDirectory, "..", "..", "workflows", "codex-openai-review.yml"),
  "utf8",
);
for (const source of [verifySource, workflowSource]) {
  assert.match(source, /closingIssuesReferences\(first: 100\)/);
  assert.match(source, /blockedBy\(first: 100\)/);
  assert.match(source, /blocking\(first: 100\)/);
  assert.match(source, /blocked_by_count:\s*issue\.blockedBy\.totalCount/);
  assert.match(source, /blocking_count:\s*issue\.blocking\.totalCount/);
  assert.doesNotMatch(source, /closingIssuesReferences\.nodes\s*\.slice\(/);
}
assert.deepEqual(context.readiness.deterministic_blockers, []);
assert.deepEqual(
  analyzePullRequest(manyLinkedIssuesInput).deterministic_blockers,
  [],
);
assert.ok(!blockerCodes(analyzePullRequest({
  ...input,
  title: "h106/zero_esp: add the Zero ESP Main App package",
})).includes("invalid-title"));
assert.ok(blockerCodes(analyzePullRequest({
  ...manyLinkedIssuesInput,
  linked_issue_count: manyLinkedIssues.length + 1,
})).includes("too-many-closing-issues"));
for (const title of [
  "Bad title",
  "H106/zero_esp: add the Zero ESP Main App package",
  "h106/_zero_esp: add the Zero ESP Main App package",
  "h106//zero_esp: add the Zero ESP Main App package",
  "h106/zero esp: add the Zero ESP Main App package",
  "h106/zero_esp: ",
]) {
  assert.ok(analyzePullRequest({ ...input, title })
    .deterministic_blockers.some((item) => item.code === "invalid-title"));
}
assert.ok(analyzePullRequest({ ...input, body: "" })
  .deterministic_blockers.some((item) => item.code === "missing-body"));
assert.ok(analyzePullRequest({ ...input, body_truncated: true })
  .deterministic_blockers.some((item) => item.code === "pr-body-truncated"));
assert.ok(analyzePullRequest({
  ...input,
  linked_issues: [{
    ...input.linked_issues[0],
    body_truncated: true,
  }],
}).deterministic_blockers.some(
  (item) => item.code === "issue-body-truncated",
));
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
    body: taskBody,
    sub_issue_count: 1,
    sub_issues: [{
      repository: input.repository,
      number: 20,
      state: "OPEN",
    }],
  }],
})), ["missing-open-sub-issues"]);
assert.deepEqual(blockerCodes(analyzePullRequest({
  ...input,
  linked_issues: [
    {
      ...input.linked_issues[0],
      number: 11,
      issue_type: "Task",
      body: taskBody,
      sub_issue_count: 1,
      sub_issues: [{
        repository: input.repository,
        number: 20,
        state: "OPEN",
      }],
    },
    {
      ...input.linked_issues[0],
      number: 20,
      parent_number: 11,
    },
  ],
})), []);
assert.deepEqual(blockerCodes(analyzePullRequest({
  ...input,
  linked_issues: [{
    ...input.linked_issues[0],
    number: 11,
    issue_type: "Task",
    body: taskBody,
    sub_issue_count: 1,
    sub_issues: [{
      repository: input.repository,
      number: 20,
      state: "CLOSED",
    }],
  }],
})), []);
assert.deepEqual(blockerCodes(analyzePullRequest({
  ...input,
  linked_issues: [
    {
      ...input.linked_issues[0],
      number: 11,
      issue_type: "Task",
      body: taskBody,
      sub_issue_count: 1,
      sub_issues: [{
        repository: input.repository,
        number: 20,
        state: "CLOSED",
      }],
    },
    {
      ...input.linked_issues[0],
      number: 20,
      state: "CLOSED",
      parent_number: 11,
    },
  ],
})), []);
assert.deepEqual(blockerCodes(analyzePullRequest({
  ...input,
  linked_issues: [
    {
      ...input.linked_issues[0],
      number: 11,
      issue_type: "Task",
      body: taskBody,
      sub_issue_count: 1,
      sub_issues: [{
        repository: input.repository,
        number: 20,
        state: "OPEN",
      }],
    },
    {
      ...input.linked_issues[0],
      number: 20,
      parent_number: 11,
      sub_issue_count: 1,
      sub_issues: [{
        repository: input.repository,
        number: 30,
        state: "OPEN",
      }],
    },
  ],
})), ["missing-open-sub-issues"]);
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
  linked_issues: [{
    ...input.linked_issues[0],
    blocked_by_count: 101,
    blocked_by: Array.from({ length: 100 }, (_, index) => ({
      repository: input.repository,
      number: index + 1,
      state: "OPEN",
    })),
  }],
})).includes("blocked-by-truncated"));
assert.ok(blockerCodes(analyzePullRequest({
  ...input,
  linked_issues: [{
    ...input.linked_issues[0],
    blocking_count: 101,
    blocking: Array.from({ length: 100 }, (_, index) => ({
      repository: input.repository,
      number: index + 1,
      state: "OPEN",
    })),
  }],
})).includes("blocking-truncated"));
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
const missingSubIssueContext = {
  readiness: analyzePullRequest({
    ...input,
    linked_issues: [{
      ...input.linked_issues[0],
      sub_issue_count: 1,
      sub_issues: [{
        repository: input.repository,
        number: 20,
        state: "OPEN",
      }],
    }],
  }),
  trusted_readiness_policy_sha256: "d".repeat(64),
};
const missingSubIssueBlocker =
  missingSubIssueContext.readiness.deterministic_blockers.find(
    (item) => item.code === "missing-open-sub-issues",
  );
assert.equal(missingSubIssueBlocker.source, "pr-linkage");
assert.match(missingSubIssueBlocker.message, /closes #10.*#20/);
const missingSubIssueReadiness = evaluateReadiness({
  context: missingSubIssueContext,
  review: {
    findings: [],
    readiness: { verdict: "pass", blockers: [] },
  },
  workflowSourceSha: "c".repeat(40),
  model: "gpt-5.6-terra",
  effort: "medium",
});
assert.equal(missingSubIssueReadiness.stage_verdicts.pr_review, "fail");
assert.equal(missingSubIssueReadiness.stage_verdicts.issue_review, "pass");
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
assert.notEqual(
  analyzePullRequest(input).snapshot_sha256,
  analyzePullRequest({
    ...input,
    linked_issues: [{
      ...input.linked_issues[0],
      blocked_by: input.linked_issues[0].blocked_by.map(
        (dependency, index) => index === 0
          ? { ...dependency, state: "CLOSED" }
          : dependency,
      ),
    }],
  }).snapshot_sha256,
);
assert.notEqual(
  analyzePullRequest(input).snapshot_sha256,
  analyzePullRequest({
    ...input,
    linked_issues: [{
      ...input.linked_issues[0],
      blocked_by_count: input.linked_issues[0].blocked_by_count + 1,
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
            state: "OPEN",
            issueType: { name: "Feature" },
            parent: null,
            subIssues: { totalCount: 0, nodes: [] },
            blockedBy: {
              totalCount: input.linked_issues[0].blocked_by_count,
              nodes: input.linked_issues[0].blocked_by.map((dependency) => ({
                repository: { nameWithOwner: dependency.repository },
                number: dependency.number,
                state: dependency.state,
              })),
            },
            blocking: {
              totalCount: input.linked_issues[0].blocking_count,
              nodes: input.linked_issues[0].blocking.map((dependency) => ({
                repository: { nameWithOwner: dependency.repository },
                number: dependency.number,
                state: dependency.state,
              })),
            },
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

  const manyFixture = structuredClone(fixture);
  manyFixture.repository.pullRequest.closingIssuesReferences = {
    totalCount: manyLinkedIssues.length,
    nodes: manyLinkedIssues.map((issue) => ({
      repository: { nameWithOwner: issue.repository },
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      issueType: { name: issue.issue_type },
      parent: issue.parent_number == null
        ? null
        : { number: issue.parent_number },
      subIssues: {
        totalCount: issue.sub_issue_count ?? 0,
        nodes: (issue.sub_issues ?? []).map((subIssue) => ({
          repository: { nameWithOwner: subIssue.repository },
          number: subIssue.number,
          state: subIssue.state,
        })),
      },
      blockedBy: {
        totalCount: issue.blocked_by_count ?? 0,
        nodes: (issue.blocked_by ?? []).map((dependency) => ({
          repository: { nameWithOwner: dependency.repository },
          number: dependency.number,
          state: dependency.state,
        })),
      },
      blocking: {
        totalCount: issue.blocking_count ?? 0,
        nodes: (issue.blocking ?? []).map((dependency) => ({
          repository: { nameWithOwner: dependency.repository },
          number: dependency.number,
          state: dependency.state,
        })),
      },
    })),
  };
  fs.writeFileSync(fixtureFile, JSON.stringify(manyFixture));
  const manyReadiness = analyzePullRequest(manyLinkedIssuesInput);
  const manyResult = verify(manyReadiness.snapshot_sha256);
  assert.equal(manyResult.status, 0, manyResult.stderr);
  fs.writeFileSync(fixtureFile, JSON.stringify(fixture));

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
    pullRequest.closingIssuesReferences.nodes[0].subIssues = {
      totalCount: 1,
      nodes: [{
        repository: { nameWithOwner: input.repository },
        number: 20,
        state: "OPEN",
      }],
    };
  });
  assertStale((pullRequest) => {
    pullRequest.closingIssuesReferences.nodes[0].blockedBy.nodes[0].state =
      "CLOSED";
  });
  assertStale((pullRequest) => {
    pullRequest.closingIssuesReferences.nodes[0].blocking.totalCount += 1;
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
