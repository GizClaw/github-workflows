import fs from "node:fs";
import { sha256 } from "../pr-readiness/common.mjs";

export const SOURCE_WORKFLOW = "GizClaw/github-workflows/.github/workflows/codex-openai-review.yml@latest";
export const admissionName = number => `review-gate-admission-pr-${number}`;
export const terminalName = number => `review-gate-terminal-pr-${number}`;
export const sourceJobName = (number, headSha) => `Review admission PR-${number} head-${headSha}`;
export const matchesSourceJob = (job, number, headSha) => job.name === sourceJobName(number, headSha)
  || job.name?.endsWith(` / ${sourceJobName(number, headSha)}`);
export const receiptHash = receipt => sha256(JSON.stringify(receipt));
export function workflowPath(value) {
  if (!/^(?:\.github\/workflows\/)?[A-Za-z0-9_-]+\.ya?ml$/.test(value || "")) {
    throw new Error("Expected one repository-local workflow filename");
  }
  return value.startsWith(".github/") ? value : `.github/workflows/${value}`;
}
export function policyFromEnv(env = process.env) {
  return {
    review: env.REVIEW_INSTRUCTIONS,
    issue: env.ISSUE_REVIEW_INSTRUCTIONS,
    // Match the existing prepare_readiness step's folded YAML value exactly:
    // issue instructions, one joining space, then PR-readiness instructions.
    readiness: `${env.ISSUE_REVIEW_INSTRUCTIONS ?? ""} ${env.PR_READINESS_INSTRUCTIONS ?? ""}`,
    model: "gpt-6.1-sol", effort: "low", codex_version: env.CODEX_VERSION,
    lfs_context_paths: env.LFS_CONTEXT_PATHS || "",
  };
}
export async function callerBlob(github, repo, path, ref) {
  const { data } = await github.rest.repos.getContent({ ...repo, path, ref });
  if (data.type !== "file" || !/^[a-f0-9]{40}$/.test(data.sha)) throw new Error("Missing immutable caller workflow");
  return data.sha;
}
export async function makeAdmission({ github, context, env = process.env }) {
  const run = (await github.rest.actions.getWorkflowRun({ ...context.repo, run_id: context.runId })).data;
  const path = workflowPath(run.path);
  if (Number(run.run_attempt) !== 1) throw new Error("Reviewer reruns cannot admit requests");
  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
    ...context.repo, run_id: context.runId, filter: "latest", per_page: 100,
  });
  const sourceJobs = jobs.filter(job => job.run_id === run.id && job.run_attempt === 1
    && matchesSourceJob(job, Number(env.PULL_REQUEST_NUMBER), env.PR_HEAD_SHA));
  if (sourceJobs.length !== 1) throw new Error("Missing or ambiguous native source admission job");
  return {
    schema: 1, kind: "admission", repository: `${context.repo.owner}/${context.repo.repo}`,
    repository_id: Number(env.REPOSITORY_ID), number: Number(env.PULL_REQUEST_NUMBER),
    head_sha: env.PR_HEAD_SHA, base_sha: env.PR_BASE_SHA,
    run_id: Number(context.runId), run_attempt: 1, source_job_id: sourceJobs[0].id,
    caller_path: path, caller_workflow_id: run.workflow_id,
    caller_sha: run.head_sha,
    caller_blob: await callerBlob(github, context.repo, path, run.head_sha),
    reviewer_sha: env.REVIEWER_SOURCE_SHA,
    trigger_comment_id: env.REQUEST_COMMENT_ID || null,
    policy: policyFromEnv(env),
  };
}
export function makeTerminal({ admission, admissionArtifactId, binding, readiness, reviewResult, publishResult, publicationId }) {
  if (readiness.snapshot_sha256 !== binding.snapshot_sha256
      || readiness.trusted_policy_sha256 !== sha256(admission.policy.readiness)
      || readiness.workflow_source_sha !== admission.reviewer_sha
      || readiness.head_sha !== admission.head_sha || readiness.base_sha !== admission.base_sha) {
    throw new Error("Review evidence does not match the accepted admission context");
  }
  return {
    ...admission, kind: "terminal", admission_artifact_id: Number(admissionArtifactId),
    admission_sha256: receiptHash(admission), ...binding,
    execution: reviewResult === "success" ? "completed" : "incomplete",
    publication: { status: publishResult, review_id: Number(publicationId) },
    stages: Object.fromEntries(["pr", "issue", "code"].map(stage => [stage, {
      status: reviewResult === "success" ? "completed" : "incomplete",
      verdict: readiness.stage_verdicts?.[`${stage}_review`] || "fail",
    }])),
  };
}
export function writeReceipt(path, receipt) {
  fs.writeFileSync(path, JSON.stringify(receipt), { encoding: "utf8", mode: 0o600 });
}
