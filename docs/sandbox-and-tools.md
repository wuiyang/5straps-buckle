# Sandbox and tools

Buckle, the approval and sandbox runtime on your machine, groups its tools into packs. A pack
that cannot run here is withheld with a reason rather than failing at call time, so
`buckle tools` lists only what works and `buckle manifest` says why the rest is missing. One tool
is the exception: `fs_search_content` is left out without `rg`, and no reason is given.

## Packs

| Pack | Tools | Needs |
|---|---|---|
| `fs` | `fs_read`, `fs_read_batch`, `fs_write`, `fs_write_batch`, `fs_patch`, `fs_list`, `fs_find_names`, `fs_search_content` | nothing; `fs_search_content` needs `rg` |
| `web` | `web_fetch`, `web_search` | `web_search` needs `BUCKLE_BRAVE_SEARCH_API_KEY` |
| `shell` | `shell_exec`, `script_run` | a process sandbox, below; on unless `BUCKLE_ALLOW_SHELL=false` |
| `git` | `git_status`, `git_diff`, `git_log`, `git_blame`, `git_branch` | `git` and `BUCKLE_ALLOW_HOST_GIT=true` |
| `forge` | `git_commit`, `git_push`, `pr_open`, `pr_read` | the same, and `BUCKLE_FORGE_GITHUB_TOKEN` |
| `dev` | `lsp_discover`, `lsp_definition`, `lsp_references`, `lsp_hover`, `lsp_rename`, `lsp_diagnostics` | `BUCKLE_ALLOW_HOST_LSP=true` and a language server |
| `browser` | `browser_command` | `agent-browser`, a browser for agents, or the command `BUCKLE_AGENT_BROWSER_COMMAND` names |
| `environment` | `env_validate` | `BUCKLE_ENV_VALIDATOR_COMMAND` |

`BUCKLE_PACKS=fs,web,shell` loads only the named packs, and naming any turns plugins off.
`buckle plugin add <id> <module>` adds a plugin, a module that exports `createPack(options)`; one
that fails to load shows as an unavailable pack. Each built-in pack ships a skill, a short guide
for the agent: `buckle skills` lists them and `buckle skills buckle-shell` prints one.

## Sandboxing per platform

`BUCKLE_SANDBOX=auto`, the default, picks the sandbox for shell tools:

- Linux: bubblewrap, when Buckle finds `bwrap` where it looks for programs
  ([Install](install.md#requirements)). A command gets new user, process, host name, and IPC
  namespaces, and no network; it sees `/usr`, `/bin`, `/lib`, and a few `/etc` files read-only,
  a fresh `/tmp`, `HOME=/tmp/home`, and the workspace, writable only below its working
  directory and `BUCKLE_SCRATCH_ROOTS`.
- macOS: Seatbelt, through `/usr/bin/sandbox-exec`, with a profile that denies by default,
  allows reading system paths and the workspace, and allows writing the writable roots and `/tmp`.
  Under Seatbelt, Buckle supports neither a workspace mount nor shell isolation.
- Anywhere else, or Linux without `bwrap`: no sandbox, and the shell pack is withheld.

`BUCKLE_SANDBOX=none` runs commands with no sandbox at all, on purpose. It still needs
`BUCKLE_SHELL_ISOLATION=false` and no workspace mount before shell tools appear. Every shell
result carries a `sandbox` field naming the mode it ran under.

Under bubblewrap and Seatbelt, Buckle hides its state directory and `~/.5straps` from commands,
and masks credential files inside the workspace unless a call asks for one by name. With
`none`, nothing is hidden.

`BUCKLE_MOUNT_READ_ONLY` adds host directories a command may read, for toolchains outside
`/usr`.

## Shell isolation

With bubblewrap, shell isolation is on by default (`BUCKLE_SHELL_ISOLATION=true`). Each
`shell_exec` or `script_run` call:

1. copies the workspace, without hidden and credential paths, into a private copy under
   `isolated-shell/` in the state directory, up to `BUCKLE_ISOLATION_MAX_BYTES` (256 MiB);
2. runs the command in that copy, shown to it as the workspace;
3. publishes the changed files back as one checkpoint, but only when those files still match what
   the copy started from, and only inside the writable roots, never a credential path or a link
   that leaves the workspace.

If publishing fails, the call reports `ISOLATED_WORKSPACE_FAILED` and the copy is kept for you:

```bash
buckle workspaces list
buckle workspaces inspect <id>
buckle workspaces publish <id>    # or: discard <id>
buckle workspaces prune
```

`BUCKLE_SHELL_ISOLATION=false` runs commands in the workspace itself, under the same sandbox.

Commands have no network unless `BUCKLE_SHELL_NETWORK=true`, no approved list is set, and
`BUCKLE_ALLOWED_HOSTS` is empty; the call must then also pass `allowNetwork: true`. The
[`web` tools](policy.md#network) are the scoped way to reach the network. A command runs for
`BUCKLE_DEFAULT_TIMEOUT_MS` (30 seconds) unless the call asks for more, up to
`BUCKLE_MAX_TIMEOUT_MS` (5 minutes).

A command that needs a credential file declares it in `sensitiveFiles`, which asks once per call
and mounts the approved file read-only for that call. This needs bubblewrap with shell isolation.

## Host Git, forge, and language servers

These run on the host, outside the sandbox and without Buckle's per-file checks, so they start
off. Turn them on for a repository you trust:

```bash
buckle settings set host-git on    # BUCKLE_ALLOW_HOST_GIT=true: the git and forge packs
```

`BUCKLE_ALLOW_HOST_LSP=true`, for the `dev` pack, has no `buckle settings` key: add the line to
`buckle.env` by hand. Restart `buckle serve` or `buckle mcp` after either change. A policy with
a filesystem `deny` or `ask` rule withholds all three packs again.

Every `git` and `forge` call hides the system and global git configs, points `core.hooksPath` at
an empty directory Buckle owns, and overrides the repository's program settings, so no hook or
configured program from the repository runs. The forge pack holds `BUCKLE_FORGE_GITHUB_TOKEN`
in git's environment, never in a remote URL, and talks to `BUCKLE_FORGE_GITHUB_API_URL`
(`https://api.github.com` by default). `git_push` refuses force and pushes only to the origin the
rules judged; commits carry `BUCKLE_FORGE_GIT_AUTHOR`.

## The browser's allowed hosts

`browser_command` runs one `agent-browser` command in a session of its own, headless unless
`BUCKLE_BROWSER_HEADED=true`. By default each session gets a fresh browser with no saved state; the
owner can choose a profile folder that keeps logins, or their own Chrome, as
[Using your own browser](browser-login.md) describes. No agent call can. The first call in a mode
launches the browser, which can take long enough for a client to time out; send the same call
again, and it reuses the browser already launched.

The owner installs `agent-browser` outside any workspace (Buckle refuses one inside):
`npm i -g agent-browser`, then `agent-browser install`, which downloads the browser.
Buckle looks for it on `PATH`, then beside its own `buckle` command, where `npm i -g` puts both,
beside its Node.js, and on Windows in `%APPDATA%\npm`. On Windows it reads, never runs, npm's
`.cmd` shim, and runs the `.exe` or script it names. Without it, the pack's reason says where
Buckle looked.

For a fresh browser with an approved list, Buckle passes its hosts to `agent-browser` as
`--allowed-domains`, so clicks, redirects, and page requests stay on them. The browser matches
host names only, so inside a page an allowed host is reachable on any port and path, while the
page a command opens is still judged with port and path. With no approved list, no flag is passed
and public hosts are open. When a list has no usable host, Buckle does not start the browser and
says which list to fix.

## Change history

Tool writes and shell publications are recorded as checkpoints under `history/`, kept up to
`BUCKLE_HISTORY_MAX_BYTES` (1 GiB) and `BUCKLE_HISTORY_RETENTION_DAYS` (30):

```bash
buckle history list
buckle history restore <id>
```
