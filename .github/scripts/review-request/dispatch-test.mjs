import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const workflow = fs.readFileSync(new URL("../../workflows/openai-pr-review-dispatch.yml", import.meta.url), "utf8");
const dispatchJob = workflow.match(/^  dispatch_review:\n([\s\S]*?)(?=^  review:)/m)?.[0];
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

test("a PR event dispatches only its number to the trusted default branch", async () => {
  const state = fixture();
  await state.execute();
  assert.deepEqual(state.requests, [{ owner: "example", repo: "project", workflow_id: 40, ref: "main", inputs: { pull_request_number: "13" } }]);
  assert.equal(state.reads, 3);
});

test("fork branches and default-branch names are resolved independently", async () => {
  const state = fixture(); state.repository.default_branch = "master";
  state.pull.head.ref = "contributor/credential-grab";
  await state.execute();
  assert.equal(state.requests[0].ref, "master");
  assert.deepEqual(state.requests[0].inputs, { pull_request_number: "13" });
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
  assert.match(workflow, /^  review:\n    if: github\.event_name != 'issues' && github\.event_name != 'pull_request_target'$/m);
  assert.match(dispatchJob, /actions: write/);
  assert.doesNotMatch(dispatchJob, /actions\/checkout|OPENAI_API_KEY|checks\.update|continue-on-error/);
  assert.match(workflow, /pull_request_number: \$\{\{ inputs\.pull_request_number \}\}/);
});
