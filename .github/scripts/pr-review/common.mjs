import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const STATE_SCHEMA_VERSION = 3;
export const LISTING_VERSION = 1;
export const CHUNKER_VERSION = 1;
export const CODEX_CREDIT_RATES = Object.freeze({
  "gpt-5.6-sol": Object.freeze({
    input: 125,
    cached_input: 12.5,
    output: 750,
  }),
  "gpt-5.6-terra": Object.freeze({
    input: 62.5,
    cached_input: 6.25,
    output: 375,
  }),
  "gpt-5.6-luna": Object.freeze({
    input: 25,
    cached_input: 2.5,
    output: 150,
  }),
  "gpt-5.5": Object.freeze({
    input: 125,
    cached_input: 12.5,
    output: 750,
  }),
  "gpt-5.4": Object.freeze({
    input: 62.5,
    cached_input: 6.25,
    output: 375,
  }),
  "gpt-5.4-mini": Object.freeze({
    input: 18.75,
    cached_input: 1.875,
    output: 113,
  }),
});

export function estimateCodexCredits({
  model,
  inputTokens,
  cachedInputTokens,
  outputTokens,
}) {
  const rates = CODEX_CREDIT_RATES[String(model).toLowerCase()];
  if (!rates) return null;
  const input = Math.max(0, Number(inputTokens) || 0);
  const cached = Math.min(input, Math.max(0, Number(cachedInputTokens) || 0));
  const output = Math.max(0, Number(outputTokens) || 0);
  const uncached = input - cached;
  return {
    credits: (
      (uncached * rates.input)
      + (cached * rates.cached_input)
      + (output * rates.output)
    ) / 1_000_000,
    uncached_input_tokens: uncached,
    cached_input_tokens: cached,
    output_tokens: output,
    rates_per_million: rates,
  };
}

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function writeJson(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode,
  });
}

export function appendOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  const text = String(value);
  if (text.includes("\n")) {
    const marker = `OPENAI_REVIEW_${crypto.randomUUID()}`;
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `${name}<<${marker}\n${text}\n${marker}\n`,
    );
  } else {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${text}\n`);
  }
}

export function git(repo, args, options = {}) {
  const result = spawnSync("git", args, {
    cwd: repo,
    encoding: options.encoding === null ? null : "utf8",
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    env: {
      ...process.env,
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_ATTR_NOSYSTEM: "1",
    },
  });
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString("utf8")
      : result.stderr;
    throw new Error(
      `git ${args.join(" ")} failed: ${String(stderr).trim().slice(0, 1000)}`,
    );
  }
  return result.stdout;
}

export function compareBytes(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function treeHash(root) {
  if (!fs.existsSync(root)) return sha256("");
  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  };
  walk(root);
  files.sort((left, right) => compareBytes(
    path.relative(root, left).split(path.sep).join("/"),
    path.relative(root, right).split(path.sep).join("/"),
  ));
  const hash = crypto.createHash("sha256");
  for (const file of files) {
    const relative = path.relative(root, file).split(path.sep).join("/");
    hash.update(relative);
    hash.update("\0");
    hash.update(fs.readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function usageFromSession(sessionFile) {
  const empty = {
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0,
  };
  if (!sessionFile || !fs.existsSync(sessionFile)) return empty;
  let usage = empty;
  for (const line of fs.readFileSync(sessionFile, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const item = JSON.parse(line);
      if (
        item.type === "event_msg"
        && item.payload?.type === "token_count"
        && item.payload.info?.total_token_usage
      ) {
        usage = { ...empty, ...item.payload.info.total_token_usage };
      }
    } catch {
      // Ignore an incomplete trailing rollout record.
    }
  }
  return usage;
}

export function findSession(codexHome, preferredId = "") {
  const sessionsRoot = path.join(codexHome, "sessions");
  if (!fs.existsSync(sessionsRoot)) return null;
  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(absolute);
    }
  };
  walk(sessionsRoot);
  const candidates = files.map((file) => {
    let id = "";
    let subagent = false;
    for (const line of fs.readFileSync(file, "utf8").split("\n").slice(0, 12)) {
      if (!line) continue;
      try {
        const item = JSON.parse(line);
        if (item.type === "session_meta" && item.payload?.id) {
          id = String(item.payload.id);
          subagent = item.payload.thread_source === "subagent"
            || Boolean(item.payload.parent_thread_id);
          break;
        }
      } catch {
        // Continue until session metadata is found.
      }
    }
    return { file, id, subagent, mtimeMs: fs.statSync(file).mtimeMs };
  }).filter((item) => (
    !item.subagent && /^[0-9a-f-]{36}$/i.test(item.id)
  )).sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates.find((item) => item.id === preferredId) ?? candidates[0] ?? null;
}

export function usageDelta(before, after) {
  const integer = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const delta = (name) => Math.max(0, integer(after?.[name]) - integer(before?.[name]));
  const input = delta("input_tokens");
  const cached = delta("cached_input_tokens");
  const output = delta("output_tokens");
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_tokens: Math.max(
      0,
      integer(after?.cache_write_input_tokens ?? after?.cache_write_tokens)
        - integer(before?.cache_write_input_tokens ?? before?.cache_write_tokens),
    ),
    cache_hit_ratio: input === 0 ? 0 : cached / input,
    output_tokens: output,
    reasoning_output_tokens: delta("reasoning_output_tokens"),
    total_tokens: delta("total_tokens") || input + output,
  };
}

export function rangesFromNumbers(values) {
  const numbers = [...new Set(values)].sort((left, right) => left - right);
  const ranges = [];
  for (const number of numbers) {
    const previous = ranges.at(-1);
    if (previous && previous[1] + 1 === number) previous[1] = number;
    else ranges.push([number, number]);
  }
  return ranges;
}

export function numberInRanges(number, ranges = []) {
  return ranges.some(([start, end]) => number >= start && number <= end);
}
