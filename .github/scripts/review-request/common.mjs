export const REVIEW_REQUEST_SCHEMA_VERSION = 1;

// A request is one whole line that is exactly `@codex`, or `@codex review`
// followed by optional focus text. CommonMark treats four or more leading
// spaces as an indented code block, so the trigger accepts at most three.
export const REVIEW_REQUEST_COMMAND =
  /^ {0,3}@codex(?:[ \t]+review\b.*?)?[ \t]*$/im;

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const BLOCK_QUOTE = /^ {0,3}>/;
const INLINE_CODE = /(`+)[^\n]*?\1/g;

function stripInlineCode(line) {
  return line.replace(INLINE_CODE, " ");
}

// Blank out every region where `@codex review` is quoted rather than
// requested: fenced code blocks, inline code spans, and block quotes. Lines
// are replaced, never removed, so a stripped region cannot join two
// unrelated lines into one command.
export function stripQuotedText(body) {
  const lines = String(body ?? "").split(/\r\n|\r|\n/);
  const kept = [];
  let openFence = "";
  for (const line of lines) {
    const fence = FENCE.exec(line);
    if (openFence) {
      const closes = fence
        && fence[1][0] === openFence[0]
        && fence[1].length >= openFence.length
        && line.slice(fence[0].length).trim() === "";
      if (closes) openFence = "";
      kept.push("");
      continue;
    }
    if (fence) {
      openFence = fence[1];
      kept.push("");
      continue;
    }
    kept.push(BLOCK_QUOTE.test(line) ? "" : stripInlineCode(line));
  }
  return kept.join("\n");
}

export function isReviewRequestComment(comment) {
  const type = String(comment?.user_type ?? "").toLowerCase();
  const login = String(comment?.user_login ?? "");
  if (type === "bot" || /\[bot\]$/i.test(login)) return false;
  return REVIEW_REQUEST_COMMAND.test(stripQuotedText(comment?.body));
}
