# Releasing

Three packages publish to npm. `@5straps/buckle`, the approval and sandbox runtime and its
`buckle` binary, depends on the other two, so they go first: `@5straps/protocol` and
`@5straps/runtime`, then `@5straps/buckle`. `pnpm -r publish` walks the workspace in that
dependency order. Nothing in CI publishes; the workflow only verifies.

## Before the first release

- Log in to npm (`npm login`, then `npm whoami`) with an account that may publish under the
  `@5straps` scope. Each package sets `publishConfig.access` to `public`.
- Install the GitHub CLI and log it in. `pnpm release` asks it for the CI results.
- Keep tokens out of the repository and out of the shell history.

## Version and changelog

The three packages share one version.

```bash
pnpm version:set 0.2.0
```

`version:set` runs `npm version 0.2.0` in each of the three packages. Buckle reads its version
from its own `package.json` at run time (`buckle/common/runtime/version.ts`), so
`buckle --version` and the manifest always match what was published.

`@5straps/buckle` names the other two as `workspace:*`. `pnpm publish` replaces that with the
exact version when it packs; `npm publish` does not, so always publish with pnpm.

The changelog comes from commit subjects through changelogen, a root dev dependency configured
under `changelog` in the root `package.json` (repository, commit types, no author lines):

```bash
pnpm exec changelogen --from <last release tag> --to HEAD -r <version> --output CHANGELOG.md
```

`-r` heads the new section `v<version>` and links its comparison to that tag; without it the
heading is a commit range. It neither tags nor bumps a version.

Read the result before committing it. Commit the version and the changelog together, push the
branch, and wait for CI.

## pnpm release

```bash
git fetch origin
pnpm release
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
3. `pnpm -r publish --access public` publishes each package. Every package's `prepack` script
   builds it first, so a stale `dist/` is never published.

Tag the released commit, for example `git tag v0.2.0`, so the next changelog has a starting
point.

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

```bash
mkdir -p /tmp/buckle-pack
for name in protocol runtime buckle; do
  pnpm --filter "@5straps/$name" pack --pack-destination /tmp/buckle-pack
done
tar -xzOf /tmp/buckle-pack/5straps-buckle-0.2.0.tgz package/package.json | grep '@5straps/'
tar -tzf /tmp/buckle-pack/5straps-buckle-0.2.0.tgz | less
```

The dependencies must name exact versions, never `workspace:*`, and the listing must hold
`package/dist/main.js`, `package/.output/server/index.mjs`, and `package/skills/buckle/SKILL.md`.
`pnpm test:package`, part of the release check, goes further: it installs the three tarballs
with npm in a scratch directory, with install scripts off and optional dependencies left out, and
drives the installed `buckle` over the CLI, HTTP, and MCP. [Building and
testing](building-and-testing.md#the-release-check) lists what it covers.
