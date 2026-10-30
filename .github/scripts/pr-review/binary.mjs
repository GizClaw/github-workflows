import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { git, sha256 } from "./common.mjs";

const MAX_BLOB_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico"]);

// Export immutable blob bytes as data, never under PR-supplied filesystem paths.
export function binaryWriter(repo, directory, {
  maxBlobBytes = MAX_BLOB_BYTES, maxTotalBytes = MAX_TOTAL_BYTES,
} = {}) {
  const objects = new Map();
  let total = 0;
  return (revision, file) => {
    const entry = String(git(repo, [
      "ls-tree", "-z", "-l", revision, "--", `:(literal)${file}`,
    ]));
    if (!entry) return null;
    const match = entry.match(/^100(?:644|755) blob ([0-9a-f]{40}) +(\d+)\t([^\0]+)\0$/);
    if (!match || match[3] !== file) {
      throw new Error("Binary review evidence must be a regular tracked file");
    }
    const [, oid, sizeText] = match;
    const size = Number(sizeText);
    if (size > maxBlobBytes) throw new Error(`Binary review blob exceeds ${maxBlobBytes} bytes`);
    if (!objects.has(oid)) {
      total += size;
      if (total > maxTotalBytes) throw new Error(`Binary review evidence exceeds ${maxTotalBytes} bytes`);
      const data = Buffer.from(git(repo, ["cat-file", "blob", oid], {
        encoding: null, maxBuffer: maxBlobBytes + 1024,
      }));
      const actual = crypto.createHash("sha1")
        .update(`blob ${data.length}\0`).update(data).digest("hex");
      if (data.length !== size || actual !== oid) throw new Error("Binary review blob identity mismatch");
      const ext = path.extname(file).toLowerCase();
      const relativePath = `binary/${oid}${imageExtensions.has(ext) ? ext : ".bin"}`;
      fs.mkdirSync(path.join(directory, "binary"), { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(directory, relativePath), data, { flag: "wx", mode: 0o600 });
      objects.set(oid, { oid, size, sha256: sha256(data), relative_path: relativePath });
    }
    return { revision, path: file, ...objects.get(oid) };
  };
}

export function verifyBinaryEvidence(directory, listing) {
  for (const file of listing.files) {
    for (const object of Object.values(file.binary ?? {})) {
      if (!object) continue;
      if (!/^binary\/[0-9a-f]{40}\.(bin|png|jpg|jpeg|gif|webp|ico)$/.test(object.relative_path)) {
        throw new Error("Invalid binary review evidence path");
      }
      const target = path.join(directory, object.relative_path);
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.size !== object.size || stat.size > MAX_BLOB_BYTES) {
        throw new Error("Invalid binary review evidence file");
      }
      const data = fs.readFileSync(target);
      const oid = crypto.createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");
      if (oid !== object.oid || sha256(data) !== object.sha256) {
        throw new Error("Binary review evidence checksum mismatch");
      }
    }
  }
}
