import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");
const mac = (key, domain, value) => {
  if (!key) throw new Error("A snapshot authentication key is required");
  return crypto.createHmac("sha256", key).update(`${domain}\0`).update(value).digest("hex");
};
const equalMac = (left, right) => /^[a-f0-9]{64}$/.test(left || "")
  && crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));

function regularFile(file) {
  if (!fs.lstatSync(file).isFile()) throw new Error("Snapshot contains a non-regular file");
  return fs.readFileSync(file);
}

// Hash paths and bytes, rejecting links that cpSync would otherwise copy without
// their contents being authenticated. Use the same byte ordering as the writer.
export function snapshotTreeHash(root) {
  if (!fs.lstatSync(root).isDirectory()) throw new Error("Snapshot state is not a directory");
  const files = [];
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) files.push(absolute);
      else throw new Error("Snapshot contains a non-regular entry");
    }
  };
  walk(root);
  files.sort((a, b) => Buffer.compare(Buffer.from(path.relative(root, a)), Buffer.from(path.relative(root, b))));
  const hash = crypto.createHash("sha256");
  for (const file of files) {
    hash.update(path.relative(root, file).split(path.sep).join("/"));
    hash.update("\0");
    hash.update(regularFile(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function artifactBase(repositoryId, pullNumber, runId, attempt = 1) {
  return `openai-pr-review-session-v2-${repositoryId}-pr-${pullNumber}-run-${runId}-attempt-${attempt}`;
}

export function authenticatedArtifactName({ repositoryId, pullNumber, runId, attempt = 1, key }) {
  const base = artifactBase(repositoryId, pullNumber, runId, attempt);
  return `${base}-mac-${mac(key, "review-snapshot-name-v1", base)}`;
}

// Authenticate names before selecting the latest snapshot. An unrelated job
// without the forwarded secret cannot shadow a valid snapshot with a newer one.
// The contents are authenticated separately after download; run metadata alone
// does not prove which job produced an artifact.
export async function findSessionArtifact({ github, context, repositoryId, pullNumber, key }) {
  const artifacts = await github.paginate(github.rest.actions.listArtifactsForRepo, {
    ...context.repo, per_page: 100,
  });
  const prefix = `openai-pr-review-session-v2-${repositoryId}-pr-${pullNumber}-run-`;
  const candidates = artifacts.filter(artifact => {
    if (artifact.expired || !artifact.name?.startsWith(prefix)) return false;
    const suffix = artifact.name.slice(prefix.length).match(/^([1-9]\d*)-attempt-1-mac-([a-f0-9]{64})$/);
    if (!suffix || String(artifact.workflow_run?.id) !== suffix[1]
      || suffix[1] === String(context.runId)) return false;
    const base = artifactBase(repositoryId, pullNumber, suffix[1]);
    return equalMac(suffix[2], mac(key, "review-snapshot-name-v1", base));
  }).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id);
  return candidates[0] || null;
}

export function signSnapshot(directory, key) {
  const raw = regularFile(path.join(directory, "manifest.json"));
  const manifest = JSON.parse(raw);
  if (sha256(regularFile(path.join(directory, "session.jsonl"))) !== manifest.session_sha256
    || snapshotTreeHash(path.join(directory, "state")) !== manifest.state_sha256) {
    throw new Error("Snapshot changed before authentication");
  }
  fs.writeFileSync(path.join(directory, "manifest.hmac"),
    `${mac(key, "review-snapshot-manifest-v1", raw)}\n`, { mode: 0o600 });
  return authenticatedArtifactName({ repositoryId: manifest.repository_id,
    pullNumber: manifest.pull_request, runId: manifest.source_run_id,
    attempt: manifest.source_run_attempt, key });
}

export function restoreSnapshot({ directory, codexHome, stateDir, key, expected, artifactId }) {
  const reset = () => {
    fs.rmSync(codexHome, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  };
  reset();
  const cold = { resumed: false, session_id: "", previous_artifact_id: "" };
  if (!artifactId) return { ...cold, reason: "No authenticated snapshot for this PR; starting a full review." };
  try {
    const raw = regularFile(path.join(directory, "manifest.json"));
    const signature = regularFile(path.join(directory, "manifest.hmac")).toString("utf8").trim();
    if (!equalMac(signature, mac(key, "review-snapshot-manifest-v1", raw))) {
      throw new Error("Snapshot authentication failed");
    }
    const manifest = JSON.parse(raw);
    if (manifest.schema_version !== 2) throw new Error("Unsupported snapshot schema");
    for (const [name, value] of Object.entries(expected)) {
      if (String(manifest[name]) !== String(value)) throw new Error(`Snapshot ${name} does not match`);
    }
    if (!/^[a-f0-9-]{36}$/i.test(manifest.session_id || "")
      || !/^sessions\/\d{4}\/\d{2}\/\d{2}\/[^/\\]+\.jsonl$/.test(manifest.session_relative_path || "")) {
      throw new Error("Invalid snapshot session identity or path");
    }
    const session = regularFile(path.join(directory, "session.jsonl"));
    if (sha256(session) !== manifest.session_sha256) throw new Error("Snapshot session checksum failed");
    const metadata = session.toString("utf8").split("\n").slice(0, 12).filter(Boolean)
      .map(line => JSON.parse(line)).find(item => item.type === "session_meta")?.payload;
    if (metadata?.id !== manifest.session_id || metadata.parent_thread_id
      || metadata.thread_source === "subagent") throw new Error("Snapshot is not the primary session");
    const sourceState = path.join(directory, "state");
    if (snapshotTreeHash(sourceState) !== manifest.state_sha256) throw new Error("Snapshot state checksum failed");
    const ledger = JSON.parse(regularFile(path.join(sourceState, "review-ledger.json")));
    if (ledger.session_key !== expected.session_key || !Array.isArray(ledger.generations)) {
      throw new Error("Snapshot ledger does not belong to this PR");
    }
    fs.cpSync(sourceState, stateDir, { recursive: true, force: true });
    const destination = path.join(codexHome, manifest.session_relative_path);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.writeFileSync(destination, session, { mode: 0o600 });
    return { resumed: true, session_id: manifest.session_id, previous_artifact_id: String(artifactId),
      reason: "Restored the previous PR session and review checkpoints." };
  } catch (error) {
    reset();
    // Do not print downloaded bytes or exception messages containing paths/data.
    return { ...cold, reason: "Previous snapshot is unavailable, incompatible, or failed authentication; starting a full review." };
  }
}

function main() {
  const required = name => {
    if (!process.env[name]) throw new Error(`Missing ${name}`);
    return process.env[name];
  };
  const output = (name, value) => fs.appendFileSync(required("GITHUB_OUTPUT"), `${name}=${value}\n`);
  const key = required("OPENAI_API_KEY");
  if (process.argv[2] === "sign") {
    output("artifact_name", signSnapshot(required("SESSION_SNAPSHOT_DIR"), key));
    return;
  }
  if (process.argv[2] !== "restore") throw new Error("Use sign or restore");
  const result = restoreSnapshot({
    directory: required("SESSION_DOWNLOAD_DIR"), codexHome: required("CODEX_HOME"),
    stateDir: required("PR_REVIEW_STATE_DIR"), key, artifactId: process.env.EXPECTED_ARTIFACT_ID || "",
    expected: {
      repository_id: required("REPOSITORY_ID"), repository: required("GITHUB_REPOSITORY"),
      pull_request: required("PULL_REQUEST_NUMBER"), session_key: required("SESSION_KEY"),
      model: required("EXPECTED_MODEL"), effort: required("EXPECTED_EFFORT"),
      codex_version: required("EXPECTED_CODEX_VERSION"), source_run_id: process.env.EXPECTED_RUN_ID || "",
      source_run_attempt: "1", review_instructions_sha256: sha256(required("REVIEW_INSTRUCTIONS")),
    },
  });
  for (const name of ["resumed", "session_id", "previous_artifact_id"]) output(name, result[name]);
  process.stdout.write(`${result.reason}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
