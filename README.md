# GizClaw GitHub Workflows

This repository provides a pull-request review workflow with optional Issue
linkage and a complete copyable caller.

| File | Role |
| --- | --- |
| `.github/workflows/codex-openai-review.yml` | Reusable OpenAI PR reviewer for any repository. |
| `.github/workflows/openai-pr-review-dispatch.yml` | GizClaw's trusted PR trigger and copyable caller. |

The trigger file is the example. A consuming repository creates one workflow
with the same events, permissions, concurrency, and `review` job, then changes
only the `uses` reference from the local path to the protected release:

```yaml
uses: GizClaw/github-workflows/.github/workflows/codex-openai-review.yml@latest
```

It must pass an `OPENAI_API_KEY` Actions secret explicitly. Set
`review-instructions`, `issue-review-instructions`, and
`pr-readiness-instructions` in the caller to match the repository's trusted
policy. The shared reviewer always uses `gpt-6.1-sol` with Light (`low`) reasoning
effort and accepts complete diffs up to 100,000,000 bytes. The legacy `model`,
`effort`, and `max-diff-bytes` inputs remain accepted for pinned callers but are
ignored. Existing callers must update their pinned workflow reference to receive
this policy; they can then remove those three inputs. Codex CLI defaults to the
pinned version `0.163.0`.
The caller must grant `checks: write` so the shared reviewer can expose its
lifecycle on the reviewed PR head, and
`pull-requests: write` for request reactions on PR comments and native review
publication. It must also grant `issues: write` for Issue-triggered refreshes
and `actions: write` for the trusted default-branch dispatcher.

In public caller repositories, complete binary-aware Git patches up to
5,000,000 bytes are reviewed automatically. Binary models, images, and other
changed binary payloads count toward this limit even though their contents are
not sent to the model. For a larger public-repository diff, an admin of the
**calling repository** must post this line as a PR comment with the current
full head commit SHA:

```text
@codex review approve <40-character-head-sha>
```

The shared reviewer checks the comment author's admin permission in the caller
repository and the live head SHA before model work. A push requires a new
approval. This uses the existing `issue_comment` trigger and works for public
callers without a GitHub Environment or per-repository approver configuration.
Private caller repositories skip the 5,000,000-byte approval gate and review
automatically. The caller's base repository privacy comes from GitHub's PR API;
unknown privacy is treated as public. Diffs above 100,000,000 bytes remain
rejected in every repository.

## Behavior

- Requests review of an open, non-draft PR when it is opened, reopened, edited,
  marked ready, or receives a new head through `synchronize`. For a fork PR,
  GitHub may omit its source-run association; in that case the automatic worker
  skips safely and a new `@codex review` PR comment is the manual fallback.
- Recalculates open PRs in the caller repository that GitHub lists as closing
  an Issue when that Issue is edited, reopened, typed, or untyped. References to
  PRs in other repositories are not interpreted as local PR numbers. A PR GitHub
  has not linked is refreshed by its next event or an `@codex review` comment.
- A commenter can request a fresh review of an internal or fork PR by putting
  `@codex` or `@codex review <focus>` on its own line anywhere in a PR comment,
  so a comment that explains the push and ends with the request is accepted.
  The whole line must be the request: a mention inside a sentence, an
  unrecognized word after `@codex`, or a mention inside a fenced code block,
  an inline code span (including one that crosses line breaks), an indented
  code block, or a block quote does not start a review, and neither does a
  comment authored by an app. Apply repository and
  API-project usage limits appropriate for a public trigger.
- **Run workflow** accepts a pull-request number as a manual fallback.
- The updated caller serializes requests for the same PR with
  [`queue: max`](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
  and `cancel-in-progress: false`. GitHub retains up to 100 pending requests;
  unlike the default single-pending-slot behavior, a delayed automatic request
  cannot evict a pending or running approval. Direct review requests and
  linked-Issue refreshes share a job-level lock for each PR. Workers run in
  queue-arrival order, which is not necessarily original event order: a delayed
  Issue refresh may replace an earlier approval's final checks. Older callers
  need to migrate their concurrency configuration. Request comments use `👀`
  while running, `🚀` when finished
  (including a failed attempt), and `😕` when superseded or cancelled.
- Actions workflow reruns are rejected before review work starts because a
  rerun reuses an old event while resolving the PR's current head. Push a new
  commit, post a new
  `@codex review` comment, or dispatch a new workflow run instead.
- Every accepted review creates three fixed Check Runs on the exact PR head:
  `OpenAI PR Review`, `OpenAI Issue Review`, and `OpenAI Code Review`. Each
  reports its own running, successful, failed, or cancelled state, while one
  native `OpenAI PR Review` report contains the combined conclusion. Its
  default view keeps the PR-format, Issue-design, and code/plan-conformance
  verdicts visible alongside the reviewed scope and aggregate usage.
- The copyable caller's `pull_request_target` job only dispatches the same
  workflow on the repository's trusted default branch, passing the PR number
  and original dispatcher run ID. The default-branch worker and comment
  retries share a worker queue; the dispatcher has a separate queue. No PR-head
  code or branch name is used to run the worker. Draft, closed, and stale-head
  events are skipped. A failed dispatch remains visible instead of being
  reported as a successful review.
- Once an automatic worker acquires its queue slot, the reusable resolver
  verifies the source run's repository-local workflow identity, immutable
  `head_sha`, PR association, first attempt and creation time. The association's
  nested head can change after pushes and is not used as original-head evidence.
  It reads all newer review-request comments
  using the existing parser, without accepting quoted text or bot messages. A
  newer (or same-second) review comment fences the old automatic worker before
  it creates checks or touches review checkpoints. The boundary is the original
  dispatcher's timestamp, not its delayed child's arrival. If an approval
  arrives after this check, the queue retains it and runs it after the current
  worker. Approval is never copied into the automatic request: the original
  comment resolver still verifies admin permission and exact-head approval.
  Source lookup or comment pagination errors fail closed.
- Only the three explicit OpenAI checks carry the review verdict on the PR
  head. Native worker jobs belong to default-branch executions, including
  failures and cancellations, so a later successful comment retry can replace
  the verdict without leaving an obsolete native review failure on the PR.
  Configure these three checks as merge requirements, not native worker jobs.
  This requires copying the updated caller into the consuming repository's
  default branch; updating `latest` alone cannot change a caller's triggers
  or concurrency. Publish the shared resolver's `dispatch_source_run_id`
  support to `latest` before migrating consumer callers to pass that new input.
  Existing callers can retain their repository-specific policy.
- Older direct callers may already have a failed native `review / review`
  beside three passing OpenAI checks. GitHub prohibits changing native Actions
  status/conclusion through the Checks API. Refresh those legacy native checks
  with a new PR event (for example, a substantive metadata update or push), and
  let it finish without also posting a concurrent comment retry. Do not erase
  failures, mark them successful through custom checks, or rerun old workflow
  attempts. The dispatcher migration prevents new worker failures from being
  attached to the PR head; it does not rewrite execution history.
- `OpenAI PR Review` checks the title, body, and closing-Issue linkage. The
  closing Issues are the ones the PR body names with a closing keyword.
  When a closing Issue has open native sub-issues, every open child must also
  be in the PR's closing-Issue set. The rule applies recursively because
  each included child is checked in turn; already-closed children are ignored.
  `OpenAI Issue Review` checks every linked Issue independently and aggregates
  their trusted-base project-policy, repository-fit, and
  implementation-readiness verdict. It reads the project's root and applicable
  nested `AGENTS.md` files, follows the Issue-review and module documents they
  require, and applies that repository-owned contract without modifying the
  Issue or inventing missing decisions. `OpenAI Code Review`
  checks only code findings and Issue-plan conformance. Closing Issues are
  optional: without them, Issue review passes without a model turn and code
  review checks the PR without requiring an Issue plan. Configure all three
  names as required checks when every stage must block merging.
- Code review also reads the recent PR discussion: the last 20 comments, each
  clipped to 2,000 characters, with the triggering comment kept to 8,000,
  marked, and restored if newer comments crowd it out of that window. It supplies author-stated intent, validation claims, disclosures, and
  any focus given in the `@codex review` comment. Comments are untrusted data
  written by any commenter: they never relax the trusted caller review profile,
  every claim must be checked against the diff, and a claim the diff
  contradicts is reported. Each request collects the current discussion. It is
  supplied whenever a code turn runs; an unchanged head can reuse completed
  evidence without a new model turn.
- An execution failure publishes a titled PR comment with the specific failure
  reason and a link to the Actions run instead of leaving only a reaction.
- Every published review reports the Codex review time, input, cached-input,
  cache-write, output, reasoning-output, and total token counts, plus the cache
  hit ratio. It also reports estimated Codex credits using the current public
  per-million-token model rate card: uncached input uses the input rate,
  cached input uses the cached-input rate, and output (including reasoning)
  uses the output rate. This is a token-derived estimate, not an API billing
  ledger value. Folded report sections retain the stable PR session key,
  content-addressed generation key, reviewed commit range, deterministic diff
  chunk count, and per-stage usage, including a separate row for each linked
  Issue. Deterministic rows consume zero model tokens. Cached-input tokens are
  part of input tokens, and reasoning-output tokens are part of output tokens;
  neither is added to the total a second time.
- Each PR resumes its previous authenticated Artifact v2 snapshot when compatible.
  It restores the primary Codex rollout and review ledger, including completed
  chunks, stage evidence, and the last fully reviewed head. A descendant push
  reviews only `last_completed_head..current_head` while the merge base and LFS
  context remain compatible. Unchanged stages reuse their completed evidence;
  metadata edits revalidate the affected stages. An unchanged request can use
  zero model tokens. Incomplete work resumes its unfinished chunks without
  advancing the last fully reviewed head.
- Model sessions are bound to their trusted base commit. A changed trusted base
  starts a fresh model conversation while retaining valid deterministic review
  checkpoints. Each model turn receives the current base explicitly, and the
  runner checks that its Git object is available first.
- A new conversation starts with native `codex review`, scoped to the first
  prepared code diff chunk. It receives the collected PR body and discussion as
  untrusted background. Supplied binary evidence must match the exact object
  hashes in the diff. PR and Issue checks, remaining chunks, and aggregation
  continue with `codex exec resume`. Later compatible runs resume that same
  primary session instead of starting native review again. Aggregation checks
  the native chunk against the reviewed Issue plans before the final verdict.
  Diff chunks define the changes under review; the reviewer can read related
  complete files and code context from the trusted checkout when needed. The
  exact reusable workflow executing the review is also available as read-only
  implementation context; a ref proposed in the PR may point elsewhere.
- Snapshots expire after 30 days. Missing, expired, unsigned, tampered, or
  incompatible snapshots start a full review. A force-push that breaks ancestry
  or a moved merge base also starts a full code diff. Older unsigned snapshots
  require one full review to establish an authenticated snapshot.
- The reviewer fetches PR Git objects without checking out or executing the PR
  head and computes the complete diff locally, avoiding GitHub's 20,000-line
  PR-diff API limit. Files use stable byte-order listing. Diffs too large for
  one model turn are split deterministically at file and hunk boundaries and
  reviewed sequentially in the same session. The final review is published
  only after every chunk and aggregation turn completes.
- Binary files in the diff have their before/after Git blobs exported as
  read-only evidence before the PR object database is removed. The canonical
  listing records Git blob IDs, SHA-256, size and content-addressed paths;
  native and resumed code-review turns receive that listing. Blob bytes are
  verified on export and before review, and never become executable policy.
  Evidence is limited to 32 MiB per blob and 128 MiB of unique blobs per
  generation. The regression tests are `node .github/scripts/pr-review/binary-test.mjs`
  and `node .github/scripts/pr-review/test.mjs`.
- Every model turn reports an execution status separately from findings and
  policy blockers. Native review requires a structured completion event and an
  explicit `COMPLETED:` explanation; `INCOMPLETE:` or malformed output fails
  closed. Resumed turns use the existing `execution.status` JSON field.
  Required input paths are checked for readability before the
  turn, and the reviewer is instructed to read these explicit inputs even when
  they live outside its working directory. An incomplete or missing execution
  status fails the run without publishing a final verdict; a new request can
  resume authenticated completed checkpoints and retry unfinished work. The
  read-only permissions and network restrictions remain.
- Artifact names and manifest bytes are authenticated with domain-separated
  HMAC-SHA256 using the explicitly forwarded `OPENAI_API_KEY`; no additional
  caller secret or permissions are required. The manifest binds the repository,
  PR, source run, primary session, runtime, review instructions, and SHA-256
  hashes of the rollout and full state tree. Names are authenticated before
  selecting the newest snapshot for this PR, and the manifest and contents are
  verified before anything is restored. A newer artifact from an unrelated job
  without that secret cannot forge a snapshot or shadow an older valid one.
  Changing the API key, model, effort, CLI version, or review instructions starts
  a new snapshot chain. A reviewer-source-only update does not invalidate it.
- GitHub's artifact metadata alone does not prove which job uploaded a snapshot.
  Only trusted reviewer steps may receive the forwarded secret; any job with
  access to that secret is inside the snapshot trust boundary. Use an isolated
  caller in which no sibling job executes untrusted PR code, and migrate older
  callers to the trusted default-branch dispatcher below. Legacy unsigned
  snapshots are never restored. Concurrent snapshots are not deleted; they
  remain until expiry.
- Fork PR reviews run through the caller repository's trusted default-branch
  worker and use the caller's explicitly forwarded secret. Secrets from the
  contributor's fork are not imported or used. Automatic dispatch requires
  GitHub to associate the source run with the PR; if it does not, request a
  review using a PR comment instead.
- Automatic PR events can permit an external contributor to consume review
  requests up to the 5,000,000-byte automatic limit in public callers. Use a
  dedicated API project with appropriate usage limits and restrict the
  organization secret to selected repositories.
- Complete diffs larger than 100,000,000 bytes fail before Codex runs. The
  `chunk-target-bytes` input still controls deterministic chunk sizing; the
  legacy `max-diff-bytes` input no longer changes the total limit.
- The reviewer checks out only the trusted base commit, reads the PR diff as
  untrusted data, never checks out or executes PR-head code, and publishes
  validated native inline review comments only on added lines.

Use `pull_request_target` only with this trusted-base, diff-as-data design.
Never check out or execute the pull-request head or merge ref, do not use
`secrets: inherit`, and restrict the organization secret to the repositories
that should be allowed to review.

## PR readiness contract

The default Issue contract comes from the consuming project's trusted
default-branch `AGENTS.md` hierarchy and the Issue-review documents it
designates. The workflow itself enforces only cross-project integrity and PR
linkage requirements:

- PR titles use lowercase `prefix: Subject` form. Each slash-separated prefix
  segment starts with a lowercase letter and may then contain lowercase letters,
  digits, hyphens, or underscores.
- The PR body describes the delivered result and validation.
- Closing Issues are optional. When supplied, the PR body identifies them with
  a closing keyword:
  `close`, `closes`, `closed`, `fix`, `fixes`, `fixed`, `resolve`, `resolves`,
  or `resolved` (any case, optional colon) followed on the same line by `#N`,
  `owner/repo#N`, or an Issue URL, for example `Closes #123`. The body is the
  only source: GitHub's Development links and `closingIssuesReferences` are not
  consulted, so linkage does not depend on GitHub having indexed the keyword.
  References inside fenced, inline, or indented code, block quotes, or HTML
  comments declare nothing, a plain mention such as `Related to #123` does not
  count, and a reference that is not a readable Issue (a pull request, a
  missing number, an inaccessible repository) is ignored.
- Issue and sub-issue snapshots must be complete.
- When an Issue body declares `- Parent: #N` (or `owner/repo#N` for the same
  repository), GitHub's native parent must be that Issue. This is checked
  deterministically, never left to the model.
- When closing Issues are supplied, the complete PR result follows their current
  plans. Material deviations must be reflected in the Issue or disclosed and
  resolved in the PR.

Review threads are collected across all GraphQL pages before counting unresolved
actionable findings. A failed page request or a missing or repeated continuation
cursor fails context collection closed; having more than 100 historical threads
alone is not a readiness blocker.
Completed reviews are published using the context collected for that run. Changes
to PR metadata, closing-Issue linkage, Issue plans or relationships, review
threads, or the base branch during review do not block publication. The report
remains attached to the reviewed head commit; publication still rejects a changed
PR head so results are not presented as covering unreviewed code. A subsequent
review request collects the updated context.

The reviewer reads every Issue the body closes, up to 100 distinct references,
in one GraphQL request. It fails closed when the body names more, rather than
silently reviewing a truncated relationship set, and when that request fails
for any reason other than an unreadable reference. Native sub-issue snapshots
use a 100-node fail-closed bound.
Each linked Issue also preserves its native `blockedBy` and `blocking`
relationships, including repository, Issue number, and state. Both dependency
directions use the same deterministic normalization and 100-node fail-closed
bound, and their normalized state is part of the Issue and readiness hashes.

Caller policy can add trusted organization-level constraints. Repository-owned
title formats, Issue Types, sections, relationships, ownership rules,
validation commands, platform requirements, and finding severity rules belong
in trusted default-branch `AGENTS.md` instructions or documents they require,
never in untrusted PR code.

Readiness evidence records the reusable-workflow source for audit and binds the
base/head revision, normalized PR metadata, closing-Issue snapshots, trusted
policy, model, and effort. Final readiness is regenerated for the current head
using compatible stage evidence from the restored snapshot. A reviewer revision
alone does not discard compatible session state.

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
not use `secrets: inherit`. Issue events resolve the PRs GitHub lists as closing
the Issue and invoke
the same reusable PR reviewer; there is no separate Issue-review dispatcher or
second workflow.

## Rollout

Callers that need LFS-backed review context can set `lfs-context-paths` to
comma-separated repository-relative globs, for example
`terraform/**/terraform.tfstate`. It is disabled by default. Before the offline
review, the trusted runner fetches matching base/head objects from the caller's
GitHub LFS endpoint, verifies their exact pointer size and SHA256, hydrates base
files, and supplies separate before/after data for the actual review range,
including the previous reviewed head during incremental review.
It never checks out or runs
the PR head. Acquisition fails closed above 64 MiB per object, 512 MiB total,
or 1024 distinct objects; raw payloads and credentials are not printed.

The native-session smoke test runs the real pinned CLI against a local
Responses API fixture and restores only the primary rollout before resuming.
It does not call the OpenAI API:

```sh
npm exec --yes --package=@openai/codex@0.163.0 -- node .github/scripts/pr-review/native-session-test.mjs
```

### Native review acceptance

Use one ready PR and two descendant documentation commits against the same
trusted base. The first request starts native review and uploads an authenticated
snapshot. The second downloads the previous snapshot for that same PR, preserves
its primary session ID, and uses only `codex exec resume` for the incremental
range from the first fully reviewed head to the new head. Confirm unchanged PR
and Issue stages reuse evidence, every pending chunk and aggregation completes,
and all three fixed Checks are attached to the new head. A subsequent unchanged
request should reuse completed evidence with zero model tokens. Old snapshots
remain available until expiry.

### Live validation matrix

Use this matrix after the caller is present on the repository's default branch.
`issues` requests revalidate the linked PRs they resolve.

| Trigger | Expected review |
| --- | --- |
| First ready PR request | Full PR, linked-Issue, and code review |
| First request without closing Issues | Full PR and code review; Issue review passes without a model turn |
| Edit the PR body | Revalidate changed metadata; reuse compatible Issue and code evidence |
| Edit a linked Issue | Revalidate that Issue and code-plan conformance; reuse unchanged code diff |
| Push a compatible descendant commit | Incremental code review from the last fully reviewed head |
| Merge a moved base or break reviewed-head ancestry | Full code diff from the new merge base |
| Post a new request on an unchanged head | Reuse compatible completed evidence with zero model tokens |
| Missing or incompatible snapshot | Full review, then upload a new authenticated snapshot |

A full code diff starts at the merge base between the live base branch tip and
the PR head, matching the PR's own "Files changed" view. An incremental diff
starts at the last fully reviewed head when ancestry, merge base, and LFS context
still match. `pull_request.base.sha` is used to check out trusted reviewer code,
not to decide what counts as a PR change. Each Issue-stage turn receives the
current native Issue Type, state, parent, sub-issues, dependencies and
deterministic relationship checks.

When editing PR metadata, preserve the closing keywords in the body.
Removing or changing a closing reference changes the plans considered by the
next affected-stage review.

1. Copy `openai-pr-review-dispatch.yml` into the caller repository's default
   branch.
2. Replace local reusable-workflow paths with the protected `latest` reference.
3. Configure trusted repository-specific review instructions.
4. Store `OPENAI_API_KEY` in an allowlisted organization or repository secret
   and forward it explicitly.
5. Open test PRs with and without closing Issues. For the linked case, use an
   implementation-ready Issue. Confirm all three fixed OpenAI Checks are
   attached to each exact head and the unlinked PR does not fail for missing
   Issues.
6. Push a descendant commit and confirm the new run downloads the same PR's
   previous authenticated snapshot and reviews only the new code range with
   `codex exec resume`, preserving the session ID and prior applicable findings.
7. Test invalid PR metadata, an incomplete Issue, an unexplained plan
   deviation, and an actionable code finding.
8. Edit one linked Issue and confirm only that Issue and code-plan conformance
   are revalidated while compatible code evidence is retained.
9. Only after live tests pass, configure all three fixed Check names as required
   status checks in the caller repository ruleset.
