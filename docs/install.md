# Installing Buckle

Buckle is an approval and sandbox runtime for AI agents. It runs on one machine, runs the tool
calls its owner allows, asks a person about the rest, and refuses what the owner ruled out. This
page covers installing, checking, upgrading, and removing it, and what it keeps on disk.

## Requirements

- Node.js 24 or newer. Every package declares `"node": ">=24.0.0"`.
- Linux with bubblewrap for every feature. macOS has a narrower shell sandbox and Windows has
  none. CI runs on Linux only, x64 and arm64; the macOS column below comes from the code.

On Windows, Buckle starts, its file tools work in the workspace, and Ctrl-C, Ctrl-Break, or
closing its console stops it after its close steps. Windows is experimental: it rests on reading
the code and on Linux tests that imitate Windows paths, signals, and file locks, not on a run on
Windows. [Known limits](known-limits.md#paths-and-windows)
lists the differences.

Buckle looks for these programs on `PATH`, then beside its `buckle` command and its Node.js, and
on Windows in `%APPDATA%\npm`. Without one, the matching pack or tool is withheld, except a
language server: a missing one withholds nothing, and a call needing it fails. `buckle init`
lists what it found; `buckle manifest` says why a pack is withheld, and without `rg` leaves out
`fs_search_content` with no reason.

| Program | Unlocks |
|---|---|
| `bwrap` (bubblewrap), Linux | the sandboxed shell pack |
| `rg` (ripgrep) | the `fs_search_content` tool |
| `git` | the `git` and `forge` packs, once host Git is turned on |
| `agent-browser`, a browser for agents | the `browser` pack |
| `typescript-language-server`, `rust-analyzer`, `gopls`, `pyright-langserver`, or `pylsp` | language support in the `dev` pack, once host language servers are turned on |

On Linux, install bubblewrap from your distribution, for example `sudo apt install bubblewrap`
or `sudo dnf install bubblewrap`. On Windows, Buckle reads, never runs, the `.cmd` shim npm
installs, and runs the `.exe` or Node.js script it names; for a shim it cannot read, point
`BUCKLE_AGENT_BROWSER_COMMAND` at the package's `.exe`.

## Platform status by feature

| Feature | Linux | macOS | Windows |
|---|---|---|---|
| `fs`, `web`, `git`, `forge`, `dev`, and `browser` packs | yes | yes | same code, not tested in CI |
| Process sandbox for shell tools | bubblewrap | Seatbelt (`/usr/bin/sandbox-exec`) | none |
| Shell tools with the settings `buckle init` writes | yes, with `bwrap` installed | withheld | withheld |
| Shell tools after a settings change | | with `BUCKLE_SHELL_ISOLATION=false` and no workspace mount | only unsandboxed: `BUCKLE_SANDBOX=none`, `BUCKLE_SHELL_ISOLATION=false`, and no workspace mount |
| Shell isolation in private copies | yes | no | no |
| `node-pty` binary | built from source at install | prebuilt | prebuilt |

The shell rows follow from two checks: isolated shell execution needs bubblewrap, and so does a
workspace mount, such as `buckle init`'s `/workspace`.
[Sandbox and tools](sandbox-and-tools.md) explains both.

## Install

```bash
npm i -g @5straps/buckle
```

This puts one command, `buckle`, on your `PATH`. npm installs its two companion packages,
`@5straps/protocol` and `@5straps/runtime`, with it. `node-pty` is an optional dependency that
only the interactive terminal feature uses; on Linux it compiles during install, so an npm
configured to skip install scripts leaves it unbuilt. Everything else still works:
[Troubleshooting](troubleshooting.md#node-pty-was-not-built) has the fix.

To build from a clone, follow [Building and testing](dev/building-and-testing.md).

## Check the install

```bash
buckle --help       # the command list; reads no configuration
buckle --version    # the version npm installed
buckle tools        # each tool this machine offers, with its risk level
buckle manifest     # packs, the sandbox mode, and why any pack is withheld
```

`buckle tools` and `buckle manifest` work before `buckle init`. Without a settings file they
serve the current directory with the defaults and create the state directory.

A withheld pack reads like this in the manifest:

```json
{
  "id": "git",
  "toolNames": ["git_status", "git_diff", "git_log", "git_blame", "git_branch"],
  "unavailableReason": "Host Git can read repository data outside per-file approval checks; BUCKLE_ALLOW_HOST_GIT=true explicitly trusts repository access outside the shell sandbox"
}
```

## Upgrade

```bash
npm i -g @5straps/buckle@latest
buckle --version
```

Then restart any running `buckle serve`, and any MCP client that started `buckle mcp`. A
running process keeps the code, settings, and policy it started with. The upgrade leaves the
state directory alone, so grants, the policy, and the audit log carry over.

## Uninstall

```bash
npm uninstall -g @5straps/buckle
```

This removes the program, not its state. Buckle keeps everything under `~/.5straps`: the state
directory `~/.5straps/buckle`, settings-file locks in `~/.5straps/locks`, and the device key of
`buckle client` in `~/.5straps/client`. Deleting `~/.5straps/buckle` deletes the audit log, so
copy `actions.jsonl` first to keep the record.

## What the state directory holds

The state directory is `~/.5straps/buckle`, or the absolute path in `BUCKLE_STATE_DIR`; a
relative path is refused. On Linux and macOS, Buckle creates it owner-only (mode 700), writes
its state files owner-only (mode 600), and refuses to start when other users can reach the
directory, unless you pass `--skip-owner-only-check`. On Windows, Buckle does not check or change
file permissions: Windows protects the default one under your user profile, and one moved
elsewhere is yours to protect. It refuses to start when the state directory sits inside the
workspace root, where an agent writes anywhere. Buckle's file tools refuse to read or write
anything under `~/.5straps` or the state directory. Only a process sandbox hides both from shell
commands: with `BUCKLE_SANDBOX=none`, a shell command can read and write them, and Buckle does
not ask about them.

| Path | Holds |
|---|---|
| `buckle.env` | the node's settings and its two credentials, written by `buckle init` |
| `policy.json` | the policy `buckle policy` stores, per workspace root |
| `dangerously-allow.json` | the dangerously-allow switch, for each workspace where it is on |
| `grants.json` | session and always grants, and remembered denials |
| `approvals.json`, `approval-calls/` | asks waiting for a person, recent decisions, unspent once approvals, and the whole call behind each ask |
| `actions.jsonl` | the [audit log](audit-log.md) |
| `plugins.json` | plugins added with `buckle plugin add` |
| `history/` | checkpoints of file changes, read by `buckle history` |
| `isolated-shell/` | the private workspace copies shell commands run in |
| `browser-sessions/`, `workbenches/`, `receive-git-hooks/` | browser session state, workbench files, and the guard hook local pushes run |
| `workspaces.json`, `workspaces/<id>/` | workspaces registered with `buckle workspace add`, each with a state directory of its own |
| `*.lock.sqlite` | locks that let several Buckle processes share these files |

Next: [First run](first-run.md).
