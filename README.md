# GizClaw GitHub Workflows

This repository intentionally has two workflow files.

| File | Role |
| --- | --- |
| `.github/workflows/codex-openai-review.yml` | Reusable OpenAI PR reviewer for any repository. |
| `.github/workflows/openai-pr-review-dispatch.yml` | GizClaw's own trigger, and the complete copyable example for a consuming repository. |

The trigger file is the example. A consuming repository creates one workflow
with the same events, permissions, concurrency, and `review` job, then changes
only the `uses` reference from the local path to the protected release:

```yaml
uses: GizClaw/github-workflows/.github/workflows/codex-openai-review.yml@v1
```

It must pass an `OPENAI_API_KEY` Actions secret explicitly. Set `model`,
`effort`, and `review-instructions` in that one caller file to match the
repository's review policy. The caller must grant `checks: write` so the
shared reviewer can expose its lifecycle on the reviewed PR head, and
`issues: write` for request reactions. It must also grant `actions: write` so
the reviewer can restore the latest per-PR Codex session artifact and delete
superseded snapshots only after a replacement upload succeeds.

## Behavior

- Reviews an open, non-draft PR when it is first created, including a PR from
  an external fork. Later pushes do not start another review.
- A collaborator with `write`, `maintain`, or `admin` permission can request a
  fresh review of an internal or fork PR using `@codex` or
  `@codex review <focus>`.
- **Run workflow** accepts a pull-request number as a manual fallback.
- A new request for the same PR cancels the previous one. Request comments use
  `👀` while running, `🚀` when finished (including a failed attempt), and `😕`
  when superseded or cancelled.
- Every accepted review creates an `OpenAI PR review` Check Run on the exact PR
  head commit. The check links to its Actions run and reports running,
  successful, failed, or cancelled state in the PR Checks UI. Comment-triggered
  reviews continue to execute from the trusted default-branch workflow.
- A failed attempt publishes a titled PR comment with the specific failure
  reason and a link to the Actions run instead of leaving only a reaction.
- Every published review reports the Codex review time, input, cached-input,
  cache-write, output, reasoning-output, and total token counts, plus the cache
  hit ratio. The report includes the stable PR session key, content-addressed
  generation key, reviewed commit range, deterministic diff chunk count, and
  per-chunk/aggregation usage. Cached-input tokens are part of input tokens,
  and reasoning-output tokens are part of output tokens; neither is added to
  the total a second time.
- Each PR has one logical Codex session. Its 30-day Artifact v2 snapshot stores
  the validated Codex rollout plus a generation ledger containing the
  last fully reviewed head, any in-progress target, the canonical file listing,
  chunk hashes, completed chunk results, and usage. The next review resumes the
  session and reviews only `last_completed_head..current_head` when the commit
  chain and base still match. Force-pushes, incompatible base updates, corrupt
  state, and policy changes safely fall back to a complete review.
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
- Opening an eligible PR intentionally permits an external contributor to
  consume one review request. Use a dedicated API project with appropriate
  usage limits and restrict the organization secret to selected repositories.
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
