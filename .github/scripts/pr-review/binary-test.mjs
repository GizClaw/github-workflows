import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { binaryWriter, verifyBinaryEvidence } from "./binary.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "binary-review-"));
const repo = path.join(root, "repo");
fs.mkdirSync(repo);
const git = (...args) => {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
try {
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  // A newline and pathspec metacharacters must not select other files.
  const file = "image[*]\n.png";
  const before = Buffer.from([0, 1, 2, 3]);
  const after = Buffer.from([0, 4, 5, 6, 7]);
  fs.writeFileSync(path.join(repo, file), before);
  git("add", "."); git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  fs.writeFileSync(path.join(repo, file), after);
  fs.writeFileSync(path.join(repo, "added.bin"), before);
  fs.symlinkSync("added.bin", path.join(repo, "link"));
  git("add", "."); git("commit", "-qm", "head");
  const head = git("rev-parse", "HEAD");
  const output = path.join(root, "evidence");
  const save = binaryWriter(repo, output);
  const binary = { before: save(base, file), after: save(head, file) };
  assert.equal(binary.before.oid, git("rev-parse", `${base}:${file}`));
  assert.deepEqual(fs.readFileSync(path.join(output, binary.before.relative_path)), before);
  assert.deepEqual(fs.readFileSync(path.join(output, binary.after.relative_path)), after);
  assert.match(binary.after.relative_path, /^binary\/[a-f0-9]{40}\.png$/);
  assert.equal(save(base, "added.bin"), null);
  assert.equal(save(head, "added.bin").relative_path, binary.before.relative_path);
  assert.throws(() => save(head, "link"), /regular tracked file/);
  assert.throws(() => binaryWriter(repo, path.join(root, "small"), { maxBlobBytes: 3 })(head, file), /exceeds/);
  const total = binaryWriter(repo, path.join(root, "total"), { maxTotalBytes: 8 });
  total(base, file);
  assert.throws(() => total(head, file), /exceeds/);
  const listing = { files: [{ binary }] };
  verifyBinaryEvidence(output, listing);
  // Evidence remains useful after the untrusted Git object store is removed.
  fs.rmSync(repo, { recursive: true });
  verifyBinaryEvidence(output, listing);
  fs.writeFileSync(path.join(output, binary.after.relative_path), Buffer.from([0, 8, 8, 8, 8]));
  assert.throws(() => verifyBinaryEvidence(output, listing), /checksum mismatch/);
  binary.after.relative_path = "../outside";
  assert.throws(() => verifyBinaryEvidence(output, listing), /Invalid binary review evidence path/);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log("Binary review evidence tests passed");
