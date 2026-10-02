# Contributing to Buckle

## Setup

- Node.js 24 or newer.
- pnpm 10.33.2, as pinned by `packageManager` in the root `package.json`
  (`corepack enable` picks it up).

```sh
pnpm install --frozen-lockfile
```

Before opening a pull request, run the same gate CI runs:

```sh
pnpm release:check
```

It checks the runtime pins and the route tables, typechecks, runs every package test and the
release-script tests, builds, installs the packed packages in a scratch directory and drives
them, and audits the production dependencies, including the code bundled into the server build.

## Repository layout

| Path | Package | What it is |
|---|---|---|
| `harness-rpc/` | `@5straps/buckle` | Buckle: the CLI, the MCP server, and the HTTP server |
| `packages/protocol/` | `@5straps/protocol` | The wire schemas Buckle speaks |
| `packages/runtime/` | `@5straps/runtime` | Runtime primitives: service lifetimes, logging, SQLite, and Nitro adapters |
| `scripts/` | - | Release checks |
| `test/` | - | Tests of the release scripts |

## House rules

- This is a greenfield product. Change schemas, configuration, and callers directly. Do not add
  deprecated aliases, dual writes, migration bridges, or release-long compatibility fallbacks
  unless the maintainer asks for compatibility. Update affected code, tests, and docs together.
- Documentation pages stay at or under 1100 words. Split a long page into numbered pages.
- Write every id with its title, for example "BUCKLE-D01 (its title)", never the bare id.
- No em-dashes in code, docs, or commit messages.
- Commits are scoped by path and use conventional subjects. The subject says what changed and
  the body says why.
- A fix comes with a test that fails without it.

## Contributor terms

Contributions are accepted under Apache-2.0 (see [LICENSE](LICENSE) and [NOTICE](NOTICE)).
Opening a pull request offers your change under that license. There is no contributor
license agreement and no sign-off requirement.

## Security

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Questions

Open an issue at <https://github.com/wuiyang/buckle/issues>.
