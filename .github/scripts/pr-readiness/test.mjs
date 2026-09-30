#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  CLOSING_ISSUE_LIMIT,
  closingIssueReferences,
  collectClosingIssues,
  graphqlIssueFetcher,
} from "./closing-issues.mjs";
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
  body: "Closes #10\n\nImplements the plan.\n\nValidation: node test.mjs",
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
  body: [
    ...manyLinkedIssues.map((issue) => `Closes #${issue.number}`),
    "",
    "Implements the plan.",
  ].join("\n"),
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
const closingIssuesSource = fs.readFileSync(
  path.join(scriptDirectory, "closing-issues.mjs"),
  "utf8",
);
// Both collectors read the Issues the body closes through the shared module
// and never GitHub's Development links.
for (const source of [verifySource, workflowSource]) {
  assert.match(source, /collectClosingIssues\(/);
  assert.doesNotMatch(source, /closingIssuesReferences/);
  assert.doesNotMatch(source, /closedByPullRequestsReferences/);
}
assert.match(closingIssuesSource, /subIssues\(first: 100\)/);
assert.match(closingIssuesSource, /blockedBy\(first: 100\)/);
assert.match(closingIssuesSource, /blocking\(first: 100\)/);
assert.match(
  closingIssuesSource,
  /blocked_by_count:\s*issue\.blockedBy\.totalCount/,
);
assert.match(
  closingIssuesSource,
  /blocking_count:\s*issue\.blocking\.totalCount/,
);
// The reusable reviewer and the verifier both check out the module's
// dependency on the request parser's quoted-text stripping.
assert.equal(
  workflowSource.match(
    /\.github\/scripts\/pr-readiness\n\s+(?:\.github\/scripts\/pr-review\n\s+)?\.github\/scripts\/review-request\n/g,
  )?.length,
  2,
);

const references = (body) => closingIssueReferences(body, "GizClaw/example")
  .map((item) => `${item.repository}#${item.number}`);
assert.deepEqual(references("Closes #10"), ["GizClaw/example#10"]);
for (const keyword of [
  "close", "closes", "closed", "fix", "fixes", "fixed",
  "resolve", "resolves", "resolved", "CLOSES", "Fixes:",
]) {
  assert.deepEqual(
    references(`Summary.\n\n${keyword} #7.`),
    ["GizClaw/example#7"],
    keyword,
  );
}
assert.deepEqual(
  references([
    "Closes #10, fixes gizclaw/EXAMPLE#10 and resolves Other/repo#3.",
    "Closes https://github.com/Other/repo/issues/4",
    "Closes #11",
  ].join("\n")),
  ["GizClaw/example#10", "Other/repo#3", "Other/repo#4", "GizClaw/example#11"],
);
for (const body of [
  "",
  "Related to #10, but this does not close it.",
  "Part of #10. See #10.",
  "hotfixes #10 and discloses #10",
  "Closes 10",
  "Closes #0",
  "Closes #10abc",
  "Closes\n#10",
  "Closes https://github.com/Other/repo/pull/4",
  "`Closes #10`",
  "```\nCloses #10\n```",
  "> Closes #10",
  "<!-- Closes #10 -->",
  "<!--\nCloses #10\n",
  "    Closes #10",
  "\tCloses #10",
  "Summary.\n\n    Closes #10\n\n    Fixes #11\n",
]) {
  assert.deepEqual(references(body), [], JSON.stringify(body));
}
// Indentation alone is not code: up to three spaces, a paragraph's
// continuation line, and a list item's content still declare the Issue.
for (const body of [
  "   Closes #10",
  "Summary:\n    Closes #10",
  "- Linkage\n\n    Closes #10",
  "1. Linkage\n    - Closes #10",
  "    code\n\nCloses #10",
]) {
  assert.deepEqual(references(body), ["GizClaw/example#10"], JSON.stringify(body));
}

const graphqlIssue = (issue) => ({
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
});
{
  // One aliased request reads every reference; a pull request or missing
  // number is ignored, and any other GraphQL error fails closed.
  const queries = [];
  const fetchIssues = graphqlIssueFetcher(async (query) => {
    queries.push(query);
    return {
      data: {
        i0: { issue: graphqlIssue(input.linked_issues[0]) },
        i1: { issue: null },
        i2: null,
        i3: { issue: graphqlIssue(input.linked_issues[0]) },
      },
      errors: [
        { type: "NOT_FOUND", path: ["i1", "issue"], message: "not an Issue" },
        { type: "NOT_FOUND", path: ["i2"], message: "no repository" },
      ],
    };
  });
  const collected = await collectClosingIssues({
    repository: input.repository,
    body: "Closes #10, closes #11, closes Private/repo#1\nFixes Renamed/example#10",
    fetchIssues,
  });
  assert.equal(queries.length, 1);
  assert.match(
    queries[0],
    /i0: repository\(owner: "GizClaw", name: "example"\) \{ issue\(number: 10\)/,
  );
  assert.match(
    queries[0],
    /i2: repository\(owner: "Private", name: "repo"\) \{ issue\(number: 1\)/,
  );
  assert.equal(collected.linked_issue_count, 1);
  assert.deepEqual(
    analyzePullRequest({ ...input, ...collected }).snapshot_sha256,
    context.readiness.snapshot_sha256,
  );
  await assert.rejects(
    collectClosingIssues({
      repository: input.repository,
      body: "Closes #10",
      fetchIssues: graphqlIssueFetcher(async () => ({
        data: { i0: null },
        errors: [{ type: "RATE_LIMITED", message: "rate limit exceeded" }],
      })),
    }),
    /GitHub GraphQL failed: rate limit exceeded/,
  );
  await assert.rejects(
    collectClosingIssues({
      repository: input.repository,
      body: "Closes #10",
      fetchIssues: graphqlIssueFetcher(async () => ({})),
    }),
    /no closing-Issue data/,
  );
  const none = await collectClosingIssues({
    repository: input.repository,
    body: "Related to #10.",
    fetchIssues: graphqlIssueFetcher(async () => {
      throw new Error("no request is needed without references");
    }),
  });
  assert.deepEqual(none, { linked_issue_count: 0, linked_issues: [] });
  assert.ok(blockerCodes(analyzePullRequest({ ...input, ...none }))
    .includes("missing-closing-issue"));
  // References past the bound are counted, not read, so the analysis reports
  // the truncation.
  const requested = [];
  const bounded = await collectClosingIssues({
    repository: input.repository,
    body: Array.from(
      { length: CLOSING_ISSUE_LIMIT + 1 },
      (_, index) => `Closes #${index + 1}`,
    ).join("\n"),
    fetchIssues: async (items) => {
      requested.push(...items);
      return items.map((item) => graphqlIssue({
        ...input.linked_issues[0],
        number: item.number,
      }));
    },
  });
  assert.equal(requested.length, CLOSING_ISSUE_LIMIT);
  assert.equal(bounded.linked_issues.length, CLOSING_ISSUE_LIMIT);
  assert.equal(bounded.linked_issue_count, CLOSING_ISSUE_LIMIT + 1);
  assert.ok(blockerCodes(analyzePullRequest({ ...input, ...bounded }))
    .includes("too-many-closing-issues"));
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
  body: "Related to #10, but this does not close it.",
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
        reviewThreads: {
          pageInfo: { hasNextPage: false },
          nodes: [],
        },
      },
    },
    issues: {
      [`${input.repository}#10`]: graphqlIssue(input.linked_issues[0]),
    },
  };
  fs.writeFileSync(fixtureFile, JSON.stringify(fixture));
  const verify = (expected, network = false) => spawnSync(process.execPath, [
    ...(network ? ['--import', path.join(temporary, 'fetch.mjs')] : []),
    path.join(path.dirname(new URL(import.meta.url).pathname), "verify.mjs"),
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_REPOSITORY: input.repository,
      PULL_REQUEST_NUMBER: String(input.number),
      PR_READINESS_VERIFY_INPUT_FILE: network ? '' : fixtureFile,
      GITHUB_TOKEN: 'test-token',
      EXPECTED_SNAPSHOT_SHA256: expected,
      GITHUB_OUTPUT: outputFile,
    },
  });
  assert.equal(verify(context.readiness.snapshot_sha256).status, 0);
  const resolved = { isResolved: true, comments: { nodes: [] } };
  const pageOne = structuredClone(fixture);
  pageOne.repository.pullRequest.reviewThreads = {
    nodes: Array(100).fill(resolved),
    pageInfo: { hasNextPage: true, endCursor: 'first' },
  };
  const pageTwo = structuredClone(fixture);
  pageTwo.repository.pullRequest.reviewThreads = {
    nodes: Array(5).fill(resolved),
    pageInfo: { hasNextPage: false, endCursor: 'last' },
  };
  function mockPages(second, httpStatus = 200) {
    fs.writeFileSync(path.join(temporary, 'fetch.mjs'), `
      import assert from 'node:assert/strict';
      let call = 0;
      globalThis.fetch = async (_url, options) => {
        const request = JSON.parse(options.body);
        // The closing Issues are read once, after every thread page.
        if (/^query \\{ i0: repository/.test(request.query)) {
          assert.ok(call >= 2);
          return { ok: true, status: 200, json: async () => ({
            data: { i0: { issue: ${JSON.stringify(fixture.issues[`${input.repository}#10`])} } },
          }) };
        }
        assert.match(request.query, /after: \\$after/);
        assert.equal(request.variables.after, call === 0 ? null : 'first');
        const first = call++ === 0;
        return { ok: first || ${httpStatus} === 200, status: ${httpStatus},
          json: async () => ({data: first ? ${JSON.stringify(pageOne)} : ${JSON.stringify(second)}}) };
      };
    `);
  }
  mockPages(pageTwo);
  assert.equal(verify(context.readiness.snapshot_sha256, true).status, 0);
  const findingPage = structuredClone(pageTwo);
  findingPage.repository.pullRequest.reviewThreads.nodes.push({
    isResolved: false, comments: { nodes: [{author: {login: 'github-actions[bot]'},
      body: 'Badge](https://img.shields.io/badge/P1-orange)'}] },
  });
  mockPages(findingPage);
  assert.notEqual(verify(context.readiness.snapshot_sha256, true).status, 0);
  mockPages(pageTwo, 503);
  assert.match(verify(context.readiness.snapshot_sha256, true).stderr, /HTTP 503/);
  mockPages(pageOne);
  assert.match(verify(context.readiness.snapshot_sha256, true).stderr, /pagination did not advance/);
  const missingCursor = structuredClone(pageOne);
  missingCursor.repository.pullRequest.reviewThreads.pageInfo.endCursor = null;
  mockPages(missingCursor);
  assert.match(verify(context.readiness.snapshot_sha256, true).stderr, /pagination did not advance/);
  const changedHead = structuredClone(pageTwo);
  changedHead.repository.pullRequest.headRefOid = 'f'.repeat(40);
  mockPages(changedHead);
  assert.match(verify(context.readiness.snapshot_sha256, true).stderr, /changed during review thread pagination/);
  assert.match(
    fs.readFileSync(outputFile, "utf8"),
    new RegExp(context.readiness.snapshot_sha256),
  );

  const manyFixture = structuredClone(fixture);
  manyFixture.repository.pullRequest.body = manyLinkedIssuesInput.body;
  manyFixture.issues = Object.fromEntries(manyLinkedIssues.map((issue) => [
    `${issue.repository}#${issue.number}`,
    graphqlIssue(issue),
  ]));
  fs.writeFileSync(fixtureFile, JSON.stringify(manyFixture));
  const manyReadiness = analyzePullRequest(manyLinkedIssuesInput);
  const manyResult = verify(manyReadiness.snapshot_sha256);
  assert.equal(manyResult.status, 0, manyResult.stderr);
  fs.writeFileSync(fixtureFile, JSON.stringify(fixture));

  const assertStale = (mutate) => {
    const staleFixture = structuredClone(fixture);
    mutate(
      staleFixture.repository.pullRequest,
      staleFixture.issues[`${input.repository}#10`],
    );
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
  // Dropping the closing keyword or naming another Issue changes the linkage.
  assertStale((pullRequest) => {
    pullRequest.body = input.body.replace("Closes #10", "Related to #10");
  });
  assertStale((pullRequest) => {
    pullRequest.body = input.body.replace("Closes #10", "Closes #12");
  });
  assertStale((_pullRequest, issue) => {
    issue.body = `${issueBody}\nchanged`;
  });
  assertStale((_pullRequest, issue) => {
    issue.subIssues = {
      totalCount: 1,
      nodes: [{
        repository: { nameWithOwner: input.repository },
        number: 20,
        state: "OPEN",
      }],
    };
  });
  assertStale((_pullRequest, issue) => {
    issue.blockedBy.nodes[0].state = "CLOSED";
  });
  assertStale((_pullRequest, issue) => {
    issue.blocking.totalCount += 1;
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
