import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { appendOutput, writeJson } from "./common.mjs";

const MAX_OBJECT_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_OBJECTS = 1024;

function command(repo, args, { statuses = [0], env = process.env, encoding = "utf8", input } = {}) {
  const result = spawnSync("git", ["--git-dir", repo, ...args], {
    encoding, input, maxBuffer: encoding === null ? MAX_OBJECT_BYTES + 4096 : 16 * 1024 * 1024, timeout: 300000,
    env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0", GIT_TRACE: "0", GIT_CURL_VERBOSE: "0", GIT_LFS_SKIP_SMUDGE: "0" },
  });
  if (!statuses.includes(result.status)) throw new Error("Git LFS input acquisition failed");
  return result.stdout;
}

export function includePatterns(value) {
  const patterns = String(value).split(",").map((item) => item.trim()).filter(Boolean);
  if (!patterns.length || patterns.length > 32 || patterns.some((item) => (
    !/^[A-Za-z0-9_.*?/-]+$/.test(item) || item.startsWith("/")
    || item.split("/").includes("..") || item.length > 256
  ))) throw new Error("Invalid trusted LFS context paths");
  return patterns;
}

export function pointer(value) {
  const match = value.match(/^version https:\/\/git-lfs.github.com\/spec\/v1\noid sha256:([0-9a-f]{64})\nsize ([0-9]+)\n?$/);
  if (!match || !Number.isSafeInteger(Number(match[2]))) throw new Error("Invalid Git LFS pointer");
  return { oid: match[1], size: Number(match[2]) };
}

function safeRelative(value) {
  return value && !path.posix.isAbsolute(value) && path.posix.normalize(value) === value
    && !value.split("/").includes("..") && !/[\x00-\x1f\x7f]/.test(value);
}

function collect(repo, revision, patterns) {
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("Invalid LFS context revision");
  const matchers = patterns.map((pattern) => {
    let expression = "^";
    for (let index = 0; index < pattern.length; index++) {
      if (pattern.slice(index, index + 3) === "**/") { expression += "(?:[^/]+/)*"; index += 2; }
      else if (pattern.slice(index, index + 2) === "**") { expression += ".*"; index++; }
      else if (pattern[index] === "*") expression += "[^/]*";
      else if (pattern[index] === "?") expression += "[^/]";
      else expression += pattern[index].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    return new RegExp(expression + "$");
  });
  const rows = [];
  for (const entry of command(repo, ["ls-tree", "-r", "-l", "-z", revision]).split("\0").filter(Boolean)) {
    const split = entry.indexOf("\t"), file = entry.slice(split + 1);
    if (!matchers.some((pattern) => pattern.test(file))) continue;
    if (!safeRelative(file)) throw new Error("Unsafe Git LFS context path");
    const blob = entry.slice(0, split).match(/^100(?:644|755) blob ([0-9a-f]{40}) +([0-9]+)$/);
    if (!blob) throw new Error("Git LFS context must be a regular tracked file");
    if (Number(blob[2]) > 1024) continue;
    const text = command(repo, ["cat-file", "blob", blob[1]]);
    if (!text.startsWith("version https://git-lfs.github.com/spec/v1")) continue;
    rows.push({ path: file, revision, ...pointer(text) });
  }
  return rows;
}

function verified(file, object) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== object.size) {
    throw new Error("Git LFS object size or file type mismatch");
  }
  const digest = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  if (digest !== object.oid) throw new Error("Git LFS object SHA256 mismatch");
}

function hydrateBase(workspace, row, source) {
  const target = path.join(workspace, row.path);
  let parent = path.dirname(target);
  while (parent !== workspace) {
    if (!parent.startsWith(workspace + path.sep) || !fs.lstatSync(parent).isDirectory()
      || fs.lstatSync(parent).isSymbolicLink()) throw new Error("Unsafe trusted-base LFS destination");
    parent = path.dirname(parent);
  }
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe trusted-base LFS file");
  if (stat.size === row.size) {
    try { verified(target, row); return; } catch { /* Require the exact pointer below. */ }
  }
  const current = pointer(fs.readFileSync(target, "utf8"));
  if (current.oid !== row.oid || current.size !== row.size) throw new Error("Trusted-base LFS pointer changed");
  fs.copyFileSync(source, target);
  fs.chmodSync(target, 0o600);
}

function fetchObjects({ repo, directory, objects, token, server, repository }) {
  if (!token || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("Missing trusted LFS repository identity or credential");
  }
  const url = new URL(server);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/"
    || url.search || url.hash) throw new Error("Invalid trusted GitHub server URL");
  const origin = `${url.origin}/${repository}.git`;
  const auth = Buffer.from(`x-access-token:${token}`).toString("base64");
  const configuration = ["-c", `lfs.url=${origin}/info/lfs`, "-c", `remote.origin.lfsurl=${origin}/info/lfs`,
    "-c", `remote.origin.url=${origin}`, "-c", `lfs.storage=${path.join(directory, "storage")}`,
    "-c", "lfs.basictransfersonly=true", "-c", "lfs.skipdownloaderrors=false",
    "-c", "lfs.fetchinclude=", "-c", "lfs.fetchexclude=",
    "-c", "credential.helper=", "-c", "core.hooksPath=/dev/null",
    "-c", `http.extraheader=AUTHORIZATION: basic ${auth}`];
  // Feed only already-admitted pointers to the official LFS client. Never let
  // fetch path matching download extra, uncounted objects from a PR tree.
  for (const object of objects) {
    const input = `version https://git-lfs.github.com/spec/v1\noid sha256:${object.oid}\nsize ${object.size}\n`;
    const data = command(repo, [...configuration, "lfs", "smudge", "--", object.path], { encoding: null, input });
    if (data.length !== object.size || crypto.createHash("sha256").update(data).digest("hex") !== object.oid) {
      throw new Error("Git LFS downloaded content does not match its pointer");
    }
  }
}

export function prepareLfs(options) {
  const { repo, workspace, directory, base, head } = options;
  const patterns = includePatterns(options.include);
  const baseRows = collect(repo, base, patterns), headRows = collect(repo, head, patterns);
  const objects = new Map();
  for (const row of [...baseRows, ...headRows]) {
    if (row.size < 1 || row.size > MAX_OBJECT_BYTES) throw new Error("Git LFS context object exceeds 64 MiB");
    if (objects.has(row.oid) && objects.get(row.oid).size !== row.size) throw new Error("Conflicting Git LFS object sizes");
    objects.set(row.oid, row);
  }
  if (objects.size > MAX_OBJECTS || [...objects.values()].reduce((sum, row) => sum + row.size, 0) > MAX_TOTAL_BYTES) {
    throw new Error("Git LFS context exceeds its object count or 512 MiB total bound");
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const fetcher = options.fetcher || fetchObjects;
  if (objects.size) fetcher({ ...options, patterns, objects: [...objects.values()] });
  const files = new Map();
  for (const object of objects.values()) {
    const file = path.join(directory, "storage", "objects", object.oid.slice(0, 2), object.oid.slice(2, 4), object.oid);
    verified(file, object);
    files.set(object.oid, file);
  }
  // Verify the complete batch before replacing any trusted-base pointer.
  for (const row of baseRows) hydrateBase(path.resolve(workspace), row, files.get(row.oid));
  const rows = (entries) => entries.map((row) => ({ ...row, file: files.get(row.oid) }));
  const manifest = path.join(directory, "manifest.json");
  writeJson(manifest, { version: 1, base_sha: base, head_sha: head,
    base: rows(baseRows), head: rows(headRows) });
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const manifest = prepareLfs({ repo: process.env.PR_DIFF_REPOSITORY,
      workspace: process.env.GITHUB_WORKSPACE, directory: process.env.LFS_CONTEXT_DIR,
      base: process.env.PR_BASE_SHA, head: process.env.PR_HEAD_SHA,
      include: process.env.LFS_CONTEXT_PATHS, token: process.env.FETCH_TOKEN,
      server: process.env.GITHUB_SERVER_URL, repository: process.env.GITHUB_REPOSITORY });
    appendOutput("manifest", manifest);
  } catch (error) {
    appendOutput("failure_reason", String(error.message).replace(/\s+/g, " ").slice(0, 300));
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
