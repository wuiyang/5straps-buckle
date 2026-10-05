# Building and testing

How to build Buckle, the approval and sandbox runtime for AI agents, from a clone, and how its
tests are organised. [CONTRIBUTING.md](../../CONTRIBUTING.md) has the house rules for a pull
request.

## Clone and install

Node.js 24 or newer, and pnpm 10.33.2, which `packageManager` in the root `package.json` pins
(`corepack enable` picks it up).

```bash
git clone https://github.com/wuiyang/5straps-buckle.git
cd 5straps-buckle
CI=true pnpm install --frozen-lockfile
```

`CI=true` runs pnpm as the CI workflow does, without prompts. `pnpm-workspace.yaml` lets one
dependency run its install script, `node-pty`, which compiles from source on Linux. Where your
npm or pnpm configuration sets `ignore-scripts=true`, it is left unbuilt; build it and check that
it loads, as the arm64 CI job does:

```bash
npm_config_ignore_scripts=false pnpm -r rebuild node-pty
pnpm --filter @5straps/buckle exec node -e "require('node-pty')"
```

## Build and run

```bash
pnpm build                    # every package, in dependency order
node buckle/dist/main.js tools
pnpm dev                      # build, run buckle serve, rebuild and restart on change
```

`@5straps/protocol` and `@5straps/runtime` compile with `tsc` into `dist/`. `@5straps/buckle`
runs `scripts/build.mjs`, which compiles into `dist/`, copies every `SKILL.md`, and keeps the bin
executable, then `scripts/build-server.mjs`, which builds the Nitro app into `.output/` and lists
the packages it bundled in `.output/bundled-packages.json`. `pnpm dev` loads the repository
root's `.env`, if there is one, into the node it starts. `cd buckle && npm link` puts the build on
your `PATH` as `buckle`.

## Typecheck

```bash
pnpm typecheck
```

It builds `@5straps/protocol` and `@5straps/runtime` first, then runs `tsc` in every package;
the runtime also checks its test types and its fixture.

## Test suites

```bash
pnpm test             # pnpm test:packages, then pnpm test:scripts
pnpm test:packages    # every package's vitest suite, one package at a time
pnpm test:scripts     # the release-script tests under test/
```

`test:packages` runs the packages one after another (`--workspace-concurrency=1`) with two vitest
workers each. The counts at version 0.1.0:

| Suite | Where | Tests |
|---|---|---|
| `@5straps/buckle` | `buckle/test/`, 125 files in two projects, `unit` and `http` | 5,727: 5,724 pass and 3 skip on a Linux machine outside CI without ripgrep |
| `@5straps/runtime` | `packages/runtime/test/`, projects `unit`, `sqlite`, and `fixture` | 364 |
| `@5straps/protocol` | `packages/protocol/test/` | 29 |
| release scripts | `test/` | 20 |

The `http` project runs against the built package: its global setup builds it first
(`buckle/test/support/global-build.ts`). The runtime's `fixture` project builds its small Nitro
fixture in a global setup as well.

### The three machine-specific skips

- `buckle/test/http/security-regressions.test.ts`, "recursive credential search": two tests
  that need `rg` on `PATH`.
- `buckle/test/pty-process.test.ts`, "loads the node-pty addon on Linux CI": runs only on Linux
  with `CI=true`, where the addon must have built.

Other tests depend on the machine too. Four real-terminal tests run on Linux wherever `node-pty`
loads, and on Linux CI always, so an unbuilt addon adds four skips locally and fails CI. Some skip
on Windows or as root, the git isolation tests need `git` and `script`, and the heredoc oracle
needs `bash`. Compare the skip count between runs on one machine.

### The heredoc oracle

`buckle/test/heredoc-oracle.test.ts` checks the command reader against real bash. It builds every
heredoc and line-continuation shape from a grid of delimiters (unquoted, the three quoted forms,
and `<<-`), receiving commands (`cat`, which only expands substitutions, and `bash`, which runs
the body), and placements of a command (plain, inside substitutions under each quoting, behind
escapes, continued across lines, under `find -exec`, and nested heredocs). In each shape a
harmless `sentinel` program, which only appends its arguments to a file, stands where a dangerous
command would be. The test runs each shape under bash, collects every sentinel invocation bash
made, and asserts that each is among the commands Buckle read from the same text. It proves that
for these shapes Buckle reads a superset of what bash runs, so a deny rule or the destructive
floor sees every command a heredoc carries. It says nothing about shapes outside the grid. It
uses no network and pushes nothing, and it skips, saying so, when `bash` is missing.

## The release check

```bash
pnpm release:check
```

This is the gate CI runs on every pull request and every push to `main`: `check:runtime-pins`
(Nitro, h3, and db0 at their reviewed versions), `check:routes` (no two Nitro routes claim one
path and method), `typecheck`, `test`, `pnpm -r build`, `test:package`, and `audit:release`
(`pnpm audit --prod`, plus the packages bundled into `.output`).

`pnpm test:package` is the packaged smoke. `scripts/release/packaged-smoke.mjs` packs the three
packages, installs the tarballs with npm in a scratch directory with install scripts off and
optional dependencies left out, then drives the installed `buckle`: the CLI, `buckle serve` with
its HTTP authorization, approvals and their audit entries, a backup and restore, a clean stop on
SIGTERM, no `/setup` without an admin credential or with the experimental flag off, and MCP over
stdio. `scripts/release/runtime-fixture-smoke.mjs` installs the packed runtime beside a small
prebuilt Nitro fixture and runs it.

## Conventions

- Conventional commit subjects, `type(scope): subject`, with a body that says why. Co-author
  trailers go at the end; no sign-off is required.
- No em-dashes in code, docs, or commit messages, and documentation pages stay at or under 1100
  words.
- A fix comes with a test that fails without it.
- Run one test command at a time on a machine. The suites start real processes, sandboxes, and
  servers, and `test:packages` already runs the packages one after another.
