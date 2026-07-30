#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { analyzeIssue, sha256 } from "./common.mjs";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const input = JSON.parse(fs.readFileSync(required("ISSUE_INPUT_FILE"), "utf8"));
const outputFile = required("ISSUE_CONTEXT_FILE");
const context = {
  issue: analyzeIssue(input.issue, {
    implementationIssue: process.env.IMPLEMENTATION_ISSUE !== "false",
  }),
  trusted_policy: String(input.trusted_policy ?? ""),
};
context.trusted_policy_sha256 = sha256(context.trusted_policy);
fs.mkdirSync(path.dirname(outputFile), { recursive: true, mode: 0o700 });
fs.writeFileSync(outputFile, `${JSON.stringify(context, null, 2)}\n`, {
  encoding: "utf8",
  mode: 0o600,
});

if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(
    process.env.GITHUB_OUTPUT,
    `issue_snapshot_sha256=${context.issue.snapshot_sha256}\n`,
  );
  fs.appendFileSync(
    process.env.GITHUB_OUTPUT,
    `deterministic_blocker_count=${context.issue.deterministic_blockers.length}\n`,
  );
  fs.appendFileSync(
    process.env.GITHUB_OUTPUT,
    `trusted_policy_sha256=${context.trusted_policy_sha256}\n`,
  );
}
