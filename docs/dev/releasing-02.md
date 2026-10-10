# Releasing: repeats and approval

## Overview

- [Repeating a failed release](#repeating-a-failed-release): keep the prepared version and its stages.
- [Approving staged packages](#approving-staged-packages): human approval and GitHub finalization.
- [Switching an older release to staging](#switching-an-older-release-to-staging): use the updated workflow on a new prepared version.

## Repeating a failed release

[Releasing](releasing.md) covers setup and the flow;
[what ships](releasing-03.md) covers package contents.

- **Source checks failed.** Fix the source and pass `verify` and `package-arm64` on its exact
  commit before Prepare release.
- **Prepare failed before its atomic push.** Neither the release commit nor tag reached GitHub.
  Fix the cause and repeat preparation. A refused branch or tag update refuses both refs.
- **Preparation succeeded.** Run Stage Buckle on the prepared commit. Generated metadata skips
  Release checks; staging validates its diff and source parent's checks.
- **Some packages staged before failure.** Inspect npm's Staged Packages page and approve those
  stages before re-running failed jobs on the same run. The workflow skips now-public versions
  and stages the remaining packages. Keep the version and tag; do not prepare again.
- **npm reports a duplicate version while the public registry returns 404.** A pending stage
  can reserve that version. Inspect and approve the existing stage rather than resubmitting it.
  OIDC cannot list or inspect stages.
- **All staging jobs succeeded.** Approve all three packages, then "Re-run all jobs" to create
  the GitHub release. "Re-run failed jobs" is insufficient when finalization was skipped.
- **Tag missing or moved.** Staging stops. Inspect preparation and tag history; release jobs
  never create or move tags.
- **A source fix is required.** Finish existing stages first. A new source commit needs its
  own checks and preparation for the next version. Do not move the old version's tag.
- **A runner fault affects source checks.** Re-run those source checks without changing source.
  Release gates use the latest eligible run of each required job.

A job re-run retains the original run's workflow and commit. Keep `main` on the prepared commit
until approval and finalization finish. GitHub allows re-runs for 30 days after the run started.

## Approving staged packages

Use a human npm account with permission to publish each package and 2FA. The staging job prints
stage IDs. On npmjs.com, open Staged Packages, wait for scanning, review and
approve `@5straps/protocol`, then `@5straps/runtime`, then `@5straps/buckle`.

The CLI alternative requires npm 11.15.0 or newer:

```bash
npm login
npm stage approve <stage-id>
```

Repeat for each package in order. OIDC cannot approve or reject stages, list them, or view their
status. Approval makes that package version public. After all three versions are public, choose
"Re-run all jobs" on the same Stage Buckle run to create the GitHub release.
See [npm staged publishing](https://docs.npmjs.com/staged-publishing/).

`pnpm release:prepare` remains available to generate metadata locally. There is no root
`pnpm release` command or automatic direct-publication fallback.

## Switching an older release to staging

An older failed Publish Buckle run still uses its original direct `npm publish` command when
re-run. It cannot pick up the new staging workflow.

Push the staging workflow change, pass source checks, run Prepare release for the next inferred
version, then run Stage Buckle. Leave earlier tags in place. The new run submits staged packages
for human approval and only creates the GitHub release once all three versions are public.
