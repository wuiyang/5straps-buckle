# Buckle user documentation

Long topics continue on numbered pages, such as `approvals-02.md`. The [README](../../README.md)
shows what Buckle does today and what is still open.

## Quick start

- [Installing Buckle](quick-start/install.md): requirements, platform status, and upgrading.
  [State files](quick-start/install-02.md) lists what it keeps on disk.
- [First run](quick-start/first-run.md): `buckle init`, and the CLI, MCP, and HTTP entry points.
  [Credentials](quick-start/first-run-02.md) covers the agent token and the admin token.

## How-to

- [Approvals](how-to/approvals.md): what asks, the scopes, the destructive floor, where to answer,
  and the dangerously-allow switch. [The serve terminal](how-to/approvals-02.md) and [calls over
  MCP, and copies](how-to/approvals-03.md) continue it.
- [Policy](how-to/policy.md): command globs, network lists, files, and when a change applies. [What
  Buckle reads](how-to/policy-02.md), [what stays unread](how-to/policy-03.md), [the file
  floor](how-to/policy-04.md), and [deletes](how-to/policy-05.md) continue it.
- [Decision AI](how-to/judge.md): the optional AI rater of asks. [What it reads and
  sends](how-to/judge-02.md), [what it keeps and shows](how-to/judge-03.md), [its settings, cache,
  and cost](how-to/judge-04.md), and [why it rates nothing](how-to/judge-05.md) continue it.
- [Secret references](how-to/secrets.md): values from dotenv files in commands, browser fills, and
  fetch headers, never shown. [Secret masking](how-to/secrets-02.md) lists the forms.
- [Audit log](how-to/audit-log.md): what `actions.jsonl` records and trims.
- [Workspaces](how-to/workspaces.md): one node, many folders, and their tokens.
  [Settings](how-to/workspaces-02.md), [node defaults](how-to/workspaces-03.md), [moving from
  0.1](how-to/workspaces-04.md), and [serving workspaces](how-to/workspaces-05.md) continue it.
- [Mounts](how-to/mounts.md): sharing more folders with the agent. [Mounts on
  Windows](how-to/mounts-02.md) covers shares.
- [Sandbox and tools](how-to/sandbox-and-tools.md): packs, sandboxing per platform, and shell
  isolation. [Part two](how-to/sandbox-and-tools-02.md) covers host Git, forge, and language
  servers.
- [Code mode](how-to/code-mode.md): scripts that call the other tools. [Replay](how-to/code-mode-02.md)
  and [limits and settings](how-to/code-mode-03.md) continue it.
- [Change history](how-to/change-history.md): checkpoints and rollback. [Part
  two](how-to/change-history-02.md) covers the agent's tools, the restore ask, and Git repositories.
- [Copying files](how-to/copy.md): `buckle cp`, its token, approvals, and limits.
  [Checks](how-to/copy-02.md) continues it.
- [Browser](how-to/browser-login.md): profile folders, your own Chrome, and Chromium arguments.
  [Sessions](how-to/browser-login-02.md) says what a close and a restart end.
- [Service](how-to/service.md): start at login on Linux and Windows. [Part two](how-to/service-02.md)
  covers macOS, a detached node, logs, upgrades, and removal.
- [Rings](how-to/rings.md): the optional pairing with the 5straps control plane.

## Caveats and fixes

- [Troubleshooting](caveats/troubleshooting.md): first failures and their messages. [Refused
  commands](caveats/troubleshooting-02.md) and [file calls](caveats/troubleshooting-03.md) continue
  it.
- [Known limits](caveats/known-limits.md): what Buckle does not yet read, hide, or handle. Parts
  [two](caveats/known-limits-02.md), [three](caveats/known-limits-03.md),
  [four](caveats/known-limits-04.md), [five](caveats/known-limits-05.md),
  [six](caveats/known-limits-06.md), [seven](caveats/known-limits-07.md),
  [eight](caveats/known-limits-08.md), [nine](caveats/known-limits-09.md), and
  [ten](caveats/known-limits-10.md) go deeper.
