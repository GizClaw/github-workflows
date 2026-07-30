#!/usr/bin/env node

import fs from "node:fs";
import { evaluateReadiness } from "./common.mjs";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const evidence = evaluateReadiness({
  context: JSON.parse(fs.readFileSync(required("PR_CONTEXT_FILE"), "utf8")),
  review: JSON.parse(required("REVIEW")),
  workflowSourceSha: required("WORKFLOW_SOURCE_SHA"),
  model: required("MODEL"),
  effort: required("EFFORT"),
});
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `verdict=${evidence.verdict}\n`);
  const marker = `PR_READINESS_${Date.now()}`;
  fs.appendFileSync(
    process.env.GITHUB_OUTPUT,
    `evidence<<${marker}\n${JSON.stringify(evidence)}\n${marker}\n`,
  );
}
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);

