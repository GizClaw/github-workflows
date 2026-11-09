import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  authenticatedArtifactName, findSessionArtifact, restoreSnapshot, signSnapshot, snapshotTreeHash,
} from "./session-artifacts.mjs";

const KEY = "fixture-openai-api-key";
const POLICY = "Review the complete diff and retain completed checkpoints.";
const SESSION_ID = "019a4a8b-1234-7000-8000-123456789abc";
const SESSION_PATH = `sessions/2026/11/09/rollout-${SESSION_ID}.jsonl`;
const GENERATION = "a".repeat(64);
const CHECKPOINT = `generations/${GENERATION}/results/0001.json`;
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const EXPECTED = {
  repository_id: "17", repository: "example/reviewer", pull_request: "13",
  session_key: "repo:17:pr:13:v2", source_run_id: "101", source_run_attempt: "1",
  model: "fixture-model", effort: "xhigh", codex_version: "0.163.0",
  review_instructions_sha256: sha256(POLICY),
};

function write(root, relative, bytes) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
}

// Re-sign deliberate compatibility/identity changes so those tests reach the
// validation after authentication, rather than passing on an invalid HMAC.
function seal(fixture) {
  fixture.manifest.session_sha256 = sha256(fs.readFileSync(path.join(fixture.directory, "session.jsonl")));
  fixture.manifest.state_sha256 = snapshotTreeHash(path.join(fixture.directory, "state"));
  write(fixture.directory, "manifest.json", json(fixture.manifest));
  return signSnapshot(fixture.directory, KEY);
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-session-artifacts-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const session = [
    { type: "session_meta", payload: { id: SESSION_ID, thread_source: "cli" } },
    { type: "response_item", payload: { role: "user", content: "Review this PR." } },
    { type: "event_msg", payload: { type: "task_complete", last_agent_message: "Checkpoint saved." } },
  ].map(item => JSON.stringify(item)).join("\n") + "\n";
  const generation = {
    key: GENERATION, status: "in_progress", from_sha: "b".repeat(40), to_sha: "c".repeat(40),
    chunks: [
      { id: "0001", status: "completed", relative_path: "chunks/0001.diff" },
      { id: "0002", status: "pending", relative_path: "chunks/0002.diff" },
    ],
  };
  const stateFiles = {
    "review-ledger.json": json({ schema_version: 2, session_key: EXPECTED.session_key, generations: [generation] }),
    [`generations/${GENERATION}/generation.json`]: json(generation),
    [`generations/${GENERATION}/chunks/0001.diff`]: "diff --git a/a.txt b/a.txt\n-old\n+new\n",
    [`generations/${GENERATION}/chunks/0002.diff`]: "diff --git a/b.txt b/b.txt\n-before\n+after\n",
    [CHECKPOINT]: json({ status: "completed", verdict: "PASS", session_id: SESSION_ID }),
  };
  const result = {
    root, directory: path.join(root, "download"), codexHome: path.join(root, "fresh-codex"),
    stateDir: path.join(root, "fresh-state"), key: KEY, expected: { ...EXPECTED }, artifactId: 901,
    manifest: {
      ...EXPECTED, schema_version: 2, pull_request: 13, session_id: SESSION_ID,
      session_relative_path: SESSION_PATH, session_bytes: Buffer.byteLength(session),
    },
    session, stateFiles,
  };
  write(result.directory, "session.jsonl", session);
  for (const [relative, bytes] of Object.entries(stateFiles)) write(result.directory, `state/${relative}`, bytes);
  result.artifactName = seal(result);
  return result;
}

function assertCold(f, overrides = {}) {
  // A rejected snapshot must remove stale data, including a previous session.
  write(f.codexHome, "sessions/stale.jsonl", "stale session");
  write(f.stateDir, "review-ledger.json", "stale checkpoint");
  const { reason, ...status } = restoreSnapshot({ ...f, ...overrides });
  assert.deepEqual(status, { resumed: false, session_id: "", previous_artifact_id: "" });
  assert.match(reason, /full review/i);
  assert.ok(!reason.includes(KEY), "fallback must not expose authentication material");
  assert.equal(fs.existsSync(f.codexHome), false, "fallback removes the session directory");
  assert.equal(fs.existsSync(f.stateDir), false, "fallback removes all review checkpoints");
}

function assertRestored(f, result) {
  assert.equal(result.resumed, true);
  assert.equal(result.session_id, SESSION_ID);
  assert.equal(result.previous_artifact_id, String(f.artifactId));
  assert.equal(fs.readFileSync(path.join(f.codexHome, SESSION_PATH), "utf8"), f.session);
  const restoredFiles = fs.readdirSync(f.stateDir, { recursive: true })
    .filter(relative => fs.statSync(path.join(f.stateDir, relative)).isFile()).sort();
  assert.deepEqual(restoredFiles, Object.keys(f.stateFiles).sort());
  for (const [relative, bytes] of Object.entries(f.stateFiles)) {
    assert.equal(fs.readFileSync(path.join(f.stateDir, relative), "utf8"), bytes, relative);
  }
  assert.equal(fs.existsSync(path.join(f.codexHome, "sessions/stale.jsonl")), false);
}

test("signed snapshots round-trip the primary session, ledger and nested checkpoints into fresh paths", t => {
  const f = fixture(t);
  assert.equal(fs.existsSync(f.codexHome), false);
  assert.equal(fs.existsSync(f.stateDir), false);
  assert.equal(f.artifactName, authenticatedArtifactName({
    repositoryId: "17", pullNumber: 13, runId: "101", key: KEY,
  }));
  assertRestored(f, restoreSnapshot(f));
  // A repeated restore also clears unrelated/stale files at the destinations.
  write(f.codexHome, "sessions/stale.jsonl", "stale");
  write(f.stateDir, "unrelated.json", "stale");
  assertRestored(f, restoreSnapshot(f));
  write(f.stateDir, CHECKPOINT, "changed after restoration");
  assert.equal(fs.readFileSync(path.join(f.directory, "state", CHECKPOINT), "utf8"), f.stateFiles[CHECKPOINT]);
});

function artifact(id, runId, overrides = {}, identity = {}) {
  return {
    id, name: authenticatedArtifactName({ repositoryId: "17", pullNumber: 13, runId, key: KEY, ...identity }),
    created_at: "2026-11-09T10:00:00Z", expired: false, workflow_run: { id: runId }, ...overrides,
  };
}

async function find(artifacts, key = KEY) {
  const listArtifactsForRepo = () => assert.fail("use the paginated artifact listing");
  const github = {
    rest: { actions: { listArtifactsForRepo } },
    paginate: async (method, parameters) => {
      assert.equal(method, listArtifactsForRepo);
      assert.deepEqual(parameters, { owner: "example", repo: "reviewer", per_page: 100 });
      return artifacts;
    },
  };
  return findSessionArtifact({ github, context: { repo: { owner: "example", repo: "reviewer" }, runId: 500 },
    repositoryId: "17", pullNumber: 13, key });
}

const rejectedArtifacts = [
  ["a forged HMAC", () => artifact(990, 190, { name: artifact(990, 190).name.replace(/.$/, char => char === "0" ? "1" : "0") })],
  ["an unsigned legacy name", () => artifact(990, 190, { name: "openai-pr-review-session-v2-17-pr-13-run-190-attempt-1" })],
  ["a name signed with another secret", () => artifact(990, 190, {}, { key: "unrelated-fixture-key" })],
  ["another repository", () => artifact(990, 190, {}, { repositoryId: "18" })],
  ["another PR", () => artifact(990, 190, {}, { pullNumber: 14 })],
  ["an expired snapshot", () => artifact(990, 190, { expired: true })],
  ["the current run", () => artifact(990, 500)],
  ["a rerun snapshot", () => artifact(990, 190, {}, { attempt: 2 })],
  ["a name with mismatched run metadata", () => artifact(990, 190, { workflow_run: { id: 191 } })],
  ["missing run metadata", () => artifact(990, 190, { workflow_run: undefined })],
];

for (const [description, create] of rejectedArtifacts) {
  test(`artifact selection rejects ${description}, even when newer than the valid snapshot`, async () => {
    const valid = artifact(901, 101);
    const rejected = { ...create(), created_at: "2026-11-09T12:00:00Z" };
    assert.equal(await find([rejected, valid]), valid);
    assert.equal(await find([rejected]), null);
  });
}

test("artifact selection chooses the newest authenticated same-PR snapshot with a stable ID tie-break", async () => {
  const older = artifact(910, 110, { created_at: "2026-11-09T09:00:00Z" });
  const newest = artifact(902, 102);
  const tied = artifact(903, 103);
  assert.equal(await find([newest, older, tied]), tied);
  assert.equal(await find([tied, older, newest]), tied);
  assert.equal(await find([newest, older]), newest);
  assert.equal(await find([newest], "wrong-fixture-key"), null);
  assert.equal(await find([]), null);
});

const tampering = [
  ["session bytes", f => fs.appendFileSync(path.join(f.directory, "session.jsonl"), "{}\n")],
  ["checkpoint bytes", f => write(f.directory, `state/${CHECKPOINT}`, "tampered checkpoint")],
  ["ledger bytes", f => write(f.directory, "state/review-ledger.json", "{}\n")],
  ["checkpoint paths", f => fs.renameSync(path.join(f.directory, "state", CHECKPOINT), path.join(f.directory, "state", `${CHECKPOINT}.renamed`))],
  ["an added state file", f => write(f.directory, "state/injected.json", "{}")],
  ["a removed state file", f => fs.rmSync(path.join(f.directory, "state", CHECKPOINT))],
  ["manifest fields", f => write(f.directory, "manifest.json", json({ ...f.manifest, pull_request: 14 }))],
  ["manifest whitespace", f => fs.appendFileSync(path.join(f.directory, "manifest.json"), "\n")],
  ["signature bytes", f => write(f.directory, "manifest.hmac", `${"0".repeat(64)}\n`)],
  ["a malformed signature", f => write(f.directory, "manifest.hmac", "not-a-valid-hmac\n")],
];
for (const [description, change] of tampering) {
  test(`restoration falls back cleanly after tampering with ${description}`, t => {
    const f = fixture(t);
    change(f);
    assertCold(f);
  });
}

const incompatible = {
  repository_id: "18", repository: "example/another-repo", pull_request: "14",
  session_key: "repo:17:pr:14:v2", source_run_id: "102", source_run_attempt: "2",
  model: "another-model", effort: "low", codex_version: "0.164.0",
  review_instructions_sha256: sha256("A different review policy"),
};
for (const [field, value] of Object.entries(incompatible)) {
  test(`an authenticated snapshot with the wrong ${field} cannot resume`, t => {
    const f = fixture(t);
    assertCold(f, { expected: { ...EXPECTED, [field]: value } });
  });
}

test("a snapshot authenticated with a different secret falls back cleanly", t => {
  const f = fixture(t);
  assertCold(f, { key: "wrong-fixture-key" });
});

for (const [description, change] of [
  ["an unsupported schema", f => { f.manifest.schema_version = 1; }],
  ["a session path outside sessions", f => { f.manifest.session_relative_path = "../escaped.jsonl"; }],
  ["a mismatched session ID", f => { f.manifest.session_id = "019a4a8b-9999-7000-8000-123456789abc"; }],
  ["a subagent session", f => write(f.directory, "session.jsonl", json({ type: "session_meta", payload: { id: SESSION_ID, thread_source: "subagent" } }))],
  ["a child thread", f => write(f.directory, "session.jsonl", json({ type: "session_meta", payload: { id: SESSION_ID, parent_thread_id: "parent-thread" } }))],
  ["missing session metadata", f => write(f.directory, "session.jsonl", json({ type: "event_msg", payload: {} }))],
  ["a ledger for another PR", f => write(f.directory, "state/review-ledger.json", json({ session_key: "repo:17:pr:14:v2", generations: [] }))],
  ["a malformed ledger", f => write(f.directory, "state/review-ledger.json", json({ session_key: EXPECTED.session_key, generations: {} }))],
]) {
  test(`authentication does not allow ${description}`, t => {
    const f = fixture(t);
    change(f);
    seal(f);
    assertCold(f);
    assert.equal(fs.existsSync(path.join(f.root, "escaped.jsonl")), false);
  });
}

for (const relative of ["manifest.json", "manifest.hmac", "session.jsonl", "state", "state/generations", `state/${CHECKPOINT}`]) {
  test(`restoration rejects a symlink at ${relative}`, t => {
    const f = fixture(t);
    const source = path.join(f.directory, relative);
    const target = path.join(f.root, "symlink-target");
    fs.renameSync(source, target);
    fs.symlinkSync(target, source);
    assertCold(f);
    assert.equal(fs.existsSync(target), true, "cleanup must leave the link target intact");
  });
}

for (const relative of ["manifest.json", "manifest.hmac", "session.jsonl", "state/review-ledger.json"]) {
  test(`a download missing ${relative} falls back cleanly`, t => {
    const f = fixture(t);
    fs.rmSync(path.join(f.directory, relative));
    assertCold(f);
  });
}

test("a missing artifact starts a full review without requiring a downloaded directory", t => {
  const f = fixture(t);
  fs.rmSync(f.directory, { recursive: true });
  assertCold(f, { artifactId: "" });
});

test("an artifact whose download is unavailable falls back cleanly", t => {
  const f = fixture(t);
  fs.rmSync(f.directory, { recursive: true });
  assertCold(f);
});

test("a partial state copy is removed before falling back to a full review", t => {
  const f = fixture(t);
  const copies = [];
  t.mock.method(fs, "cpSync", (source, destination) => {
    copies.push([source, destination]);
    write(destination, CHECKPOINT, "partially copied checkpoint");
    throw new Error("Injected copy failure after writing a checkpoint");
  });
  assertCold(f);
  assert.deepEqual(copies, [[path.join(f.directory, "state"), f.stateDir]],
    "exercise copy cleanup after successful authentication");
});

for (const relative of ["session.jsonl", `state/${CHECKPOINT}`]) {
  test(`signing refuses ${relative} changed after manifest creation`, t => {
    const f = fixture(t);
    fs.rmSync(path.join(f.directory, "manifest.hmac"));
    fs.appendFileSync(path.join(f.directory, relative), "changed");
    assert.throws(() => signSnapshot(f.directory, KEY), /changed before authentication/);
    assert.equal(fs.existsSync(path.join(f.directory, "manifest.hmac")), false);
  });
}

test("CLI signs and restores using the forwarded fixture key and emits resume outputs", t => {
  const f = fixture(t);
  const output = path.join(f.root, "github-output");
  fs.writeFileSync(output, "");
  const script = fileURLToPath(new URL("./session-artifacts.mjs", import.meta.url));
  const env = {
    OPENAI_API_KEY: KEY, GITHUB_OUTPUT: output, SESSION_SNAPSHOT_DIR: f.directory,
    SESSION_DOWNLOAD_DIR: f.directory, CODEX_HOME: f.codexHome, PR_REVIEW_STATE_DIR: f.stateDir,
    EXPECTED_ARTIFACT_ID: String(f.artifactId), EXPECTED_RUN_ID: EXPECTED.source_run_id,
    REPOSITORY_ID: EXPECTED.repository_id, GITHUB_REPOSITORY: EXPECTED.repository,
    PULL_REQUEST_NUMBER: EXPECTED.pull_request, SESSION_KEY: EXPECTED.session_key,
    EXPECTED_MODEL: EXPECTED.model, EXPECTED_EFFORT: EXPECTED.effort,
    EXPECTED_CODEX_VERSION: EXPECTED.codex_version, REVIEW_INSTRUCTIONS: POLICY,
  };
  fs.rmSync(path.join(f.directory, "manifest.hmac"));
  const signed = spawnSync(process.execPath, [script, "sign"], { env, encoding: "utf8" });
  assert.equal(signed.status, 0, signed.stderr);
  assert.equal(fs.readFileSync(output, "utf8"), `artifact_name=${f.artifactName}\n`);
  fs.writeFileSync(output, "");
  const restored = spawnSync(process.execPath, [script, "restore"], { env, encoding: "utf8" });
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(fs.readFileSync(output, "utf8"), `resumed=true\nsession_id=${SESSION_ID}\nprevious_artifact_id=${f.artifactId}\n`);
  assertRestored(f, { resumed: true, session_id: SESSION_ID, previous_artifact_id: String(f.artifactId) });

  fs.writeFileSync(output, "");
  const incompatible = spawnSync(process.execPath, [script, "restore"], {
    env: { ...env, REVIEW_INSTRUCTIONS: "A changed trusted policy" }, encoding: "utf8",
  });
  assert.equal(incompatible.status, 0, incompatible.stderr);
  assert.equal(fs.readFileSync(output, "utf8"), "resumed=false\nsession_id=\nprevious_artifact_id=\n");
  assert.equal(fs.existsSync(f.codexHome), false);
  assert.equal(fs.existsSync(f.stateDir), false);
});

test("workflow downloads before restore/prepare and gates snapshot upload on authentication", () => {
  const workflow = fs.readFileSync(new URL("../../workflows/codex-openai-review.yml", import.meta.url), "utf8");
  const steps = workflow.split(/(?=^      - )/m);
  const step = id => {
    const found = steps.find(block => new RegExp(`^        id: ${id}$`, "m").test(block));
    assert.ok(found, `workflow step ${id} must exist`);
    return found;
  };
  const find = step("find_session"), download = step("download_session"), restore = step("restore_session");
  const prepare = step("prepare_diff"), snapshot = step("prepare_session");
  const authenticate = step("authenticate_session"), upload = step("upload_session");
  const ordered = [find, download, restore, prepare, snapshot, authenticate, upload].map(block => workflow.indexOf(block));
  assert.deepEqual(ordered, [...ordered].sort((a, b) => a - b));
  assert.match(find, /findSessionArtifact/);
  assert.match(find, /key:\s*process\.env\.OPENAI_API_KEY/);
  assert.match(download, /uses: actions\/download-artifact@/);
  assert.match(download, /if:.*steps\.find_session\.outputs\.found == 'true'/);
  assert.match(download, /artifact-ids:.*steps\.find_session\.outputs\.artifact_id/);
  assert.match(download, /run-id:.*steps\.find_session\.outputs\.run_id/);
  assert.match(restore, /EXPECTED_ARTIFACT_ID:.*steps\.download_session\.outcome == 'success'/);
  assert.match(restore, /EXPECTED_RUN_ID:.*steps\.find_session\.outputs\.run_id/);
  assert.match(restore, /session-artifacts\.mjs["']? restore/);
  assert.match(authenticate, /if:.*steps\.prepare_session\.outputs\.ready == 'true'/);
  assert.match(authenticate, /OPENAI_API_KEY:.*secrets\.OPENAI_API_KEY/);
  assert.match(authenticate, /session-artifacts\.mjs["']? sign/);
  assert.match(upload, /if:.*steps\.authenticate_session\.outcome == 'success'/);
  assert.match(upload, /name:.*steps\.authenticate_session\.outputs\.artifact_name/);
  assert.match(upload, /\/manifest\.hmac/);
});
