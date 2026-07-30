#!/usr/bin/env node

import fs from "node:fs";
import { analyzePullRequest, sha256 } from "./common.mjs";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const contextFile = required("PR_CONTEXT_FILE");
const context = JSON.parse(fs.readFileSync(contextFile, "utf8"));
context.readiness = analyzePullRequest({
  repository: required("GITHUB_REPOSITORY"),
  number: Number(required("PULL_REQUEST_NUMBER")),
  title: context.pull_request?.title,
  body: context.pull_request?.body,
  body_truncated: context.pull_request?.body_truncated,
  base_sha: required("PR_BASE_SHA"),
  head_sha: required("PR_HEAD_SHA"),
  linked_issues: context.linked_issues,
  linked_issue_count: context.linked_issue_count,
  unresolved_openai_thread_count: context.unresolved_openai_thread_count,
  review_threads_truncated: context.review_threads_truncated,
  trigger_comment_id: context.trigger_comment_id,
});
context.trusted_readiness_policy = required("PR_READINESS_INSTRUCTIONS");
context.trusted_readiness_policy_sha256 = sha256(
  context.trusted_readiness_policy,
);
context.readiness_context_sha256 = sha256(JSON.stringify({
  snapshot_sha256: context.readiness.snapshot_sha256,
  trusted_policy_sha256: context.trusted_readiness_policy_sha256,
}));
fs.writeFileSync(contextFile, `${JSON.stringify(context, null, 2)}\n`, {
  encoding: "utf8",
  mode: 0o600,
});
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(
    process.env.GITHUB_OUTPUT,
    `snapshot_sha256=${context.readiness.snapshot_sha256}\n`,
  );
  fs.appendFileSync(
    process.env.GITHUB_OUTPUT,
    `context_sha256=${context.readiness_context_sha256}\n`,
  );
  fs.appendFileSync(
    process.env.GITHUB_OUTPUT,
    `deterministic_blocker_count=${context.readiness.deterministic_blockers.length}\n`,
  );
}
