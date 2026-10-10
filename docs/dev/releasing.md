# Releasing

## Overview

- [Release flow](#release-flow): prepare, verify, and publish manually.
- [One-time setup](#one-time-setup): npm trusted publishing and GitHub rules.
- [Prepare release](#step-one-prepare-release): set the version and changelog.
- [Publish Buckle](#step-two-publish-buckle): check, pack, and publish.

## Release flow

Three packages publish to npm: `@5straps/protocol`, the wire schemas; `@5straps/runtime`, the
runtime primitives; and `@5straps/buckle`, the approval and sandbox runtime with its `buckle`
binary. Buckle depends on the other two, so they publish first. The three share one version.

A release runs from the repository's Actions tab, in two workflows started by hand on `main`:

1. Actions, Prepare release, Run workflow on `main`; the version is inferred.
2. Wait for `verify` and `package-arm64` to pass on that exact preparation commit.
3. Actions, Publish Buckle, Run workflow on `main`. Select `dry_run` to check and pack first.

[Repeats and by hand](releasing-02.md) covers a failed run and the manual fallback;
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
| Allowed actions | `npm publish` |

npm checks these fields only when a publish arrives, so a mistyped one shows up as a failed
publish. npm's documentation names `ENEEDAUTH`, but behind the `.npmrc` that setup-node writes, the
error reads `E404 Not Found` or `E401` on the PUT. A trusted publisher made after 3 September 2026
allows only `npm stage publish` until `npm publish` is selected. No npm token is stored: npm
trades the publishing job's GitHub identity for a short-lived one. After a first release this way,
each package can require two-factor authentication and disallow tokens; publishing by hand then
asks for a one-time code.

On GitHub:

- The publishing job runs in an environment named `npm`. Before the first real publish, make the
  repository public, then create this environment in Settings, Environments, and allow deployments
  from `main` only; a required reviewer is optional. A `dry_run` skips the publishing job and does
  not create the environment. Until the deployment rule is set, only a test inside `release.yml`
  holds publishing to `main`, and a run on another branch uses that branch's copy. On GitHub Free,
  environments are configurable only for public repositories
  ([Managing environments for deployment](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)).
- A branch rule or ruleset on `main` that requires pull requests, status checks, or signed commits
  (the release commit is unsigned), or that restricts who may update `main`, refuses the push
  Prepare release makes, and the release stops there.
- A tag rule that stops the workflow token from creating `v*` tags stops Publish Buckle before it
  publishes.

While the repository is private, npm publishes without a provenance statement. Once it is public,
npm adds one on each trusted publish on its own.

## Step one: Prepare release

Actions, Prepare release, Run workflow, on `main`. No version input or override is needed.
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
can only read: it installs with install scripts off, runs `prepare.mjs`, and hands over the four
files and the inferred version. `commit` holds the write token, installs nothing, and copies just those files over a fresh
checkout of the same commit. `scripts/release/check-prepared.mjs`, which needs only Node and git,
then refuses unless `git status` names exactly the four, each `package.json` differs from `HEAD`
only in its version, matching the inferred output and one allowed bump from `HEAD`, and
`CHANGELOG.md` only gains the new top section. The job commits as
`github-actions[bot]`, subject `chore(release): v<version>`, and pushes to `main` without force; if
`main` moved since the run started, the push is refused. A push made with the workflow token starts
no workflow, so the job starts Release checks (`release-check.yml`) on `main` itself, and the run
summary names the release commit.

Wait for both jobs of that Release checks run, `verify` and `package-arm64`, to pass.

## Step two: Publish Buckle

Start Publish Buckle only after both checks have passed on the release commit: Actions,
Publish Buckle, Run workflow, on `main`. The run releases the commit `main` held when Run workflow
was clicked, even while it waits behind another release run. Tick `dry_run` to check and pack only: the tarballs and
notes are kept as the run's `release` artifact, and nothing is tagged or published.

**`pack`** reads the repository and its check runs, and holds no publishing identity.

1. `scripts/release/require-ci.mjs` refuses unless the tree is clean, `HEAD` is on `main` and is
   what `origin/main` holds, and both `verify` and `package-arm64` have a latest run on that exact
   commit that succeeded, counting only `release-check.yml` on a push to `main` or started on
   `main`.
2. It installs, then `scripts/release/plan.mjs` refuses unless the three packages share one
   version, `CHANGELOG.md` has its section, and the tag `v<version>` is absent or already on this
   commit. It reports which packages npm already holds at that version.
3. It packs the three with `pnpm pack`, which builds through `prepack` and writes `workspace:*` as
   the exact version, and reads each tarball back: sibling dependencies at exactly that version,
   and every entry point file present.
4. It writes the changelog section as the release notes and uploads tarballs and notes.

**`tag`** holds `contents: write` and installs nothing. Before anything is published,
`github-release.mjs tag` reads `v<version>` on GitHub: on the packed commit, it does nothing; on
another commit, it stops the run; missing, it creates the tag there. A version is only ever
finished from the commit that started it.

**`publish`** runs in the `npm` environment and holds `id-token: write` and nothing else. It checks
out nothing, installs nothing, and runs no repository code. It sets up Node 24, refuses an npm older
than 11.5.1, which trusted publishing requires, downloads the artifact, and publishes protocol,
runtime, then buckle with `npm publish <tarball> --access public`, skipping a package the registry
already holds at that version.

**`github-release`** holds `contents: write` and runs after `publish`: `github-release.mjs release`
creates the release on the existing tag, titled `v<version>`, with the changelog section as notes.
It never makes or moves a tag, and leaves an existing release alone.

Both workflows share one concurrency group. A second run waits for the one in progress and never
cancels it; GitHub keeps one waiting run per group, so a third start replaces the waiting one. A
waiting run still releases the commit `main` held when it was started.
