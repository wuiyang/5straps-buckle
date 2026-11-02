# Buckle

Buckle is an approval and sandbox runtime for AI agents: a tool-execution node that any AI
harness can drive over CLI, MCP (the Model Context Protocol, a standard for giving agents tools),
or HTTP, which runs what its owner allows, asks a person before anything else runs, and refuses
the rest.

Buckle is at version 0.1. CI runs on Linux only; macOS and Windows have had less testing.

## What you get today

- **Three faces, one policy.** The CLI, MCP over stdio, and HTTP offer the same tools and approvals.
- **Approvals.** Every call is allowed, asked, or denied. A person answers an ask once, for the
  session, or always.
- **[A sandboxed shell](./docs/sandbox-and-tools.md).** bubblewrap (a Linux sandbox) or Seatbelt
  (macOS's built-in sandbox; shell isolation and mounts off) holds each command; without one, the shell pack is withheld. On Linux,
  commands by default run on private workspace copies and publish checked changes.
- **Tools in one workspace.** Files, Git and GitHub pull requests, web fetch and search, language
  servers, and a browser through agent-browser (a command-line browser for agents;
  [sessions](./docs/browser-login-02.md)). Git and language servers run on the host, outside the sandbox, and are off until you turn them on.
- **Code mode.** An agent sends one JavaScript program that calls the tools. Each call is
  judged like a direct one, and only the result goes back to the model.
- **[Secret references](./docs/secrets.md).** An agent names a dotenv value, as
  `{{file:.env.local:NAME}}`, in a command, a browser fill, or a request header, and never sees it.
- **[Change history](./docs/change-history.md).** Each change is a checkpoint, kept for the last 10
  turns by default. Restoring one asks a person.
- **[An audit log](./docs/audit-log.md).** Each workspace logs what Buckle does, read with
  `buckle log`. The log is append-only, not tamper-proof.
- **Workspaces and mounts.** One node serves many folders, each with its own token, policy, and
  mounts. `buckle cp` copies a file without passing it through the model.
- **[A decision AI](./docs/judge.md).** Optional and off by default, it rates asks with models you
  configure. In automated mode a `safe` rating can pass an interpreter ask; destructive asks always
  reach a person.
- **[A service](./docs/service.md).** `buckle service install` starts the node at login.
- **[Rings](./docs/rings.md), optionally.** Rings, the separate 5straps control plane for agents, can
  pair with a node to collect its logs and relay approvals. Buckle runs without it.

## Install

Buckle needs Node.js 24 or newer.

```bash
npm i -g @5straps/buckle
```

To build from a clone, see
[building and testing](./docs/dev/building-and-testing.md).

## First run

```bash
cd ~/some/project
buckle init
```

`buckle init` sets up the node once, writing its settings and admin credential to
`buckle.env`, owner-only, in the state directory: `~/.5straps/buckle`, or the absolute path in
`BUCKLE_STATE_DIR`. It serves the current directory as a workspace, shown to the agent as
`/workspace`, and prints its agent token once. `--yes` takes the defaults; another
`buckle init` adds a workspace.

Only a process sandbox hides the state directory from shell commands: with
`BUCKLE_SANDBOX=none`, a shell command can read `buckle.env` without an ask.

## Three faces

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
`/mcp`, each serving the bearer token's workspace. No TLS is built in; put a proxy in front for
anything beyond this host.

## Approvals

The first write to a directory, credential files, destructive commands, and private-network URLs
ask. Reads outside the workspace ask when no mount is set. A granted directory never unlocks a
credential file inside it, and destructive commands never offer the scope always.

The approver sees the full action before anything runs, common credential shapes hidden
([known limits](./docs/known-limits.md#credential-hiding)),
and the decision binds the whole call. The answer can come from a prompt in the terminal running
`buckle serve`, MCP elicitation over stdio where the host supports it, or `buckle approve <token>`
from another terminal.

```bash
buckle approvals --watch
buckle approve <token> --scope session
buckle policy allow-command 'pnpm {build,test} *'
buckle policy allow-url localhost:3000
```

Owners set policy with `buckle policy`: command globs, an approved host and URL list, and where
the folder shows. Deny wins.

`buckle workspace mount add <local>:<sandbox>[:ro]` shares more folders
([mounts](./docs/mounts.md)).
`buckle policy dangerously-allow on` removes the person from most asks and is off by default
([Approvals](./docs/approvals.md#dangerously-allow)).

## Roadmap

[Known limits](./docs/known-limits.md) lists every
known gap. These are open now:

- **Desktop control.** There is no desktop pack yet. It would build on agent-desktop, a tool that
  lets an agent drive desktop apps, as the browser pack builds on agent-browser.
- **Real-machine checks.** The service install has not run under a real systemd, launchd, or Task
  Scheduler (the service managers of Linux, macOS, and Windows), and Windows is experimental.
- **Command reading.** Buckle refuses or asks about a command it cannot read whole, such as shell
  text built at run time. Credential hiding covers common shapes only.
- **History size.** A rewrite with the same content, and a folder an older build recorded, keep
  copies outside the size cap.
- **`code_run` errors.** A script that throws still answers the call as `ok`, with the failure in
  the result.
- **The decision AI.** It has not run against a live AI gateway, Jev (its quick rater), or Socket
  (a package-security service); the tests imitate them.
- **Copies and secrets.** `buckle cp` cannot copy between two nodes, and secret references read
  dotenv files only.

**Plan.** The direction is a desktop pack, live checks on real machines, and a smarter command
reader, then more secret sources, such as Rings or a password manager, and a Rings view of the
decision AI's verdict. What comes first depends on what people ask for.

**Feedback.** Report a bug or request a feature in
[GitHub issues](https://github.com/wuiyang/5straps-buckle/issues), and ask questions or share
ideas in [Discussions](https://github.com/wuiyang/5straps-buckle/discussions).

## Documentation

The [documentation index](./docs/README.md) lists
every page, from installing to troubleshooting.

## Packages

| Path | Package | What it is |
|---|---|---|
| `buckle/` | `@5straps/buckle` | The CLI, MCP server, and HTTP server |
| `packages/protocol/` | `@5straps/protocol` | The wire schemas |
| `packages/runtime/` | `@5straps/runtime` | Runtime primitives |

Settings are in [`.env.example`](./.env.example).
To work on Buckle, see [CONTRIBUTING.md](./CONTRIBUTING.md).
Changes are in [CHANGELOG.md](./CHANGELOG.md).

## Security

Report a vulnerability privately through GitHub private vulnerability reporting, as
[SECURITY.md](./SECURITY.md) describes, not in a
public issue.

## License

Apache-2.0. Copyright 2026 The 5straps Authors. See [LICENSE](./LICENSE)
and [NOTICE](./NOTICE).
