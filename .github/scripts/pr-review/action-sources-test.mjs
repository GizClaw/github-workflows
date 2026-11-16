import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { actionReference, actionRefsFromDiff, discoverActionRefs, collectActionSources, verifyActionSources, ACTION_SOURCE_LIMITS } from "./action-sources.mjs";

const hash = (kind, bytes) => crypto.createHash("sha1").update(`${kind} ${bytes.length}\0`).update(bytes).digest("hex");
const old = "a".repeat(40), current = "b".repeat(40), dependency = "c".repeat(40);
const reference = `owner/actions/sub@${current}`, previous = `owner/actions/sub@${old}`;
function source(files) {
  const blobs = new Map(), entries = [], groups = new Map([["", []]]);
  for (const [name, text] of Object.entries(files)) {
    const bytes = Buffer.from(text), sha = hash("blob", bytes);
    blobs.set(sha, { sha, size: bytes.length, encoding: "base64", content: bytes.toString("base64") });
    entries.push({ path: name, type: "blob", mode: "100644", sha, size: bytes.length });
    let parent = path.posix.dirname(name);
    while (parent !== ".") { if (!groups.has(parent)) groups.set(parent, []); parent = path.posix.dirname(parent); }
  }
  for (const dir of [...groups.keys()].sort((a, b) => b.length - a.length)) {
    const children = entries.filter(entry => (path.posix.dirname(entry.path) === "." ? "" : path.posix.dirname(entry.path)) === dir);
    children.sort((a, b) => Buffer.compare(Buffer.from(path.posix.basename(a.path) + (a.type === "tree" ? "/" : "")), Buffer.from(path.posix.basename(b.path) + (b.type === "tree" ? "/" : ""))));
    const bytes = Buffer.concat(children.map(entry => Buffer.concat([Buffer.from(`${entry.type === "tree" ? "40000" : entry.mode} ${path.posix.basename(entry.path)}\0`), Buffer.from(entry.sha, "hex")])));
    const sha = hash("tree", bytes);
    if (dir) entries.push({ path: dir, mode: "040000", type: "tree", sha });
    else return { tree: { sha, tree: entries, truncated: false }, blobs };
  }
}
function fixture(patch = {}) {
  const local = source({ "sub/action.yml": `runs:\n  using: composite\n  steps:\n    - uses: owner/script@${dependency}\n`, "lib/verify.mjs": "export const value = 42;\n", "lib/context.mjs": "// Local dependency is included, never executed.\n" });
  const remote = source({ "action.yml": "runs:\n  using: node24\n  main: dist/index.js\n", "dist/index.js": "throw new Error('dependency must not execute');\n" });
  const sources = new Map([[`actions:${old}`, local], [`actions:${current}`, local], [`script:${dependency}`, remote]]);
  const calls = [];
  const github = { rest: {
    repos: { get: async args => { calls.push(["repo", args]); return { data: { id: args.repo === "actions" ? 1 : 2, private: false, full_name: `${args.owner}/${args.repo}`, ...patch.repository } }; } },
    git: {
      getCommit: async args => { calls.push(["commit", args]); const s = sources.get(`${args.repo}:${args.commit_sha}`); assert.ok(s); return { data: { sha: args.commit_sha, tree: { sha: s.tree.sha }, ...patch.commit } }; },
      getTree: async args => { calls.push(["tree", args]); const s = [...sources.values()].find(s => s.tree.sha === args.tree_sha); return { data: { ...structuredClone(s.tree), ...patch.tree } }; },
      getBlob: async args => { calls.push(["blob", args]); const blob = [...sources.values()].map(s => s.blobs.get(args.file_sha)).find(Boolean); return { data: { ...blob, ...patch.blob } }; },
    },
  } };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "action-sources-"));
  const options = { github, directory: path.join(root, "evidence"), base: old, head: current, refs: [previous, reference] };
  return { root, options, sources, local, remote, calls, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

for (const size of [0, 1, 2, 3, 4 * 1024 * 1024, 8 * 1024 * 1024]) {
  test(`collector accepts valid base64 blob ${size} bytes without regexp stack recursion`, async () => {
    const f = fixture();
    try {
      const data = source({ "sub/action.yml": "runs:\n  using: node24\n  main: payload.bin\n", "sub/payload.bin": Buffer.alloc(size, 0xfb) });
      // The size range covers no padding, one '=', two '=', and the unchanged
      // default blob ceiling. Payload is evidence only, never executed.
      f.sources.set(`actions:${current}`, data); f.options.refs = [reference];
      for (const blob of data.blobs.values()) blob.content = blob.content.match(/.{1,60}/g)?.join("\n") || "";
      const file = await collectActionSources(f.options);
      assert.match(verifyActionSources(file, { base: old, head: current, requiredRefs: [reference] }), /^[a-f0-9]{64}$/);
    } finally { f.cleanup(); }
  });
}
for (const corruption of ["interior-padding", "three-padding", "alphabet", "whitespace", "carriage-return", "unicode", "short", "long"]) {
  test(`base64 large blob rejects ${corruption} before hash/decoding can authorize evidence`, async () => {
    const f = fixture();
    try {
      const data = source({ "sub/action.yml": "runs:\n  using: node24\n  main: payload.bin\n", "sub/payload.bin": Buffer.alloc(4 * 1024 * 1024, 0xfb) });
      const blob = [...data.blobs.values()].find(value => value.size > 1024 * 1024);
      const at = Math.floor(blob.content.length / 2);
      const marker = { "interior-padding": "=", "alphabet": "!", "whitespace": " ", "carriage-return": "\r", "unicode": "é" }[corruption];
      if (marker) blob.content = blob.content.slice(0, at) + marker + blob.content.slice(at + 1);
      if (corruption === "three-padding") blob.content = blob.content.slice(0, -3) + "===";
      if (corruption === "short") blob.content = blob.content.slice(4);
      if (corruption === "long") blob.content += "AAAA";
      f.sources.set(`actions:${current}`, data); f.options.refs = [reference];
      await assert.rejects(collectActionSources(f.options), /Malformed action source base64/);
    } finally { f.cleanup(); }
  });
}
test("collector still refuses a blob one byte beyond its unchanged byte limit", async () => {
  const f = fixture();
  try {
    f.sources.set(`actions:${current}`, source({ "sub/action.yml": "runs:\n  using: node24\n  main: payload.bin\n", "sub/payload.bin": Buffer.alloc(ACTION_SOURCE_LIMITS.blobBytes + 1) }));
    f.options.refs = [reference];
    await assert.rejects(collectActionSources(f.options), /file\/size bound exceeded/);
  } finally { f.cleanup(); }
});

const patch = `diff --git a/.github/workflows/gates.yml b/.github/workflows/gates.yml\n--- a/.github/workflows/gates.yml\n+++ b/.github/workflows/gates.yml\n-  uses: ${previous}\n+  uses: '${reference}' # immutable\n+  uses: ${reference}\ndiff --git a/README.md b/README.md\n+  uses: owner/docs@${dependency}\n`;
test("discover exact before/after fixed refs, ignoring other files and duplicate uses", () => {
  assert.deepEqual(actionRefsFromDiff(patch), [previous, reference]);
  assert.deepEqual(actionReference(reference), { repository: "owner/actions", action_path: "sub", commit: current });
  for (const ref of ["owner/repo@latest", `owner/repo/../x@${old}`, `owner/repo\\x@${old}`, `https://x/y@${old}`, "docker://busybox"]) assert.throws(() => actionReference(ref));
});
test("real Git discovery and actual trusted workflow collector supply bound source data", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "action-diff-"));
  try {
    const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" } }).trim();
    git("init", "-q"); fs.mkdirSync(path.join(dir, ".github/workflows"), { recursive: true });
    const file = path.join(dir, ".github/workflows/gates.yml"); fs.writeFileSync(file, `steps:\n  - uses: ${previous}\n`); git("add", "."); git("commit", "-qm", "base"); const base = git("rev-parse", "HEAD");
    fs.writeFileSync(file, `steps:\n  - uses: ${reference}\n`); git("add", "."); git("commit", "-qm", "pin"); const head = git("rev-parse", "HEAD");
    assert.deepEqual(discoverActionRefs({ repo: dir, base, head }), { base, head, refs: [previous, reference] });
    const f = fixture();
    const keys = ["REVIEWER_SOURCE_DIR", "PR_DIFF_REPOSITORY", "PR_BASE_SHA", "PR_BASE_TIP_SHA", "PR_HEAD_SHA", "REVIEW_FROM_SHA", "RUNNER_TEMP"];
    const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    try {
      Object.assign(process.env, { REVIEWER_SOURCE_DIR: fileURLToPath(new URL("../../../", import.meta.url)), PR_DIFF_REPOSITORY: dir, PR_BASE_SHA: base, PR_BASE_TIP_SHA: base, PR_HEAD_SHA: head, REVIEW_FROM_SHA: base, RUNNER_TEMP: f.root });
      const workflow = fs.readFileSync(new URL("../../workflows/codex-openai-review.yml", import.meta.url), "utf8");
      const section = workflow.split("      - name: Collect exact pinned action source as read-only evidence\n")[1].split("      - name:")[0];
      const script = section.split("          script: |\n")[1].split("\n").filter(line => line.startsWith("            ")).map(line => line.slice(12)).join("\n");
      const outputs = {};
      await new (Object.getPrototypeOf(async function () {}).constructor)("require", "github", "core", script)(createRequire(import.meta.url), f.options.github, { setOutput: (key, value) => { outputs[key] = value; } });
      assert.match(verifyActionSources(outputs.manifest, { base, head, requiredRefs: [reference] }), /^[a-f0-9]{64}$/);
      assert.ok(workflow.indexOf("Collect exact pinned action source") < workflow.indexOf("Remove fetched pull-request Git objects"));
      assert.match(workflow, /ACTION_SOURCE_MANIFEST: \$\{\{ steps\.action_sources\.outputs\.manifest \}\}/);
    } finally { for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } f.cleanup(); }
    const finalRef = `owner/actions/sub@${"d".repeat(40)}`;
    fs.writeFileSync(file, `steps:\n  - uses: ${finalRef}\n`); git("add", "."); git("commit", "-qm", "next pin"); const finalHead = git("rev-parse", "HEAD");
    assert.deepEqual(discoverActionRefs({ repo: dir, base, head: finalHead }).refs, [previous, finalRef].sort());
    assert.deepEqual(discoverActionRefs({ repo: dir, base, head: finalHead, from: head }).refs, [previous, reference, finalRef].sort(), "incremental source also includes the intermediate pin removed from this chunk");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test("collect full committed trees and fixed external dependencies without executing any source", async () => {
  const f = fixture();
  try {
    const file = await collectActionSources(f.options);
    const data = JSON.parse(fs.readFileSync(file));
    assert.equal(data.snapshots.length, 3); assert.equal(data.actions.length, 3);
    assert.ok(data.snapshots.find(s => s.commit === current).files.some(file => file.path === "lib/context.mjs"));
    assert.equal(f.calls.filter(([kind]) => kind === "blob").length, 5, "identical old/new blobs cached by verified Git object ID");
    assert.match(verifyActionSources(file, { base: old, head: current, requiredRefs: [reference] }), /^[a-f0-9]{64}$/);
    assert.equal(fs.statSync(file).mode & 0o777, 0o400);
  } finally { f.cleanup(); }
});
for (const [name, patch] of Object.entries({
  private: { repository: { private: true } }, repository: { repository: { full_name: "forged/name" } }, commit: { commit: { sha: dependency } },
  tree: { tree: { sha: dependency } }, truncated: { tree: { truncated: true } }, blob: { blob: { content: "Zm9yZ2Vk" } }, encoding: { blob: { encoding: "utf8" } }, size: { blob: { size: 999 } }, base64: { blob: { content: "!!!" } },
})) test(`reject ${name} before source can authorize offline evidence`, async () => {
  const f = fixture(patch); try { await assert.rejects(collectActionSources(f.options)); } finally { f.cleanup(); }
});
for (const corruption of ["duplicate", "missing-parent", "tree-hash", "symlink", "submodule", "traversal"]) test(`reject ${corruption} in API tree`, async () => {
  const f = fixture();
  try {
    const tree = f.local.tree.tree;
    if (corruption === "duplicate") tree.push(structuredClone(tree[0]));
    if (corruption === "missing-parent") f.local.tree.tree = tree.filter(e => e.path !== "lib");
    if (corruption === "tree-hash") tree[0].sha = dependency;
    if (corruption === "symlink") tree[0].mode = "120000";
    if (corruption === "submodule") Object.assign(tree[0], { type: "commit", mode: "160000" });
    if (corruption === "traversal") tree[0].path = "../escape";
    await assert.rejects(collectActionSources(f.options));
  } finally { f.cleanup(); }
});
for (const key of ["repositories", "snapshots", "files", "blobBytes", "totalBytes", "depth", "actions", "edges", "dependencyEntries", "graphBytes"]) test(`reject ${key} acquisition over bound`, async () => {
  const f = fixture(); try { await assert.rejects(collectActionSources({ ...f.options, limits: { ...ACTION_SOURCE_LIMITS, [key]: 0 } })); } finally { f.cleanup(); }
});
for (const dependency of ["owner/script@latest", "./local", "docker://image", "${{ inputs.action }}", `owner/actions/sub@${current}`]) test(`refuse unsupported/cyclic dependency ${dependency}`, async () => {
  const f = fixture();
  try {
    const updated = source({ "sub/action.yml": `runs:\n  steps:\n    - uses: ${dependency}\n` });
    f.sources.set(`actions:${current}`, updated); f.options.refs = [reference];
    await assert.rejects(collectActionSources(f.options));
  } finally { f.cleanup(); }
});
test("API errors and unsupported inline YAML cannot yield complete evidence", async () => {
  for (const inline of [false, true]) {
    const f = fixture();
    try {
      if (inline) f.sources.set(`actions:${current}`, source({ "sub/action.yml": `runs: {steps: [{uses: owner/script@${dependency}}]}\n` }));
      else f.options.github.rest.git.getBlob = async () => { throw new Error("API denied"); };
      f.options.refs = [reference]; await assert.rejects(collectActionSources(f.options));
    } finally { f.cleanup(); }
  }
});
for (const corruption of ["blob", "symlink", "head", "tree", "missing-file", "dependency", "action-ref", "duplicate-snapshot", "manifest-link"]) test(`offline verification rejects ${corruption}`, async () => {
  const f = fixture();
  try {
    const file = await collectActionSources(f.options), manifest = JSON.parse(fs.readFileSync(file));
    const object = manifest.snapshots[0].files[0], target = path.join(path.dirname(file), object.relative_path);
    if (corruption === "blob") { fs.chmodSync(target, 0o600); fs.writeFileSync(target, "forged"); }
    if (corruption === "symlink") { fs.unlinkSync(target); fs.symlinkSync(file, target); }
    if (corruption === "head") manifest.head = old;
    if (corruption === "tree") manifest.snapshots[0].tree = dependency;
    if (corruption === "missing-file") manifest.snapshots[0].files.pop();
    if (corruption === "dependency") manifest.actions.pop();
    if (corruption === "action-ref") manifest.actions[0].commit = dependency;
    if (corruption === "duplicate-snapshot") manifest.snapshots.push(structuredClone(manifest.snapshots[0]));
    if (corruption === "manifest-link") { fs.renameSync(file, file + ".real"); fs.symlinkSync(file + ".real", file); }
    else { fs.chmodSync(file, 0o600); fs.writeFileSync(file, JSON.stringify(manifest)); }
    assert.throws(() => verifyActionSources(file, { base: old, head: current, requiredRefs: [reference] }));
  } finally { f.cleanup(); }
});
test("absence stays incomplete for changed pins; no-pin collection makes no API request", async () => {
  assert.throws(() => verifyActionSources("", { base: old, head: current, requiredRefs: [reference] }), /required/);
  const f = fixture();
  try { const file = await collectActionSources({ ...f.options, refs: [] }); assert.equal(f.calls.length, 0); assert.equal(verifyActionSources(file, { base: old, head: current }), ""); } finally { f.cleanup(); }
});

// Independently construct valid Git objects for graph fixtures, including ones
// that the collector must refuse. Never import or execute their source bytes.
function graphFixture(graph, roots, padding = {}) {
  const f = fixture(), ref = name => `owner/actions/${name}@${current}`;
  const files = {};
  for (const [name, children] of Object.entries(graph)) {
    files[`${name}/action.yml`] = (padding[name] || "") + (children.length
      ? "runs:\n  using: composite\n  steps:\n" + children.map(child => `    - uses: ${ref(child)}\n`).join("")
      : "runs:\n  using: node24\n  main: main.js\n");
    if (!children.length) files[`${name}/main.js`] = "throw new Error('graph evidence must not execute');\n";
  }
  const data = source(files); f.sources.set(`actions:${current}`, data); f.options.refs = roots.map(ref);
  const bundle = () => {
    fs.mkdirSync(path.join(f.options.directory, "objects"), { recursive: true });
    const entries = data.tree.tree.filter(entry => entry.type === "blob").map(entry => {
      const bytes = Buffer.from(data.blobs.get(entry.sha).content, "base64");
      const sha256 = crypto.createHash("sha256").update(bytes).digest("hex"), relative_path = `objects/${sha256}.txt`;
      const target = path.join(f.options.directory, relative_path);
      if (!fs.existsSync(target)) fs.writeFileSync(target, bytes, { mode: 0o400 });
      return { path: entry.path, mode: entry.mode, blob: entry.sha, size: bytes.length, sha256, relative_path };
    });
    const manifest = { schema: 1, base: old, head: current, refs: roots.map(ref), actions: Object.entries(graph).map(([name, children]) => ({ ref: ref(name), repository: "owner/actions", action_path: name, commit: current, manifest: `${name}/action.yml`, dependencies: children.map(ref) })), snapshots: [{ repository: { id: 1, full_name: "owner/actions" }, commit: current, tree: data.tree.sha, tree_entries: data.tree.tree, files: entries }] };
    const file = path.join(f.options.directory, "manifest.json"); fs.writeFileSync(file, JSON.stringify(manifest)); return file;
  };
  return { ...f, ref, bundle };
}
function verifyWithReadCounts(file, leaf) {
  const manifest = JSON.parse(fs.readFileSync(file));
  const object = manifest.snapshots[0].files.find(item => item.path === leaf);
  const target = path.join(path.dirname(file), object.relative_path), read = fs.readFileSync;
  let leafReads = 0, allReads = 0;
  fs.readFileSync = function (file, ...args) { allReads++; if (file === target) leafReads++; return read.call(this, file, ...args); };
  try { return { digest: verifyActionSources(file, { base: old, head: current }), leafReads, allReads }; }
  finally { fs.readFileSync = read; }
}
test("shared DAG validation reads each blob once rather than expanding duplicate paths", async () => {
  // Bounded old/new regression only. Never run the large graph on old verifier.
  for (const width of [24, 48]) {
    const f = graphFixture({ a: Array(width).fill("b"), b: Array(width).fill("c"), c: Array(width).fill("d"), d: [] }, ["a"]);
    try {
      const file = await collectActionSources(f.options);
      const result = verifyWithReadCounts(file, "d/action.yml");
      assert.equal(result.leafReads, 1, `width ${width}: unique source is hash-checked once`);
      assert.equal(result.allReads, 6, "one manifest plus five unique source blobs regardless of path multiplicity");
      assert.match(result.digest, /^[a-f0-9]{64}$/);
    } finally { f.cleanup(); }
  }
});
test("diamond sharing, repeated edges and repeated roots cannot bypass validation", async () => {
  const f = graphFixture({ a: ["b", "c", "b", "c"], b: ["d", "d"], c: ["d", "d"], d: ["e"], e: [] }, ["a"]);
  try {
    const file = await collectActionSources(f.options), result = verifyWithReadCounts(file, "e/action.yml");
    assert.equal(result.leafReads, 1); assert.ok(result.allReads <= 7);
    const manifest = JSON.parse(fs.readFileSync(file)); manifest.refs.push(manifest.refs[0]);
    fs.chmodSync(file, 0o600); fs.writeFileSync(file, JSON.stringify(manifest));
    assert.throws(() => verifyActionSources(file, { base: old, head: current }), /duplicate action source roots/);
  } finally { f.cleanup(); }
});
test("a shared subtree first visited shallow still rejects a later longest path over depth", async () => {
  const graph = { a: ["s"], s: ["t"], t: [], z: ["x"], x: ["y"], y: ["s"] };
  for (const roots of [["a", "z"], ["z", "a"]]) {
    const f = graphFixture(graph, roots);
    try { const file = f.bundle(); assert.throws(() => verifyActionSources(file, { base: old, head: current }), /depth\/cycle/); }
    finally { f.cleanup(); }
  }
  const f = graphFixture(graph, ["a", "z"]);
  try { await assert.rejects(collectActionSources(f.options), /depth\/cycle/); } finally { f.cleanup(); }
});
for (const [name, graph] of Object.entries({ self: { a: ["a"] }, shared: { a: ["b", "c"], b: ["d"], c: ["d"], d: ["b"] } })) test(`cached graph still rejects ${name} cycle`, async () => {
  const f = graphFixture(graph, ["a"]);
  try { assert.throws(() => verifyActionSources(f.bundle(), { base: old, head: current }), /depth\/cycle/); } finally { f.cleanup(); }
});
for (const corruption of ["bytes", "metadata", "missing-node", "duplicate-node", "missing-source"]) test(`shared graph rejects ${corruption} rather than skipping it via cache`, () => {
  const f = graphFixture({ a: ["b", "c"], b: ["d"], c: ["d"], d: [] }, ["a"]);
  try {
    const file = f.bundle(), manifest = JSON.parse(fs.readFileSync(file));
    const leaf = manifest.snapshots[0].files.find(item => item.path === "d/action.yml"), target = path.join(path.dirname(file), leaf.relative_path);
    if (corruption === "bytes") { fs.chmodSync(target, 0o600); fs.writeFileSync(target, Buffer.alloc(leaf.size, 0x78)); }
    if (corruption === "metadata") manifest.actions.find(action => action.action_path === "d").dependencies = [f.ref("a")];
    if (corruption === "missing-node") manifest.actions = manifest.actions.filter(action => action.action_path !== "d");
    if (corruption === "duplicate-node") manifest.actions.push({ ...manifest.actions[0] });
    if (corruption === "missing-source") fs.unlinkSync(target);
    fs.writeFileSync(file, JSON.stringify(manifest));
    assert.throws(() => verifyActionSources(file, { base: old, head: current }));
  } finally { f.cleanup(); }
});
test("large repeated-edge graph is rejected by new work budget without expanded traversal", async () => {
  // This ~1 MiB fixture is exercised ONLY on the new implementation. The old
  // verifier would expand 125 billion paths; do not use this case for old-fail.
  const width = 5000, graph = { a: Array(width).fill("b"), b: Array(width).fill("c"), c: Array(width).fill("d"), d: [] };
  const f = graphFixture(graph, ["a"]);
  try { assert.throws(() => verifyActionSources(f.bundle(), { base: old, head: current }), /entry budget/); } finally { f.cleanup(); }
  const g = graphFixture(graph, ["a"]);
  try { await assert.rejects(collectActionSources(g.options), /entry budget/); } finally { g.cleanup(); }
});
test("dense shared graph respects the unique-edge budget separately from entry and node bounds", async () => {
  const levels = Array.from({ length: 4 }, (_, layer) => Array.from({ length: 8 }, (_, i) => `n${layer}${i}`));
  const graph = Object.fromEntries(levels.flatMap((names, layer) => names.map(name => [name, levels.slice(layer + 1).flat()])));
  const f = graphFixture(graph, levels[0]);
  try { assert.throws(() => verifyActionSources(f.bundle(), { base: old, head: current }), /edge budget/); } finally { f.cleanup(); }
  const g = graphFixture(graph, levels[0]);
  try { await assert.rejects(collectActionSources(g.options), /edge budget/); } finally { g.cleanup(); }
});
test("dependency text byte budget is enforced before parsing an oversized action manifest", async () => {
  const graph = { a: [] }, padding = { a: "#" + "x".repeat(ACTION_SOURCE_LIMITS.graphBytes) + "\n" };
  const f = graphFixture(graph, ["a"], padding);
  try { assert.throws(() => verifyActionSources(f.bundle(), { base: old, head: current }), /byte budget/); } finally { f.cleanup(); }
  const g = graphFixture(graph, ["a"], { a: "#" + "x".repeat(128) + "\n" });
  try { await assert.rejects(collectActionSources({ ...g.options, limits: { ...ACTION_SOURCE_LIMITS, graphBytes: 128 } }), /byte budget/); } finally { g.cleanup(); }
});
