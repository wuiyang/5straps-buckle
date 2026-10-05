# Releasing: repeats and by hand

What to do when a release run fails, how to release without GitHub Actions, and what the three
packages ship. [Releasing](releasing.md) covers the one-time setup and the two workflows.

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
- **Release failed.** Run it again on the same `main`. `pack` plans again, `publish` skips every
  package the registry already holds at that version, and `github-release` leaves a tag and
  release already on the commit as they are. Finish a half-published version this way, never with
  a new version.
- **A repeat right after a publish** can find the registry not yet answering for that package, try
  it again, and fail on npm's refusal of the duplicate. Nothing is harmed; run Release again
  later.
- **A tag `v<version>` names another commit.** `pack` and `github-release` both stop: that version
  came from somewhere else. Find out where before moving or deleting the tag.

## Releasing by hand

The fallback when Actions cannot publish. It needs an npm login (`npm login`, then `npm whoami`)
with an account that may publish under the `@5straps` scope, and the GitHub CLI, `gh`, logged in:
`pnpm release` asks it for the CI results. Keep tokens out of the repository and out of the shell
history.

```bash
git fetch origin --tags
pnpm release:prepare 0.2.0
```

`release:prepare` runs `scripts/release/prepare.mjs`, with the same checks and changes as step
one. Read the diff, commit the four files as `chore(release): v0.2.0`, push to `main`, and wait
for both checks, which a push by a person starts. Then:

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
   - both CI jobs, `verify` and `package-arm64`, run by GitHub Actions, have a latest run on that
     exact commit that completed successfully. It reads the check runs with
     `gh api repos/<owner>/<repo>/commits/<sha>/check-runs`, taking the repository from
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

## What each package ships

npm always adds `package.json` and `README.md`. The rest is each package's `files` list:

| Package | `files` |
|---|---|
| `@5straps/protocol` | `dist`, `src`, `LICENSE`, `NOTICE` |
| `@5straps/runtime` | `dist`, `src`, `LICENSE`, `NOTICE` |
| `@5straps/buckle` | `dist`, `.output`, `main.ts`, `common`, `cli`, `mcp`, `server`, `skills`, `LICENSE`, `NOTICE`, `THIRD_PARTY_NOTICES.md` |

For `@5straps/buckle`: `dist/main.js` is the `bin`. `.output` is the built HTTP app, which
`buckle serve` imports at run time. `skills/buckle/SKILL.md` is read at run time as the root
skill, and each pack's `SKILL.md` is copied into `dist` by the build. The sources ship beside the
build. `THIRD_PARTY_NOTICES.md` covers the code bundled into `.output`.

## Check the tarballs

The Release workflow's `pack` job checks its own tarballs. To look at them on a machine:

```bash
mkdir -p ../buckle-pack
for name in protocol runtime buckle; do
  pnpm --filter "@5straps/$name" pack --pack-destination "$PWD/../buckle-pack"
done
tar -xzOf ../buckle-pack/5straps-buckle-0.2.0.tgz package/package.json | grep '@5straps/'
tar -tzf ../buckle-pack/5straps-buckle-0.2.0.tgz | less
```

pnpm names a tarball after the package without its `@`, the slash made a hyphen, then the
version. The dependencies must name exact versions, never `workspace:*`, and the listing must hold
`package/dist/main.js`, `package/.output/server/index.mjs`, and `package/skills/buckle/SKILL.md`.
`pnpm pack` builds through each `prepack` script, which an npm config with `ignore-scripts` skips:
build first with `pnpm -r build` on such a machine. `pnpm test:package`, part of the release
check, goes further: it installs the three tarballs with npm in a scratch directory, with install
scripts off and optional dependencies left out, and drives the installed `buckle` over the CLI,
HTTP, and MCP. [Building and testing](building-and-testing.md#the-release-check) lists what it
covers.
