# GizClaw GitHub Workflows

This repository provides an Issue-led pull-request review workflow and a
complete copyable caller.

| File | Role |
| --- | --- |
| `.github/workflows/codex-openai-review.yml` | Reusable OpenAI PR reviewer for any repository. |
| `.github/workflows/openai-pr-review-dispatch.yml` | GizClaw's trusted PR trigger and copyable caller. |

The trigger file is the example. A consuming repository creates one workflow
with the same events, permissions, concurrency, and `review` job, then changes
only the `uses` reference from the local path to the protected release:

```yaml
uses: GizClaw/github-workflows/.github/workflows/codex-openai-review.yml@v1
```

It must pass an `OPENAI_API_KEY` Actions secret explicitly. Set `model`,
`effort`, `review-instructions`, `issue-review-instructions`, and
`pr-readiness-instructions` in the caller to match the repository's trusted
policy. The caller must grant `checks: write` so the
shared reviewer can expose its lifecycle on the reviewed PR head, and
`issues: write` for request reactions. It must also grant `actions: write` so
the reviewer can restore the latest per-PR Codex session artifact and delete
superseded snapshots only after a replacement upload succeeds.

## Behavior

- Reviews an open, non-draft PR when it is opened, reopened, edited, marked
  ready, or receives a new head through `synchronize`, including a PR from an
  external fork.
- Recalculates open PRs that natively close an Issue when that Issue is edited,
  reopened, typed, or untyped, using the same caller and reusable PR reviewer.
- A commenter can request a fresh review of an internal or fork PR using
  `@codex` or `@codex review <focus>`. Apply repository and API-project usage
  limits appropriate for a public trigger.
- **Run workflow** accepts a pull-request number as a manual fallback.
- A new request for the same PR cancels the previous one. Request comments use
  `👀` while running, `🚀` when finished (including a failed attempt), and `😕`
  when superseded or cancelled.
- Every accepted review creates three fixed Check Runs on the exact PR head:
  `OpenAI PR Review`, `OpenAI Issue Review`, and `OpenAI Code Review`. Each
  reports its own running, successful, failed, or cancelled state, while one
  native `## 🤖 OpenAI PR review` report contains the combined evidence.
- `OpenAI PR Review` checks the title, body, and native closing-Issue linkage.
  `OpenAI Issue Review` checks every linked Issue independently and aggregates
  their format and design verdict. `OpenAI Code Review` checks only code
  findings and Issue-plan conformance. Configure all three names as required
  checks when every stage must block merging.
- An execution failure publishes a titled PR comment with the specific failure
  reason and a link to the Actions run instead of leaving only a reaction.
- Every published review reports the Codex review time, input, cached-input,
  cache-write, output, reasoning-output, and total token counts, plus the cache
  hit ratio. It also reports estimated Codex credits using the current public
  per-million-token model rate card: uncached input uses the input rate,
  cached input uses the cached-input rate, and output (including reasoning)
  uses the output rate. This is a token-derived estimate, not an API billing
  ledger value. The report includes the stable PR session key, content-addressed
  generation key, reviewed commit range, deterministic diff chunk count, and
  per-stage usage. The stage table identifies full, incremental, reused, and
  deterministic work, including a separate row for every linked Issue.
  Reused and deterministic rows consume zero model tokens. Cached-input tokens
  are part of input tokens, and reasoning-output tokens are part of output
  tokens; neither is added to the total a second time.
- Each PR has one logical Codex session. Its 30-day Artifact v2 snapshot stores
  the validated Codex rollout plus a generation ledger containing the
  last fully reviewed head, any in-progress target, the canonical file listing,
  chunk hashes, completed chunk results, stage evidence, and usage. PR metadata,
  every linked Issue, and code have independent content-addressed identities.
  An unchanged stage reuses validated evidence with zero model tokens; an
  edited PR or Issue sends only its field-level snapshot diff plus previous
  evidence; a new code head sends only
  `last_completed_head..current_head` when ancestry and base still match.
  Force-pushes, incompatible base updates, missing sessions, corrupt state,
  and relevant policy changes safely fall back to a complete stage review.
- The reviewer fetches PR Git objects without checking out or executing the PR
  head and computes the complete diff locally, avoiding GitHub's 20,000-line
  PR-diff API limit. Files use stable byte-order listing. Diffs too large for
  one model turn are split deterministically at file and hunk boundaries and
  reviewed sequentially in the same session. The final review is published
  only after every chunk and aggregation turn completes.
- Failed chunk reviews checkpoint completed work in the replacement Artifact,
  but do not advance `last_completed_head`. A retry resumes the first unfinished
  chunk. Older snapshots are deleted only after the replacement upload
  succeeds. A missing, expired, corrupt, or incompatible snapshot safely starts
  a new session.
- Fork PRs run through the caller repository's trusted default-branch
  `pull_request_target` workflow and use the caller's explicitly forwarded
  secret. Secrets from the contributor's fork are not imported or used.
- Automatic PR events intentionally permit an external contributor to consume
  review requests when opening, editing, or pushing to an eligible PR. Use a
  dedicated API project with appropriate usage limits and restrict the
  organization secret to selected repositories.
- Complete diffs larger than 1 MB fail before Codex runs by default, limiting
  untrusted input and avoiding unbounded model usage. Callers can explicitly
  set `max-diff-bytes` and `chunk-target-bytes` when their cost policy permits
  larger reviews.
- The reviewer checks out only the trusted base commit, reads the PR diff as
  untrusted data, never checks out or executes PR-head code, and publishes
  validated native inline review comments only on added lines.

Use `pull_request_target` only with this trusted-base, diff-as-data design.
Never check out or execute the pull-request head or merge ref, do not use
`secrets: inherit`, and restrict the organization secret to the repositories
that should be allowed to review.

## Issue-led readiness contract

The default contract implements the same core rules as `write-issue`:

- PR and Issue titles use lowercase `prefix: Subject` form.
- The PR body describes the delivered result and validation.
- The PR has at least one same-repository native closing Issue from GraphQL
  `closingIssuesReferences`; text-only references do not count.
- A PR closes a concrete implementation Issue rather than only a `Task`
  tracking container.
- Implementation Issues contain exactly `Background`, `Goal`,
  `Code Changes Tree`, `Design`, and `Test And Acceptance Criteria` as ordered
  top-level sections.
- Issue relationships use Markdown-list form, planned paths fit the trusted
  repository layout, the design is concrete, and acceptance criteria are
  observable.
- The complete PR result follows the current Issue plan. Material deviations
  must be reflected in the Issue or disclosed and resolved in the PR.

Caller policy can add required sections, allowed prefixes or Issue Types,
ownership rules, validation commands, platform requirements, and finding
severity rules. Repository-specific policy belongs in trusted default-branch
instructions such as `AGENTS.md`, never in untrusted PR code.

Readiness evidence binds the base/head revision, normalized PR metadata,
native Issue snapshots, trusted policy, reusable-workflow source, model, and
effort. Final readiness is always regenerated for the current head. Within
that run, only the affected content-addressed PR, Issue, or code stage is
invalidated.

Success from all three OpenAI checks means only that the configured automated
blockers were absent. It is not an approval and does not replace human review,
hardware or product acceptance, or deployment approval.

## Trusted caller triggers

The copyable PR caller uses:

```yaml
on:
  pull_request_target:
    types: [opened, reopened, synchronize, edited, ready_for_review]
  issue_comment:
    types: [created]
  issues:
    types: [edited, reopened, typed, untyped]
  workflow_dispatch:
```

The caller passes `OPENAI_API_KEY` explicitly and uses per-PR concurrency. Do
not use `secrets: inherit`. Issue events resolve native closing PRs and invoke
the same reusable PR reviewer; there is no separate Issue-review dispatcher or
second workflow.

## Rollout

### Live validation matrix

Use this matrix after the caller is present on the repository's default branch.
Every run recreates the three fixed Checks on the exact current PR head; the
stage modes below describe model work and evidence reuse inside that run.

| Trigger | PR evidence | Issue evidence | Code evidence | Expected Check publication |
| --- | --- | --- | --- | --- |
| Open a ready PR | `full` | `full` for every linked Issue | `full` complete diff | All three fixed Checks |
| Edit only the PR body | `incremental` field diff | `reused` | `reused` | All three, with only PR metadata re-reviewed |
| Edit one linked Issue | `reused` | `incremental` for that Issue; others `reused` | `incremental` plan-conformance aggregation with no repeated complete code diff | All three, with Issue and Code verdicts revalidated |
| Push a descendant commit | `reused` | `reused` | `incremental` from the last completed head | All three on the new head |
| Rerun an unchanged head | deterministic checks plus `reused` | `reused` | `reused` | All three with zero model tokens |

An Issue edit revalidates plan conformance without resending an unchanged
complete code diff. A workflow-source, runtime, model, or trusted-policy change
intentionally invalidates incompatible session evidence and safely starts the
affected review stages again.

When editing PR metadata, preserve the native closing-Issue relationship.
Removing or changing that relationship changes the plan-conformance identity
and intentionally invalidates the affected Code evidence.

1. Copy `openai-pr-review-dispatch.yml` into the caller repository's default
   branch.
2. Replace local reusable-workflow paths with a protected `v1` reference or an
   immutable commit SHA.
3. Configure trusted repository-specific review instructions.
4. Store `OPENAI_API_KEY` in an allowlisted organization or repository secret
   and forward it explicitly.
5. Open a test PR that natively closes an implementation-ready Issue and
   confirm all three fixed OpenAI Checks are attached to the exact head.
6. Push a new commit and confirm code is reviewed incrementally while unchanged
   PR and Issue evidence is reused with zero model tokens.
7. Test invalid PR metadata, an incomplete Issue, an unexplained plan
   deviation, and an actionable code finding.
8. Edit one linked Issue and confirm only that Issue stage runs incrementally.
9. Only after live tests pass, configure all three fixed Check names as required
   status checks in the caller repository ruleset.
