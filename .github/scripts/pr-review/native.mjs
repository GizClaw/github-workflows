import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { findSession, usageDelta, usageFromSession } from "./common.mjs";

export const NATIVE_SESSION_VERSION = 1;

export function readNativeReview(file, repositoryDir, paths, offset = 0) {
  let completed;
  for (const line of fs.readFileSync(file).subarray(offset).toString("utf8").split("\n")) {
    if (!line) continue;
    const entry = JSON.parse(line);
    if (entry.type !== "event_msg") continue;
    const event = entry.payload;
    if (event.type === "exited_review_mode") {
      completed = { output: event.review_output, turnId: event.turn_id };
    } else if (event.type === "item_completed" && event.item?.type === "ExitedReviewMode") {
      completed = { output: event.item.review_output, turnId: event.turn_id };
    }
  }
  const output = completed?.output;
  if (
    !output
    || !Array.isArray(output.findings)
    || !["patch is correct", "patch is incorrect"].includes(output.overall_correctness)
    || typeof output.overall_explanation !== "string"
    || !/^COMPLETED:\s*\S/.test(output.overall_explanation)
    || !Number.isFinite(output.overall_confidence_score)
    || output.overall_confidence_score < 0
    || output.overall_confidence_score > 1
  ) {
    throw new Error(`Native review incomplete or invalid: ${String(output?.overall_explanation ?? "missing completed review output").slice(0, 500)}`);
  }
  const findings = output.findings.slice(0, 25).map((finding) => {
    const location = finding?.code_location;
    const absolute = location?.absolute_file_path;
    const relative = typeof absolute === "string" && path.isAbsolute(absolute)
      ? path.relative(repositoryDir, absolute).split(path.sep).join("/")
      : "";
    if (
      !finding
      || typeof finding.title !== "string"
      || typeof finding.body !== "string"
      || !Number.isInteger(finding.priority)
      || finding.priority < 0 || finding.priority > 3
      || !Number.isFinite(finding.confidence_score)
      || finding.confidence_score < 0 || finding.confidence_score > 1
      || !relative || !paths.includes(relative)
      || !Number.isSafeInteger(location.line_range?.start)
      || location.line_range.start < 1
      || !Number.isSafeInteger(location.line_range?.end)
      || location.line_range.end < location.line_range.start
    ) throw new Error("Native review returned an invalid code finding");
    return {
      title: finding.title.slice(0, 240),
      body: finding.body.slice(0, 12000),
      priority: `P${finding.priority}`,
      path: relative,
      line: location.line_range.start,
    };
  });
  return {
    turnId: completed.turnId,
    result: {
      summary: output.overall_explanation.replace(/^COMPLETED:\s*/, "").slice(0, 12000),
      findings,
      // Native code analysis is followed by plan-conformance aggregation.
      readiness: { verdict: "pass", blockers: [] },
    },
  };
}

// Native review runs in a child thread. Its tokens are not written to the
// primary rollout in CLI 0.163.0, although its result is. Count the exact child
// turn here; only the primary rollout is needed for a later exec resume.
export function nativeUsageSession(codexHome, primary, turnId) {
  const root = path.join(codexHome, "sessions");
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        const found = walk(file);
        if (found) return found;
      } else if (entry.isFile() && entry.name.endsWith(".jsonl") && file !== primary.file) {
        const text = fs.readFileSync(file, "utf8");
        let header;
        try { header = JSON.parse(text.split("\n", 1)[0]); } catch { continue; }
        const meta = header.type === "session_meta" ? header.payload : null;
        if (meta?.parent_thread_id !== primary.id || meta.source?.subagent !== "review") continue;
        const rows = text.trim().split("\n").map(JSON.parse);
        if (!rows.some((row) => row.type === "event_msg"
          && row.payload.type === "task_started"
          && (row.payload.root_turn_id ?? row.payload.turn_attribution?.root_turn_id) === turnId)) continue;
        return { id: meta.id, file };
      }
    }
    return null;
  };
  return walk(root) ?? primary;
}

export function runNativeReview({ codexHome, repositoryDir, model, effort, prompt, paths, key, mode }) {
  const before = findSession(codexHome);
  const beforeSize = before ? fs.statSync(before.file).size : 0;
  const beforeUsage = usageFromSession(before?.file);
  const started = Date.now();
  const command = spawnSync("codex", [
    "review",
    "--config", `model=${JSON.stringify(model)}`,
    "--config", `review_model=${JSON.stringify(model)}`,
    "--config", `model_reasoning_effort=${JSON.stringify(effort)}`,
    "--config", 'default_permissions=":read-only"',
    "-",
  ], {
    cwd: repositoryDir,
    input: prompt,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, CODEX_HOME: codexHome, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "codex_github_action", FORCE_COLOR: "0" },
  });
  if (command.status !== 0) {
    throw new Error(`Native review failed: ${String(command.stderr || command.stdout || `exit ${command.status}`).replace(/\s+/g, " ").slice(0, 1000)}`);
  }
  const session = findSession(codexHome);
  if (!session) throw new Error("Native review did not persist a primary session");
  const { result, turnId } = readNativeReview(
    session.file, repositoryDir, paths, before?.file === session.file ? beforeSize : 0,
  );
  const usageSession = nativeUsageSession(codexHome, session, turnId);
  return {
    sessionId: session.id,
    result,
    metrics: {
      key, stage: "code", mode, issue_number: null,
      duration_seconds: Math.max(0, Math.round((Date.now() - started) / 1000)),
      ...usageDelta(before?.file === usageSession.file ? beforeUsage : null, usageFromSession(usageSession.file)),
    },
  };
}
