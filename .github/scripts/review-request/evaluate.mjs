#!/usr/bin/env node

import fs from "node:fs";
import { isReviewRequestComment } from "./common.mjs";

const requested = isReviewRequestComment({
  body: process.env.COMMENT_BODY ?? "",
  user_type: process.env.COMMENT_USER_TYPE ?? "",
  user_login: process.env.COMMENT_USER_LOGIN ?? "",
});
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `requested=${requested}\n`);
}
process.stdout.write(`requested=${requested}\n`);
