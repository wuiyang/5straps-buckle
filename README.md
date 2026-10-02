# Buckle

Buckle is an approval and sandbox runtime for AI agents: a tool-execution node that any AI
harness can drive over CLI, MCP, or HTTP, which runs what its owner allows, asks a person
before anything else runs, and refuses the rest.

It gives an agent files, a shell, Git, web fetch, a browser (once agent-browser is installed),
and language tools inside one workspace, and keeps a log of what it actually did.

## Install

Buckle needs Node.js 24 or newer.

```bash
npm i -g @5straps/buckle
```

To build from a clone instead (pnpm 10.33.2, as pinned in `package.json`):

```bash
pnpm install
pnpm build
cd buckle && npm link
```

Shell tools need a sandbox: bubblewrap on Linux, Seatbelt on macOS (see [Sandbox](#sandbox)).

## First run

```bash
cd ~/some/project
buckle init
```

`buckle init` writes `buckle.env`, readable by its owner only, in the state directory:
`~/.5straps/buckle` by default, or the absolute path in `BUCKLE_STATE_DIR`. The file holds two
fresh credentials, `BUCKLE_AUTH_TOKEN` for agents and `BUCKLE_ADMIN_TOKEN` for setup, and the
workspace settings. The current directory becomes the workspace root, shown to the agent as
`/workspace`. In a terminal it asks which packs to enable and about the shell, host Git, and the
network lists; `--yes` takes the defaults. `buckle settings set` changes any of them later.

The state directory also holds grants, the policy, pending approvals, and the action log.
Buckle's file tools refuse to read it. Only a process sandbox, bubblewrap on Linux or Seatbelt on
macOS, hides it from shell commands: with `BUCKLE_SANDBOX=none`, a shell command can read
`buckle.env` without an ask.

## Three faces

The same tools and the same approvals sit behind each face.

**CLI**

```bash
buckle tools                  # what this node offers
buckle fs read src/index.ts   # run a tool
buckle manifest               # loaded packs, and why others did not load
```

**MCP** over stdio, for any MCP host:

```bash
claude mcp add buckle -- buckle mcp
```

**HTTP**: `buckle serve` listens on `127.0.0.1:4320`, with native RPC under `/v1` and MCP on
`/mcp`, each behind the agent token as a bearer credential. There is no TLS built in; put a
proxy in front for anything beyond the local host.

## Approvals

Every call meets one of three answers: **allow**, **ask**, or **deny**. The first write to a
directory, credential files, destructive commands, and private-network URLs ask. Reads outside
the workspace ask when no mount is set; the `/workspace` mount `buckle init` writes refuses them.
A granted directory never unlocks a credential file inside it.

A person answers an ask with a scope: **once**, **session**, or **always**. Destructive
commands never offer always. The approver sees the full action before anything runs; only
credentials are redacted from what is shown, and the decision binds the whole call.

The answer can come from wherever the person is: a prompt in the terminal running `buckle
serve`, MCP elicitation over stdio where the host supports it (HTTP `/mcp` never elicits), or
`buckle approve <token>` from another terminal. Buckle can also post each pending approval to
the relay `BUCKLE_APPROVAL_WEBHOOK` names, so a person can be reached away from the machine. A
call waits 15 seconds by default (`BUCKLE_APPROVAL_TIMEOUT_MS`) before handing the agent a token
to retry with.

```bash
buckle approvals --watch
buckle approve <token> --scope session
buckle grants list
```

Owners set the policy with `buckle policy`: command allow and deny globs matched one shell
word at a time, an approved host and URL list, and a mount that shows only `/workspace`.
Deny wins.

```bash
buckle policy allow-command 'pnpm {build,test} *'
buckle policy allow-url localhost:3000
buckle policy mount /workspace
```

`buckle policy dangerously-allow on` removes the person: every ask in that workspace becomes an
allow, destructive commands included. Explicit deny rules, the node's policy over a registered
workspace, and the mount boundary still refuse, and a path outside the workspace root still asks.
It is off by default, and
[Approvals](https://github.com/wuiyang/buckle/blob/main/docs/approvals.md#dangerously-allow)
documents it.

## Sandbox

- Linux: shell commands run under bubblewrap.
- macOS: shell commands run under Seatbelt once `BUCKLE_SHELL_ISOLATION=false` is set and no
  workspace mount is, since shell isolation and the mount both need bubblewrap.
- Elsewhere, or with no sandbox available, the shell pack is withheld. `BUCKLE_SANDBOX=none`
  is the explicit acknowledgement that commands run unsandboxed; it too needs
  `BUCKLE_SHELL_ISOLATION=false` and no mount.

On Linux, shell tools work on private copies of the workspace by default and publish
changes through conflict-checked checkpoints; `BUCKLE_SHELL_ISOLATION=false` selects
shared-workspace execution. Host Git and forge tools (`BUCKLE_ALLOW_HOST_GIT`) and host
language servers (`BUCKLE_ALLOW_HOST_LSP`) are off by default, because they run outside the
sandbox. `buckle manifest` explains any tool that is unavailable.

## Audit log

Each workspace records what Buckle did in `actions.jsonl` in its state directory. Read it
back with:

```bash
buckle log --limit 20
buckle log --json
```

Arguments are trimmed for the log: every string becomes its length, such as
`[5 characters]`, and any value under a credential-named key reads `[redacted]`. The log is a plain append-only file,
not a tamper-proof record.

## Rings

Rings, the 5straps agent control plane, can optionally pair with Buckle nodes to collect their
action logs and refused calls, relay pending approvals, and, where the experimental admin face is
on, push policy; Buckle runs without it.

## Documentation

For users:

- [Installing Buckle](https://github.com/wuiyang/buckle/blob/main/docs/install.md): requirements, platform status, upgrading, and the
  state directory.
- [First run](https://github.com/wuiyang/buckle/blob/main/docs/first-run.md): `buckle init`, the two credentials, and the CLI, MCP, and
  HTTP faces.
- [Approvals](https://github.com/wuiyang/buckle/blob/main/docs/approvals.md): what asks, the scopes, the destructive floor, where to
  answer, and the dangerously-allow switch.
- [Policy](https://github.com/wuiyang/buckle/blob/main/docs/policy.md): command globs, reading limits, network lists, files, and when a
  restart is needed.
- [Sandbox and tools](https://github.com/wuiyang/buckle/blob/main/docs/sandbox-and-tools.md): packs, sandboxing per platform, and shell
  isolation.
- [The audit log](https://github.com/wuiyang/buckle/blob/main/docs/audit-log.md): what `actions.jsonl` records and trims.
- [Rings](https://github.com/wuiyang/buckle/blob/main/docs/rings.md): the optional pairing and its settings.
- [Troubleshooting](https://github.com/wuiyang/buckle/blob/main/docs/troubleshooting.md): the first failures, with their messages.

For developers:

- [Architecture](https://github.com/wuiyang/buckle/blob/main/docs/dev/architecture.md), [Building and testing](https://github.com/wuiyang/buckle/blob/main/docs/dev/building-and-testing.md),
  and [Releasing](https://github.com/wuiyang/buckle/blob/main/docs/dev/releasing.md).
- Research records: [command matching](https://github.com/wuiyang/buckle/blob/main/docs/dev/research/command-matching.md) and
  [transport and terminal packages](https://github.com/wuiyang/buckle/blob/main/docs/dev/research/packages.md).

## Packages

| Path | Package | What it is |
|---|---|---|
| `buckle/` | `@5straps/buckle` | Buckle: the CLI, the MCP server, and the HTTP server |
| `packages/protocol/` | `@5straps/protocol` | The wire schemas Buckle speaks |
| `packages/runtime/` | `@5straps/runtime` | Runtime primitives Buckle is built on |

Settings are documented in [`.env.example`](https://github.com/wuiyang/buckle/blob/main/.env.example).
To work on Buckle, see [CONTRIBUTING.md](https://github.com/wuiyang/buckle/blob/main/CONTRIBUTING.md).
Changes are listed in [CHANGELOG.md](https://github.com/wuiyang/buckle/blob/main/CHANGELOG.md).

## Security

Report a vulnerability privately through GitHub private vulnerability reporting, as
[SECURITY.md](https://github.com/wuiyang/buckle/blob/main/SECURITY.md) describes, not in a
public issue.

## License

Apache-2.0. Copyright 2026 5straps. See [LICENSE](https://github.com/wuiyang/buckle/blob/main/LICENSE)
and [NOTICE](https://github.com/wuiyang/buckle/blob/main/NOTICE).
