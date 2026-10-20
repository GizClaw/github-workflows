#!/usr/bin/env node

// Exercise the real pinned CLI against a local Responses fixture, with no API key.
// Run with the pinned codex binary on PATH (see README.md).
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { findSession, usageFromSession } from "./common.mjs";
import { nativeUsageSession, readNativeReview } from "./native.mjs";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "native-review-session-"));
const repo = path.join(temporary, "repo");
const firstHome = path.join(temporary, "first-home");
const restoredHome = path.join(temporary, "restored-home");
let passed = false;
for (const directory of [repo, firstHome, restoredHome]) fs.mkdirSync(directory);
const requests = [];
const nativeReview = {
  findings: [],
  overall_correctness: "patch is correct",
  overall_explanation: "COMPLETED: No issues found in the supplied diff.",
  overall_confidence_score: 0.99,
};
const stageResult = {
  execution: { status: "completed", reason: "" },
  summary: "Incremental review completed.",
  blockers: [],
};
const server = http.createServer(async (request, response) => {
  if (request.method !== "POST") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [] }));
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  requests.push(JSON.parse(Buffer.concat(chunks).toString()));
  const text = JSON.stringify(requests.length === 1 ? nativeReview : stageResult);
  const id = `response_${requests.length}`;
  const item = {
    id: `message_${requests.length}`,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  const events = [
    { type: "response.created", response: { id, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [], status: "in_progress" } },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id, status: "completed", output: [item],
        usage: {
          input_tokens: 100,
          input_tokens_details: { cached_tokens: 20 },
          output_tokens: 30,
          output_tokens_details: { reasoning_tokens: 10 },
          total_tokens: 130,
        },
      },
    },
  ];
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const cli = ["codex"];
const config = [
  'model="gpt-6.1-sol"',
  'model_reasoning_effort="max"',
  'model_provider="fixture"',
  'model_providers.fixture.name="Local review fixture"',
  `model_providers.fixture.base_url="http://127.0.0.1:${server.address().port}/v1"`,
  'model_providers.fixture.wire_api="responses"',
  "model_providers.fixture.requires_openai_auth=false",
  "model_providers.fixture.supports_websockets=false",
  'default_permissions=":read-only"',
].flatMap((value) => ["--config", value]);
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => (
  !/TOKEN|API_KEY|SECRET/.test(key.toUpperCase())
)));
function invoke(args, home, prompt, command = cli) {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], [...command.slice(1), ...args], {
      cwd: repo, env: { ...environment, CODEX_HOME: home },
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => { child.kill(); reject(new Error("CLI fixture timed out")); }, 45_000);
    child.on("error", (error) => { clearTimeout(timeout); reject(error); });
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    child.on("close", (status) => { clearTimeout(timeout); resolve({ status, stdout, stderr }); });
    child.stdin.end(prompt);
  });
}

try {
  for (const args of [["init", "-q"], ["config", "user.name", "Review Test"], ["config", "user.email", "review@example.com"]]) {
    assert.equal(spawnSync("git", args, { cwd: repo }).status, 0);
  }
  fs.writeFileSync(path.join(repo, "sample.txt"), "fixture\n");
  assert.equal(spawnSync("git", ["add", "."], { cwd: repo }).status, 0);
  assert.equal(spawnSync("git", ["commit", "-qm", "fixture"], { cwd: repo }).status, 0);
  fs.writeFileSync(path.join(firstHome, "config.toml"), config.filter((_, index) => index % 2).join("\n"));
  const nativeRunner = path.join(temporary, "native-runner.mjs");
  fs.writeFileSync(nativeRunner, [
    `import { runNativeReview } from ${JSON.stringify(new URL("./native.mjs", import.meta.url).href)};`,
    'let input = ""; for await (const data of process.stdin) input += data;',
    'process.stdout.write(JSON.stringify(runNativeReview(JSON.parse(input))));',
  ].join("\n"));
  const initial = await invoke([nativeRunner], firstHome, JSON.stringify({
    codexHome: firstHome, repositoryDir: repo, model: "gpt-6.1-sol", effort: "max",
    key: "fixture:native", mode: "full", paths: ["sample.txt"],
    prompt: "Review the supplied code fixture. Return the native review JSON format with COMPLETED: at the start of overall_explanation.",
  }), [process.execPath]);
  assert.equal(initial.status, 0, initial.stderr);
  assert.equal(JSON.parse(initial.stdout).metrics.input_tokens, 100);
  const session = findSession(firstHome);
  assert.ok(session, "native review must persist a primary session");
  const decoded = readNativeReview(session.file, repo, ["sample.txt"]);
  assert.equal(decoded.result.summary, "No issues found in the supplied diff.");
  assert.equal(usageFromSession(nativeUsageSession(firstHome, session, decoded.turnId).file).input_tokens, 100);
  const relative = path.relative(firstHome, session.file);
  const restoredFile = path.join(restoredHome, relative);
  fs.mkdirSync(path.dirname(restoredFile), { recursive: true });
  fs.copyFileSync(session.file, restoredFile);
  const outputFile = path.join(temporary, "stage-result.json");
  const schema = path.join(path.dirname(new URL(import.meta.url).pathname), "stage-output-schema.json");
  const resumed = await invoke([
    "exec", "resume", ...config,
    "--output-schema", schema, "--output-last-message", outputFile, session.id, "-",
  ], restoredHome, "Review only the incremental metadata change. Preserve the native review findings in context and return the stage output schema.");
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(outputFile)), stageResult);
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.model === "gpt-6.1-sol" && request.reasoning.effort === "max"));
  assert.match(JSON.stringify(requests[0]), /reviewer|reviewing|code review/i);
  assert.match(JSON.stringify(requests[1]), /No issues found in the supplied diff/);
  assert.equal(findSession(restoredHome, session.id).id, session.id);
  passed = true;
  process.stdout.write("native review -> restored exec resume: ok (real CLI, local API fixture)\n");
} catch (error) {
  process.stderr.write(`Fixture retained at ${temporary}\n`);
  throw error;
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  if (passed) fs.rmSync(temporary, { recursive: true, force: true });
}
