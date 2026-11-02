# Buckle documentation

Buckle is an approval and sandbox runtime for AI agents. These pages say how to install it, run
it, and set its policy, and how it works inside. Long topics continue on numbered pages, such as
`approvals-02.md`. The [README](../README.md) shows what Buckle does today and what is still open.

## Start here

- [Installing Buckle](install.md): requirements, platform status, and upgrading. [State
  files](install-02.md) lists what it keeps on disk.
- [First run](first-run.md): `buckle init`, and the CLI, MCP (the Model Context Protocol), and HTTP faces.
  [Credentials](first-run-02.md)
  covers the agent token and the admin token.
- [Troubleshooting](troubleshooting.md): first failures and their messages. [Refused
  commands](troubleshooting-02.md) and [file calls](troubleshooting-03.md) continue it.
- [Known limits](known-limits.md): what Buckle does not yet read, hide, or handle. Parts
  [two](known-limits-02.md), [three](known-limits-03.md), [four](known-limits-04.md),
  [five](known-limits-05.md), [six](known-limits-06.md), [seven](known-limits-07.md),
  [eight](known-limits-08.md), [nine](known-limits-09.md), and [ten](known-limits-10.md) go
  deeper.

## Approvals and policy

- [Approvals](approvals.md): what asks, the scopes, the destructive floor, where to answer, and the
  dangerously-allow switch. [The serve terminal](approvals-02.md) and [calls over
  MCP, and copies](approvals-03.md) continue it.
- [Policy](policy.md): command globs, network lists, files, and when a change applies. [What Buckle
  reads](policy-02.md), [what stays unread](policy-03.md), [the file floor](policy-04.md), and
  [deletes](policy-05.md) continue it.
- [The decision AI](judge.md): the optional AI rater of asks. [What it reads and
  sends](judge-02.md), [what it keeps and shows](judge-03.md), [its settings, cache, and
  cost](judge-04.md), and [why it rates nothing](judge-05.md) continue it.
- [Secret references](secrets.md): values from dotenv files in commands, browser fills, and fetch
  headers, never shown. [Secret masking](secrets-02.md) lists the forms.
- [The audit log](audit-log.md): what `actions.jsonl` records and trims.

## Workspaces, tools, and files

- [Workspaces](workspaces.md): one node, many folders, and their tokens. [Settings](workspaces-02.md),
  [node defaults](workspaces-03.md), [moving from 0.1](workspaces-04.md), and [serving
  workspaces](workspaces-05.md) continue it.
- [Mounts](mounts.md): sharing more folders with the agent. [Mounts on Windows](mounts-02.md) covers
  shares.
- [Sandbox and tools](sandbox-and-tools.md): packs, sandboxing per platform, and shell isolation.
  [Part two](sandbox-and-tools-02.md) covers host Git, forge, and language servers.
- [Code mode](code-mode.md): scripts that call the other tools. [Replay](code-mode-02.md) and
  [limits and settings](code-mode-03.md) continue it.
- [The change history](change-history.md): checkpoints and rollback. [Part
  two](change-history-02.md) covers the agent's tools, the restore ask, and Git repositories.
- [Copying files](copy.md): `buckle cp`, its token, approvals, and limits. [Checks](copy-02.md)
  continues it.
- [Using your own browser](browser-login.md): profile folders, your own Chrome, and Chromium
  arguments. [Sessions](browser-login-02.md) says what a close and a restart end.

## Running Buckle

- [Running Buckle as a service](service.md): start at login on Linux and Windows. [Part
  two](service-02.md) covers macOS, a detached node, logs, upgrades, and removal.
- [Rings](rings.md): the optional pairing with the 5straps control plane for agents.

## For developers

- [Architecture](dev/architecture.md) ([state and packs](dev/architecture-02.md)), [Building and
  testing](dev/building-and-testing.md), and [Releasing](dev/releasing.md) ([setup](dev/releasing-04.md),
  [repeats and approval](dev/releasing-02.md), and [what ships](dev/releasing-03.md)).
- Research records: [command matching](dev/research/command-matching.md) and [transport and
  terminal packages](dev/research/packages.md).
- [Contributing](../CONTRIBUTING.md), the [changelog](../CHANGELOG.md), and [security
  policy](../SECURITY.md).
