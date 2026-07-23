# GizClaw GitHub Workflows

Reusable GitHub Actions workflows for GizClaw projects.

## OpenAI PR review

`.github/workflows/codex-openai-review.yml` is a reusable workflow that reviews
an internal pull request with the OpenAI API through
[`openai/codex-action`](https://github.com/openai/codex-action). It runs Codex
in a read-only sandbox and publishes a native GitHub pull-request review. A
finding on an added diff line becomes a resolvable inline comment; a finding
without a safe location remains in the review summary.

The workflow has no write path to the pull-request checkout: the review job has
only `contents: read` and `pull-requests: read` to fetch the diff, while a
separate publication job has only the `pull-requests: write` permission needed
to publish the review.

### Review triggers

The built-in caller provides the review behavior expected from a PR-review
service:

- automatic review on an internal PR opening, update, reopen, or draft-to-ready;
- a collaborator with `write`, `maintain`, or `admin` permission can comment
  `@codex` or `@codex review` to request another review;
- an operator can use **Run workflow** with a pull-request number as a safe
  fallback;
- fork PRs and drafts are skipped.

Every accepted manual-request comment acts as its own status record without
adding timeline noise: `👀` means accepted/running, `🚀` means the review
completed, `👎` means it failed, and `😕` means a newer request for the same PR
superseded it. At startup, the reusable review job records both the trigger
comment ID and the `👀` reaction ID returned by GitHub. That same job runs its
`always()` teardown step with the same job token, removes exactly that
reaction, and applies the terminal status, including `😕` for a concurrency
cancellation. The repository-scoped `GITHUB_TOKEN` performs these reactions
with the workflow's `issues: write` permission. Only the newest manual request
runs at a time.

The PR event is deliberately an unprivileged signal with no secret:

```yaml
name: OpenAI PR review request

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read

jobs:
  signal:
    if: github.event.pull_request.draft == false
    runs-on: ubuntu-latest
    steps:
      - run: echo "OpenAI review requested"
```

The `workflow_run` dispatcher exists on the protected default branch. It
resolves the open, non-fork pull request through GitHub's API before passing
its number and commit SHAs to the shared review workflow. This prevents a PR
from changing the job that receives the API key.

```yaml
name: OpenAI PR review

on:
  workflow_run:
    workflows: [OpenAI PR review request]
    types: [completed]

permissions:
  contents: read
  pull-requests: write

jobs:
  resolve-pr:
    if: >-
      github.event.workflow_run.event == 'pull_request' &&
      github.event.workflow_run.conclusion == 'success'
    runs-on: ubuntu-latest
    outputs:
      number: ${{ steps.pr.outputs.number }}
      base_sha: ${{ steps.pr.outputs.base_sha }}
      head_sha: ${{ steps.pr.outputs.head_sha }}
    steps:
      - id: pr
        uses: actions/github-script@ed597411d8f924073f98dfc5c65a23a2325f34cd # v8
        with:
          script: |
            const [signal] = context.payload.workflow_run.pull_requests;
            const { data: pr } = await github.rest.pulls.get({
              owner: context.repo.owner,
              repo: context.repo.repo,
              pull_number: signal.number,
            });
            if (pr.state !== 'open' || pr.draft || pr.head.repo?.fork) {
              core.setFailed('Only open, non-fork pull requests are eligible.');
              return;
            }
            core.setOutput('number', String(pr.number));
            core.setOutput('base_sha', pr.base.sha);
            core.setOutput('head_sha', pr.head.sha);

  openai-review:
    needs: resolve-pr
    uses: GizClaw/github-workflows/.github/workflows/codex-openai-review.yml@v1
    with:
      model: gpt-5.6-terra
      effort: medium
      review-instructions: >-
        Review only the pull-request diff and report actionable findings.
      pull_request_number: ${{ needs.resolve-pr.outputs.number }}
      base_sha: ${{ needs.resolve-pr.outputs.base_sha }}
      head_sha: ${{ needs.resolve-pr.outputs.head_sha }}
    secrets:
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

`openai-pr-review-on-comment.yml` implements the trusted manual trigger. Copy
the three caller files from this repository, then replace the local `uses`
line in the two `review` jobs with the protected release reference:

```yaml
uses: GizClaw/github-workflows/.github/workflows/codex-openai-review.yml@v1
```

The caller must pass `OPENAI_API_KEY` by name. Do not use `secrets: inherit`.
The reusable workflow defaults `model` to `gpt-5.6-terra` and reasoning
`effort` to `medium`; callers may deliberately select another supported model
or effort level. Keep both settings in the wrapper so they are reviewed as
configuration.

This repository includes all three caller workflows as its internal caller and
smoke-test path. Both privileged wrappers are loaded from `main`, so a pull
request cannot change the workflow that receives the API key. The review job
checks out only the trusted base commit and fetches the pull-request diff as
data; it never checks out or executes the pull-request head or merge ref.

### Security and rollout

- Store the API key as an organization secret restricted to an explicit
  allowlist of participating repositories. Use a dedicated OpenAI API project
  with its own spending controls.
- Forked pull requests are skipped. Do not use `pull_request_target`, and do
  not check out or execute pull-request code in a workflow that receives the
  API key.
- The workflow uses `sandbox: read-only` together with
  `safety-strategy: drop-sudo`; read-only filesystem access alone is not a
  secret-protection boundary on GitHub-hosted runners.
- Inline comments are created only after the publisher verifies that the
  model-supplied path and line identify an added line in the live PR diff.
  Stale reviews are skipped if the PR head changed while Codex was running.
- Call the shared workflow through the protected `v1` release reference. Move
  `v1` only after the new workflow revision has been validated.

### Inputs and output

| Input | Default | Purpose |
| --- | --- | --- |
| `model` | `gpt-5.6-terra` | OpenAI model supplied to Codex for the review. |
| `effort` | `medium` | Codex reasoning effort; choose a value supported by the selected model. |
| `review-instructions` | Diff-only actionable-review profile | Additional caller-owned review guidance. |
| `pull_request_number` | — | Open pull request to annotate. |
| `base_sha` | — | Trusted base commit checked out for review context. |
| `head_sha` | — | Reviewed pull-request head recorded in the prompt. |

The reusable workflow exposes a `review` output containing the structured JSON
result. Its native pull-request review includes the reviewed commit, selected
model, concise summary, and resolvable inline findings with priority badges.

### Operational limits

The reviewer never pushes commits, approves, merges, or otherwise changes a
pull-request branch. It is an independent review service rather than a
replacement for Codex's conversational code-writing surface. Enable it in one
internal repository at a time to avoid duplicate reviews.
