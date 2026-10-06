# Releasing: repeats and by hand

What to do when a release run fails, and how to release without GitHub Actions.
[Releasing](releasing.md) covers the one-time setup and the two workflows, and
[Releasing: what ships](releasing-03.md) covers what each package holds.

## Repeating a failed release

Every step can be started again: what is already done is checked, not done twice.

- **Prepare release failed before its push.** Nothing reached GitHub. Fix the cause and run it
  again.
- **Its push was refused** because `main` moved after the run started. Run it again; it starts
  from the new `main`.
- **It pushed, but starting the checks failed.** Start them by hand: Actions, Release checks, Run
  workflow, on `main`.
- **A check failed on the release commit.** Push the fix to `main` as usual, which runs the checks
  on it, then run Release: it releases that later commit under the prepared version. Do not
  prepare again, since the version is already set. The fix is not in the changelog section; add it
  there in the same push if it matters.
- **A check failed or was cancelled with nothing to fix**, such as a runner fault. Re-run it with
  "Re-run failed jobs" on that Release checks run. Release reads the latest run of each job, so
  push nothing.
- **Release failed.** Finish it with "Re-run failed jobs" on the same run, which GitHub allows for
  30 days after the run started. The re-run keeps the run's commit and the tarballs `pack`
  uploaded: `tag` finds its tag in place, `publish` skips every package the registry already
  holds, and `github-release` leaves an existing release as it is. Finish a half-published version
  this way, never with a new version.
- **A new Release run** is for when nothing reached npm, or when the fix must change `main`. It
  releases the head of `main`, and the failed run's `tag` job may have left `v<version>` on the
  earlier commit, which stops a run from any other commit before it publishes. When nothing
  reached npm, delete that tag by hand (`git push origin :refs/tags/v<version>`, or on GitHub),
  then start the new run. When a package did reach npm, that version is abandoned: prepare the
  next version, with the fix. The abandoned version leaves its tag behind, to delete by hand once
  the next version is prepared, since preparing reads the tag of the current version.
- **A repeat right after a publish** can find the registry not yet answering for that package, try
  it again, and fail on npm's refusal of the duplicate. Nothing is harmed; re-run the failed jobs
  later.
- **A tag `v<version>` names another commit.** `pack`, `tag`, and `github-release` all stop, before
  anything is published: that version came from somewhere else. Find out where before moving or
  deleting the tag.

## Releasing by hand

The fallback when Actions cannot publish. It needs an npm login (`npm login`, then `npm whoami`)
with an account that may publish under the `@5straps` scope, and the GitHub CLI, `gh`, logged in:
`pnpm release` asks it for the CI results. Keep tokens out of the repository and out of the shell
history.

```bash
git switch main
git pull --ff-only origin main
git fetch origin --tags
pnpm install --frozen-lockfile
pnpm release:prepare 0.2.0
```

`release:prepare` runs `scripts/release/prepare.mjs`, with the same checks and changes as step
one, on the local `HEAD`: the new changelog section covers the commits from the last tag to that
`HEAD`, so bring `main` up to date first, as above. Read the diff, commit the four files as
`chore(release): v0.2.0`, push to `main`, and wait for both checks, which a push by a person
starts. Then:

```bash
git fetch origin
pnpm release
git tag v0.2.0
git push origin v0.2.0
```

`pnpm release` runs three steps and stops at the first failure:

1. `scripts/release/require-ci.mjs` refuses unless:
   - the working tree has no uncommitted changes;
   - `HEAD` is on a branch, not detached, and equals the local `origin/<branch>` (it compares
     with what the last fetch saw and never fetches itself);
   - both CI jobs, `verify` and `package-arm64`, have a latest run on that exact commit that
     completed successfully, counting only `release-check.yml` on a push to `main` or a run
     started on `main`. It reads the check runs with
     `gh api repos/<owner>/<repo>/commits/<sha>/check-runs`, and the workflow run each one names
     with `gh api repos/<owner>/<repo>/actions/runs/<id>`, taking the repository from
     `GITHUB_REPOSITORY` or from the `origin` URL.
2. `pnpm release:check` runs the whole gate locally: runtime pins, route tables, typecheck, every
   test suite, the builds, the packaged smoke, and the dependency audit.
3. `pnpm -r publish --access public` publishes each package in dependency order. The release
   check has just built every package, and each `prepack` script builds it again where scripts
   run, so a stale `dist/` is never published.

`@5straps/buckle` names the other two as `workspace:*`. `pnpm publish` and `pnpm pack` write the
exact version in its place; `npm publish` from a package directory does not, so publish by hand
with pnpm.

The tag gives the next changelog section its starting point. Running Release while `main` is still
at that commit adds the GitHub release: it skips the packages npm holds and keeps the tag.
