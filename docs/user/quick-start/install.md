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
[Known limits](../caveats/known-limits.md#paths-and-windows) lists the differences.

Buckle looks for these programs on `PATH`, then beside its `buckle` command and Node.js, and on
Windows in `%APPDATA%\npm`. Without one, the matching pack or tool is withheld; a missing
language server withholds nothing, and a call needing it fails. `buckle init`
checks the first four; `buckle manifest` says why a pack is withheld. Without `rg`,
`fs_search_content` runs through Buckle's own, slower walker.

| Program | Unlocks |
|---|---|
| `bwrap` (bubblewrap), Linux | the sandboxed shell pack |
| `rg` (ripgrep) | a faster `fs_search_content`; without it, Buckle's own walker |
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
| Shell tools after a settings change | | with `shell.isolation` off and no workspace mount | only unsandboxed: `BUCKLE_SANDBOX=none`, `shell.isolation` off, and no workspace mount |
| Shell isolation in private copies | yes | no | no |
| `node-pty` binary | built from source at install | prebuilt | prebuilt |
| Start at login, `buckle service install` ([Service](../how-to/service.md)) | systemd user unit | launchd agent, not yet run on a Mac | Task Scheduler task, experimental |

The shell rows follow from two checks: isolated shell execution and a workspace mount, such as
`buckle init`'s `/workspace`, both need bubblewrap. `shell.isolation` is a workspace setting
(`buckle workspace set shell.isolation off`); `BUCKLE_SHELL_ISOLATION=false` in `buckle.env` is its
default for every workspace. The mount table, which shares more folders with `buckle workspace mount`,
is on [Mounts](../how-to/mounts.md). [Sandbox and tools](../how-to/sandbox-and-tools.md) explains both checks.

## Install

```bash
npm i -g @5straps/buckle
```

This puts one command, `buckle`, on your `PATH`. npm installs its companion packages
`@5straps/protocol` and `@5straps/runtime` with it. `node-pty` is an optional dependency that
only the interactive terminal feature uses; on Linux it compiles during install, so an npm
configured to skip install scripts leaves it unbuilt. The rest works:
[Troubleshooting](../caveats/troubleshooting.md#node-pty-was-not-built) has the fix.

To build from a clone, follow [Building and testing](../../developer/building-and-testing.md).

## Check the install

```bash
buckle --help       # the command list; reads no configuration
buckle --version    # the version npm installed; a build from a clone adds its commit
buckle tools        # each tool this machine offers, with its risk level
buckle manifest     # packs, the sandbox mode, and why any pack is withheld
```

`buckle tools` and `buckle manifest` act on a [workspace](../how-to/workspaces.md), so run them after
`buckle init`, in its folder. In the manifest, a withheld pack's `unavailableReason` says why;
the `git` pack's names `packs.hostGit`, off until you turn it on.

## Upgrade

```bash
npm i -g @5straps/buckle@latest
buckle --version
```

Then restart any running `buckle serve` (`buckle service restart` where a service runs it), and
any MCP client that started `buckle mcp`. Grants,
policies, and the audit log carry over: the calls of a 0.1 node's folder are its workspace's log,
which `buckle log --workspace <name>` reads. The first command after an upgrade from 0.1 moves the
node onto workspaces once, and an older Buckle then fails closed;
[Moving a node from 0.1](../how-to/workspaces-04.md) says what changes, and how to go back. Stop
`buckle serve`, the service, every MCP client that runs `buckle mcp`, and the browser Buckle
opened before that first command: on Windows the move stops at a folder a running Buckle, or the
browser it opened, holds open.

## Uninstall

```bash
npm uninstall -g @5straps/buckle
```

Run `buckle service uninstall` first where a service runs the node ([Uninstall](../how-to/service-02.md)), or
its definition keeps naming a program that is gone. This removes the program, not its state. Buckle keeps everything under `~/.5straps`: the state
directory `~/.5straps/buckle`, settings-file locks in `~/.5straps/locks`, and the device key of
`buckle client` in `~/.5straps/client`. Deleting `~/.5straps/buckle` deletes the audit logs, so
copy `actions.jsonl`, which holds the node's own commands, and each `workspaces/<id>/actions.jsonl`,
which holds that workspace's calls, first.

What Buckle keeps in its state directory, file by file, is on [the next page](install-02.md). To
keep the node running at every login, with no terminal open, see [Running Buckle as a service](../how-to/service.md).

Next: [First run](first-run.md).
