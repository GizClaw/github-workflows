import crypto from "node:crypto";
import { PREFIXED_TITLE, analyzeIssue } from "../issue-review/common.mjs";

export const PR_READINESS_SCHEMA_VERSION = 1;

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function blocker(source, code, message) {
  return { source, code, message };
}

export function analyzePullRequest(input) {
  const pullRequest = {
    repository: String(input.repository ?? ""),
    number: Number(input.number),
    title: String(input.title ?? ""),
    body: String(input.body ?? ""),
    body_truncated: input.body_truncated === true,
    base_sha: String(input.base_sha ?? ""),
    head_sha: String(input.head_sha ?? ""),
    trigger_comment_id: input.trigger_comment_id == null
      ? null : String(input.trigger_comment_id),
  };
  const linkedIssues = (input.linked_issues ?? [])
    .map((issue) => analyzeIssue(issue, { implementationIssue: false }))
    .sort((left, right) => (
      left.snapshot.repository.localeCompare(right.snapshot.repository)
      || left.snapshot.number - right.snapshot.number
    ));
  const sameRepository = linkedIssues.filter(
    (issue) => issue.snapshot.repository.toLowerCase()
      === pullRequest.repository.toLowerCase(),
  );
  const implementationIssues = sameRepository.filter(
    (issue) => issue.snapshot.issue_type.toLowerCase() !== "task",
  );
  const deterministicBlockers = [];
  if (!PREFIXED_TITLE.test(pullRequest.title)) {
    deterministicBlockers.push(blocker(
      "pr-format",
      "invalid-title",
      "Pull-request title must use the lowercase `prefix: Subject` format.",
    ));
  }
  if (!pullRequest.body.trim()) {
    deterministicBlockers.push(blocker(
      "pr-format",
      "missing-body",
      "Pull-request body must describe the delivered change and validation.",
    ));
  }
  if (pullRequest.body_truncated) {
    deterministicBlockers.push(blocker(
      "pr-format",
      "pr-body-truncated",
      "The workflow could not snapshot the complete pull-request body and must fail closed.",
    ));
  }
  if (implementationIssues.length === 0) {
    deterministicBlockers.push(blocker(
      "pr-linkage",
      "missing-closing-issue",
      "Pull request must natively close at least one same-repository implementation Issue.",
    ));
  }
  if (Number(input.linked_issue_count ?? linkedIssues.length) > linkedIssues.length) {
    deterministicBlockers.push(blocker(
      "pr-linkage",
      "too-many-closing-issues",
      "The workflow could not review every native closing Issue within its configured bound.",
    ));
  }
  if (Number(input.unresolved_openai_thread_count ?? 0) > 0) {
    deterministicBlockers.push(blocker(
      "review-thread",
      "unresolved-actionable-threads",
      `Pull request has ${Number(input.unresolved_openai_thread_count)} unresolved OpenAI review thread(s).`,
    ));
  }
  if (input.review_threads_truncated === true) {
    deterministicBlockers.push(blocker(
      "review-thread",
      "review-thread-query-truncated",
      "The workflow could not verify every review thread and must fail closed.",
    ));
  }
  for (const issue of linkedIssues) {
    deterministicBlockers.push(...issue.deterministic_blockers.map((item) => ({
      ...item,
      issue_repository: issue.snapshot.repository,
      issue_number: issue.snapshot.number,
    })));
  }
  const snapshot = {
    ...pullRequest,
    linked_issue_count: Number(input.linked_issue_count ?? linkedIssues.length),
    unresolved_openai_thread_count: Number(
      input.unresolved_openai_thread_count ?? 0,
    ),
    review_threads_truncated: input.review_threads_truncated === true,
    linked_issues: linkedIssues.map((issue) => ({
      snapshot: issue.snapshot,
      snapshot_sha256: issue.snapshot_sha256,
    })),
  };
  return {
    schema_version: PR_READINESS_SCHEMA_VERSION,
    snapshot,
    snapshot_sha256: sha256(JSON.stringify(snapshot)),
    deterministic_blockers: deterministicBlockers,
  };
}

export function evaluateReadiness({
  context,
  review,
  workflowSourceSha,
  model,
  effort,
}) {
  const modelBlockers = (review.readiness?.blockers ?? []).map((item) => ({
    source: item.category,
    code: item.code,
    message: item.body,
    title: item.title,
    ...(item.issue_number == null
      ? {}
      : { issue_number: item.issue_number }),
  }));
  const prBlockers = [
    ...context.readiness.deterministic_blockers.filter((item) => (
      ["pr-format", "pr-linkage", "review-thread"].includes(item.source)
    )),
    ...modelBlockers.filter((item) => item.source === "pr-format"),
  ];
  const issueBlockers = [
    ...context.readiness.deterministic_blockers.filter(
      (item) => item.source === "issue-format",
    ),
    ...modelBlockers.filter((item) => item.source === "issue-design"),
  ];
  const codeBlockers = [
    ...modelBlockers.filter((item) => item.source === "plan-conformance"),
    ...review.findings.map((item) => ({
      source: "code-review",
      code: item.priority,
      message: `${item.path}:${item.line}: ${item.title}`,
    })),
  ];
  const blockers = [
    ...prBlockers,
    ...issueBlockers,
    ...codeBlockers,
  ];
  return {
    schema_version: PR_READINESS_SCHEMA_VERSION,
    repository: context.readiness.snapshot.repository,
    pull_request_number: context.readiness.snapshot.number,
    base_sha: context.readiness.snapshot.base_sha,
    head_sha: context.readiness.snapshot.head_sha,
    snapshot_sha256: context.readiness.snapshot_sha256,
    trusted_policy_sha256: context.trusted_readiness_policy_sha256,
    workflow_source_sha: workflowSourceSha,
    model,
    effort,
    stage_verdicts: {
      pr_review: prBlockers.length === 0 ? "pass" : "fail",
      issue_review: issueBlockers.length === 0 ? "pass" : "fail",
      code_review: codeBlockers.length === 0 ? "pass" : "fail",
    },
    verdict: blockers.length === 0 ? "pass" : "fail",
    blockers,
  };
}
