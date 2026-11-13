import { collectClosingIssues, graphqlIssueFetcher } from "./closing-issues.mjs";
import { analyzePullRequest, sha256 } from "./common.mjs";

function validateThreads(threads) {
  if (!Array.isArray(threads?.nodes) || typeof threads.pageInfo?.hasNextPage !== "boolean"
      || threads.nodes.some(thread => typeof thread.isResolved !== "boolean"
        || typeof thread.id !== "string" || !Array.isArray(thread.comments?.nodes))) {
    throw new Error("Malformed review-thread API response");
  }
}

// Shared API collection for the reviewer and secretless pinned gate. PR/Issue
// text remains data; callers must never import code from collected artifacts.
export async function collectDiscussion({ github, context, number, triggerCommentId: triggerCommentIdInput = "" }) {
  const clip = (value, length) => String(value ?? "").slice(0, length);
  const data = await github.graphql(`
    query(
      $owner: String!,
      $repo: String!,
      $number: Int!
    ) {
      repository(owner: $owner, name: $repo) {
        nameWithOwner
        pullRequest(number: $number) {
          title
          body
          reviewThreads(first: 100) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              isResolved
              isOutdated
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
  `, {
    owner: context.repo.owner,
    repo: context.repo.repo,
    number: Number(number),
  });
  const pullRequest = data.repository.pullRequest;
  if (!pullRequest) throw new Error('Pull request was not found');
  validateThreads(pullRequest.reviewThreads);
  // Fetch every page before reporting complete thread evidence.
  const cursors = new Set();
  while (pullRequest.reviewThreads.pageInfo.hasNextPage) {
    const after = pullRequest.reviewThreads.pageInfo.endCursor;
    if (!after || cursors.has(after)) {
      throw new Error('Review thread pagination did not advance');
    }
    cursors.add(after);
    const page = await github.graphql(`
      query($owner: String!, $repo: String!, $number: Int!, $after: String!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) {
            reviewThreads(first: 100, after: $after) {
              pageInfo { hasNextPage endCursor }
              nodes {
                id
                isResolved
                isOutdated
                comments(first: 1) { nodes { author { login } body } }
              }
            }
          }
        }
      }
    `, {
      owner: context.repo.owner, repo: context.repo.repo,
      number: Number(number), after,
    });
    const threads = page.repository.pullRequest.reviewThreads;
    validateThreads(threads);
    pullRequest.reviewThreads.nodes.push(...threads.nodes);
    pullRequest.reviewThreads.pageInfo = threads.pageInfo;
  }
  // The Issues this pull request closes are the ones its body
  // names with a closing keyword; GitHub's Development links are
  // not consulted.
  const closing = await collectClosingIssues({
    repository: data.repository.nameWithOwner,
    body: pullRequest.body,
    fetchIssues: graphqlIssueFetcher(async (query) => (
      await github.request('POST /graphql', { query })
    ).data),
  });
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner: context.repo.owner, repo: context.repo.repo,
    issue_number: Number(number), per_page: 100,
  });
  // The request keeps its own budget only if it survives the
  // window, so it is restored when newer comments crowd it out.
  const triggerCommentId = String(
    triggerCommentIdInput || '',
  );
  const recentComments = comments.slice(-20);
  const triggerComment = triggerCommentId
    && comments.find(
      (comment) => String(comment.id) === triggerCommentId,
    );
  const selectedComments = triggerComment
    && !recentComments.some(
      (comment) => String(comment.id) === triggerCommentId,
    )
    ? [triggerComment, ...recentComments]
    : recentComments;
  const discussion = {
    live_metadata: { title: pullRequest.title, body: pullRequest.body, threads: pullRequest.reviewThreads.nodes },
    repository: data.repository.nameWithOwner,
    pull_request: {
      title: clip(pullRequest.title, 500),
      body: clip(pullRequest.body, 80_000),
      body_truncated:
        String(pullRequest.body ?? '').length > 80_000,
    },
    linked_issue_count: closing.linked_issue_count,
    linked_issues: closing.linked_issues,
    unresolved_openai_thread_count: pullRequest.reviewThreads.nodes
      .filter((thread) => (
        !thread.isResolved
        && thread.comments.nodes[0]?.author?.login
          === 'github-actions[bot]'
        && /Badge\]\(https:\/\/img\.shields\.io\/badge\/P[0-3]-/
          .test(thread.comments.nodes[0]?.body || '')
      ))
      .length,
    review_threads_truncated:
      pullRequest.reviewThreads.pageInfo.hasNextPage,
    trigger_comment_id: triggerCommentIdInput || null,
    comments: selectedComments.map((comment) => {
      const isTrigger = String(comment.id) === triggerCommentId;
      const limit = isTrigger ? 8_000 : 2_000;
      return {
        id: String(comment.id),
        author: comment.user.login,
        author_is_bot: comment.user.type === 'Bot'
          || /\[bot\]$/i.test(comment.user.login || ''),
        association: comment.author_association,
        created_at: comment.created_at,
        is_trigger: isTrigger,
        body: clip(comment.body, limit),
        body_truncated:
          String(comment.body ?? '').length > limit,
      };
    }),
  };
  return discussion;
}

export function gateContext(discussion, { repository, number, baseSha, headSha, policy, requireComplete = true }) {
  const readiness = analyzePullRequest({
    repository, number, ...discussion.pull_request,
    base_sha: baseSha, head_sha: headSha,
    linked_issues: discussion.linked_issues,
    linked_issue_count: discussion.linked_issue_count,
    unresolved_openai_thread_count: discussion.unresolved_openai_thread_count,
    review_threads_truncated: discussion.review_threads_truncated,
    trigger_comment_id: discussion.trigger_comment_id,
  });
  if (requireComplete && (discussion.pull_request.body_truncated || discussion.review_threads_truncated
      || readiness.deterministic_blockers.some(item => /truncated|too-many/.test(item.code)))) {
    throw new Error("Incomplete canonical review context");
  }
  return {
    snapshot_sha256: readiness.snapshot_sha256,
    policy_sha256: sha256(JSON.stringify(policy)),
    context_sha256: sha256(JSON.stringify({
      snapshot_sha256: readiness.snapshot_sha256,
      live_metadata: discussion.live_metadata,
      issue_revisions: discussion.linked_issues.map(issue => [issue.repository, issue.number, issue.updated_at]),
    })),
  };
}
