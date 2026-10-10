# Releasing: what ships

## Overview

- [What each package ships](#what-each-package-ships): files included in each npm package.
- [Check the tarballs](#check-the-tarballs): inspect the packages before publishing.

## What each package ships

What each of the three packages holds, and how to look inside the tarballs before a release.
[Releasing](releasing.md) covers the two release workflows, and
[Releasing: repeats and approval](releasing-02.md) covers failed runs and human approval.

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

Buckle reads its version from its own `package.json` at run time
(`buckle/common/runtime/version.ts`), so `buckle --version` matches what is published.

## Check the tarballs

The Stage Buckle workflow's `pack` job checks its own tarballs. To look at them on a machine:

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
