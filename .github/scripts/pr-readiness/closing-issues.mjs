import { stripQuotedText } from "../review-request/common.mjs";

export const CLOSING_ISSUE_LIMIT = 100;

const REPOSITORY =
  "[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?/[A-Za-z0-9._-]+";
// One of GitHub's closing keywords, an optional colon, then one Issue
// reference: `#N`, `owner/repo#N`, or an Issue URL.
const CLOSING_REFERENCE = new RegExp(
  "(?<![\\w-])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?[ \\t]+"
    + `(?:(${REPOSITORY})#(\\d+)|#(\\d+)`
    + `|https://github\\.com/(${REPOSITORY})/issues/(\\d+))(?![\\w-])`,
  "gi",
);
const HTML_COMMENT = /<!--[\s\S]*?(?:-->|$)/g;
const LIST_MARKER = /^(?:[-*+]|\d{1,9}[.)])(?=[ \t]|$)/;

// The column where a run of leading whitespace ends when it starts at
// `column`, with tabs advancing to four-column stops as CommonMark counts them.
function whitespaceEnd(text, column = 0) {
  let end = column;
  for (const char of text) {
    if (char === " ") end += 1;
    else if (char === "\t") end += 4 - (end % 4);
    else break;
  }
  return end;
}

// An indented code block is four or more columns past the enclosing list
// item's content, starts after a blank line, and cannot interrupt a paragraph.
// Less indentation under a list item is that item's own text.
function blankIndentedCode(text) {
  const contentColumns = [];
  let afterBlank = true;
  let inCode = false;
  return text.split("\n").map((line) => {
    if (line.trim() === "") {
      afterBlank = true;
      return line;
    }
    const indent = whitespaceEnd(line);
    while (contentColumns.length > 0 && indent < contentColumns.at(-1)) {
      contentColumns.pop();
    }
    const relative = indent - (contentColumns.at(-1) ?? 0);
    const code = relative >= 4 && (afterBlank || inCode);
    afterBlank = false;
    inCode = code;
    if (code) return "";
    const rest = line.trimStart();
    const marker = relative <= 3 ? LIST_MARKER.exec(rest) : null;
    if (marker) {
      const markerEnd = indent + marker[0].length;
      const padding = whitespaceEnd(rest.slice(marker[0].length), markerEnd)
        - markerEnd;
      contentColumns.push(
        markerEnd + (padding >= 1 && padding <= 4 ? padding : 1),
      );
    }
    return line;
  }).join("\n");
}

const ISSUE_FIELDS = `
  repository { nameWithOwner }
  number
  title
  body
  state
  issueType { name }
  parent { number }
  subIssues(first: 100) {
    totalCount
    nodes {
      repository { nameWithOwner }
      number
      state
    }
  }
  blockedBy(first: 100) {
    totalCount
    nodes {
      repository { nameWithOwner }
      number
      state
    }
  }
  blocking(first: 100) {
    totalCount
    nodes {
      repository { nameWithOwner }
      number
      state
    }
  }
`;

function referenceKey(repository, number) {
  return `${String(repository).toLowerCase()}#${Number(number)}`;
}

// The Issues a pull-request body declares it closes, in body order and
// without duplicates. Quoted text, code, and HTML comments declare nothing,
// so a template placeholder or a pasted log cannot satisfy the linkage rule.
export function closingIssueReferences(body, repository) {
  const text = blankIndentedCode(stripQuotedText(
    String(body ?? "").replace(HTML_COMMENT, (chunk) => (
      chunk.replace(/[^\n]/g, " ")
    )),
  ));
  const references = [];
  const seen = new Set();
  for (const match of text.matchAll(CLOSING_REFERENCE)) {
    const target = match[1] ?? match[4] ?? String(repository ?? "");
    const number = Number(match[2] ?? match[3] ?? match[5]);
    if (!target || !Number.isSafeInteger(number) || number < 1) continue;
    const key = referenceKey(target, number);
    if (seen.has(key)) continue;
    seen.add(key);
    references.push({
      repository: target.toLowerCase() === String(repository ?? "").toLowerCase()
        ? String(repository)
        : target,
      number,
    });
  }
  return references;
}

const clip = (value, length) => String(value ?? "").slice(0, length);
const relation = (item) => ({
  repository: item.repository.nameWithOwner,
  number: item.number,
  state: item.state,
});

function normalizeIssue(issue) {
  return {
    repository: issue.repository.nameWithOwner,
    number: issue.number,
    title: clip(issue.title, 500),
    body: clip(issue.body, 80_000),
    body_truncated: String(issue.body ?? "").length > 80_000,
    state: issue.state,
    issue_type: issue.issueType?.name || "",
    parent_number: issue.parent?.number ?? null,
    sub_issue_count: issue.subIssues.totalCount,
    sub_issue_numbers: issue.subIssues.nodes.map((item) => item.number),
    sub_issues: issue.subIssues.nodes.map(relation),
    blocked_by_count: issue.blockedBy.totalCount,
    blocked_by: issue.blockedBy.nodes.map(relation),
    blocking_count: issue.blocking.totalCount,
    blocking: issue.blocking.nodes.map(relation),
  };
}

// Reads the referenced Issues in one request. `graphql(query)` resolves to the
// raw `{ data, errors }` response. A reference that is not a readable Issue
// (a pull request, a missing number, another private repository) resolves to
// null, as GitHub ignores it; any other error fails closed.
export function graphqlIssueFetcher(graphql) {
  return async (references) => {
    if (references.length === 0) return [];
    const fields = references.map((reference, index) => {
      const [owner, name] = reference.repository.split("/");
      return `i${index}: repository(owner: ${JSON.stringify(owner)}, `
        + `name: ${JSON.stringify(name)}) { `
        + `issue(number: ${reference.number}) { ${ISSUE_FIELDS} } }`;
    });
    const payload = await graphql(`query { ${fields.join("\n")} }`);
    const fatal = (payload?.errors ?? []).find(
      (error) => error.type !== "NOT_FOUND",
    );
    if (fatal) throw new Error(`GitHub GraphQL failed: ${fatal.message}`);
    if (!payload?.data) {
      throw new Error("GitHub GraphQL returned no closing-Issue data");
    }
    return references.map(
      (_reference, index) => payload.data[`i${index}`]?.issue ?? null,
    );
  };
}

// The linked-Issue evidence of a pull request: every readable Issue its body
// closes. More references than the bound are counted but not read, which the
// readiness analysis reports instead of reviewing a truncated set.
export async function collectClosingIssues({ repository, body, fetchIssues }) {
  const references = closingIssueReferences(body, repository);
  const issues = await fetchIssues(references.slice(0, CLOSING_ISSUE_LIMIT));
  const linkedIssues = [];
  const seen = new Set();
  for (const issue of issues) {
    if (!issue) continue;
    const normalized = normalizeIssue(issue);
    const key = referenceKey(normalized.repository, normalized.number);
    if (seen.has(key)) continue;
    seen.add(key);
    linkedIssues.push(normalized);
  }
  return {
    linked_issue_count: references.length > CLOSING_ISSUE_LIMIT
      ? references.length
      : linkedIssues.length,
    linked_issues: linkedIssues,
  };
}
