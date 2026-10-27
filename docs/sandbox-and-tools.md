# Sandbox and tools

Buckle, the approval and sandbox runtime on your machine, groups its tools into packs. A pack
that cannot run here is withheld with a reason rather than failing at call time, so
`buckle tools` lists only what works and `buckle manifest` says why the rest is missing.

## Packs

| Pack | Tools | Needs |
|---|---|---|
| `fs` | `fs_read`, `fs_read_batch`, `fs_write`, `fs_write_batch`, `fs_patch`, `fs_apply_patch`, `fs_delete`, `fs_move`, `fs_list`, `fs_find_names`, `fs_search_content`, `fs_receive`, `fs_send` | nothing; `fs_search_content` uses `rg` when it is installed, else Buckle's own walker; the last two run only for [`buckle cp`](copy.md) |
| `web` | `web_fetch`, `web_search` | `web_search` needs `BUCKLE_BRAVE_SEARCH_API_KEY` |
| `shell` | `shell_exec`, `script_run` | a process sandbox, below; on unless the workspace sets `packs.shell` off |
| `git` | `git_status`, `git_diff`, `git_log`, `git_blame`, `git_branch` | `git`, and `packs.hostGit` on |
| `forge` | `git_commit`, `git_push`, `pr_open`, `pr_read` | the same, and `BUCKLE_FORGE_GITHUB_TOKEN` |
| `dev` | `lsp_discover`, `lsp_definition`, `lsp_references`, `lsp_hover`, `lsp_rename`, `lsp_diagnostics` | `packs.hostLsp` on, and a language server |
| `browser` | `browser_command` | `agent-browser`, a browser for agents, or the command `BUCKLE_AGENT_BROWSER_COMMAND` names |
| `code` | `code_run`, `code_api`: a script that calls the other tools, each call judged as a direct one ([Code mode](code-mode.md)) | nothing, not even a sandbox; on unless the workspace sets `packs.code` off |
| `environment` | `env_validate` | `BUCKLE_ENV_VALIDATOR_COMMAND` |

The file tools change files in these ways. `fs_apply_patch` applies a unified diff to several
files, checking every hunk before it writes any. `fs_delete` removes files, and a folder only with `recursive: true`.
`fs_move` renames or moves, and replaces a file at `to` only with `replace: true`. Each change is
checkpointed, so [`buckle history restore`](sandbox-and-tools-02.md#change-history) brings it back.
The [file floor](policy-04.md) asks before some of these calls. Without `rg`, `fs_search_content`
runs more slowly and skips binary files ([known limits](known-limits-08.md#search-without-rg)).

`buckle workspace set packs.enabled fs,web,shell` offers only the named
[packs](workspaces-02.md#settings), and naming any turns plugins off.
The tool policy treats the two copy tools as the file faces of `fs_write` and `fs_read`:
`buckle policy deny-tool fs_write` also denies `fs_receive`, and `deny-tool fs_read` also denies
`fs_send`. A tool allow list must name them to allow copies.
`buckle plugin add <id> <module>` adds a plugin, a module that exports `createPack(options)`; one
that fails to load shows as an unavailable pack. Each built-in pack ships a skill, a short guide
for the agent: `buckle skills` lists them and `buckle skills buckle-shell` prints one.

## Sandboxing per platform

`BUCKLE_SANDBOX=auto`, the default, picks the sandbox for shell tools:

- Linux: bubblewrap, when Buckle finds `bwrap` where it looks for programs
  ([Install](install.md#requirements)). A command runs as `agent` on a host named `buckle`, with
  new user, process, and IPC namespaces and no network, in an empty root holding the system
  folders read-only, a fresh `/tmp`, the workspace (writable below its working directory), and
  each [mount](mounts.md#what-the-agent-sees).
- macOS: Seatbelt, through `/usr/bin/sandbox-exec`, with a profile that denies by default,
  allows reading system paths and the workspace, and allows writing the writable roots and `/tmp`.
  Under Seatbelt, Buckle supports neither a workspace mount nor shell isolation.
- Anywhere else, or Linux without `bwrap`: no sandbox, and the shell pack is withheld.

`BUCKLE_SANDBOX=none` runs commands with no sandbox, on purpose. It still needs
`shell.isolation` off and no workspace mount before shell tools appear. Every shell result
carries a `sandbox` field naming the mode it ran under.

Under bubblewrap and Seatbelt, Buckle hides its state directory and `~/.5straps` from commands,
and masks credential files inside the workspace unless a call asks for one by name. With
`none`, nothing is hidden.

## Shell isolation

With bubblewrap, shell isolation is on by default (the workspace setting `shell.isolation`). Each
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

A read-write mount is read-only to an isolated command, and its result says so.
`shell.isolation` off runs commands in the workspace itself, under the same sandbox.

Commands have no network unless `shell.network` is on and no approved list is set; the call must
also pass `allowNetwork: true`. The
[`web` tools](policy.md#network) are the scoped way to reach the network. A command runs for
`BUCKLE_DEFAULT_TIMEOUT_MS` (30 seconds) unless the call asks for more, up to
`BUCKLE_MAX_TIMEOUT_MS` (5 minutes).

A command that needs a credential file declares it in `sensitiveFiles`, which asks once per call
and mounts the approved file read-only for that call. This needs bubblewrap with shell isolation.
A [secret reference](secrets.md) hands a command one dotenv value without showing it.

[Part two](sandbox-and-tools-02.md) covers host Git, forge, and language servers, the browser's allowed hosts, `web_fetch` redirects, and the change history.
