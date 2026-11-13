import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { createRequire } from "node:module";
import { allPages, verifyOnce, validateOrigin, readReceipt, waitForReview } from "./verify.mjs";
import { makeAdmission, makeTerminal, admissionName, terminalName, SOURCE_WORKFLOW, workflowPath, sourceJobName, policyFromEnv } from "./receipts.mjs";
import { refreshNativeGates } from "./refresh.mjs";
import { collectDiscussion, gateContext } from "../pr-readiness/collect.mjs";
import { sha256 } from "../pr-readiness/common.mjs";

const revision = "c85e1eddb3d3f83499de23643f4eed5bb8c0d8fc";
const callerSha = "4702da99e6fde9d18a8d3468edcb75f785bfbb42";
const head = "a".repeat(40), base = "b".repeat(40), blob = "c".repeat(40);
const repository = { id: 324951019, full_name: "idy/letsolo", default_branch: "master" };
const workflow = { id: 331696417, path: ".github/workflows/codex-review.yml" };
// Fields captured from GET idy/letsolo/actions/runs/43426230048. That run
// predates receipts and is NOT grandfathered into a native gate pass.
const sourceRun = {
  id: 43426230048, run_attempt: 1, event: "issue_comment", ...{ workflow_id: workflow.id, path: workflow.path },
  head_branch: "master", head_sha: callerSha, status: "completed", conclusion: "success",
  repository: { id: repository.id, full_name: repository.full_name }, head_repository: { id: repository.id },
  referenced_workflows: [{ path: SOURCE_WORKFLOW, ref: "refs/tags/latest", sha: revision }],
};
const readinessInput = "Validate metadata";
const policy = { review: "Review correctness", issue: "Read project policy", readiness: `Read project policy ${readinessInput}`, model: "gpt-6.1-sol", effort: "low", codex_version: "0.163.0", lfs_context_paths: "" };
const discussionFixture = () => ({
  repository: repository.full_name, pull_request: { title: "fix: Secure gates", body: "Delivered and tested.", body_truncated: false },
  linked_issues: [], linked_issue_count: 0, unresolved_openai_thread_count: 0,
  review_threads_truncated: false, trigger_comment_id: null,
  live_metadata: { title: "fix: Secure gates", body: "Delivered and tested.", threads: [] }, comments: [],
});
const artifactFor = (id, run, name) => ({
  id, name, expired: false, expires_at: "2099-01-01T00:00:00Z", size_in_bytes: 512,
  workflow_run: { id: run.id, repository_id: repository.id, head_repository_id: repository.id, head_branch: run.head_branch, head_sha: run.head_sha },
});
function fixture() {
  const state = {
    runs: new Map(), jobs: [], checks: [], artifacts: [], receipts: new Map(), discussion: discussionFixture(),
    pull: { number: 695, state: "open", draft: false, head: { sha: head }, base: { sha: base, repo: { id: repository.id } } },
    currentBlob: blob, comparison: "ahead", mutations: [], publications: new Map(),
  };
  const context = { repo: { owner: "idy", repo: "letsolo" }, eventName: "pull_request", runId: 99, payload: { pull_request: structuredClone(state.pull) } };
  const response = data => ({ data: structuredClone(data), headers: {} });
  const page = (items, key) => response({ [key]: items, total_count: items.length });
  const github = { rest: {
    repos: {
      get: async () => response(repository),
      getBranch: async () => response({ commit: { sha: "d".repeat(40) } }),
      getContent: async ({ ref }) => response({ type: "file", sha: ref === callerSha ? blob : state.currentBlob }),
      compareCommitsWithBasehead: async () => response({ status: state.comparison }),
    },
    pulls: {
      get: async () => response(state.pull),
      getReview: async ({ review_id }) => response(state.publications.get(review_id) || { id: review_id, commit_id: head, state: "COMMENTED", user: { login: "github-actions[bot]" } }),
    },
    checks: { listForRef: async () => page(state.checks, "check_runs") },
    actions: {
      listJobsForWorkflowRun: async ({ run_id }) => page(state.jobs.filter(job => job.run_id === run_id), "jobs"),
      getWorkflow: async ({ workflow_id }) => response(workflow_id === "codex-review-gates.yml" ? { id: 71, path: ".github/workflows/codex-review-gates.yml" } : workflow),
      getWorkflowRun: async ({ run_id }) => { assert.ok(state.runs.has(run_id), `Unknown source ${run_id}`); return response(state.runs.get(run_id)); },
      listArtifactsForRepo: async ({ name }) => page(state.artifacts.filter(item => item.name === name), "artifacts"),
      listWorkflowRunArtifacts: async ({ run_id }) => page(state.artifacts.filter(item => item.workflow_run.id === run_id), "artifacts"),
      listWorkflowRuns: async () => page([...state.runs.values()], "workflow_runs"),
      reRunWorkflow: async ({ run_id }) => { state.mutations.push(run_id); return response({}); },
    },
  } };
  const add = (artifactId, runId, verdict = "pass", runPatch = {}) => {
    const run = { ...structuredClone(sourceRun), id: runId, ...runPatch };
    state.runs.set(runId, run);
    state.jobs.push({ id: artifactId * 10, name: sourceJobName(695, head), run_id: runId, run_attempt: 1, status: run.status });
    state.checks.push({ id: artifactId * 100, name: "OpenAI Code Review", head_sha: head, external_id: `${runId}:1:695:code` });
    const artifact = artifactFor(artifactId, run, admissionName(695));
    const admission = {
      schema: 1, kind: "admission", repository: repository.full_name, repository_id: repository.id, number: 695,
      head_sha: head, base_sha: base, run_id: run.id, run_attempt: 1, source_job_id: artifactId * 10, caller_path: workflow.path,
      caller_workflow_id: workflow.id, caller_sha: callerSha, caller_blob: blob, reviewer_sha: revision,
      trigger_comment_id: null, policy: structuredClone(policy),
    };
    state.artifacts.push(artifact);
    state.receipts.set(artifactId, admission);
    const binding = gateContext(state.discussion, { repository: repository.full_name, number: 695, baseSha: base, headSha: head, policy });
    const terminal = makeTerminal({ admission, admissionArtifactId: artifactId, binding,
      readiness: { ...binding, workflow_source_sha: revision, trusted_policy_sha256: sha256(policy.readiness), head_sha: head, base_sha: base, stage_verdicts: { pr_review: verdict, issue_review: verdict, code_review: verdict } },
      reviewResult: "success", publishResult: "success", publicationId: artifactId + 1000,
    });
    const terminalArtifact = artifactFor(artifactId + 1, run, terminalName(695));
    state.artifacts.push(terminalArtifact);
    state.receipts.set(artifactId + 1, terminal);
    return { run, artifact, admission, terminalArtifact, terminal };
  };
  const options = { github, context, reviewWorkflow: "codex-review.yml", stage: "code",
    read: async (_github, _repo, artifact) => structuredClone(state.receipts.get(artifact.id)),
    collect: async () => structuredClone(state.discussion),
  };
  return { state, context, github, add, options };
}

test("actual trusted source metadata authenticates origin, but pre-receipt runs cannot pass", async () => {
  const f = fixture();
  const real = artifactFor(10, sourceRun, admissionName(695));
  assert.equal(validateOrigin({ artifact: real, run: sourceRun, repository, workflow, defaultBranch: "master" }), true);
  assert.equal((await verifyOnce(f.options)).pending, true);
  f.add(100, sourceRun.id);
  for (const stage of ["pr", "issue", "code"]) assert.equal((await verifyOnce({ ...f.options, stage })).sourceRunId, sourceRun.id);
});

test("forged external IDs and artifact names from gate or unrelated runs are not receipts", async () => {
  const f = fixture();
  f.add(100, 1000);
  f.add(900, 9000, "fail", { workflow_id: 71, path: ".github/workflows/codex-review-gates.yml", event: "pull_request", external_id: "43426230048:1:695:code" });
  assert.equal((await verifyOnce(f.options)).sourceRunId, 1000);
});

for (const [name, patch] of Object.entries({
  "wrong workflow ID": { workflow_id: 7 }, "wrong workflow path": { path: ".github/workflows/forged.yml" },
  "wrong repository": { repository: { id: 7 } }, "wrong head repository": { head_repository: { id: 7 } },
  "wrong branch": { head_branch: "untrusted" }, "wrong event": { event: "pull_request" },
  "wrong immutable revision": { head_sha: "f".repeat(40) }, "wrong attempt": { run_attempt: 2 },
  "missing reusable": { referenced_workflows: [] }, "wrong reusable ref": { referenced_workflows: [{ path: SOURCE_WORKFLOW.replace("@latest", "@evil"), sha: revision }] },
})) test(`origin rejects ${name}`, () => {
  const artifact = artifactFor(10, sourceRun, admissionName(695));
  assert.equal(validateOrigin({ artifact, run: { ...sourceRun, ...patch }, repository, workflow, defaultBranch: "master" }), false);
});

test("reviewer revision and claimed identifiers alone cannot authenticate the selected receipt", async () => {
  const f = fixture();
  const item = f.add(100, 1000);
  item.admission.reviewer_sha = "e".repeat(40);
  await assert.rejects(verifyOnce(f.options), /mismatched admission/);
});

test("queue admission order wins over original request/run order in both pass/fail directions", async () => {
  const f = fixture();
  f.add(100, 9999, "pass");
  f.add(200, 1000, "fail");
  await assert.rejects(verifyOnce(f.options), /explicitly complete and pass/);
  f.add(300, 1001, "pass");
  assert.equal((await verifyOnce(f.options)).sourceRunId, 1001);
});

test("new pending, failed, cancelled, skipped and rerun admissions prevent old success reuse", async () => {
  for (const state of ["pending", "failure", "cancelled", "skipped", "rerun"]) {
    const f = fixture();
    f.add(100, 1000);
    const item = f.add(200, 2000, "pass", state === "pending" ? { status: "in_progress", conclusion: null }
      : state === "rerun" ? { run_attempt: 2 } : { conclusion: state });
    if (state === "pending") {
      f.state.artifacts = f.state.artifacts.filter(a => a.id !== item.terminalArtifact.id);
      assert.equal((await verifyOnce(f.options)).pending, true);
    } else await assert.rejects(verifyOnce(f.options), /source run did not succeed|invalid source attempt/);
  }
});

test("missing, malformed, ambiguous and mismatched terminal cannot fall back", async () => {
  for (const corruption of ["missing", "malformed", "duplicate", "admission", "run", "metadata", "publication", "skipped", "cancelled"]) {
    const f = fixture();
    f.add(100, 1000);
    const item = f.add(200, 2000);
    if (corruption === "missing") f.state.artifacts = f.state.artifacts.filter(a => a.id !== 201);
    if (corruption === "malformed") f.state.receipts.set(201, {});
    if (corruption === "duplicate") f.state.artifacts.push({ ...item.terminalArtifact, id: 202 });
    if (corruption === "admission") item.terminal.admission_artifact_id = 100;
    if (corruption === "run") item.terminal.run_id = 1000;
    if (corruption === "metadata") item.terminalArtifact.workflow_run.head_repository_id = 7;
    if (corruption === "publication") item.terminal.publication.status = "failure";
    if (corruption === "skipped") item.terminal.stages.code.status = "skipped";
    if (corruption === "cancelled") item.terminal.stages.code.status = "cancelled";
    await assert.rejects(verifyOnce(f.options));
  }
});

test("stale original event head, receipt head/base, default history and policy fail closed", async () => {
  for (const corruption of ["event-head", "receipt-head", "base", "history", "policy", "draft", "closed"]) {
    const f = fixture(), item = f.add(100, 1000);
    if (corruption === "event-head") f.state.pull.head.sha = "e".repeat(40);
    if (corruption === "receipt-head") item.admission.head_sha = "e".repeat(40);
    if (corruption === "base") f.state.pull.base.sha = "e".repeat(40);
    if (corruption === "history") f.state.comparison = "diverged";
    if (corruption === "policy") f.state.currentBlob = "e".repeat(40);
    if (corruption === "draft") f.state.pull.draft = true;
    if (corruption === "closed") f.state.pull.state = "closed";
    await assert.rejects(verifyOnce(f.options));
  }
});

test("live PR metadata, linked-Issue contents/revisions/relationships and threads invalidate receipts", async () => {
  for (const change of ["title", "body", "issue-body", "issue-revision", "issue-parent", "issue-dependency", "threads"]) {
    const f = fixture();
    f.state.discussion.linked_issues = [{ repository: repository.full_name, number: 700, title: "fix: Plan", body: "Original plan", updated_at: "2026-11-12T10:00:00Z", state: "OPEN", sub_issues: [], blocked_by: [], blocking: [] }];
    f.state.discussion.linked_issue_count = 1;
    f.add(100, 1000);
    const issue = f.state.discussion.linked_issues[0];
    if (change === "title") f.state.discussion.pull_request.title = "fix: Different title";
    if (change === "body") f.state.discussion.pull_request.body += " Changed.";
    if (change === "issue-body") issue.body += " Revised.";
    if (change === "issue-revision") issue.updated_at = "2026-11-13T10:00:00Z";
    if (change === "issue-parent") issue.parent_number = 7;
    if (change === "issue-dependency") issue.blocked_by.push({ repository: repository.full_name, number: 8, state: "OPEN" });
    if (change === "threads") f.state.discussion.live_metadata.threads.push({ id: "new", isResolved: false, comments: { nodes: [] } });
    await assert.rejects(verifyOnce(f.options), /stale/);
  }
});

test("native publication is required, with exact reviewed head and author", async () => {
  for (const patch of [{ commit_id: base }, { state: "PENDING" }, { user: { login: "attacker" } }]) {
    const f = fixture(), item = f.add(100, 1000);
    f.state.publications.set(item.terminal.publication.review_id, { commit_id: head, state: "COMMENTED", user: { login: "github-actions[bot]" }, ...patch });
    await assert.rejects(verifyOnce(f.options), /publication/);
  }
});

test("admission arriving during verification makes the gate keep waiting", async () => {
  const f = fixture(); f.add(100, 1000);
  const collect = async () => { f.add(200, 2000, "pass", { status: "in_progress" }); return f.state.discussion; };
  assert.equal((await verifyOnce({ ...f.options, collect })).pending, true);
});

test("API errors, malformed and incomplete/repeated/changing pages never pass", async () => {
  for (const method of ["listArtifactsForRepo", "getWorkflowRun", "listWorkflowRunArtifacts", "listJobsForWorkflowRun"]) {
    const f = fixture(); f.add(100, 1000);
    f.github.rest.actions[method] = async () => { throw new Error("API unavailable"); };
    await assert.rejects(verifyOnce(f.options), /API unavailable/);
  }
  const page = (ids, count, next) => ({ data: { artifacts: ids.map(id => ({ id })), total_count: count }, headers: { link: next ? '<url>; rel="next"' : "" } });
  for (const pages of [[page([1], 2, false)], [page([1], 2, true), page([1], 2, false)], [page([1], 2, true), page([2], 3, false)], [{ data: {} }]]) {
    let i = 0;
    await assert.rejects(allPages(async () => pages[i++], {}, "artifacts"));
  }
  let i = 0;
  assert.deepEqual(await allPages(async () => [page([1], 2, true), page([2], 2, false)][i++], {}, "artifacts"), [{ id: 1 }, { id: 2 }]);
});

test("expiry and unsafe ZIP receipts fail closed without extracting paths", async () => {
  const artifact = artifactFor(10, sourceRun, admissionName(695));
  await assert.rejects(readReceipt({}, {}, { ...artifact, expired: true }), /expired/);
  await assert.rejects(readReceipt({}, {}, { ...artifact, expires_at: "invalid" }), /expired/);
  const python = fileURLToPath(new URL("./read-receipt.py", import.meta.url));
  const zip = (entries) => execFileSync("python3", ["-I", "-c", 'import sys,json,zipfile,io; b=io.BytesIO(); z=zipfile.ZipFile(b,"w",zipfile.ZIP_DEFLATED); [(z.writestr(n,s)) for n,s in json.loads(sys.argv[1])]; z.close(); sys.stdout.buffer.write(b.getvalue())', JSON.stringify(entries)]);
  assert.deepEqual(JSON.parse(execFileSync("python3", ["-I", python], { input: zip([["receipt.json", '{"schema":1}']]) })), { schema: 1 });
  for (const entries of [[], [["../receipt.json", "{}"]], [["/receipt.json", "{}"]], [["receipt.json", "{}"], ["extra.py", "print(1)"]], [["receipt.json", '{"x":1,"x":2}']], [["receipt.json", '{"x":NaN}']], [["receipt.json", "[1]"]], [["receipt.json", "x".repeat(65537)]]]) {
    assert.throws(() => execFileSync("python3", ["-I", python], { input: zip(entries), stdio: ["pipe", "pipe", "pipe"] }));
  }
});

function gateRun(id, patch = {}) {
  return { id, workflow_id: 71, path: ".github/workflows/codex-review-gates.yml", event: "pull_request", head_sha: head, status: "completed", repository: { id: repository.id }, pull_requests: [{ number: 695, base: { repo: { id: repository.id } } }], ...patch };
}
test("same-head comment/manual/Issue refresh reruns only latest eligible gate, without waiting", async () => {
  for (const event of ["issue_comment", "workflow_dispatch", "issues"]) {
    const f = fixture(); f.add(100, 1000, "pass", { event }); f.context.runId = 1000;
    f.state.runs.set(10, gateRun(10)); f.state.runs.set(11, gateRun(11));
    assert.deepEqual(await refreshNativeGates({ ...f.options, gateWorkflow: "codex-review-gates.yml", number: 695, headSha: head }), [11]);
    assert.deepEqual(f.state.mutations, [11]);
  }
});
test("refresh never reruns reviewers, stale heads, wrong PRs/events/workflows, or active gates", async () => {
  for (const patch of [{ head_sha: base }, { status: "in_progress" }, { status: "queued" }, { status: "waiting" }, { event: "workflow_dispatch" }, { workflow_id: workflow.id, path: workflow.path }, { pull_requests: [{ number: 694 }] }, { repository: { id: 7 } }]) {
    const f = fixture(); f.add(100, 1000); f.context.runId = 1000;
    f.state.runs.set(10, gateRun(10, patch));
    assert.deepEqual(await refreshNativeGates({ ...f.options, gateWorkflow: "codex-review-gates.yml", number: 695, headSha: head }), []);
    assert.deepEqual(f.state.mutations, []);
  }
  const f = fixture(); f.add(100, 1000); f.context.runId = 1000;
  await assert.rejects(refreshNativeGates({ ...f.options, gateWorkflow: "codex-review.yml", number: 695, headSha: head }), /cannot be the reviewer/);
  assert.deepEqual(await refreshNativeGates({ ...f.options, gateWorkflow: "", number: 695, headSha: head }), []);
});

test("collector rejects missing/repeated thread cursors and failed pages", async () => {
  const context = { repo: { owner: "idy", repo: "letsolo" } };
  for (const mode of ["missing", "repeat", "api", "malformed"]) {
    let page = 0;
    const github = { graphql: async () => {
      if (mode === "api" && page++) throw new Error("Thread API failure");
      return { repository: { nameWithOwner: repository.full_name, pullRequest: { title: "fix: Test", body: "No Issues", reviewThreads: {
        nodes: [], pageInfo: mode === "malformed" ? {} : { hasNextPage: true, endCursor: mode === "missing" ? null : "repeated" },
      } } } };
    } };
    await assert.rejects(collectDiscussion({ github, context, number: 695 }), /pagination|API failure|Malformed/);
  }
});

test("action stays secretless and imports only pinned repository code; workflow ordering has no gate wait", () => {
  const action = fs.readFileSync(new URL("../../actions/review-gate/action.yml", import.meta.url), "utf8");
  assert.match(action, /actions\/github-script@[a-f0-9]{40}/);
  assert.doesNotMatch(action, /uses: actions\/checkout|OPENAI_API_KEY|npm|pip install/);
  const source = fs.readFileSync(new URL("../../workflows/codex-openai-review.yml", import.meta.url), "utf8");
  assert.ok(source.indexOf("Upload native gate admission") < source.indexOf("Refresh only the opt-in"));
  assert.ok(source.indexOf("Refresh only the opt-in") < source.indexOf("Bootstrap Codex"));
  assert.match(source, /name: Review admission PR-\$\{\{ needs\.resolve\.outputs\.number \}\} head-\$\{\{ needs\.resolve\.outputs\.head_sha \}\}/);
  assert.match(source, /name: Refresh only the opt-in native gate workflow\n\s+if: always\(\) && inputs\.native-gate-workflow != ''/);
  assert.ok(source.indexOf("Publish native pull-request review") < source.indexOf("Upload native gate terminal receipt"));
  assert.match(source, /native-gate-workflow:[\s\S]*?default: ''/);
  assert.doesNotMatch(fs.readFileSync(new URL("./refresh.mjs", import.meta.url), "utf8"), /waitForReview|checks\.update|reRunJob/);
  assert.throws(() => workflowPath("../codex-review.yml"));
  assert.throws(() => workflowPath(".github/workflows/reviewer.yml@main"));
});

test("wait loop rejects unsupported stage/event and invalid timeout without sleeping", async () => {
  const f = fixture();
  await assert.rejects(waitForReview({ ...f.options, core: { info() {} }, waitMinutes: 0 }), /wait-minutes/);
  await assert.rejects(verifyOnce({ ...f.options, stage: "fake" }), /Unknown/);
  await assert.rejects(verifyOnce({ ...f.options, context: { ...f.context, eventName: "workflow_dispatch" } }), /pull_request event/);
});

test("admission/terminal upload failures fence an older completed native pass", async () => {
  for (const missing of ["admission", "terminal"]) {
    const f = fixture(); f.add(100, 9999);
    f.add(200, 1000, "pass", { status: "in_progress", conclusion: null });
    f.state.artifacts = f.state.artifacts.filter(a => missing === "admission" ? a.workflow_run.id !== 1000 : a.id !== 201);
    assert.equal((await verifyOnce(f.options)).pending, true);
    f.state.runs.set(1000, { ...f.state.runs.get(1000), status: "completed", conclusion: "failure" });
    await assert.rejects(verifyOnce(f.options), /without an admission receipt|source run did not succeed/);
    // Refresh still schedules the old eligible gate after the upload failed.
    f.context.runId = 1000; f.state.runs.set(10, gateRun(10));
    assert.deepEqual(await refreshNativeGates({ ...f.options, gateWorkflow: "codex-review-gates.yml", number: 695, headSha: head }), [10]);
  }
});

test("forged external IDs need API-owned PR/head jobs, not just a trusted run ID", async () => {
  const f = fixture(); f.add(100, 1000); f.add(200, 2000);
  f.state.artifacts = f.state.artifacts.filter(a => a.workflow_run.id !== 2000);
  f.state.jobs.find(job => job.run_id === 2000).name = sourceJobName(694, head);
  assert.equal((await verifyOnce(f.options)).sourceRunId, 1000);
  f.state.jobs.find(job => job.run_id === 1000).name = sourceJobName(695, base);
  await assert.rejects(verifyOnce(f.options), /Missing API-owned/);
});


test("actual workflow refresh script executes after missing upload, without any model work", async () => {
  const f = fixture(); f.add(100, 9999); f.add(200, 1000, "pass", { status: "in_progress" });
  f.context.runId = 1000;
  f.state.artifacts = f.state.artifacts.filter(a => a.workflow_run.id !== 1000);
  f.state.runs.set(10, gateRun(10));
  const source = fs.readFileSync(new URL("../../workflows/codex-openai-review.yml", import.meta.url), "utf8");
  const section = source.split("      - name: Refresh only the opt-in native gate workflow")[1].split("      - name:")[0];
  assert.match(section, /if: always\(\)/);
  const script = section.split("          script: |\n")[1].split("\n").filter(line => line.startsWith("            ")).map(line => line.slice(12)).join("\n");
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await new AsyncFunction("require", "github", "context", "process", script)(
    createRequire(import.meta.url), f.github, f.context,
    { env: { REVIEWER_SOURCE_DIR: fileURLToPath(new URL("../../../", import.meta.url)), NATIVE_GATE_WORKFLOW: "codex-review-gates.yml", PULL_REQUEST_NUMBER: "695", PR_HEAD_SHA: head } },
  );
  assert.deepEqual(f.state.mutations, [10]);
  assert.equal((await verifyOnce(f.options)).pending, true);
});

test("admission writer binds the API-owned source job and immutable caller blob", async () => {
  const f = fixture(); const current = f.add(100, 1000); f.context.runId = 1000;
  f.github.paginate = async () => f.state.jobs;
  const admission = await makeAdmission({ github: f.github, context: f.context, env: {
    REPOSITORY_ID: String(repository.id), PULL_REQUEST_NUMBER: "695", PR_HEAD_SHA: head, PR_BASE_SHA: base,
    REVIEWER_SOURCE_SHA: revision, REVIEW_INSTRUCTIONS: policy.review, ISSUE_REVIEW_INSTRUCTIONS: policy.issue,
    PR_READINESS_INSTRUCTIONS: readinessInput, CODEX_VERSION: policy.codex_version,
  } });
  assert.deepEqual(admission, current.admission);
  f.state.jobs[0].name = sourceJobName(694, head);
  await assert.rejects(makeAdmission({ github: f.github, context: f.context, env: { PULL_REQUEST_NUMBER: "695", PR_HEAD_SHA: head } }), /source admission job/);
});


test("legacy empty-input callers tolerate only optional receipt infrastructure failures", () => {
  const source = fs.readFileSync(new URL("../../workflows/codex-openai-review.yml", import.meta.url), "utf8");
  for (const name of ["Admit the accepted review request before model work", "Upload native gate admission", "Check out trusted terminal receipt writer", "Bind the terminal receipt to successful native publication", "Upload native gate terminal receipt"]) {
    const step = source.split(`      - name: ${name}\n`)[1]?.split("      - name:")[0];
    assert.ok(step, name);
    // This is the runner's failure policy, not a swallowed exception in model
    // or publication code: empty-input callers keep availability, opt-in
    // consumers require successful receipt production/upload.
    assert.match(step, /continue-on-error: \$\{\{ inputs\.native-gate-workflow == '' \}\}/);
  }
  const publication = source.split("      - name: Publish native pull-request review\n")[1].split("      - name:")[0];
  assert.doesNotMatch(publication, /continue-on-error/);
  const refresh = source.split("      - name: Refresh only the opt-in native gate workflow\n")[1].split("      - name:")[0];
  assert.match(refresh, /if: always\(\) && inputs\.native-gate-workflow != ''/);
  assert.doesNotMatch(refresh, /continue-on-error/);
});

test("successful legacy source after tolerated receipt upload failure cannot make native gates pass", async () => {
  for (const missing of ["admission", "terminal"]) {
    const f = fixture(); f.add(100, 9999); f.add(200, 1000);
    // Legacy reviewer availability is preserved: source itself succeeded, but
    // its absent optional evidence still cannot authorize any native stage.
    f.state.artifacts = f.state.artifacts.filter(a => missing === "admission" ? a.workflow_run.id !== 1000 : a.id !== 201);
    for (const stage of ["pr", "issue", "code"]) {
      await assert.rejects(verifyOnce({ ...f.options, stage }), /without an admission receipt|Missing or ambiguous terminal/);
    }
  }
});


test("PR and linked-Issue edits during final API corroboration cannot pass", async () => {
  for (const change of ["title", "body", "issue-body", "issue-revision", "issue-relationship"]) {
    const f = fixture();
    f.state.discussion.linked_issues = [{ repository: repository.full_name, number: 700, title: "fix: Plan", body: "Original plan", updated_at: "2026-11-12T10:00:00Z", state: "OPEN", sub_issues: [], blocked_by: [], blocking: [] }];
    f.state.discussion.linked_issue_count = 1;
    f.add(100, 1000);
    const originalPublication = f.github.rest.pulls.getReview;
    f.github.rest.pulls.getReview = async args => {
      // This call follows the first canonical fingerprint validation. Git
      // revisions deliberately remain unchanged throughout the mutation.
      const issue = f.state.discussion.linked_issues[0];
      if (change === "title") f.state.discussion.pull_request.title = "fix: Changed after validation";
      if (change === "body") f.state.discussion.pull_request.body += " Changed after validation.";
      if (change === "issue-body") issue.body += " Revised after validation.";
      if (change === "issue-revision") issue.updated_at = "2026-11-13T10:00:00Z";
      if (change === "issue-relationship") issue.parent_number = 701;
      return originalPublication(args);
    };
    await assert.rejects(verifyOnce(f.options), /context or policy is stale/);
  }
});

test("failure in the final canonical context collection cannot pass", async () => {
  const f = fixture(); f.add(100, 1000);
  let collections = 0;
  await assert.rejects(verifyOnce({ ...f.options, collect: async () => {
    if (++collections === 2) throw new Error("Final live context API failure");
    return structuredClone(f.state.discussion);
  } }), /Final live context API failure/);
  assert.equal(collections, 2);
});


test("real prepare/evaluate readiness policy composes with terminal receipts and native gates", async () => {
  const f = fixture(); const accepted = f.add(100, 1000); f.context.runId = 1000;
  f.github.paginate = async () => f.state.jobs;
  const source = fs.readFileSync(new URL("../../workflows/codex-openai-review.yml", import.meta.url), "utf8");
  const prepareStep = source.split("      - name: Prepare deterministic PR and Issue readiness context\n")[1].split("      - name:")[0];
  const foldedExpression = prepareStep.split("          PR_READINESS_INSTRUCTIONS: >-\n")[1].split("        run:")[0].trim().split("\n").map(line => line.trim()).join(" ");
  assert.equal(foldedExpression, "${{ inputs.issue-review-instructions }} ${{ inputs.pr-readiness-instructions }}");
  const workflowPolicy = foldedExpression.replace("${{ inputs.issue-review-instructions }}", policy.issue)
    .replace("${{ inputs.pr-readiness-instructions }}", readinessInput);
  const env = {
    REPOSITORY_ID: String(repository.id), GITHUB_REPOSITORY: repository.full_name, PULL_REQUEST_NUMBER: "695",
    PR_HEAD_SHA: head, PR_BASE_SHA: base, REVIEWER_SOURCE_SHA: revision,
    REVIEW_INSTRUCTIONS: policy.review, ISSUE_REVIEW_INSTRUCTIONS: policy.issue,
    PR_READINESS_INSTRUCTIONS: readinessInput, CODEX_VERSION: policy.codex_version,
  };
  const admission = await makeAdmission({ github: f.github, context: f.context, env });
  assert.equal(admission.policy.readiness, workflowPolicy);
  const temporary = fs.mkdtempSync(fileURLToPath(new URL(".policy-test-", import.meta.url)));
  try {
    const contextFile = `${temporary}/context.json`;
    fs.writeFileSync(contextFile, JSON.stringify(f.state.discussion));
    const scriptEnv = { ...process.env, ...env, PR_CONTEXT_FILE: contextFile,
      GITHUB_OUTPUT: `${temporary}/outputs`, PR_READINESS_INSTRUCTIONS: workflowPolicy,
      WORKFLOW_SOURCE_SHA: revision, MODEL: policy.model, EFFORT: policy.effort,
      REVIEW: JSON.stringify({ findings: [], readiness: { blockers: [] } }),
    };
    execFileSync(process.execPath, [fileURLToPath(new URL("../pr-readiness/prepare.mjs", import.meta.url))], { env: scriptEnv });
    const prepared = JSON.parse(fs.readFileSync(contextFile, "utf8"));
    assert.equal(prepared.trusted_readiness_policy, workflowPolicy);
    assert.equal(prepared.trusted_readiness_policy_sha256, sha256(workflowPolicy));
    const readiness = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL("../pr-readiness/evaluate.mjs", import.meta.url))], { env: scriptEnv }));
    assert.equal(readiness.verdict, "pass");
    const binding = gateContext(f.state.discussion, { repository: repository.full_name, number: 695, baseSha: base, headSha: head, policy: admission.policy });
    const terminal = makeTerminal({ admission, admissionArtifactId: accepted.artifact.id, binding, readiness,
      reviewResult: "success", publishResult: "success", publicationId: accepted.terminal.publication.review_id,
    });
    f.state.receipts.set(100, admission); f.state.receipts.set(101, terminal);
    for (const stage of ["pr", "issue", "code"]) assert.equal((await verifyOnce({ ...f.options, stage })).sourceRunId, 1000);
    assert.throws(() => makeTerminal({ admission: { ...admission, policy: { ...admission.policy, readiness: readinessInput } },
      admissionArtifactId: 100, binding, readiness, reviewResult: "success", publishResult: "success", publicationId: 1100,
    }), /evidence does not match/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("receipt policy preserves folded-value whitespace and multiline input semantics", () => {
  for (const [issue, readiness] of [["Issue instructions", "PR instructions"], ["Issue\nsecond line", " PR\nsecond line "], ["", "PR only"], ["Issue only", ""]]) {
    assert.equal(policyFromEnv({ ISSUE_REVIEW_INSTRUCTIONS: issue, PR_READINESS_INSTRUCTIONS: readiness }).readiness, `${issue} ${readiness}`);
  }
});


test("actual collection workflow hashes full thread metadata but preserves model context budgets", async () => {
  const source = fs.readFileSync(new URL("../../workflows/codex-openai-review.yml", import.meta.url), "utf8");
  const section = source.split("      - name: Collect untrusted pull-request discussion context\n")[1].split("      - name:")[0];
  const script = section.split("          script: |\n")[1].split("\n").filter(line => line.startsWith("            ")).map(line => line.slice(12)).join("\n");
  const temporary = fs.mkdtempSync(fileURLToPath(new URL(".context-test-", import.meta.url)));
  const thread = { id: "large-historical-thread", isResolved: false, isOutdated: false,
    comments: { nodes: [{ author: { login: "github-actions[bot]" }, body: `Badge](https://img.shields.io/badge/P1-orange) ${"thread detail ".repeat(10000)}` }] },
  };
  const github = {
    graphql: async () => ({ repository: { nameWithOwner: repository.full_name, pullRequest: {
      title: "fix: Secure gates", body: "Delivered and tested.",
      reviewThreads: { nodes: [structuredClone(thread)], pageInfo: { hasNextPage: false, endCursor: null } },
    } } }),
    paginate: async () => [{ id: 7, user: { login: "contributor", type: "User" }, body: "comment ".repeat(1000), author_association: "NONE", created_at: "2026-11-13T00:00:00Z" }],
    rest: { issues: { listComments() {} } },
  };
  const environment = { PR_CONTEXT_FILE: `${temporary}/context.json`, PULL_REQUEST_NUMBER: "695", PR_BASE_SHA: base, PR_HEAD_SHA: head,
    GITHUB_REPOSITORY: repository.full_name, REVIEWER_SOURCE_DIR: fileURLToPath(new URL("../../../", import.meta.url)),
    REQUEST_COMMENT_ID: "", REVIEW_INSTRUCTIONS: policy.review, ISSUE_REVIEW_INSTRUCTIONS: policy.issue,
    PR_READINESS_INSTRUCTIONS: readinessInput, CODEX_VERSION: policy.codex_version, LFS_CONTEXT_PATHS: "",
  };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  const outputs = {};
  try {
    Object.assign(process.env, environment);
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    await new AsyncFunction("require", "github", "context", "core", script)(createRequire(import.meta.url), github,
      { repo: { owner: "idy", repo: "letsolo" } }, { exportVariable() {}, setOutput(key, value) { outputs[key] = value; }, setFailed(reason) { throw new Error(reason); } });
    const modelContext = JSON.parse(fs.readFileSync(environment.PR_CONTEXT_FILE, "utf8"));
    assert.equal(Object.hasOwn(modelContext, "live_metadata"), false);
    assert.equal(modelContext.unresolved_openai_thread_count, 1);
    assert.equal(modelContext.comments[0].body.length, 2000);
    assert.equal(modelContext.comments[0].body_truncated, true);
    assert.equal(JSON.stringify(modelContext).includes("thread detail"), false);
    const fullContext = await collectDiscussion({ github, context: { repo: { owner: "idy", repo: "letsolo" } }, number: 695 });
    const expected = gateContext(fullContext, { repository: repository.full_name, number: 695, baseSha: base, headSha: head, policy });
    assert.deepEqual(JSON.parse(outputs.gate_context), expected);
    fullContext.live_metadata.threads[0].comments.nodes[0].body += " revised";
    assert.notEqual(gateContext(fullContext, { repository: repository.full_name, number: 695, baseSha: base, headSha: head, policy }).context_sha256, expected.context_sha256);
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
