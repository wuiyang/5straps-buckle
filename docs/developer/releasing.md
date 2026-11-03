# Releasing

## Overview

- [Release flow](#release-flow): verify source, prepare and tag, stage, then approve.
- [One-time setup](releasing-04.md): npm trusted publishing and GitHub rules, on their own page.
- [Prepare release](#step-one-prepare-release): set the version and changelog.
- [Stage Buckle](#step-two-stage-buckle): check, pack, and submit staged packages.
- [Finishing the release](releasing-02.md#finishing-the-release): approve each stage, then create the GitHub release.

## Release flow

Three packages publish to npm: `@5straps/protocol`, the wire schemas; `@5straps/runtime`, the
runtime primitives; and `@5straps/buckle`, the approval and sandbox runtime with its `buckle`
binary. Buckle depends on the other two, so they publish first. The three share one version.

A release runs from the repository's Actions tab, in two workflows started by hand on `main`:

1. Wait for `verify` and `package-arm64` to pass on the source commit on `main`.
2. Actions, Prepare release, Run workflow on `main`; it infers the version, commits the release
   metadata, and atomically pushes `main` and `v<version>`.
3. Actions, Stage Buckle, Run workflow on `main`. Select `dry_run` to check and pack first.
4. Approve the staged packages on npm, in order: protocol, runtime, then buckle, each only when
   its integrity matches the line in the run summary.
5. Choose "Re-run all jobs" on that Stage Buckle run to confirm all three versions are public
   and create the GitHub release.

The generated release commit changes only versions and the changelog. It skips Release checks;
staging validates that diff and uses the successful checks on its source parent.

[One-time setup](releasing-04.md) comes first on a new repository;
[repeats and approval](releasing-02.md) covers finishing, failed runs, and npm approval;
[what ships](releasing-03.md) covers what each package holds.

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
those files over a fresh checkout of the same commit. `scripts/release/check-prepared.mjs`, which
needs only Node and git, then refuses unless `git status` names exactly the four, each `package.json` differs from `HEAD`
only in its version, matching the inferred output and one allowed bump from `HEAD`, and
`CHANGELOG.md` only gains the new top section, with no other heading of level one or two. The job
commits as `github-actions[bot]`, subject `chore(release): v<version> [skip ci]`, creates the
lightweight `v<version>` tag, and atomically pushes `main` and that tag, leased on the source
commit. If `main` no longer names the source commit, or either update is refused, neither reaches
GitHub. It starts no Release checks on the generated commit. The run summary names the
release commit and tag.

## Step two: Stage Buckle

After Prepare release succeeds, start Actions, Stage Buckle, Run workflow, on `main`.
The workflow file remains `release.yml`, matching npm's trusted publisher configuration.
The run uses the commit `main` held when it started, including while it waits for another release
run. A `dry_run` checks and packs only, retaining tarballs and notes as the `release` artifact.
The prepared tag already exists.

**`pack`** reads the repository and check runs, without an npm identity.

1. `scripts/release/require-ci.mjs` requires a clean tree and `HEAD` equal to `origin/main`. In
   Actions the checkout sets `origin/main` to the run's commit, so that comparison guards local
   runs only. An ordinary source commit needs its own successful `verify` and `package-arm64` checks.
   A release chore may use its single parent's checks only after its exact tag and strict
   four-file metadata diff validate. A check counts only from a `release-check.yml` run on `main`
   that succeeded and lists the check among its jobs.
2. `scripts/release/plan.mjs` requires the shared version, its changelog section, and
   `v<version>` on this commit. It reports which versions are already public on npm.
3. `pnpm pack` builds through `prepack`, replaces `workspace:*` with exact sibling versions,
   and checks the tarballs' dependencies and entry points.
4. The job uploads the tarballs and changelog release notes.

**`confirm-tag`** holds only `contents: read` and installs nothing. It first requires the commit
pack reports to be the run's own, checks out that commit, and verifies that GitHub's prepared tag
still names it. No release job creates or moves that tag.

**`stage`** runs in the `npm` environment with only `id-token: write`. It checks out no code,
runs no repository script, and installs the pinned official `npm@11.15.0` CLI with install
scripts disabled. It downloads the artifact, then submits protocol, runtime, and buckle with
`npm stage publish <tarball> --access public`. Already-public versions are skipped. Before each
submission it prints the tarball's integrity, `sha512-` and the base64 of its SHA-512, beside the
package name and version. Keep the integrity lines and stage IDs from the job log and run summary.

Successful staging does not publish the packages. If the job stages any package, it skips the
GitHub release. A public registry 404 cannot distinguish an unused version from a pending stage;
[handle existing stages before retrying](releasing-02.md#repeating-a-failed-release).

Both release workflows share one concurrency group. A running release is never cancelled;
GitHub retains one waiting run, which a third start replaces. Waiting runs keep their starting
commit, and so does a re-run, so `main` may move once Stage Buckle has started. Only a new Stage
Buckle run needs `main` on the prepared commit.
