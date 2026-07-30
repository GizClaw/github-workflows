import crypto from "node:crypto";

export const ISSUE_REVIEW_SCHEMA_VERSION = 1;
export const REQUIRED_SECTIONS = Object.freeze([
  "Background",
  "Goal",
  "Code Changes Tree",
  "Design",
  "Test And Acceptance Criteria",
]);
export const PREFIXED_TITLE = /^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*: \S.*$/;

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function blocker(code, message) {
  return { source: "issue-format", code, message };
}

function markdownStructure(body) {
  const lines = String(body).split(/\r?\n/);
  const headings = [];
  const visibleLines = [];
  let fence = "";
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1][0];
      else if (fence === fenceMatch[1][0]) fence = "";
      continue;
    }
    if (fence) continue;
    visibleLines.push({ index, line });
    const heading = line.match(/^## (.+?)\s*$/)?.[1];
    if (heading) headings.push({ index, heading });
  }
  return { lines, headings, visibleLines };
}

export function issueSnapshot(issue) {
  const subIssueNumbers = [...new Set(
    (issue.sub_issue_numbers ?? []).map(Number).filter(Number.isSafeInteger),
  )].sort((left, right) => left - right);
  return {
    repository: String(issue.repository ?? ""),
    number: Number(issue.number),
    title: String(issue.title ?? ""),
    body: String(issue.body ?? ""),
    issue_type: String(issue.issue_type ?? ""),
    parent_number: issue.parent_number == null ? null : Number(issue.parent_number),
    sub_issue_count: issue.sub_issue_count == null
      ? subIssueNumbers.length
      : Number(issue.sub_issue_count),
    sub_issue_numbers: subIssueNumbers,
  };
}

export function issueSnapshotSha256(issue) {
  return sha256(JSON.stringify(issueSnapshot(issue)));
}

export function analyzeIssue(issue, { implementationIssue = true } = {}) {
  const snapshot = issueSnapshot(issue);
  const blockers = [];
  if (!PREFIXED_TITLE.test(snapshot.title)) {
    blockers.push(blocker(
      "invalid-title",
      "Issue title must use the lowercase `prefix: Subject` format.",
    ));
  }
  if (!snapshot.issue_type) {
    blockers.push(blocker(
      "missing-issue-type",
      "Issue must have a GitHub Issue Type.",
    ));
  }
  if (implementationIssue && snapshot.issue_type.toLowerCase() === "task") {
    blockers.push(blocker(
      "tracking-task",
      "A pull request must close a concrete implementation Issue, not only a Task container.",
    ));
  }
  if (
    snapshot.issue_type.toLowerCase() === "task"
    && snapshot.sub_issue_count === 0
  ) {
    blockers.push(blocker(
      "task-without-sub-issues",
      "A Task Issue must be a tracking container with native sub-issues.",
    ));
  }
  if (snapshot.sub_issue_count > snapshot.sub_issue_numbers.length) {
    blockers.push(blocker(
      "sub-issues-truncated",
      "The workflow could not snapshot every native sub-issue and must fail closed.",
    ));
  }

  const structure = markdownStructure(snapshot.body);
  const sections = structure.headings.map((item) => item.heading);
  if (
    snapshot.issue_type.toLowerCase() !== "task"
    && (
    sections.length !== REQUIRED_SECTIONS.length
    || sections.some((section, index) => section !== REQUIRED_SECTIONS[index])
    )
  ) {
    blockers.push(blocker(
      "invalid-section-contract",
      `Issue must contain exactly these top-level sections in order: ${REQUIRED_SECTIONS.join(", ")}.`,
    ));
  }

  const backgroundHeading = structure.headings.find(
    (item) => item.heading === "Background",
  );
  const nextHeading = structure.headings.find(
    (item) => backgroundHeading && item.index > backgroundHeading.index,
  );
  const background = !backgroundHeading
    ? ""
    : structure.visibleLines
      .filter((item) => (
        item.index > backgroundHeading.index
        && (!nextHeading || item.index < nextHeading.index)
      ))
      .map((item) => item.line)
      .join("\n");
  for (
    const label of snapshot.issue_type.toLowerCase() === "task"
      ? []
      : ["Parent", "Prerequisite of", "Follow up to"]
  ) {
    if (new RegExp(`^${label}:`, "m").test(background)) {
      blockers.push(blocker(
        "invalid-background-relationship",
        `${label} relationships must be Markdown list items.`,
      ));
    }
  }
  if (
    snapshot.issue_type.toLowerCase() !== "task"
    && /^- (?:Prerequisite of|Follow up to):\s+#\d+\s*$/m.test(background)
  ) {
    blockers.push(blocker(
      "invalid-background-relationship",
      "Prerequisite of and Follow up to relationships must use nested Issue lists.",
    ));
  }

  return {
    schema_version: ISSUE_REVIEW_SCHEMA_VERSION,
    snapshot,
    snapshot_sha256: issueSnapshotSha256(snapshot),
    deterministic_blockers: blockers,
  };
}
