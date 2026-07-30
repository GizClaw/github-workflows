#!/usr/bin/env node

import fs from "node:fs";
import { analyzePullRequest } from "./common.mjs";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

async function fetchPullRequest() {
  if (process.env.PR_READINESS_VERIFY_INPUT_FILE) {
    const payload = JSON.parse(fs.readFileSync(
      process.env.PR_READINESS_VERIFY_INPUT_FILE,
      "utf8",
    ));
    if (payload.errors?.length) {
      throw new Error(`GitHub GraphQL failed: ${payload.errors[0].message}`);
    }
    return payload.data ?? payload;
  }
  const [owner, repo] = required("GITHUB_REPOSITORY").split("/");
  const response = await fetch(
    process.env.GITHUB_GRAPHQL_URL ?? "https://api.github.com/graphql",
    {
      method: "POST",
      headers: {
        authorization: `bearer ${required("GITHUB_TOKEN")}`,
        "content-type": "application/json",
        "user-agent": "openai-pr-readiness",
      },
      body: JSON.stringify({
        query: `
          query($owner: String!, $repo: String!, $number: Int!) {
            repository(owner: $owner, name: $repo) {
              nameWithOwner
              pullRequest(number: $number) {
                title
                body
                baseRefOid
                headRefOid
                closingIssuesReferences(first: 20) {
                  totalCount
                  nodes {
                    repository { nameWithOwner }
                    number
                    title
                    body
                    issueType { name }
                    parent { number }
                    subIssues(first: 100) { nodes { number } }
                  }
                }
                reviewThreads(first: 100) {
                  pageInfo { hasNextPage }
                  nodes {
                    isResolved
                    comments(first: 1) {
                      nodes {
                        author { login }
                        body
                      }
                    }
                  }
                }
              }
            }
          }
        `,
        variables: {
          owner,
          repo,
          number: Number(required("PULL_REQUEST_NUMBER")),
        },
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`GitHub GraphQL returned HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (payload.errors?.length) {
    throw new Error(
      `GitHub GraphQL failed: ${payload.errors[0].message}`,
    );
  }
  return payload.data;
}

const data = await fetchPullRequest();
const pullRequest = data.repository?.pullRequest;
if (!pullRequest) throw new Error("Pull request was not found");
const linkedIssues = pullRequest.closingIssuesReferences.nodes
  .slice(0, 10)
  .map((issue) => ({
    repository: issue.repository.nameWithOwner,
    number: issue.number,
    title: String(issue.title).slice(0, 500),
    body: String(issue.body).slice(0, 80_000),
    issue_type: issue.issueType?.name || "",
    parent_number: issue.parent?.number ?? null,
    sub_issue_numbers: issue.subIssues.nodes.map((item) => item.number),
  }));
const current = analyzePullRequest({
  repository: data.repository.nameWithOwner,
  number: Number(required("PULL_REQUEST_NUMBER")),
  title: String(pullRequest.title).slice(0, 500),
  body: String(pullRequest.body).slice(0, 80_000),
  base_sha: pullRequest.baseRefOid,
  head_sha: pullRequest.headRefOid,
  linked_issues: linkedIssues,
  linked_issue_count: pullRequest.closingIssuesReferences.totalCount,
  unresolved_openai_thread_count: pullRequest.reviewThreads.nodes.filter(
    (thread) => (
      !thread.isResolved
      && thread.comments.nodes[0]?.author?.login === "github-actions[bot]"
      && /Badge\]\(https:\/\/img\.shields\.io\/badge\/P[0-3]-/
        .test(thread.comments.nodes[0]?.body || "")
    ),
  ).length,
  review_threads_truncated: pullRequest.reviewThreads.pageInfo.hasNextPage,
  trigger_comment_id: process.env.REQUEST_COMMENT_ID || null,
});
if (current.snapshot_sha256 !== required("EXPECTED_SNAPSHOT_SHA256")) {
  throw new Error(
    "PR metadata, native Issue linkage, linked Issue design, base/head, or review threads changed while readiness review was running",
  );
}
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(
    process.env.GITHUB_OUTPUT,
    `snapshot_sha256=${current.snapshot_sha256}\n`,
  );
}
