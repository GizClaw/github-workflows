import crypto from "node:crypto";

export const STAGE_EVIDENCE_VERSION = 1;

export function stageSha256(value) {
  return crypto.createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function textDiff(before, after) {
  const left = String(before ?? "").split("\n");
  const right = String(after ?? "").split("\n");
  let prefix = 0;
  while (
    prefix < left.length
    && prefix < right.length
    && left[prefix] === right[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < left.length - prefix
    && suffix < right.length - prefix
    && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return {
    old_start: prefix + 1,
    new_start: prefix + 1,
    removed: left.slice(prefix, left.length - suffix),
    added: right.slice(prefix, right.length - suffix),
  };
}

export function snapshotDiff(before, after) {
  if (!before) return { mode: "full", snapshot: after };
  const changes = [];
  const keys = [...new Set([
    ...Object.keys(before),
    ...Object.keys(after),
  ])].sort();
  for (const key of keys) {
    const left = before[key];
    const right = after[key];
    if (JSON.stringify(left) === JSON.stringify(right)) continue;
    changes.push({
      field: key,
      ...(typeof left === "string" && typeof right === "string"
        ? { text_diff: textDiff(left, right) }
        : { before: left ?? null, after: right ?? null }),
    });
  }
  return { mode: "incremental", changes };
}

export function stageIdentity({
  stage,
  snapshot,
  policySha256,
  model,
  effort,
}) {
  return {
    version: STAGE_EVIDENCE_VERSION,
    stage,
    snapshot_sha256: stageSha256(snapshot),
    policy_sha256: policySha256,
    model,
    effort,
  };
}

export function emptyMetrics(key, stage, mode, issueNumber = null) {
  return {
    key,
    stage,
    mode,
    issue_number: issueNumber,
    duration_seconds: 0,
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_write_tokens: 0,
    cache_hit_ratio: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0,
  };
}

export function totalMetrics(rows) {
  const totals = rows.reduce((total, metrics) => ({
    duration_seconds: total.duration_seconds + metrics.duration_seconds,
    input_tokens: total.input_tokens + metrics.input_tokens,
    cached_input_tokens: total.cached_input_tokens
      + metrics.cached_input_tokens,
    cache_write_tokens: total.cache_write_tokens
      + metrics.cache_write_tokens,
    output_tokens: total.output_tokens + metrics.output_tokens,
    reasoning_output_tokens: total.reasoning_output_tokens
      + metrics.reasoning_output_tokens,
    total_tokens: total.total_tokens + metrics.total_tokens,
  }), {
    duration_seconds: 0,
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_write_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0,
  });
  totals.cache_hit_ratio = totals.input_tokens === 0
    ? null
    : totals.cached_input_tokens / totals.input_tokens;
  return totals;
}
