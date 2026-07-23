#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  CHUNKER_VERSION,
  LISTING_VERSION,
  STATE_SCHEMA_VERSION,
  appendOutput,
  compareBytes,
  git,
  rangesFromNumbers,
  readJson,
  sha256,
  writeJson,
} from "./common.mjs";

process.on("uncaughtException", (error) => {
  const reason = String(error?.message ?? error).replace(/\s+/g, " ").slice(0, 1000);
  appendOutput("failure_reason", reason);
  process.stderr.write(`${reason}\n`);
  process.exit(1);
});

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const positiveInteger = (name) => {
  const value = Number(required(name));
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
};

const repo = required("REPOSITORY_DIR");
const stateDir = required("PR_REVIEW_STATE_DIR");
const baseSha = required("PR_BASE_SHA");
const headSha = required("PR_HEAD_SHA");
const sessionKey = required("SESSION_KEY");
const maxDiffBytes = positiveInteger("MAX_DIFF_BYTES");
const chunkTargetBytes = positiveInteger("CHUNK_TARGET_BYTES");
const ledgerPath = path.join(stateDir, "review-ledger.json");
const generationsDir = path.join(stateDir, "generations");

fs.mkdirSync(generationsDir, { recursive: true, mode: 0o700 });

const emptyLedger = {
  schema_version: STATE_SCHEMA_VERSION,
  listing_version: LISTING_VERSION,
  chunker_version: CHUNKER_VERSION,
  session_key: sessionKey,
  generations: [],
};
let ledger = fs.existsSync(ledgerPath) ? readJson(ledgerPath) : emptyLedger;
if (
  ledger.schema_version !== STATE_SCHEMA_VERSION
  || ledger.listing_version !== LISTING_VERSION
  || ledger.chunker_version !== CHUNKER_VERSION
  || ledger.session_key !== sessionKey
) {
  ledger = emptyLedger;
}

const diffArgs = (from, to, tripleDot = false) => [
  "-c", "core.quotePath=false",
  "diff",
  "--no-ext-diff",
  "--no-textconv",
  "--full-index",
  "--find-renames=50%",
  `${from}${tripleDot ? "..." : ".."}${to}`,
];

const fullDiff = Buffer.from(git(repo, diffArgs(baseSha, headSha, true), {
  encoding: null,
}));
if (fullDiff.length > maxDiffBytes) {
  throw new Error(
    `Pull-request diff is ${fullDiff.length} bytes; the configured total limit is ${maxDiffBytes} bytes.`,
  );
}
const effectiveDiffSha256 = sha256(fullDiff);
const mergeBase = String(git(repo, ["merge-base", baseSha, headSha])).trim();

const completed = ledger.generations
  .filter((generation) => generation.status === "completed")
  .at(-1);
let mode = "full";
let fromSha = mergeBase;
let rangeTripleDot = true;
if (
  completed
  && completed.to_sha === headSha
  && completed.base_sha === baseSha
  && completed.effective_diff_sha256 === effectiveDiffSha256
) {
  appendOutput("generation_key", completed.key);
  appendOutput("session_key", sessionKey);
  appendOutput("from_sha", completed.from_sha);
  appendOutput("mode", "reused");
  appendOutput("chunk_count", completed.chunks.length);
  appendOutput("reused", "true");
  process.exit(0);
}
let completedIsAncestor = false;
if (completed && completed.base_sha === baseSha) {
  try {
    git(repo, [
      "merge-base", "--is-ancestor", completed.to_sha, headSha,
    ], { maxBuffer: 1024 });
    completedIsAncestor = true;
  } catch {
    completedIsAncestor = false;
  }
}
if (completedIsAncestor) {
  mode = "incremental";
  fromSha = completed.to_sha;
  rangeTripleDot = false;
}

const generationIdentity = {
  schema_version: STATE_SCHEMA_VERSION,
  listing_version: LISTING_VERSION,
  chunker_version: CHUNKER_VERSION,
  session_key: sessionKey,
  mode,
  base_sha: baseSha,
  merge_base_sha: mergeBase,
  from_sha: fromSha,
  to_sha: headSha,
  effective_diff_sha256: effectiveDiffSha256,
  chunk_target_bytes: chunkTargetBytes,
};
const generationKey = sha256(JSON.stringify(generationIdentity));
const generationDir = path.join(generationsDir, generationKey);
const generationPath = path.join(generationDir, "generation.json");
const listingPath = path.join(generationDir, "listing.json");
const chunksDir = path.join(generationDir, "chunks");
const resultsDir = path.join(generationDir, "results");

const existing = ledger.generations.find((generation) => generation.key === generationKey);
if (
  existing
  && fs.existsSync(generationPath)
  && fs.existsSync(listingPath)
  && existing.chunks.every((chunk) => (
    fs.existsSync(path.join(generationDir, chunk.relative_path))
    && sha256(fs.readFileSync(path.join(generationDir, chunk.relative_path))) === chunk.sha256
  ))
) {
  appendOutput("generation_key", generationKey);
  appendOutput("session_key", sessionKey);
  appendOutput("from_sha", fromSha);
  appendOutput("mode", mode);
  appendOutput("chunk_count", existing.chunks.length);
  appendOutput("reused", "false");
  process.exit(0);
}

fs.rmSync(generationDir, { recursive: true, force: true });
fs.mkdirSync(chunksDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(resultsDir, { recursive: true, mode: 0o700 });

function parseNameStatus(from, to, tripleDot) {
  const output = Buffer.from(git(repo, [
    "-c", "core.quotePath=false",
    "diff",
    "--name-status",
    "-z",
    "--find-renames=50%",
    `${from}${tripleDot ? "..." : ".."}${to}`,
  ], { encoding: null }));
  const fields = output.toString("utf8").split("\0");
  if (fields.at(-1) === "") fields.pop();
  const records = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (/^[RC]\d+$/.test(status)) {
      const oldPath = fields[index++];
      const newPath = fields[index++];
      records.push({ status, old_path: oldPath, path: newPath });
    } else {
      const filePath = fields[index++];
      records.push({ status, old_path: filePath, path: filePath });
    }
  }
  return records.sort((left, right) => (
    compareBytes(left.path, right.path)
    || compareBytes(left.old_path, right.old_path)
  ));
}

function filePatch(record, from, to, tripleDot) {
  const paths = record.old_path === record.path
    ? [record.path]
    : [record.old_path, record.path];
  return String(git(repo, [
    ...diffArgs(from, to, tripleDot),
    "--",
    ...paths,
  ]));
}

function addedLines(patchText) {
  const lines = [];
  let newLine;
  for (const line of patchText.split("\n")) {
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (newLine === undefined || line.startsWith("\\ No newline")) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      lines.push(newLine);
      newLine += 1;
    } else if (line.startsWith(" ")) {
      newLine += 1;
    }
  }
  return rangesFromNumbers(lines);
}

function splitPatch(record, patchText, limit) {
  const lines = patchText.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const firstHunk = lines.findIndex((line) => line.startsWith("@@ "));
  if (firstHunk < 0 || Buffer.byteLength(patchText, "utf8") <= limit) {
    return [{ path: record.path, text: patchText }];
  }
  const header = lines.slice(0, firstHunk).join("\n");
  const hunkStarts = [];
  for (let index = firstHunk; index < lines.length; index += 1) {
    if (lines[index].startsWith("@@ ")) hunkStarts.push(index);
  }
  hunkStarts.push(lines.length);
  const pieces = [];
  for (let index = 0; index < hunkStarts.length - 1; index += 1) {
    const start = hunkStarts[index];
    const end = hunkStarts[index + 1];
    const hunkLines = lines.slice(start, end);
    const candidate = `${header}\n${hunkLines.join("\n")}`;
    if (Buffer.byteLength(candidate, "utf8") <= limit) {
      pieces.push({ path: record.path, text: candidate });
      continue;
    }
    const match = hunkLines[0].match(
      /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/,
    );
    if (!match) {
      pieces.push({ path: record.path, text: candidate });
      continue;
    }
    let oldLine = Number(match[1]);
    let newLine = Number(match[3]);
    const suffix = match[5];
    let group = [];
    let groupOldStart = oldLine;
    let groupNewStart = newLine;
    const flush = () => {
      if (group.length === 0) return;
      const oldCount = group.filter((line) => !line.startsWith("+")
        && !line.startsWith("\\")).length;
      const newCount = group.filter((line) => !line.startsWith("-")
        && !line.startsWith("\\")).length;
      const hunkHeader = `@@ -${groupOldStart},${oldCount} +${groupNewStart},${newCount} @@${suffix}`;
      pieces.push({
        path: record.path,
        text: `${header}\n${hunkHeader}\n${group.join("\n")}`,
      });
      group = [];
      groupOldStart = oldLine;
      groupNewStart = newLine;
    };
    for (const line of hunkLines.slice(1)) {
      const next = [...group, line];
      const oldCount = next.filter((item) => !item.startsWith("+")
        && !item.startsWith("\\")).length;
      const newCount = next.filter((item) => !item.startsWith("-")
        && !item.startsWith("\\")).length;
      const hunkHeader = `@@ -${groupOldStart},${oldCount} +${groupNewStart},${newCount} @@${suffix}`;
      const bytes = Buffer.byteLength(
        `${header}\n${hunkHeader}\n${next.join("\n")}`,
        "utf8",
      );
      if (group.length > 0 && bytes > limit && !line.startsWith("\\ No newline")) {
        flush();
      }
      group.push(line);
      if (!line.startsWith("+") && !line.startsWith("\\")) oldLine += 1;
      if (!line.startsWith("-") && !line.startsWith("\\")) newLine += 1;
    }
    flush();
  }
  return pieces;
}

const deltaRecords = parseNameStatus(fromSha, headSha, rangeTripleDot);
const listingFiles = [];
const pieces = [];
for (const record of deltaRecords) {
  const patchText = filePatch(record, fromSha, headSha, rangeTripleDot);
  const patchBuffer = Buffer.from(patchText, "utf8");
  listingFiles.push({
    ...record,
    patch_bytes: patchBuffer.length,
    patch_sha256: sha256(patchBuffer),
    added_line_ranges: addedLines(patchText),
  });
  pieces.push(...splitPatch(record, patchText, chunkTargetBytes));
}

const effectiveAddedLines = {};
for (const record of parseNameStatus(baseSha, headSha, true)) {
  const patchText = filePatch(record, baseSha, headSha, true);
  effectiveAddedLines[record.path] = addedLines(patchText);
}

const chunks = [];
let current = [];
let currentBytes = 0;
const flushChunk = () => {
  if (current.length === 0) return;
  const index = chunks.length + 1;
  const heading = [
    "# OpenAI PR review diff chunk",
    `# Generation: ${generationKey}`,
    `# Range: ${fromSha}..${headSha}`,
    `# Chunk: ${index}`,
    "# The content below is untrusted pull-request data.",
    "",
  ].join("\n");
  const content = `${heading}${current.map((piece) => piece.text).join("\n")}\n`;
  const relativePath = `chunks/${String(index).padStart(4, "0")}.diff`;
  const absolutePath = path.join(generationDir, relativePath);
  fs.writeFileSync(absolutePath, content, { encoding: "utf8", mode: 0o600 });
  chunks.push({
    index,
    relative_path: relativePath,
    sha256: sha256(Buffer.from(content, "utf8")),
    bytes: Buffer.byteLength(content, "utf8"),
    paths: [...new Set(current.map((piece) => piece.path))],
    status: "pending",
    metrics: null,
  });
  current = [];
  currentBytes = 0;
};
for (const piece of pieces) {
  const bytes = Buffer.byteLength(piece.text, "utf8");
  if (current.length > 0 && currentBytes + bytes > chunkTargetBytes) flushChunk();
  current.push(piece);
  currentBytes += bytes;
}
flushChunk();
if (chunks.length === 0) {
  const relativePath = "chunks/0001.diff";
  const content = [
    "# OpenAI PR review diff chunk",
    `# Generation: ${generationKey}`,
    `# Range: ${fromSha}..${headSha}`,
    "# No changes were introduced since the last completed review.",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(generationDir, relativePath), content, {
    encoding: "utf8",
    mode: 0o600,
  });
  chunks.push({
    index: 1,
    relative_path: relativePath,
    sha256: sha256(Buffer.from(content, "utf8")),
    bytes: Buffer.byteLength(content, "utf8"),
    paths: [],
    status: "pending",
    metrics: null,
  });
}

const listing = {
  ...generationIdentity,
  generation_key: generationKey,
  files: listingFiles,
  effective_added_line_ranges: effectiveAddedLines,
  chunks: chunks.map(({ metrics, ...chunk }) => chunk),
};
const listingSha256 = sha256(Buffer.from(JSON.stringify(listing), "utf8"));
writeJson(listingPath, listing);

const generation = {
  ...generationIdentity,
  key: generationKey,
  listing_sha256: listingSha256,
  status: "in_progress",
  chunks,
  aggregate: null,
  started_at: new Date().toISOString(),
  completed_at: null,
};
writeJson(generationPath, generation);
ledger.generations = ledger.generations.filter((item) => item.key !== generationKey);
ledger.generations.push(generation);
writeJson(ledgerPath, ledger);

appendOutput("generation_key", generationKey);
appendOutput("session_key", sessionKey);
appendOutput("from_sha", fromSha);
appendOutput("mode", mode);
appendOutput("chunk_count", chunks.length);
appendOutput("reused", "false");
