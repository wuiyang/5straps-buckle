# Buckle

Buckle is an approval and sandbox runtime for AI agents: a tool-execution node that any AI
harness can drive over CLI, MCP, or HTTP, which runs what its owner allows, asks a person
before anything else runs, and refuses the rest.

It gives an agent files, a shell, Git, web fetch, a browser (once agent-browser is installed),
and language tools inside one workspace, and logs its actions.

## Install

Buckle needs Node.js 24 or newer.

```bash
npm i -g @5straps/buckle
```

To build from a clone (pnpm 10.33.2):

```bash
pnpm install
pnpm build
cd buckle && npm link
```

## First run

```bash
cd ~/some/project
buckle init
```

`buckle init` sets up the node once, writing its settings and admin credential to
`buckle.env`, owner-only, in the state directory: `~/.5straps/buckle`, or the absolute path in
`BUCKLE_STATE_DIR`. It serves the current directory as a workspace, shown to the agent as
`/workspace`, and prints its agent token once. It asks about packs, the shell, host Git, and
network lists; `--yes` takes the defaults. `buckle workspace set` and `buckle policy` change them
later; another `buckle init` adds a workspace.

The state directory holds each workspace's settings, grants, approvals, and action log.
Buckle's file tools refuse to read it. Only a process sandbox, bubblewrap on Linux or Seatbelt on
macOS, hides it from shell commands: with `BUCKLE_SANDBOX=none`, a shell command can read
`buckle.env` without an ask.

## Three faces

Each face has the same tools and approvals.

**CLI**

```bash
buckle tools                  # what this node offers
buckle fs read src/index.ts   # run a tool
buckle manifest               # loaded packs, and why others did not load
```

**MCP** over stdio, for MCP hosts:

```bash
claude mcp add buckle -- buckle mcp
```

**HTTP**: `buckle serve` listens on `127.0.0.1:4320`, with native RPC under `/v1` and MCP on
`/mcp`, each serving the bearer token's workspace. No TLS is built in; put a
proxy in front for anything beyond this host. `buckle service install --now` runs it at every
login ([service](https://github.com/wuiyang/5straps-buckle/blob/main/docs/service.md)).

## Approvals

Every call meets one of three answers: **allow**, **ask**, or **deny**. The first write to a
directory, credential files, destructive commands, and private-network URLs ask. Reads outside
the workspace ask when no mount is set; the `/workspace` mount `buckle init` writes refuses them.
A granted directory never unlocks a credential file inside it.

A person answers an ask with a scope: **once**, **session**, or **always**. Destructive
commands never offer always. The approver sees the full action before anything runs, common
credential shapes hidden
([known limits](https://github.com/wuiyang/5straps-buckle/blob/main/docs/known-limits.md#credential-hiding)),
and the decision binds the whole call.

The answer can come from a prompt in the terminal running `buckle
serve`, MCP elicitation over stdio where the host supports it (HTTP `/mcp` never elicits), or
`buckle approve <token>` from another terminal. Buckle can post each pending approval to
the relay `BUCKLE_APPROVAL_WEBHOOK` names, for a person away from the machine. A
call waits 15 seconds by default (`approvalWaitMs`), 30 at most on `/mcp`; sent again, it joins its ask.

```bash
buckle approvals --watch
buckle approve <token> --scope session
buckle grants list
```

Owners set policy with `buckle policy`: command allow and deny globs matched one shell
word at a time, an approved host and URL list, and where the folder shows. Deny wins.

```bash
buckle policy allow-command 'pnpm {build,test} *'
buckle policy allow-url localhost:3000
buckle policy mount /workspace
```

`buckle workspace mount add <local>:<sandbox>[:ro]` shares more folders ([mounts](https://github.com/wuiyang/5straps-buckle/blob/main/docs/mounts.md)).

`buckle policy dangerously-allow on` (level `command`) removes the person: every ask in that workspace is allowed except a secret file's, which still reaches a person. `all` allows that too. Deny rules and the mount boundary still refuse; a path outside the workspace still asks.
Off by default;
[Approvals](https://github.com/wuiyang/5straps-buckle/blob/main/docs/approvals.md#dangerously-allow)
documents it.

## Sandbox

- Linux: shell commands run under bubblewrap.
- macOS: shell commands run under Seatbelt once `shell.isolation` is off and no mount
  is set, since both need bubblewrap.
- Elsewhere, or with no sandbox, the shell pack is withheld. `BUCKLE_SANDBOX=none`
  acknowledges that commands run unsandboxed; it too needs
  `shell.isolation` off and no mount.

On Linux, shell tools work on private workspace copies by default and publish
changes through conflict-checked checkpoints; `shell.isolation` off selects shared-workspace
execution. Host Git and forge
tools (`packs.hostGit`) and host language servers (`packs.hostLsp`) are off by default: they
run outside the sandbox.

## Audit log

Each workspace records what Buckle did in `actions.jsonl` in its state directory. Read it with:

```bash
buckle log --limit 20
buckle log --json
```

Arguments are trimmed for the log: every string becomes its length, like
`[5 characters]`, except a file copy's path and digest, and any value under a credential-named key reads `[redacted]`. The log is append-only,
not tamper-proof.

## Rings

Rings, the 5straps agent control plane, can pair with Buckle nodes to collect
action logs and refused calls, relay pending approvals, and, where the experimental admin face is
on, push policy; Buckle runs without it.

## Documentation

For users:

- [Installing Buckle](https://github.com/wuiyang/5straps-buckle/blob/main/docs/install.md) ([state files](https://github.com/wuiyang/5straps-buckle/blob/main/docs/install-02.md)):
  requirements, platform status, and upgrading.
- [First run](https://github.com/wuiyang/5straps-buckle/blob/main/docs/first-run.md) ([credentials](https://github.com/wuiyang/5straps-buckle/blob/main/docs/first-run-02.md)): `buckle init`, the two credentials, and the CLI, MCP, and
  HTTP faces.
- [Workspaces](https://github.com/wuiyang/5straps-buckle/blob/main/docs/workspaces.md) ([settings](https://github.com/wuiyang/5straps-buckle/blob/main/docs/workspaces-02.md), [defaults](https://github.com/wuiyang/5straps-buckle/blob/main/docs/workspaces-03.md), and [moving from 0.1](https://github.com/wuiyang/5straps-buckle/blob/main/docs/workspaces-04.md)):
  one node, many folders, and their tokens.
- [Approvals](https://github.com/wuiyang/5straps-buckle/blob/main/docs/approvals.md): what asks, the scopes, the destructive floor, where to
  answer, and the dangerously-allow switch.
- [Policy](https://github.com/wuiyang/5straps-buckle/blob/main/docs/policy.md) ([what Buckle reads](https://github.com/wuiyang/5straps-buckle/blob/main/docs/policy-02.md),
  [what stays unread](https://github.com/wuiyang/5straps-buckle/blob/main/docs/policy-03.md)): command globs, network lists, files, and
  when a change applies.
- [Sandbox and tools](https://github.com/wuiyang/5straps-buckle/blob/main/docs/sandbox-and-tools.md): packs, sandboxing per platform, shell isolation,
  and [scripts](https://github.com/wuiyang/5straps-buckle/blob/main/docs/code-mode.md).
- [Copying files](https://github.com/wuiyang/5straps-buckle/blob/main/docs/copy.md) ([checks](https://github.com/wuiyang/5straps-buckle/blob/main/docs/copy-02.md)): `buckle cp`, its token, approvals, and limits.
- [Secrets](https://github.com/wuiyang/5straps-buckle/blob/main/docs/secrets.md): secret references in commands, browser fills, and fetch headers; values never shown.
- [Using your own browser](https://github.com/wuiyang/5straps-buckle/blob/main/docs/browser-login.md): profile folders, your own Chrome, and
  Chromium arguments.
- [The audit log](https://github.com/wuiyang/5straps-buckle/blob/main/docs/audit-log.md): what `actions.jsonl` records and trims.
- [Rings](https://github.com/wuiyang/5straps-buckle/blob/main/docs/rings.md): the optional pairing and its settings.
- [Troubleshooting](https://github.com/wuiyang/5straps-buckle/blob/main/docs/troubleshooting.md) ([refused commands](https://github.com/wuiyang/5straps-buckle/blob/main/docs/troubleshooting-02.md)): the first
  failures, with their messages.
- [Known limits](https://github.com/wuiyang/5straps-buckle/blob/main/docs/known-limits.md): what Buckle does not yet read or hide.

For developers:

- [Architecture](https://github.com/wuiyang/5straps-buckle/blob/main/docs/dev/architecture.md) ([state and packs](https://github.com/wuiyang/5straps-buckle/blob/main/docs/dev/architecture-02.md)),
  [Building and testing](https://github.com/wuiyang/5straps-buckle/blob/main/docs/dev/building-and-testing.md),
  and [Releasing](https://github.com/wuiyang/5straps-buckle/blob/main/docs/dev/releasing.md)
  ([setup](https://github.com/wuiyang/5straps-buckle/blob/main/docs/dev/releasing-04.md), [repeats](https://github.com/wuiyang/5straps-buckle/blob/main/docs/dev/releasing-02.md), and [tarballs](https://github.com/wuiyang/5straps-buckle/blob/main/docs/dev/releasing-03.md)).
- Research records: [command matching](https://github.com/wuiyang/5straps-buckle/blob/main/docs/dev/research/command-matching.md) and
  [transport and terminal packages](https://github.com/wuiyang/5straps-buckle/blob/main/docs/dev/research/packages.md).

## Packages

| Path | Package | What it is |
|---|---|---|
| `buckle/` | `@5straps/buckle` | Buckle: the CLI, MCP server, and HTTP server |
| `packages/protocol/` | `@5straps/protocol` | The wire schemas Buckle speaks |
| `packages/runtime/` | `@5straps/runtime` | Runtime primitives Buckle is built on |

Settings are in [`.env.example`](https://github.com/wuiyang/5straps-buckle/blob/main/.env.example).
To work on Buckle, see [CONTRIBUTING.md](https://github.com/wuiyang/5straps-buckle/blob/main/CONTRIBUTING.md).
Changes are in [CHANGELOG.md](https://github.com/wuiyang/5straps-buckle/blob/main/CHANGELOG.md).

## Security

Report a vulnerability privately through GitHub private vulnerability reporting, as
[SECURITY.md](https://github.com/wuiyang/5straps-buckle/blob/main/SECURITY.md) describes, not in a
public issue.

## License

Apache-2.0. Copyright 2026 The 5straps Authors. See [LICENSE](https://github.com/wuiyang/5straps-buckle/blob/main/LICENSE)
and [NOTICE](https://github.com/wuiyang/5straps-buckle/blob/main/NOTICE).
