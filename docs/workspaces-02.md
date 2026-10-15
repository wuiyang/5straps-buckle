# Workspace settings, and moving from 0.1

Each [workspace](workspaces.md) of a node of Buckle, the approval and sandbox runtime on this
machine, keeps its own settings in `workspaces/<id>/workspace.json` in the state directory. The
node keeps its own in `buckle.env`, and those are every workspace's defaults: a setting a
workspace leaves unset is the node's, else Buckle's built-in one. This page lists the settings,
says when a change applies, and covers the move from 0.1. [Node defaults](workspaces-03.md)
covers how each setting resolves, the deny lists every workspace is held to, and the node's own
settings.

## Settings

`buckle workspace show` lists each setting in force and where it comes from: `workspace`, its
own `workspace.json`; `node default`, the node's `buckle.env`; or `built-in`. `--json` adds the
file as stored. `buckle workspace set <key> <value>` gives the workspace a value of its own,
checked whole with the rest before anything is written; `unset <key>` takes it out, so the
node's applies again:

| Key | Takes | Built-in |
|---|---|---|
| `name` | the workspace's name, shown beside its id | the folder's name |
| `env.<NAME>` | a variable its shell commands see | none |
| `mount` | where the agent sees the folder, such as `/workspace` | its real path |
| `approvalWaitMs` | milliseconds a gated call waits for an answer; `0` waits until someone answers | `15000` |
| `packs.enabled` | the packs offered, comma separated, which leaves plugins out | every built-in pack, and plugins |
| `packs.shell` | `on` or `off`: the shell pack | on |
| `packs.code` | `on` or `off`: [code mode](code-mode.md) | on |
| `packs.hostGit` | `on` or `off`: the `git` and `forge` packs, which read the repository outside per-file checks | off |
| `packs.hostLsp` | `on` or `off`: language servers in the `dev` pack | off |

A new workspace sets its mount, `/workspace`, and nothing else. `buckle workspace set` refuses a
node setting, such as `host` or `BUCKLE_PORT`, naming `buckle settings set`.

A variable name that looks like a credential (holding token, secret, password, or key) is taken,
with a warning that its value is plain text in `workspace.json` and reaches every command. A name
starting `BUCKLE_`, and the names Buckle sets for every command (`PATH`, `HOME`, `USER`,
`LOGNAME`, `SHELL`, and `TMPDIR`), are refused. So is a value that contains a secret the node
holds (the admin token, `BUCKLE_AUTH_TOKEN`, the forge token, the Brave search key, the report
token, the Rings pairing key, or the approval webhook's URL) or a workspace's agent token as a
word of it. Keep real secrets in your own store: `buckle workspace show` prints the variables,
and every command in the workspace can read them. A call's own `env` is set over them.

The policy lists change with `buckle policy`, which acts on one workspace as every command does
([Policy](policy.md)). The browser settings (`browser.cdp`, `browser.profile`, `browser.args`,
`browser.headed`, and `browser.idleTimeoutMs`) are kept in the file but not read: the browser runs
on the node's `BUCKLE_BROWSER_*` settings until a later release reads each workspace's own.

## When a change applies

A running `buckle serve` or `buckle mcp` watches a workspace's state folder and takes a change up
at once while the workspace is idle, with a check at the start of each call as the fallback. A
change to the policy lists, the variables, or the approval wait applies from the next call, even
while another runs, which keeps its own rules; a list change alone waits while a
workbench is open, as taking it up stops its terminals. A change to the packs or to where the
folder shows waits until the workspace has no active work, such as a running call or a shell copy
awaiting review, and calls are refused with a 409 until then. A file that will not read leaves
the settings in force, and the owner's log says so once. `buckle serve` watches the registry
folder the same way, with its poll as the fallback. A change to `buckle.env` applies when the
node restarts.

## Moving a node from 0.1

The first command of this release on a state directory 0.1 used moves the node onto
workspaces, once, under the registry's lock:

- The folder the node served, `BUCKLE_WORKSPACE_ROOT` or the directory the command runs in,
  becomes a workspace named after its folder, with a UUID id Buckle assigns and its records under
  `workspaces/<id>/`. `BUCKLE_AUTH_TOKEN` becomes its token `node`, so agents configured with it
  keep working; `buckle workspace token create --workspace <that name>`, then `token revoke
  node`, rotates it.
- Each workspace registered with `buckle workspace add` keeps its 0.1 id as its name, gets a UUID
  id, and keeps its folder, tokens, and `/workspace` mount. A disabled or retired one is kept
  offline. Each workspace's own admin credential goes: the node's is the one.
- The registry keeps every token as its SHA-256 digest alone.
- Each `workspace.json` holds what was the workspace's own: the lists `buckle policy` stored, and
  for the node's folder a mount it stored. The settings `buckle.env` held stay there, copied into
  no workspace, as every workspace's defaults. A workspace with an allow list of its own now uses
  it alone, where the node's list was a ceiling over it, and the move says so.
- Grants, remembered denials, and the dangerously-allow switch move from the folder they were
  kept under to the workspace's id.

A state directory that served nothing gets no workspace until `buckle init` makes one.

The move keeps owner-only copies of what it changes: `workspaces.v1.json` and
`policy.v1.json` in the state directory (empty where the node had no registry or policy), and
`grants.v1.json` and `dangerously-allow.v1.json` beside each grants and switch file it moved: in
the state directory for the node's folder, and in `workspaces/<0.1 id>/` for each workspace
registered under 0.1 ([the files](install-02.md)). It makes `policy.json`
a version 2 stub and takes `BUCKLE_AUTH_TOKEN` out of `buckle.env`, so an older Buckle refuses to
start.

To go back to 0.1, stop Buckle and its MCP clients. Copy each `*.v1.json` file over its original,
set `BUCKLE_AUTH_TOKEN` in `buckle.env` to the token your agents use (Buckle kept only its
digest), set `BUCKLE_WORKSPACE_ROOT` there to the node's folder (see `buckle workspace list`)
if `buckle settings unset root` removed it, and install the older release. Going back loses
every workspace registered, token created, grant, denial, and `workspace.json` written after the
move.

`workspaces.v1.json` holds the registered workspaces' agent tokens and admin credentials in clear
text. Once the node works, delete every `*.v1.json` file in the state directory and in each
`workspaces/<0.1 id>/` folder; the way back goes with them.
