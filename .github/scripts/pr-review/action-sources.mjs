import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { git } from "./common.mjs";

const insist = (value, message) => { if (!value) throw new Error(message); };
const oid = value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const hash = (kind, bytes) => crypto.createHash("sha1").update(`${kind} ${bytes.length}\0`).update(bytes).digest("hex");
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const safePath = value => typeof value === "string" && value.length <= 512 && value !== ""
  && !value.startsWith("/") && !/[\\\x00-\x1f\x7f]/.test(value)
  && value.split("/").every(part => part !== "" && part !== "." && part !== "..");
export const ACTION_SOURCE_LIMITS = { repositories: 4, snapshots: 8, files: 512, blobBytes: 8 * 1024 * 1024, totalBytes: 32 * 1024 * 1024, depth: 4 };

export function actionReference(value) {
  const match = /^([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+)(?:\/([^@]+))?@([a-f0-9]{40})$/.exec(value);
  insist(match && match[2] !== "." && match[2] !== ".." && (!match[3] || safePath(match[3])), "Action source requires a literal GitHub action at a full SHA");
  return { repository: `${match[1]}/${match[2]}`, action_path: match[3] || "", commit: match[4] };
}
// Discovery is deliberately syntax-limited, never a YAML evaluator. Values are
// untrusted lookup hints, not executable policy. Unsupported forms stay absent
// evidence and cannot be represented as complete source in the manifest.
function uses(text) {
  const values = [...text.matchAll(/^\s*(?:-\s*)?uses:\s*["']?([^\s"'#]+)["']?\s*(?:#.*)?$/gm)].map(match => match[1]);
  const keys = [...text.matchAll(/(?:^\s*(?:-\s*)?|[,{]\s*)["']?uses["']?\s*:/gm)];
  insist(keys.length === values.length, "Unsupported action uses syntax; source coverage cannot be established");
  return values;
}
export function actionRefsFromDiff(text) {
  const refs = new Set();
  let workflow = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) workflow = / b\/\.github\/workflows\/[^/]+\.ya?ml$/.test(line);
    if (!workflow || !/^[+-](?![+-])/.test(line)) continue;
    for (const value of uses(line.slice(1))) {
      if (/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+(?:\/[^@]+)?@[a-f0-9]{40}$/.test(value)) {
        const reference = actionReference(value);
        // Reusable workflow jobs are a different protocol, not action manifests.
        if (!/^\.github\/workflows\/[^/]+\.ya?ml$/.test(reference.action_path)) refs.add(value);
      }
    }
  }
  return [...refs].sort();
}
export function discoverActionRefs({ repo, base, head, from }) {
  insist(oid(base) && oid(head) && (!from || oid(from)), "Invalid action source PR revisions");
  const mergeBase = String(git(repo, ["merge-base", base, head])).trim();
  const diff = revision => String(git(repo, ["diff", "--no-ext-diff", "--no-textconv", "--unified=0", `${revision}..${head}`, "--", ".github/workflows/*.yml", ".github/workflows/*.yaml"], { maxBuffer: 8 * 1024 * 1024 }));
  // Incremental review can remove an intermediate pin absent from the final
  // merge-base diff. Supply its source too, not just base/current versions.
  const refs = new Set(actionRefsFromDiff(diff(mergeBase)));
  if (from && from !== mergeBase) for (const ref of actionRefsFromDiff(diff(from))) refs.add(ref);
  return { base: mergeBase, head, refs: [...refs].sort() };
}

function checkedTree(tree, expected) {
  insist(tree.sha === expected && tree.truncated === false && Array.isArray(tree.tree), "Incomplete or mismatched action source tree");
  insist(tree.tree.length <= 2048, "Action source tree entry bound exceeded");
  const byPath = new Map();
  for (const entry of tree.tree) {
    insist(safePath(entry.path) && oid(entry.sha) && !byPath.has(entry.path), "Unsafe or duplicate action source path");
    insist((entry.type === "tree" && entry.mode === "040000") || (entry.type === "blob" && ["100644", "100755"].includes(entry.mode)), "Action source symlinks/submodules are unsupported");
    byPath.set(entry.path, entry);
  }
  const groups = new Map([["", []]]);
  for (const entry of byPath.values()) {
    const parent = path.posix.dirname(entry.path) === "." ? "" : path.posix.dirname(entry.path);
    insist(!parent || byPath.get(parent)?.type === "tree", "Missing action source parent tree");
    if (!groups.has(parent)) groups.set(parent, []);
    groups.get(parent).push(entry);
    if (entry.type === "tree" && !groups.has(entry.path)) groups.set(entry.path, []);
  }
  for (const [parent, entries] of groups) {
    entries.sort((a, b) => Buffer.compare(Buffer.from(path.posix.basename(a.path) + (a.type === "tree" ? "/" : "")), Buffer.from(path.posix.basename(b.path) + (b.type === "tree" ? "/" : ""))));
    const bytes = Buffer.concat(entries.map(entry => Buffer.concat([Buffer.from(`${entry.type === "tree" ? "40000" : entry.mode} ${path.posix.basename(entry.path)}\0`), Buffer.from(entry.sha, "hex")])));
    insist(hash("tree", bytes) === (parent ? byPath.get(parent).sha : expected), "Action source tree hash mismatch");
  }
  return [...byPath.values()].filter(entry => entry.type === "blob").sort((a, b) => a.path.localeCompare(b.path, "en"));
}

export async function collectActionSources({ github, directory, base, head, refs, limits = ACTION_SOURCE_LIMITS }) {
  insist(oid(base) && oid(head) && Array.isArray(refs), "Invalid action source request");
  insist(!fs.existsSync(directory), "Action source directory must be new");
  fs.mkdirSync(path.join(directory, "objects"), { recursive: true, mode: 0o700 });
  const repositories = new Map(), snapshots = new Map(), objects = new Map(), actions = new Map();
  let total = 0, count = 0;
  const snapshot = async reference => {
    const key = `${reference.repository.toLowerCase()}@${reference.commit}`;
    if (snapshots.has(key)) return snapshots.get(key);
    insist(snapshots.size < limits.snapshots, "Action source snapshot bound exceeded");
    const [owner, repo] = reference.repository.split("/");
    if (!repositories.has(reference.repository.toLowerCase())) {
      insist(repositories.size < limits.repositories, "Action source repository bound exceeded");
      const { data } = await github.rest.repos.get({ owner, repo });
      // Cross-repository private access is outside the caller-token contract.
      insist(data.private === false && Number.isSafeInteger(data.id) && data.id > 0 && data.full_name?.toLowerCase() === reference.repository.toLowerCase(), "Action source must be the exact public repository");
      repositories.set(reference.repository.toLowerCase(), { id: data.id, full_name: data.full_name });
    }
    const commit = (await github.rest.git.getCommit({ owner, repo, commit_sha: reference.commit })).data;
    insist(commit.sha === reference.commit && oid(commit.tree?.sha), "Action source commit identity mismatch");
    const tree = (await github.rest.git.getTree({ owner, repo, tree_sha: commit.tree.sha, recursive: "1" })).data;
    const entries = checkedTree(tree, commit.tree.sha);
    const files = [];
    for (const entry of entries) {
      insist(++count <= limits.files && Number.isSafeInteger(entry.size) && entry.size >= 0 && entry.size <= limits.blobBytes, "Action source file/size bound exceeded");
      if (!objects.has(entry.sha)) {
        const blob = (await github.rest.git.getBlob({ owner, repo, file_sha: entry.sha })).data;
        insist(blob.sha === entry.sha && blob.encoding === "base64" && blob.size === entry.size && typeof blob.content === "string", "Malformed action source blob");
        insist(blob.content.length <= 8 * Math.ceil(entry.size / 3) + 2, "Action source encoded blob bound exceeded");
        const encoded = blob.content.replace(/\n/g, "");
        insist(encoded.length === 4 * Math.ceil(entry.size / 3) && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded), "Malformed action source base64");
        const bytes = Buffer.from(encoded, "base64");
        insist(bytes.length === entry.size && hash("blob", bytes) === entry.sha, "Action source blob hash mismatch");
        insist((total += bytes.length) <= limits.totalBytes, "Action source total byte bound exceeded");
        const digest = sha256(bytes), relative_path = `objects/${digest}.txt`;
        fs.writeFileSync(path.join(directory, relative_path), bytes, { mode: 0o400, flag: "wx" });
        objects.set(entry.sha, { blob: entry.sha, sha256: digest, size: bytes.length, relative_path });
      }
      insist(objects.get(entry.sha).size === entry.size, "Conflicting action source blob size");
      files.push({ path: entry.path, mode: entry.mode, ...objects.get(entry.sha) });
    }
    const result = { repository: repositories.get(reference.repository.toLowerCase()), commit: commit.sha, tree: commit.tree.sha, tree_entries: tree.tree, files };
    snapshots.set(key, result); return result;
  };
  const visit = async (value, ancestors = []) => {
    insist(ancestors.length < limits.depth && !ancestors.includes(value), "Action source dependency depth/cycle");
    if (actions.has(value)) return;
    insist(actions.size < 32, "Action source dependency count bound exceeded");
    const reference = actionReference(value), source = await snapshot(reference);
    const prefix = reference.action_path ? `${reference.action_path}/` : "";
    const manifests = source.files.filter(file => [prefix + "action.yml", prefix + "action.yaml"].includes(file.path));
    insist(manifests.length === 1, "Missing or ambiguous action source manifest");
    const text = fs.readFileSync(path.join(directory, manifests[0].relative_path), "utf8");
    const dependencies = uses(text);
    actions.set(value, { ref: value, ...reference, manifest: manifests[0].path, dependencies });
    for (const dependency of dependencies) {
      insist(!dependency.startsWith("./"), "Local composite action uses require caller-workspace evidence and are unsupported");
      actionReference(dependency); // Mutable/docker/dynamic dependency: refuse.
      await visit(dependency, [...ancestors, value]);
    }
  };
  for (const ref of [...new Set(refs)].sort()) await visit(ref);
  const manifest = { schema: 1, base, head, refs: [...new Set(refs)].sort(), actions: [...actions.values()].sort((a, b) => a.ref.localeCompare(b.ref, "en")), snapshots: [...snapshots.values()].sort((a, b) => `${a.repository.full_name}@${a.commit}`.localeCompare(`${b.repository.full_name}@${b.commit}`, "en")) };
  const file = path.join(directory, "manifest.json");
  fs.writeFileSync(file, JSON.stringify(manifest), { mode: 0o400, flag: "wx" });
  return file;
}

export function verifyActionSources(file, { base, head, requiredRefs = [] }) {
  if (!file) { insist(requiredRefs.length === 0, "Pinned action source manifest is required"); return ""; }
  const root = path.dirname(file);
  insist(!fs.lstatSync(root).isSymbolicLink() && fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink() && fs.statSync(file).size <= 4 * 1024 * 1024, "Unsafe or oversized action source manifest");
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  insist(manifest.schema === 1 && manifest.base === base && manifest.head === head && Array.isArray(manifest.refs) && Array.isArray(manifest.snapshots) && Array.isArray(manifest.actions), "Action source PR binding mismatch");
  insist(requiredRefs.every(ref => manifest.refs.includes(ref)), "Missing changed action source reference");
  insist(manifest.snapshots.length <= ACTION_SOURCE_LIMITS.snapshots && manifest.actions.length <= 32, "Action source manifest bound exceeded");
  const actions = new Map(manifest.actions.map(action => [action.ref, action]));
  insist(actions.size === manifest.actions.length, "Duplicate action source dependency");
  const snapshots = new Map(), verifiedObjects = new Set();
  let fileCount = 0, totalBytes = 0;
  for (const snapshot of manifest.snapshots) {
    insist(oid(snapshot.commit) && oid(snapshot.tree) && snapshot.repository?.full_name && Number.isSafeInteger(snapshot.repository.id), "Invalid action source snapshot");
    const key = `${snapshot.repository.full_name.toLowerCase()}@${snapshot.commit}`;
    insist(!snapshots.has(key), "Duplicate action source snapshot");
    const entries = checkedTree({ sha: snapshot.tree, tree: snapshot.tree_entries, truncated: false }, snapshot.tree);
    insist((fileCount += entries.length) <= ACTION_SOURCE_LIMITS.files, "Action source file bound exceeded");
    insist(entries.length === snapshot.files.length, "Incomplete action source files");
    for (const entry of entries) {
      const object = snapshot.files.find(item => item.path === entry.path);
      insist(object?.blob === entry.sha && object.mode === entry.mode && object.size === entry.size && /^[a-f0-9]{64}$/.test(object.sha256) && object.relative_path === `objects/${object.sha256}.txt`, "Action source file binding mismatch");
      insist(Number.isSafeInteger(object.size) && object.size >= 0 && object.size <= ACTION_SOURCE_LIMITS.blobBytes, "Action source blob bound exceeded");
      if (!verifiedObjects.has(object.sha256)) { totalBytes += object.size; verifiedObjects.add(object.sha256); }
      insist(totalBytes <= ACTION_SOURCE_LIMITS.totalBytes, "Action source byte bound exceeded");
      const target = path.join(root, object.relative_path);
      insist(!fs.lstatSync(root).isSymbolicLink() && !fs.lstatSync(path.join(root, "objects")).isSymbolicLink() && fs.lstatSync(target).isFile() && !fs.lstatSync(target).isSymbolicLink() && fs.statSync(target).size === object.size, "Unsafe action source evidence file");
      const bytes = fs.readFileSync(target);
      insist(bytes.length === object.size && hash("blob", bytes) === object.blob && sha256(bytes) === object.sha256, "Action source evidence checksum mismatch");
    }
    snapshots.set(key, snapshot);
  }
  const check = (ref, ancestors = []) => {
    insist(ancestors.length < ACTION_SOURCE_LIMITS.depth && !ancestors.includes(ref), "Action source dependency depth/cycle");
    const reference = actionReference(ref), action = actions.get(ref), snapshot = snapshots.get(`${reference.repository.toLowerCase()}@${reference.commit}`);
    const prefix = reference.action_path ? reference.action_path + "/" : "";
    const manifests = snapshot?.files.filter(item => [prefix + "action.yml", prefix + "action.yaml"].includes(item.path));
    insist(action && action.repository === reference.repository && action.action_path === reference.action_path && action.commit === reference.commit && manifests?.length === 1 && action.manifest === manifests[0].path, "Missing or mismatched action source dependency");
    const dependencies = uses(fs.readFileSync(path.join(root, manifests[0].relative_path), "utf8"));
    insist(JSON.stringify(dependencies) === JSON.stringify(action.dependencies), "Action source dependency binding mismatch");
    for (const dependency of dependencies) {
      insist(!dependency.startsWith("./"), "Local composite action uses are unsupported");
      check(dependency, [...ancestors, ref]);
    }
  };
  for (const ref of manifest.refs) check(ref);
  return manifest.refs.length ? sha256(JSON.stringify(manifest)) : "";
}
