#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  isReviewRequestComment,
  REVIEW_REQUEST_SCHEMA_VERSION,
  stripQuotedText,
} from "./common.mjs";

assert.equal(REVIEW_REQUEST_SCHEMA_VERSION, 1);

const cases = [
  ["bare mention", "@codex", true],
  ["bare mention with surrounding whitespace", "  \n@codex  \n\n", true],
  ["review command", "@codex review", true],
  ["review command with focus", "@codex review focus on the retry path", true],
  ["mixed case command", "@CODEX Review", true],
  [
    "explanation followed by the command on its own line",
    [
      "Pushed a fix for the retry path and rebased on main.",
      "",
      "@codex review",
    ].join("\n"),
    true,
  ],
  [
    "command before trailing explanation",
    "@codex review\n\nThe failing case is the fork PR.",
    true,
  ],
  ["command indented up to three spaces", "   @codex review", true],
  ["mention mid-sentence", "Could you please @codex review this?", false],
  ["mention with trailing prose on the same line", "@codex when you can", false],
  ["mention as a different word", "@codex reviewing the diff now", false],
  [
    "command inside a fenced code block",
    ["Trigger it with:", "", "```", "@codex review", "```"].join("\n"),
    false,
  ],
  [
    "command inside a tilde-fenced block with an info string",
    ["~~~text", "@codex review", "~~~"].join("\n"),
    false,
  ],
  [
    "command inside an unterminated fenced block",
    ["```", "@codex review"].join("\n"),
    false,
  ],
  ["command inside an inline code span", "Post `@codex review` to rerun.", false],
  [
    "command inside a double-backtick span",
    "Post ``@codex review`` to rerun.",
    false,
  ],
  ["command inside an indented code block", "    @codex review", false],
  [
    "command inside a code span that crosses line breaks",
    "`example\n@codex review\nexample`",
    false,
  ],
  [
    "command inside a multi-line double-backtick span",
    "See ``example\n@codex review\nexample`` above.",
    false,
  ],
  [
    "command after a code span closed on a later line",
    "`example\nexample`\n\n@codex review",
    true,
  ],
  [
    "command after an unmatched backtick in an earlier paragraph",
    "Use a ` to quote it.\n\n@codex review",
    true,
  ],
  [
    "command after an unmatched backtick in the same paragraph",
    "Use a ` to quote it.\n@codex review",
    true,
  ],
  ["command inside a block quote", "> @codex review\n\nAlready done.", false],
  ["unrelated text", "Looks good to me, merging once CI is green.", false],
  ["unrelated mention of the reviewer", "The codex review passed.", false],
  ["empty comment", "", false],
  [
    "reopened fence after a closed one",
    ["```", "@codex", "```", "", "@codex review"].join("\n"),
    true,
  ],
];

for (const [name, body, expected] of cases) {
  assert.equal(
    isReviewRequestComment({ body, user_type: "User", user_login: "octocat" }),
    expected,
    name,
  );
}

// A comment authored by an app never requests a review, however it is worded.
assert.equal(
  isReviewRequestComment({
    body: "@codex review",
    user_type: "Bot",
    user_login: "github-actions[bot]",
  }),
  false,
);
assert.equal(
  isReviewRequestComment({
    body: "@codex review",
    user_type: "User",
    user_login: "github-actions[bot]",
  }),
  false,
);

// Missing and non-string payloads are rejected instead of throwing.
assert.equal(isReviewRequestComment(undefined), false);
assert.equal(isReviewRequestComment({ body: null }), false);
assert.equal(isReviewRequestComment({ body: 42 }), false);

// Stripping preserves line structure so two quoted regions cannot merge into
// one command line.
assert.equal(
  stripQuotedText(["```", "@codex", "```", "review"].join("\n")),
  "\n\n\nreview",
);

// A code span blanks its own characters and keeps every newline, so the line
// after a multi-line span stays on its own line.
assert.equal(
  stripQuotedText("`a\n@codex review\nb`\nreview"),
  "  \n             \n  \nreview",
);

// A stray backtick must not blank the rest of the comment: the span search
// stops at the paragraph break, as CommonMark requires.
assert.equal(stripQuotedText("a `\n\n@codex"), "a `\n\n@codex");

// Carriage returns from the GitHub comment API do not defeat the line anchors.
assert.equal(isReviewRequestComment({ body: "Done.\r\n@codex review\r\n" }), true);

process.stdout.write("review-request tests passed\n");
