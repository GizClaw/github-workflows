import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { automaticDispatchFence } from "./dispatch-fence.mjs";

const head = "a".repeat(40);
const repository = { owner: "example", repo: "project" };
const originalTime = "2026-11-05T01:00:00Z";
function comment(body = `@codex review approve ${head}`, created = "2026-11-05T01:01:00Z") {
  return { id: 400, body, created_at: created, user: { type: "User", login: "admin-user" } };
}
function fixture() {
  const state = {
    source: { id: 200, run_attempt: 1, event: "pull_request_target", workflow_id: 40,
      path: ".github/workflows/review.yml", created_at: originalTime, head_sha: head,
      pull_requests: [{ number: 13, head: { sha: head } }] },
    current: { id: 500, run_attempt: 1, event: "workflow_dispatch", workflow_id: 40,
      path: ".github/workflows/review.yml", created_at: "2026-11-05T01:03:00Z" },
    pull: { number: 13, state: "open", draft: false, head: { sha: head, repo: { full_name: "contributor/fork" } },
      base: { repo: { private: false }, sha: "b".repeat(40), ref: "main" } },
    context: { eventName: "workflow_dispatch", runId: 500, repo: repository },
    commentPages: [], reads: [],
  };
  const listComments = () => {};
  state.github = {
    rest: { actions: { getWorkflowRun: async parameters => {
      state.reads.push(parameters);
      return { data: structuredClone(parameters.run_id === 200 ? state.source : state.current) };
    } }, issues: { listComments } },
    paginate: async (method, parameters) => {
      assert.equal(method, listComments);
      assert.equal(parameters.issue_number, 13);
      assert.equal(parameters.per_page, 100);
      state.reads.push(parameters);
      // Model GitHub's exclusive updated_at filter, including same-second data.
      return state.commentPages.flat().filter(item => {
        const updated = Date.parse(item.updated_at || item.created_at);
        return !Number.isFinite(updated) || updated > Date.parse(parameters.since);
      });
    },
  };
  state.args = { github: state.github, context: state.context, sourceRunId: "200", pull: state.pull };
  state.run = () => automaticDispatchFence(state.args);
  return state;
}

test("a current automatic request with no newer comment can start without granting approval", async () => {
  const state = fixture();
  const result = await state.run();
  assert.equal(result.eligible, true);
  assert.deepEqual(Object.keys(result).sort(), ["eligible", "reason"]);
  assert.equal(state.reads.length, 3);
  for (const read of state.reads) {
    assert.equal(read.headers["cache-control"], "no-cache");
    assert.ok(read.cache_bust);
  }
  assert.equal(new Set(state.reads.map(read => read.cache_bust)).size, 3);
});

test("a delayed automatic child uses the original request time, not its later arrival", async () => {
  const state = fixture();
  state.commentPages = [[comment()]];
  assert.ok(Date.parse(state.commentPages[0][0].created_at) < Date.parse(state.current.created_at));
  assert.equal((await state.run()).eligible, false);
});

test("an approval arriving while source metadata is being read is seen before admission", async () => {
  const state = fixture();
  const getRun = state.github.rest.actions.getWorkflowRun;
  state.github.rest.actions.getWorkflowRun = async parameters => {
    const result = await getRun(parameters);
    state.commentPages = [[comment()]];
    return result;
  };
  assert.equal((await state.run()).eligible, false);
});

test("new ordinary and same-second review comments also supersede automatic requests", async () => {
  for (const newer of [comment("@codex review"), comment(`@codex review approve ${head}`, originalTime)]) {
    const state = fixture(); state.commentPages = [[newer]];
    assert.equal((await state.run()).eligible, false);
  }
});

test("old comments edited after the event do not falsely supersede a new request", async () => {
  const state = fixture();
  state.commentPages = [[{ ...comment("@codex review", "2026-11-04T01:00:00Z"), updated_at: "2026-11-05T01:04:00Z" }]];
  assert.equal((await state.run()).eligible, true);
});

test("quoted instructions, ordinary discussion, and bot comments cannot suppress a review", async () => {
  for (const ignored of [comment("Looks good"), comment("`@codex review`"), comment("> @codex review"),
    comment("```\n@codex review\n```"), comment("    @codex review"),
    { ...comment(), user: { type: "Bot", login: "automation[bot]" } }]) {
    const state = fixture(); state.commentPages = [[ignored]];
    assert.equal((await state.run()).eligible, true);
  }
});

test("a newer review request on later API pages is honored", async () => {
  const state = fixture();
  state.commentPages = [Array.from({ length: 100 }, () => comment("ordinary discussion")), [comment()]];
  assert.equal((await state.run()).eligible, false);
});

test("source PR, changed heads, drafts, and closed PRs are fenced", async () => {
  for (const patch of [{ number: 14 }, { state: "closed" }, { draft: true },
    { head: { sha: "c".repeat(40) } }]) {
    const state = fixture(); Object.assign(state.pull, patch);
    assert.equal((await state.run()).eligible, false);
  }
  const state = fixture(); state.source.pull_requests = [];
  assert.equal((await state.run()).eligible, false);
});

test("a dynamic PR association cannot disguise a dispatch from an older head", async () => {
  const state = fixture();
  const newerHead = "c".repeat(40);
  state.pull.head.sha = newerHead;
  state.source.pull_requests[0].head.sha = newerHead;
  assert.equal(state.source.head_sha, head, "GitHub keeps the source run's own commit fixed");
  assert.equal((await state.run()).eligible, false);
  assert.equal(state.reads.length, 2, "no comment data is needed for a stale source commit");
});

test("unrelated workflows, reruns, malformed origins and impossible time order fail closed", async () => {
  for (const patch of [{ id: 199 }, { workflow_id: 41 }, { path: "another.yml" }, { event: "push" },
    { run_attempt: 2 }, { created_at: "invalid" }, { created_at: "2026-11-05T01:04:00Z" }]) {
    const state = fixture(); Object.assign(state.source, patch);
    await assert.rejects(state.run(), /original caller workflow/);
  }
  for (const sourceRunId of ["", "junk", "0", "500", "600", "9007199254740992"]) {
    const state = fixture(); state.args.sourceRunId = sourceRunId;
    await assert.rejects(state.run(), /Invalid automatic review source/);
  }
  const state = fixture(); state.context.eventName = "issue_comment";
  await assert.rejects(state.run(), /Invalid automatic review source/);
});

test("unreadable metadata and invalid request timestamps never admit a review", async () => {
  const state = fixture();
  state.github.paginate = async () => { throw new Error("API unavailable"); };
  await assert.rejects(state.run(), /API unavailable/);
  const invalid = fixture(); invalid.commentPages = [[comment("@codex review", "invalid")]];
  await assert.rejects(invalid.run(), /valid creation time/);
});

const root = fileURLToPath(new URL("../../../", import.meta.url));
const workflow = fs.readFileSync(new URL("../../workflows/codex-openai-review.yml", import.meta.url), "utf8");
const resolve = workflow.match(/^  resolve:\n([\s\S]*?)(?=^  start:)/m)[0];
const prScript = resolve.split("          script: |\n")[1].split("\n")
  .map(line => line.startsWith("            ") ? line.slice(12) : line).join("\n");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const runResolver = new AsyncFunction("require", "github", "context", "core", "process", prScript);
const require = createRequire(import.meta.url);
async function resolveRequest(state, commentEvent = false, permission = "admin") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-dispatch-fence-"));
  try {
    fs.symlinkSync(root, path.join(directory, ".openai-pr-review-trigger-source"), "dir");
    const outputs = {};
    state.github.rest.pulls = { get: async () => ({ data: state.pull }) };
    state.github.rest.repos = { getCollaboratorPermissionLevel: async () => ({ data: { permission } }) };
    const context = commentEvent ? { ...state.context, eventName: "issue_comment", payload: {
      issue: { number: 13, pull_request: {} }, comment: state.commentPages.at(-1)?.at(-1) || comment(),
    } } : state.context;
    await runResolver(require, state.github, context,
      { setOutput: (key, value) => { outputs[key] = value; }, info() {}, warning() {} },
      { env: { GITHUB_WORKSPACE: directory, REQUESTED_PULL_NUMBER: commentEvent ? "" : "13",
        DISPATCH_SOURCE_RUN_ID: commentEvent ? "" : "200", COMMENT_REVIEW_REQUESTED: commentEvent ? "true" : "" } });
    return outputs;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("actual resolver skips a delayed child before any verdict or approval output", async () => {
  const state = fixture(); state.commentPages = [[comment()]];
  assert.deepEqual(await resolveRequest(state), { eligible: "false" });
});

test("actual approved comment retains admin and exact-head verification after automatic skip", async () => {
  const state = fixture(); state.commentPages = [[comment()]];
  assert.deepEqual(await resolveRequest(state), { eligible: "false" });
  const approved = await resolveRequest(state, true);
  assert.equal(approved.eligible, "true");
  assert.equal(approved.large_diff_approved, "true");
  assert.equal(approved.request_comment_id, "400");
  assert.equal((await resolveRequest(state, true, "write")).large_diff_approved, "false");
  state.commentPages = [[comment(`@codex review approve ${"d".repeat(40)}`)]];
  assert.equal((await resolveRequest(state, true)).large_diff_approved, "false");
});

test("admitted automatic requests never inherit comment-based approval", async () => {
  const result = await resolveRequest(fixture());
  assert.equal(result.eligible, "true");
  assert.equal(result.large_diff_approved, "false");
  assert.equal(result.request_comment_id, "");
});

test("fenced workers cannot start checks, load model checkpoints or finalize statuses", () => {
  for (const job of ["start", "review", "finalize"]) {
    const block = workflow.match(new RegExp(`^  ${job}:\\n([\\s\\S]*?)(?=^  [a-z_-]+:|$(?![\\s\\S]))`, "m"))?.[0];
    assert.ok(block?.includes("needs.resolve.outputs.eligible == 'true'"), job);
  }
  assert.match(resolve, /actions: read/);
  assert.match(resolve, /issues: read/);
  assert.match(resolve, /github\.event_name == 'issue_comment' \|\| inputs\.dispatch_source_run_id != ''/);
});
