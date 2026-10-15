# Installing Buckle

Buckle is an approval and sandbox runtime for AI agents. It runs on one machine, runs the tool
calls its owner allows, asks a person about the rest, and refuses what the owner ruled out. This
page covers installing, checking, upgrading, and removing it, and what it keeps on disk.

## Requirements

- Node.js 24 or newer. Every package declares `"node": ">=24.0.0"`.
- Linux with bubblewrap for every feature. macOS has a narrower shell sandbox and Windows has
  none. CI runs on Linux only, x64 and arm64; the macOS column below comes from the code.

Windows is experimental: Buckle starts there, its file tools work, and Ctrl-C, Ctrl-Break, or
closing its console stops it, as read from the code and Linux tests that imitate Windows.
[Known limits](known-limits.md#paths-and-windows) lists the differences.

Buckle looks for these programs on `PATH`, then beside its `buckle` command and Node.js, and on
Windows in `%APPDATA%\npm`. Without one, the matching pack or tool is withheld; a missing
language server withholds nothing, and a call needing it fails. `buckle init`
checks the first four; `buckle manifest` says why a pack is withheld, and without `rg` leaves out
`fs_search_content` with no reason.

| Program | Unlocks |
|---|---|
| `bwrap` (bubblewrap), Linux | the sandboxed shell pack |
| `rg` (ripgrep) | the `fs_search_content` tool |
| `git` | the `git` and `forge` packs, once host Git is turned on |
| `agent-browser`, a browser for agents | the `browser` pack |
| `typescript-language-server`, `rust-analyzer`, `gopls`, `pyright-langserver`, or `pylsp` | language support in the `dev` pack, once host language servers are turned on |

On Linux, install bubblewrap from your distribution, such as `sudo apt install bubblewrap`. On
Windows, Buckle reads, never runs, npm's `.cmd` shim, and runs the `.exe` or Node.js script it
names; for a refused shim, point `BUCKLE_AGENT_BROWSER_COMMAND` at the package's `.exe` or script.

## Platform status by feature

| Feature | Linux | macOS | Windows |
|---|---|---|---|
| `fs`, `web`, `git`, `forge`, `dev`, and `browser` packs | yes | yes | same code, not tested in CI |
| Process sandbox for shell tools | bubblewrap | Seatbelt (`/usr/bin/sandbox-exec`) | none |
| Shell tools with the settings `buckle init` writes | yes, with `bwrap` installed | withheld | withheld |
| Shell tools after a settings change | | with `BUCKLE_SHELL_ISOLATION=false` and no workspace mount | only unsandboxed: `BUCKLE_SANDBOX=none`, `BUCKLE_SHELL_ISOLATION=false`, and no workspace mount |
| Shell isolation in private copies | yes | no | no |
| `node-pty` binary | built from source at install | prebuilt | prebuilt |

The shell rows follow from two checks: isolated shell execution and a workspace mount, such as
`buckle init`'s `/workspace`, both need bubblewrap.
[Sandbox and tools](sandbox-and-tools.md) explains both.

## Install

```bash
npm i -g @5straps/buckle
```

This puts one command, `buckle`, on your `PATH`. npm installs its companion packages
`@5straps/protocol` and `@5straps/runtime` with it. `node-pty` is an optional dependency that
only the interactive terminal feature uses; on Linux it compiles during install, so an npm
configured to skip install scripts leaves it unbuilt. The rest works:
[Troubleshooting](troubleshooting.md#node-pty-was-not-built) has the fix.

To build from a clone, follow [Building and testing](dev/building-and-testing.md).

## Check the install

```bash
buckle --help       # the command list; reads no configuration
buckle --version    # the version npm installed
buckle tools        # each tool this machine offers, with its risk level
buckle manifest     # packs, the sandbox mode, and why any pack is withheld
```

`buckle tools` and `buckle manifest` act on a [workspace](workspaces.md), so run them after
`buckle init`, in its folder. In the manifest, a withheld pack's `unavailableReason` says why;
the `git` pack's names `packs.hostGit`, off until you turn it on.

## Upgrade

```bash
npm i -g @5straps/buckle@latest
buckle --version
```

Then restart any running `buckle serve`, and any MCP client that started `buckle mcp`. Grants,
policies, and the audit log carry over. The first command after an upgrade from 0.1 moves the
node onto workspaces once, and an older Buckle then fails closed;
[Moving a node from 0.1](workspaces-02.md#moving-a-node-from-01) says what changes, and how to go
back.

## Uninstall

```bash
npm uninstall -g @5straps/buckle
```

This removes the program, not its state. Buckle keeps everything under `~/.5straps`: the state
directory `~/.5straps/buckle`, settings-file locks in `~/.5straps/locks`, and the device key of
`buckle client` in `~/.5straps/client`. Deleting `~/.5straps/buckle` deletes the audit log, so
copy `actions.jsonl` first.

## What the state directory holds

The state directory is `~/.5straps/buckle`, or the absolute path in `BUCKLE_STATE_DIR`; a
relative path is refused. On Linux and macOS, Buckle creates it owner-only (mode 700), writes
its state files owner-only (mode 600), and refuses to start when other users can reach the
directory, unless you pass `--skip-owner-only-check`. On Windows, Buckle leaves file permissions
alone: Windows protects the default one under your profile, and one moved elsewhere is yours to
protect. It refuses a workspace folder that holds the state directory, where an agent writes
anywhere. Buckle's file tools refuse to read or write
anything under `~/.5straps` or the state directory. Only a process sandbox hides both from shell
commands: with `BUCKLE_SANDBOX=none`, a shell command can read and write them, and Buckle does
not ask about them.

Workspace `default`, a 0.1 node's folder, keeps its records here. Every other workspace keeps
the files from `dangerously-allow.json` down in its own `workspaces/<id>/`.

| Path | Holds |
|---|---|
| `buckle.env` | the node's settings and its admin credential, written by `buckle init` |
| `workspaces.json` | each workspace's id, name, folder, whether it is online, and its agent tokens' SHA-256 digests |
| `workspaces/<id>/` | the workspace's `workspace.json`, its settings and policy, and its records |
| `workspaces.v1.json` | the 0.1 registry, kept when the node moved |
| `policy.json` | a stub an older Buckle cannot read; `policy.v1.json` keeps the 0.1 policy |
| `dangerously-allow.json` | the dangerously-allow switch, where it is on |
| `grants.json` | session and always grants, and remembered denials |
| `approvals.json`, `approval-calls/` | asks waiting for a person, recent decisions, unspent once approvals, and the whole call behind each ask |
| `actions.jsonl` | the [audit log](audit-log.md) |
| `plugins.json` | plugins added with `buckle plugin add` |
| `history/` | checkpoints of file changes, read by `buckle history` |
| `code-journal/` | stopped scripts' text and calls' results, kept ten minutes |
| `isolated-shell/` | the private workspace copies shell commands run in |
| `browser-sessions/`, `workbenches/`, `receive-git-hooks/` | browser session state, workbench files, and the guard hook local pushes run |
| `*.lock.sqlite` | locks that let several Buckle processes share these files |

Next: [First run](first-run.md).
