import { isReviewRequestComment } from "./common.mjs";

// Run after the worker acquires its per-PR queue, before creating checks or
// loading checkpoints. Arrival order is not request order for dispatched runs.
export async function automaticDispatchFence({ github, context, sourceRunId, pull }) {
  if (context.eventName !== "workflow_dispatch" || !/^[1-9]\d*$/.test(String(sourceRunId))) {
    throw new Error("Invalid automatic review source");
  }
  const sourceId = Number(sourceRunId);
  if (!Number.isSafeInteger(sourceId) || !Number.isSafeInteger(context.runId)
    || sourceId >= context.runId || !Number.isSafeInteger(pull?.number)) {
    throw new Error("Invalid automatic review source");
  }
  let sequence = 0;
  const fresh = () => ({
    headers: { "cache-control": "no-cache" },
    cache_bust: `${context.runId}-${Date.now()}-${sequence++}`,
  });
  const [{ data: source }, { data: current }] = await Promise.all([
    github.rest.actions.getWorkflowRun({ ...context.repo, ...fresh(), run_id: sourceId }),
    github.rest.actions.getWorkflowRun({ ...context.repo, ...fresh(), run_id: context.runId }),
  ]);
  const sourceTime = Date.parse(source.created_at);
  const currentTime = Date.parse(current.created_at);
  if (source.id !== sourceId || current.id !== context.runId
    || source.event !== "pull_request_target" || current.event !== "workflow_dispatch"
    || source.run_attempt !== 1 || current.run_attempt !== 1
    || !Number.isSafeInteger(source.workflow_id) || source.workflow_id < 1
    || source.workflow_id !== current.workflow_id || !source.path || source.path !== current.path
    || !Number.isFinite(sourceTime) || !Number.isFinite(currentTime) || sourceTime > currentTime) {
    throw new Error("Automatic review source is not the original caller workflow");
  }
  // The PR association's nested head follows later pushes; only the run's
  // own head_sha is immutable. Do not use source.pull_requests[].head.sha.
  if (pull.state !== "open" || pull.draft || source.head_sha !== pull.head?.sha
    || !source.pull_requests?.some(pr => pr.number === pull.number)) {
    return { eligible: false, reason: "The automatic request no longer matches the open PR head" };
  }

  const comments = await github.paginate(github.rest.issues.listComments, {
    ...context.repo, ...fresh(), issue_number: pull.number,
    // since is exclusive and filters updated_at. Include the whole source
    // second, then compare immutable created_at timestamps below.
    since: new Date(sourceTime - 1000).toISOString(), per_page: 100,
  });
  for (const comment of comments) {
    if (!isReviewRequestComment({ body: comment.body,
      user_type: comment.user?.type, user_login: comment.user?.login })) continue;
    const requestedAt = Date.parse(comment.created_at);
    if (!Number.isFinite(requestedAt)) throw new Error("Review request has no valid creation time");
    // GitHub timestamps have second resolution: equal-second requests also win.
    // This only yields to a request; its own issue_comment resolver must still
    // validate admin permission and exact-head approval before lifting a limit.
    if (requestedAt >= sourceTime) return {
      eligible: false, reason: "A newer review comment supersedes this automatic request",
    };
  }
  return { eligible: true, reason: "No newer review request supersedes this automatic dispatch" };
}
