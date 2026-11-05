import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const workflow = fs.readFileSync(new URL("../../workflows/openai-pr-review-dispatch.yml", import.meta.url), "utf8");
const dispatchJob = workflow.match(/^  dispatch_review:\n([\s\S]*?)(?=^  resolve_review_target:)/m)?.[0];
assert.ok(dispatchJob);
const body = dispatchJob.split("          script: |\n")[1].split("\n")
  .map(line => line.startsWith("            ") ? line.slice(12) : line).join("\n");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const dispatch = new AsyncFunction("github", "context", "core", "process", body);
const head = "a".repeat(40);

function fixture() {
  const state = {
    pull: { state: "open", draft: false, head: { sha: head, ref: "untrusted-branch", repo: { full_name: "contributor/fork" } } },
    repository: { default_branch: "main" },
    run: { id: 300, workflow_id: 40, event: "pull_request_target" },
    context: { repo: { owner: "example", repo: "project" }, runId: 300,
      eventName: "pull_request_target", payload: { pull_request: { number: 13, head: { sha: head } } } },
    process: { env: { GITHUB_RUN_ATTEMPT: "1" } },
    requests: [], reads: 0, logs: [],
  };
  const get = key => async () => { state.reads++; return { data: structuredClone(state[key]) }; };
  state.github = { rest: {
    pulls: { get: get("pull") }, repos: { get: get("repository") },
    actions: { getWorkflowRun: get("run"), createWorkflowDispatch: async value => state.requests.push(value) },
  } };
  state.execute = () => dispatch(state.github, state.context, { info: text => state.logs.push(text) }, state.process);
  return state;
}

test("a PR event dispatches its number and original run identity to the trusted default branch", async () => {
  const state = fixture();
  await state.execute();
  assert.deepEqual(state.requests, [{ owner: "example", repo: "project", workflow_id: 40, ref: "main", inputs: { pull_request_number: "13", dispatch_source_run_id: "300" } }]);
  assert.equal(state.reads, 3);
});

test("fork branches and default-branch names are resolved independently", async () => {
  const state = fixture(); state.repository.default_branch = "master";
  state.pull.head.ref = "contributor/credential-grab";
  await state.execute();
  assert.equal(state.requests[0].ref, "master");
  assert.deepEqual(state.requests[0].inputs, { pull_request_number: "13", dispatch_source_run_id: "300" });
  assert.ok(!JSON.stringify(state.requests).includes(state.pull.head.ref));
});

for (const [label, change] of [["draft", { draft: true }], ["closed", { state: "closed" }],
  ["stale-head", { head: { sha: "b".repeat(40) } }]]) {
  test(`${label} PR events do not enqueue model work`, async () => {
    const state = fixture(); Object.assign(state.pull, change);
    await state.execute();
    assert.deepEqual(state.requests, []);
    assert.equal(state.reads, 1);
  });
}

test("reruns and worker events cannot recursively dispatch", async () => {
  for (const event of ["issue_comment", "workflow_dispatch", "issues", "pull_request"]) {
    const state = fixture(); state.context.eventName = event;
    await assert.rejects(state.execute(), /new review request/);
    assert.deepEqual(state.requests, []);
  }
  const state = fixture(); state.process.env.GITHUB_RUN_ATTEMPT = "2";
  await assert.rejects(state.execute(), /new review request/);
  assert.equal(state.reads, 0);
});

test("malformed PR numbers are rejected before API use", async () => {
  for (const number of [undefined, 0, -1, "1;echo bad", 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const state = fixture(); state.context.payload.pull_request.number = number;
    await assert.rejects(state.execute(), /Invalid pull request/);
    assert.equal(state.reads, 0);
  }
});

test("incomplete caller identity cannot select an arbitrary worker", async () => {
  for (const change of [{ workflow_id: "40" }, { workflow_id: undefined }, { id: 299 }, { event: "push" }]) {
    const state = fixture(); Object.assign(state.run, change);
    await assert.rejects(state.execute(), /trusted caller/);
    assert.deepEqual(state.requests, []);
  }
  const state = fixture(); state.repository.default_branch = "";
  await assert.rejects(state.execute(), /trusted caller/);
});

test("dispatch API failures remain visible to the PR instead of faking success", async () => {
  const state = fixture();
  state.github.rest.actions.createWorkflowDispatch = async () => { throw new Error("API unavailable"); };
  await assert.rejects(state.execute(), /API unavailable/);
});

test("dispatcher and worker have separate concurrency lanes and trusted event gates", () => {
  assert.match(workflow, /group: openai-pr-review-\$\{\{ github\.event_name == 'pull_request_target' && 'dispatch' \|\| 'worker' \}\}/);
  assert.match(dispatchJob, /^    if: github\.event_name == 'pull_request_target'$/m);
  assert.match(workflow, /^  review:\n    needs: resolve_review_target\n    if: github\.event_name != 'issues' && github\.event_name != 'pull_request_target'$/m);
  assert.match(dispatchJob, /actions: write/);
  assert.match(workflow, /^  queue: max$/m);
  assert.match(workflow, /^  cancel-in-progress: false$/m);
  assert.match(workflow, /dispatch_source_run_id: \$\{\{ inputs\.dispatch_source_run_id \}\}/);
  assert.doesNotMatch(dispatchJob, /actions\/checkout|OPENAI_API_KEY|checks\.update|continue-on-error/);
  assert.match(workflow, /pull_request_number: \$\{\{ inputs\.pull_request_number \}\}/);
});

test("PR requests and linked-Issue refreshes share a queued per-PR invocation lock", () => {
  const review = workflow.match(/^  review:\n[\s\S]*?(?=^  resolve_linked_prs:)/m)?.[0];
  const refresh = workflow.match(/^  refresh_linked_prs:\n[\s\S]*/m)?.[0];
  assert.ok(review);
  assert.ok(refresh);
  assert.match(review, /group: openai-pr-review-invoke-\$\{\{ needs\.resolve_review_target\.outputs\.number \}\}/);
  assert.match(refresh, /group: openai-pr-review-invoke-\$\{\{ matrix\.pull_request_number \}\}/);
  for (const job of [review, refresh]) {
    assert.match(job, /queue: max/);
    assert.match(job, /cancel-in-progress: false/);
  }
});

test("linked-Issue refreshes select only open PRs in the caller repository", async () => {
  const job = workflow.match(/^  resolve_linked_prs:\n[\s\S]*?(?=^  refresh_linked_prs:)/m)?.[0];
  assert.ok(job);
  const body = job.split("          script: |\n")[1].split("\n")
    .map(line => line.startsWith("            ") ? line.slice(12) : line).join("\n");
  const resolve = new AsyncFunction("github", "context", "core", body);
  const nodes = [
    { number: 12, state: "OPEN", repository: { nameWithOwner: "example/project" } },
    { number: 13, state: "OPEN", repository: { nameWithOwner: "other/project" } },
    { number: 14, state: "CLOSED", repository: { nameWithOwner: "Example/Project" } },
  ];
  const result = { repository: { issue: { closedByPullRequestsReferences: { totalCount: nodes.length, nodes } } } };
  const outputs = {};
  const github = { graphql: async query => {
    assert.match(query, /repository\s*\{\s*nameWithOwner\s*\}/);
    return result;
  } };
  const context = { repo: { owner: "Example", repo: "Project" }, payload: { issue: { number: 1 } } };
  const core = { setOutput: (key, value) => { outputs[key] = value; } };
  await resolve(github, context, core);
  assert.deepEqual(outputs, { pull_requests: "[12]", pull_request_count: "1" });
  nodes[1].repository = null;
  await assert.rejects(resolve(github, context, core), /linked pull request repository/);
  nodes[1].repository = { nameWithOwner: "other/project" };
  result.repository.issue.closedByPullRequestsReferences.totalCount = 51;
  await assert.rejects(resolve(github, context, core), /within the configured bound/);
});

test("the invocation lock normalizes PR numbers and rejects invalid targets", () => {
  const job = workflow.match(/^  resolve_review_target:\n[\s\S]*?(?=^  review:)/m)?.[0];
  const body = job?.match(/          node <<'NODE'\n([\s\S]*?)\n          NODE/)?.[1];
  assert.ok(body);
  const run = new Function("require", "process", body);
  const invoke = (event, isPR, input, issue) => {
    let output = "";
    run(name => {
      assert.equal(name, "node:fs");
      return { appendFileSync: (file, value) => { assert.equal(file, "output"); output += value; } };
    }, { env: { GITHUB_OUTPUT: "output", CODEX_REVIEW_EVENT_NAME: event, CODEX_REVIEW_IS_PR: isPR,
      CODEX_REVIEW_PR_INPUT: input, CODEX_REVIEW_ISSUE_NUMBER: issue } });
    return output;
  };
  for (const value of ["13", "0013", "13.0"]) {
    assert.equal(invoke("workflow_dispatch", "false", value, ""), "number=13\n");
  }
  assert.equal(invoke("issue_comment", "true", "", "13"), "number=13\n");
  for (const value of ["", "0", "1.1", "not-a-number", "9007199254740992"]) {
    assert.throws(() => invoke("workflow_dispatch", "false", value, ""), /positive safe integer/);
  }
  assert.throws(() => invoke("issue_comment", "false", "", "13"), /Unsupported review event/);
});
