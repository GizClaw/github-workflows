import assert from "node:assert/strict";
import test from "node:test";
import { reconcileSupersededChecks } from "./checks.mjs";

const head = "a".repeat(40);
const app = { id: 15368, slug: "github-actions" };
const repository = "https://api.github.com/repos/example/project";

function fixture() {
  const state = { updates: [], reads: 0 };
  const checkIds = { pr: 301, issue: 302, code: 303 };
  const names = { pr: "OpenAI PR Review", issue: "OpenAI Issue Review", code: "OpenAI Code Review" };
  state.checks = Object.entries(checkIds).map(([key, id]) => ({
    id, name: names[key], head_sha: head, status: "completed", conclusion: "success",
    app, external_id: `300:1:13:${key}`, url: `${repository}/check-runs/${id}`,
  }));
  state.runs = new Map([
    [300, { id: 300, run_attempt: 1, workflow_id: 40, path: ".github/workflows/codex-review.yml",
      created_at: "2026-11-05T02:00:00Z", event: "issue_comment", status: "in_progress" }],
    [100, { id: 100, run_attempt: 1, workflow_id: 40, path: ".github/workflows/codex-review.yml",
      created_at: "2026-11-05T01:00:00Z", event: "pull_request_target", status: "completed",
      conclusion: "failure", head_sha: head, pull_requests: [{ number: 13, head: { sha: head } }],
      referenced_workflows: [{ path: "GizClaw/github-workflows/.github/workflows/codex-openai-review.yml@latest" }] }],
  ]);
  state.jobs = new Map();
  state.add = (id, name, conclusion = "failure", runId = 100) => {
    const url = `${repository}/check-runs/${id}`;
    const check = { id, name, app, head_sha: head, status: "completed", conclusion, url,
      details_url: `https://github.com/example/project/actions/runs/${runId}/job/${id}` };
    state.checks.push(check);
    state.jobs.set(id, { id, name, run_id: runId, status: "completed", conclusion, check_run_url: url });
    return check;
  };
  state.add(201, "review / review");
  state.add(202, "review / publish", "cancelled");
  state.add(203, "Windows desktop (amd64)");
  state.pull = { state: "open", draft: false, head: { sha: head } };
  const listForRef = () => {};
  const github = {
    rest: {
      checks: {
        get: async ({ check_run_id }) => ({ data: structuredClone(state.checks.find(check => check.id === check_run_id)) }),
        listForRef,
        update: async parameters => {
          state.updates.push(parameters);
          state.checks.find(check => check.id === parameters.check_run_id).conclusion = parameters.conclusion;
          return { data: {} };
        },
      },
      actions: {
        getWorkflowRun: async ({ run_id }) => ({ data: structuredClone(state.runs.get(run_id)) }),
        getJobForWorkflowRun: async ({ job_id }) => ({ data: structuredClone(state.jobs.get(job_id)) }),
      },
      pulls: { get: async () => ({ data: structuredClone(state.pull) }) },
    },
    paginate: async (method, parameters) => {
      assert.equal(method, listForRef);
      assert.equal(parameters.ref, head);
      assert.equal(parameters.filter, "latest");
      assert.equal(parameters.per_page, 100);
      state.reads += 1;
      if (state.beforeList) state.beforeList(state.reads);
      return structuredClone(state.checks);
    },
  };
  state.args = { github, owner: "example", repo: "project", pullNumber: 13, headSha: head,
    runId: 300, runAttempt: 1, checkIds, workflowRepository: "GizClaw/github-workflows" };
  state.run = () => reconcileSupersededChecks(state.args);
  return state;
}

function unchanged(state) {
  assert.deepEqual(state.updates, []);
  assert.equal(state.checks.find(check => check.id === 201).conclusion, "failure");
}

test("successful retries neutralize only obsolete native review jobs and retain audit links", async () => {
  const state = fixture();
  assert.deepEqual(await state.run(), { updated: [201, 202], skipped: null });
  assert.equal(state.checks.find(check => check.id === 203).conclusion, "failure", "business CI is untouched");
  assert.equal(state.runs.get(100).conclusion, "failure", "the original Actions run is retained");
  assert.ok(state.updates.every(update => update.conclusion === "neutral"));
  assert.match(state.updates[0].output.summary, /runs\/300/);
  assert.match(state.updates[0].output.summary, /runs\/100\/job\/201/);
  assert.deepEqual(await state.run(), { updated: [], skipped: null }, "reconciliation is idempotent");
});

for (const conclusion of ["failure", "cancelled", "neutral", null]) {
  test(`a ${conclusion} verdict never supersedes earlier failures`, async () => {
    const state = fixture();
    state.checks[1].conclusion = conclusion;
    assert.ok((await state.run()).skipped);
    unchanged(state);
  });
}

test("verdicts must belong to this run, attempt, PR, head and GitHub Actions app", async () => {
  for (const change of [
    { external_id: "299:1:13:pr" }, { external_id: "300:2:13:pr" },
    { external_id: "300:1:14:pr" }, { head_sha: "b".repeat(40) },
    { app: { id: 42, slug: "third-party" } }, { status: "in_progress" }, { name: "Other review" },
  ]) {
    const state = fixture();
    Object.assign(state.checks[0], change);
    assert.ok((await state.run()).skipped);
    unchanged(state);
  }
});

test("missing or duplicated verdict IDs cannot authorize updates", async () => {
  for (const checkIds of [{}, { pr: 301, issue: 301, code: 303 }]) {
    const state = fixture(); state.args.checkIds = checkIds;
    assert.ok((await state.run()).skipped);
    unchanged(state);
  }
});

test("only the same trusted caller and explicit PR/head association qualify", async () => {
  for (const change of [
    { workflow_id: 99 }, { path: ".github/workflows/build.yml" }, { event: "push" },
    { head_sha: "b".repeat(40) }, { pull_requests: [] },
    { pull_requests: [{ number: 14, head: { sha: head } }] },
    { pull_requests: [{ number: 13, head: { sha: "b".repeat(40) } }] },
    { referenced_workflows: [] }, { status: "in_progress" },
    { created_at: "invalid" }, { created_at: "2026-11-05T03:00:00Z" },
  ]) {
    const state = fixture(); Object.assign(state.runs.get(100), change);
    assert.deepEqual((await state.run()).updated, []);
    unchanged(state);
  }
});

test("lookalike checks, untrusted links, and unrelated heads remain unchanged", async () => {
  for (const change of [
    { head_sha: "b".repeat(40) }, { app: { id: 42, slug: "github-actions" } },
    { name: "build / review" }, { status: "in_progress" },
    { details_url: "https://example.com/example/project/actions/runs/100/job/201" },
    { details_url: "https://github.com/another/project/actions/runs/100/job/201" },
    { details_url: "https://github.com/example/project/actions/runs/100/job/201?spoofed=1" },
    { details_url: "https://github.com/example/project/actions/runs/301/job/201" },
  ]) {
    const state = fixture(); Object.assign(state.checks.find(check => check.id === 201), change);
    assert.deepEqual((await state.run()).updated, [202]);
    assert.ok(!state.updates.some(update => update.check_run_id === 201));
  }
});

test("the native job must identify the exact check run and terminal outcome", async () => {
  for (const change of [{ check_run_url: `${repository}/check-runs/999` }, { name: "test" },
    { run_id: 101 }, { status: "in_progress" }, { conclusion: "success" }]) {
    const state = fixture(); Object.assign(state.jobs.get(201), change);
    assert.deepEqual((await state.run()).updated, [202]);
  }
});

for (const when of [1, 2]) {
  test(`a newer review discovered on read ${when} prevents stale-finalizer updates`, async () => {
    const state = fixture();
    state.beforeList = read => {
      if (read === when) state.checks.push({ ...state.checks[0], id: 400, status: "in_progress", conclusion: null });
    };
    assert.ok((await state.run()).skipped);
    unchanged(state);
  });
}

test("fresh snapshots cannot reuse a cached success after another review starts", async () => {
  const state = fixture();
  const paginate = state.args.github.paginate;
  const seen = new Set();
  let reads = 0;
  state.args.github.paginate = async (method, parameters) => {
    reads += 1;
    const fresh = parameters.headers?.["cache-control"] === "no-cache"
      && parameters.cache_bust && !seen.has(parameters.cache_bust);
    seen.add(parameters.cache_bust);
    const checks = await paginate(method, parameters);
    if (reads === 2 && fresh) checks.push({ ...checks[0], id: 400, status: "in_progress", conclusion: null });
    return checks;
  };
  assert.ok((await state.run()).skipped);
  assert.equal(seen.size, 2);
  unchanged(state);
});

test("head moves, closed PRs and drafts are rechecked before writes", async () => {
  for (const change of [{ head: { sha: "b".repeat(40) } }, { state: "closed" }, { draft: true }]) {
    const state = fixture(); Object.assign(state.pull, change);
    assert.ok((await state.run()).skipped);
    unchanged(state);
  }
});

test("a native job already updated by another finalizer is left alone", async () => {
  const state = fixture();
  state.beforeList = read => { if (read === 2) state.checks.find(check => check.id === 201).conclusion = "neutral"; };
  assert.deepEqual((await state.run()).updated, [202]);
});

test("incomplete API evidence aborts before any mutation", async () => {
  const state = fixture();
  state.args.github.rest.actions.getJobForWorkflowRun = async () => { throw new Error("API unavailable"); };
  await assert.rejects(state.run(), /API unavailable/);
  unchanged(state);
});

test("invalid review identities are rejected before API calls", async () => {
  const state = fixture(); state.args.headSha = "not-a-commit";
  await assert.rejects(state.run(), /Invalid review identity/);
  unchanged(state);
});
