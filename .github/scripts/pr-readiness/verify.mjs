#!/usr/bin/env node

import fs from "node:fs";
import {
  collectClosingIssues,
  graphqlIssueFetcher,
} from "./closing-issues.mjs";
import { analyzePullRequest } from "./common.mjs";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const fixture = process.env.PR_READINESS_VERIFY_INPUT_FILE
  ? JSON.parse(fs.readFileSync(
    process.env.PR_READINESS_VERIFY_INPUT_FILE,
    "utf8",
  ))
  : null;

async function graphqlRequest(query, variables = {}) {
  const response = await fetch(
    process.env.GITHUB_GRAPHQL_URL ?? "https://api.github.com/graphql",
    {
      method: "POST",
      headers: {
        authorization: `bearer ${required("GITHUB_TOKEN")}`,
        "content-type": "application/json",
        "user-agent": "openai-pr-readiness",
      },
      body: JSON.stringify({ query, variables }),
    },
  );
  if (!response.ok) {
    throw new Error(`GitHub GraphQL returned HTTP ${response.status}`);
  }
  return response.json();
}

async function fetchPullRequest(after = null) {
  if (fixture) {
    if (fixture.errors?.length) {
      throw new Error(`GitHub GraphQL failed: ${fixture.errors[0].message}`);
    }
    return fixture.data ?? fixture;
  }
  const [owner, repo] = required("GITHUB_REPOSITORY").split("/");
  const payload = await graphqlRequest(
    `
      query($owner: String!, $repo: String!, $number: Int!, $after: String) {
        repository(owner: $owner, name: $repo) {
          nameWithOwner
          pullRequest(number: $number) {
            title
            body
            baseRefOid
            headRefOid
            reviewThreads(first: 100, after: $after) {
              pageInfo { hasNextPage endCursor }
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
    {
      owner,
      repo,
      after,
      number: Number(required("PULL_REQUEST_NUMBER")),
    },
  );
  if (payload.errors?.length) {
    throw new Error(
      `GitHub GraphQL failed: ${payload.errors[0].message}`,
    );
  }
  return payload.data;
}

// A fixture lists the Issues its repository would return, keyed `owner/repo#N`.
const fetchIssues = fixture
  ? async (references) => references.map((reference) => (
    fixture.issues?.[`${reference.repository}#${reference.number}`] ?? null
  ))
  : graphqlIssueFetcher(graphqlRequest);

const data = await fetchPullRequest();
const pullRequest = data.repository?.pullRequest;
if (!pullRequest) throw new Error("Pull request was not found");
const cursors = new Set();
while (pullRequest.reviewThreads.pageInfo.hasNextPage) {
  const after = pullRequest.reviewThreads.pageInfo.endCursor;
  if (!after || cursors.has(after)) {
    throw new Error("Review thread pagination did not advance");
  }
  cursors.add(after);
  const page = await fetchPullRequest(after);
  const next = page.repository?.pullRequest;
  if (!next || next.baseRefOid !== pullRequest.baseRefOid ||
      next.headRefOid !== pullRequest.headRefOid) {
    throw new Error("Pull request changed during review thread pagination");
  }
  pullRequest.reviewThreads.nodes.push(...next.reviewThreads.nodes);
  pullRequest.reviewThreads.pageInfo = next.reviewThreads.pageInfo;
}
const closing = await collectClosingIssues({
  repository: data.repository.nameWithOwner,
  body: pullRequest.body,
  fetchIssues,
});
const current = analyzePullRequest({
  repository: data.repository.nameWithOwner,
  number: Number(required("PULL_REQUEST_NUMBER")),
  title: String(pullRequest.title).slice(0, 500),
  body: String(pullRequest.body).slice(0, 80_000),
  body_truncated: String(pullRequest.body).length > 80_000,
  base_sha: pullRequest.baseRefOid,
  head_sha: pullRequest.headRefOid,
  linked_issues: closing.linked_issues,
  linked_issue_count: closing.linked_issue_count,
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
    "PR metadata, closing-Issue linkage, linked Issue design, base/head, or review threads changed while readiness review was running",
  );
}
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(
    process.env.GITHUB_OUTPUT,
    `snapshot_sha256=${current.snapshot_sha256}\n`,
  );
}
