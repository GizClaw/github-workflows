export const REVIEW_REQUEST_SCHEMA_VERSION = 1;

// A request is one whole line that is exactly `@codex`, or `@codex review`
// followed by optional focus text. CommonMark treats four or more leading
// spaces as an indented code block, so the trigger accepts at most three.
export const REVIEW_REQUEST_COMMAND =
  /^ {0,3}@codex(?:[ \t]+review\b.*?)?[ \t]*$/im;

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const BLOCK_QUOTE = /^ {0,3}>/;
const PARAGRAPH_BREAK = /\n[ \t]*\n/;

function blankRun(chunk) {
  return chunk.replace(/[^\n]/g, " ");
}

// A code span ends the paragraph it started in: CommonMark cannot carry one
// across a blank line. Bounding the search there stops a single stray backtick
// from blanking the rest of the comment.
function paragraphEnd(text, from) {
  const match = PARAGRAPH_BREAK.exec(text.slice(from));
  return match === null ? text.length : from + match.index + 1;
}

// Inline code spans may cross line breaks, so this runs over the whole text
// rather than line by line. Every character of a span is replaced with a
// space and newlines are preserved, which removes the command without moving
// any surrounding line.
function stripInlineCode(text) {
  let out = "";
  let index = 0;
  while (index < text.length) {
    if (text[index] !== "`") {
      out += text[index];
      index += 1;
      continue;
    }
    let openEnd = index;
    while (text[openEnd] === "`") openEnd += 1;
    const runLength = openEnd - index;
    const bound = paragraphEnd(text, index);
    let search = openEnd;
    let closeStart = -1;
    while (search < bound) {
      const next = text.indexOf("`", search);
      if (next === -1 || next >= bound) break;
      let closeEnd = next;
      while (text[closeEnd] === "`") closeEnd += 1;
      if (closeEnd - next === runLength) {
        closeStart = next;
        break;
      }
      search = closeEnd;
    }
    if (closeStart === -1) {
      // An unmatched backtick run is literal text, not a delimiter.
      out += text.slice(index, openEnd);
      index = openEnd;
      continue;
    }
    const spanEnd = closeStart + runLength;
    out += blankRun(text.slice(index, spanEnd));
    index = spanEnd;
  }
  return out;
}

// Blank out every region where `@codex review` is quoted rather than
// requested: fenced code blocks, block quotes, and inline code spans. Lines
// are replaced, never removed, so a stripped region cannot join two unrelated
// lines into one command.
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
    kept.push(BLOCK_QUOTE.test(line) ? "" : line);
  }
  return stripInlineCode(kept.join("\n"));
}

export function isReviewRequestComment(comment) {
  const type = String(comment?.user_type ?? "").toLowerCase();
  const login = String(comment?.user_login ?? "");
  if (type === "bot" || /\[bot\]$/i.test(login)) return false;
  return REVIEW_REQUEST_COMMAND.test(stripQuotedText(comment?.body));
}
