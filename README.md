# GizClaw GitHub Workflows

Reusable GitHub Actions workflows for GizClaw projects.

## OpenAI PR review

`.github/workflows/codex-openai-review.yml` is a reusable workflow that reviews
an internal pull request with the OpenAI API through
[`openai/codex-action`](https://github.com/openai/codex-action). It runs Codex
in a read-only sandbox and posts one structured result to the pull request. A
new run updates that result instead of adding another bot comment.

The workflow has no write path to the pull-request checkout: the review job has
only `contents: read`, while a separate publication job has only the
`pull-requests: write` permission needed to update the review comment.

### Caller workflow

Participating repositories add a thin wrapper such as:

```yaml
name: OpenAI PR review

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read
  pull-requests: write

jobs:
  openai-review:
    if: >-
      github.event.pull_request.draft == false &&
      github.event.pull_request.head.repo.fork == false
    uses: GizClaw/github-workflows/.github/workflows/codex-openai-review.yml@v1
    with:
      model: gpt-5.6-terra
      review-instructions: >-
        Review only the pull-request diff and report actionable findings.
    secrets:
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

The caller must pass `OPENAI_API_KEY` by name. Do not use `secrets: inherit`.
The reusable workflow defaults `model` to `gpt-5.6-terra`; callers may select
another supported OpenAI model deliberately. Keep the selected model in the
wrapper so that a model change is reviewed as configuration.

This repository includes `.github/workflows/openai-pr-review.yml` as its own
internal caller and smoke-test wrapper. It intentionally calls the local
reusable workflow so that a pull request can review the workflow revision it
introduces. Other repositories should call the protected `@v1` reference shown
above.

### Security and rollout

- Store the API key as an organization secret restricted to an explicit
  allowlist of participating repositories. Use a dedicated OpenAI API project
  with its own spending controls.
- Forked pull requests are skipped. Do not substitute `pull_request_target` or
  execute pull-request code with credentials to review forks.
- The workflow uses `sandbox: read-only` together with
  `safety-strategy: drop-sudo`; read-only filesystem access alone is not a
  secret-protection boundary on GitHub-hosted runners.
- Call the shared workflow through the protected `v1` release reference. Move
  `v1` only after the new workflow revision has been validated.

### Inputs and output

| Input | Default | Purpose |
| --- | --- | --- |
| `model` | `gpt-5.6-terra` | OpenAI model supplied to Codex for the review. |
| `review-instructions` | Diff-only actionable-review profile | Additional caller-owned review guidance. |

The reusable workflow exposes a `review` output containing the structured JSON
result. Its pull-request comment contains a summary and only actionable
findings, each with priority, path, and line.

### Operational limits

The first release neither pushes commits nor approves, merges, or otherwise
changes a pull-request branch. It does not replace an existing CI or official
Codex automatic-review configuration. Enable it in one internal repository at
a time to avoid duplicate reviews.
