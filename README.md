# GizClaw GitHub Workflows

Reusable GitHub Actions workflows for GizClaw projects.

## OpenAI PR review

`.github/workflows/codex-openai-review.yml` is a reusable workflow that reviews
an internal pull request with the OpenAI API through
[`openai/codex-action`](https://github.com/openai/codex-action). It runs Codex
in a read-only sandbox and posts one structured result to the pull request. A
new run updates that result instead of adding another bot comment.

The workflow has no write path to the pull-request checkout: the review job has
only `contents: read` and `pull-requests: read` to fetch the diff, while a
separate publication job has only the `pull-requests: write` permission needed
to update the review comment.

### Caller workflows

Each participating repository uses two small wrappers. The first is an
unprivileged pull-request signal with no secret:

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

The second wrapper is a `workflow_run` workflow that exists on the protected
default branch. It resolves the open, non-fork pull request through GitHub's
API before passing its number and commit SHAs to the shared review workflow:

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
      review-instructions: >-
        Review only the pull-request diff and report actionable findings.
      pull_request_number: ${{ needs.resolve-pr.outputs.number }}
      base_sha: ${{ needs.resolve-pr.outputs.base_sha }}
      head_sha: ${{ needs.resolve-pr.outputs.head_sha }}
    secrets:
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

The caller must pass `OPENAI_API_KEY` by name. Do not use `secrets: inherit`.
The reusable workflow defaults `model` to `gpt-5.6-terra`; callers may select
another supported OpenAI model deliberately. Keep the selected model in the
wrapper so that a model change is reviewed as configuration.

This repository includes both wrappers as its internal caller and smoke-test
path. The privileged wrapper is loaded from `main`, so a pull request cannot
change the workflow that receives the API key. Its review job checks out only
the trusted base commit and fetches the pull-request diff as data; it never
checks out or executes the pull-request head or merge ref.

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
- Call the shared workflow through the protected `v1` release reference. Move
  `v1` only after the new workflow revision has been validated.

### Inputs and output

| Input | Default | Purpose |
| --- | --- | --- |
| `model` | `gpt-5.6-terra` | OpenAI model supplied to Codex for the review. |
| `review-instructions` | Diff-only actionable-review profile | Additional caller-owned review guidance. |
| `pull_request_number` | — | Open pull request to annotate. |
| `base_sha` | — | Trusted base commit checked out for review context. |
| `head_sha` | — | Reviewed pull-request head recorded in the prompt. |

The reusable workflow exposes a `review` output containing the structured JSON
result. Its pull-request comment contains a summary and only actionable
findings, each with priority, path, and line.

### Operational limits

The first release neither pushes commits nor approves, merges, or otherwise
changes a pull-request branch. It does not replace an existing CI or official
Codex automatic-review configuration. Enable it in one internal repository at
a time to avoid duplicate reviews.
