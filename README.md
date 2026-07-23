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
`issues: write` for request reactions.

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
- Every published review reports the Codex review time and its total, input,
  cached-input, output, and reasoning-output token counts. Cached-input tokens
  are part of input tokens, and reasoning-output tokens are part of output
  tokens; neither is added to the total a second time.
- Fork PRs run through the caller repository's trusted default-branch
  `pull_request_target` workflow and use the caller's explicitly forwarded
  secret. Secrets from the contributor's fork are not imported or used.
- Opening an eligible PR intentionally permits an external contributor to
  consume one review request. Use a dedicated API project with appropriate
  usage limits and restrict the organization secret to selected repositories.
- Diffs larger than 1 MB fail before Codex runs, limiting untrusted input and
  avoiding unbounded model usage.
- The reviewer checks out only the trusted base commit, reads the PR diff as
  untrusted data, never checks out or executes PR-head code, and publishes
  validated native inline review comments only on added lines.

Use `pull_request_target` only with this trusted-base, diff-as-data design.
Never check out or execute the pull-request head or merge ref, do not use
`secrets: inherit`, and restrict the organization secret to the repositories
that should be allowed to review.
