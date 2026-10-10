# Releasing

## Overview

- [Release flow](#release-flow): verify source, prepare and tag, stage, then approve.
- [One-time setup](#one-time-setup): npm trusted publishing and GitHub rules.
- [Prepare release](#step-one-prepare-release): set the version and changelog.
- [Stage Buckle](#step-two-stage-buckle): check, pack, and submit staged packages.
- [Approve and finalize](#step-three-approve-and-finalize): publish with human approval, then create the GitHub release.

## Release flow

Three packages publish to npm: `@5straps/protocol`, the wire schemas; `@5straps/runtime`, the
runtime primitives; and `@5straps/buckle`, the approval and sandbox runtime with its `buckle`
binary. Buckle depends on the other two, so they publish first. The three share one version.

A release runs from the repository's Actions tab, in two workflows started by hand on `main`:

1. Wait for `verify` and `package-arm64` to pass on the source commit on `main`.
2. Actions, Prepare release, Run workflow on `main`; it infers the version, commits the release
   metadata, and atomically pushes `main` and `v<version>`.
3. Actions, Stage Buckle, Run workflow on `main`. Select `dry_run` to check and pack first.
4. Approve the staged packages on npm, in order: protocol, runtime, then buckle.
5. With `main` still on the prepared commit, choose "Re-run all jobs" on that Stage Buckle run
   to confirm all three versions are public and create the GitHub release.

The generated release commit changes only versions and the changelog. It skips Release checks;
staging validates that diff and uses the successful checks on its source parent.

[Repeats and approval](releasing-02.md) covers failed runs and npm approval;
[what ships](releasing-03.md) covers what each package holds.

## One-time setup

On npmjs.com, open each of the three packages, then Settings, then Trusted publishing, and add a
trusted publisher for GitHub Actions:

| Field | Value |
|---|---|
| Organization or user | `wuiyang` |
| Repository | `5straps-buckle` |
| Workflow filename | `release.yml` |
| Environment name | `npm` |
| Allowed actions | `npm stage publish`, always allowed by trusted publishing |

Direct `npm publish` permission is not needed. New connections created after 3 September 2026
allow staged publishing by default. Check the active connection's identity fields on every package.
See [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/) and
[staged publishing](https://docs.npmjs.com/staged-publishing/).

No npm token is stored. npm trades the staging job's GitHub identity for a short-lived one.
Approving stages requires a human npm account with package publishing permission and 2FA;
OIDC cannot approve, reject, list, or inspect stages.

On GitHub:

- The staging job runs in an environment named `npm`. Before the first real publish, make the
  repository public, then create this environment in Settings, Environments, and allow deployments
  from `main` only; a required reviewer is optional. A `dry_run` skips the staging job and does
  not create the environment. Until the deployment rule is set, only a test inside `release.yml`
  holds staging to `main`, and a run on another branch uses that branch's copy. On GitHub Free,
  environments are configurable only for public repositories
  ([Managing environments for deployment](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)).
- A branch rule or ruleset on `main` that requires pull requests, status checks, or signed commits
  (the release commit is unsigned), or that restricts who may update `main`, refuses the push
  Prepare release makes, and the release stops there.
- A tag rule that stops the workflow token from creating `v*` tags refuses the atomic push
  Prepare release makes. Neither the branch nor the tag changes.

## Step one: Prepare release

Actions, Prepare release, Run workflow, on `main`, after both source checks pass.
There is no version input or override.
Changelogen infers the next shared version from conventional commits since `v<current>`.
Its pinned 0.6.2 rules make `fix` a patch, `feat` a minor, and a breaking change a major.
Before 1.0.0, a feature becomes a patch and a breaking change becomes a minor instead.
Documentation, refactor, build, performance, and types commits also request a patch.
If no commit requests a release, preparation stops without changing the release files.

`scripts/release/prepare.mjs` refuses, changing nothing, unless:

- the three packages share one plain version and changelogen infers a greater one;
- the working tree is clean;
- the tag of the current version, such as `v0.1.0`, where the new changelog section starts, exists;
- neither the tag `v<version>` nor that version on npm exists yet.

It then sets the version in the three `package.json` files, as `pnpm version:set` does, and writes
the new section at the top of `CHANGELOG.md` with
`changelogen --from v<current> --to HEAD -r <version>`, configured under `changelog` in the root
`package.json`. changelogen exits 0 even when it fails, so the script reads both results back.

The workflow has two jobs, so no installed dependency runs where `main` can be pushed. `prepare`
can only read: it first requires successful `verify` and `package-arm64` checks on the exact
source commit, installs with install scripts off, runs `prepare.mjs`, and hands over the four
files and the inferred version. `commit` holds the write token, installs nothing, and copies just
those files over a fresh checkout of the same commit. `scripts/release/check-prepared.mjs`, which needs only Node and git,
then refuses unless `git status` names exactly the four, each `package.json` differs from `HEAD`
only in its version, matching the inferred output and one allowed bump from `HEAD`, and
`CHANGELOG.md` only gains the new top section. The job commits as
`github-actions[bot]`, subject `chore(release): v<version> [skip ci]`, creates the lightweight
`v<version>` tag, and atomically pushes `main` and that tag without force. If `main` moved or either
update is refused, neither update reaches GitHub. It starts no Release checks on the generated
commit. The run summary names the release commit and tag.

## Step two: Stage Buckle

After Prepare release succeeds, start Actions, Stage Buckle, Run workflow, on `main`.
The workflow file remains `release.yml`, matching npm's trusted publisher configuration.
The run uses the commit `main` held when it started, including while it waits for another release
run. A `dry_run` checks and packs only, retaining tarballs and notes as the `release` artifact.
The prepared tag already exists.

**`pack`** reads the repository and check runs, without an npm identity.

1. `scripts/release/require-ci.mjs` requires a clean tree and `HEAD` equal to `origin/main`.
   An ordinary source commit needs its own successful `verify` and `package-arm64` checks.
   A release chore may use its single parent's checks only after its exact tag and strict
   four-file metadata diff validate. Only eligible `release-check.yml` runs on `main` count.
2. `scripts/release/plan.mjs` requires the shared version, its changelog section, and
   `v<version>` on this commit. It reports which versions are already public on npm.
3. `pnpm pack` builds through `prepack`, replaces `workspace:*` with exact sibling versions,
   and checks the tarballs' dependencies and entry points.
4. The job uploads the tarballs and changelog release notes.

**`confirm-tag`** holds only `contents: read`, installs nothing, and verifies that GitHub's
prepared tag still names the packed commit. No release job creates or moves that tag.

**`stage`** runs in the `npm` environment with only `id-token: write`. It checks out no code,
runs no repository script, and installs the pinned official `npm@11.15.0` CLI with install
scripts disabled. It downloads the artifact, then submits protocol, runtime, and buckle with
`npm stage publish <tarball> --access public`. Already-public versions are skipped.
Keep the stage IDs printed by npm in the job log and run summary.

Successful staging does not publish the packages. If the job stages any package, it skips the
GitHub release. A public registry 404 cannot distinguish an unused version from a pending stage;
[handle existing stages before retrying](releasing-02.md#repeating-a-failed-release).

## Step three: Approve and finalize

Open npmjs.com's Staged Packages page with a package maintainer account. Wait for scanning,
review each stage, and approve protocol, runtime, then buckle with 2FA.
Alternatively use `npm stage approve <stage-id>` with npm 11.15.0 or newer and a human login.
The workflow's OIDC identity cannot perform this approval.

When all three versions are public, choose "Re-run all jobs" on the same Stage Buckle run,
with `main` still on the prepared commit. Its staging job skips the public versions and allows
**`github-release`** to create the GitHub release on the prepared tag, using the changelog notes.
An existing GitHub release is left alone. Staging alone never creates this release.

Both release workflows share one concurrency group. A running release is never cancelled;
GitHub retains one waiting run, which a third start replaces. Waiting runs keep their starting
commit. Keep `main` on the prepared commit until staging, approval, and finalization finish.
