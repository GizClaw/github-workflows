import crypto from "node:crypto";

export const ISSUE_REVIEW_SCHEMA_VERSION = 4;
export const PREFIXED_TITLE = /^[a-z][a-z0-9_-]*(?:\/[a-z][a-z0-9_-]*)*: \S.*$/;

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function blocker(code, message) {
  return { source: "issue-format", code, message };
}

function normalizeIssueReferences(references, defaultRepository) {
  return [...new Map((Array.isArray(references) ? references : [])
    .map((reference) => ({
      repository: String(reference?.repository ?? defaultRepository),
      number: Number(reference?.number),
      state: String(reference?.state ?? "OPEN").toUpperCase(),
    }))
    .filter((reference) => (
      reference.repository
      && Number.isSafeInteger(reference.number)
    ))
    .map((reference) => [
      `${reference.repository.toLowerCase()}#${reference.number}`,
      reference,
    ])).values()].sort((left, right) => (
    left.repository.localeCompare(right.repository)
    || left.number - right.number
  ));
}

export function issueSnapshot(issue) {
  const repository = String(issue.repository ?? "");
  const rawSubIssues = Array.isArray(issue.sub_issues)
    ? issue.sub_issues
    : (issue.sub_issue_numbers ?? []).map((number) => ({
        repository,
        number,
        state: "OPEN",
      }));
  const subIssues = normalizeIssueReferences(rawSubIssues, repository);
  const blockedBy = normalizeIssueReferences(issue.blocked_by, repository);
  const blocking = normalizeIssueReferences(issue.blocking, repository);
  return {
    repository,
    number: Number(issue.number),
    title: String(issue.title ?? ""),
    body: String(issue.body ?? ""),
    body_truncated: issue.body_truncated === true,
    state: String(issue.state ?? "OPEN").toUpperCase(),
    issue_type: String(issue.issue_type ?? ""),
    parent_number: issue.parent_number == null ? null : Number(issue.parent_number),
    sub_issue_count: issue.sub_issue_count == null
      ? subIssues.length
      : Number(issue.sub_issue_count),
    sub_issue_numbers: subIssues.map((subIssue) => subIssue.number),
    sub_issues: subIssues,
    blocked_by_count: issue.blocked_by_count == null
      ? blockedBy.length
      : Number(issue.blocked_by_count),
    blocked_by: blockedBy,
    blocking_count: issue.blocking_count == null
      ? blocking.length
      : Number(issue.blocking_count),
    blocking,
  };
}

export function issueSnapshotSha256(issue) {
  return sha256(JSON.stringify(issueSnapshot(issue)));
}

export function analyzeIssue(issue) {
  const snapshot = issueSnapshot(issue);
  const blockers = [];
  if (snapshot.body_truncated) {
    blockers.push(blocker(
      "issue-body-truncated",
      "The workflow could not snapshot the complete Issue body and must fail closed.",
    ));
  }
  if (snapshot.sub_issue_count > snapshot.sub_issues.length) {
    blockers.push(blocker(
      "sub-issues-truncated",
      "The workflow could not snapshot every native sub-issue and must fail closed.",
    ));
  }
  if (snapshot.blocked_by_count > snapshot.blocked_by.length) {
    blockers.push(blocker(
      "blocked-by-truncated",
      "The workflow could not snapshot every native blocking prerequisite and must fail closed.",
    ));
  }
  if (snapshot.blocking_count > snapshot.blocking.length) {
    blockers.push(blocker(
      "blocking-truncated",
      "The workflow could not snapshot every natively blocked Issue and must fail closed.",
    ));
  }

  for (const check of issueRelationshipChecks(snapshot)) {
    if (check.status === "pass") continue;
    const declared = check.declared_parent_numbers
      .map((number) => `#${number}`)
      .join(", ");
    blockers.push(check.native_parent_number == null
      ? blocker(
          "parent-relationship-missing",
          `The Issue body declares parent ${declared}, but the Issue has no native parent.`,
        )
      : blocker(
          "parent-relationship-mismatch",
          `The Issue body declares parent ${declared}, but its native parent is #${check.native_parent_number}.`,
        ));
  }

  return {
    schema_version: ISSUE_REVIEW_SCHEMA_VERSION,
    snapshot,
    snapshot_sha256: issueSnapshotSha256(snapshot),
    deterministic_blockers: blockers,
  };
}

const PARENT_DECLARATION =
  /^[ \t]*[-*][ \t]+Parent:[ \t]*(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+))?#(\d+)\b/gim;

function declaredParents(snapshot) {
  // Fenced examples are documentation, not a relationship declaration.
  const body = snapshot.body.replace(/^[ \t]*(```|~~~)[\s\S]*?^[ \t]*\1[^\n]*$/gm, "");
  const numbers = new Set();
  for (const match of body.matchAll(PARENT_DECLARATION)) {
    if (
      match[1]
      && match[1].toLowerCase() !== snapshot.repository.toLowerCase()
    ) {
      continue;
    }
    numbers.add(Number(match[2]));
  }
  return [...numbers].sort((left, right) => left - right);
}

// Native relationship facts the reviewer must not reinterpret: a body
// `- Parent: #N` line is compared with GitHub's native parent here instead of
// being left to a model that may misread (or keep re-emitting) the metadata.
export function issueRelationshipChecks(issue) {
  const snapshot = issueSnapshot(issue);
  const declared = declaredParents(snapshot);
  if (declared.length === 0) return [];
  const status = declared.length === 1 && declared[0] === snapshot.parent_number
    ? "pass"
    : "fail";
  return [{
    check: "body-parent-matches-native-parent",
    status,
    declared_parent_numbers: declared,
    native_parent_number: snapshot.parent_number,
  }];
}
