# Releasing: repeats and by hand

## Overview

- [Repeating a failed release](#repeating-a-failed-release): recover the prepared version.
- [Releasing by hand](#releasing-by-hand): publish when Actions cannot.

## Repeating a failed release

[Releasing](releasing.md) covers setup and the workflows;
[what ships](releasing-03.md) covers package contents.

- **Source checks failed.** Fix the source on `main` and wait for both `verify` and
  `package-arm64` to pass before Prepare release.
- **Prepare release failed before its atomic push.** Neither the release commit nor tag reached
  GitHub. Fix the cause and run preparation again.
- **Its push was refused.** Check branch and tag rules. If `main` moved, wait for checks on its
  new source commit and run preparation again. The atomic push updates both refs or neither.
- **Preparation succeeded.** Run Publish Buckle on that prepared `main` commit. Release checks
  are skipped for its generated metadata; publishing validates the diff and its parent's checks.
- **An older preparation has no tag.** This predates the atomic flow. Review that original
  preparation commit and its source checks before repairing its tag. Do not blindly prepare a
  new version or move an existing tag.
- **Publish Buckle failed.** Use "Re-run failed jobs" on the same run within GitHub's 30-day
  window. The run retains its commit and uploaded tarballs. Publishing skips packages already
  on npm, and GitHub release creation leaves an existing release alone.
- **A check was cancelled or failed without a source fix.** Re-run the failed jobs on the source
  Release checks run. Publishing reads the latest eligible run of each required job.
- **A fix changes source after preparation.** Push the fix, pass source checks, then prepare the
  next version. The prepared tag binds the earlier version to its original commit; a new Publish
  Buckle run on another commit cannot finish that version. Finish any partial publication by
  re-running its original run.
- **A tag names another commit or is missing.** Publishing stops before npm. Inspect the
  preparation result and tag history; publishing never creates or moves the tag.
- **A repeat immediately after publishing fails on an npm duplicate.** Registry visibility can
  lag. Re-run the failed jobs later.

## Releasing by hand

The fallback needs an npm account allowed to publish under `@5straps`, and the GitHub CLI, `gh`,
logged in. Keep tokens out of the repository and shell history.

```bash
git switch main
git pull --ff-only origin main
git fetch origin --tags
pnpm install --frozen-lockfile
node scripts/release/require-ci.mjs --source
pnpm release:prepare
```

The CI gate must pass on the source commit before preparation. `release:prepare` only generates
the version and changelog locally; it does not commit, tag, or push. The version is inferred
without an override. Review its four changed files and use the printed version below:

```bash
git add -- CHANGELOG.md packages/protocol/package.json packages/runtime/package.json buckle/package.json
git commit --message "chore(release): v<version> [skip ci]"
git tag v<version>
git push --atomic origin HEAD:refs/heads/main refs/tags/v<version>
git fetch origin
npm login
npm whoami
pnpm release
```

Replace `<version>` with the printed version. The atomic push updates both refs or neither.
No Release checks run is needed on this generated metadata commit.

`pnpm release` first runs `scripts/release/require-ci.mjs --release`. It requires a clean tree,
an attached branch with `HEAD` equal to the fetched `origin/<branch>`, the shared version's tag
on `HEAD`, and successful eligible `verify` and `package-arm64` checks. An ordinary source commit needs its own checks. A canonical release
commit may use its single parent's checks only after its exact tag and strict four-file diff
validate. The script never fetches itself. It reads GitHub check and workflow runs through `gh`,
using `GITHUB_REPOSITORY` or the `origin` URL to identify the repository.

It then runs `pnpm -r publish --access public` in dependency order. Each `prepack` builds its
package. It does not repeat the full release check on generated metadata. Use pnpm because it
replaces `workspace:*` dependencies with the exact version; publishing from a package directory
with npm does not.

The prepared tag starts the next changelog range. Running Publish Buckle while `main` still
names that release commit adds the GitHub release and skips packages npm already holds.
