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
repository's review policy.

## Behavior

- Reviews open, non-draft, non-fork PRs when they open, update, reopen, or
  become ready for review.
- A collaborator with `write`, `maintain`, or `admin` permission can request a
  fresh review using `@codex` or `@codex review <focus>`.
- **Run workflow** accepts a pull-request number as a manual fallback.
- A new request for the same PR cancels the previous one. Request comments use
  `👀` while running, `🚀` on success, `😕` when superseded, and `👎` on failure.
- The reviewer checks out only the trusted base commit, reads the PR diff as
  data, never executes PR-head code, and publishes validated native inline
  review comments only on added lines.

Do not use `pull_request_target`, do not use `secrets: inherit`, and restrict
the organization secret to the repositories that should be allowed to review.
