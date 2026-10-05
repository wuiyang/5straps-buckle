# Releasing

Three packages publish to npm: `@5straps/protocol`, the wire schemas; `@5straps/runtime`, the
runtime primitives; and `@5straps/buckle`, the approval and sandbox runtime with its `buckle`
binary. Buckle depends on the other two, so they publish first. The three share one version.

A release runs from the Actions tab of the GitHub repository, in two workflows started by hand on
`main`: Prepare release, then Release. [Releasing: repeats and by hand](releasing-02.md) covers a
failed run, the manual fallback, and what each package ships.

## One-time setup

On npmjs.com, open each of the three packages, then Settings, then Trusted publishing, and add a
trusted publisher for GitHub Actions:

| Field | Value |
|---|---|
| Organization or user | `wuiyang` |
| Repository | `5straps-buckle` |
| Workflow filename | `release.yml` |
| Environment name | none |
| Allowed actions | `npm publish` |

npm checks these fields only when a publish arrives, so a mistyped one shows up as a failed publish
(`ENEEDAUTH`). A trusted publisher made after 3 September 2026 allows only `npm stage publish`
until `npm publish` is selected. No npm token is stored anywhere: npm trades the publishing job's
GitHub identity for a short-lived token. Once a release has gone through this way, each package's
publishing access can be set to require two-factor authentication and disallow tokens; publishing
by hand then asks for a one-time code.

On GitHub, nothing needs setting, with two cautions:

- A branch rule or ruleset on `main` that requires pull requests or status checks refuses the push
  Prepare release makes, and the release stops there.
- A tag rule that stops the workflow token from creating `v*` tags stops the last Release job.

While the repository is private, npm publishes without a provenance statement. Once it is public,
npm adds one on each trusted publish on its own; nothing changes here.

## Step one: Prepare release

Actions, Prepare release, Run workflow, on `main`, with the version: plain `MAJOR.MINOR.PATCH`
with no `v`, such as `0.2.0`, greater than the current one.

`scripts/release/prepare.mjs` refuses, changing nothing, unless:

- the version is plain and greater than the one the three packages share;
- the working tree is clean;
- the tag of the current version, such as `v0.1.0`, exists, since the new changelog section starts
  there;
- neither the tag `v<version>` nor that version on npm exists yet.

It then sets the version in the three `package.json` files, as `pnpm version:set` does, and writes
the new section at the top of `CHANGELOG.md` with changelogen, a root dev dependency configured
under `changelog` in the root `package.json`:

```bash
pnpm exec changelogen --from v<current> --to HEAD -r <version> --output CHANGELOG.md
```

`-r` heads the section `v<version>` and links its comparison to that tag. changelogen exits 0
even when it fails, so the script reads both results back: all three packages at the new version,
one new section, and every earlier section unchanged after it.

The workflow commits the four files as `github-actions[bot]`, with the subject
`chore(release): v<version>`, and pushes to `main` without force. If `main` moved after the run
started, the push is refused and nothing reaches GitHub. A push made with the workflow token starts
no workflow, so the job then starts Release checks (`release-check.yml`) on `main` itself. The run
summary names the release commit.

Wait for both jobs of that Release checks run, `verify` and `package-arm64`, to pass. Buckle reads
its version from its own `package.json` at run time (`buckle/common/runtime/version.ts`), so
`buckle --version` matches what is published.

## Step two: Release

Actions, Release, Run workflow, on `main`. Tick `dry_run` to check and pack only: the tarballs and
notes are kept as the run's `release` artifact, and nothing is published or tagged. The run
releases the commit at the head of `main` when it starts.

**`pack`** reads the repository and its check runs, and holds no publishing identity.

1. `scripts/release/require-ci.mjs` refuses unless the tree is clean, `HEAD` is on `main` and is
   what `origin/main` holds in the checkout, and both `verify` and `package-arm64`, run by GitHub
   Actions, have a latest run on that exact commit that succeeded.
2. It installs, then `scripts/release/plan.mjs` refuses unless the three packages share one
   version, `CHANGELOG.md` has its section, and the tag `v<version>` is absent or already on this
   commit. It reports which packages npm already holds at that version.
3. It packs the three with `pnpm pack`, which runs each package's `prepack` build and writes
   `workspace:*` as the exact version, then reads each tarball back: every sibling dependency at
   exactly that version, and every file the manifest's entry points name present.
4. It writes the changelog section as the release notes and uploads tarballs and notes.

**`publish`** holds `id-token: write` and nothing else, and is skipped on a dry run. It checks out
nothing, installs nothing, and runs no repository code. It sets up Node 24, refuses an npm older
than 11.5.1, which trusted publishing requires, downloads the artifact, and publishes protocol,
runtime, then buckle with `npm publish <tarball> --access public`. A package the registry already
holds at that version is skipped.

**`github-release`** holds `contents: write` and runs after `publish`, so never on a dry run.
Through `gh`, `scripts/release/github-release.mjs` creates the tag `v<version>` on the released
commit with a GitHub release of the same title, whose notes are the changelog section. When both
already exist on that commit it does nothing; a tag on another commit stops it.

Both workflows share one concurrency group. A second run waits for the one in progress and never
cancels it; GitHub keeps one waiting run per group, so a third start replaces the waiting one.
