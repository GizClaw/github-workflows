import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { includePatterns, pointer, prepareLfs } from "./lfs.mjs";

const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const encoded = (value, size = Buffer.byteLength(value)) =>
  `version https://git-lfs.github.com/spec/v1\noid sha256:${sha(value)}\nsize ${size}\n`;
function git(repo, ...args) {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function fixture({ oversized = false, symlink = false } = {}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "lfs-review-"));
  const workspace = path.join(temporary, "workspace"), repo = path.join(temporary, "diff.git");
  fs.mkdirSync(workspace);
  git(workspace, "init", "-q");
  git(workspace, "config", "user.name", "Fixture");
  git(workspace, "config", "user.email", "fixture@example.test");
  const relative = "terraform/dev/terraform.tfstate", file = path.join(workspace, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const before = '{"serial":1,"resources":[]}\n';
  const after = '{"serial":2,"resources":[{"type":"fixture"}]}\n';
  fs.writeFileSync(file, encoded(before));
  fs.writeFileSync(path.join(workspace, ".lfsconfig"), '[lfs]\nurl = https://invalid.example.test/untrusted\n');
  git(workspace, "add", "."); git(workspace, "commit", "-qm", "base");
  const base = git(workspace, "rev-parse", "HEAD");
  fs.rmSync(file);
  if (symlink) fs.symlinkSync(encoded(after), file);
  else fs.writeFileSync(file, encoded(after, oversized ? 64 * 1024 * 1024 + 1 : undefined));
  fs.writeFileSync(path.join(workspace, "head-only.sh"), "exit 99\n");
  git(workspace, "add", "."); git(workspace, "commit", "-qm", "head");
  const head = git(workspace, "rev-parse", "HEAD");
  git(temporary, "clone", "-q", "--bare", workspace, repo);
  git(workspace, "checkout", "-q", "--detach", base);
  const directory = path.join(temporary, "lfs-inputs");
  const bytes = new Map([[sha(before), before], [sha(after), after]]);
  const fetcher = ({ objects }) => {
    for (const object of objects) {
      const destination = path.join(directory, "storage", "objects", object.oid.slice(0, 2), object.oid.slice(2, 4), object.oid);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, bytes.get(object.oid));
    }
  };
  return { temporary, repo, workspace, directory, base, head, before, after, file, relative,
    include: "terraform/**/terraform.tfstate", fetcher };
}

assert.throws(() => includePatterns("../outside"), /Invalid/);
assert.throws(() => includePatterns("/absolute/*"), /Invalid/);
assert.throws(() => includePatterns(":(exclude)*"), /Invalid/);
assert.throws(() => pointer("version https://git-lfs.github.com/spec/v1\noid sha256:invalid\nsize 2\n"), /Invalid/);

for (const scenario of ["complete", "hash-mismatch", "oversized", "total-bound", "symlink", "ancestor-symlink", "native-cached-fetch"]) {
  const f = fixture({ oversized: scenario === "oversized", symlink: scenario === "symlink" });
  try {
    if (scenario === "total-bound") {
      git(f.workspace, "checkout", "-q", "--detach", f.head);
      for (let index = 0; index < 9; index++) {
        fs.writeFileSync(path.join(f.workspace, "terraform", "dev", `${index}.tfstate`), encoded(`fixture-${index}`, 64 * 1024 * 1024));
      }
      git(f.workspace, "add", "."); git(f.workspace, "commit", "-qm", "oversized batch");
      f.head = git(f.workspace, "rev-parse", "HEAD");
      git(f.repo, "fetch", "-q", f.workspace, f.head);
      git(f.workspace, "checkout", "-q", "--detach", f.base);
      f.include = "terraform/**/*.tfstate";
    }
    let fetched = 0;
    const fetcher = (options) => {
      fetched++;
      f.fetcher(options);
      if (scenario === "hash-mismatch") {
        const object = options.objects[0];
        const destination = path.join(f.directory, "storage", "objects", object.oid.slice(0, 2), object.oid.slice(2, 4), object.oid);
        fs.writeFileSync(destination, "x".repeat(object.size));
      }
    };
    if (scenario === "ancestor-symlink") {
      fs.renameSync(path.join(f.workspace, "terraform"), path.join(f.temporary, "outside"));
      fs.symlinkSync(path.join(f.temporary, "outside"), path.join(f.workspace, "terraform"));
    }
    if (["oversized", "total-bound", "symlink", "hash-mismatch", "ancestor-symlink"].includes(scenario)) {
      assert.throws(() => prepareLfs({ ...f, fetcher }), /exceeds|regular|SHA256|Unsafe/, scenario);
      if (["oversized", "total-bound", "symlink"].includes(scenario)) assert.equal(fetched, 0);
      assert.equal(fs.readFileSync(f.file, "utf8"), encoded(f.before));
      continue;
    }
    let manifest;
    if (scenario === "native-cached-fetch") {
      f.fetcher({ objects: [{ oid: sha(f.before) }, { oid: sha(f.after) }] });
      const options = { ...f, token: "fixture-token", server: "https://github.com", repository: "GizClaw/deploy" };
      delete options.fetcher;
      manifest = prepareLfs(options);
    } else manifest = prepareLfs({ ...f, fetcher });
    const content = JSON.parse(fs.readFileSync(manifest));
    assert.equal(content.base_sha, f.base);
    assert.equal(content.head_sha, f.head);
    assert.equal(fs.readFileSync(f.file, "utf8"), f.before);
    assert.equal(fs.readFileSync(content.head[0].file, "utf8"), f.after);
    assert.equal(content.head[0].oid, sha(f.after));
    assert.equal(fs.existsSync(path.join(f.workspace, "head-only.sh")), false);
    assert.equal(git(f.workspace, "rev-parse", "HEAD"), f.base);
  } finally { fs.rmSync(f.temporary, { recursive: true, force: true }); }
}
console.log("Git LFS review input tests passed");
