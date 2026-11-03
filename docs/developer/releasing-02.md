# Releasing: repeats and approval

## Overview

- [Finishing the release](#finishing-the-release): approve each stage against its integrity, then create the GitHub release.
- [Repeating a failed release](#repeating-a-failed-release): keep the prepared version and its stages.
- [Preparing by hand](#preparing-by-hand): commit and tag what `pnpm release:prepare` writes.
- [Versions that never reached npm](#versions-that-never-reached-npm): v0.1.1 and v0.1.2.

## Finishing the release

[Releasing](releasing.md) covers the flow, [one-time setup](releasing-04.md) the npm and GitHub
settings, and [what ships](releasing-03.md) the package contents.

Staging submits the packages; a human approval publishes them. Use a human npm account with
permission to publish each package and 2FA. For each package it staged, the Stage Buckle run
summary holds an integrity line, `@5straps/<name>@<version>: integrity sha512-...`, just above
npm's line with the stage ID. On npmjs.com, open Staged Packages, wait for scanning, and compare
the integrity npm lists for each stage with that line. Approve only on a match, in order:
`@5straps/protocol`, then `@5straps/runtime`, then `@5straps/buckle`. Reject a stage whose
integrity differs, and find out where it came from.

The CLI alternative requires npm 11.15.0 or newer and a human login:

```bash
npm login
npm stage approve <stage-id>
```

OIDC cannot approve or reject stages, list them, or view their status. Approval makes that
package version public. See [npm staged publishing](https://docs.npmjs.com/staged-publishing/).

When all three versions are public, choose "Re-run all jobs" on the same Stage Buckle run. Its
staging job skips the public versions and lets **`github-release`** run. That job first requires
the commit pack reports to be the run's own, checks out that commit, confirms the prepared tag
still names it, and creates the GitHub release on the tag, with the version's section of
`CHANGELOG.md` from that checkout as its notes. An existing GitHub release is left alone. Staging
alone never creates it.

Known limit: the GitHub release names the tag and its notes only and attaches no files, so the
check that the public packages are the ones this run built happens at approval, not at
finalization. A re-run packs again, and the Buckle tarball carries its build time, so its integrity
changes with every pack.

## Repeating a failed release

- **Source checks failed:** Fix the source and pass `verify` and `package-arm64` on its exact
  commit before Prepare release.
- **Prepare failed before its atomic push:** Neither the release commit nor tag reached GitHub.
  Fix the cause and repeat preparation. A refused branch or tag update, or a `main` that no
  longer names the source commit, refuses both refs.
- **Preparation succeeded:** Run Stage Buckle on the prepared commit. Generated metadata skips
  Release checks; staging validates its diff and source parent's checks.
- **Some packages staged before failure:** Inspect npm's Staged Packages page and approve those
  stages, each only when its integrity matches the run summary, before re-running failed jobs on
  the same run. The workflow skips now-public versions and stages the remaining packages. Keep the
  version and tag; do not prepare again.
- **npm reports a duplicate version while the public registry returns 404:** A pending stage
  can reserve that version. Approve the existing stage only when its integrity matches the run
  summary of the run that staged it; otherwise reject it and stage again. OIDC cannot list or
  inspect stages.
- **The staging job succeeded:** Approve all three packages, then "Re-run all jobs" to create
  the GitHub release. "Re-run failed jobs" is insufficient when finalization was skipped.
- **Tag missing or moved:** Staging stops. Inspect preparation and tag history; release jobs
  never create or move tags.
- **A source fix is required:** Finish existing stages first. A new source commit needs its
  own checks and preparation for the next version. Do not move the old version's tag.
- **A runner fault affects source checks:** Re-run those source checks without changing source.
  Release gates take the latest run of each required job, and its `release-check.yml` run must
  have succeeded.

A job re-run keeps the original run's workflow and commit, so `main` may move once Stage Buckle
has started. Only a new Stage Buckle run, for example after GitHub's 30-day re-run window, needs
`main` on the prepared commit.

## Preparing by hand

`pnpm release:prepare` runs `prepare.mjs` locally: it sets the version and writes the changelog
section, and commits nothing. To release what it wrote, with both source checks passed on the
current commit, commit exactly the four files as `chore(release): v<version>`, tag that commit
`v<version>`, and push both:

```bash
git add -- CHANGELOG.md packages/protocol/package.json packages/runtime/package.json buckle/package.json
git commit --message "chore(release): v<version>"
git tag "v<version>"
git push --atomic origin HEAD:refs/heads/main "refs/tags/v<version>"
```

Then run Stage Buckle, which validates the commit as usual: its tag, its four-file diff, and its
parent's checks. There is no root `pnpm release` command or automatic direct-publication fallback.

## Versions that never reached npm

v0.1.1 and v0.1.2 were prepared and tagged while `release.yml` still published directly. Neither
reached npm, which stays at 0.1.0 until the next staged release is approved, and neither gets a
GitHub release. Leave their tags and changelog sections in place. Their changes ship with the next
version, whose GitHub release notes carry only its own section. Never re-run a run from before
staging, which still runs `npm publish`: run Prepare release for the next version, then Stage Buckle.
