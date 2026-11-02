# Buckle

Buckle is a lightweight remote execution harness for AI agents: a small program you install on a
machine, so an agent can work on your remote environment with tools you allow.

- **Goal:** plug and play your environment, so it is ready for an agent to work in.
- **Why:** let AI work across devices without full device exposure, as with SSH. Buckle exposes
  only the tools, folders, and sites you allow, and asks a person before anything else.
- **Rules:** fine-grained static restrictions, checked before anything runs: command globs, an
  approved URL list, mounts, and credential-file protection.
- **Near future:** more tools through plugins, starting with desktop control on agent-desktop,
  simpler deployment, and exportable rules.
- **Growth plan:** a multiplayer, centralized AI session server for internal enterprise use,
  building on Rings, the 5straps control plane, with audit logs, OIDC, background agents, teammate
  agents, and more.

Buckle is at version 0.1. CI runs on Linux only; macOS and Windows have had less testing.

## Features

- **Multiple entry points:** the CLI, MCP over stdio, and HTTP offer the same tools and approvals.
- **Approvals:** every call is allowed, asked, or denied. A person answers an ask once, for the
  session, or always.
- **[Sandboxed shell](https://github.com/wuiyang/5straps-buckle/blob/main/docs/sandbox-and-tools.md):** bubblewrap on Linux, or Seatbelt on macOS
  with shell isolation and mounts off, holds each command; without one, the shell pack is
  withheld. On Linux, commands run on private workspace copies by default and publish checked
  changes.
- **Tools in one workspace:** files, Git and GitHub pull requests, web fetch and search, and
  language servers. Git and language servers run on the host, outside the sandbox, and are off
  until you turn them on.
- **[Agent browser with whitelist](https://github.com/wuiyang/5straps-buckle/blob/main/docs/browser-login-02.md):** only specified safe domains are
  allowed to the agent through agent-browser, and non-whitelisted URLs are blocked from opening,
  including through clicked links.
- **Code mode:** an agent sends one JavaScript program that calls the tools. Each call is judged
  like a direct one, and only the result goes back to the model.
- **[Secret references](https://github.com/wuiyang/5straps-buckle/blob/main/docs/secrets.md):** an agent names a dotenv value, as
  `{{file:.env.local:NAME}}`, in a command, a browser fill, or a request header, and never sees it.
- **[Change history](https://github.com/wuiyang/5straps-buckle/blob/main/docs/change-history.md):** each change is a checkpoint, kept for the last
  10 turns by default. Restoring one asks a person.
- **[Audit log](https://github.com/wuiyang/5straps-buckle/blob/main/docs/audit-log.md):** each workspace logs what Buckle does, read with
  `buckle log`. The log is append-only, not tamper-proof.
- **Workspaces and mounts:** one node serves many folders, each with its own token and policy.
  `buckle cp` copies a file without passing it through the model.
- **[Decision AI](https://github.com/wuiyang/5straps-buckle/blob/main/docs/judge.md):** optional and off by default, it rates asks with models you
  configure. Destructive asks always reach a person.
- **[Service](https://github.com/wuiyang/5straps-buckle/blob/main/docs/service.md):** `buckle service install` starts the node at login.
- **[Rings](https://github.com/wuiyang/5straps-buckle/blob/main/docs/rings.md), optional:** pairs with a node to collect its logs and relay approvals.

## Install

Buckle needs Node.js 24 or newer.

```bash
npm i -g @5straps/buckle
```

To build from a clone, see [building and testing](https://github.com/wuiyang/5straps-buckle/blob/main/docs/dev/building-and-testing.md).

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

**CLI:**

```bash
buckle tools                  # what this node offers
buckle fs read src/index.ts   # run a tool
buckle manifest               # loaded packs, and why others did not load
```

**MCP:** over stdio.

```bash
claude mcp add buckle -- buckle mcp
```

**HTTP:** `buckle serve` listens on `127.0.0.1:4320`, with native RPC under `/v1` and MCP on
`/mcp`, each serving the bearer token's workspace. No TLS is built in; put a proxy in front for
anything beyond this host.

## Approvals

The first write to a directory, credential files, destructive commands, and private-network URLs
ask ([approvals](https://github.com/wuiyang/5straps-buckle/blob/main/docs/approvals.md)). The approver sees the full action before anything runs,
common credential shapes hidden ([known limits](https://github.com/wuiyang/5straps-buckle/blob/main/docs/known-limits.md#credential-hiding)), and the
decision binds the whole call.

```bash
buckle approvals --watch
buckle approve <token> --scope session
buckle policy allow-command 'pnpm {build,test} *'
```

Deny wins. `buckle workspace mount add <local>:<sandbox>[:ro]` shares more folders
([mounts](https://github.com/wuiyang/5straps-buckle/blob/main/docs/mounts.md)). `buckle policy dangerously-allow on` removes the person from most
asks and is off by default ([details](https://github.com/wuiyang/5straps-buckle/blob/main/docs/approvals.md#dangerously-allow)).

## Roadmap

[Known limits](https://github.com/wuiyang/5straps-buckle/blob/main/docs/known-limits.md) lists every known gap. Open now:

- **Real-machine checks:** the service install has not run under a real systemd, launchd, or Task
  Scheduler, and Windows is experimental.
- **Command reading:** Buckle asks about or refuses a command it cannot read whole.
- **History size:** some copies fall outside the size cap.
- **`code_run` errors:** a script that throws still answers the call as `ok`.
- **Decision AI:** not yet run against a live AI gateway, Jev, or Socket.
- **Copies and secrets:** `buckle cp` cannot copy between two nodes, and secret references read
  dotenv files only.

**Feedback:** Report a bug or request a feature in
[GitHub issues](https://github.com/wuiyang/5straps-buckle/issues), and ask questions or share
ideas in [Discussions](https://github.com/wuiyang/5straps-buckle/discussions).

## Documentation

The [documentation index](https://github.com/wuiyang/5straps-buckle/blob/main/docs/README.md) lists every page.

## Packages

| Path | Package | What it is |
|---|---|---|
| `buckle/` | `@5straps/buckle` | The CLI, MCP server, and HTTP server |
| `packages/protocol/` | `@5straps/protocol` | The wire schemas |
| `packages/runtime/` | `@5straps/runtime` | Runtime primitives |

Settings are in [`.env.example`](https://github.com/wuiyang/5straps-buckle/blob/main/.env.example).
To work on Buckle, see [CONTRIBUTING.md](https://github.com/wuiyang/5straps-buckle/blob/main/CONTRIBUTING.md).
Changes are in [CHANGELOG.md](https://github.com/wuiyang/5straps-buckle/blob/main/CHANGELOG.md).

## Security

Report a vulnerability privately through GitHub private vulnerability reporting, as
[SECURITY.md](https://github.com/wuiyang/5straps-buckle/blob/main/SECURITY.md) describes, not in a public issue.

## License

Apache-2.0. Copyright 2026 The 5straps Authors. See [LICENSE](https://github.com/wuiyang/5straps-buckle/blob/main/LICENSE) and [NOTICE](https://github.com/wuiyang/5straps-buckle/blob/main/NOTICE).
