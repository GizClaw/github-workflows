import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { collectDiscussion, gateContext } from "../pr-readiness/collect.mjs";
import { SOURCE_WORKFLOW, admissionName, terminalName, workflowPath, callerBlob, receiptHash, matchesSourceJob } from "./receipts.mjs";

const sha = value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value > 0;
const insist = (test, message) => { if (!test) throw new Error(message); };

// Do not let an incomplete API page silently hide a newer admission. Endpoint
// totals and Link headers must agree. Bounds fail closed, including GitHub's
// 1,000-result workflow-run search cap (used by the refresh helper).
export async function allPages(method, args, key, limit = 100) {
  const items = [];
  let expected;
  const seen = new Set();
  for (let page = 1; page <= limit; page++) {
    const response = await method({ ...args, per_page: 100, page });
    const data = response.data;
    insist(Array.isArray(data?.[key]) && Number.isSafeInteger(data.total_count), "Malformed pagination response");
    if (expected === undefined) expected = data.total_count;
    insist(data.total_count === expected, "API pagination changed during collection; retry");
    for (const item of data[key]) {
      insist(integer(item.id) && !seen.has(item.id), "Duplicate or missing paginated item");
      seen.add(item.id);
      items.push(item);
    }
    const next = /rel="next"/.test(response.headers?.link || "");
    if (!next) {
      insist(items.length === expected, "Incomplete API pagination");
      return items;
    }
    insist(data[key].length > 0 && items.length < expected, "Pagination did not advance");
  }
  throw new Error("Pagination safety bound exceeded");
}

export async function readReceipt(github, repo, artifact) {
  insist(!artifact.expired && Date.parse(artifact.expires_at) > Date.now(), "Receipt expired");
  insist(integer(artifact.size_in_bytes) && artifact.size_in_bytes <= 131072, "Receipt archive exceeds size bound");
  const { data } = await github.rest.actions.downloadArtifact({ ...repo, artifact_id: artifact.id, archive_format: "zip" });
  const zip = Buffer.from(data);
  insist(zip.length <= 131072, "Receipt download exceeds size bound");
  // Python's stdlib is invoked in isolated mode. The ZIP is stdin data; no
  // entry is ever extracted, and no artifact code is loaded or executed.
  const json = execFileSync("python3", ["-I", fileURLToPath(new URL("./read-receipt.py", import.meta.url))], {
    input: zip, maxBuffer: 65536, cwd: process.env.RUNNER_TEMP || "/tmp",
  });
  return JSON.parse(json.toString("utf8"));
}

function sourceIdentity(run, repository, workflow, defaultBranch, admissionCandidate) {
  return !!(integer(run.id) && run.workflow_id === workflow.id && run.path === workflow.path
    && ["issue_comment", "workflow_dispatch", "issues"].includes(run.event)
    && run.repository?.id === repository.id && run.head_repository?.id === repository.id
    && run.head_branch === defaultBranch && sha(run.head_sha)
    && (admissionCandidate || (run.run_attempt === 1
      && run.referenced_workflows?.filter(item => item.path === SOURCE_WORKFLOW && sha(item.sha)).length === 1)));
}
export function validateOrigin({ artifact, run, repository, workflow, defaultBranch, admissionCandidate = false }) {
  const meta = artifact.workflow_run;
  return !!(sourceIdentity(run, repository, workflow, defaultBranch, admissionCandidate)
    && run.id === meta?.id
    && meta.repository_id === repository.id && meta.head_repository_id === repository.id
    && meta.head_branch === defaultBranch && meta.head_sha === run.head_sha);
}

// Check IDs are discovery hints only. Corroborate them with API-owned native
// job metadata in the exact trusted source run. This durable marker survives
// failed artifact uploads; forged external_id values cannot manufacture it.
async function latestSourceJob({ github, repo, repository, workflow, number, headSha }) {
  const checks = await allPages(github.rest.checks.listForRef, { ...repo, ref: headSha, filter: "all" }, "check_runs");
  const runIds = new Set();
  const pattern = new RegExp(`^(\\d+):1:${number}:(pr|issue|code)$`);
  for (const check of checks) {
    const match = pattern.exec(check.external_id || "");
    if (match && check.head_sha === headSha) runIds.add(Number(match[1]));
  }
  const markers = [];
  for (const runId of runIds) {
    const run = (await github.rest.actions.getWorkflowRun({ ...repo, run_id: runId })).data;
    if (!sourceIdentity(run, repository, workflow, repository.default_branch, true)) continue;
    const jobs = await allPages(github.rest.actions.listJobsForWorkflowRun, { ...repo, run_id: runId, filter: "all" }, "jobs");
    const matched = jobs.filter(job => job.run_id === run.id && job.run_attempt === 1
      && matchesSourceJob(job, number, headSha));
    insist(matched.length <= 1, "Ambiguous source admission jobs");
    if (matched.length) markers.push({ job: matched[0], run });
  }
  return markers.sort((a, b) => b.job.id - a.job.id)[0];
}

export function validateAdmission(receipt, { run, artifact, repository, workflow, number }) {
  const reference = run.referenced_workflows.find(item => item.path === SOURCE_WORKFLOW);
  insist(receipt.schema === 1 && receipt.kind === "admission"
    && receipt.repository.toLowerCase() === repository.full_name.toLowerCase()
    && receipt.repository_id === repository.id && receipt.number === number
    && receipt.run_id === run.id && receipt.run_attempt === 1 && integer(receipt.source_job_id)
    && receipt.caller_path === workflow.path && receipt.caller_workflow_id === workflow.id
    && receipt.caller_sha === run.head_sha && receipt.reviewer_sha === reference.sha
    && sha(receipt.caller_blob) && sha(receipt.head_sha) && sha(receipt.base_sha)
    && receipt.policy && ["review", "issue", "readiness", "codex_version"].every(key => typeof receipt.policy[key] === "string")
    && artifact.name === admissionName(number), "Malformed or mismatched admission receipt");
}

export function validateTerminal(terminal, admission, artifactId, live, stage) {
  insist(terminal.schema === 1 && terminal.kind === "terminal"
    && terminal.admission_artifact_id === artifactId
    && terminal.admission_sha256 === receiptHash(admission)
    && ["repository", "repository_id", "number", "head_sha", "base_sha", "run_id", "run_attempt", "source_job_id", "caller_path", "caller_workflow_id", "caller_sha", "caller_blob", "reviewer_sha"].every(key => terminal[key] === admission[key]),
  "Terminal receipt does not match the current accepted admission");
  insist(terminal.execution === "completed" && terminal.publication?.status === "success"
    && integer(terminal.publication.review_id), "Review execution or native publication did not complete");
  insist(terminal.stages?.[stage]?.status === "completed" && terminal.stages[stage].verdict === "pass", `${stage} review did not explicitly complete and pass`);
  insist(["snapshot_sha256", "policy_sha256", "context_sha256"].every(key => terminal[key] === live[key]), "Review context or policy is stale; request a fresh review");
}

async function admissions({ github, repo, repository, workflow, number }) {
  const artifacts = await allPages(github.rest.actions.listArtifactsForRepo, { ...repo, name: admissionName(number) }, "artifacts");
  const accepted = [];
  for (const artifact of artifacts) {
    // API name filtering is still checked; names and claimed run IDs do not
    // authenticate anything. Fetch the API-owned run associated with the artifact.
    if (artifact.name !== admissionName(number) || !integer(artifact.workflow_run?.id)) continue;
    const run = (await github.rest.actions.getWorkflowRun({ ...repo, run_id: artifact.workflow_run.id })).data;
    if (validateOrigin({ artifact, run, repository, workflow, defaultBranch: repository.default_branch, admissionCandidate: true })) accepted.push({ artifact, run });
  }
  // Artifact IDs are allocated at upload/admission, after queue acquisition.
  // Original request creation and workflow run IDs are deliberately not order keys.
  return accepted.sort((a, b) => b.artifact.id - a.artifact.id);
}

export async function verifyOnce({ github, context, reviewWorkflow, stage, read = readReceipt, collect = collectDiscussion }) {
  insist(["pr", "issue", "code"].includes(stage), "Unknown gate stage");
  insist(context.eventName === "pull_request", "Native review gates require the pull_request event");
  const original = context.payload.pull_request;
  insist(original && integer(original.number) && sha(original.head.sha), "Missing original pull_request head");
  const repo = context.repo;
  const repository = (await github.rest.repos.get(repo)).data;
  const workflow = (await github.rest.actions.getWorkflow({ ...repo, workflow_id: workflowPath(reviewWorkflow).split("/").at(-1) })).data;
  insist(workflow.path === workflowPath(reviewWorkflow) && integer(workflow.id), "Reviewer workflow identity mismatch");
  const pull = (await github.rest.pulls.get({ ...repo, pull_number: original.number })).data;
  insist(pull.state === "open" && !pull.draft && pull.head.sha === original.head.sha, "Original gate event is stale, closed, or draft");
  const marker = await latestSourceJob({ github, repo, repository, workflow, number: original.number, headSha: pull.head.sha });
  const candidates = await admissions({ github, repo, repository, workflow, number: original.number });
  if (!candidates.length) {
    insist(!marker || marker.run.status !== "completed", "Latest source request completed without an admission receipt");
    return { pending: true, reason: "Waiting for an authenticated review admission" };
  }
  const { artifact, run } = candidates[0];
  insist(validateOrigin({ artifact, run, repository, workflow, defaultBranch: repository.default_branch }), "Latest admission has an invalid source attempt or reusable revision");
  if (marker && marker.run.id !== run.id) {
    insist(marker.run.status !== "completed", "Newer accepted request completed without an admission receipt");
    return { pending: true, reason: "Waiting for the newest source job's admission upload" };
  }
  // Never fall back to older success when the latest trusted admission is
  // malformed, pending, failed, cancelled, expired, or for a previous revision.
  const admission = await read(github, repo, artifact);
  validateAdmission(admission, { run, artifact, repository, workflow, number: original.number });
  insist(marker, "Missing API-owned source admission job");
  if (marker.job.id > admission.source_job_id) {
    insist(marker.run.status !== "completed", "Newer accepted request completed without an admission receipt");
    return { pending: true, reason: "A newer accepted source request is awaiting its admission receipt" };
  }
  insist(marker.job.id === admission.source_job_id && marker.run.id === run.id, "Admission does not match the latest API-owned source job");
  insist(admission.head_sha === pull.head.sha && admission.base_sha === pull.base.sha, "Latest admission is for a stale PR head/base");
  const branch = (await github.rest.repos.getBranch({ ...repo, branch: repository.default_branch })).data;
  insist(sha(branch.commit?.sha), "Missing default-branch revision");
  const comparison = (await github.rest.repos.compareCommitsWithBasehead({ ...repo, basehead: `${run.head_sha}...${branch.commit.sha}` })).data;
  insist(["ahead", "identical"].includes(comparison.status), "Source revision is not in the trusted default-branch history");
  insist(await callerBlob(github, repo, workflow.path, run.head_sha) === admission.caller_blob
    && await callerBlob(github, repo, workflow.path, branch.commit.sha) === admission.caller_blob,
  "Caller policy changed since admission; request a fresh review");
  if (run.status !== "completed") return { pending: true, reason: "Latest admitted review is still running" };
  insist(run.conclusion === "success", "Latest admitted source run did not succeed");
  const artifacts = await allPages(github.rest.actions.listWorkflowRunArtifacts, { ...repo, run_id: run.id }, "artifacts");
  const terminals = artifacts.filter(item => item.name === terminalName(original.number));
  insist(terminals.length === 1, "Missing or ambiguous terminal receipt");
  const terminalArtifact = terminals[0];
  insist(validateOrigin({ artifact: terminalArtifact, run, repository, workflow, defaultBranch: repository.default_branch }), "Terminal artifact origin mismatch");
  const terminal = await read(github, repo, terminalArtifact);
  const discussion = await collect({ github, context, number: pull.number, triggerCommentId: admission.trigger_comment_id || "" });
  const live = gateContext(discussion, { repository: admission.repository, number: pull.number, baseSha: pull.base.sha, headSha: pull.head.sha, policy: admission.policy });
  validateTerminal(terminal, admission, artifact.id, live, stage);
  const publication = (await github.rest.pulls.getReview({ ...repo, pull_number: pull.number, review_id: terminal.publication.review_id })).data;
  insist(publication.commit_id === pull.head.sha && publication.state === "COMMENTED"
    && publication.user?.login === "github-actions[bot]", "Native publication is missing or mismatched");
  const latest = await admissions({ github, repo, repository, workflow, number: original.number });
  if (latest[0]?.artifact.id !== artifact.id) return { pending: true, reason: "A newer admission arrived during verification" };
  const freshMarker = await latestSourceJob({ github, repo, repository, workflow, number: original.number, headSha: pull.head.sha });
  if (freshMarker?.job.id !== marker.job.id) return { pending: true, reason: "A newer accepted source job appeared during verification" };
  const freshPull = (await github.rest.pulls.get({ ...repo, pull_number: pull.number })).data;
  insist(freshPull.state === "open" && !freshPull.draft && freshPull.head.sha === pull.head.sha && freshPull.base.sha === pull.base.sha, "PR revision changed during verification");
  // The publication/admission/job API reads above can overlap metadata or Issue
  // edits without moving the PR's Git revisions. Recollect the canonical live
  // context as the final verification read, rather than trusting the earlier
  // fingerprint after that interval.
  const finalDiscussion = await collect({ github, context, number: pull.number, triggerCommentId: admission.trigger_comment_id || "" });
  const finalLive = gateContext(finalDiscussion, { repository: admission.repository, number: pull.number, baseSha: freshPull.base.sha, headSha: freshPull.head.sha, policy: admission.policy });
  validateTerminal(terminal, admission, artifact.id, finalLive, stage);
  return { pending: false, sourceRunId: run.id, admissionId: artifact.id };
}

export async function waitForReview({ core, waitMinutes = 30, ...options }) {
  const minutes = Number(waitMinutes);
  insist(Number.isFinite(minutes) && minutes > 0 && minutes <= 60, "wait-minutes must be between 0 and 60");
  const deadline = Date.now() + minutes * 60_000;
  while (true) {
    const result = await verifyOnce(options);
    if (!result.pending) {
      core.info(`Authenticated ${options.stage} review from source run ${result.sourceRunId}, admission ${result.admissionId}`);
      return;
    }
    core.info(result.reason);
    insist(Date.now() < deadline, "Timed out waiting for the latest accepted review");
    await new Promise(resolve => setTimeout(resolve, Math.min(15_000, deadline - Date.now())));
  }
}
