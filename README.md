# Buckle

In short, Buckle is a lightweight remote execution harness for AI agents: a small program you
install on a machine, so an agent can work there through tools you allow.

- **Goal.** Plug and play your environment, so it is ready for an agent to work in.
- **Why.** Let AI work across devices without exposing the whole device. Giving an agent SSH
  (remote shell login) access hands it everything that account can do. Buckle gives it only the
  tools, folders, and sites you allow, and asks a person before anything else.
- **Rules.** Fine-grained static restrictions, checked before anything runs: command globs
  (patterns), an approved URL list, mounts (the folders an agent sees), and credential-file
  protection.
- **Near future.** More tools through plugins, which Buckle calls packs. The first planned is
  desktop control, built on agent-desktop (a tool that lets an agent drive desktop apps). Simpler
  deployment and exportable rules follow.
- **Growth plan.** A multiplayer, centralized AI session server for internal enterprise use,
  building on Rings (the separate 5straps control plane for agents), with audit logs, single
  sign-on through OIDC (OpenID Connect, a login standard), background agents, teammate agents, and
  more. None of this exists today.

Buckle is at version 0.1. CI runs on Linux only; macOS and Windows have had less testing.

## Features

- **Multiple entry points.** The command line (CLI), MCP (the Model Context Protocol, a standard
  for giving agents tools) over stdio, and HTTP offer the same tools and approvals.
- **Approvals.** Every call is allowed, asked, or denied. A person answers an ask.
- **[A sandboxed shell](./docs/sandbox-and-tools.md).** bubblewrap (a Linux sandbox) or Seatbelt
  (macOS's built-in sandbox; shell isolation and mounts off) holds each command; without one, the
  shell pack is withheld. On Linux, commands by default run on private workspace copies and publish
  checked changes.
- **Tools in one workspace.** Files, Git and GitHub pull requests, web fetch and search, and
  language servers. Git and language servers run on the host, outside the sandbox, and are off
  until you turn them on.
- **A browser, on the same URL list.** The browser pack drives agent-browser (a command-line
  browser for agents, installed separately; [sessions](./docs/browser-login-02.md)). With a fresh
  browser, Buckle passes the approved list's hosts to its `--allowed-domains`, so clicks,
  redirects, and page requests stay on them. With a profile folder or an attached Chrome, the list
  is not passed, and Buckle warns. Chrome regularly fixes bugs that attackers already exploit
  through web pages, such as
  [CVE-2026-2441](https://chromereleases.googleblog.com/2026/02/stable-channel-update-for-desktop_13.html),
  a memory bug in its CSS handling that Google said had an exploit in the wild, so limiting where
  an agent can browse reduces that risk.
- **Code mode.** An agent sends one JavaScript program that calls the tools. Each call is
  judged like a direct one, and only the result goes back to the model.
- **[Secret references](./docs/secrets.md).** An agent names a dotenv value, as
  `{{file:.env.local:NAME}}`, in a command, a browser fill, or a request header, and never sees it.
- **[Change history](./docs/change-history.md).** Each change is a checkpoint, kept for the last
  10 turns by default. Restoring one asks a person.
- **[An audit log](./docs/audit-log.md).** Each workspace logs what Buckle does, read with
  `buckle log`. The log is append-only, not tamper-proof.
- **Workspaces and mounts.** One node serves many folders, each with its own token and policy.
  `buckle cp` copies a file without passing it through the model.
- **[A decision AI](./docs/judge.md).** Optional and off by default, it rates asks with models you
  configure. Destructive asks always reach a person.
- **[A service](./docs/service.md).** `buckle service install` starts the node at login.
- **[Rings](./docs/rings.md), optionally.** Rings can pair with a node to collect its logs and
  relay approvals. Buckle runs without it.

## Install

Buckle needs Node.js 24 or newer.

```bash
npm i -g @5straps/buckle
```

To build from a clone, see [building and testing](./docs/dev/building-and-testing.md).

## First run

```bash
cd ~/some/project
buckle init
```

`buckle init` sets up the node once, writing its settings and admin credential to an owner-only
`buckle.env` in the state directory (`~/.5straps/buckle`, or `BUCKLE_STATE_DIR`). It serves the
current directory as a workspace and prints its agent token once. Another `buckle init` adds a
workspace. With `BUCKLE_SANDBOX=none`, a shell command can read `buckle.env` without an ask.

## Entry points

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
ask ([approvals](./docs/approvals.md)). The approver sees the full action before anything runs,
common credential shapes hidden ([known limits](./docs/known-limits.md#credential-hiding)), and the
decision binds the whole call.

```bash
buckle approvals --watch
buckle approve <token> --scope session
buckle policy allow-command 'pnpm {build,test} *'
```

Deny wins. `buckle workspace mount add <local>:<sandbox>[:ro]` shares more folders
([mounts](./docs/mounts.md)). `buckle policy dangerously-allow on` removes the person from most
asks and is off by default ([details](./docs/approvals.md#dangerously-allow)).

## Roadmap

[Known limits](./docs/known-limits.md) lists every known gap. These are open now:

- **Real-machine checks.** The service install has not run under a real systemd, launchd, or Task
  Scheduler (the service managers of Linux, macOS, and Windows), and Windows is experimental.
- **Command reading.** Buckle asks about or refuses a command it cannot read whole.
- **History size.** Some copies fall outside the size cap.
- **`code_run` errors.** A script that throws still answers the call as `ok`.
- **The decision AI.** Not yet run against a live AI gateway, Jev (its quick rater), or Socket
  (a package-security service).
- **Copies and secrets.** `buckle cp` cannot copy between two nodes, and secret references read
  dotenv files only.

**Feedback.** Report a bug or request a feature in
[GitHub issues](https://github.com/wuiyang/5straps-buckle/issues), and ask questions or share
ideas in [Discussions](https://github.com/wuiyang/5straps-buckle/discussions).

## Documentation

The [documentation index](./docs/README.md) lists every page.

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
[SECURITY.md](./SECURITY.md) describes, not in a public issue.

## License

Apache-2.0. Copyright 2026 The 5straps Authors. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
