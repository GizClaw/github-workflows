import { allPages } from "./verify.mjs";
import { workflowPath } from "./receipts.mjs";

// Runs after admission upload using the review job's existing actions:write.
// Only whole runs of the opt-in pull_request gate workflow can be rerun; the
// review workflow and arbitrary jobs/check statuses are never mutated.
export async function refreshNativeGates({ github, context, gateWorkflow, number, headSha }) {
  if (!gateWorkflow) return [];
  const path = workflowPath(gateWorkflow);
  const repo = context.repo;
  const source = (await github.rest.actions.getWorkflowRun({ ...repo, run_id: context.runId })).data;
  if (source.run_attempt !== 1 || !["issue_comment", "workflow_dispatch", "issues"].includes(source.event)) return [];
  if (source.path === path) throw new Error("The native gate workflow cannot be the reviewer workflow");
  const workflow = (await github.rest.actions.getWorkflow({ ...repo, workflow_id: path.split("/").at(-1) })).data;
  if (workflow.path !== path || workflow.id === source.workflow_id) throw new Error("Native gate workflow identity mismatch");
  const pull = (await github.rest.pulls.get({ ...repo, pull_number: Number(number) })).data;
  if (pull.state !== "open" || pull.draft || pull.head.sha !== headSha) return [];
  const runs = await allPages(github.rest.actions.listWorkflowRuns, {
    ...repo, workflow_id: workflow.id, event: "pull_request", head_sha: headSha,
  }, "workflow_runs", 10);
  const eligible = runs.filter(run => run.workflow_id === workflow.id && run.path === path
    && run.event === "pull_request" && run.head_sha === headSha
    && run.repository?.id === pull.base.repo.id
    && run.pull_requests?.some(item => item.number === pull.number && item.base?.repo?.id === pull.base.repo.id));
  // A running gate follows the newest admission itself. Do not trigger a second
  // attempt while it is queued, waiting, or in progress, even if old runs failed.
  if (eligible.some(run => run.status !== "completed")) return [];
  const latest = eligible.sort((a, b) => b.id - a.id)[0];
  if (!latest) return [];
  // Re-read immediately before the mutation to avoid racing an existing rerun.
  const current = (await github.rest.actions.getWorkflowRun({ ...repo, run_id: latest.id })).data;
  const live = (await github.rest.pulls.get({ ...repo, pull_number: pull.number })).data;
  if (current.status !== "completed" || current.workflow_id !== workflow.id
      || current.path !== path || current.event !== "pull_request" || current.head_sha !== headSha
      || live.head.sha !== headSha || live.state !== "open" || live.draft) return [];
  await github.rest.actions.reRunWorkflow({ ...repo, run_id: current.id });
  return [current.id];
}
