# Contributing

These rules apply to every contributor, including Claude and Codex. This file is the single source of truth for the workflow.

## Issue → branch → implementation → PR

1. Before starting a feature or other tracked change, create a GitHub issue using the feature/change template. Include what changes, why, constraints, and testable acceptance criteria. Reuse an existing issue when it already covers the request. With `gh issue create`, include the same sections in the body.
2. Fetch origin and branch from `origin/main`. Branch names are not checked; use whatever name is convenient.
3. Implement and validate the acceptance criteria. Every commit must use Conventional Commits. Reference the issue in the commit body where useful. Never commit directly to `main`.
4. Run `pnpm build`, `pnpm tsc`, `pnpm lint`, and `pnpm test --coverage`. Run `pnpm audit --audit-level=high` and review findings. Format changed files with `pnpm exec oxfmt <files>`.
5. Push the branch and open a PR against **main**. Give the PR a Conventional Commit title and include `Closes #<issue>`, a description of the resulting behavior, and validation results. Do not merge your own work unless the maintainer requested a merge. PRs are merged with merge commits; do not squash.
6. Merging a PR to `main` runs CI and deploys the viewer to GitHub Pages. Nothing is published to npm.

GitHub automatically closes referenced issues when their closing commits reach the default branch (`main`).

## Commit format

Use `type(optional-scope): description`. Allowed types are `feat`, `fix`, `perf`, `docs`, `chore`, `refactor`, `test`, `style`, `build`, `ci`, and `revert`. Use an imperative, concise description. Add a blank line before a body or footer. Husky validates commit messages after `pnpm install`; CI validates feature commits and PR titles too. Git-generated merge commits are exempt from commitlint.

## Development and CI

Use Node 26 and the pinned pnpm version in `package.json`. Clone with submodules (`git clone --recurse-submodules`, or `git submodule update --init` afterwards), then run `pnpm install --frozen-lockfile`.

CI checks builds, types, lint, and tests with coverage. Dependency audit findings appear as warnings so existing advisories remain visible without preventing unrelated fixes. Coverage is uploaded as an artifact.
