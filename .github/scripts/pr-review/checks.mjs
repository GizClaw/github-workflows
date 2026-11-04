const VERDICTS = {
  pr: "OpenAI PR Review",
  issue: "OpenAI Issue Review",
  code: "OpenAI Code Review",
};
const NATIVE_STAGES = new Set([
  "review / rerun-guard", "review / resolve", "review / start",
  "review / review", "review / publish", "review / finalize",
]);
const SUPERSEDED = new Set(["failure", "cancelled", "timed_out"]);

function nativeJob(check, owner, repo, serverUrl) {
  if (!NATIVE_STAGES.has(check.name) || check.status !== "completed"
    || !SUPERSEDED.has(check.conclusion)) return null;
  try {
    const url = new URL(check.details_url);
    const parts = url.pathname.split("/");
    if (url.origin !== new URL(serverUrl).origin || url.search || url.hash
      || parts.length !== 8 || parts[1] !== owner || parts[2] !== repo
      || parts[3] !== "actions" || parts[4] !== "runs" || parts[6] !== "job"
      || !/^\d+$/.test(parts[5]) || !/^\d+$/.test(parts[7])) return null;
    const runId = Number(parts[5]);
    const jobId = Number(parts[7]);
    return Number.isSafeInteger(runId) && Number.isSafeInteger(jobId)
      ? { runId, jobId } : null;
  } catch {
    return null;
  }
}

// A successful comment-triggered retry runs on the default branch. Its explicit
// verdict checks reach the PR head, but GitHub leaves earlier native jobs there.
export async function reconcileSupersededChecks({
  github, owner, repo, pullNumber, headSha, runId, runAttempt, checkIds,
  workflowRepository, serverUrl = "https://github.com",
}) {
  const skipped = reason => ({ updated: [], skipped: reason });
  let readSequence = 0;
  // Metadata caches must not let an older successful review authorize cleanup.
  const freshRead = () => ({
    headers: { "cache-control": "no-cache" },
    cache_bust: `${runId}-${runAttempt}-${Date.now()}-${readSequence++}`,
  });
  if (!/^[0-9a-f]{40}$/.test(headSha || "")
    || ![pullNumber, runId, runAttempt].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new Error("Invalid review identity for check reconciliation");
  }
  const ids = Object.keys(VERDICTS).map(key => Number(checkIds?.[key]));
  if (new Set(ids).size !== 3 || !ids.every(id => Number.isSafeInteger(id) && id > 0)) {
    return skipped("The three current verdict checks are required");
  }
  const verdicts = await Promise.all(Object.entries(VERDICTS).map(async ([key, name]) => {
    const { data } = await github.rest.checks.get({ owner, repo, ...freshRead(), check_run_id: Number(checkIds[key]) });
    return { key, name, data };
  }));
  const appId = verdicts[0].data.app?.id;
  if (!Number.isSafeInteger(appId) || appId < 1 || !verdicts.every(({ key, name, data }) => (
    data.id === Number(checkIds[key]) && data.head_sha === headSha && data.name === name && data.status === "completed"
    && data.conclusion === "success" && data.app?.id === appId
    && data.app?.slug === "github-actions"
    && data.external_id === `${runId}:${runAttempt}:${pullNumber}:${key}`
  ))) return skipped("The current run has not passed all three verdict checks");

  const { data: currentRun } = await github.rest.actions.getWorkflowRun({ owner, repo, ...freshRead(), run_id: runId });
  const created = Date.parse(currentRun.created_at);
  if (currentRun.id !== runId || currentRun.run_attempt !== runAttempt
    || !Number.isSafeInteger(currentRun.workflow_id) || !currentRun.path
    || !Number.isFinite(created) || !workflowRepository) {
    throw new Error("Incomplete current workflow identity");
  }
  const checks = await github.paginate(github.rest.checks.listForRef, {
    owner, repo, ...freshRead(), ref: headSha, filter: "latest", per_page: 100,
  });
  const latestVerdictsMatch = list => verdicts.every(({ name, data }) => {
    const newest = list.filter(check => check.name === name && check.app?.id === appId)
      .reduce((latest, check) => !latest || check.id > latest.id ? check : latest, null);
    return newest?.id === data.id && newest.status === "completed" && newest.conclusion === "success";
  });
  if (!latestVerdictsMatch(checks)) return skipped("A newer review owns this head");

  const runs = new Map();
  const candidates = [];
  for (const check of checks) {
    if (check.head_sha !== headSha || check.app?.id !== appId || check.app?.slug !== "github-actions") continue;
    const jobRef = nativeJob(check, owner, repo, serverUrl);
    if (!jobRef || jobRef.runId >= runId) continue;
    if (!runs.has(jobRef.runId)) {
      const { data } = await github.rest.actions.getWorkflowRun({ owner, repo, ...freshRead(), run_id: jobRef.runId });
      runs.set(jobRef.runId, data);
    }
    const previous = runs.get(jobRef.runId);
    const previousCreated = Date.parse(previous.created_at);
    if (previous.id !== jobRef.runId || previous.status !== "completed"
      || previous.event !== "pull_request_target" || previous.head_sha !== headSha
      || previous.workflow_id !== currentRun.workflow_id || previous.path !== currentRun.path
      || !Number.isFinite(previousCreated) || previousCreated > created
      || !previous.pull_requests?.some(pr => pr.number === pullNumber && pr.head?.sha === headSha)
      || !previous.referenced_workflows?.some(workflow => workflow.path?.startsWith(
        `${workflowRepository}/.github/workflows/codex-openai-review.yml@`,
      ))) continue;
    const { data: job } = await github.rest.actions.getJobForWorkflowRun({ owner, repo, ...freshRead(), job_id: jobRef.jobId });
    if (job.run_id !== previous.id || job.name !== check.name || job.status !== "completed"
      || job.conclusion !== check.conclusion || job.check_run_url !== check.url) continue;
    candidates.push(check);
  }
  if (!candidates.length) return { updated: [], skipped: null };

  // Collect and validate all evidence before writing. Do not let an older
  // finalizer supersede checks after a new head or a new review has started.
  const { data: pull } = await github.rest.pulls.get({ owner, repo, ...freshRead(), pull_number: pullNumber });
  if (pull.state !== "open" || pull.draft || pull.head?.sha !== headSha) return skipped("The pull request changed");
  const finalChecks = await github.paginate(github.rest.checks.listForRef, {
    owner, repo, ...freshRead(), ref: headSha, filter: "latest", per_page: 100,
  });
  if (!latestVerdictsMatch(finalChecks)) return skipped("A newer review owns this head");

  const updated = [];
  for (const check of candidates) {
    const latest = finalChecks.find(item => item.id === check.id);
    if (latest?.status !== "completed" || latest.conclusion !== check.conclusion) continue;
    await github.rest.checks.update({
      owner, repo, check_run_id: check.id, status: "completed", conclusion: "neutral",
      output: {
        title: "Superseded review execution",
        summary: [
          `This earlier review task ended with \`${check.conclusion}\`.`,
          `The [newer review run](${serverUrl}/${owner}/${repo}/actions/runs/${runId}) fully passed commit \`${headSha}\`.`,
          `The [original execution and logs](${check.details_url}) remain available.`,
          "The OpenAI PR, Issue, and Code Review checks are the current verdicts; unrelated build checks are unchanged.",
        ].join("\n\n"),
      },
    });
    updated.push(check.id);
  }
  return { updated, skipped: null };
}
